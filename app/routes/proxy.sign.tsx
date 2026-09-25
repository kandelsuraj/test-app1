import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { normalizeConfig, priceFromInputs } from "../calculator";
import { getSigningKey, signLine } from "../pricing.server";

/**
 * POST /apps/price-calc/sign on the storefront, proxied here by Shopify.
 *
 * Takes the customer's raw inputs, prices them with the product's saved config,
 * and returns the signed line attributes the storefront block adds to the cart.
 * The price the browser calculated is never read: only the inputs are.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  // Verifies Shopify's signature on the proxied request.
  const { admin, session } = await authenticate.public.appProxy(request);
  if (!admin || !session) {
    return Response.json(
      { ok: false, error: "This store has not finished setting up the app." },
      { status: 503 },
    );
  }

  let body: { variantId?: unknown; values?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const variantNumber = String(body.variantId ?? "");
  if (!/^\d+$/.test(variantNumber)) {
    return Response.json({ ok: false, error: "Bad request." }, { status: 400 });
  }
  const variantId = `gid://shopify/ProductVariant/${variantNumber}`;

  const response = await admin.graphql(
    `#graphql
      query SignVariant($id: ID!) {
        productVariant(id: $id) {
          id
          product {
            id
            calculator: metafield(namespace: "$app", key: "price_calculator") {
              jsonValue
            }
          }
        }
      }`,
    { variables: { id: variantId } },
  );
  const json = await response.json();
  const variant = json.data?.productVariant;
  const rawConfig = variant?.product?.calculator?.jsonValue;

  if (!variant || !rawConfig) {
    return Response.json(
      { ok: false, error: "This product can't be priced." },
      { status: 404 },
    );
  }

  const config = normalizeConfig(rawConfig);

  // Calculators saved before revisions existed have none, and the price
  // function rejects a line without one. Give them one on first use.
  if (!config.revision) {
    config.revision = crypto.randomUUID().slice(0, 8);
    const saved = await admin.graphql(
      `#graphql
        mutation BackfillRevision($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            userErrors {
              message
            }
          }
        }`,
      {
        variables: {
          metafields: [
            {
              ownerId: variant.product.id,
              namespace: "$app",
              key: "price_calculator",
              type: "json",
              value: JSON.stringify(config),
            },
            {
              ownerId: variant.product.id,
              namespace: "$app",
              key: "price_revision",
              type: "single_line_text_field",
              value: config.revision,
            },
          ],
        },
      },
    );
    const savedJson = await saved.json();
    if (savedJson.data?.metafieldsSet?.userErrors?.length) {
      return Response.json(
        { ok: false, error: "This product can't be priced right now." },
        { status: 500 },
      );
    }
  }
  const priced = priceFromInputs(config, body.values);
  if ("error" in priced) {
    return Response.json({ ok: false, error: priced.error }, { status: 422 });
  }

  const signed = signLine(await getSigningKey(session.shop), {
    variantId: variant.id,
    unitCents: priced.unitCents,
    revision: config.revision,
    values: config.fields.map((field) => priced.values[field.key]),
  });

  return Response.json({
    ok: true,
    unitCents: priced.unitCents,
    ...signed,
  });
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);
  return new Response("Method not allowed", { status: 405 });
};
