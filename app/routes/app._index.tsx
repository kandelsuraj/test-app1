/**
 * `/app` is where Shopify opens the app, so it goes straight to the calculators.
 */
import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { redirect } = await authenticate.admin(request);
  return redirect("/app/calculators");
};
