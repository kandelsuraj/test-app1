import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  useSearchParams,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import {
  EMPTY_CONFIG,
  defaultValueFor,
  hasOptions,
  normalizeConfig,
  quantityForPrice,
  totalCents,
  validateConfig,
} from "../calculator";
import type {
  CalculatorConfig,
  CalculatorField,
  FieldType,
} from "../calculator";
import {
  getCalculator,
  loadProducts,
  saveCalculator,
} from "../calculators.server";
import { FUNCTION_NAMES, FormulaError, runFormula } from "../formula";

const NEW = "new";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const id = params.id ?? NEW;

  const shopResponse = await admin.graphql(
    `#graphql
      query CalculatorShopCurrency {
        shop {
          currencyCode
        }
      }`,
  );
  const shopJson = await shopResponse.json();
  const currencyCode: string = shopJson.data?.shop?.currencyCode ?? "USD";

  if (id === NEW) {
    return {
      id: null,
      name: "",
      config: EMPTY_CONFIG,
      products: [],
      currencyCode,
    };
  }

  const calculator = await getCalculator(session.shop, id);
  if (!calculator) {
    throw new Response("Calculator not found", { status: 404 });
  }

  const summaries = await loadProducts(admin, calculator.productIds);

  return {
    id: calculator.id,
    name: calculator.name,
    config: calculator.config,
    // Products deleted from the store simply drop out.
    products: calculator.productIds
      .map((productId) => summaries.get(productId))
      .filter((product) => product !== undefined),
    currencyCode,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session, redirect } = await authenticate.admin(request);
  const formData = await request.formData();
  const id = params.id && params.id !== NEW ? params.id : null;

  const name = String(formData.get("name") ?? "").trim();
  let parsedConfig: unknown;
  let parsedProducts: unknown;
  try {
    parsedConfig = JSON.parse(String(formData.get("config") ?? "{}"));
    parsedProducts = JSON.parse(String(formData.get("productIds") ?? "[]"));
  } catch {
    return { ok: false, errors: ["The settings could not be read."] };
  }

  // Re-validate server-side; the client check is only there for fast feedback.
  const config = normalizeConfig(parsedConfig);
  const errors = validateConfig(config);
  if (!name) errors.unshift("Give the calculator a name.");
  if (errors.length > 0) return { ok: false, errors };

  const productIds = Array.isArray(parsedProducts)
    ? parsedProducts
        .map(String)
        .filter((value) => value.startsWith("gid://shopify/Product/"))
    : [];

  const result = await saveCalculator(admin, session.shop, {
    id,
    name,
    config,
    productIds,
  });
  if ("errors" in result) return { ok: false, errors: result.errors };

  if (!id) return redirect(`/app/calculators/${result.id}?created=1`);
  return { ok: true, errors: [] as string[] };
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
  { value: "radio", label: "Radio buttons" },
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

type ProductRow = {
  id: string;
  title: string;
  image: string | null;
  /** Null for products just picked whose details the picker didn't return. */
  variantPrice: string | null;
  /** Null until saved: the picker doesn't report inventory tracking. */
  inventoryTracked: boolean | null;
  inventoryPolicy: string | null;
};

type PickedProduct = {
  id: string;
  title: string;
  images?: { originalSrc?: string }[];
  variants?: { price?: string }[];
};

const MODAL_ID = "leave-calculator-modal";

// Whatever the s-modal JSX element hands to `ref`.
type ModalElement = ComponentRef<"s-modal">;

export default function CalculatorEditRoute() {
  const loaded = useLoaderData<typeof loader>();
  const { id, currencyCode } = loaded;
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const modal = useRef<ModalElement>(null);

  const [name, setName] = useState(loaded.name);
  const [products, setProducts] = useState<ProductRow[]>(loaded.products);
  const [draft, setDraft] = useState<CalculatorConfig>(() =>
    JSON.parse(JSON.stringify(loaded.config)),
  );
  const [preview, setPreview] = useState<Record<string, number>>({});
  const [previewPieces, setPreviewPieces] = useState(1);
  const savedKey = JSON.stringify([
    id,
    loaded.name,
    loaded.config,
    loaded.products.map((product) => product.id),
  ]);

  useEffect(() => {
    // Clone so editing never mutates the shared default.
    const next: CalculatorConfig = JSON.parse(JSON.stringify(loaded.config));
    setName(loaded.name);
    setProducts(loaded.products);
    setDraft(next);
    setPreview(
      Object.fromEntries(
        next.fields.map((field) => [field.key, defaultValueFor(field)]),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  // A new calculator is saved by redirecting here, so the toast shows on arrival.
  useEffect(() => {
    if (searchParams.get("created")) {
      shopify.toast.show("Calculator created");
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams, shopify]);

  const isSaving = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;

    if (fetcher.data.ok) {
      shopify.toast.show("Calculator saved");
    } else {
      shopify.toast.show(fetcher.data.errors[0] ?? "Could not save", {
        isError: true,
      });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const errors = useMemo(() => {
    const problems = validateConfig(draft);
    if (!name.trim()) problems.unshift("Give the calculator a name.");
    return problems;
  }, [draft, name]);
  const serverErrors =
    fetcher.state === "idle" && fetcher.data && !fetcher.data.ok
      ? fetcher.data.errors
      : [];

  // The preview prices against the first product with a known unit price.
  const previewProduct = products.find(
    (product) => product.variantPrice !== null,
  );
  const unitCents = Math.round(
    Number(previewProduct?.variantPrice ?? "0.01") * 100,
  );

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
      const { quantity, chargedCents } = quantityForPrice(
        priceCents,
        unitCents,
      );

      return {
        priceCents,
        quantity,
        chargedCents,
        error: null as string | null,
      };
    } catch (error) {
      return {
        priceCents: 0,
        quantity: 0,
        chargedCents: 0,
        error:
          error instanceof FormulaError
            ? error.message
            : "Formula is not valid",
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

  const chooseProducts = useCallback(async () => {
    const chosen = (await shopify.resourcePicker({
      type: "product",
      action: "select",
      multiple: true,
      filter: { variants: false },
      selectionIds: products.map((product) => ({ id: product.id })),
    })) as PickedProduct[] | undefined;

    // Cancelled: keep the current selection.
    if (!chosen) return;

    setProducts((current) =>
      chosen.map((picked) => {
        const known = current.find((product) => product.id === picked.id);
        if (known) return known;
        return {
          id: picked.id,
          title: picked.title,
          image: picked.images?.[0]?.originalSrc ?? null,
          variantPrice: picked.variants?.[0]?.price ?? null,
          inventoryTracked: null,
          inventoryPolicy: null,
        };
      }),
    );
  }, [products, shopify]);

  const removeProduct = useCallback((productId: string) => {
    setProducts((current) =>
      current.filter((product) => product.id !== productId),
    );
  }, []);

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

  // Drag and drop reordering. A row only becomes draggable while its handle is
  // held, so text in the row's inputs can still be selected with the mouse.
  const [armed, setArmed] = useState<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const focusHandle = useRef<number | null>(null);

  const endDrag = useCallback(() => {
    setArmed(null);
    setDragging(null);
    setDropTarget(null);
  }, []);

  const moveFieldTo = useCallback((from: number, to: number) => {
    setDraft((current) => {
      if (from === to || to < 0 || to >= current.fields.length) return current;

      const fields = current.fields.slice();
      const [moved] = fields.splice(from, 1);
      fields.splice(to, 0, moved);
      focusHandle.current = to;
      return { ...current, fields };
    });
  }, []);

  // Rows are keyed by position, so after a keyboard move put focus back on the
  // handle of the field that moved rather than whatever took its old place.
  useEffect(() => {
    if (focusHandle.current === null) return;
    document
      .querySelector<HTMLElement>(
        `[data-field-handle="${focusHandle.current}"]`,
      )
      ?.focus();
    focusHandle.current = null;
  }, [draft.fields]);

  const save = useCallback(() => {
    fetcher.submit(
      {
        name: name.trim(),
        config: JSON.stringify(draft),
        productIds: JSON.stringify(products.map((product) => product.id)),
      },
      { method: "POST" },
    );
  }, [draft, fetcher, name, products]);

  // Unsaved when anything differs from what the loader last returned; a save
  // reloads that data, so this clears itself once the save lands.
  const isDirty =
    JSON.stringify([name, draft, products.map((product) => product.id)]) !==
    JSON.stringify([
      loaded.name,
      loaded.config,
      loaded.products.map((product) => product.id),
    ]);

  // Nothing to save until something changes. A new calculator has nothing
  // saved to compare against, so it only needs to be valid.
  const canSave = errors.length === 0 && (isDirty || !id);

  const leave = useCallback(() => navigate("/app/calculators"), [navigate]);

  const exit = useCallback(() => {
    if (isDirty) modal.current?.showOverlay();
    else leave();
  }, [isDirty, leave]);

  const numberValue = (value: number | null) =>
    value === null ? "" : String(value);

  const wrongPrice = products.filter(
    (product) =>
      product.variantPrice !== null &&
      Math.round(Number(product.variantPrice) * 100) !== 1,
  );
  const tracked = products.filter(
    (product) => product.inventoryTracked && product.inventoryPolicy === "DENY",
  );

  return (
    <s-page heading={id ? loaded.name : "Create calculator"}>
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={save}
        {...(canSave ? {} : { disabled: true })}
        {...(isSaving ? { loading: true } : {})}
      >
        Save
      </s-button>
      <s-button slot="secondary-actions" onClick={exit}>
        Exit
      </s-button>

      {serverErrors.length > 0 && (
        <s-banner tone="critical" heading="Could not save">
          {serverErrors.map((message) => (
            <s-paragraph key={message}>{message}</s-paragraph>
          ))}
        </s-banner>
      )}

      <s-section heading="Calculator">
        <s-text-field
          label="Name"
          details="Only you see this. It identifies the calculator in the app."
          placeholder="Curtain panels"
          value={name}
          onInput={(event) => setName(valueOf(event))}
        />
      </s-section>

      <s-section heading="Products">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Every product chosen here shows this calculator on its product page.
            A product can use only one calculator.
          </s-paragraph>

          {products.length > 0 && (
            <s-stack direction="block" gap="small-200">
              {products.map((product) => (
                <s-box
                  key={product.id}
                  padding="small-200"
                  borderWidth="base"
                  borderRadius="base"
                >
                  <s-stack
                    direction="inline"
                    gap="base"
                    alignItems="center"
                    justifyContent="space-between"
                  >
                    <s-stack direction="inline" gap="base" alignItems="center">
                      <s-thumbnail
                        size="small"
                        alt={product.title}
                        {...(product.image ? { src: product.image } : {})}
                      />
                      <s-stack direction="block">
                        <s-text type="strong">{product.title}</s-text>
                        {product.variantPrice !== null && (
                          <s-text color="subdued">
                            Unit price{" "}
                            {money(
                              Math.round(Number(product.variantPrice) * 100),
                            )}
                          </s-text>
                        )}
                      </s-stack>
                    </s-stack>
                    <s-button
                      variant="tertiary"
                      tone="critical"
                      accessibilityLabel={`Remove ${product.title}`}
                      onClick={() => removeProduct(product.id)}
                    >
                      Remove
                    </s-button>
                  </s-stack>
                </s-box>
              ))}
            </s-stack>
          )}

          <s-stack direction="inline">
            <s-button onClick={chooseProducts}>Choose products</s-button>
          </s-stack>

          {wrongPrice.length > 0 && (
            <s-banner
              tone="warning"
              heading="Set these products' price to 0.01"
            >
              <s-paragraph>
                {wrongPrice.map((product) => product.title).join(", ")}. The
                storefront can&apos;t set its own price, so the calculator adds{" "}
                <s-text type="strong">quantity × the variant price</s-text> to
                the cart, and prices can only land on multiples of the unit
                price. A variant price of 0.01 gives exact prices to the cent.
              </s-paragraph>
            </s-banner>
          )}

          {tracked.length > 0 && (
            <s-banner tone="warning" heading="Turn off inventory tracking">
              <s-paragraph>
                {tracked.map((product) => product.title).join(", ")}. Each order
                adds hundreds or thousands of units to the line, so tracked
                inventory will block the purchase. Untrack these products, or
                let them continue selling when out of stock.
              </s-paragraph>
            </s-banner>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Customer inputs">
        <s-stack direction="block" gap="base">
          {draft.fields.length > 1 && (
            <s-text color="subdued">
              Drag a field by its handle to change the order customers see.
            </s-text>
          )}
          {draft.fields.map((field, index) => (
            <div
              key={index}
              draggable={armed === index}
              onDragStart={(event) => {
                setDragging(index);
                event.dataTransfer.effectAllowed = "move";
                // Firefox won't start a drag without some data.
                event.dataTransfer.setData("text/plain", String(index));
              }}
              onDragOver={(event) => {
                if (dragging === null) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                if (dropTarget !== index) setDropTarget(index);
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging !== null) moveFieldTo(dragging, index);
                endDrag();
              }}
              onDragEnd={endDrag}
              style={{
                opacity: dragging === index ? 0.4 : 1,
                borderRadius: "12px",
                boxShadow:
                  dropTarget === index &&
                  dragging !== null &&
                  dragging !== index
                    ? `0 ${dragging < index ? 3 : -3}px 0 0 var(--p-color-border-emphasis, #005bd3)`
                    : "none",
              }}
            >
              <s-box padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="base">
                  <s-stack
                    direction="inline"
                    gap="base"
                    justifyContent="space-between"
                    alignItems="center"
                  >
                    <s-stack
                      direction="inline"
                      gap="small-200"
                      alignItems="center"
                    >
                      <div
                        role="button"
                        tabIndex={0}
                        data-field-handle={index}
                        aria-label={`Reorder ${field.label || `field ${index + 1}`}. Use the up and down arrow keys to move it.`}
                        title="Drag to reorder"
                        onPointerDown={() => setArmed(index)}
                        onPointerUp={() => setArmed(null)}
                        onKeyDown={(event) => {
                          const delta =
                            event.key === "ArrowUp"
                              ? -1
                              : event.key === "ArrowDown"
                                ? 1
                                : 0;
                          if (!delta) return;
                          event.preventDefault();
                          moveFieldTo(index, index + delta);
                        }}
                        style={{
                          display: "flex",
                          padding: "4px",
                          cursor: dragging === null ? "grab" : "grabbing",
                          touchAction: "none",
                        }}
                      >
                        <s-icon type="drag-handle" />
                      </div>
                      <s-text type="strong">
                        {field.label || `Field ${index + 1}`}
                      </s-text>
                    </s-stack>
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

                  <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
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
                            min:
                              valueOf(event) === ""
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
                            max:
                              valueOf(event) === ""
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
                            step:
                              valueOf(event) === ""
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
                            defaultValue:
                              valueOf(event) === ""
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

                  {hasOptions(field.type) && (
                    <s-stack direction="block" gap="base">
                      <s-text color="subdued">
                        Each option contributes its value to the formula.
                        {field.type === "radio" &&
                          " The first option is selected to start with."}
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
                                        value: Number(valueOf(event)) || 0,
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
                      <s-stack direction="inline">
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
                    </s-stack>
                  )}
                </s-stack>
              </s-box>
            </div>
          ))}

          <s-stack direction="inline">
            <s-button
              variant="secondary"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  fields: [
                    ...current.fields,
                    blankField(current.fields.length),
                  ],
                }))
              }
            >
              Add field
            </s-button>
          </s-stack>
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
            Example:{" "}
            <s-text type="strong">max(width * height / 10000 * 45, 25)</s-text>{" "}
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
            onChange={(event) => patchDraft({ addToCartLabel: valueOf(event) })}
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
              onChange={(event) => patchDraft({ piecesLabel: valueOf(event) })}
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
      </s-section>

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
              ) : field.type === "radio" ? (
                <s-choice-list
                  label={field.label || field.key}
                  onChange={(event) =>
                    patchPreview(
                      field.key,
                      Number(
                        (event.target as unknown as { values: string[] })
                          .values[0],
                      ) || 0,
                    )
                  }
                >
                  {field.options.map((option, optionIndex) => (
                    <s-choice
                      key={optionIndex}
                      value={String(option.value)}
                      {...(preview[field.key] === option.value
                        ? { selected: true }
                        : {})}
                    >
                      {option.label}
                    </s-choice>
                  ))}
                </s-choice-list>
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
                  {previewProduct ? ` (${previewProduct.title})` : ""}
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

      <s-modal id={MODAL_ID} ref={modal} heading="Leave without saving?">
        <s-paragraph>
          Your changes to{" "}
          <s-text type="strong">{name.trim() || "this calculator"}</s-text>{" "}
          haven&apos;t been saved and will be lost.
        </s-paragraph>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          onClick={leave}
        >
          Discard changes
        </s-button>
        <s-button
          slot="secondary-actions"
          commandFor={MODAL_ID}
          command="--hide"
        >
          Keep editing
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
