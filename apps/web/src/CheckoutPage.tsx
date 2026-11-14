import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, createOrder, type CreateOrderRequest } from "./api";
import { checkoutLines, clearCart, type CartLine } from "./cart";
import { pickSampleBuyer } from "./sampleBuyers";
import {
  fallbackCatalog,
  isCatalog,
  productNeedsCustomText,
  unitPriceCents,
  type Catalog,
} from "./catalog";
import { formatCents } from "./format";

const CUSTOM_TEXT_MAX = 60;

type ShipFields = {
  email: string;
  name: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  brand: string;
  last4: string;
};

const emptyShip = (): ShipFields => ({
  email: "",
  name: "",
  line1: "",
  line2: "",
  city: "",
  region: "",
  postalCode: "",
  country: "US",
  brand: "visa",
  last4: "",
});

function optionsIncluding(current: string, choices: { value: string; label: string }[]): { value: string; label: string }[] {
  if (choices.some((choice) => choice.value === current)) return choices;
  return [{ value: current, label: current }, ...choices];
}

export function CheckoutPage() {
  const navigate = useNavigate();
  const [catalog, setCatalog] = useState<Catalog>(fallbackCatalog);
  const [lines, setLines] = useState<CartLine[]>(() => checkoutLines());
  const [ship, setShip] = useState<ShipFields>(emptyShip);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const lastBuyerIndex = useRef<number | undefined>(undefined);

  function fillWithRandomBuyer(): void {
    const { buyer, index } = pickSampleBuyer(lastBuyerIndex.current);
    lastBuyerIndex.current = index;
    setShip({
      email: buyer.email,
      name: buyer.name,
      line1: buyer.line1,
      line2: buyer.line2,
      city: buyer.city,
      region: buyer.region,
      postalCode: buyer.postalCode,
      country: buyer.country,
      brand: buyer.brand,
      last4: buyer.last4,
    });
    setLines((current) =>
      current.map((line) =>
        productNeedsCustomText(catalog, line.sku) ? { ...line, customText: buyer.customText } : line,
      ),
    );
    setError("");
  }

  useEffect(() => {
    const controller = new AbortController();
    async function loadCatalog(): Promise<void> {
      try {
        const response = await fetch("/api/products", { signal: controller.signal });
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (isCatalog(body)) setCatalog(body);
      } catch {
        // Keep the fallback catalog when the API is unreachable.
      }
    }
    void loadCatalog();
    return () => controller.abort();
  }, []);

  const totalCents = useMemo(() => {
    let total = 0;
    for (const line of lines) {
      const unit = unitPriceCents(catalog, line.size, line.frame);
      if (unit === undefined || line.quantity < 1) return undefined;
      total += unit * line.quantity;
    }
    return total;
  }, [catalog, lines]);

  function updateLine(index: number, patch: Partial<CartLine> & { customText?: string }): void {
    setLines((current) =>
      current.map((line, lineIndex) => {
        if (lineIndex !== index) return line;
        const next: CartLine = {
          sku: patch.sku ?? line.sku,
          size: patch.size ?? line.size,
          frame: patch.frame ?? line.frame,
          quantity: patch.quantity ?? line.quantity,
        };
        const customText = patch.customText !== undefined ? patch.customText : line.customText;
        if (customText !== undefined) next.customText = customText;
        return next;
      }),
    );
  }

  function updateShip<K extends keyof ShipFields>(key: K, value: ShipFields[K]): void {
    setShip((current) => ({ ...current, [key]: value }));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError("");

    for (const line of lines) {
      if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 10) {
        setError("Quantity must be from 1 to 10.");
        return;
      }
      if (productNeedsCustomText(catalog, line.sku)) {
        const text = line.customText?.trim() ?? "";
        if (text.length === 0 || text.length > CUSTOM_TEXT_MAX) {
          setError("Custom text is required and must be 60 characters or fewer.");
          return;
        }
      }
    }

    if (!/^\d{4}$/.test(ship.last4)) {
      setError("Enter the last 4 digits of the card.");
      return;
    }

    const payload: CreateOrderRequest = {
      email: ship.email.trim(),
      shipTo: {
        name: ship.name.trim(),
        line1: ship.line1.trim(),
        city: ship.city.trim(),
        region: ship.region.trim(),
        postalCode: ship.postalCode.trim(),
        country: ship.country.trim(),
      },
      items: lines.map((line) => {
        const item: CreateOrderRequest["items"][number] = {
          sku: line.sku,
          size: line.size,
          frame: line.frame,
          quantity: line.quantity,
        };
        if (productNeedsCustomText(catalog, line.sku)) {
          const customText = line.customText?.trim() ?? "";
          if (customText.length > 0) item.customText = customText;
        }
        return item;
      }),
      payment: { brand: ship.brand, last4: ship.last4 },
    };
    const line2 = ship.line2.trim();
    if (line2.length > 0) payload.shipTo.line2 = line2;

    setSubmitting(true);
    try {
      const order = await createOrder(payload);
      clearCart();
      navigate(`/orders/${order.number}`);
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : "We couldn't place your order";
      setError(message);
      setSubmitting(false);
    }
  }

  const productChoices = catalog.products.map((product) => ({ value: product.sku, label: product.name }));
  const sizeChoices = catalog.sizes.map((size) => ({ value: size.id, label: size.id }));
  const frameChoices = catalog.frames.map((frame) => ({ value: frame.id, label: frame.name }));

  return (
    <main className="page">
      <h1>Checkout</h1>
      <p className="lede">Shipping and a demo card. Payment is accepted here and ignored by the store.</p>
      <div className="checkout-tools">
        <button className="fill-buyer" type="button" onClick={fillWithRandomBuyer}>
          Fill with a random buyer
        </button>
      </div>
      <form className="layout" onSubmit={(event) => void onSubmit(event)}>
        <div className="stack">
          <section className="panel">
            <h2>Posters</h2>
            {lines.map((line, index) => {
              const needsText = productNeedsCustomText(catalog, line.sku);
              return (
                <div className="line" key={`${line.sku}-${index}`}>
                  <div className="line-grid">
                    <label className="field">
                      <span>Poster</span>
                      <select
                        value={line.sku}
                        onChange={(event) => updateLine(index, { sku: event.target.value })}
                      >
                        {optionsIncluding(line.sku, productChoices).map((choice) => (
                          <option key={choice.value} value={choice.value}>
                            {choice.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Size</span>
                      <select
                        value={line.size}
                        onChange={(event) => updateLine(index, { size: event.target.value })}
                      >
                        {optionsIncluding(line.size, sizeChoices).map((choice) => (
                          <option key={choice.value} value={choice.value}>
                            {choice.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Frame</span>
                      <select
                        value={line.frame}
                        onChange={(event) => updateLine(index, { frame: event.target.value })}
                      >
                        {optionsIncluding(line.frame, frameChoices).map((choice) => (
                          <option key={choice.value} value={choice.value}>
                            {choice.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Quantity</span>
                      <input
                        type="number"
                        min={1}
                        max={10}
                        value={line.quantity}
                        onChange={(event) => updateLine(index, { quantity: Number(event.target.value) })}
                        required
                      />
                    </label>
                  </div>
                  {needsText ? (
                    <label className="field custom-text">
                      <span>Custom text</span>
                      <input
                        value={line.customText ?? ""}
                        maxLength={CUSTOM_TEXT_MAX}
                        onChange={(event) => updateLine(index, { customText: event.target.value })}
                        required
                      />
                    </label>
                  ) : null}
                </div>
              );
            })}
          </section>

          <section className="panel">
            <h2>Shipping</h2>
            <div className="fields">
              <label className="field">
                <span>Email</span>
                <input
                  type="email"
                  value={ship.email}
                  onChange={(event) => updateShip("email", event.target.value)}
                  required
                  autoComplete="email"
                />
              </label>
              <label className="field">
                <span>Name</span>
                <input
                  value={ship.name}
                  onChange={(event) => updateShip("name", event.target.value)}
                  required
                  autoComplete="name"
                />
              </label>
              <div className="address-grid">
                <label className="field">
                  <span>Address line 1</span>
                  <input
                    value={ship.line1}
                    onChange={(event) => updateShip("line1", event.target.value)}
                    required
                    autoComplete="address-line1"
                  />
                </label>
                <label className="field">
                  <span>Address line 2</span>
                  <input
                    value={ship.line2}
                    onChange={(event) => updateShip("line2", event.target.value)}
                    autoComplete="address-line2"
                  />
                </label>
                <label className="field">
                  <span>City</span>
                  <input
                    value={ship.city}
                    onChange={(event) => updateShip("city", event.target.value)}
                    required
                    autoComplete="address-level2"
                  />
                </label>
                <label className="field">
                  <span>Region</span>
                  <input
                    value={ship.region}
                    onChange={(event) => updateShip("region", event.target.value)}
                    required
                    autoComplete="address-level1"
                  />
                </label>
                <label className="field">
                  <span>Postal code</span>
                  <input
                    value={ship.postalCode}
                    onChange={(event) => updateShip("postalCode", event.target.value)}
                    required
                    autoComplete="postal-code"
                  />
                </label>
                <label className="field">
                  <span>Country</span>
                  <input
                    value={ship.country}
                    onChange={(event) => updateShip("country", event.target.value)}
                    required
                    autoComplete="country"
                  />
                </label>
              </div>
            </div>
          </section>

          <section className="panel">
            <h2>Payment</h2>
            <div className="payment-grid">
              <label className="field">
                <span>Card brand</span>
                <select value={ship.brand} onChange={(event) => updateShip("brand", event.target.value)}>
                  <option value="visa">Visa</option>
                  <option value="mastercard">Mastercard</option>
                  <option value="amex">American Express</option>
                </select>
              </label>
              <label className="field">
                <span>Last 4</span>
                <input
                  inputMode="numeric"
                  autoComplete="cc-number"
                  maxLength={4}
                  pattern="\d{4}"
                  value={ship.last4}
                  onChange={(event) => updateShip("last4", event.target.value)}
                  required
                />
              </label>
            </div>
            <p className="fine">Demo checkout. The card is not charged or stored.</p>
          </section>
        </div>

        <aside className="panel summary">
          <h2>Order</h2>
          {lines.map((line, index) => {
            const unit = unitPriceCents(catalog, line.size, line.frame);
            const product = catalog.products.find((entry) => entry.sku === line.sku);
            return (
              <p className="summary-line" key={`summary-${index}`}>
                <span>
                  {product?.name ?? line.sku}
                  <br />
                  <span className="fine">
                    {line.size} · {line.frame} · {line.quantity}
                  </span>
                </span>
                <span>{unit === undefined ? "—" : formatCents(unit * line.quantity)}</span>
              </p>
            );
          })}
          <p className="total-line">
            <span>Total</span>
            <span>{totalCents === undefined ? "—" : formatCents(totalCents)}</span>
          </p>
          {error ? (
            <p className="alert" role="alert">
              {error}
            </p>
          ) : null}
          <button className="place-order" type="submit" disabled={submitting}>
            {submitting ? "Placing order…" : "Place order"}
          </button>
        </aside>
      </form>
    </main>
  );
}
