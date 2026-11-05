export type ErrorCode =
  | "unauthorized"
  | "invalid_request"
  | "rate_limited"
  | "upstream_unavailable"
  | "internal_error";

export const statusByCode: Record<ErrorCode, number> = {
  unauthorized: 401,
  invalid_request: 400,
  rate_limited: 429,
  upstream_unavailable: 503,
  internal_error: 500,
};

export const messageByCode: Record<ErrorCode, string> = {
  unauthorized: "Unauthorized",
  invalid_request: "Invalid request",
  rate_limited: "Rate limit exceeded",
  upstream_unavailable: "Upstream service unavailable",
  internal_error: "Internal server error",
};

export type ErrorBody = {
  error: {
    code: ErrorCode;
    message: string;
    request_id: string;
  };
};

export function errorBody(code: ErrorCode, requestId: string): ErrorBody {
  return {
    error: {
      code,
      message: messageByCode[code],
      request_id: requestId,
    },
  };
}

export type AppErrorOptions = {
  timedOut?: boolean;
  retryAfterMs?: number;
  cause?: unknown;
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly timedOut: boolean;
  readonly retryAfterMs: number | null;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(messageByCode[code], { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = statusByCode[code];
    this.timedOut = options.timedOut ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }

  get retryAfterSeconds(): number | null {
    if (this.retryAfterMs === null) {
      return null;
    }

    return Math.max(1, Math.ceil(this.retryAfterMs / 1000));
  }
}