import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";

export type MockRequest = {
  method: string;
  url: string;
  body: string;
};

export type MockUpstreamOptions = {
  status?: number;
  body?: unknown;
  rawBody?: string;
  delayMs?: number;
  contentType?: string;
};

export type MockUpstream = {
  server: Server;
  requests: MockRequest[];
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createMockUpstream(
  options: MockUpstreamOptions = {}
): MockUpstream {
  const status = options.status ?? 200;
  const delayMs = options.delayMs ?? 0;
  const contentType = options.contentType ?? "application/json";
  const rawBody =
    options.rawBody ?? JSON.stringify(options.body ?? { ok: true });
  const requests: MockRequest[] = [];

  const server = createServer(async (req, res) => {
    let body = "";

    for await (const chunk of req) {
      body += chunk.toString();
    }

    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      body,
    });

    if (delayMs > 0) {
      await wait(delayMs);
    }

    if (res.destroyed) {
      return;
    }

    res.writeHead(status, { "content-type": contentType });
    res.end(rawBody);
  });

  return { server, requests };
}

const entrypoint = process.argv[1];

if (
  entrypoint !== undefined &&
  pathToFileURL(entrypoint).href === import.meta.url
) {
  const port = Number(process.env.MOCK_PORT ?? 4010);
  const status = Number(process.env.MOCK_STATUS ?? 200);
  const delayMs = Number(process.env.MOCK_DELAY_MS ?? 0);
  const rawBody = process.env.MOCK_BODY ?? JSON.stringify({ ok: true });

  const { server } = createMockUpstream({ status, rawBody, delayMs });

  server.listen(port, () => {
    console.log(`Mock upstream listening on port ${port}`);
  });
}