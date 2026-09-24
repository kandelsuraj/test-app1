/**
 * The old one-product calculator page. Calculators now have their own list and
 * edit pages; this keeps old links working.
 */
import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { listCalculators } from "../calculators.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const productId = new URL(request.url).searchParams.get("product");

  if (productId) {
    const owner = (await listCalculators(session.shop)).find((calculator) =>
      calculator.productIds.includes(productId),
    );
    if (owner) return redirect(`/app/calculators/${owner.id}`);
  }

  return redirect("/app/calculators");
};
