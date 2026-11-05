# Task 4: Rate Limiter and Fallback Router

A single-process HTTP router that reserves a per-key token budget in SQLite,
calls a primary upstream, and fails over to a secondary upstream when the
primary is rate limited, times out, has a network error, or returns 5xx.

## Flow

```
POST /v1/chat/completions   Authorization: Bearer <key>
              |
              v
       +--------------+
       |   index.ts   |  request_id, auth, JSON, X-Request-Id
       +--------------+
              |
              v
       +--------------+
       |  limiter.ts  |  reserve(): DELETE >60s, SUM, reject or INSERT
       |   .immediate |  usage(id, key_hash, ts_ms, tokens, status)
       +--------------+
              |
              v
       +--------------+
       |  router.ts   |  primary (3s) --> failover? --> secondary (3s)
       | settled flag |  first terminal outcome wins, late reply ignored
       +--------------+
              |
       +------+--------+
       |               |
   settle(id)      release(id) / keep on timeout
       |               |
       +-----> usage.sqlite
              |
              v
     JSON logs on stderr, fixed error JSON to client
```

## Run

```sh
npm start
```

| Variable | Default |
| --- | --- |
| `PORT` | `3020` |
| `DB_PATH` | `task4-router.sqlite` |
| `PRIMARY_URL` | `http://localhost:4010/v1/chat/completions` |
| `SECONDARY_URL` | `http://localhost:4011/v1/chat/completions` |
| `PRIMARY_TIMEOUT_MS` | `3000` |
| `SECONDARY_TIMEOUT_MS` | `3000` |
| `PRIMARY_API_KEY` / `SECONDARY_API_KEY` | unset |
| `PRIMARY_MODEL` / `SECONDARY_MODEL` | `gpt-4o-mini` |

`npm run start:mock` starts one mock upstream (`MOCK_PORT`, `MOCK_STATUS`,
`MOCK_BODY`, `MOCK_DELAY_MS`).

```sh
npm test
npm run lint
npm run demo
```

## Request and response

The body accepts `prompt` (string) or OpenAI-style `messages`. `max_tokens`
defaults to `1024`.

```json
{ "prompt": "hello", "max_tokens": 100 }
```

A successful call returns `200`:

```json
{
  "text": "hello from the secondary",
  "upstream": "secondary",
  "usage": { "total_tokens": 102 },
  "request_id": "..."
}
```

## Token budget

Each key is SHA-256 hashed. The budget is 50,000 estimated tokens per rolling
60-second window. `reserve(key, est)` runs inside a `transaction.immediate()`
write lock:

1. Delete this key's rows with `ts_ms` at or before `now - 60_000`.
2. Sum the remaining `tokens`.
3. Reject when `sum + est > 50_000`, returning `retry_after` and a
   `Retry-After` header.
4. Otherwise insert a `reserved` row.

An estimate larger than 50,000 can never fit, so it returns `400
invalid_request` without touching the database.

`estimateTokens(text, maxTokens)` is `ceil(text.length / 4) + maxTokens`,
isolated in one function so a real tokenizer can replace it.

A background timer (unref'd) deletes all rows older than 60 seconds.

## Reservation lifecycle

| Outcome | Action |
| --- | --- |
| Provider returns usage | `settle(id, actual)` stores the real count |
| Provider returns no usage | `settle(id, null)` keeps the estimate |
| Any non-timeout failure | `release(id)` deletes the row |
| Any attempt timed out | Keep the row charged until it ages out |

A timed-out request is left charged on purpose: the upstream may still have
processed it, so the outcome is unknown. It ages out within 60 seconds, so no
extra expiry code is needed.

## Failover

The primary is wrapped in `AbortSignal.timeout(3000)`. Failover happens on
`429`, timeout, network error, and `5xx`. The primary is aborted when failover
starts, and a settled flag makes the first terminal outcome win, so a late
primary response is ignored. The secondary has its own timeout.

Other `4xx` responses do not fail over. `400` and `422` map to
`invalid_request`; the remaining failures map to `upstream_unavailable`.

## Errors

Every error has one shape:

```json
{ "error": { "code": "rate_limited", "message": "Rate limit exceeded", "request_id": "..." } }
```

| Code | Status | Fixed message |
| --- | --- | --- |
| `unauthorized` | 401 | `Unauthorized` |
| `invalid_request` | 400 | `Invalid request` |
| `rate_limited` | 429 | `Rate limit exceeded` |
| `upstream_unavailable` | 503 | `Upstream service unavailable` |
| `internal_error` | 500 | `Internal server error` |

Responses carry `X-Request-Id`. Real error detail, including stacks and
upstream bodies, goes only to stderr as structured JSON keyed by
`request_id`; upstream bodies are never echoed to clients.

## Demo

`demo.sh` starts a failing primary (with a fake stack and secret), a healthy
secondary, and the router. Expected output shape:

```
== failover to secondary ==
HTTP/1.1 200 OK
x-request-id: <request-id>
{"text":"hello from the secondary","upstream":"secondary","usage":{"total_tokens":102},"request_id":"<request-id>"}

== first large reservation ==
HTTP/1.1 200 OK
x-request-id: <request-id>
{"text":"hello from the secondary","upstream":"secondary","usage":{"total_tokens":30002},"request_id":"<request-id>"}

== second large reservation (rate limited) ==
HTTP/1.1 429 Too Many Requests
retry-after: 60
{"error":{"code":"rate_limited","message":"Rate limit exceeded","request_id":"<request-id>"}}
```

The fake stack and `sk-live-DEMO` secret never appear in a response.

## Design decisions and known limits

- Tokens are estimated as `chars / 4 + max_tokens`. This is approximate; a real
  tokenizer can replace `estimateTokens` without touching the limiter.
- State lives in one SQLite file on one host. WAL plus `busy_timeout = 5000`
  plus `transaction.immediate()` makes it safe across processes on that host,
  but it is not a distributed limiter.
- A timed-out request remains charged because its outcome is unknown.
- Only `POST /v1/chat/completions` is implemented.
- Failover on 429, network errors, and 5xx is an intentional extension beyond
  the minimum 429-only requirement.