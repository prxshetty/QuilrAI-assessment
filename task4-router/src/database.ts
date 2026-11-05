import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type UsageStatus = "reserved" | "settled";

export type UsageRow = {
  id: string;
  key_hash: string;
  ts_ms: number;
  tokens: number;
  status: UsageStatus;
};

const schema = `
CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  tokens INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'settled'))
);
CREATE INDEX IF NOT EXISTS usage_key_ts ON usage (key_hash, ts_ms);
`;

const setupDeadlineMs = 10_000;
const setupSleepMs = 25;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function isBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "SQLITE_BUSY"
  );
}

function withBusyRetry(operation: () => void): void {
  const deadline = Date.now() + setupDeadlineMs;

  for (;;) {
    try {
      operation();
      return;
    } catch (error) {
      if (!isBusy(error) || Date.now() >= deadline) {
        throw error;
      }

      Atomics.wait(sleepBuffer, 0, 0, setupSleepMs);
    }
  }
}

export function openDatabase(path: string): Database.Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  db.pragma("busy_timeout = 5000");

  withBusyRetry(() => {
    db.pragma("journal_mode = WAL");
  });
  withBusyRetry(() => {
    db.exec(schema);
  });

  return db;
}