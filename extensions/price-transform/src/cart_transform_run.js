// @ts-check
import { blake2sMac, safeEqual } from "./mac";

/**
 * @typedef {import("../generated/api").CartTransformRunInput} CartTransformRunInput
 * @typedef {import("../generated/api").CartTransformRunResult} CartTransformRunResult
 * @typedef {import("../generated/api").Operation} Operation
 */

/*
 * Gives price-calculator lines the price the app signed for them.
 *
 * The app proxy (app/routes/proxy.sign.tsx) prices the customer's inputs on the
 * server and signs the result into the `_calculator` line attribute, with the
 * keyed BLAKE2s tag in `_calc_sig`, as
 * `1|<variant id>|<unit cents>|<revision>|<values>`. Here the tag is re-derived
 * from the key state stored on this cart transform.
 * A line only gets its custom price when the record names this exact variant,
 * was minted for the product's current config revision, and the signature
 * matches. Anything else is left alone and is charged the variant's own price,
 * so tampering can only ever make a line more expensive.
 *
 * Hashing dominates the instruction count (~1.1M per 64-byte block in Javy
 * against Shopify's 11M limit), so the cheap checks run first, identical lines
 * are verified once, and verification stops when the budget below runs out.
 * Going over the limit would fail the whole run and drop every line to its
 * variant price; running out of budget only does that to the remaining lines.
 *
 * Keep the format in sync with signLine() in app/pricing.server.ts.
 */

// Measured with `shopify app function run`, rounded up. Shopify's limit is 11M.
const INSTRUCTION_BUDGET = 10_000_000;
const COST_OF_SETUP = 1_000_000;
const COST_PER_LINE = 100_000;
const COST_PER_BLOCK = 1_200_000;

/** @type {CartTransformRunResult} */
const NO_CHANGES = {
  operations: [],
};

/**
 * @param {CartTransformRunInput["cart"]["lines"][number]} line
 * @param {(raw: string, signature: string) => boolean} verify
 * @param {number} rate
 * @returns {Operation | null}
 */
function expandLine(line, verify, rate) {
  const merchandise = line.merchandise;
  if (merchandise.__typename !== "ProductVariant") return null;

  const raw = line.calculator?.value;
  const signature = line.signature?.value;
  if (!raw || !signature) return null;

  // Shopify rejects expand operations on subscription lines.
  if (line.sellingPlanAllocation) return null;

  const [version, variant, unit, revision] = raw.split("|");

  // A valid signature for another variant (say, a cheaper product) is no use here.
  if (version !== "1" || `gid://shopify/ProductVariant/${variant}` !== merchandise.id) {
    return null;
  }

  // Changes on every save (including switching the calculator off) and is
  // deleted with the calculator, so prices signed against older settings fail.
  const current = merchandise.product.revision?.value;
  if (!current || current !== revision) return null;

  if (!/^\d+$/.test(unit)) return null;
  const unitCents = Number(unit);

  if (!verify(raw, signature)) return null;

  return {
    lineExpand: {
      cartLineId: line.id,
      expandedCartItems: [
        {
          merchandiseId: merchandise.id,
          quantity: 1,
          price: {
            adjustment: {
              fixedPricePerUnit: {
                // Signed in shop currency; the cart may be in another one.
                amount: ((unitCents / 100) * rate).toFixed(2),
              },
            },
          },
        },
      ],
    },
  };
}

/**
 * @param {CartTransformRunInput} input
 * @returns {CartTransformRunResult}
 */
export function cartTransformRun(input) {
  const keyState = input.cartTransform.signingKey?.value;
  if (!keyState) return NO_CHANGES;

  const rate = Number(input.presentmentCurrencyRate) || 1;

  let budget =
    INSTRUCTION_BUDGET - COST_OF_SETUP - COST_PER_LINE * input.cart.lines.length;

  // Most carts hold no calculator lines, so the key is only parsed when needed.
  /** @type {((message: string) => string) | null | undefined} */
  let sign;

  /** @type {Record<string, boolean>} */
  const verified = {};
  /** @param {string} raw @param {string} signature */
  const verify = (raw, signature) => {
    const cacheKey = `${raw}#${signature}`;
    if (!(cacheKey in verified)) {
      const cost = COST_PER_BLOCK * Math.ceil(raw.length / 64);
      if (cost > budget) return false;
      budget -= cost;
      if (sign === undefined) sign = blake2sMac(keyState);
      verified[cacheKey] = sign ? safeEqual(sign(raw), signature.toLowerCase()) : false;
    }
    return verified[cacheKey];
  };

  /** @type {Operation[]} */
  const operations = [];
  for (const line of input.cart.lines) {
    const operation = expandLine(line, verify, rate);
    if (operation) operations.push(operation);
  }

  return { operations };
}
