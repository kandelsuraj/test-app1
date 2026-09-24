import { useEffect, useRef, useState } from "react";
import type { ComponentRef } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useRouteError,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import {
  adoptLegacyCalculators,
  deleteCalculator,
  listCalculators,
  loadProducts,
} from "../calculators.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  await adoptLegacyCalculators(admin, session.shop);
  const calculators = await listCalculators(session.shop);
  const products = await loadProducts(
    admin,
    Array.from(
      new Set(calculators.flatMap((calculator) => calculator.productIds)),
    ),
  );

  return {
    calculators: calculators.map((calculator) => ({
      id: calculator.id,
      name: calculator.name,
      enabled: calculator.config.enabled,
      fieldCount: calculator.config.fields.length,
      products: calculator.productIds
        .map((id) => products.get(id))
        .filter((product) => product !== undefined)
        .map((product) => ({ id: product.id, title: product.title })),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();

  if (formData.get("intent") !== "delete") {
    return { ok: false, errors: ["Unknown action."] };
  }

  const errors = await deleteCalculator(
    admin,
    session.shop,
    String(formData.get("id") ?? ""),
  );
  return { ok: errors.length === 0, errors };
};

const MODAL_ID = "delete-calculator-modal";

// Whatever the s-modal JSX element hands to `ref`.
type ModalElement = ComponentRef<"s-modal">;

export default function CalculatorsIndex() {
  const { calculators } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const modal = useRef<ModalElement>(null);
  const [pending, setPending] = useState<{ id: string; name: string } | null>(
    null,
  );

  const isDeleting = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;

    modal.current?.hideOverlay();
    if (fetcher.data.ok) {
      shopify.toast.show("Calculator deleted");
    } else {
      shopify.toast.show(fetcher.data.errors[0] ?? "Could not delete", {
        isError: true,
      });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const confirmDelete = () => {
    if (!pending) return;
    fetcher.submit({ intent: "delete", id: pending.id }, { method: "POST" });
  };

  return (
    <s-page heading="Price calculators">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={() => navigate("/app/calculators/new")}
      >
        Create calculator
      </s-button>

      {calculators.length === 0 ? (
        <s-section>
          <s-stack direction="block" gap="base" alignItems="center">
            <s-heading>Create your first calculator</s-heading>
            <s-paragraph>
              A calculator describes the inputs a customer fills in and the
              formula that turns them into a price. Assign it to as many
              products as you like.
            </s-paragraph>
            <s-button
              variant="primary"
              onClick={() => navigate("/app/calculators/new")}
            >
              Create calculator
            </s-button>
          </s-stack>
        </s-section>
      ) : (
        <s-section padding="none">
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Calculator</s-table-header>
              <s-table-header listSlot="secondary">Products</s-table-header>
              <s-table-header listSlot="inline">Status</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {calculators.map((calculator) => (
                <s-table-row key={calculator.id}>
                  <s-table-cell>
                    <s-stack direction="block">
                      <s-link href={`/app/calculators/${calculator.id}`}>
                        {calculator.name}
                      </s-link>
                      <s-text color="subdued">
                        {calculator.fieldCount}{" "}
                        {calculator.fieldCount === 1 ? "field" : "fields"}
                      </s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    {calculator.products.length === 0 ? (
                      <s-text color="subdued">No products</s-text>
                    ) : (
                      <s-text>
                        {calculator.products
                          .slice(0, 3)
                          .map((product) => product.title)
                          .join(", ")}
                        {calculator.products.length > 3 &&
                          ` and ${calculator.products.length - 3} more`}
                      </s-text>
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    {calculator.enabled ? (
                      <s-badge tone="success">Active</s-badge>
                    ) : (
                      <s-badge tone="neutral">Off</s-badge>
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200">
                      <s-button
                        onClick={() =>
                          navigate(`/app/calculators/${calculator.id}`)
                        }
                      >
                        Edit
                      </s-button>
                      <s-button
                        tone="critical"
                        commandFor={MODAL_ID}
                        command="--show"
                        onClick={() =>
                          setPending({
                            id: calculator.id,
                            name: calculator.name,
                          })
                        }
                      >
                        Delete
                      </s-button>
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}

      <s-section slot="aside" heading="How it reaches the cart">
        <s-paragraph>
          The storefront can&apos;t set a price, so the block adds{" "}
          <s-text type="strong">quantity × the variant price</s-text> and
          records the entered values as line item properties. Price each variant
          at 0.01 and the total lands exactly on the calculated amount.
        </s-paragraph>
        <s-paragraph>
          Add the <s-text type="strong">Price calculator</s-text> app block to
          the product template in the theme editor, and hide the theme&apos;s
          own buy button on these products.
        </s-paragraph>
      </s-section>

      <s-modal id={MODAL_ID} ref={modal} heading="Delete calculator?">
        <s-paragraph>
          <s-text type="strong">{pending?.name}</s-text> will be removed from
          all of its products, and the storefront will stop showing it. This
          can&apos;t be undone.
        </s-paragraph>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          onClick={confirmDelete}
          {...(isDeleting ? { loading: true } : {})}
        >
          Delete
        </s-button>
        <s-button
          slot="secondary-actions"
          commandFor={MODAL_ID}
          command="--hide"
        >
          Cancel
        </s-button>
      </s-modal>
    </s-page>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
