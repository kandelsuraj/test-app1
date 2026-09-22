/*
 * Storefront half of the price calculator.
 *
 * The parser below is a plain-JS port of app/formula.ts in the app itself, so a
 * formula previews in the admin exactly as it prices on the storefront. Keep the
 * grammar and the FUNCTIONS table in sync with that file.
 */
(function () {
  'use strict';

  var FUNCTIONS = {
    min: Math.min,
    max: Math.max,
    abs: Math.abs,
    sqrt: Math.sqrt,
    floor: Math.floor,
    ceil: Math.ceil,
    pow: Math.pow,
    round: function (value, digits) {
      var factor = Math.pow(10, digits || 0);
      return Math.round(value * factor) / factor;
    }
  };

  var OPERATORS = [
    '<=', '>=', '==', '!=', '&&', '||',
    '+', '-', '*', '/', '%', '^', '(', ')', ',', '?', ':', '<', '>', '!'
  ];

  var PRECEDENCE = [
    ['||'],
    ['&&'],
    ['==', '!='],
    ['<', '<=', '>', '>='],
    ['+', '-'],
    ['*', '/', '%']
  ];

  function FormulaError(message) {
    this.message = message;
  }
  FormulaError.prototype = Object.create(Error.prototype);

  function tokenize(source) {
    var tokens = [];
    var index = 0;

    while (index < source.length) {
      var char = source.charAt(index);

      if (/\s/.test(char)) {
        index += 1;
        continue;
      }

      if (/[0-9.]/.test(char)) {
        var number = /^[0-9]*\.?[0-9]+/.exec(source.slice(index));
        if (!number) throw new FormulaError('Invalid number');
        tokens.push({ type: 'number', value: number[0] });
        index += number[0].length;
        continue;
      }

      if (/[A-Za-z_]/.test(char)) {
        var name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index));
        tokens.push({ type: 'name', value: name[0] });
        index += name[0].length;
        continue;
      }

      var operator = null;
      for (var i = 0; i < OPERATORS.length; i += 1) {
        if (source.slice(index, index + OPERATORS[i].length) === OPERATORS[i]) {
          operator = OPERATORS[i];
          break;
        }
      }
      if (!operator) throw new FormulaError('Unexpected character "' + char + '"');
      tokens.push({ type: 'op', value: operator });
      index += operator.length;
    }

    return tokens;
  }

  function parse(source) {
    var tokens = tokenize(source);
    var position = 0;

    function peek() {
      return tokens[position];
    }

    function eat(value) {
      var token = peek();
      if (token && token.type === 'op' && token.value === value) {
        position += 1;
        return true;
      }
      return false;
    }

    function expect(value) {
      if (!eat(value)) throw new FormulaError('Expected "' + value + '"');
    }

    function parseExpression() {
      var test = parseBinary(0);
      if (!eat('?')) return test;

      var then = parseExpression();
      expect(':');
      return { kind: 'ternary', test: test, then: then, otherwise: parseExpression() };
    }

    function parseBinary(tier) {
      if (tier >= PRECEDENCE.length) return parseUnary();

      var left = parseBinary(tier + 1);
      for (;;) {
        var token = peek();
        if (!token || token.type !== 'op' || PRECEDENCE[tier].indexOf(token.value) === -1) {
          return left;
        }
        position += 1;
        left = {
          kind: 'binary',
          op: token.value,
          left: left,
          right: parseBinary(tier + 1)
        };
      }
    }

    function parseUnary() {
      var token = peek();
      if (token && token.type === 'op' && ['-', '+', '!'].indexOf(token.value) !== -1) {
        position += 1;
        return { kind: 'unary', op: token.value, operand: parseUnary() };
      }
      return parsePower();
    }

    function parsePower() {
      var base = parsePrimary();
      if (eat('^')) {
        return { kind: 'binary', op: '^', left: base, right: parseUnary() };
      }
      return base;
    }

    function parsePrimary() {
      var token = peek();
      if (!token) throw new FormulaError('Unexpected end of formula');

      if (token.type === 'number') {
        position += 1;
        return { kind: 'number', value: Number(token.value) };
      }

      if (token.type === 'name') {
        position += 1;
        if (eat('(')) {
          var args = [];
          if (!eat(')')) {
            do {
              args.push(parseExpression());
            } while (eat(','));
            expect(')');
          }
          return { kind: 'call', name: token.value, args: args };
        }
        return { kind: 'variable', name: token.value };
      }

      if (eat('(')) {
        var inner = parseExpression();
        expect(')');
        return inner;
      }

      throw new FormulaError('Unexpected "' + token.value + '"');
    }

    var node = parseExpression();
    if (position < tokens.length) {
      throw new FormulaError('Unexpected "' + tokens[position].value + '"');
    }
    return node;
  }

  function evaluate(node, variables) {
    switch (node.kind) {
      case 'number':
        return node.value;

      case 'variable': {
        var value = variables[node.name];
        if (typeof value !== 'number' || isNaN(value)) {
          throw new FormulaError('No value for "' + node.name + '"');
        }
        return value;
      }

      case 'unary': {
        var operand = evaluate(node.operand, variables);
        if (node.op === '-') return -operand;
        if (node.op === '!') return operand ? 0 : 1;
        return operand;
      }

      case 'binary': {
        var left = evaluate(node.left, variables);
        if (node.op === '&&') return left && evaluate(node.right, variables) ? 1 : 0;
        if (node.op === '||') return left ? 1 : evaluate(node.right, variables) ? 1 : 0;

        var right = evaluate(node.right, variables);
        switch (node.op) {
          case '+': return left + right;
          case '-': return left - right;
          case '*': return left * right;
          case '/':
            if (right === 0) throw new FormulaError('Division by zero');
            return left / right;
          case '%':
            if (right === 0) throw new FormulaError('Division by zero');
            return left % right;
          case '^': return Math.pow(left, right);
          case '<': return left < right ? 1 : 0;
          case '<=': return left <= right ? 1 : 0;
          case '>': return left > right ? 1 : 0;
          case '>=': return left >= right ? 1 : 0;
          case '==': return left === right ? 1 : 0;
          case '!=': return left !== right ? 1 : 0;
          default: throw new FormulaError('Unknown operator');
        }
      }

      case 'ternary':
        return evaluate(node.test, variables)
          ? evaluate(node.then, variables)
          : evaluate(node.otherwise, variables);

      case 'call': {
        var fn = FUNCTIONS[node.name];
        if (!fn) throw new FormulaError('Unknown function "' + node.name + '()"');
        var args = node.args.map(function (arg) {
          return evaluate(arg, variables);
        });
        return fn.apply(null, args);
      }

      default:
        throw new FormulaError('Invalid formula');
    }
  }

  function setup(root) {
    if (root.dataset.priceCalcReady === 'true') return;
    root.dataset.priceCalcReady = 'true';

    var config;
    try {
      config = JSON.parse(root.getAttribute('data-config') || '{}');
    } catch (error) {
      return;
    }

    var unitCents = parseInt(root.getAttribute('data-unit-cents'), 10) || 0;
    var currency = root.getAttribute('data-currency') || 'USD';
    var output = root.querySelector('[data-price-calc-output]');
    var errorNode = root.querySelector('[data-price-calc-error]');
    var quantityInput = root.querySelector('[data-price-calc-quantity]');
    var rawInput = root.querySelector('[data-price-calc-raw]');
    var submit = root.querySelector('[data-price-calc-submit]');
    var piecesInput = root.querySelector('[data-price-calc-pieces]');
    var piecesProp = root.querySelector('[data-price-calc-pieces-prop]');
    var maxPieces = piecesInput ? parseInt(piecesInput.max, 10) || 100 : 1;
    var controls = Array.prototype.slice.call(root.querySelectorAll('[data-calc-key]'));

    var formatter;
    try {
      formatter = new Intl.NumberFormat(document.documentElement.lang || undefined, {
        style: 'currency',
        currency: currency
      });
    } catch (error) {
      formatter = { format: function (amount) { return amount.toFixed(2); } };
    }

    var ast;
    try {
      ast = parse(config.formula || '');
    } catch (error) {
      showError('This product is not priced correctly yet.');
      return;
    }

    var fieldsByKey = {};
    (config.fields || []).forEach(function (field) {
      fieldsByKey[field.key] = field;
    });

    function showError(message) {
      if (!errorNode) return;
      errorNode.textContent = message;
      errorNode.hidden = !message;
    }

    function readControl(control) {
      var type = control.getAttribute('data-calc-type');
      if (type === 'checkbox') return control.checked ? 1 : 0;
      if (type === 'select') return Number(control.value);
      return control.value === '' ? NaN : Number(control.value);
    }

    function displayValue(control, field) {
      var type = control.getAttribute('data-calc-type');
      if (type === 'checkbox') return control.checked ? 'Yes' : 'No';
      if (type === 'select') {
        var option = control.options[control.selectedIndex];
        return option ? option.textContent.trim() : '';
      }
      return field && field.unit ? control.value + ' ' + field.unit : control.value;
    }

    function update() {
      var variables = {};
      var problem = null;

      controls.forEach(function (control) {
        var key = control.getAttribute('data-calc-key');
        var field = fieldsByKey[key] || {};
        var value = readControl(control);

        if (isNaN(value)) {
          problem = problem || 'Fill in ' + (field.label || key) + '.';
          return;
        }
        if (control.getAttribute('data-calc-type') === 'number') {
          if (field.min !== null && field.min !== undefined && value < field.min) {
            problem = problem || (field.label || key) + ' must be at least ' + field.min + (field.unit ? ' ' + field.unit : '') + '.';
          }
          if (field.max !== null && field.max !== undefined && value > field.max) {
            problem = problem || (field.label || key) + ' can be at most ' + field.max + (field.unit ? ' ' + field.unit : '') + '.';
          }
        }

        variables[key] = value;
      });

      var pieces = 1;
      if (piecesInput) {
        pieces = Math.floor(Number(piecesInput.value));
        if (!pieces || pieces < 1) {
          problem = problem || 'Choose how many you want.';
        } else if (pieces > maxPieces) {
          problem = problem || 'You can order at most ' + maxPieces + ' at a time.';
        }
      }

      if (problem) return fail(problem);
      if (unitCents < 1) return fail('This product needs a price before it can be sold.');

      var price;
      try {
        price = evaluate(ast, variables);
      } catch (error) {
        return fail('We could not work out a price for those values.');
      }

      if (!isFinite(price)) return fail('We could not work out a price for those values.');

      // The formula prices one piece; buying several multiplies it.
      var perPieceCents = Math.round(Math.max(price, Number(config.minPrice) || 0) * 100);
      var totalCents = perPieceCents * pieces;

      var quantity = Math.max(1, Math.round(totalCents / unitCents));
      var chargedCents = quantity * unitCents;

      if (piecesProp) piecesProp.value = String(pieces);

      if (output) output.textContent = formatter.format(chargedCents / 100);
      if (quantityInput) quantityInput.value = String(quantity);

      // Mirror the readable values into the line item properties.
      controls.forEach(function (control) {
        var key = control.getAttribute('data-calc-key');
        var property = root.querySelector('[data-calc-prop="' + key + '"]');
        if (property) property.value = displayValue(control, fieldsByKey[key]);
      });

      if (rawInput) {
        rawInput.value = JSON.stringify({
          values: variables,
          pieces: pieces,
          perPiece: perPieceCents / 100,
          price: chargedCents / 100,
          unit: unitCents / 100
        });
      }

      showError('');
      if (submit) submit.disabled = false;
    }

    function fail(message) {
      if (output) output.textContent = '—';
      if (submit) submit.disabled = true;
      showError(message);
    }

    controls.forEach(function (control) {
      control.addEventListener('input', update);
      control.addEventListener('change', update);
    });

    if (piecesInput) {
      piecesInput.addEventListener('input', update);
      piecesInput.addEventListener('change', update);
    }

    update();
  }

  function scan(scope) {
    var root = scope || document;
    Array.prototype.slice
      .call(root.querySelectorAll('[data-price-calculator]'))
      .forEach(setup);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { scan(); });
  } else {
    scan();
  }

  // Theme editor re-renders sections without a page load.
  document.addEventListener('shopify:section:load', function (event) {
    scan(event.target);
  });
  document.addEventListener('shopify:block:select', function (event) {
    scan(event.target);
  });
})();
