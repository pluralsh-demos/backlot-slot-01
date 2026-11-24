import type { FastifyBaseLogger } from "fastify";
import { frames, getProduct, sizes } from "./catalog.js";
import { sqlStateOf } from "./db.js";
import type { ApiMetrics } from "./metrics.js";

const CUSTOM_TEXT_MAX = 60;
const QUANTITY_MAX = 10;

export const ORDER_FAILED = "We couldn't place your order";
export const ORDERS_UNAVAILABLE = "Orders are unavailable";

const ORDER_NOT_FOUND = "Order not found";
const ORDER_LOAD_FAILED = "We couldn't load this order";

export type OrderItemResponse = {
  sku: string;
  size: string;
  frame: string;
  customText: string | null;
  unitPrice: number;
};

export type OrderResponse = {
  number: string;
  status: string;
  subtotal: number;
  total: number;
  items: OrderItemResponse[];
};

export type OrderResult =
  | { ok: true; order: OrderResponse }
  | { ok: false; status: 400 | 404 | 500; error: string };

type OrderFailure = Extract<OrderResult, { ok: false }>;

export type OrderQueryResult<T> = {
  rows: T[];
  rowCount: number | null;
};

/** Subset of node-pg used by checkout. Tests pass a stub with the same shape. */
export type OrderDb = {
  connect(): Promise<OrderClient>;
  totalCount?: number;
  idleCount?: number;
  waitingCount?: number;
};

export type OrderClient = {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<OrderQueryResult<T>>;
  release(): void;
};

type ShipTo = {
  name: string;
  line1: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  line2?: string;
};

type PricedItem = OrderItemResponse;

type ParsedOrder = {
  email: string;
  shipTo: ShipTo;
  items: PricedItem[];
  subtotal: number;
};

type CheckoutMetrics = Pick<ApiMetrics, "dbErrorsTotal" | "transactionsTotal">;
type ReadMetrics = Pick<ApiMetrics, "dbErrorsTotal">;

const INSERT_ORDER = `
  INSERT INTO orders (number, email, ship_to, status, subtotal, tax, total, levy_ref, print_dimensions)
  VALUES ('PM-' || nextval('order_number_seq')::text, $1, $2::jsonb, 'received', $3, NULL, $3, NULL, $4)
  RETURNING id, number, status, subtotal, total
`;

const PRINT_DIMENSIONS: Record<string, string> = {
  A3: "297x420",
  A2: "420x594",
  A1: "594x841",
};

function printDimensions(size: string | undefined): string {
  if (!size) throw new Error("order has no items");
  const dimensions = PRINT_DIMENSIONS[size];
  if (!dimensions) throw new Error("unknown size");
  return dimensions;
}

const INSERT_ITEM = `
  INSERT INTO order_items (order_id, sku, size, frame, custom_text, unit_price)
  VALUES ($1, $2, $3, $4, $5, $6)
`;

const SELECT_ORDER = `
  SELECT
    o.number,
    o.status,
    o.subtotal,
    o.total,
    COALESCE(
      json_agg(
        json_build_object(
          'sku', i.sku,
          'size', i.size,
          'frame', i.frame,
          'customText', i.custom_text,
          'unitPrice', i.unit_price
        )
        ORDER BY i.ctid
      ) FILTER (WHERE i.id IS NOT NULL),
      '[]'::json
    ) AS items
  FROM orders o
  LEFT JOIN order_items i ON i.order_id = o.id
  WHERE o.number = $1
  GROUP BY o.id
`;

type OrderInsertRow = {
  id: string;
  number: string;
  status: string;
  subtotal: number | string;
  total: number | string;
};

type OrderSelectRow = {
  number: string;
  status: string;
  subtotal: number | string;
  total: number | string;
  items: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}

function invalid(error: string): OrderFailure {
  return { ok: false, status: 400, error };
}

/** Drop payment before any order log. Card data is never stored. */
export function detachPayment(body: unknown): unknown {
  if (!isRecord(body) || !Object.prototype.hasOwnProperty.call(body, "payment")) {
    return undefined;
  }
  const payment = body.payment;
  delete body.payment;
  return payment;
}

function unitPriceCents(sizeId: string, frameId: string): number | undefined {
  const size = sizes.find((entry) => entry.id === sizeId);
  const frame = frames.find((entry) => entry.id === frameId);
  if (!size || !frame) return undefined;
  return size.priceCents + frame.priceCents;
}

function parseShipTo(value: unknown): { shipTo: ShipTo } | OrderFailure {
  if (!isRecord(value)) return invalid("Shipping address is incomplete");

  const name = requiredText(value.name);
  const line1 = requiredText(value.line1);
  const city = requiredText(value.city);
  const region = requiredText(value.region);
  const postalCode = requiredText(value.postalCode);
  const country = requiredText(value.country);
  if (!name || !line1 || !city || !region || !postalCode || !country) {
    return invalid("Shipping address is incomplete");
  }

  const shipTo: ShipTo = { name, line1, city, region, postalCode, country };
  if (value.line2 !== undefined && value.line2 !== null && value.line2 !== "") {
    const line2 = requiredText(value.line2);
    if (!line2) return invalid("Shipping address is incomplete");
    shipTo.line2 = line2;
  }
  return { shipTo };
}

function parseItem(value: unknown): { items: PricedItem[] } | OrderFailure {
  if (!isRecord(value)) return invalid("Add at least one poster");

  const sku = requiredText(value.sku);
  const size = requiredText(value.size);
  const frame = requiredText(value.frame);
  if (!sku || !size || !frame) return invalid("Add at least one poster");

  const product = getProduct(sku);
  if (!product) return invalid("Unknown product");
  if (!sizes.some((entry) => entry.id === size)) return invalid("Unknown size");
  if (!frames.some((entry) => entry.id === frame)) return invalid("Unknown frame");

  const quantity = value.quantity;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > QUANTITY_MAX) {
    return invalid("Quantity must be between 1 and 10");
  }

  let customText: string | null = null;
  const rawCustom = value.customText;
  if (product.customText) {
    const text = requiredText(rawCustom);
    if (!text) return invalid("Custom text is required");
    if (text.length > CUSTOM_TEXT_MAX) return invalid("Custom text must be 60 characters or fewer");
    customText = text;
  } else if (rawCustom !== undefined && rawCustom !== null && rawCustom !== "") {
    if (typeof rawCustom !== "string" || rawCustom.trim().length > 0) {
      return invalid("This poster does not include custom text");
    }
  }

  const unitPrice = unitPriceCents(size, frame);
  if (unitPrice === undefined) return invalid("Unknown size");

  const row: PricedItem = { sku, size, frame, customText, unitPrice };
  return { items: Array.from({ length: quantity }, () => ({ ...row })) };
}

function parseOrderBody(body: unknown, payment: unknown): ParsedOrder | OrderFailure {
  if (!isRecord(body)) return invalid("Order is incomplete");
  if (!isRecord(payment)) return invalid("Payment is required");

  const email = requiredText(body.email);
  if (!email || !email.includes("@")) return invalid("Enter a valid email address");

  const shipped = parseShipTo(body.shipTo);
  if ("ok" in shipped) return shipped;

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return invalid("Add at least one poster");
  }

  const items: PricedItem[] = [];
  for (const entry of body.items) {
    const parsed = parseItem(entry);
    if ("ok" in parsed) return parsed;
    items.push(...parsed.items);
  }

  const subtotal = items.reduce((sum, item) => sum + item.unitPrice, 0);
  return { email, shipTo: shipped.shipTo, items, subtotal };
}

class QueryFailed extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("query failed");
    this.name = "QueryFailed";
    this.cause = cause;
  }
}

function noteDbError(log: FastifyBaseLogger, metrics: ReadMetrics, error: unknown): void {
  const sqlstate = sqlStateOf(error);
  const pgMessage = error instanceof Error ? error.message : "database error";
  metrics.dbErrorsTotal.inc({ sqlstate });
  log.error({ sqlstate, pgMessage }, "order query failed");
}

async function countedQuery<T>(
  log: FastifyBaseLogger,
  metrics: ReadMetrics,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    noteDbError(log, metrics, error);
    throw new QueryFailed(error);
  }
}

function asMoney(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  throw new Error("unexpected money value from database");
}

function asItems(value: unknown): OrderItemResponse[] {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry) => {
    if (!isRecord(entry)) throw new Error("unexpected order item from database");
    const sku = requiredText(entry.sku);
    const size = requiredText(entry.size);
    const frame = requiredText(entry.frame);
    const unitPrice = asMoney(entry.unitPrice);
    if (!sku || !size || !frame) throw new Error("unexpected order item from database");
    const customText = entry.customText === null ? null : requiredText(entry.customText);
    if (entry.customText !== null && customText === undefined) {
      throw new Error("unexpected order item from database");
    }
    return { sku, size, frame, customText: customText ?? null, unitPrice };
  });
}

async function rollback(client: OrderClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original query error is the one that counts.
  }
}

export async function placeOrder(
  db: OrderDb,
  body: unknown,
  log: FastifyBaseLogger,
  metrics: CheckoutMetrics,
): Promise<OrderResult> {
  const payment = detachPayment(body);
  const parsed = parseOrderBody(body, payment);
  if ("ok" in parsed) return parsed;

  let client: OrderClient | undefined;
  let open = false;
  try {
    const connected = await countedQuery(log, metrics, () => db.connect());
    client = connected;
    await countedQuery(log, metrics, () => connected.query("BEGIN"));
    open = true;

    const inserted = await countedQuery(log, metrics, () =>
      connected.query<OrderInsertRow>(INSERT_ORDER, [
        parsed.email,
        JSON.stringify(parsed.shipTo),
        parsed.subtotal,
        printDimensions(parsed.items[0]?.size),
      ]),
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("order insert returned no row");

    for (const item of parsed.items) {
      await countedQuery(log, metrics, () =>
        connected.query(INSERT_ITEM, [
          row.id,
          item.sku,
          item.size,
          item.frame,
          item.customText,
          item.unitPrice,
        ]),
      );
    }

    const order: OrderResponse = {
      number: String(row.number),
      status: String(row.status),
      subtotal: asMoney(row.subtotal),
      total: asMoney(row.total),
      items: parsed.items,
    };
    await countedQuery(log, metrics, () => connected.query("COMMIT"));
    open = false;
    metrics.transactionsTotal.inc({ result: "success" });
    return { ok: true, order };
  } catch (error) {
    if (open && client) await rollback(client);
    if (!(error instanceof QueryFailed)) noteDbError(log, metrics, error);
    metrics.transactionsTotal.inc({ result: "error" });
    return { ok: false, status: 500, error: ORDER_FAILED };
  } finally {
    client?.release();
  }
}

export async function readOrder(
  db: OrderDb,
  number: string,
  log: FastifyBaseLogger,
  metrics: ReadMetrics,
): Promise<OrderResult> {
  let client: OrderClient | undefined;
  try {
    const connected = await countedQuery(log, metrics, () => db.connect());
    client = connected;
    const selected = await countedQuery(log, metrics, () =>
      connected.query<OrderSelectRow>(SELECT_ORDER, [number]),
    );
    const row = selected.rows[0];
    if (!row) return { ok: false, status: 404, error: ORDER_NOT_FOUND };
    return {
      ok: true,
      order: {
        number: String(row.number),
        status: String(row.status),
        subtotal: asMoney(row.subtotal),
        total: asMoney(row.total),
        items: asItems(row.items),
      },
    };
  } catch (error) {
    if (!(error instanceof QueryFailed)) noteDbError(log, metrics, error);
    return { ok: false, status: 500, error: ORDER_LOAD_FAILED };
  } finally {
    client?.release();
  }
}
