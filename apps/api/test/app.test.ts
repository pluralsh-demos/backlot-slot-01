import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { OrderDb, OrderQueryResult } from "../src/orders.js";

const METRIC_NAMES = [
  "http_requests_total",
  "http_request_duration_seconds",
  "transactions_total",
  "db_pool_connections",
  "db_errors_total",
  "app_build_info",
] as const;

const CUSTOM_TEXT_SKUS = new Set(["PM-STARMAP", "PM-NAMESTARS"]);

type EnvName = "DATABASE_URL" | "PACK" | "VERSION" | "GIT_SHA";

const envBackup: Partial<Record<EnvName, string | undefined>> = {};

function rememberEnv(name: EnvName): void {
  envBackup[name] = process.env[name];
}

function restoreEnv(name: EnvName): void {
  const previous = envBackup[name];
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

function captureLogs(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  return {
    stream,
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

const discardLogs = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

describe("poster meteor api", () => {
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    rememberEnv("DATABASE_URL");
    rememberEnv("PACK");
    rememberEnv("VERSION");
    rememberEnv("GIT_SHA");
    delete process.env.DATABASE_URL;
    process.env.PACK = "poster-meteor";
    process.env.VERSION = "dev";
    process.env.GIT_SHA = "unknown";
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    restoreEnv("DATABASE_URL");
    restoreEnv("PACK");
    restoreEnv("VERSION");
    restoreEnv("GIT_SHA");
  });

  it("returns six products, custom-text flags, sizes, frames, and 404 for an unknown sku", async () => {
    app = buildApp({ logStream: discardLogs });

    const list = await app.inject({ method: "GET", url: "/api/products" });
    expect(list.statusCode).toBe(200);
    const body = list.json<{
      products: { sku: string; name: string; customText: boolean }[];
      sizes: { id: string; priceCents: number }[];
      frames: { id: string; priceCents: number }[];
    }>();

    expect(body.products.map((product) => product.sku)).toEqual([
      "PM-PERSEID",
      "PM-LEONID",
      "PM-HALLEY",
      "PM-STARMAP",
      "PM-NAMESTARS",
      "PM-NEBULA-LE",
    ]);
    expect(body.products).toHaveLength(6);
    for (const product of body.products) {
      expect(product.name.length).toBeGreaterThan(0);
      expect(product.customText).toBe(CUSTOM_TEXT_SKUS.has(product.sku));
    }

    expect(body.sizes).toEqual([
      { id: "A3", priceCents: 2800 },
      { id: "A2", priceCents: 4200 },
      { id: "A1", priceCents: 6400 },
    ]);
    expect(body.frames).toEqual([
      { id: "none", name: "None", priceCents: 0 },
      { id: "black-oak", name: "Black Oak", priceCents: 3500 },
      { id: "white-ash", name: "White Ash", priceCents: 3500 },
    ]);

    const starMap = await app.inject({ method: "GET", url: "/api/products/PM-STARMAP" });
    expect(starMap.statusCode).toBe(200);
    expect(starMap.json()).toMatchObject({ sku: "PM-STARMAP", customText: true });

    const missing = await app.inject({ method: "GET", url: "/api/products/PM-UNKNOWN" });
    expect(missing.statusCode).toBe(404);
  });

  it("returns 200 from /healthz and /readyz with no database", async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
    app = buildApp({ logStream: discardLogs });

    const health = await app.inject({ method: "GET", url: "/healthz" });
    const ready = await app.inject({ method: "GET", url: "/readyz" });

    expect(health.statusCode).toBe(200);
    expect(ready.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });
    expect(ready.json()).toEqual({ status: "ok" });
  });

  it("exposes the telemetry series and app_build_info labels", async () => {
    app = buildApp({ logStream: discardLogs });

    const response = await app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(200);

    for (const name of METRIC_NAMES) {
      expect(response.body).toContain(`# TYPE ${name}`);
    }
    expect(response.body).toContain(
      'app_build_info{pack="poster-meteor",version="dev",git_sha="unknown"} 1',
    );
  });

  it("logs the telemetry contract and redacts an inbound cookie", async () => {
    const logs = captureLogs();
    app = buildApp({ logStream: logs.stream });

    const response = await app.inject({
      method: "GET",
      url: "/api/products/PM-PERSEID",
      headers: { cookie: "session=secret" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("secret");

    const text = logs.text();
    expect(text).not.toContain("secret");

    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.pack).toBe("poster-meteor");
      expect(line.service).toBe("api");
      expect(line.route).toBe("/api/products/:sku");
      expect(line.ref).toBe("");
    }
  });

  it("returns 503 for orders when no database is configured", async () => {
    app = buildApp({ logStream: discardLogs });

    const created = await app.inject({
      method: "POST",
      url: "/api/orders",
      payload: orderBody({ payment: { brand: "visa", last4: "4242424242424242" } }),
    });
    const loaded = await app.inject({ method: "GET", url: "/api/orders/PM-12000" });
    const catalog = await app.inject({ method: "GET", url: "/api/products" });

    expect(created.statusCode).toBe(503);
    expect(loaded.statusCode).toBe(503);
    expect(created.json()).toEqual({ error: "Orders are unavailable" });
    expect(catalog.statusCode).toBe(200);
    expect(await counter(app, "transactions_total", 'result="success"')).toBe(0);
    expect(await counter(app, "transactions_total", 'result="error"')).toBe(0);
  });

  it("places an order and reads it back", async () => {
    const logs = captureLogs();
    const db = memoryOrders();
    app = buildApp({ logStream: logs.stream, pool: db.pool });

    const created = await app.inject({
      method: "POST",
      url: "/api/orders",
      payload: orderBody({
        payment: { brand: "visa", last4: "4242424242424242" },
        items: [
          { sku: "PM-PERSEID", size: "A3", frame: "none", quantity: 2 },
          { sku: "PM-STARMAP", size: "A1", frame: "white-ash", customText: "Orion", quantity: 1 },
        ],
      }),
    });

    expect(created.statusCode).toBe(201);
    const order = created.json<{
      number: string;
      status: string;
      subtotal: number;
      total: number;
      tax?: number;
      items: { sku: string; unitPrice: number; customText: string | null }[];
    }>();
    expect(order.number).toMatch(/^PM-\d+$/);
    expect(order.status).toBe("received");
    expect(order.subtotal).toBe(order.total);
    expect(order.subtotal).toBe(2800 * 2 + (6400 + 3500));
    expect(order.items).toHaveLength(3);
    expect(order.items[0]).toMatchObject({ sku: "PM-PERSEID", unitPrice: 2800, customText: null });
    expect(order.items[2]).toMatchObject({ sku: "PM-STARMAP", unitPrice: 9900, customText: "Orion" });
    expect(order).not.toHaveProperty("tax");
    expect(created.body).not.toContain("4242424242424242");
    expect(logs.text()).not.toContain("4242424242424242");
    expect(db.calls.some((sql) => sql.includes("4242"))).toBe(false);
    expect(await counter(app, "transactions_total", 'result="success"')).toBe(1);
    expect(await counter(app, "transactions_total", 'result="error"')).toBe(0);

    const createdLog = logLines(logs.text()).find((line) => line.msg === "order created");
    expect(createdLog?.ref).toBe(order.number);

    const loaded = await app.inject({ method: "GET", url: `/api/orders/${order.number}` });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json()).toEqual(order);
    expect(logLines(logs.text()).some((line) => line.ref === order.number && line.route === "/api/orders/:number")).toBe(
      true,
    );
  });

  it("rejects an unknown sku without counting a transaction", async () => {
    const db = memoryOrders();
    app = buildApp({ logStream: discardLogs, pool: db.pool });

    const response = await app.inject({
      method: "POST",
      url: "/api/orders",
      payload: orderBody({
        items: [{ sku: "PM-NOPE", size: "A3", frame: "none", quantity: 1 }],
      }),
    });

    expect(response.statusCode).toBe(400);
    expect(db.calls).toEqual([]);
    expect(await counter(app, "transactions_total", 'result="success"')).toBe(0);
    expect(await counter(app, "transactions_total", 'result="error"')).toBe(0);

    const customOnPlain = await app.inject({
      method: "POST",
      url: "/api/orders",
      payload: orderBody({
        items: [{ sku: "PM-PERSEID", size: "A3", frame: "none", quantity: 1, customText: "nope" }],
      }),
    });
    const missingCustom = await app.inject({
      method: "POST",
      url: "/api/orders",
      payload: orderBody({
        items: [{ sku: "PM-NAMESTARS", size: "A2", frame: "black-oak", quantity: 1 }],
      }),
    });
    const longCustom = await app.inject({
      method: "POST",
      url: "/api/orders",
      payload: orderBody({
        items: [
          {
            sku: "PM-STARMAP",
            size: "A3",
            frame: "none",
            quantity: 1,
            customText: "x".repeat(61),
          },
        ],
      }),
    });
    const tooMany = await app.inject({
      method: "POST",
      url: "/api/orders",
      payload: orderBody({
        items: [{ sku: "PM-HALLEY", size: "A3", frame: "none", quantity: 11 }],
      }),
    });

    expect(customOnPlain.statusCode).toBe(400);
    expect(missingCustom.statusCode).toBe(400);
    expect(longCustom.statusCode).toBe(400);
    expect(tooMany.statusCode).toBe(400);
    expect(db.calls).toEqual([]);
    expect(await counter(app, "transactions_total", 'result="error"')).toBe(0);
  });

  it("counts a missing column as a database error and hides the sql", async () => {
    const logs = captureLogs();
    const db = memoryOrders({
      failOn: "INSERT INTO orders",
      code: "42703",
      message: 'column "print_dimensions" of relation "orders" does not exist',
    });
    app = buildApp({ logStream: logs.stream, pool: db.pool });

    const response = await app.inject({
      method: "POST",
      url: "/api/orders",
      payload: orderBody(),
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "We couldn't place your order" });
    expect(response.body).not.toContain("42703");
    expect(response.body).not.toContain("print_dimensions");
    expect(await counter(app, "db_errors_total", 'sqlstate="42703"')).toBe(1);
    expect(await counter(app, "transactions_total", 'result="error"')).toBe(1);
    expect(await counter(app, "transactions_total", 'result="success"')).toBe(0);

    const text = logs.text();
    expect(text).toContain("42703");
    expect(text).toContain("sqlstate");
    const dbError = logLines(text).find((line) => line.sqlstate === "42703");
    expect(dbError?.pgMessage).toBe(
      'column "print_dimensions" of relation "orders" does not exist',
    );
    expect(db.calls.some((sql) => sql === "ROLLBACK")).toBe(true);
  });

  it("counts a refused connection as a database error and hides the sqlstate", async () => {
    const logs = captureLogs();
    const db = memoryOrders({
      failConnect: true,
      code: "53300",
      message: "sorry, too many clients already",
    });
    app = buildApp({ logStream: logs.stream, pool: db.pool });

    const response = await app.inject({
      method: "POST",
      url: "/api/orders",
      payload: orderBody(),
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "We couldn't place your order" });
    expect(response.body).not.toContain("53300");
    expect(await counter(app, "db_errors_total", 'sqlstate="53300"')).toBe(1);
    expect(await counter(app, "transactions_total", 'result="error"')).toBe(1);
    expect(await counter(app, "transactions_total", 'result="success"')).toBe(0);

    const dbError = logLines(logs.text()).find((line) => line.sqlstate === "53300");
    expect(dbError?.pgMessage).toBe("sorry, too many clients already");
    expect(db.calls).not.toContain("BEGIN");
  });
});

function orderBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: "ada@example.com",
    shipTo: {
      name: "Ada Lovelace",
      line1: "1 Analytical Engine",
      city: "London",
      region: "London",
      postalCode: "SW1A 1AA",
      country: "GB",
    },
    items: [{ sku: "PM-PERSEID", size: "A3", frame: "none", quantity: 1 }],
    payment: { brand: "visa", last4: "4242" },
    ...overrides,
  };
}

function logLines(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function counter(app: FastifyInstance, name: string, labels: string): Promise<number> {
  const response = await app.inject({ method: "GET", url: "/metrics" });
  const match = response.body.match(new RegExp(`^${name}\\{${labels}\\} (\\d+)`, "m"));
  return match?.[1] ? Number(match[1]) : 0;
}

type StoredItem = {
  sku: string;
  size: string;
  frame: string;
  customText: string | null;
  unitPrice: number;
};

type StoredOrder = {
  id: string;
  number: string;
  status: "received";
  subtotal: number;
  total: number;
  items: StoredItem[];
};

function memoryOrders(options?: {
  failOn?: string;
  failConnect?: boolean;
  code?: string;
  message?: string;
}): {
  pool: OrderDb;
  calls: string[];
} {
  const calls: string[] = [];
  const orders: StoredOrder[] = [];
  let next = 12000;
  const client = {
    async query<T>(sql: string, params?: unknown[]): Promise<OrderQueryResult<T>> {
      calls.push(sql);
      if (options?.failOn && sql.includes(options.failOn)) {
        const error = new Error(options.message ?? "database error") as Error & { code?: string };
        error.code = options.code ?? "XX000";
        throw error;
      }
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }
      if (sql.includes("INSERT INTO orders")) {
        const subtotal = Number(params?.[2]);
        const id = `order-${orders.length + 1}`;
        const number = `PM-${next}`;
        next += 1;
        orders.push({
          id,
          number,
          status: "received",
          subtotal,
          total: subtotal,
          items: [],
        });
        return {
          rows: [{ id, number, status: "received", subtotal, total: subtotal } as T],
          rowCount: 1,
        };
      }
      if (sql.includes("INSERT INTO order_items")) {
        const order = orders.find((entry) => entry.id === params?.[0]);
        if (!order) throw new Error("missing order");
        order.items.push({
          sku: String(params?.[1]),
          size: String(params?.[2]),
          frame: String(params?.[3]),
          customText: params?.[4] === null || params?.[4] === undefined ? null : String(params[4]),
          unitPrice: Number(params?.[5]),
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM orders")) {
        const order = orders.find((entry) => entry.number === params?.[0]);
        if (!order) return { rows: [], rowCount: 0 };
        return {
          rows: [
            {
              number: order.number,
              status: order.status,
              subtotal: order.subtotal,
              total: order.total,
              items: order.items,
            } as T,
          ],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
    release() {},
  };
  return {
    calls,
    pool: {
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      connect: async () => {
        if (options?.failConnect) {
          const error = new Error(options.message ?? "database error") as Error & { code?: string };
          error.code = options.code ?? "XX000";
          throw error;
        }
        return client;
      },
    },
  };
}
