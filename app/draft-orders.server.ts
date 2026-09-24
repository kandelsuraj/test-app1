/**
 * Housekeeping for the draft orders the storefront checkout creates.
 *
 * Every checkout click makes a draft. Paid ones become orders and are marked
 * completed; abandoned ones would otherwise sit open in the admin forever, so
 * old open ones are deleted. Shoppers also get a signed ticket for their draft,
 * which lets the storefront ask later whether it was paid (to empty the cart)
 * without being able to ask about anyone else's draft.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

type AdminApi = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

/** Every draft the app creates carries this tag; clean-up only touches these. */
export const DRAFT_TAG = "price-calculator";

/** Open drafts older than this are treated as abandoned. */
export const ABANDONED_AFTER_DAYS = 7;

/** Clean-up runs at most this often per shop. */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** Deleted per run; anything left over goes on the next run. */
const CLEANUP_BATCH = 25;

const LOG = "[draft cleanup]";

function sign(value: string) {
  return createHmac("sha256", process.env.SHOPIFY_API_SECRET || "")
    .update(value)
    .digest("base64url");
}

/** A token naming one draft, which only this app could have issued. */
export function draftTicket(draftId: string) {
  const numericId = draftId.split("/").pop() ?? "";
  return `${numericId}.${sign(numericId)}`;
}

/** The draft's GID if the ticket is genuine, otherwise null. */
export function draftIdFromTicket(ticket: string): string | null {
  const [numericId, signature] = ticket.split(".");
  if (!numericId || !signature || !/^\d+$/.test(numericId)) return null;

  const expected = Buffer.from(sign(numericId));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }
  return `gid://shopify/DraftOrder/${numericId}`;
}

const lastCleanup = new Map<string, number>();

/**
 * Deletes abandoned drafts in the background. It never delays the checkout
 * that triggered it, and a failure is only logged.
 */
export function scheduleDraftCleanup(admin: AdminApi, shop: string) {
  const now = Date.now();
  if (now - (lastCleanup.get(shop) ?? 0) < CLEANUP_INTERVAL_MS) return;
  lastCleanup.set(shop, now);

  deleteAbandonedDrafts(admin)
    .then((count) => {
      if (count > 0) {
        console.info(`${LOG} deleted ${count} abandoned draft(s) for ${shop}`);
      }
    })
    .catch((error) => {
      console.error(`${LOG} failed for ${shop}:`, error);
    });
}

async function deleteAbandonedDrafts(admin: AdminApi) {
  const cutoff = new Date(Date.now() - ABANDONED_AFTER_DAYS * 86_400_000);

  const response = await admin.graphql(
    `#graphql
      query CalculatorAbandonedDrafts($query: String!, $first: Int!) {
        draftOrders(first: $first, query: $query) {
          nodes {
            id
            status
            tags
            createdAt
          }
        }
      }`,
    {
      variables: {
        first: CLEANUP_BATCH,
        query: `tag:'${DRAFT_TAG}' AND status:open AND created_at:<'${cutoff.toISOString()}'`,
      },
    },
  );
  const json = await response.json();
  const nodes: {
    id: string;
    status: string;
    tags: string[];
    createdAt: string;
  }[] = json.data?.draftOrders?.nodes ?? [];

  // Re-check everything the search returned: a search that matched more than
  // intended must never delete a merchant's own or a paid draft.
  const abandoned = nodes.filter(
    (node) =>
      node.status === "OPEN" &&
      node.tags.includes(DRAFT_TAG) &&
      new Date(node.createdAt) < cutoff,
  );

  let deleted = 0;
  for (const draft of abandoned) {
    const result = await admin.graphql(
      `#graphql
        mutation CalculatorDeleteDraft($input: DraftOrderDeleteInput!) {
          draftOrderDelete(input: $input) {
            deletedId
            userErrors {
              message
            }
          }
        }`,
      { variables: { input: { id: draft.id } } },
    );
    const resultJson = await result.json();
    const errors = resultJson.data?.draftOrderDelete?.userErrors ?? [];
    if (errors.length > 0) {
      console.warn(`${LOG} could not delete ${draft.id}:`, errors);
    } else {
      deleted += 1;
    }
  }
  return deleted;
}
