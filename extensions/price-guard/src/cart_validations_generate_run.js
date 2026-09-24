// @ts-check

/**
 * Blocks checkout of calculator products at anything below their calculated
 * price.
 *
 * The storefront can't set prices, so a calculator product goes into the cart
 * as `quantity x a token price` (e.g. 4500 x $0.01), and the quantity comes
 * from the shopper's browser. Only the app's own draft-order checkout charges
 * the real price. This runs inside Shopify's checkout, where it can't be
 * bypassed, and refuses every calculator line whose price per piece is below
 * what its calculator values work out to — which is any line that didn't come
 * through the app's checkout.
 *
 * Pricing is the app's own code, so this, the storefront and the draft-order
 * checkout always agree on the price.
 */
import { normalizeConfig, priceCalculatedLine } from "../../../app/calculator";

/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 * @typedef {CartValidationsGenerateRunInput["cart"]["lines"][number]} Line
 */

const TARGET = "$.cart";

/**
 * Prices are compared in the shopper's currency. Converting and rounding can
 * move the draft's price by a cent or so, which is not a reason to block.
 */
const TOLERANCE_RATIO = 0.005;
const TOLERANCE_MIN = 0.01;

/**
 * @param {Line} line
 * @param {import("../../../app/calculator").CalculatorConfig} config
 * @param {string} title
 * @param {number} rate
 * @returns {string | null} Why the line can't be bought, or null if it can.
 */
function problemWith(line, config, title, rate) {
  const raw = line.calculator?.value;
  if (!raw) {
    return `${title} has to be ordered through its price calculator. Please remove it and add it again from the product page.`;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return `${title} has unreadable options. Please remove it and add it again from the product page.`;
  }

  const priced = priceCalculatedLine(config, payload);
  if ("error" in priced) {
    return `${title}: ${priced.error} Please remove it and add it again from the product page.`;
  }

  const expected = priced.price * rate;
  const charged = Number(line.cost.amountPerQuantity.amount);
  const tolerance = Math.max(TOLERANCE_MIN, expected * TOLERANCE_RATIO);

  if (!(charged + tolerance >= expected)) {
    return `${title} can't be checked out at this price. Please go back to your cart and use its Checkout button.`;
  }
  return null;
}

/**
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  // Adding to and editing the cart must keep working: calculator lines are
  // meant to sit there at the token price until the app's checkout prices
  // them. Every checkout step (and anything unrecognised) is checked.
  if (input.buyerJourney.step === "CART_INTERACTION") {
    return { operations: [{ validationAdd: { errors: [] } }] };
  }

  const rate = Number(input.presentmentCurrencyRate) || 1;
  /** @type {{ message: string, target: string }[]} */
  const errors = [];

  for (const line of input.cart.lines) {
    const merchandise = line.merchandise;
    if (merchandise.__typename !== "ProductVariant") continue;

    const settings = merchandise.product.calculator?.jsonValue;
    if (!settings) continue;

    let message;
    try {
      message = problemWith(
        line,
        normalizeConfig(settings),
        merchandise.product.title,
        rate,
      );
    } catch {
      // Anything unexpected about a calculator line fails closed.
      message = `${merchandise.product.title} couldn't be checked. Please contact the store.`;
    }
    if (message) errors.push({ message, target: TARGET });
  }

  return { operations: [{ validationAdd: { errors } }] };
}
