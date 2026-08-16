# Relaydeck — Node.js

Relaydeck is a deliberately small local dashboard for:

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
| Requests and headers | Responses aliases, reasoning/service-tier normalization, configurable and native-client Codex version/beta negotiation, Anthropic header defaults/forwarding, dynamic Codex model discovery, native Codex response-control projection, model ETags, unsupported-route envelopes | `test/proxy.test.js`, `test/gateway-routes.test.js`, `test/codex-model-catalog.test.js`, `test/native-payload.test.js` |
| OpenAI adapters | Forward-compatible Responses fields and enum/tool variants, Responses and Chat message/content/tool conversion, Chat custom tools, multimodal input, continuation/replay validation including URL citations, non-stream Chat output and finish reasons | `test/openai-adapters.test.js`, `test/proxy.test.js` |
| HTTP ingress and errors | Bounded JSON/compressed bodies, gzip/deflate/zstd, timeouts, OpenAI-shaped errors, provider-detail redaction, valid Anthropic 4xx passthrough | `test/http-ingress.test.js`, `test/gateway-routes.test.js` |
| Pricing and settlement | OpenAI/Anthropic JSON and streaming usage, cache fields, dated model suffix pricing, authoritative `price_cost_usd`, idempotent replacement deltas | `test/pricing.test.js`, `test/domain.test.js`, `test/proxy.test.js` |
| Routing | Ordered spend-cap-eligible candidates, per-account discovered Codex model support, an optional operator-managed priority list ahead of least-recent-success balancing, explicit/session pins, response-continuation pins with the 125% allowance, safe pre-output failover, immediate account cooldown for quota responses, reauthentication blocking, shared Codex-origin reachability protection, and durable model/route circuit recovery | `test/routing.test.js`, `test/proxy.test.js`, `test/gateway-routes.test.js`, `test/codex-model-catalog.test.js`, `test/codex-host-health.test.js`, `test/upstream-outcomes.test.js`, `test/store.test.js` |
| Pacing | Optional per-account and per-model minimum start intervals, bounded abort-aware queues, local `429`/`Retry-After`, and sanitized runtime diagnostics | `test/upstream-pacer.test.js`, `test/proxy.test.js`, `test/gateway-routes.test.js`, `test/server.test.js` |
| Readiness and diagnostics | Immediate liveness, startup-settled readiness with documented degradation, bounded sanitized terminal failure reasons, and phase timing summaries | `test/readiness.test.js`, `test/gateway-diagnostics.test.js`, `test/server.test.js`, `test/accounting-lifecycle.test.js` |
| SSE | Incremental UTF-8/SSE parsing, bounded incomplete events, first-event failover, public Responses sequencing, Chat translation, terminal sanitization, cancellation and usage settlement | `test/proxy.test.js` |
| Responses WebSocket | Public `response.create` normalization, `generate: false` warmups, validated per-turn `stream_id` echo, public compaction bridging, per-turn routing/session pinning, sequential multi-turn reuse, bounded frames/pending output, pre-output reconnect, sanitized terminals and terminal usage settlement | `test/gateway-routes.test.js` |

### Intentional limitations

- The server is single-process. It does not implement distributed WebSocket owners, leases, takeover, remote forwarding, or cross-process in-flight continuity.
- There are no Pools, assignments, provider-quota routing, or bulkheads. Routing uses spending caps, explicit/session pins, model policy, and circuit state.
- Public Responses WebSocket turns queue in-process while an active turn terminates. A process restart loses queued and in-flight socket state.
- Credential preparation and refresh failures stay on the selected account instead of crossing accounts. Failover is allowed only after a refresh succeeds but that same account is still rejected, and only when the request is not explicitly or session pinned.
- Pricing is a small generated snapshot, not the Elixir catalog/database sync. Refresh it explicitly with `npm run pricing:refresh`; unknown or ambiguous models remain unpriced unless the provider reports `price_cost_usd`. Settlements are deduplicated per attempt across the 100 most recent settlements; a replay older than that window is counted again.
- Compatibility learning is deliberately narrow. A provider may teach the proxy that one allowlisted optional Codex field is rejected, that a Compass Messages model requires adaptive thinking, or that it rejects one of the optional sampling controls `temperature`, `top_p`, or `top_k`. Those per-upstream/model/protocol facts expire after 24 hours, are revalidated before use, and never suppress arbitrary fields even if persisted state is malformed.
- Only the routes listed below are supported. Other OpenAI endpoints return the deterministic `unsupported_endpoint` envelope rather than attempting partial compatibility. `POST /v1/messages/count_tokens` is intentionally unsupported: Compass does not serve it and no local Claude tokenizer exists, so clients fall back to their own estimation.
- The encrypted local SQLite store is suitable for one local process, not concurrent replicas or production high-availability storage.

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

Native Codex HTTP/WebSocket routes forward validated client `version`, `originator`, and `openai-beta` negotiation headers. Public OpenAI routes use the proxy defaults. Operators can override the fallback fingerprint with `CODEX_POOLER_CODEX_CLIENT_VERSION` and `CODEX_POOLER_CODEX_ORIGINATOR`, add HTTP beta tokens with `CODEX_POOLER_CODEX_HTTP_BETA`, or replace the required WebSocket beta token with `CODEX_POOLER_CODEX_WEBSOCKET_BETA`. Invalid or control-character-bearing values are ignored.

Shared Codex host health is enabled conservatively by default. Two proven pre-connect failures within 30 seconds open a 15-second circuit for the normalized Codex origin; requests receive a local retryable `503 codex_host_unavailable` with `Retry-After`, and one half-open probe is admitted after cooldown. Only `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ENETUNREACH`, `ENETDOWN`, and `EHOSTUNREACH` count. Timeouts, resets, broken pipes, TLS failures, HTTP responses, and authentication failures remain account-attributed, while any actual HTTP response clears host reachability evidence. Configure this with `CODEX_POOLER_CODEX_HOST_CIRCUIT_ENABLED`, `CODEX_POOLER_CODEX_HOST_FAILURE_THRESHOLD`, `CODEX_POOLER_CODEX_HOST_FAILURE_WINDOW_MS`, `CODEX_POOLER_CODEX_HOST_COOLDOWN_MS`, and `CODEX_POOLER_CODEX_HOST_MAX_ENTRIES`.

Compass requests use HTTPS. Compass quota reads use the deployment-wide `CODEX_POOLER_COMPASS_GATEWAY_TOKEN`. Codex quota reads use the access token imported from `auth.json`; when it is expired or rejected, the server refreshes it through `https://auth.openai.com/oauth/token` using OpenAI's Codex client ID and persists rotated tokens. Independently, it checks refreshable Codex tokens at startup and hourly, refreshing those that expire within 12 hours. Transient refresh failures retry with bounded exponential backoff (eight total attempts), then re-enter recovery after six hours; missing or revoked refresh tokens require reauthentication. The dashboard also offers a manual Codex token refresh. The server refreshes all upstream quotas immediately and every minute.

Data is stored in `.data/`. Credential fields are encrypted with a local `.data/.key` and are never returned by the API or rendered in the browser. `db.sqlite` keeps configuration, spending state, 90 days of compact daily usage counters, and at most 100 terminal failure diagnostics; successful request histories are not stored. Existing `db.json` files migrate automatically on startup. Back up `.data/.key` and `db.sqlite` together if you need to move the data; startup refuses to create a replacement key for an existing database. Set `CODEX_POOLER_NODE_DATA_DIR` to choose another data directory.

`GET /healthz` is immediate process liveness. Exact `GET /readyz` returns `200` only after local storage and API-key setup plus the initial token-recovery, quota-refresh, and model-discovery passes have settled. Provider/network failures degrade those startup checks without blocking readiness because requests can still recover credentials on demand, quota refresh continues in the background, and model discovery has the documented static fallback. Pending or failed readiness returns `503`, `Retry-After: 1`, and only the fixed `pending|ready|failed` state plus sanitized per-check states.

Spending caps use 25 credits per dollar, rounded to whole credits, and a positive cap is never rounded down to zero (which would read as no cap). A cap update starts a new cap period and resets spend. Proxy requests require a positive cap: accounts remain eligible until they reach 100%, and a `previous_response_id` continuation stays pinned to its original account below 125%. Valid provider-reported `usage.price_cost_usd` is authoritative, accepted only as a plain non-negative decimal; otherwise supported Codex and Anthropic token usage is priced from the local snapshot, which applies OpenAI's long-context rates above 272,000 input tokens. A known model with no snapshot for the requested service tier or context bucket bills at its standard default rates rather than going unpriced, and a provider `total_tokens` that disagrees with input plus output is reported as received without discarding the priced tokens. The usage endpoint remains available for other integrations.

## API

```text
GET    /api/upstreams
GET    /api/upstreams/events             # SSE: ready + upstream-change notifications
GET    /api/model-catalog                 # sanitized discovery source/freshness/failure status
GET    /api/codex-host-health             # sanitized aggregate shared-origin circuit status
GET    /api/pacing                       # sanitized per-account runtime queue/start status
GET    /api/diagnostics                  # readiness, memory-only successes, and bounded terminal failures
GET    /api/routing                       # persisted routing strategy
PUT    /api/routing                       { "strategy": "least-recent-success|most-remaining-quota" }
POST   /api/routing/dry-run               # sanitized live-planner candidate/exclusion diagnostics
POST   /api/upstreams
PATCH  /api/upstreams/:id
DELETE /api/upstreams/:id
POST   /api/upstreams/:id/refresh-quota
POST   /api/upstreams/:id/refresh-token
POST   /api/upstreams/:id/clear-cooldown
PUT    /api/upstreams/:id/cap       { "capDollars": 100 }
POST   /api/upstreams/:id/usage     { "attemptId": "...", "startedAt": "...", "settledCostMicros": 40000, "costSource": "upstream_reported" }
                                 or { "costUsd": 1 } instead of settledCostMicros
GET    /api/upstreams/:id/spending
GET    /api/upstreams/eligibility?continuationId=...
PUT    /api/upstreams/priority     { "ids": ["first", "second"] }   # ordered priority list; [] clears it
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

`GET /v1/models`, `GET /backend-api/codex/models`, and `GET /backend-api/codex/v1/models` aggregate the static catalog with model metadata discovered from every currently usable Codex account. Discovery uses the configured Codex protocol fingerprint and normal credential-refresh path, caches each account for five minutes, coalesces concurrent requests, suppresses repeated failures for 30 seconds, and retains the last-known-good catalog when refresh fails. Cold start, no-account, and all-account discovery failures continue serving the static catalog. Native routes preserve bounded, sanitized upstream metadata; `/v1/models` returns stable OpenAI-shaped rows.

Discovered capability is account-specific. Once an account has an authoritative catalog, a model absent from that catalog is not routed to that account; accounts without authoritative discovery remain eligible. Scope model policy, per-upstream model restrictions, spending caps, explicit pins, continuation affinity, and circuit state remain authoritative. Provider `model_not_found` failures create an immediate bounded negative capability and force that account's catalog to refresh on the next discovery attempt. Public image compatibility uses the selected account's catalog, prefers an explicitly image-capable host model, and skips the account when its metadata authoritatively rules image input out. `GET /api/model-catalog` exposes only sanitized source, freshness, model count, timestamps, and failure class.

Account health is settled consistently for public JSON/SSE, Chat adapters, native HTTP, public and native Responses WebSockets, and Codex file/audio/image helpers. One upstream `402` or `429` immediately removes the account from ordinary routing. A valid `Retry-After` is honored for up to 24 hours and relayed on terminal proxy failures; known quota-reset timestamps are capped to 15 minutes, and missing timing metadata uses a 60-second cooldown. Reset-derived cooldowns permit one generation-fenced early probe after five minutes, while explicit `Retry-After` cooldowns never probe early. A `401/403` that remains after the normal Codex refresh retry marks the account reauthentication-required. Caller `4xx`, redirects, downstream cancellation, and local credential-preparation failures do not penalize account health.

Codex HTTP, compatibility, model-discovery, compaction, and WebSocket handshakes also share bounded in-memory origin reachability state. Proven DNS or pre-connect failures settle the selected account neutrally, preventing one local-network or ChatGPT-origin outage from opening every account circuit. Generation-fenced leases prevent an old half-open request from clearing a newer outage, while a real HTTP response of any status immediately restores normal host admission. The state is process-local and stores no credentials, request bodies, response bodies, or hostnames in diagnostics.

Quota and reauthentication transitions clear ordinary session affinity so new work can route elsewhere, but committed response-continuation pins are retained and never silently moved. Credential replacement and generation-fenced attempt leases prevent stale in-flight success or failure from overwriting newer account state. Public upstream records expose only sanitized health fields. `POST /api/upstreams/:id/clear-cooldown` clears quota cooldown state without clearing reauthentication-required state or unrelated routing history.

Create a Codex upstream with `{ "type": "codex", "authJson": "..." }`, or a Compass upstream with `{ "type": "compass", "projectId": "...", "projectKey": "...", "quotaSource": "compass|aiswitch" }`. Use `quotaSource: "aiswitch"` for CQP accounts whose quota is managed in AISwitch; they remain routable based on their spending cap without a gateway quota refresh. Names are derived server-side: masked JWT email for Codex and project ID for Compass. Bulk caps accept either `{ "target": "all|cap_reached|uncapped", "capDollars": 100 }` or quota rules such as `{ "rules": [{ "minQuotaLeft": 1000, "capDollars": 100 }] }`. Bulk updates are sequential, not atomic.

Request pacing is disabled by default and configured per upstream through create or patch with `{ "pacing": { "enabled": true, "minStartIntervalMs": 1000, "modelIntervals": [{ "model": "gpt-5.6-sol", "minStartIntervalMs": 2000 }], "maxQueueDepth": 20, "maxQueueAgeMs": 30000 } }`. Account and matching model intervals both apply. Runtime queues are process-local and independent per account; queue overflow or expiration returns local `429` with `Retry-After` and never changes account or host health. `GET /api/pacing` exposes only upstream ID, queue depth, next slot time, and last start time.

`GET /api/diagnostics` and the dashboard **Diagnostics** dialog expose readiness plus at most 100 terminal gateway failures. Failure records contain only endpoint class, transport, HTTP status, stable error/exclusion codes, retry count, and integer phase durations for queue wait, credential preparation, connection, first response headers, first SSE/WebSocket event, and terminal completion. Account IDs, upstream IDs, API-key IDs, scope IDs, requested models, hostnames, credentials, request bodies, response bodies, and raw exceptions are removed. Detailed successful traces are process-local and limited to the 20 most recent successes; they are never persisted.

Proxy routing prefers Codex, prefers Compass for `claude-*` models, and requires Compass for `/v1/messages`. Type preference is soft: `/v1/responses` and `/v1/chat/completions` fall through to the other upstream type when the preferred one is filtered out. Type requirements are hard: `/v1/messages` never reaches a Codex upstream and `/backend-api/codex/*` never reaches a Compass one, so a request with no eligible upstream of the required type fails with `no_compatible_backend` instead of failing over.

The persisted routing strategy defaults to `least-recent-success`, preserving the existing behavior. `most-remaining-quota` is optional and compares normalized remaining percentages only within the same strict priority tier. Quota observations are fresh for five minutes, matching the automatic one-minute refresh cycle with room for transient refresh failures. Missing or stale quota remains eligible and receives the median fresh score in its tier, so unknown providers are not categorically placed last; least-recent-success and stable persisted order break ties. Configure the strategy in dashboard **Routing** or with `GET/PUT /api/routing`. `POST /api/routing/dry-run` uses the live planner and returns sanitized ordered candidates, quota freshness, and exclusion codes without credentials or provider bodies.

The priority list is empty by default; upstreams added to it (dashboard **Set priority**, or `PUT /api/upstreams/priority`) are dispatched in list order ahead of unlisted upstreams of the same type. Each listed position is a strict tier, while all unlisted upstreams share the final tier. Spending caps, account health, capability and model filters, hard pins, and circuits are applied before strategy ordering. Use `x-upstream-type: codex|compass` or `x-upstream-id` to select explicitly. `x-codex-session-id` is an API-key-isolated soft upstream preference. Each pin rotates after $5 of settled, priced spend: the next ordinary request excludes the prior upstream once, then applies priority routing among the remaining eligible upstreams (or safely falls back to the same one when it is the only candidate). Thus priority `[A, B]` alternates sessions in $5 chunks: A → B → A → B, while both remain eligible. Response continuations retain their response pin. Codex Chat Completions are translated to Responses upstream and converted back, while Compass requests are sent directly to `/chat/completions`, `/responses`, or `/messages`. Compass Messages defaults `anthropic-version` to `2023-06-01` when the client omits it and relays validated `anthropic-beta` values unchanged.

Public file creation performs the Codex create → upload → finalize protocol and stores only file metadata locally; file content and signed URLs are not persisted. Audio requests normalize OpenAI multipart fields for Codex transcription. Public image requests translate through the Responses image-generation tool and automatically select an image-capable Codex host model. The proxy binds to `127.0.0.1`. The API key is a single shared key, not a Pool or per-user key system.

Backend Responses requests with `stream: true` may end their input with a `compaction_trigger`. The Node gateway validates that trigger, projects the compact-compatible request fields, dispatches to `/backend-api/codex/responses/compact` on the selected Codex account, and returns the encrypted compaction item as Responses SSE. Public `/v1/responses` HTTP and WebSocket turns also accept exactly one terminal trigger after visible input; they dispatch the compact projection through the ordinary backend Responses endpoint and adapt the result to public JSON, SSE, or WebSocket events. The direct public `POST /v1/responses/compact` route remains intentionally unsupported.

OpenAI billing rows and the advertised Codex model IDs come from `src/openai-pricing-snapshot.js`. Refresh that reviewable generated file from the configured upstream pricing feed with:

```bash
npm run pricing:refresh
```

Use `--source=<url-or-file-url>`, `--effective-at=<ISO-8601>`, or `--models=<comma-separated-ids>` when updating from a different vetted source or model selection.

## Check

```bash
npm test
```
