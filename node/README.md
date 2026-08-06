# Codex Pooler — Node.js

A deliberately small local dashboard for:

- adding, editing, and deleting Codex or Compass upstreams (provider URLs are fixed server-side);
- reading the provider's current quota window (monthly when the provider reports one); AISwitch/CQP accounts are marked `aiswitch` because their quota requires a separate Compass SSO session;
- setting individual or bulk spending caps in dollars;
- exposing spending-cap state and eligibility;
- observing normal/reached cap status and continuation eligibility;
- proxying the core Responses, Chat Completions, and Compass Anthropic Messages APIs.

This is the primary implementation for new development. It is a small single-process proxy with scoped API keys and the core HTTP/WebSocket compatibility layer. The Elixir application is retained unchanged from upstream as a reference, not as a second maintained implementation. Codex access tokens are refreshed lazily before quota and proxy requests, and proactively once per hour when they expire within 12 hours.

## Proxy compatibility status

The Node proxy covers the client-visible local compatibility path:

| Area | Implemented contract | Regression coverage |
| --- | --- | --- |
| Requests and headers | Responses aliases, reasoning/service-tier normalization, Codex and Anthropic header allowlists, model ETags, unsupported-route envelopes | `test/proxy.test.js`, `test/gateway-routes.test.js` |
| OpenAI adapters | Responses and Chat message/content/tool conversion, multimodal input, continuation/replay validation, non-stream Chat output and finish reasons | `test/openai-adapters.test.js`, `test/proxy.test.js` |
| HTTP ingress and errors | Bounded JSON/compressed bodies, gzip/deflate/zstd, timeouts, OpenAI-shaped errors, provider-detail redaction, valid Anthropic 4xx passthrough | `test/http-ingress.test.js`, `test/gateway-routes.test.js` |
| Pricing and settlement | OpenAI/Anthropic JSON and streaming usage, cache fields, dated model suffix pricing, authoritative `price_cost_usd`, idempotent replacement deltas | `test/pricing.test.js`, `test/domain.test.js`, `test/proxy.test.js` |
| Routing | Ordered spend-cap-eligible candidates, explicit/session pins, response-continuation pins with the 125% allowance, safe pre-output HTTP failover, durable model/route circuit cooldown and half-open recovery | `test/routing.test.js`, `test/proxy.test.js`, `test/store.test.js` |
| SSE | Incremental UTF-8/SSE parsing, bounded incomplete events, first-event failover, public Responses sequencing, Chat translation, terminal sanitization, cancellation and usage settlement | `test/proxy.test.js` |
| Responses WebSocket | Public `response.create` normalization, per-turn routing/session pinning, sequential multi-turn reuse, bounded frames/pending output, pre-output reconnect, sanitized terminals and terminal usage settlement | `test/gateway-routes.test.js` |

### Intentional limitations

- The server is single-process. It does not implement distributed WebSocket owners, leases, takeover, remote forwarding, or cross-process in-flight continuity.
- There are no Pools, assignments, provider-quota routing, or bulkheads. Routing uses spending caps, explicit/session pins, model policy, and circuit state.
- Public Responses WebSocket turns queue in-process while an active turn terminates. A process restart loses queued and in-flight socket state.
- Credential preparation and refresh failures stay on the selected account instead of crossing accounts. Failover is allowed only after a refresh succeeds but that same account is still rejected, and only when the request is not explicitly or session pinned.
- Pricing is a small static snapshot, not the Elixir catalog/database sync. Unknown or ambiguous models remain unpriced unless the provider reports `price_cost_usd`.
- Only the routes listed below are supported. Other OpenAI endpoints return the deterministic `unsupported_endpoint` envelope rather than attempting partial compatibility.
- The encrypted local JSON store is suitable for one local process, not concurrent replicas or production high-availability storage.

## Run

Node 20+ is enough.

```bash
cd node
npm install
npm start
# open http://localhost:3000
```

`npm start` loads `node/.env`. Use `npm run dev` for Node's watch mode. Set one client key in `CODEX_POOLER_API_KEY`; startup fails without it. Proxy routes require `Authorization: Bearer ...`, except `POST /v1/messages`, which also accepts `x-api-key`.

By default, the server binds `127.0.0.1` and accepts only localhost Host headers. For a reverse proxy deployment, set `CODEX_POOLER_BIND_HOST` and `CODEX_POOLER_ALLOWED_HOSTS` (comma-separated). Optional `CODEX_POOLER_ALLOWED_ORIGINS`, `CODEX_POOLER_TRUSTED_PROXIES`, and `CODEX_POOLER_FIREWALL_ALLOWLIST` configure browser origins, trusted forwarding peers, and runtime CIDR/IP admission. External `/api/*` administration requests require the Bearer key; localhost administration remains dashboard-compatible.

Compass requests use HTTPS. Compass quota reads use the deployment-wide `CODEX_POOLER_COMPASS_GATEWAY_TOKEN`. Codex quota reads use the access token imported from `auth.json`; when it is expired or rejected, the server refreshes it through `https://auth.openai.com/oauth/token` using OpenAI's Codex client ID and persists rotated tokens. Independently, it checks refreshable Codex tokens at startup and hourly, refreshing those that expire within 12 hours. Transient refresh failures retry with bounded exponential backoff (eight total attempts), then re-enter recovery after six hours; missing or revoked refresh tokens require reauthentication. The dashboard also offers a manual Codex token refresh. The server refreshes all upstream quotas immediately and every minute.

Data is stored in `.data/`. Credential fields are encrypted with a local `.data/.key` and are never returned by the API or rendered in the browser. `db.json` keeps configuration, spending state, 90 days of compact daily usage counters, and at most 100 terminal failure diagnostics; successful request histories are not stored. Back up both files together if you need to move the data; startup refuses to create a replacement key for an existing database. Set `CODEX_POOLER_NODE_DATA_DIR` to choose another data directory.

Spending caps use 25 credits per dollar. A cap update starts a new cap period and resets spend. Proxy requests require a positive cap: accounts remain eligible until they reach 100%, and a `previous_response_id` continuation stays pinned to its original account below 125%. Valid provider-reported `usage.price_cost_usd` is authoritative; otherwise supported Codex and Anthropic token usage is priced from the local snapshot, which applies OpenAI's long-context rates above 272,000 input tokens. The usage endpoint remains available for other integrations.

## API

```text
GET    /api/upstreams
GET    /api/upstreams/events             # SSE: ready + upstream-change notifications
POST   /api/upstreams
PATCH  /api/upstreams/:id
DELETE /api/upstreams/:id
POST   /api/upstreams/:id/refresh-quota
POST   /api/upstreams/:id/refresh-token
PUT    /api/upstreams/:id/cap       { "capDollars": 100 }
POST   /api/upstreams/:id/usage     { "attemptId": "...", "startedAt": "...", "settledCostMicros": 40000, "costSource": "upstream_reported" }
                                 or { "costUsd": 1 } instead of settledCostMicros
GET    /api/upstreams/:id/spending
GET    /api/upstreams/eligibility?continuationId=...
POST   /api/spending-caps/bulk

# Model proxy
POST   /v1/responses
GET    /v1/responses                # WebSocket upgrade
POST   /v1/chat/completions
POST   /v1/messages                 # Compass only
POST   /v1/responses/compact        # deterministic unsupported_endpoint, matching origin
GET    /v1/models
GET    /v1/files
POST   /v1/files
GET    /v1/files/:id
DELETE /v1/files/:id               # deterministic unsupported_endpoint
GET    /v1/files/:id/content        # deterministic unsupported_endpoint
POST   /v1/audio/transcriptions
POST   /v1/images/generations
POST   /v1/images/edits

# Codex-compatible aliases
POST   /backend-api/codex/responses
GET    /backend-api/codex/responses # WebSocket upgrade
POST   /backend-api/codex/v1/responses
POST   /backend-api/codex/v1/chat/completions
POST   /backend-api/codex/responses/compact
GET    /backend-api/codex/models
POST   /backend-api/transcribe
POST   /backend-api/files
POST   /backend-api/files/:id/uploaded
POST   /backend-api/codex/images/generations
POST   /backend-api/codex/images/edits
```

The dashboard's bulk-cap dialog starts with the original quota presets: quota left above $1,000/$500/$200/$100/$50/$0 maps to caps of $100/$50/$20/$10/$5/$0. Rules are editable, and one-cap targets remain available.

Create a Codex upstream with `{ "type": "codex", "authJson": "..." }`, or a Compass upstream with `{ "type": "compass", "projectId": "...", "projectKey": "...", "quotaSource": "compass|aiswitch" }`. Use `quotaSource: "aiswitch"` for CQP accounts whose quota is managed in AISwitch; they remain routable based on their spending cap without a gateway quota refresh. Names are derived server-side: masked JWT email for Codex and project ID for Compass. Bulk caps accept either `{ "target": "all|cap_reached|uncapped", "capDollars": 100 }` or quota rules such as `{ "rules": [{ "minQuotaLeft": 1000, "capDollars": 100 }] }`. Bulk updates are sequential, not atomic.

Proxy routing prefers Codex, prefers Compass for `claude-*` models, and routes `/v1/messages` to Compass. Use `x-upstream-type: codex|compass` or `x-upstream-id` to select explicitly. `x-codex-session-id` is an API-key-isolated soft upstream preference and falls back safely when unavailable. Codex Chat Completions are translated to Responses upstream and converted back, while Compass requests are sent directly to `/chat/completions`, `/responses`, or `/messages`.

Public file creation performs the Codex create → upload → finalize protocol and stores only file metadata locally; file content and signed URLs are not persisted. Audio requests normalize OpenAI multipart fields for Codex transcription. Public image requests translate through the Responses image-generation tool and automatically select an image-capable Codex host model. The proxy binds to `127.0.0.1`. The API key is a single shared key, not a Pool or per-user key system.

## Check

```bash
npm test
```
