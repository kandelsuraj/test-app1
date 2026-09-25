/**
 * Server-signed calculator prices.
 *
 * The storefront never tells Shopify a price. It sends the customer's inputs to
 * the app proxy, which prices them with priceFromInputs() and signs the result
 * here with keyed BLAKE2s (see mac.server.ts). The price-transform cart
 * transform function re-derives the tag from the key state kept in its
 * $app:signing_key metafield and only then sets the line's price. A line with a
 * missing or forged signature is charged the variant's own price.
 */
import { randomBytes } from "node:crypto";

import prisma from "./db.server";
import { blake2sMac, keyState } from "./mac.server";

export const FUNCTION_HANDLE = "price-transform";
const KEY_NAMESPACE = "$app";
const KEY_KEY = "signing_key";

type GraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export async function getSigningKey(shop: string) {
  const existing = await prisma.priceSigningKey.findUnique({ where: { shop } });
  if (existing) return existing.secret;

  // upsert, so two first requests racing each other agree on one key.
  const created = await prisma.priceSigningKey.upsert({
    where: { shop },
    update: {},
    create: { shop, secret: randomBytes(32).toString("hex") },
  });
  return created.secret;
}

export type SignedLine = {
  /** Goes in the `_calculator` line attribute; the signature covers it verbatim. */
  calculator: string;
  /** Goes in the `_calc_sig` line attribute. */
  signature: string;
};

/**
 * The signed record is `1|<variant id>|<unit cents>|<revision>|<values>`, with
 * the entered values in field order, e.g. `1|4455667788|5425|a1b2c3d4|120,80`.
 * It lands in the order as the `_calculator` property: those are the signed
 * dimensions to fulfil from, while the labelled properties beside it are only
 * for reading.
 *
 * It is kept terse on purpose: the function re-hashes it in an interpreter
 * with a hard instruction limit, and every 64 bytes costs another block.
 *
 * Keep the format in sync with extensions/price-transform/src/cart_transform_run.js.
 */
export function signLine(
  secret: string,
  line: {
    variantId: string;
    unitCents: number;
    revision: string;
    /** In the calculator's field order. */
    values: number[];
  },
): SignedLine {
  const variant = line.variantId.split("/").pop();
  const calculator = [
    1,
    variant,
    line.unitCents,
    line.revision,
    line.values.join(","),
  ].join("|");

  return {
    calculator,
    signature: blake2sMac(Buffer.from(secret, "hex"), calculator),
  };
}

export type PriceSetupStatus =
  | { active: true }
  | { active: false; error: string };

/**
 * Make sure the cart transform exists and holds the current signing key.
 * Idempotent, so it is safe to call on every admin load.
 */
export async function ensurePriceSetup(
  admin: GraphqlClient,
  shop: string,
): Promise<PriceSetupStatus> {
  // The function only ever gets the post-key-block state, never the key.
  const functionKey = keyState(Buffer.from(await getSigningKey(shop), "hex"));

  try {
    const response = await admin.graphql(
      `#graphql
        query PriceTransforms {
          cartTransforms(first: 25) {
            nodes {
              id
              functionId
              signingKey: metafield(namespace: "${KEY_NAMESPACE}", key: "${KEY_KEY}") {
                value
              }
            }
          }
        }`,
    );
    const json = await response.json();
    // An app only sees its own cart transforms, and this app registers one.
    const existing = json.data?.cartTransforms?.nodes?.[0];

    if (!existing) {
      const createResponse = await admin.graphql(
        `#graphql
          mutation PriceTransformCreate($handle: String!, $metafields: [MetafieldInput!]) {
            cartTransformCreate(
              functionHandle: $handle
              blockOnFailure: false
              metafields: $metafields
            ) {
              cartTransform {
                id
              }
              userErrors {
                field
                message
              }
            }
          }`,
        {
          variables: {
            handle: FUNCTION_HANDLE,
            metafields: [
              {
                namespace: KEY_NAMESPACE,
                key: KEY_KEY,
                type: "single_line_text_field",
                value: functionKey,
              },
            ],
          },
        },
      );
      const createJson = await createResponse.json();
      const userErrors = createJson.data?.cartTransformCreate?.userErrors ?? [];
      if (userErrors.length > 0 || !createJson.data?.cartTransformCreate?.cartTransform) {
        return {
          active: false,
          error:
            userErrors[0]?.message ??
            "The price function could not be switched on. Deploy the app, then reload this page.",
        };
      }
      return { active: true };
    }

    if (existing.signingKey?.value !== functionKey) {
      const setResponse = await admin.graphql(
        `#graphql
          mutation PriceTransformKey($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              userErrors {
                field
                message
              }
            }
          }`,
        {
          variables: {
            metafields: [
              {
                ownerId: existing.id,
                namespace: KEY_NAMESPACE,
                key: KEY_KEY,
                type: "single_line_text_field",
                value: functionKey,
              },
            ],
          },
        },
      );
      const setJson = await setResponse.json();
      const userErrors = setJson.data?.metafieldsSet?.userErrors ?? [];
      if (userErrors.length > 0) {
        return { active: false, error: userErrors[0].message };
      }
    }

    return { active: true };
  } catch (error) {
    return {
      active: false,
      error:
        error instanceof Error
          ? error.message
          : "The price function could not be checked.",
    };
  }
}
