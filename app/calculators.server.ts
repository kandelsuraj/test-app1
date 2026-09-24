/**
 * Calculators live in the app database: a name, a config and the products that
 * use it. The storefront block and the checkout proxy never see this table —
 * they read the $app:price_calculator product metafield — so every save copies
 * the config onto each assigned product, and removing a product (or deleting
 * the calculator) deletes the metafield from it.
 */
import db from "./db.server";
import { normalizeConfig } from "./calculator";
import type { CalculatorConfig } from "./calculator";

type AdminApi = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export const NAMESPACE = "$app";
export const KEY = "price_calculator";

/** metafieldsSet and metafieldsDelete both take at most 25 at a time. */
const BATCH = 25;

export type CalculatorRecord = {
  id: string;
  name: string;
  config: CalculatorConfig;
  productIds: string[];
  updatedAt: Date;
};

type Row = {
  id: string;
  name: string;
  config: string;
  productIds: string;
  updatedAt: Date;
};

function toRecord(row: Row): CalculatorRecord {
  let config: unknown = {};
  let productIds: unknown = [];
  try {
    config = JSON.parse(row.config);
  } catch {
    // Fall through to an empty, normalized config.
  }
  try {
    productIds = JSON.parse(row.productIds);
  } catch {
    // Fall through to no products.
  }

  return {
    id: row.id,
    name: row.name,
    config: normalizeConfig(config),
    productIds: Array.isArray(productIds) ? productIds.map(String) : [],
    updatedAt: row.updatedAt,
  };
}

function chunks<T>(items: T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += BATCH) {
    result.push(items.slice(index, index + BATCH));
  }
  return result;
}

export async function listCalculators(shop: string) {
  const rows = await db.calculator.findMany({
    where: { shop },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toRecord);
}

export async function getCalculator(shop: string, id: string) {
  const row = await db.calculator.findFirst({ where: { shop, id } });
  return row ? toRecord(row) : null;
}

export type ProductSummary = {
  id: string;
  title: string;
  image: string | null;
  variantPrice: string;
  inventoryTracked: boolean;
  inventoryPolicy: string;
};

/** Current titles, images and pricing for the given products. Missing ones (deleted) are left out. */
export async function loadProducts(
  admin: AdminApi,
  ids: string[],
): Promise<Map<string, ProductSummary>> {
  const products = new Map<string, ProductSummary>();

  for (const batch of chunks(ids)) {
    const response = await admin.graphql(
      `#graphql
        query CalculatorProductSummaries($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              title
              featuredMedia {
                preview {
                  image {
                    url(transform: { maxWidth: 80, maxHeight: 80 })
                  }
                }
              }
              variants(first: 1) {
                nodes {
                  price
                  inventoryPolicy
                  inventoryItem {
                    tracked
                  }
                }
              }
            }
          }
        }`,
      { variables: { ids: batch } },
    );
    const json = await response.json();

    for (const node of json.data?.nodes ?? []) {
      if (!node?.id) continue;
      const variant = node.variants?.nodes?.[0];
      products.set(node.id, {
        id: node.id,
        title: node.title,
        image: node.featuredMedia?.preview?.image?.url ?? null,
        variantPrice: variant?.price ?? "0.00",
        inventoryTracked: variant?.inventoryItem?.tracked ?? false,
        inventoryPolicy: variant?.inventoryPolicy ?? "DENY",
      });
    }
  }

  return products;
}

async function writeMetafields(
  admin: AdminApi,
  productIds: string[],
  config: CalculatorConfig,
): Promise<string[]> {
  const errors: string[] = [];

  for (const batch of chunks(productIds)) {
    const response = await admin.graphql(
      `#graphql
        mutation CalculatorSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            userErrors {
              message
            }
          }
        }`,
      {
        variables: {
          metafields: batch.map((ownerId) => ({
            ownerId,
            namespace: NAMESPACE,
            key: KEY,
            type: "json",
            value: JSON.stringify(config),
          })),
        },
      },
    );
    const json = await response.json();
    for (const error of json.data?.metafieldsSet?.userErrors ?? []) {
      errors.push(error.message);
    }
  }

  return errors;
}

async function deleteMetafields(
  admin: AdminApi,
  productIds: string[],
): Promise<string[]> {
  const errors: string[] = [];

  for (const batch of chunks(productIds)) {
    const response = await admin.graphql(
      `#graphql
        mutation CalculatorUnset($metafields: [MetafieldIdentifierInput!]!) {
          metafieldsDelete(metafields: $metafields) {
            userErrors {
              message
            }
          }
        }`,
      {
        variables: {
          metafields: batch.map((ownerId) => ({
            ownerId,
            namespace: NAMESPACE,
            key: KEY,
          })),
        },
      },
    );
    const json = await response.json();
    for (const error of json.data?.metafieldsDelete?.userErrors ?? []) {
      errors.push(error.message);
    }
  }

  return errors;
}

/**
 * Creates (no id) or updates a calculator and syncs its products' metafields.
 * A product can only use one calculator, because it has only one metafield.
 */
export async function saveCalculator(
  admin: AdminApi,
  shop: string,
  input: {
    id: string | null;
    name: string;
    config: CalculatorConfig;
    productIds: string[];
  },
): Promise<{ id: string } | { errors: string[] }> {
  const productIds = Array.from(new Set(input.productIds));
  const existing = input.id ? await getCalculator(shop, input.id) : null;
  if (input.id && !existing) {
    return { errors: ["This calculator no longer exists."] };
  }

  const others = (await listCalculators(shop)).filter(
    (calculator) => calculator.id !== input.id,
  );
  const taken = productIds
    .map((productId) => ({
      productId,
      owner: others.find((calculator) =>
        calculator.productIds.includes(productId),
      ),
    }))
    .filter((entry) => entry.owner);

  if (taken.length > 0) {
    const titles = await loadProducts(
      admin,
      taken.map((entry) => entry.productId),
    );
    return {
      errors: taken.map(
        (entry) =>
          `${titles.get(entry.productId)?.title ?? "A product"} already uses “${entry.owner!.name}”. Remove it there first.`,
      ),
    };
  }

  const removed = (existing?.productIds ?? []).filter(
    (productId) => !productIds.includes(productId),
  );

  const errors = [
    ...(await writeMetafields(admin, productIds, input.config)),
    ...(await deleteMetafields(admin, removed)),
  ];
  if (errors.length > 0) return { errors };

  const data = {
    name: input.name,
    config: JSON.stringify(input.config),
    productIds: JSON.stringify(productIds),
  };
  const row = existing
    ? await db.calculator.update({ where: { id: existing.id }, data })
    : await db.calculator.create({ data: { ...data, shop } });

  return { id: row.id };
}

export async function deleteCalculator(
  admin: AdminApi,
  shop: string,
  id: string,
): Promise<string[]> {
  const existing = await getCalculator(shop, id);
  if (!existing) return [];

  const errors = await deleteMetafields(admin, existing.productIds);
  if (errors.length > 0) return errors;

  await db.calculator.delete({ where: { id } });
  return [];
}

/**
 * Before calculators had their own records, each product's metafield was the
 * only copy. Adopt any such product not yet owned by a calculator, grouping
 * products that share an identical config into one calculator.
 */
export async function adoptLegacyCalculators(admin: AdminApi, shop: string) {
  const response = await admin.graphql(
    `#graphql
      query CalculatorLegacyMetafields {
        metafieldDefinition(
          identifier: { ownerType: PRODUCT, namespace: "${NAMESPACE}", key: "${KEY}" }
        ) {
          metafields(first: 250) {
            nodes {
              jsonValue
              owner {
                ... on Product {
                  id
                  title
                }
              }
            }
          }
        }
      }`,
  );
  const json = await response.json();
  const nodes: {
    jsonValue: unknown;
    owner: { id?: string; title?: string } | null;
  }[] = json.data?.metafieldDefinition?.metafields?.nodes ?? [];
  if (nodes.length === 0) return;

  const owned = new Set(
    (await listCalculators(shop)).flatMap(
      (calculator) => calculator.productIds,
    ),
  );

  const groups = new Map<
    string,
    { config: CalculatorConfig; products: { id: string; title: string }[] }
  >();
  for (const node of nodes) {
    const id = node.owner?.id;
    if (!id || owned.has(id) || !node.jsonValue) continue;

    const config = normalizeConfig(node.jsonValue);
    const key = JSON.stringify(config);
    const group = groups.get(key) ?? { config, products: [] };
    group.products.push({ id, title: node.owner?.title ?? "Product" });
    groups.set(key, group);
  }

  for (const { config, products } of groups.values()) {
    await db.calculator.create({
      data: {
        shop,
        name:
          products.length === 1
            ? products[0].title
            : `${products[0].title} and ${products.length - 1} more`,
        config: JSON.stringify(config),
        productIds: JSON.stringify(products.map((product) => product.id)),
      },
    });
  }
}
