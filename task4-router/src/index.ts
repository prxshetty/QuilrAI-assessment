import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { AppError, errorBody, type ErrorCode } from "./errors.js";
import { openDatabase } from "./database.js";
import {
  EstimateTooLargeError,
  Limiter,
  RateLimitError,
  estimateTokens,
} from "./limiter.js";
import { createHttpProvider } from "./providers.js";
import { DEFAULT_TIMEOUT_MS, Router, type LogFn } from "./router.js";

const chatCompletionsPath = "/v1/chat/completions";
const bearerPattern = /^Bearer (\S+)$/;
const defaultMaxTokens = 1024;

export type RouterServerOptions = {
  limiter: Limiter;
  router: Router;
  defaultMaxTokens?: number;
  log?: LogFn;
};

export const writeLog: LogFn = (entry) => {
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`
  );
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

function apiKey(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }

  const match = bearerPattern.exec(header);

  return match?.[1] ?? null;
}

function promptFrom(body: Record<string, unknown>): string | null {
  if (typeof body.prompt === "string" && body.prompt.length > 0) {
    return body.prompt;
  }

  const messages = body.messages;

  if (!Array.isArray(messages)) {
    return null;
  }

  const parts: string[] = [];

  for (const message of messages) {
    if (!isRecord(message) || typeof message.content !== "string") {
      continue;
    }

    parts.push(message.content);
  }

  const prompt = parts.join("\n");

  return prompt.length > 0 ? prompt : null;
}

function maxTokensFrom(body: Record<string, unknown>, fallback: number): number | null {
  const value = body.max_tokens;

  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }

  return value;
}

function sendError(
  res: ServerResponse,
  status: number,
  code: ErrorCode,
  requestId: string,
  retryAfterSeconds?: number
): void {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-request-id": requestId,
  };

  if (retryAfterSeconds !== undefined) {
    headers["retry-after"] = String(retryAfterSeconds);
  }

  res.writeHead(status, headers);
  res.end(JSON.stringify(errorBody(code, requestId)));
}

export function createRouterServer(options: RouterServerOptions): Server {
  const log = options.log ?? writeLog;
  const fallbackMaxTokens = options.defaultMaxTokens ?? defaultMaxTokens;
  const { limiter, router } = options;

  return createServer(async (req, res) => {
    const requestId = randomUUID();
    const path = (req.url ?? "").split("?")[0];

    res.setHeader("x-request-id", requestId);
    log({
      level: "info",
      event: "request.start",
      request_id: requestId,
      method: req.method,
      path,
    });

    if (req.method !== "POST" || path !== chatCompletionsPath) {
      sendError(res, 404, "invalid_request", requestId);
      return;
    }

    const key = apiKey(req.headers.authorization);

    if (key === null) {
      log({
        level: "warn",
        event: "request.unauthorized",
        request_id: requestId,
      });
      sendError(res, 401, "unauthorized", requestId);
      return;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(await readRequestBody(req));
    } catch {
      sendError(res, 400, "invalid_request", requestId);
      return;
    }

    if (!isRecord(parsed)) {
      sendError(res, 400, "invalid_request", requestId);
      return;
    }

    const prompt = promptFrom(parsed);
    const maxTokens = maxTokensFrom(parsed, fallbackMaxTokens);

    if (prompt === null || maxTokens === null) {
      sendError(res, 400, "invalid_request", requestId);
      return;
    }

    const estimated = estimateTokens(prompt, maxTokens);

    let reservation: { id: string; estimated: number };

    try {
      reservation = limiter.reserve(key, estimated);
    } catch (error) {
      if (error instanceof RateLimitError) {
        log({
          level: "warn",
          event: "request.rate_limited",
          request_id: requestId,
          retry_after_s: error.retryAfterSeconds,
        });
        sendError(
          res,
          429,
          "rate_limited",
          requestId,
          error.retryAfterSeconds
        );
        return;
      }

      if (error instanceof EstimateTooLargeError) {
        sendError(res, 400, "invalid_request", requestId);
        return;
      }

      log({
        level: "error",
        event: "request.internal_error",
        request_id: requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      sendError(res, 500, "internal_error", requestId);
      return;
    }

    try {
      const result = await router.route({
        prompt,
        maxTokens,
        requestId,
      });

      limiter.settle(reservation.id, result.totalTokens);
      const totalTokens = result.totalTokens ?? reservation.estimated;

      log({
        level: "info",
        event: "request.settled",
        request_id: requestId,
        upstream: result.upstream,
        estimated: reservation.estimated,
        total_tokens: totalTokens,
      });

      res.writeHead(200, {
        "content-type": "application/json",
        "x-request-id": requestId,
      });
      res.end(
        JSON.stringify({
          text: result.text,
          upstream: result.upstream,
          usage: { total_tokens: totalTokens },
          request_id: requestId,
        })
      );
    } catch (error) {
      const appError =
        error instanceof AppError
          ? error
          : new AppError("internal_error", { cause: error });

      if (!appError.timedOut) {
        limiter.release(reservation.id);
      }

      log({
        level: appError.status >= 500 ? "error" : "warn",
        event: "request.failed",
        request_id: requestId,
        code: appError.code,
        timed_out: appError.timedOut,
        released: !appError.timedOut,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      sendError(
        res,
        appError.status,
        appError.code,
        requestId,
        appError.retryAfterSeconds ?? undefined
      );
    }
  });
}

const entrypoint = process.argv[1];

if (
  entrypoint !== undefined &&
  pathToFileURL(entrypoint).href === import.meta.url
) {
  const port = Number(process.env.PORT ?? 3020);
  const dbPath = process.env.DB_PATH ?? "task4-router.sqlite";
  const primaryUrl =
    process.env.PRIMARY_URL ?? "http://localhost:4010/v1/chat/completions";
  const secondaryUrl =
    process.env.SECONDARY_URL ?? "http://localhost:4011/v1/chat/completions";

  const db = openDatabase(dbPath);
  const limiter = new Limiter({ db });
  limiter.startPurgeTimer();

  const router = new Router({
    primary: createHttpProvider({
      name: "primary",
      url: primaryUrl,
      model: process.env.PRIMARY_MODEL,
      apiKey: process.env.PRIMARY_API_KEY,
    }),
    secondary: createHttpProvider({
      name: "secondary",
      url: secondaryUrl,
      model: process.env.SECONDARY_MODEL,
      apiKey: process.env.SECONDARY_API_KEY,
    }),
    primaryTimeoutMs: Number(
      process.env.PRIMARY_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS
    ),
    secondaryTimeoutMs: Number(
      process.env.SECONDARY_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS
    ),
    log: writeLog,
  });

  const server = createRouterServer({ limiter, router, log: writeLog });

  const shutdown = (): void => {
    limiter.stopPurgeTimer();
    server.close(() => {
      db.close();
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  server.listen(port, () => {
    console.log(`Router listening on port ${port}`);
  });
}