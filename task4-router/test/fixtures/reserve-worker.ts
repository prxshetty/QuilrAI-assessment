import { openDatabase } from "../../src/database.js";
import { Limiter, RateLimitError } from "../../src/limiter.js";

const dbPath = process.argv[2];
const key = process.argv[3] ?? "shared";
const attempts = Number(process.argv[4] ?? 100);
const estimated = Number(process.argv[5] ?? 1000);

if (dbPath === undefined) {
  throw new Error("db path is required");
}

const db = openDatabase(dbPath);
const limiter = new Limiter({ db });
let accepted = 0;
let acceptedTokens = 0;

for (let index = 0; index < attempts; index += 1) {
  try {
    limiter.reserve(key, estimated);
    accepted += 1;
    acceptedTokens += estimated;
  } catch (error) {
    if (!(error instanceof RateLimitError)) {
      throw error;
    }
  }
}

db.close();
process.stdout.write(JSON.stringify({ accepted, acceptedTokens }));