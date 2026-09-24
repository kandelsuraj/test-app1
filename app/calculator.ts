/**
 * Shape of the per-product calculator config stored in the app-owned
 * $app:price_calculator product metafield, plus validation shared by the admin
 * action and the admin live preview.
 */
import {
  FormulaError,
  collectVariables,
  parseFormula,
  runFormula,
} from "./formula";

export type FieldType = "number" | "select" | "radio" | "checkbox";

/** Types the customer picks from a list of options. */
export function hasOptions(type: FieldType) {
  return type === "select" || type === "radio";
}

export type CalculatorField = {
  /** Identifier used inside the formula. */
  key: string;
  label: string;
  type: FieldType;
  /** Shown after the input, e.g. "cm". */
  unit: string;
  min: number | null;
  max: number | null;
  step: number | null;
  defaultValue: number | null;
  /** Only for "select" and "radio"; the value is what the formula sees. */
  options: { label: string; value: number }[];
};

export type CalculatorConfig = {
  enabled: boolean;
  fields: CalculatorField[];
  formula: string;
  /** Never charge less than this, in store currency. */
  minPrice: number;
  priceLabel: string;
  addToCartLabel: string;
  note: string;
  /** Let the customer buy several identical pieces on one line. */
  allowPieces: boolean;
  piecesLabel: string;
  maxPieces: number;
};

export const RESERVED_KEYS = new Set([
  "min",
  "max",
  "abs",
  "sqrt",
  "floor",
  "ceil",
  "pow",
  "round",
]);

export const EMPTY_CONFIG: CalculatorConfig = {
  enabled: true,
  fields: [
    {
      key: "width",
      label: "Width",
      type: "number",
      unit: "cm",
      min: 10,
      max: 300,
      step: 1,
      defaultValue: 100,
      options: [],
    },
    {
      key: "height",
      label: "Height",
      type: "number",
      unit: "cm",
      min: 10,
      max: 300,
      step: 1,
      defaultValue: 100,
      options: [],
    },
  ],
  formula: "width * height / 10000 * 45",
  minPrice: 0,
  priceLabel: "Your price",
  addToCartLabel: "Add to cart",
  note: "",
  allowPieces: true,
  piecesLabel: "Quantity",
  maxPieces: 100,
};

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Coerce anything read from the metafield (or a form) into a known-good config. */
export function normalizeConfig(input: unknown): CalculatorConfig {
  const raw = (input ?? {}) as Partial<CalculatorConfig>;
  const fields = Array.isArray(raw.fields) ? raw.fields : [];

  return {
    enabled: raw.enabled !== false,
    formula: typeof raw.formula === "string" ? raw.formula : "",
    minPrice: toNumberOrNull(raw.minPrice) ?? 0,
    priceLabel:
      typeof raw.priceLabel === "string" && raw.priceLabel.trim()
        ? raw.priceLabel
        : "Your price",
    addToCartLabel:
      typeof raw.addToCartLabel === "string" && raw.addToCartLabel.trim()
        ? raw.addToCartLabel
        : "Add to cart",
    note: typeof raw.note === "string" ? raw.note : "",
    allowPieces: raw.allowPieces !== false,
    piecesLabel:
      typeof raw.piecesLabel === "string" && raw.piecesLabel.trim()
        ? raw.piecesLabel
        : "Pieces",
    maxPieces: Math.min(
      1000,
      Math.max(1, Math.round(toNumberOrNull(raw.maxPieces) ?? 100)),
    ),
    fields: fields.map((field) => {
      const type: FieldType =
        field?.type === "select" ||
        field?.type === "radio" ||
        field?.type === "checkbox"
          ? field.type
          : "number";

      return {
        key: String(field?.key ?? "").trim(),
        label: String(field?.label ?? "").trim(),
        type,
        unit: String(field?.unit ?? "").trim(),
        min: toNumberOrNull(field?.min),
        max: toNumberOrNull(field?.max),
        step: toNumberOrNull(field?.step),
        defaultValue: toNumberOrNull(field?.defaultValue),
        options: Array.isArray(field?.options)
          ? field.options
              .map((option) => ({
                label: String(option?.label ?? "").trim(),
                value: toNumberOrNull(option?.value) ?? 0,
              }))
              .filter((option) => option.label !== "")
          : [],
      };
    }),
  };
}

/** Human-readable problems. An empty array means the config is safe to save. */
export function validateConfig(config: CalculatorConfig): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const labels = new Set<string>();

  if (config.fields.length === 0) {
    errors.push("Add at least one input field.");
  }

  config.fields.forEach((field, index) => {
    const position = field.label || `Field ${index + 1}`;

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.key)) {
      errors.push(
        `${position}: the key must start with a letter and use only letters, numbers, and underscores.`,
      );
    } else if (RESERVED_KEYS.has(field.key)) {
      errors.push(`${position}: "${field.key}" is a built-in function name.`);
    } else if (seen.has(field.key)) {
      errors.push(`${position}: the key "${field.key}" is used twice.`);
    }
    seen.add(field.key);

    // The label becomes the cart line item property name, so it has to be
    // unique and free of the brackets that delimit a property name.
    if (!field.label) {
      errors.push(`Field ${index + 1}: add a label.`);
    } else if (labels.has(field.label.toLowerCase())) {
      errors.push(`${position}: another field already uses this label.`);
    } else if (/[[\]]/.test(field.label)) {
      errors.push(`${position}: the label cannot contain [ or ].`);
    }
    labels.add(field.label.toLowerCase());

    if (field.min !== null && field.max !== null && field.min > field.max) {
      errors.push(`${position}: the minimum is larger than the maximum.`);
    }

    if (hasOptions(field.type) && field.options.length === 0) {
      errors.push(
        `${position}: ${field.type === "radio" ? "radio buttons need" : "a dropdown needs"} at least one option.`,
      );
    }
  });

  try {
    const variables = collectVariables(parseFormula(config.formula));
    variables.forEach((name) => {
      if (!seen.has(name)) {
        errors.push(`Formula uses "${name}", which is not one of the fields.`);
      }
    });
  } catch (error) {
    errors.push(
      error instanceof FormulaError
        ? `Formula: ${error.message}`
        : "Formula could not be read.",
    );
  }

  if (config.minPrice < 0) {
    errors.push("The minimum price cannot be negative.");
  }

  if (config.allowPieces) {
    // It becomes a line item property too, so the same rules apply.
    if (!config.piecesLabel.trim()) {
      errors.push("Give the pieces selector a label.");
    } else if (labels.has(config.piecesLabel.toLowerCase())) {
      errors.push("A field already uses the pieces label.");
    } else if (/[[\]]/.test(config.piecesLabel)) {
      errors.push("The pieces label cannot contain [ or ].");
    }
  }

  return errors;
}

/** The value a field contributes to the formula before the customer touches it. */
export function defaultValueFor(field: CalculatorField): number {
  if (field.type === "checkbox") return field.defaultValue ? 1 : 0;
  if (hasOptions(field.type)) {
    return field.defaultValue ?? field.options[0]?.value ?? 0;
  }
  return field.defaultValue ?? field.min ?? 0;
}

/**
 * The storefront can't set a price, so the line is charged as
 * `quantity x variant price`. Picking the quantity is the whole trick: the
 * variant should be priced at the smallest unit (1 cent is exact).
 */
export function quantityForPrice(priceCents: number, unitCents: number) {
  if (!unitCents || unitCents < 1) {
    return { quantity: 1, chargedCents: unitCents || 0 };
  }

  const quantity = Math.max(1, Math.round(priceCents / unitCents));
  return { quantity, chargedCents: quantity * unitCents };
}

/**
 * The formula prices one piece; buying several multiplies it. Pieces stay out of
 * the formula on purpose, so a merchant can never forget to multiply by them.
 */
export function totalCents(
  unitPrice: number,
  minPrice: number,
  pieces: number,
) {
  const perPiece = Math.max(unitPrice, minPrice);
  return Math.round(perPiece * 100) * Math.max(1, Math.round(pieces));
}

/**
 * Authoritative pricing for one cart line, used by the app proxy at checkout.
 *
 * Deliberately ignores any price the storefront claims: it reads only the
 * customer's entered values and re-derives everything from the merchant's
 * config, so a tampered payload changes what is ordered, never what is charged.
 */
export function priceCalculatedLine(
  config: CalculatorConfig,
  payload: { values?: Record<string, number>; pieces?: number },
): { price: number; pieces: number } | { error: string } {
  const values = payload.values ?? {};

  for (const field of config.fields) {
    const value = values[field.key];

    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { error: `Missing a value for ${field.label || field.key}.` };
    }
    if (field.type === "number") {
      if (field.min !== null && value < field.min) {
        return { error: `${field.label || field.key} is below the minimum.` };
      }
      if (field.max !== null && value > field.max) {
        return { error: `${field.label || field.key} is above the maximum.` };
      }
    }
  }

  let perPiece: number;
  try {
    perPiece = runFormula(config.formula, values);
  } catch (error) {
    return {
      error:
        error instanceof FormulaError
          ? "This product is not priced correctly yet."
          : "We could not work out a price for this item.",
    };
  }

  perPiece = Math.max(perPiece, config.minPrice);
  if (!Number.isFinite(perPiece) || perPiece < 0) {
    return { error: "We could not work out a price for this item." };
  }

  const requested = config.allowPieces
    ? Math.floor(Number(payload.pieces) || 1)
    : 1;
  const pieces = Math.min(Math.max(requested, 1), config.maxPieces);

  return { price: perPiece, pieces };
}
