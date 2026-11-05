export type ProviderFailureKind = "timeout" | "network" | "http";

export type ProviderSuccess = {
  ok: true;
  text: string;
  totalTokens: number | null;
};

export type ProviderFailure = {
  ok: false;
  kind: ProviderFailureKind;
  status?: number;
};

export type ProviderResult = ProviderSuccess | ProviderFailure;

export type ProviderRequest = {
  prompt: string;
  maxTokens: number;
  signal: AbortSignal;
};

export type Provider = {
  name: string;
  complete(request: ProviderRequest): Promise<ProviderResult>;
};

export type HttpProviderOptions = {
  name: string;
  url: string;
  model?: string | undefined;
  apiKey?: string | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function extractText(payload: unknown): string {
  if (!isRecord(payload)) {
    return "";
  }

  const choices = payload.choices;

  if (Array.isArray(choices) && choices.length > 0) {
    const choice = choices[0];

    if (isRecord(choice)) {
      const message = choice.message;

      if (isRecord(message) && typeof message.content === "string") {
        return message.content;
      }

      if (typeof choice.text === "string") {
        return choice.text;
      }
    }
  }

  if (typeof payload.content === "string") {
    return payload.content;
  }

  if (typeof payload.text === "string") {
    return payload.text;
  }

  return "";
}

function extractTotalTokens(payload: unknown): number | null {
  if (!isRecord(payload) || !isRecord(payload.usage)) {
    return null;
  }

  const total = payload.usage.total_tokens;

  return typeof total === "number" && Number.isFinite(total) ? total : null;
}

export function createHttpProvider(options: HttpProviderOptions): Provider {
  return {
    name: options.name,
    async complete(request: ProviderRequest): Promise<ProviderResult> {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };

      if (options.apiKey !== undefined) {
        headers.authorization = `Bearer ${options.apiKey}`;
      }

      let response: Response;

      try {
        response = await fetch(options.url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: options.model ?? "gpt-4o-mini",
            messages: [{ role: "user", content: request.prompt }],
            max_tokens: request.maxTokens,
          }),
          signal: request.signal,
        });
      } catch (error) {
        if (isAbort(error)) {
          return { ok: false, kind: "timeout" };
        }

        return { ok: false, kind: "network" };
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);

        return { ok: false, kind: "http", status: response.status };
      }

      let payload: unknown;

      try {
        payload = await response.json();
      } catch {
        return { ok: false, kind: "network" };
      }

      return {
        ok: true,
        text: extractText(payload),
        totalTokens: extractTotalTokens(payload),
      };
    },
  };
}