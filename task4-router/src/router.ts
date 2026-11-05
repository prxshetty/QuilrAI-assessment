import { AppError } from "./errors.js";
import type {
  Provider,
  ProviderFailure,
  ProviderResult,
} from "./providers.js";

export const DEFAULT_TIMEOUT_MS = 3000;

export type LogFn = (entry: Record<string, unknown>) => void;

export type RouteInput = {
  prompt: string;
  maxTokens: number;
  requestId?: string | undefined;
};

export type RouteSuccess = {
  text: string;
  upstream: "primary" | "secondary";
  totalTokens: number | null;
};

export type RouterOptions = {
  primary: Provider;
  secondary: Provider;
  primaryTimeoutMs?: number;
  secondaryTimeoutMs?: number;
  log?: LogFn;
};

function shouldFailover(failure: ProviderFailure): boolean {
  if (failure.kind === "timeout" || failure.kind === "network") {
    return true;
  }

  return failure.status === 429 || (failure.status ?? 0) >= 500;
}

function describeFailure(failure: ProviderFailure): string {
  return failure.status === undefined
    ? failure.kind
    : `${failure.kind}:${failure.status}`;
}

function toAppError(failure: ProviderFailure, timedOut: boolean): AppError {
  if (
    failure.kind === "http" &&
    (failure.status === 400 || failure.status === 422)
  ) {
    return new AppError("invalid_request", { timedOut });
  }

  return new AppError("upstream_unavailable", { timedOut });
}

export class Router {
  private readonly primary: Provider;
  private readonly secondary: Provider;
  private readonly primaryTimeoutMs: number;
  private readonly secondaryTimeoutMs: number;
  private readonly log: LogFn | undefined;

  constructor(options: RouterOptions) {
    this.primary = options.primary;
    this.secondary = options.secondary;
    this.primaryTimeoutMs = options.primaryTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.secondaryTimeoutMs = options.secondaryTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = options.log;
  }

  async route(input: RouteInput): Promise<RouteSuccess> {
    const primaryController = new AbortController();
    let sawTimeout = false;

    const primary = await this.attempt(
      this.primary,
      input,
      this.primaryTimeoutMs,
      primaryController.signal
    );

    if (primary.ok) {
      return {
        text: primary.text,
        upstream: "primary",
        totalTokens: primary.totalTokens,
      };
    }

    if (primary.kind === "timeout") {
      sawTimeout = true;
    }

    if (!shouldFailover(primary)) {
      throw toAppError(primary, sawTimeout);
    }

    primaryController.abort();
    this.log?.({
      level: "warn",
      event: "router.failover",
      request_id: input.requestId,
      from: this.primary.name,
      to: this.secondary.name,
      reason: describeFailure(primary),
    });

    const secondary = await this.attempt(
      this.secondary,
      input,
      this.secondaryTimeoutMs
    );

    if (secondary.ok) {
      return {
        text: secondary.text,
        upstream: "secondary",
        totalTokens: secondary.totalTokens,
      };
    }

    if (secondary.kind === "timeout") {
      sawTimeout = true;
    }

    throw toAppError(secondary, sawTimeout);
  }

  private attempt(
    provider: Provider,
    input: RouteInput,
    timeoutMs: number,
    externalSignal?: AbortSignal
  ): Promise<ProviderResult> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal =
      externalSignal === undefined
        ? timeoutSignal
        : AbortSignal.any([timeoutSignal, externalSignal]);

    const providerResult = provider
      .complete({
        prompt: input.prompt,
        maxTokens: input.maxTokens,
        signal,
      })
      .catch((): ProviderResult => ({ ok: false, kind: "network" }));

    return new Promise<ProviderResult>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const finish = (result: ProviderResult): void => {
        if (settled) {
          return;
        }

        settled = true;

        if (timer !== undefined) {
          clearTimeout(timer);
        }

        resolve(result);
      };

      timer = setTimeout(
        () => finish({ ok: false, kind: "timeout" }),
        timeoutMs
      );

      timeoutSignal.addEventListener(
        "abort",
        () => finish({ ok: false, kind: "timeout" }),
        { once: true }
      );

      providerResult.then(finish);
    });
  }
}