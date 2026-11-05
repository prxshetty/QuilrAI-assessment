import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type Database from "better-sqlite3";

import { createRouterServer, writeLog } from "../src/index.js";
import { openDatabase } from "../src/database.js";
import { Limiter } from "../src/limiter.js";
import {
  createHttpProvider,
  type Provider,
  type ProviderRequest,
  type ProviderResult,
} from "../src/providers.js";
import { Router } from "../src/router.js";
import {
  createMockUpstream,
  type MockUpstream,
  type MockUpstreamOptions,
} from "../src/mock-upstream.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (address === null || typeof address === "string") {
        reject(new Error("server did not bind to a TCP port"));
        return;
      }

      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function provider(
  name: string,
  complete: (request: ProviderRequest) => Promise<ProviderResult>
): Provider {
  return { name, complete };
}

function httpProvider(name: string, port: number): Provider {
  return createHttpProvider({
    name,
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
  });
}

type Started = {
  db: Database.Database;
  server: Server;
  url: string;
  close: () => Promise<void>;
};

async function startWith(
  primary: Provider,
  secondary: Provider
): Promise<Started> {
  const db = openDatabase(":memory:");
  const limiter = new Limiter({ db });
  const router = new Router({
    primary,
    secondary,
    log: () => undefined,
  });
  const server = createRouterServer({
    limiter,
    router,
    log: () => undefined,
  });
  const port = await listen(server);

  return {
    db,
    server,
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    close: async () => {
      await close(server);
      db.close();
    },
  };
}

type Mock = {
  upstream: MockUpstream;
  port: number;
  close: () => Promise<void>;
};

async function startMock(options: MockUpstreamOptions): Promise<Mock> {
  const upstream = createMockUpstream(options);
  const port = await listen(upstream.server);

  return {
    upstream,
    port,
    close: () => close(upstream.server),
  };
}

type CallOptions = {
  key?: string;
  prompt?: string;
  maxTokens?: number;
};

function call(url: string, options: CallOptions = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.key ?? "test-key"}`,
    },
    body: JSON.stringify({
      prompt: options.prompt ?? "hello",
      max_tokens: options.maxTokens ?? 10,
    }),
  });
}

function neverCalled(): Provider {
  return provider("secondary", async () => {
    throw new Error("provider should not be called");
  });
}

type SuccessBody = {
  text: string;
  upstream: string;
  usage: { total_tokens: number };
  request_id: string;
};

test("success settles the provider usage and carries X-Request-Id", async () => {
  const mock = await startMock({
    body: {
      choices: [{ message: { content: "hello there" } }],
      usage: { total_tokens: 123 },
    },
  });
  const started = await startWith(httpProvider("primary", mock.port), neverCalled());

  try {
    const response = await call(started.url);
    const body = (await response.json()) as SuccessBody;
    const requestId = response.headers.get("x-request-id");

    assert.equal(response.status, 200);
    assert.equal(body.text, "hello there");
    assert.equal(body.upstream, "primary");
    assert.equal(body.usage.total_tokens, 123);
    assert.equal(body.request_id, requestId);

    const row = started.db
      .prepare("SELECT tokens, status FROM usage")
      .get() as { tokens: number; status: string };

    assert.equal(row.tokens, 123);
    assert.equal(row.status, "settled");
  } finally {
    await started.close();
    await mock.close();
  }
});

test("upstream stacks and secrets never reach the client", async () => {
  const secret = "sk-live-SECRET";
  const stack = "Error: boom\n    at secretHandler (/srv/secret.js:1:1)";

  const bad = await startMock({
    status: 400,
    body: { error: { message: "bad", secret, stack } },
  });
  const rejected = await startWith(httpProvider("primary", bad.port), neverCalled());

  try {
    const response = await call(rejected.url);
    const text = await response.text();

    assert.equal(response.status, 400);
    assert.ok(!text.includes(secret));
    assert.ok(!text.includes("secretHandler"));
    assert.equal(JSON.parse(text).error.code, "invalid_request");
  } finally {
    await rejected.close();
    await bad.close();
  }

  const primary = await startMock({
    status: 500,
    body: { error: { message: "boom", secret, stack } },
  });
  const secondary = await startMock({
    body: { choices: [{ message: { content: "safe" } }] },
  });
  const routed = await startWith(
    httpProvider("primary", primary.port),
    httpProvider("secondary", secondary.port)
  );

  try {
    const response = await call(routed.url);
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.ok(!text.includes(secret));
    assert.ok(!text.includes("secretHandler"));
  } finally {
    await routed.close();
    await primary.close();
    await secondary.close();
  }
});

test("a full budget returns 429 with Retry-After", async () => {
  const mock = await startMock({
    body: { choices: [{ message: { content: "ok" } }] },
  });
  const started = await startWith(httpProvider("primary", mock.port), neverCalled());

  try {
    const first = await call(started.url, { maxTokens: 30_000 });
    assert.equal(first.status, 200);

    const second = await call(started.url, { maxTokens: 30_000 });
    const body = (await second.json()) as {
      error: { code: string; request_id: string };
    };
    const retryAfter = second.headers.get("retry-after");

    assert.equal(second.status, 429);
    assert.equal(body.error.code, "rate_limited");
    assert.equal(body.error.request_id, second.headers.get("x-request-id"));
    assert.ok(retryAfter !== null);
    assert.ok(Number(retryAfter) >= 1);
  } finally {
    await started.close();
    await mock.close();
  }
});

test("a timed-out request stays charged while a 400 releases", async () => {
  const timed = await startWith(
    provider("primary", async () => ({ ok: false, kind: "timeout" })),
    provider("secondary", async () => ({ ok: false, kind: "timeout" }))
  );

  try {
    const response = await call(timed.url);
    assert.equal(response.status, 503);

    const rows = timed.db
      .prepare("SELECT status FROM usage")
      .all() as Array<{ status: string }>;

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, "reserved");
  } finally {
    await timed.close();
  }

  const rejected = await startWith(
    provider("primary", async () => ({ ok: false, kind: "http", status: 400 })),
    neverCalled()
  );

  try {
    const response = await call(rejected.url);
    assert.equal(response.status, 400);

    const row = rejected.db
      .prepare("SELECT COUNT(*) AS total FROM usage")
      .get() as { total: number };

    assert.equal(row.total, 0);
  } finally {
    await rejected.close();
  }
});

test("an estimate larger than the whole budget returns 400", async () => {
  const started = await startWith(neverCalled(), neverCalled());

  try {
    const response = await call(started.url, { maxTokens: 50_000 });
    const body = (await response.json()) as { error: { code: string } };
    const row = started.db
      .prepare("SELECT COUNT(*) AS total FROM usage")
      .get() as { total: number };

    assert.equal(response.status, 400);
    assert.equal(body.error.code, "invalid_request");
    assert.equal(row.total, 0);
  } finally {
    await started.close();
  }
});

test("structured logs are JSON keyed by request_id", () => {
  const captured: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    writeLog({ level: "info", event: "test", request_id: "req-1" });
  } finally {
    process.stderr.write = original;
  }

  const line = JSON.parse(captured.join("").trim()) as Record<string, unknown>;

  assert.equal(line.request_id, "req-1");
  assert.equal(line.event, "test");
  assert.equal(typeof line.ts, "string");
});

test("a missing key returns a fixed unauthorized body", async () => {
  const started = await startWith(neverCalled(), neverCalled());

  try {
    const response = await fetch(started.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", max_tokens: 10 }),
    });
    const body = (await response.json()) as {
      error: { code: string; message: string; request_id: string };
    };

    assert.equal(response.status, 401);
    assert.equal(body.error.code, "unauthorized");
    assert.equal(body.error.message, "Unauthorized");
    assert.equal(body.error.request_id, response.headers.get("x-request-id"));
  } finally {
    await started.close();
  }
});