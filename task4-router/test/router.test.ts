import { test } from "node:test";
import assert from "node:assert/strict";

import { AppError } from "../src/errors.js";
import type {
  Provider,
  ProviderRequest,
  ProviderResult,
} from "../src/providers.js";
import { Router } from "../src/router.js";

function provider(
  name: string,
  complete: (request: ProviderRequest) => Promise<ProviderResult>
): Provider {
  return { name, complete };
}

function success(text: string, totalTokens: number | null = null): ProviderResult {
  return { ok: true, text, totalTokens };
}

function httpFailure(status: number): ProviderResult {
  return { ok: false, kind: "http", status };
}

function neverCalled(): Provider {
  return provider("secondary", async () => {
    throw new Error("secondary should not be called");
  });
}

test("429, 5xx and network failures fail over", async () => {
  const failures: ProviderResult[] = [
    httpFailure(429),
    httpFailure(500),
    httpFailure(503),
    { ok: false, kind: "network" },
  ];

  for (const failure of failures) {
    let secondaryCalled = false;
    const router = new Router({
      primary: provider("primary", async () => failure),
      secondary: provider("secondary", async () => {
        secondaryCalled = true;
        return success("secondary");
      }),
    });

    const result = await router.route({ prompt: "hi", maxTokens: 10 });

    assert.equal(result.upstream, "secondary");
    assert.equal(result.text, "secondary");
    assert.ok(secondaryCalled);
  }
});

test("400 and 422 do not fail over and map to invalid_request", async () => {
  for (const status of [400, 422]) {
    const router = new Router({
      primary: provider("primary", async () => httpFailure(status)),
      secondary: neverCalled(),
    });

    await assert.rejects(
      router.route({ prompt: "hi", maxTokens: 10 }),
      (error: unknown) =>
        error instanceof AppError && error.code === "invalid_request"
    );
  }
});

test("a 3.5s primary fails over at 3.0s and its late reply is ignored", async () => {
  const primary = provider(
    "primary",
    () =>
      new Promise<ProviderResult>((resolve) => {
        setTimeout(() => resolve(success("primary")), 3500);
      })
  );
  const router = new Router({
    primary,
    secondary: provider("secondary", async () => success("secondary")),
  });

  const startedAt = Date.now();
  const result = await router.route({ prompt: "hi", maxTokens: 10 });
  const elapsed = Date.now() - startedAt;

  assert.equal(result.text, "secondary");
  assert.equal(result.upstream, "secondary");
  assert.ok(elapsed >= 2900, `failed over too early: ${elapsed}ms`);
  assert.ok(elapsed < 3400, `failed over too late: ${elapsed}ms`);

  await new Promise((resolve) => setTimeout(resolve, 600));
});

test("secondary timeout leaves timedOut set", async () => {
  const router = new Router({
    primary: provider("primary", async () => ({ ok: false, kind: "network" })),
    secondary: provider(
      "secondary",
      () => new Promise<ProviderResult>(() => undefined)
    ),
    secondaryTimeoutMs: 30,
  });

  await assert.rejects(
    router.route({ prompt: "hi", maxTokens: 10 }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "upstream_unavailable" &&
      error.timedOut
  );
});

test("both upstreams failing returns upstream_unavailable", async () => {
  const router = new Router({
    primary: provider("primary", async () => httpFailure(500)),
    secondary: provider("secondary", async () => httpFailure(500)),
  });

  await assert.rejects(
    router.route({ prompt: "hi", maxTokens: 10 }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "upstream_unavailable" &&
      !error.timedOut
  );
});