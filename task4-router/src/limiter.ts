import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export const WINDOW_MS = 60_000;
export const TOKEN_LIMIT = 50_000;

export function estimateTokens(text: string, maxTokens: number): number {
  return Math.ceil(text.length / 4) + maxTokens;
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export class RateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("Rate limit exceeded");
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }

  get retryAfterSeconds(): number {
    return Math.max(1, Math.ceil(this.retryAfterMs / 1000));
  }
}

export class EstimateTooLargeError extends Error {
  constructor(estimated: number) {
    super(`Estimated ${estimated} tokens exceeds the limit`);
    this.name = "EstimateTooLargeError";
  }
}

export type Reservation = {
  id: string;
  estimated: number;
};

export type LimiterOptions = {
  db: Database.Database;
  now?: () => number;
  windowMs?: number;
  tokenLimit?: number;
  purgeIntervalMs?: number;
};

type UsageTotal = {
  total: number;
  oldest: number | null;
};

export class Limiter {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly tokenLimit: number;
  private readonly purgeIntervalMs: number;
  private purgeTimer: NodeJS.Timeout | null = null;

  constructor(options: LimiterOptions) {
    this.db = options.db;
    this.now = options.now ?? Date.now;
    this.windowMs = options.windowMs ?? WINDOW_MS;
    this.tokenLimit = options.tokenLimit ?? TOKEN_LIMIT;
    this.purgeIntervalMs = options.purgeIntervalMs ?? 30_000;
  }

  reserve(key: string, estimated: number): Reservation {
    if (!Number.isInteger(estimated) || estimated < 0) {
      throw new RangeError("estimated must be a non-negative integer");
    }

    if (estimated > this.tokenLimit) {
      throw new EstimateTooLargeError(estimated);
    }

    const id = randomUUID();
    const keyHash = hashKey(key);
    const now = this.now();
    const cutoff = now - this.windowMs;

    const transaction = this.db.transaction((): Reservation => {
      this.db
        .prepare("DELETE FROM usage WHERE key_hash = ? AND ts_ms <= ?")
        .run(keyHash, cutoff);

      const row = this.db
        .prepare(
          "SELECT COALESCE(SUM(tokens), 0) AS total, MIN(ts_ms) AS oldest FROM usage WHERE key_hash = ?"
        )
        .get(keyHash) as UsageTotal;

      if (row.total + estimated > this.tokenLimit) {
        const retryAfterMs =
          row.oldest === null
            ? this.windowMs
            : Math.max(1, row.oldest + this.windowMs - now);

        throw new RateLimitError(retryAfterMs);
      }

      this.db
        .prepare(
          "INSERT INTO usage (id, key_hash, ts_ms, tokens, status) VALUES (?, ?, ?, ?, 'reserved')"
        )
        .run(id, keyHash, now, estimated);

      return { id, estimated };
    });

    return transaction.immediate();
  }

  settle(id: string, actual: number | null | undefined): void {
    const row = this.db
      .prepare("SELECT tokens FROM usage WHERE id = ?")
      .get(id) as { tokens: number } | undefined;

    if (row === undefined) {
      return;
    }

    const tokens =
      typeof actual === "number" && Number.isFinite(actual) && actual >= 0
        ? Math.ceil(actual)
        : row.tokens;

    this.db
      .prepare("UPDATE usage SET tokens = ?, status = 'settled' WHERE id = ?")
      .run(tokens, id);
  }

  release(id: string): void {
    this.db.prepare("DELETE FROM usage WHERE id = ?").run(id);
  }

  usedTokens(key: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(tokens), 0) AS total FROM usage WHERE key_hash = ?"
      )
      .get(hashKey(key)) as { total: number };

    return row.total;
  }

  purge(): number {
    const cutoff = this.now() - this.windowMs;

    return this.db.prepare("DELETE FROM usage WHERE ts_ms <= ?").run(cutoff)
      .changes;
  }

  startPurgeTimer(): NodeJS.Timeout {
    if (this.purgeTimer !== null) {
      return this.purgeTimer;
    }

    this.purgeTimer = setInterval(() => {
      this.purge();
    }, this.purgeIntervalMs);
    this.purgeTimer.unref();

    return this.purgeTimer;
  }

  stopPurgeTimer(): void {
    if (this.purgeTimer === null) {
      return;
    }

    clearInterval(this.purgeTimer);
    this.purgeTimer = null;
  }
}