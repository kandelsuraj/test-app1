import { useCallback, useEffect, useMemo, useState } from "react";
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
  EMPTY_CONFIG,
  defaultValueFor,
  normalizeConfig,
  quantityForPrice,
  totalCents,
  validateConfig,
} from "../calculator";
import type { CalculatorConfig, CalculatorField, FieldType } from "../calculator";
import { FUNCTION_NAMES, FormulaError, runFormula } from "../formula";

const NAMESPACE = "$app";
const KEY = "price_calculator";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const productId = new URL(request.url).searchParams.get("product");

  const listResponse = await admin.graphql(
    `#graphql
      query CalculatorProducts {
        shop {
          currencyCode
        }
        products(first: 50, sortKey: UPDATED_AT, reverse: true) {
          nodes {
            id
            title
            calculator: metafield(namespace: "${NAMESPACE}", key: "${KEY}") {
              jsonValue
            }
          }
        }
      }`,
  );
  const listJson = await listResponse.json();
  const currencyCode: string = listJson.data?.shop?.currencyCode ?? "USD";
  const configured = (listJson.data?.products?.nodes ?? [])
    .filter(
      (node: { calculator?: { jsonValue?: unknown } | null }) =>
        node.calculator?.jsonValue,
    )
    .map(
      (node: {
        id: string;
        title: string;
        calculator: { jsonValue: { enabled?: boolean } };
      }) => ({
      id: node.id,
      title: node.title,
        enabled: node.calculator.jsonValue?.enabled !== false,
      }),
    );

  if (!productId) {
    return { product: null, config: null, currencyCode, configured };
  }

  const response = await admin.graphql(
    `#graphql
      query CalculatorForProduct($id: ID!) {
        product(id: $id) {
          id
          title
          handle
          calculator: metafield(namespace: "${NAMESPACE}", key: "${KEY}") {
            jsonValue
          }
          variants(first: 1) {
            nodes {
              id
              price
              inventoryPolicy
              inventoryItem {
                tracked
              }
            }
          }
        }
      }`,
    { variables: { id: productId } },
  );
  const json = await response.json();
  const product = json.data?.product;

  if (!product) {
    return { product: null, config: null, currencyCode, configured };
  }

  const variant = product.variants?.nodes?.[0];

  return {
    product: {
      id: product.id,
      title: product.title,
      handle: product.handle,
      variantPrice: variant?.price ?? "0.00",
      inventoryTracked: variant?.inventoryItem?.tracked ?? false,
      inventoryPolicy: variant?.inventoryPolicy ?? "DENY",
    },
    config: product.calculator?.jsonValue
      ? normalizeConfig(product.calculator.jsonValue)
      : null,
    currencyCode,
    configured,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const productId = String(formData.get("productId") ?? "");

  if (!productId) {
    return { ok: false, errors: ["Choose a product first."] };
  }

  if (formData.get("intent") === "delete") {
    const response = await admin.graphql(
      `#graphql
        mutation CalculatorDelete($metafields: [MetafieldIdentifierInput!]!) {
          metafieldsDelete(metafields: $metafields) {
            deletedMetafields {
              key
            }
            userErrors {
              field
              message
            }
          }
        }`,
      {
        variables: {
          metafields: [{ ownerId: productId, namespace: NAMESPACE, key: KEY }],
        },
      },
    );
    const json = await response.json();
    const errors: string[] = (
      json.data?.metafieldsDelete?.userErrors ?? []
    ).map((error: { message: string }) => error.message);

    return { ok: errors.length === 0, errors, removed: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(formData.get("config") ?? "{}"));
  } catch {
    return { ok: false, errors: ["The settings could not be read."] };
  }

  // Re-validate server-side; the client check is only there for fast feedback.
  const config = normalizeConfig(parsed);
  const errors = validateConfig(config);
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const response = await admin.graphql(
    `#graphql
      mutation CalculatorSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
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
        metafields: [
          {
            ownerId: productId,
            namespace: NAMESPACE,
            key: KEY,
            type: "json",
            value: JSON.stringify(config),
          },
        ],
      },
    },
  );
  const json = await response.json();
  const userErrors: string[] = (
    json.data?.metafieldsSet?.userErrors ?? []
  ).map((error: { message: string }) => error.message);

  return { ok: userErrors.length === 0, errors: userErrors, removed: false };
};

/**
 * Polaris web components hand back a plain DOM Event. Read `target`, not
 * `currentTarget`: the browser clears `currentTarget` once dispatch finishes,
 * and these values are sometimes read after that.
 */
const valueOf = (event: Event) => (event.target as HTMLInputElement).value;
const checkedOf = (event: Event) => (event.target as HTMLInputElement).checked;

const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: "number", label: "Number" },
  { value: "select", label: "Dropdown" },
  { value: "checkbox", label: "Checkbox" },
];

function blankField(index: number): CalculatorField {
  return {
    key: `field_${index + 1}`,
    label: "",
    type: "number",
    unit: "",
    min: null,
    max: null,
    step: 1,
    defaultValue: null,
    options: [],
  };
}

export default function CalculatorRoute() {
  const { product, config, currencyCode, configured } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();

  const [draft, setDraft] = useState<CalculatorConfig>(() =>
    JSON.parse(JSON.stringify(config ?? EMPTY_CONFIG)),
  );
  const [preview, setPreview] = useState<Record<string, number>>({});
  const [previewPieces, setPreviewPieces] = useState(1);
  const savedKey = `${product?.id ?? ""}:${JSON.stringify(config)}`;

  useEffect(() => {
    // Clone so editing never mutates the shared default.
    const next: CalculatorConfig = JSON.parse(
      JSON.stringify(config ?? EMPTY_CONFIG),
    );
    setDraft(next);
    setPreview(
      Object.fromEntries(
        next.fields.map((field) => [field.key, defaultValueFor(field)]),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const isSaving = fetcher.state !== "idle" && fetcher.formMethod === "POST";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;

    if (fetcher.data.ok) {
      shopify.toast.show(
        fetcher.data.removed ? "Calculator removed" : "Calculator saved",
      );
    } else {
      shopify.toast.show(fetcher.data.errors[0] ?? "Could not save", {
        isError: true,
      });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const errors = useMemo(() => validateConfig(draft), [draft]);

  const unitCents = Math.round(Number(product?.variantPrice ?? 0) * 100);

  const money = useCallback(
    (cents: number) =>
      new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currencyCode,
      }).format(cents / 100),
    [currencyCode],
  );

  const previewResult = useMemo(() => {
    try {
      const perPiece = runFormula(draft.formula, preview);
      const pieces = draft.allowPieces ? previewPieces : 1;
      const priceCents = totalCents(perPiece, draft.minPrice, pieces);
      const { quantity, chargedCents } = quantityForPrice(priceCents, unitCents);

      return { priceCents, quantity, chargedCents, error: null as string | null };
    } catch (error) {
      return {
        priceCents: 0,
        quantity: 0,
        chargedCents: 0,
        error:
          error instanceof FormulaError ? error.message : "Formula is not valid",
      };
    }
  }, [
    draft.formula,
    draft.minPrice,
    draft.allowPieces,
    preview,
    previewPieces,
    unitCents,
  ]);

  const chooseProduct = useCallback(async () => {
    const chosen = await shopify.resourcePicker({
      type: "product",
      action: "select",
      filter: { variants: false },
    });

    if (chosen?.length) {
      navigate(`/app/calculator?product=${encodeURIComponent(chosen[0].id)}`);
    }
  }, [navigate, shopify]);

  // React runs state updaters during render, long after the event finished
  // dispatching, so every handler reads its value eagerly and passes it in.
  const patchDraft = useCallback(
    (patch: Partial<CalculatorConfig>) =>
      setDraft((current) => ({ ...current, ...patch })),
    [],
  );

  const patchPreview = useCallback(
    (key: string, value: number) =>
      setPreview((current) => ({ ...current, [key]: value })),
    [],
  );

  const patchField = useCallback(
    (index: number, patch: Partial<CalculatorField>) => {
      setDraft((current) => ({
        ...current,
        fields: current.fields.map((field, position) =>
          position === index ? { ...field, ...patch } : field,
        ),
      }));
    },
    [],
  );

  const moveField = useCallback((index: number, delta: number) => {
    setDraft((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.fields.length) return current;

      const fields = current.fields.slice();
      [fields[index], fields[target]] = [fields[target], fields[index]];
      return { ...current, fields };
    });
  }, []);

  const save = useCallback(() => {
    if (!product) return;

    fetcher.submit(
      { productId: product.id, config: JSON.stringify(draft) },
      { method: "POST" },
    );
  }, [draft, fetcher, product]);

  const remove = useCallback(() => {
    if (!product) return;

    fetcher.submit(
      { productId: product.id, intent: "delete" },
      { method: "POST" },
    );
  }, [fetcher, product]);

  const numberValue = (value: number | null) =>
    value === null ? "" : String(value);

  return (
    <s-page heading="Price calculator">
      <s-button
        slot="primary-action"
        onClick={save}
        {...(product && errors.length === 0 ? {} : { disabled: true })}
        {...(isSaving ? { loading: true } : {})}
      >
        Save
      </s-button>

      <s-section heading="Product">
        <s-paragraph>
          Choose a product, describe the inputs the customer fills in, and write
          the formula that turns those inputs into a price.
        </s-paragraph>
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-button onClick={chooseProduct}>
            {product ? "Change product" : "Choose product"}
          </s-button>
          {product && (
            <s-text>
              <s-text type="strong">{product.title}</s-text> — unit price{" "}
              {money(unitCents)}
            </s-text>
          )}
        </s-stack>

        {product && unitCents !== 1 && (
          <s-banner tone="warning" heading="Set this product's price to 0.01">
            <s-paragraph>
              The storefront can&apos;t set its own price, so the calculator adds{" "}
              <s-text type="strong">quantity × the variant price</s-text> to the
              cart. At {money(unitCents)} per unit, prices can only land on
              multiples of that. A variant price of 0.01 gives exact prices to
              the cent.
            </s-paragraph>
          </s-banner>
        )}

        {product && product.inventoryTracked && product.inventoryPolicy === "DENY" && (
          <s-banner tone="warning" heading="Turn off inventory tracking">
            <s-paragraph>
              Each order adds hundreds or thousands of units to the line, so
              tracked inventory will block the purchase. Untrack this product, or
              let it continue selling when out of stock.
            </s-paragraph>
          </s-banner>
        )}
      </s-section>

      {product && (
        <>
          <s-section heading="Customer inputs">
            <s-stack direction="block" gap="base">
              {draft.fields.map((field, index) => (
                <s-box
                  key={index}
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                >
                  <s-stack direction="block" gap="base">
                    <s-stack
                      direction="inline"
                      gap="base"
                      justifyContent="space-between"
                      alignItems="center"
                    >
                      <s-text type="strong">
                        {field.label || `Field ${index + 1}`}
                      </s-text>
                      <s-stack direction="inline" gap="base">
                        <s-button
                          variant="tertiary"
                          onClick={() => moveField(index, -1)}
                          {...(index === 0 ? { disabled: true } : {})}
                        >
                          Up
                        </s-button>
                        <s-button
                          variant="tertiary"
                          onClick={() => moveField(index, 1)}
                          {...(index === draft.fields.length - 1
                            ? { disabled: true }
                            : {})}
                        >
                          Down
                        </s-button>
                        <s-button
                          variant="tertiary"
                          tone="critical"
                          onClick={() =>
                            setDraft((current) => ({
                              ...current,
                              fields: current.fields.filter(
                                (_, position) => position !== index,
                              ),
                            }))
                          }
                        >
                          Remove
                        </s-button>
                      </s-stack>
                    </s-stack>

                    <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
                      <s-text-field
                        label="Label"
                        value={field.label}
                        onChange={(event) =>
                          patchField(index, { label: valueOf(event) })
                        }
                      />
                      <s-text-field
                        label="Formula key"
                        details="Used in the formula, e.g. width"
                        value={field.key}
                        onChange={(event) =>
                          patchField(index, { key: valueOf(event) })
                        }
                      />
                      <s-select
                        label="Type"
                        value={field.type}
                        onChange={(event) =>
                          patchField(index, {
                            type: valueOf(event) as FieldType,
                          })
                        }
                      >
                        {FIELD_TYPES.map((option) => (
                          <s-option key={option.value} value={option.value}>
                            {option.label}
                          </s-option>
                        ))}
                      </s-select>
                    </s-grid>

                    {field.type === "number" && (
                      <s-grid
                        gridTemplateColumns="1fr 1fr 1fr 1fr 1fr"
                        gap="base"
                      >
                        <s-text-field
                          label="Unit"
                          placeholder="cm"
                          value={field.unit}
                          onChange={(event) =>
                            patchField(index, {
                              unit: valueOf(event),
                            })
                          }
                        />
                        <s-number-field
                          label="Min"
                          value={numberValue(field.min)}
                          onChange={(event) =>
                            patchField(index, {
                              min: valueOf(event) === ""
                                ? null
                                : Number(valueOf(event)),
                            })
                          }
                        />
                        <s-number-field
                          label="Max"
                          value={numberValue(field.max)}
                          onChange={(event) =>
                            patchField(index, {
                              max: valueOf(event) === ""
                                ? null
                                : Number(valueOf(event)),
                            })
                          }
                        />
                        <s-number-field
                          label="Step"
                          value={numberValue(field.step)}
                          onChange={(event) =>
                            patchField(index, {
                              step: valueOf(event) === ""
                                ? null
                                : Number(valueOf(event)),
                            })
                          }
                        />
                        <s-number-field
                          label="Default"
                          value={numberValue(field.defaultValue)}
                          onChange={(event) =>
                            patchField(index, {
                              defaultValue: valueOf(event) === ""
                                ? null
                                : Number(valueOf(event)),
                            })
                          }
                        />
                      </s-grid>
                    )}

                    {field.type === "checkbox" && (
                      <s-checkbox
                        label="Ticked by default"
                        {...(field.defaultValue ? { checked: true } : {})}
                        onChange={(event) =>
                          patchField(index, {
                            defaultValue: checkedOf(event) ? 1 : 0,
                          })
                        }
                      />
                    )}

                    {field.type === "select" && (
                      <s-stack direction="block" gap="base">
                        <s-text color="subdued">
                          Each option contributes its value to the formula.
                        </s-text>
                        {field.options.map((option, optionIndex) => (
                          <s-grid
                            key={optionIndex}
                            gridTemplateColumns="2fr 1fr auto"
                            gap="base"
                          >
                            <s-text-field
                              label="Option label"
                              value={option.label}
                              onChange={(event) =>
                                patchField(index, {
                                  options: field.options.map((item, position) =>
                                    position === optionIndex
                                      ? {
                                          ...item,
                                          label: valueOf(event),
                                        }
                                      : item,
                                  ),
                                })
                              }
                            />
                            <s-number-field
                              label="Value"
                              value={String(option.value)}
                              onChange={(event) =>
                                patchField(index, {
                                  options: field.options.map((item, position) =>
                                    position === optionIndex
                                      ? {
                                          ...item,
                                          value:
                                            Number(valueOf(event)) || 0,
                                        }
                                      : item,
                                  ),
                                })
                              }
                            />
                            <s-button
                              variant="tertiary"
                              tone="critical"
                              onClick={() =>
                                patchField(index, {
                                  options: field.options.filter(
                                    (_, position) => position !== optionIndex,
                                  ),
                                })
                              }
                            >
                              Remove
                            </s-button>
                          </s-grid>
                        ))}
                        <s-button
                          variant="secondary"
                          onClick={() =>
                            patchField(index, {
                              options: [
                                ...field.options,
                                { label: "", value: 0 },
                              ],
                            })
                          }
                        >
                          Add option
                        </s-button>
                      </s-stack>
                    )}
                  </s-stack>
                </s-box>
              ))}

              <s-button
                variant="secondary"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    fields: [...current.fields, blankField(current.fields.length)],
                  }))
                }
              >
                Add field
              </s-button>
            </s-stack>
          </s-section>

          <s-section heading="Formula">
            <s-stack direction="block" gap="base">
              <s-text-area
                label="Price formula"
                rows={3}
                value={draft.formula}
                onChange={(event) => patchDraft({ formula: valueOf(event) })}
              />
              <s-text color="subdued">
                Fields available:{" "}
                {draft.fields.map((field) => field.key).join(", ") || "none yet"}.
                Functions: {FUNCTION_NAMES.join(", ")}. Operators: + - * / % ^,
                comparisons, and <s-text type="strong">test ? a : b</s-text>.
              </s-text>
              <s-text color="subdued">
                Example: <s-text type="strong">
                  max(width * height / 10000 * 45, 25)
                </s-text>{" "}
                prices a panel at 45 per m² with a 25 minimum.
              </s-text>

              {errors.length > 0 && (
                <s-banner tone="critical" heading="Fix these before saving">
                  {errors.map((message) => (
                    <s-paragraph key={message}>{message}</s-paragraph>
                  ))}
                </s-banner>
              )}
            </s-stack>
          </s-section>

          <s-section heading="Wording and limits">
            <s-grid gridTemplateColumns="1fr 1fr" gap="base">
              <s-text-field
                label="Price label"
                value={draft.priceLabel}
                onChange={(event) => patchDraft({ priceLabel: valueOf(event) })}
              />
              <s-text-field
                label="Add to cart button"
                value={draft.addToCartLabel}
                onChange={(event) =>
                  patchDraft({ addToCartLabel: valueOf(event) })
                }
              />
              <s-number-field
                label="Minimum price"
                details="Charged when the formula returns less"
                value={String(draft.minPrice)}
                onChange={(event) =>
                  patchDraft({ minPrice: Number(valueOf(event)) || 0 })
                }
              />
              <s-text-field
                label="Note under the price"
                value={draft.note}
                onChange={(event) => patchDraft({ note: valueOf(event) })}
              />
            </s-grid>
            <s-checkbox
              label="Let customers choose how many pieces"
              details="The formula prices one piece; the app multiplies by the number of pieces."
              {...(draft.allowPieces ? { checked: true } : {})}
              onChange={(event) => patchDraft({ allowPieces: checkedOf(event) })}
            />
            {draft.allowPieces && (
              <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                <s-text-field
                  label="Pieces label"
                  value={draft.piecesLabel}
                  onChange={(event) =>
                    patchDraft({ piecesLabel: valueOf(event) })
                  }
                />
                <s-number-field
                  label="Maximum pieces"
                  value={String(draft.maxPieces)}
                  onChange={(event) =>
                    patchDraft({ maxPieces: Number(valueOf(event)) || 1 })
                  }
                />
              </s-grid>
            )}
            <s-checkbox
              label="Show the calculator on the storefront"
              {...(draft.enabled ? { checked: true } : {})}
              onChange={(event) => patchDraft({ enabled: checkedOf(event) })}
            />
            <s-button variant="tertiary" tone="critical" onClick={remove}>
              Remove calculator from this product
            </s-button>
          </s-section>
        </>
      )}

      {product && (
        <s-section slot="aside" heading="Preview">
          <s-stack direction="block" gap="base">
            {draft.fields.map((field, index) => (
              <div key={index}>
                {field.type === "checkbox" ? (
                  <s-checkbox
                    label={field.label || field.key}
                    {...(preview[field.key] ? { checked: true } : {})}
                    onChange={(event) =>
                      patchPreview(field.key, checkedOf(event) ? 1 : 0)
                    }
                  />
                ) : field.type === "select" ? (
                  <s-select
                    label={field.label || field.key}
                    value={String(preview[field.key] ?? "")}
                    onChange={(event) =>
                      patchPreview(field.key, Number(valueOf(event)) || 0)
                    }
                  >
                    {field.options.map((option, optionIndex) => (
                      <s-option key={optionIndex} value={String(option.value)}>
                        {option.label}
                      </s-option>
                    ))}
                  </s-select>
                ) : (
                  <s-number-field
                    label={`${field.label || field.key}${field.unit ? ` (${field.unit})` : ""}`}
                    value={String(preview[field.key] ?? "")}
                    onInput={(event) =>
                      patchPreview(field.key, Number(valueOf(event)) || 0)
                    }
                  />
                )}
              </div>
            ))}

            {draft.allowPieces && (
              <s-number-field
                label={draft.piecesLabel}
                value={String(previewPieces)}
                onInput={(event) =>
                  setPreviewPieces(Math.max(1, Number(valueOf(event)) || 1))
                }
              />
            )}

            {previewResult.error ? (
              <s-text tone="critical">{previewResult.error}</s-text>
            ) : (
              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block">
                  <s-text type="strong">
                    {draft.priceLabel}: {money(previewResult.chargedCents)}
                  </s-text>
                  <s-text color="subdued">
                    Added as {previewResult.quantity} × {money(unitCents)}
                  </s-text>
                  {previewResult.chargedCents !== previewResult.priceCents && (
                    <s-text color="subdued">
                      Formula said {money(previewResult.priceCents)} — rounded to
                      the nearest unit.
                    </s-text>
                  )}
                </s-stack>
              </s-box>
            )}
          </s-stack>
        </s-section>
      )}

      <s-section slot="aside" heading="How it reaches the cart">
        <s-paragraph>
          The storefront can&apos;t set a price, so the block adds{" "}
          <s-text type="strong">quantity × the variant price</s-text> and records
          the entered values as line item properties. Price the variant at 0.01
          and the total lands exactly on the calculated amount.
        </s-paragraph>
        <s-paragraph>
          Add the <s-text type="strong">Price calculator</s-text> app block to the
          product template in the theme editor, and hide the theme&apos;s own buy
          button on these products.
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Products with a calculator">
        {configured.length === 0 ? (
          <s-paragraph>Nothing configured yet.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {configured.map(
              (item: { id: string; title: string; enabled: boolean }) => (
                <s-stack
                  key={item.id}
                  direction="inline"
                  gap="base"
                  alignItems="center"
                >
                  <s-link
                    href={`/app/calculator?product=${encodeURIComponent(item.id)}`}
                  >
                    {item.title}
                  </s-link>
                  {!item.enabled && <s-badge tone="neutral">Off</s-badge>}
                </s-stack>
              ),
            )}
          </s-stack>
        )}
      </s-section>
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
