import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { openDatabase } from "../src/database.js";
import {
  EstimateTooLargeError,
  Limiter,
  RateLimitError,
  estimateTokens,
} from "../src/limiter.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(testDir);
const workerPath = join(testDir, "fixtures", "reserve-worker.ts");

function memoryLimiter(now?: () => number): {
  db: ReturnType<typeof openDatabase>;
  limiter: Limiter;
} {
  const db = openDatabase(":memory:");

  return { db, limiter: new Limiter({ db, now }) };
}

test("estimates chars/4 plus max_tokens", () => {
  assert.equal(estimateTokens("12345678", 100), 102);
  assert.equal(estimateTokens("123", 0), 1);
});

test("settle stores the provider count and falls back to the estimate", () => {
  const { limiter } = memoryLimiter();
  const first = limiter.reserve("key", 1000);
  limiter.settle(first.id, 250);
  assert.equal(limiter.usedTokens("key"), 250);

  const second = limiter.reserve("key", 500);
  limiter.settle(second.id, null);
  assert.equal(limiter.usedTokens("key"), 750);

  const third = limiter.reserve("key", 300);
  limiter.settle(third.id, undefined);
  assert.equal(limiter.usedTokens("key"), 1050);
});

test("release removes a reservation", () => {
  const { limiter } = memoryLimiter();
  const reservation = limiter.reserve("key", 1000);
  assert.equal(limiter.usedTokens("key"), 1000);

  limiter.release(reservation.id);
  assert.equal(limiter.usedTokens("key"), 0);
});

test("rejects estimates larger than the whole budget", () => {
  const { limiter } = memoryLimiter();

  assert.throws(
    () => limiter.reserve("key", 50_001),
    EstimateTooLargeError
  );
});

test("reports retry_after when the budget is exhausted", () => {
  let now = 0;
  const { limiter } = memoryLimiter(() => now);
  limiter.reserve("key", 30_000);

  now = 10_000;
  limiter.reserve("key", 20_000);

  try {
    limiter.reserve("key", 1);
    assert.fail("expected a rate limit error");
  } catch (error) {
    assert.ok(error instanceof RateLimitError);
    assert.equal(error.retryAfterSeconds, 50);
  }
});

test("clock eviction happens after the 60s window", () => {
  let now = 0;
  const { limiter } = memoryLimiter(() => now);

  limiter.reserve("key", 30_000);

  now = 59_900;
  limiter.reserve("key", 20_000);
  assert.throws(() => limiter.reserve("key", 1), RateLimitError);

  now = 60_100;
  assert.doesNotThrow(() => limiter.reserve("key", 30_000));
  assert.equal(limiter.usedTokens("key"), 50_000);
});

test("purge removes every expired row", () => {
  let now = 0;
  const { limiter } = memoryLimiter(() => now);
  limiter.reserve("a", 100);
  limiter.reserve("b", 100);

  now = 60_000;
  assert.equal(limiter.purge(), 2);
  assert.equal(limiter.usedTokens("a"), 0);
});

test("100 concurrent reservations keep the total at or below 50k", async () => {
  const { limiter } = memoryLimiter();
  let accepted = 0;

  await Promise.all(
    Array.from({ length: 100 }, async () => {
      try {
        limiter.reserve("key", 1000);
        accepted += 1;
      } catch (error) {
        assert.ok(error instanceof RateLimitError);
      }
    })
  );

  assert.equal(accepted, 50);
  assert.equal(limiter.usedTokens("key"), 50_000);
});

type WorkerResult = { accepted: number; acceptedTokens: number };

function runWorker(dbPath: string): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = fork(
      workerPath,
      [dbPath, "shared", "200", "1000"],
      {
        cwd: packageDir,
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "pipe", "inherit", "ipc"],
      }
    );
    let output = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`worker exited with ${code}`));
        return;
      }

      resolve(JSON.parse(output) as WorkerResult);
    });
  });
}

test("4 worker processes on one DB file keep the total at or below 50k", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task4-router-"));
  const dbPath = join(dir, "usage.sqlite");

  try {
    const results = await Promise.all([
      runWorker(dbPath),
      runWorker(dbPath),
      runWorker(dbPath),
      runWorker(dbPath),
    ]);
    const accepted = results.reduce(
      (sum, result) => sum + result.acceptedTokens,
      0
    );

    assert.equal(accepted, 50_000);

    const db = openDatabase(dbPath);
    const row = db
      .prepare("SELECT COALESCE(SUM(tokens), 0) AS total FROM usage")
      .get() as { total: number };
    db.close();

    assert.equal(row.total, 50_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});