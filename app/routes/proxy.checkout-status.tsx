/**
 * App proxy endpoint: /apps/calculator/checkout-status?ticket=...
 *
 * The storefront asks whether the draft it sent the shopper to has been paid,
 * so it can take those items out of the cart. The ticket is the signed token
 * the checkout endpoint issued, so a shopper can only ask about their own draft.
 */
import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { draftIdFromTicket } from "../draft-orders.server";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.public.appProxy(request);
  if (!admin) {
    return json({ error: "This shop is not connected to the app." }, 401);
  }

  const ticket = new URL(request.url).searchParams.get("ticket") ?? "";
  const draftId = draftIdFromTicket(ticket);
  if (!draftId) return json({ error: "Unknown checkout." }, 400);

  try {
    const response = await admin.graphql(
      `#graphql
        query CalculatorDraftStatus($id: ID!) {
          draftOrder(id: $id) {
            status
          }
        }`,
      { variables: { id: draftId } },
    );
    const data = await response.json();
    const status: string | undefined = data.data?.draftOrder?.status;

    // Deleted (abandoned and cleaned up, or removed by the merchant).
    if (!status) return json({ status: "GONE" });
    return json({ status });
  } catch (error) {
    console.error("[checkout status] could not read", draftId, error);
    return json({ error: "Could not check the order." }, 500);
  }
};
