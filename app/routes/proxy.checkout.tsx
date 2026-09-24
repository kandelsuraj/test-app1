/**
 * App proxy endpoint: /apps/calculator/checkout
 *
 * The storefront hands over the cart contents and this route turns them into a
 * draft order. Every calculated price is recomputed here from the product's own
 * formula metafield — the browser sends dimensions, never a price — so editing
 * anything client-side only changes what the customer is asking for, never what
 * they are charged.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { normalizeConfig, priceCalculatedLine } from "../calculator";
import type { CalculatorConfig } from "../calculator";
import {
  DRAFT_TAG,
  draftTicket,
  scheduleDraftCleanup,
} from "../draft-orders.server";

const NAMESPACE = "$app";
const KEY = "price_calculator";
const CALC_PROPERTY = "_calculator";

type IncomingItem = {
  variantId?: number | string;
  productId?: number | string;
  quantity?: number;
  properties?: Record<string, string> | null;
};

type DraftLineItem = {
  variantId: string;
  quantity: number;
  priceOverride?: { amount: string; currencyCode: string };
  customAttributes: { key: string; value: string }[];
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function gid(type: string, id: number | string) {
  const raw = String(id);
  return raw.startsWith("gid://") ? raw : `gid://shopify/${type}/${raw}`;
}

/** Line item properties minus our internal underscore-prefixed bookkeeping. */
function visibleAttributes(properties?: Record<string, string> | null) {
  return Object.entries(properties ?? {})
    .filter(([key, value]) => !key.startsWith("_") && value !== "")
    .map(([key, value]) => ({ key, value: String(value) }));
}

function isCalculated(item: IncomingItem) {
  return Boolean(item.properties?.[CALC_PROPERTY]);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);
  return json({ error: "Use POST." }, 405);
};

type Stopwatch = ReturnType<typeof stopwatch>;

/** Times each step, so a slow checkout shows where the time went. */
function stopwatch() {
  const started = Date.now();
  let last = started;
  const steps: string[] = [];

  return {
    lap(name: string) {
      const now = Date.now();
      steps.push(`${name} ${now - last}ms`);
      last = now;
    },
    summary() {
      return `${Date.now() - started}ms (${steps.join(", ") || "no steps"})`;
    },
  };
}

const LOG = "[checkout]";

/**
 * Logs every outcome to the server console. Shopify's app proxy only waits a
 * limited time and then shows the shopper its own error page, so the timings
 * here are often the only record of why a checkout fell back.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const timer = stopwatch();

  try {
    const response = await createCheckout(request, timer);

    if (response.ok) {
      console.info(`${LOG} draft order ready in ${timer.summary()}`);
    } else {
      const body = await response.clone().text();
      console.warn(
        `${LOG} rejected with ${response.status} after ${timer.summary()}: ${body}`,
      );
    }
    return response;
  } catch (error) {
    // authenticate.public.appProxy throws a Response for bad signatures.
    if (error instanceof Response) {
      console.warn(
        `${LOG} proxy request refused with ${error.status} after ${timer.summary()}`,
      );
      throw error;
    }

    // A GraphqlQueryError carries Shopify's own explanation; that is the useful
    // part; the error object itself also holds every response header.
    const graphQLErrors = (
      error as { body?: { errors?: { graphQLErrors?: unknown } } }
    )?.body?.errors?.graphQLErrors;
    if (graphQLErrors) {
      console.error(
        `${LOG} failed after ${timer.summary()}: Shopify API error\n` +
          JSON.stringify(graphQLErrors, null, 2),
      );
    } else {
      console.error(`${LOG} failed after ${timer.summary()}:`, error);
    }
    return json({ error: "We could not start your checkout." }, 500);
  }
};

async function createCheckout(request: Request, timer: Stopwatch) {
  const { admin, session } = await authenticate.public.appProxy(request);
  timer.lap("proxy auth");

  // No stored session for this shop means the app is not properly installed.
  if (!admin) {
    return json({ error: "This shop is not connected to the app." }, 401);
  }

  let body: { items?: IncomingItem[] };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Could not read the cart." }, 400);
  }

  const items = (body.items ?? []).filter(
    (item) => item.variantId && (item.quantity ?? 0) > 0,
  );

  if (items.length === 0) {
    return json({ error: "The cart is empty." }, 400);
  }
  if (!items.some(isCalculated)) {
    // Nothing for us to price; the storefront should check out normally.
    return json({ error: "No calculated items in the cart." }, 422);
  }

  const productIds = Array.from(
    new Set(
      items
        .filter(isCalculated)
        .map((item) => (item.productId ? gid("Product", item.productId) : null))
        .filter((id): id is string => Boolean(id)),
    ),
  );

  const configResponse = await admin.graphql(
    `#graphql
      query CalculatorCheckoutConfigs($ids: [ID!]!) {
        shop {
          currencyCode
        }
        nodes(ids: $ids) {
          ... on Product {
            id
            calculator: metafield(namespace: "${NAMESPACE}", key: "${KEY}") {
              jsonValue
            }
          }
        }
      }`,
    { variables: { ids: productIds } },
  );
  const configJson = await configResponse.json();
  timer.lap("load calculator settings");
  const currencyCode: string = configJson.data?.shop?.currencyCode ?? "USD";

  const configs = new Map<string, CalculatorConfig>();
  for (const node of configJson.data?.nodes ?? []) {
    if (node?.id && node.calculator?.jsonValue) {
      configs.set(node.id, normalizeConfig(node.calculator.jsonValue));
    }
  }

  const lineItems: DraftLineItem[] = [];

  for (const item of items) {
    const variantId = gid("ProductVariant", item.variantId!);
    const attributes = visibleAttributes(item.properties);

    if (!isCalculated(item)) {
      lineItems.push({
        variantId,
        quantity: Math.max(1, Math.floor(item.quantity!)),
        customAttributes: attributes,
      });
      continue;
    }

    const productId = item.productId ? gid("Product", item.productId) : "";
    const config = configs.get(productId);
    if (!config) {
      return json(
        { error: "One of the items is no longer set up for custom pricing." },
        422,
      );
    }

    let payload: { values?: Record<string, number>; pieces?: number };
    try {
      payload = JSON.parse(item.properties![CALC_PROPERTY]);
    } catch {
      return json({ error: "One of the items has unreadable options." }, 422);
    }

    const priced = priceCalculatedLine(config, payload);
    if ("error" in priced) {
      return json({ error: priced.error }, 422);
    }

    lineItems.push({
      variantId,
      quantity: priced.pieces,
      priceOverride: {
        amount: priced.price.toFixed(2),
        currencyCode,
      },
      customAttributes: attributes,
    });
  }

  const draftResponse = await admin.graphql(
    `#graphql
      mutation CalculatorDraftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder {
            id
            invoiceUrl
          }
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        input: {
          lineItems,
          tags: [DRAFT_TAG],
          note: "Created from the storefront price calculator.",
        },
      },
    },
  );
  const draftJson = await draftResponse.json();
  timer.lap("create draft order");
  const userErrors = draftJson.data?.draftOrderCreate?.userErrors ?? [];

  if (userErrors.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`${LOG} draftOrderCreate userErrors:`, userErrors);
    return json({ error: "We could not start your checkout." }, 502);
  }

  const draftOrder = draftJson.data?.draftOrderCreate?.draftOrder;
  if (!draftOrder?.invoiceUrl) {
    return json({ error: "We could not start your checkout." }, 502);
  }

  // A good moment to clear out drafts from checkouts nobody finished.
  if (session) scheduleDraftCleanup(admin, session.shop);

  return json({
    invoiceUrl: draftOrder.invoiceUrl,
    // Lets the storefront ask later whether this draft was paid.
    ticket: draftTicket(draftOrder.id),
  });
}
