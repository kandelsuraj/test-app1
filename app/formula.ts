/**
 * A small, safe expression evaluator for merchant-authored pricing formulas.
 *
 * Merchants type formulas like `max(width * height * rate / 10000, 25)`, so the
 * input is untrusted and must never reach eval() or new Function(). This parses
 * to an AST and walks it, supporting only the operators and functions below.
 *
 * NOTE: storefront/price-calculator.js carries a plain-JS
 * port of this parser so the storefront evaluates prices identically. Keep the
 * two in sync when changing the grammar or the FUNCTIONS table.
 */

export type Node =
  | { kind: "number"; value: number }
  | { kind: "variable"; name: string }
  | { kind: "unary"; op: string; operand: Node }
  | { kind: "binary"; op: string; left: Node; right: Node }
  | { kind: "ternary"; test: Node; then: Node; otherwise: Node }
  | { kind: "call"; name: string; args: Node[] };

export class FormulaError extends Error {}

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  min: Math.min,
  max: Math.max,
  abs: Math.abs,
  sqrt: Math.sqrt,
  floor: Math.floor,
  ceil: Math.ceil,
  pow: Math.pow,
  round: (value, digits = 0) => {
    const factor = Math.pow(10, digits);
    return Math.round(value * factor) / factor;
  },
};

export const FUNCTION_NAMES = Object.keys(FUNCTIONS);

type Token = { type: "number" | "name" | "op"; value: string };

const OPERATORS = [
  "<=",
  ">=",
  "==",
  "!=",
  "&&",
  "||",
  "+",
  "-",
  "*",
  "/",
  "%",
  "^",
  "(",
  ")",
  ",",
  "?",
  ":",
  "<",
  ">",
  "!",
];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (/[0-9.]/.test(char)) {
      const match = /^[0-9]*\.?[0-9]+/.exec(source.slice(index));
      if (!match) throw new FormulaError(`Invalid number at position ${index}`);
      tokens.push({ type: "number", value: match[0] });
      index += match[0].length;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index))!;
      tokens.push({ type: "name", value: match[0] });
      index += match[0].length;
      continue;
    }

    const operator = OPERATORS.find((candidate) =>
      source.startsWith(candidate, index),
    );
    if (!operator) {
      throw new FormulaError(`Unexpected character "${char}"`);
    }
    tokens.push({ type: "op", value: operator });
    index += operator.length;
  }

  return tokens;
}

/** Recursive-descent parser, loosest binding first. */
function createParser(tokens: Token[]) {
  let position = 0;

  const peek = () => tokens[position];
  const eat = (value: string) => {
    const token = peek();
    if (token && token.type === "op" && token.value === value) {
      position += 1;
      return true;
    }
    return false;
  };
  const expect = (value: string) => {
    if (!eat(value)) throw new FormulaError(`Expected "${value}"`);
  };

  function parseExpression(): Node {
    const test = parseBinary(0);
    if (!eat("?")) return test;

    const then = parseExpression();
    expect(":");
    return { kind: "ternary", test, then, otherwise: parseExpression() };
  }

  // Precedence climbing: each tier binds tighter than the one before it.
  const PRECEDENCE: string[][] = [
    ["||"],
    ["&&"],
    ["==", "!="],
    ["<", "<=", ">", ">="],
    ["+", "-"],
    ["*", "/", "%"],
  ];

  function parseBinary(tier: number): Node {
    if (tier >= PRECEDENCE.length) return parseUnary();

    let left = parseBinary(tier + 1);
    for (;;) {
      const token = peek();
      if (!token || token.type !== "op" || !PRECEDENCE[tier].includes(token.value)) {
        return left;
      }
      position += 1;
      left = {
        kind: "binary",
        op: token.value,
        left,
        right: parseBinary(tier + 1),
      };
    }
  }

  function parseUnary(): Node {
    const token = peek();
    if (token && token.type === "op" && ["-", "+", "!"].includes(token.value)) {
      position += 1;
      return { kind: "unary", op: token.value, operand: parseUnary() };
    }
    return parsePower();
  }

  function parsePower(): Node {
    const base = parsePrimary();
    // Right-associative, and binds tighter than unary minus on the right side.
    if (eat("^")) {
      return { kind: "binary", op: "^", left: base, right: parseUnary() };
    }
    return base;
  }

  function parsePrimary(): Node {
    const token = peek();
    if (!token) throw new FormulaError("Unexpected end of formula");

    if (token.type === "number") {
      position += 1;
      return { kind: "number", value: Number(token.value) };
    }

    if (token.type === "name") {
      position += 1;
      if (eat("(")) {
        const args: Node[] = [];
        if (!eat(")")) {
          do {
            args.push(parseExpression());
          } while (eat(","));
          expect(")");
        }
        return { kind: "call", name: token.value, args };
      }
      return { kind: "variable", name: token.value };
    }

    if (eat("(")) {
      const inner = parseExpression();
      expect(")");
      return inner;
    }

    throw new FormulaError(`Unexpected "${token.value}"`);
  }

  return {
    parse() {
      const node = parseExpression();
      if (position < tokens.length) {
        throw new FormulaError(`Unexpected "${tokens[position].value}"`);
      }
      return node;
    },
  };
}

export function parseFormula(source: string): Node {
  if (!source || !source.trim()) {
    throw new FormulaError("Formula is empty");
  }
  return createParser(tokenize(source)).parse();
}

/** Every identifier the formula reads, so callers can check them against the fields. */
export function collectVariables(node: Node, found = new Set<string>()) {
  switch (node.kind) {
    case "variable":
      found.add(node.name);
      break;
    case "unary":
      collectVariables(node.operand, found);
      break;
    case "binary":
      collectVariables(node.left, found);
      collectVariables(node.right, found);
      break;
    case "ternary":
      collectVariables(node.test, found);
      collectVariables(node.then, found);
      collectVariables(node.otherwise, found);
      break;
    case "call":
      if (!FUNCTIONS[node.name]) {
        throw new FormulaError(`Unknown function "${node.name}()"`);
      }
      node.args.forEach((arg) => collectVariables(arg, found));
      break;
    default:
      break;
  }
  return found;
}

export function evaluate(node: Node, variables: Record<string, number>): number {
  switch (node.kind) {
    case "number":
      return node.value;

    case "variable": {
      const value = variables[node.name];
      if (typeof value !== "number" || Number.isNaN(value)) {
        throw new FormulaError(`No value for "${node.name}"`);
      }
      return value;
    }

    case "unary": {
      const value = evaluate(node.operand, variables);
      if (node.op === "-") return -value;
      if (node.op === "!") return value ? 0 : 1;
      return value;
    }

    case "binary": {
      const left = evaluate(node.left, variables);

      // Short-circuit before evaluating the right side.
      if (node.op === "&&") return left && evaluate(node.right, variables) ? 1 : 0;
      if (node.op === "||") return left ? 1 : evaluate(node.right, variables) ? 1 : 0;

      const right = evaluate(node.right, variables);
      switch (node.op) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          if (right === 0) throw new FormulaError("Division by zero");
          return left / right;
        case "%":
          if (right === 0) throw new FormulaError("Division by zero");
          return left % right;
        case "^":
          return Math.pow(left, right);
        case "<":
          return left < right ? 1 : 0;
        case "<=":
          return left <= right ? 1 : 0;
        case ">":
          return left > right ? 1 : 0;
        case ">=":
          return left >= right ? 1 : 0;
        case "==":
          return left === right ? 1 : 0;
        case "!=":
          return left !== right ? 1 : 0;
        default:
          throw new FormulaError(`Unknown operator "${node.op}"`);
      }
    }

    case "ternary":
      return evaluate(node.test, variables)
        ? evaluate(node.then, variables)
        : evaluate(node.otherwise, variables);

    case "call": {
      const fn = FUNCTIONS[node.name];
      if (!fn) throw new FormulaError(`Unknown function "${node.name}()"`);
      return fn(...node.args.map((arg) => evaluate(arg, variables)));
    }

    default:
      throw new FormulaError("Invalid formula");
  }
}

export function runFormula(
  source: string,
  variables: Record<string, number>,
): number {
  const result = evaluate(parseFormula(source), variables);
  if (!Number.isFinite(result)) {
    throw new FormulaError("Formula did not produce a usable number");
  }
  return result;
}
