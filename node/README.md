# Relaydeck — Node.js

Relaydeck is a deliberately small local dashboard for:

- adding, editing, and deleting Codex, Compass, Claude OAuth, or Anthropic API-key upstreams (Codex/Compass URLs are fixed; Claude may use an operator-supplied Anthropic-compatible `base_url`);
- reading the provider's current quota window (monthly when the provider reports one); AISwitch/CQP accounts are marked `aiswitch` because their quota requires a separate Compass SSO session;
- setting individual or bulk spending caps in dollars;
- exposing spending-cap state and eligibility;
- observing normal/reached cap status and continuation eligibility;
- proxying the core Responses, Chat Completions, Compass Anthropic Messages, and native Claude Anthropic Messages APIs.

This is the primary implementation for new development. It is a small single-process proxy with scoped API keys and the core HTTP/WebSocket compatibility layer. The Elixir application is retained unchanged from upstream as a reference, not as a second maintained implementation. Codex and Claude OAuth access tokens are refreshed lazily before proxy requests, and proactively once per hour when they expire within 12 hours; Anthropic API-key upstreams do not use OAuth refresh.

Quota sharing is a separate product under `pool/`. It has its own server, UI,
cookies, environment, and data directory. See `pool/README.md`; Relaydeck does
not initialize or expose Codex Share accounts, routes, sessions, or storage.
Both products route their client-facing gateway surface through
`src/gateway-dispatch.js`. Add proxy routes or compatibility behavior in the
shared gateway modules, never as a Relaydeck-only or Codex Share-only route.
Codex Share is an informal, free friend-sharing tool. It intentionally has no
payments, marketplace pricing, reputation system, ratings, or availability
guarantees. Durable operational notifications are delivered by email when its
optional SMTP settings are configured; see `pool/README.md`.

## Proxy compatibility status

The Node proxy covers the client-visible local compatibility path:

| Area | Implemented contract | Regression coverage |
| --- | --- | --- |
| Requests and headers | Responses aliases, reasoning/service-tier normalization, configurable and native-client Codex version/beta negotiation, Anthropic header defaults/forwarding, dynamic Codex model discovery, native Codex response-control projection, model ETags, unsupported-route envelopes | `test/proxy.test.js`, `test/gateway-routes.test.js`, `test/codex-model-catalog.test.js`, `test/native-payload.test.js` |
| OpenAI adapters | Forward-compatible Responses fields and enum/tool variants, Responses and Chat message/content/tool conversion, Chat custom tools, multimodal input, continuation/replay validation including URL citations and closed hosted-shell history, strict object-root schemas with nested recursion, non-stream Chat output and finish reasons | `test/openai-adapters.test.js`, `test/proxy.test.js` |
| HTTP ingress and errors | Bounded JSON/compressed bodies, gzip/deflate/zstd, timeouts, OpenAI-shaped errors, provider-detail redaction, bounded native-only misalignment guidance, valid Anthropic 4xx passthrough | `test/http-ingress.test.js`, `test/gateway-routes.test.js` |
| Pricing and settlement | OpenAI/Anthropic JSON and streaming usage, cache fields, dated model suffix pricing, exact ultrafast-tier pricing without fallback, authoritative `price_cost_usd`, idempotent replacement deltas | `test/pricing.test.js`, `test/domain.test.js`, `test/proxy.test.js` |
| Routing | Ordered spend-cap-eligible candidates, per-account discovered Codex model support and advertised ultrafast capability, an optional operator-managed priority list ahead of least-recent-success balancing, explicit/session pins, response-continuation pins with the 125% allowance, safe pre-output failover capped at eight candidate accounts per request, immediate account cooldown for quota responses, reauthentication blocking, health-neutral policy failures, shared Codex-origin reachability protection, and durable model/route circuit recovery | `test/routing.test.js`, `test/proxy.test.js`, `test/gateway-routes.test.js`, `test/codex-model-catalog.test.js`, `test/codex-host-health.test.js`, `test/upstream-outcomes.test.js`, `test/store.test.js` |
| Pacing | Optional per-account and per-model minimum start intervals, bounded abort-aware queues, local `429`/`Retry-After`, and sanitized runtime diagnostics | `test/upstream-pacer.test.js`, `test/proxy.test.js`, `test/gateway-routes.test.js`, `test/server.test.js` |
| Compatibility learning | Passive structured evidence, versioned HTTP/WebSocket protocol fingerprints, route-scoped Compass sampling fallbacks, repeated-evidence promotion, sanitized status/reset APIs, and dashboard controls | `test/compatibility-learning.test.js`, `test/proxy.test.js`, `test/gateway-routes.test.js` |
| Compatibility fixtures | Offline sanitized Codex/Claude client captures replayed through live request projection, with deterministic fingerprint/route/shape/rejection drift reports | `test/compatibility-fixtures.test.js` |
| Compatibility intake | Bounded local capture sanitization, closest-fixture matching, deterministic drift classification, review suggestions, draft output, and CI failure mode | `test/compatibility-intake.test.js` |
| Client release gate | Reviewed npm manifest, latest-version discovery, integrity-pinned platform packages, loopback-only synthetic client execution, and sanitized intake reports | `test/compatibility-release-gate.test.js` |
| Readiness and diagnostics | Immediate liveness, startup-settled readiness with documented degradation, bounded sanitized terminal failure reasons, and phase timing summaries | `test/readiness.test.js`, `test/gateway-diagnostics.test.js`, `test/server.test.js`, `test/accounting-lifecycle.test.js` |
| SSE | Incremental UTF-8/SSE parsing across LF, CRLF, standalone CR, and transport boundaries; bounded complete and incomplete events; OpenAI and Anthropic terminal recognition; first-event failover; public Responses sequencing; Chat translation; cancellation and usage settlement | `test/openai-streaming.test.js`, `test/proxy.test.js` |
| Responses WebSocket | Public `response.create` normalization, `generate: false` warmups, validated per-turn `stream_id` echo, public compaction bridging, per-turn routing/session pinning, sequential multi-turn reuse, bounded frames/pending output, pre-output reconnect, sanitized terminals and terminal usage settlement; native Codex frames remain opaque on one upstream connection, including compaction continuations | `test/gateway-routes.test.js` |

### Intentional limitations

- The server is single-process. It does not implement distributed WebSocket owners, leases, takeover, remote forwarding, or cross-process in-flight continuity.
- There are no Pools, assignments, provider-quota routing, or bulkheads. Routing uses spending caps, explicit/session pins, model policy, and circuit state.
- Public Responses WebSocket turns queue in-process while an active turn terminates. A process restart loses queued and in-flight socket state.
- Credential preparation and refresh failures stay on the selected account instead of crossing accounts. Failover is allowed only after a refresh succeeds but that same account is still rejected, and only when the request is not explicitly or session pinned.
- Pricing is a small generated snapshot, not the Elixir catalog/database sync. Refresh it explicitly with `npm run pricing:refresh`; unknown or ambiguous models remain unpriced unless the provider reports `price_cost_usd`. Settlements are deduplicated per attempt across the 100 most recent settlements; a replay older than that window is counted again.
- Compass Messages translates legacy `thinking.type: "enabled"` requests to adaptive thinking by default, removes the legacy token budget, and supplies `output_config.effort: "medium"` when the client did not specify an effort. Compatibility learning remains deliberately narrow: a provider may teach the proxy that one allowlisted optional Codex field is rejected or that a Compass route rejects an allowlisted sampling control. Messages may learn `temperature`, `top_p`, or `top_k`; Compass Chat Completions and Responses may learn `temperature` or `top_p`. Facts are isolated by route. The current request retries immediately, but later requests change only after two independent structured observations. Versioned per-upstream/model/protocol facts expire after 24 hours, and persisted state is validated against fixed code allowlists.
- Compatibility fixtures are deliberately content-free. They reject credentials, hosts, real model/account/project IDs, request text, provider messages, and unknown schema fields. Fixture drift never updates runtime compatibility facts or fallback allowlists automatically.
- Compatibility intake reads raw captures only from a local file. Reports and drafts replace content, credentials, IDs, URLs, binary data, dynamic schema/tool-argument keys, and provider messages with deterministic markers. A review suggestion is never permission to expand a fallback allowlist.
- The client release gate executes only reviewed, integrity-pinned npm packages inside a supported loopback-only network sandbox. A newer registry release is reported but not executed; unsupported isolation fails closed.
- Only the routes listed below are supported. Other OpenAI endpoints return the deterministic `unsupported_endpoint` envelope rather than attempting partial compatibility. Claude OAuth and Anthropic API-key upstreams forward native Messages inference directly; first-party `POST /v1/messages/count_tokens` uses Anthropic's native counter, while custom Claude origins use CPA's local O200kBase estimator.
- The encrypted local SQLite store is suitable for one local process, not concurrent replicas or production high-availability storage.

## Run

Node 20+ is enough for the dashboard, Codex/Compass routes, and Claude egress.
Claude OAuth compatibility, including Claude Code body shaping and CCH signing,
runs entirely in Node; API-key requests retain caller-owned Anthropic semantics
unless `fingerprint_profile: "claude-code-cli"` is explicitly configured.

```bash
cd node
npm install
npm start
# open http://localhost:3000
```

`npm start` loads `node/.env`. Use `npm run dev` for Node's watch mode. Set one client key in `CODEX_POOLER_API_KEY`; startup fails without it. Proxy routes require `Authorization: Bearer ...`, except `POST /v1/messages`, which also accepts `x-api-key`.

By default, the server binds `127.0.0.1` and accepts only localhost Host headers. For a reverse proxy deployment, set `CODEX_POOLER_BIND_HOST` and `CODEX_POOLER_ALLOWED_HOSTS` (comma-separated). Optional `CODEX_POOLER_ALLOWED_ORIGINS`, `CODEX_POOLER_TRUSTED_PROXIES`, and `CODEX_POOLER_FIREWALL_ALLOWLIST` configure browser origins, trusted forwarding peers, and runtime CIDR/IP admission. External `/api/*` administration requests require the Bearer key; localhost administration remains dashboard-compatible.

Native Codex HTTP/WebSocket routes forward validated client `version`, `originator`, and `openai-beta` negotiation headers. Public OpenAI routes use the proxy defaults. Operators can override the fallback fingerprint with `CODEX_POOLER_CODEX_CLIENT_VERSION` and `CODEX_POOLER_CODEX_ORIGINATOR`, add HTTP beta tokens with `CODEX_POOLER_CODEX_HTTP_BETA`, or replace the required WebSocket beta token with `CODEX_POOLER_CODEX_WEBSOCKET_BETA`. Invalid or control-character-bearing values are ignored.

Passive compatibility observation is enabled by default with `CODEX_POOLER_COMPATIBILITY_PASSIVE_ENABLED=true`. It retains at most 256 content-free observations in memory and promotes only allowlisted structured rejections after independent requests. The dashboard's explicit Test connection action performs one minimal live generation through the selected upstream; no compatibility probes run automatically.

Sanitized release fixtures live in `fixtures/compatibility/` and cover Codex public HTTP/SSE,
native HTTP, compact HTTP, public/native WebSockets, and Compass Anthropic Messages. Run
`npm run compatibility:check` for a deterministic offline drift report. After adding or deliberately
changing a sanitized fixture, run `npm run compatibility:update`, inspect the expectation diff, then
run the check again. Expectations contain only target routes, normalized protocol fingerprints,
sorted JSON paths/types, `type` discriminator values, and structured rejection status/code/param
fields. The capture checklist and safety contract are in `COMPATIBILITY_FIXTURE_PLAN.md`.

For a new Codex or Claude client release, create a local capture file using the bounded envelope
below. Raw capture files may contain sensitive data and should stay outside the repository. The
committed files in `fixtures/compatibility-intake/` are synthetic test corpus entries only.

```json
{
  "schemaVersion": 1,
  "profile": "codex-public-sse",
  "client": { "family": "codex", "version": "0.200.0" },
  "request": {
    "path": "/v1/responses",
    "headers": {},
    "body": { "model": "gpt-example", "input": "example", "stream": true }
  },
  "response": {
    "status": 400,
    "body": { "error": { "type": "invalid_request_error", "code": "unsupported_parameter", "param": "example" } }
  }
}
```

Run intake without writing anything:

```bash
npm run compatibility:intake -- --capture=/absolute/path/to/capture.json
```

Add `--json` for machine-readable output, or `--fail-on-review` to return exit code 1 unless the
capture exactly matches its closest same-profile fixture. Write a new sanitized draft with
`--output=/absolute/path/to/draft.json`; the command refuses to overwrite an existing file.
`draftReady: false` means the live adapter rejected the sanitized shape and the draft has no
generated expectation yet. Review the report and draft manually before moving it into
`fixtures/compatibility/` and running `npm run compatibility:check`.

The client release gate uses `fixtures/compatibility-releases.json` as a reviewed allowlist for
Codex CLI and Claude Code versions, root-package integrity, and per-platform executable packages:

```bash
npm run compatibility:release-check
```

Online mode discovers the latest published versions, verifies the reviewed root and platform
package metadata, downloads only exact pinned packages, verifies SHA-512, and executes each client
against a temporary loopback synthetic endpoint. A newer release is reported as `new_release` but
is not executed until its exact provenance is reviewed and added to the manifest. Client execution
requires platform network isolation that denies external traffic; unsupported hosts fail closed.
Temporary client state, raw captures, and output are deleted after Phase 9 sanitization. Use
`--client=codex` or `--client=claude-code`, `--json`, `--fail-on-review`, or `--offline` for a
verified cache-only run. The full contract is in `COMPATIBILITY_RELEASE_GATE_PLAN.md`.

Shared Codex host health is enabled conservatively by default. Two proven pre-connect failures within 30 seconds open a 15-second circuit for the normalized Codex origin; requests receive a local retryable `503 codex_host_unavailable` with `Retry-After`, and one half-open probe is admitted after cooldown. Only `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ENETUNREACH`, `ENETDOWN`, and `EHOSTUNREACH` count. Timeouts, resets, broken pipes, TLS failures, HTTP responses, and authentication failures remain account-attributed, while any actual HTTP response clears host reachability evidence. Configure this with `CODEX_POOLER_CODEX_HOST_CIRCUIT_ENABLED`, `CODEX_POOLER_CODEX_HOST_FAILURE_THRESHOLD`, `CODEX_POOLER_CODEX_HOST_FAILURE_WINDOW_MS`, `CODEX_POOLER_CODEX_HOST_COOLDOWN_MS`, and `CODEX_POOLER_CODEX_HOST_MAX_ENTRIES`.

Compass requests use HTTPS. Compass quota reads use the deployment-wide `CODEX_POOLER_COMPASS_GATEWAY_TOKEN`. Codex quota reads use the access token imported from `auth.json`; Claude OAuth credentials use the Claude Code PKCE exchange and refresh endpoints, then call the configured Anthropic-compatible base URL (default `https://api.anthropic.com`) at `/v1/messages?beta=true`. Claude API-key upstreams use `x-api-key` and the same native Anthropic Messages routes without OAuth control-plane calls. Codex and Claude OAuth tokens are refreshed lazily before proxy requests and proactively once per hour when they expire within 12 hours. Transient refresh failures retry with bounded exponential backoff (eight total attempts), then re-enter recovery after six hours; missing or revoked refresh tokens require reauthentication. The dashboard offers manual OAuth token refresh for both providers. Claude upstreams have no provider quota endpoint, so their routing is governed by spending caps and account health.
Adding an upstream performs a best-effort quota refresh before the create response returns when the provider exposes quota data. Replacing Codex or Compass quota credentials does the same, while provider failures do not roll back the saved upstream.

Data is stored in `.data/`. Credential fields are encrypted with a local `.data/.key`. Public upstream records never include credentials; an authenticated operator can explicitly reveal an upstream's current credential export from the Edit upstream dialog or `GET /api/upstreams/:id/credentials`. `db.sqlite` keeps configuration, spending state, 90 days of compact daily usage counters, and at most 100 terminal failure diagnostics; successful request histories are not stored. Existing `db.json` files migrate automatically on startup. Back up `.data/.key` and `db.sqlite` together if you need to move the data; startup refuses to create a replacement key for an existing database. Set `CODEX_POOLER_NODE_DATA_DIR` to choose another data directory.

`GET /healthz` is immediate process liveness. Exact `GET /readyz` returns `200` only after local storage and API-key setup plus the initial token-recovery, quota-refresh, and model-discovery passes have settled. Provider/network failures degrade those startup checks without blocking readiness because requests can still recover credentials on demand, quota refresh continues in the background, and model discovery has the documented static fallback. Pending or failed readiness returns `503`, `Retry-After: 1`, and only sanitized fixed states.

Spending caps use 25 credits per dollar, rounded to whole credits, and a positive cap is never rounded down to zero (which would read as no cap). A cap update starts a new cap period and resets spend. Proxy requests require a positive cap: accounts remain eligible until they reach 100%, and a `previous_response_id` continuation stays pinned to its original account below 125%. Valid provider-reported `usage.price_cost_usd` is authoritative, accepted only as a plain non-negative decimal; otherwise supported Codex and Anthropic token usage is priced from the local snapshot, which applies OpenAI's long-context rates above 272,000 input tokens. A known model with no snapshot for an ordinary requested service tier or context bucket bills at its standard default rates rather than going unpriced. The distinct `ultrafast` tier remains unpriced without an exact snapshot. A provider `total_tokens` that disagrees with input plus output is reported as received without discarding the priced tokens. The usage endpoint remains available for other integrations.

## API

```text
GET    /api/upstreams
GET    /api/upstreams/:id/credentials  # explicit current credential export
GET    /api/upstreams/events             # SSE: ready + upstream-change notifications
GET    /api/model-catalog                 # sanitized discovery source/freshness/failure status
GET    /api/codex-host-health             # sanitized aggregate shared-origin circuit status
GET    /api/pacing                       # sanitized per-account runtime queue/start status
GET    /api/diagnostics                  # readiness, memory-only successes, and bounded terminal failures
GET    /api/compatibility                # sanitized fingerprints, counts, and allowlisted facts
DELETE /api/compatibility/facts          # reset all learned compatibility state
DELETE /api/compatibility/facts/:id      # reset one opaque compatibility fact
GET    /api/routing                       # persisted routing strategy
PUT    /api/routing                       { "strategy": "least-recent-success|most-remaining-quota" }
POST   /api/routing/dry-run               # sanitized live-planner candidate/exclusion diagnostics
POST   /api/upstreams
POST   /api/upstreams/refresh-quota         # all upstreams, concurrent batches of 10
PATCH  /api/upstreams/:id
DELETE /api/upstreams/:id
POST   /api/upstreams/:id/refresh-quota
POST   /api/upstreams/:id/test-connection  # live minimal generation through this upstream
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
POST   /v1/messages                 # Compass or Claude; native Anthropic Messages
POST   /v1/messages/count_tokens    # Claude; native first-party or local O200k count
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
POST   /backend-api/codex/v1/responses/compact
GET    /backend-api/codex/models
GET    /backend-api/codex/v1/models
POST   /backend-api/transcribe
POST   /backend-api/files
POST   /backend-api/files/:id/uploaded
POST   /backend-api/codex/images/generations
POST   /backend-api/codex/images/edits
```

The dashboard's bulk-cap dialog starts with the original quota presets: quota left above $1,000/$500/$200/$100/$50/$0 maps to caps of $100/$50/$20/$10/$5/$0. Rules are editable, and one-cap targets remain available.

`GET /v1/models`, `GET /backend-api/codex/models`, and `GET /backend-api/codex/v1/models` aggregate the static catalog with model metadata discovered from every currently usable Codex account. Discovery uses the configured Codex protocol fingerprint and normal credential-refresh path, caches each account for five minutes, coalesces concurrent requests, suppresses repeated failures for 30 seconds, and retains the last-known-good catalog when refresh fails. Cold start, no-account, and all-account discovery failures continue serving the static catalog. Native routes preserve bounded, sanitized upstream metadata; `/v1/models` returns stable OpenAI-shaped rows.

Discovered capability is account-specific. Once an account has an authoritative catalog, a model absent from that catalog is not routed to that account; accounts without authoritative discovery remain eligible. Scope model policy, per-upstream model restrictions, spending caps, explicit pins, continuation affinity, and circuit state remain authoritative. Provider `model_not_found` failures create an immediate bounded negative capability and force that account's catalog to refresh on the next discovery attempt. Public image compatibility uses the selected account's catalog, prefers an explicitly image-capable host model, and skips the account when its metadata authoritatively rules image input out. `GET /api/model-catalog` exposes only sanitized source, freshness, model count, timestamps, and failure class.

Account health is settled consistently for public JSON/SSE, Chat adapters, native HTTP, public and native Responses WebSockets, and Codex file/audio/image helpers. One upstream `402` or credential-scoped `429` immediately removes the account from ordinary routing. Claude model-scoped rate limits (including CPA Fable-only unified-window rejection) create a bounded cooldown for only the requested model, so another Claude model on the same credential remains eligible; Fable-only `7d_oi` resets are not treated as week-long account cooldowns. A valid `Retry-After` is honored for up to 24 hours and relayed on terminal proxy failures; known quota-reset timestamps are capped to 15 minutes, and missing timing metadata uses a 60-second cooldown. Reset-derived cooldowns permit one generation-fenced early probe after five minutes, while explicit `Retry-After` cooldowns never probe early. A `401/403` that remains after the normal Codex refresh retry marks the account reauthentication-required. Caller `4xx`, redirects, downstream cancellation, and local credential-preparation failures do not penalize account health.

Codex HTTP, compatibility, model-discovery, compaction, and WebSocket handshakes also share bounded in-memory origin reachability state. Proven DNS or pre-connect failures settle the selected account neutrally, preventing one local-network or ChatGPT-origin outage from opening every account circuit. Generation-fenced leases prevent an old half-open request from clearing a newer outage, while a real HTTP response of any status immediately restores normal host admission. The state is process-local and stores no credentials, request bodies, response bodies, or hostnames in diagnostics.

Quota and reauthentication transitions clear ordinary session affinity so new work can route elsewhere, but committed response-continuation pins are retained and never silently moved. Credential replacement and generation-fenced attempt leases prevent stale in-flight success or failure from overwriting newer account state. Public upstream records expose only sanitized health fields. `POST /api/upstreams/:id/clear-cooldown` clears quota cooldown state without clearing reauthentication-required state or unrelated routing history.

Create a Codex upstream with `{ "type": "codex", "authJson": "..." }`, a Compass upstream with `{ "type": "compass", "projectId": "...", "projectKey": "...", "quotaSource": "compass|aiswitch" }`, or a Claude OAuth upstream with `{ "type": "claude", "authJson": "{\"access_token\":\"...\",\"refresh_token\":\"...\"}" }`; an Anthropic API-key upstream uses `{ "type": "claude", "projectKey": "sk-ant-api..." }`. The API endpoints `POST /api/claude/oauth/start` and `POST /api/claude/oauth/exchange` support the Claude Code PKCE flow; the dashboard supports importing credential JSON, API keys, and manual OAuth refresh. Claude requests are native `/v1/messages` and `/v1/messages/count_tokens` calls; use `x-upstream-type: claude` when Compass and Claude upstreams coexist. Names are derived server-side: masked account email for OAuth accounts and a generic Claude label for API keys. Claude credential metadata may carry CPA-compatible `cloak_mode` (`never` preserves caller placement), `cloak_strict_mode`, `cloak_sensitive_words` (array or comma-separated string), IANA `timezone`, `fingerprint_profile: "claude-code-cli"`, opt-in `rebuild_mid_system_message`, `header:<name>` overrides (including `$<incoming-header>` substitutions, a nested `headers` object, or cookies), per-auth `model_aliases` entries such as `{ "name": "claude-sonnet-4-6", "alias": "team-sonnet", "force-mapping": true }`, and `request_scoped_errors` rules with CPA actions `stop`, `stop-and-cooldown`, `continue`, or `continue-and-cooldown`. The management API also accepts CPA-style top-level Claude fields: `headers`, `models`, `excluded-models`, `proxy-url`, `prefix`, `rebuild-mid-system-message`, `disable-cooling`, `request-retry`, `request-scoped-errors`, `fingerprint-profile`, and `cloak`; `models` replaces the default catalog for that credential and supports CPA `name`, `alias`, `display-name`, `max-context-length`, `force-mapping`, and `is-compat` fields. Claude model suffixes such as `claude-sonnet-4-6(8192)`, `(high)`, `(auto)`, and `(none)` are applied before direct Messages dispatch. Aliases rewrite the upstream model and force-mapped responses use the client alias; scoped rules can stop or fail over a matching HTTP/SSE error and optionally cool the credential. These are applied only to the Claude wire transformation and never to authentication. The single Claude OAuth device identity is persisted in exported credential metadata. Bulk caps accept either `{ "target": "all|cap_reached|uncapped", "capDollars": 100 }` or quota rules such as `{ "rules": [{ "minQuotaLeft": 1000, "capDollars": 100 }] }`. Bulk updates are sequential, not atomic.

Claude per-credential `disable_cooling` (or legacy `disable-cooling`) suppresses account and transient circuit cooldown scheduling. `request_retry` (or `request-retry`) allows up to eight additional bounded local retry rounds for that credential; retryable failures still fail over normally when another candidate is available.

For `count_tokens`, first-party Anthropic is called natively; custom Claude origins use the local O200kBase estimator and never receive a network call.

The Node host also accepts the CPA global Claude controls through
`CODEX_POOLER_CLAUDE_CONFIG_JSON` (a bounded JSON object). It supports
`disable-claude-cloak-mode`, `disableCooling`, `requestRetry`, and the
`claudeHeaderDefaults` object (`userAgent`, `packageVersion`, `runtimeVersion`,
`os`, `arch`, `timeout`, `timezone`, and `stabilizeDeviceProfile`). The global
OAuth maps `oauthModelAlias`, `oauthExcludedModels`, and
`oauthRequestScopedErrors` are also supported for Claude. `oauthProxyUrl` can
route the initial PKCE exchange and advisory profile/roles lookups through the
same egress proxy. Its `payload` object supports CPA's
`default`, `default-raw`, `override`, `override-raw`, and `filter` rules,
including model/protocol/source-protocol/header gates and JSON-path conditions.
For example: `CODEX_POOLER_CLAUDE_CONFIG_JSON='{"claudeHeaderDefaults":{"timezone":"Asia/Tokyo"},"payload":{"override":[{"models":[{"name":"claude-*","protocol":"claude"}],"params":{"temperature":0.2}}]}}'`.

Claude `prefix` metadata namespaces model routing (for example, `team-a/claude-sonnet-4-6`) and the matching prefix is removed before dispatch. `proxy_url` metadata selects an HTTP, HTTPS, SOCKS5, or SOCKS5h egress proxy for that credential's direct Messages, `count_tokens`, and OAuth profile/refresh control-plane calls; proxy agents are bounded and reused per proxy URL. SOCKS URLs may include percent-encoded credentials.

Request pacing is disabled by default and configured per upstream through create or patch with `{ "pacing": { "enabled": true, "minStartIntervalMs": 1000, "modelIntervals": [{ "model": "gpt-5.6-sol", "minStartIntervalMs": 2000 }], "maxQueueDepth": 20, "maxQueueAgeMs": 30000 } }`. Account and matching model intervals both apply. Runtime queues are process-local and independent per account; queue overflow or expiration returns local `429` with `Retry-After` and never changes account or host health. `GET /api/pacing` exposes only upstream ID, queue depth, next slot time, and last start time.

`GET /api/diagnostics` and the dashboard **Diagnostics** dialog expose readiness plus at most 100 terminal gateway failures. Failure records contain only endpoint class, transport, HTTP status, stable error/exclusion codes, candidate failover count, a bounded latest-attempt sample, and integer phase durations for queue wait, credential preparation, connection, first response headers, first SSE/WebSocket event, and terminal completion. Account IDs, upstream IDs, API-key IDs, scope IDs, requested models, hostnames, credentials, request bodies, response bodies, and raw exceptions are removed. Detailed successful traces are process-local and limited to the 20 most recent successes; they are never persisted.

`GET /api/compatibility` and the dashboard **Compatibility** dialog expose only protocol fingerprint version/hash, aggregate active/stale counts, counters, and allowlisted fact metadata. They do not expose upstream/account IDs, model IDs, hostnames, credentials, request/response bodies, or raw errors. Persisted compatibility state is limited to 100 facts per upstream; credential identity replacement clears it.

Proxy routing prefers Codex, prefers Compass for `claude-*` models, and supports Compass or Claude for `/v1/messages`; `/v1/messages/count_tokens` is Claude-only. Type preference is soft except for native protocol boundaries: `/v1/messages` never reaches Codex, `/v1/messages/count_tokens` never reaches Codex or Compass, `/backend-api/codex/*` never reaches Compass or Claude, and Claude upstreams are not selected for OpenAI Chat/Responses routes until a dedicated translation adapter exists. Use `x-upstream-type: claude` or `x-upstream-id` to select Claude explicitly when both direct Anthropic upstream types are configured.

The persisted routing strategy defaults to `least-recent-success`, preserving the existing behavior. `most-remaining-quota` is optional and compares normalized remaining percentages only within the same strict priority tier. Quota observations are fresh for five minutes, matching the automatic one-minute refresh cycle with room for transient refresh failures. Missing or stale quota remains eligible and receives the median fresh score in its tier, so unknown providers are not categorically placed last; least-recent-success and stable persisted order break ties. Configure the strategy in dashboard **Routing** or with `GET/PUT /api/routing`. `POST /api/routing/dry-run` uses the live planner and returns sanitized ordered candidates, quota freshness, and exclusion codes without credentials or provider bodies.

The priority list is empty by default; upstreams added to it (dashboard **Set priority**, or `PUT /api/upstreams/priority`) are dispatched in list order ahead of unlisted upstreams of the same type. Each listed position is a strict tier, while all unlisted upstreams share the final tier. Spending caps, account health, capability and model filters, hard pins, and circuits are applied before strategy ordering. Use `x-upstream-type: codex|compass|claude` or `x-upstream-id` to select explicitly. `x-codex-session-id` is an API-key-isolated soft upstream preference. Each pin rotates after $5 of settled, priced spend: the next ordinary request excludes the prior upstream once, then applies priority routing among the remaining eligible upstreams (or safely falls back to the same one when it is the only candidate). Thus priority `[A, B]` alternates sessions in $5 chunks: A → B → A → B, while both remain eligible. Response continuations retain their response pin. Codex Chat Completions are translated to Responses upstream and converted back, while Compass requests are sent directly to `/chat/completions`, `/responses`, or `/messages`; Claude forwards native `/messages` and `/messages/count_tokens`. Direct Anthropic API-key requests preserve caller-owned identity and protocol headers/body by default; CPA-compatible cache breakpoints may still be added when the caller sends none, while OAuth or an explicit Claude Code fingerprint profile adds the corresponding CLI profile. Requests default `anthropic-version` to `2023-06-01` and relay validated response/rate-limit headers.

Public file creation performs the Codex create → upload → finalize protocol and stores only file metadata locally; file content and signed URLs are not persisted. Audio requests normalize OpenAI multipart fields for Codex transcription. Public image requests translate through the Responses image-generation tool and automatically select an image-capable Codex host model. The proxy binds to `127.0.0.1`. The API key is a single shared key, not a Pool or per-user key system.

Backend Responses requests with `stream: true` may end their input with a `compaction_trigger`. The Node gateway validates that trigger, projects the compact-compatible request fields, dispatches to `/backend-api/codex/responses/compact` on the selected Codex account, and returns the encrypted compaction item as Responses SSE. Codex V2 compaction requests (`responses_compaction_v2` turn metadata) collect streamed compact results, including an unframed final event, and reject data after the terminal. Public `/v1/responses` HTTP and WebSocket turns also accept exactly one terminal trigger after visible input; they dispatch the compact projection through the ordinary backend Responses endpoint and adapt the result to public JSON, SSE, or WebSocket events. The direct public `POST /v1/responses/compact` route remains intentionally unsupported.

OpenAI billing rows and the advertised Codex model IDs come from `src/openai-pricing-snapshot.js`. Refresh that reviewable generated file from the configured upstream pricing feed with:

```bash
npm run pricing:refresh
```

Use `--source=<url-or-file-url>`, `--effective-at=<ISO-8601>`, or `--models=<comma-separated-ids>` when updating from a different vetted source or model selection.

## Check

```bash
npm run compatibility:check
npm run compatibility:release-check
npm test
```
