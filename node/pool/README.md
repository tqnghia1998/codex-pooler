# QuotaHub

QuotaHub is a standalone quota-sharing product. It has its own server, UI,
cookies, environment, and runtime data. It reuses the Node gateway's provider
adapters and proxy compatibility code, but it does not run inside Relaydeck and
never opens Relaydeck's `node/.data`.

QuotaHub is for informal sharing between friends. Offers and requests are
free: the product has no payments, pricing marketplace, ratings, reputation
score, or service guarantee. Providers can pause or revoke access at any time,
and consumers should treat shared quota as best-effort.

## Run

Node 20+ is required.

```bash
cd node
npm install
cp pool/.env.example pool/.env
npm run pool:start
# open http://localhost:3010
```

`npm run pool:start` runs the server in Node watch mode; `npm run pool:dev` is
an alias. The product loads `pool/.env` when that file exists. Its variables
use the `POOL_*` prefix; Relaydeck's `CODEX_POOLER_*` variables are not product
configuration.

## Product Boundary

- Entry point: `pool/src/server.js`
- UI source: `pool/ui/`
- Generated UI: `pool/public/`
- Runtime data: `pool/.data/`
- Default port: `3010`
- Account cookies: `codex_pool_session`, `codex_pool_csrf`
- Share keys: `cp_share_...`
- Personal keys: `cp_personal_...`

`pool/.data/db.sqlite` and `pool/.data/.key` are the product's private gateway
store for linked Codex and Claude credentials. `pool/.data/pool.sqlite` and
`pool/.data/.pool-key` hold product accounts, offers, tickets, sessions, key
hashes, and audit events. Back up all four files together.

QuotaHub also writes a full JSON snapshot to `pool/.data/quotahub-snapshot.json`
on startup and then every hour, replacing the previous snapshot. The file uses
the same format as the admin export and can be restored through admin import;
it contains the encrypted gateway records and every product table. Set
`POOL_BACKUP_INTERVAL_MS` to change the cadence. Admin Data management shows
the last successful automatic snapshot time and any failure since then.

The embedded pool always uses local SQLite. Deploy it with a persistent volume
for `POOL_DATA_DIR`; Redis and KMS persistence belong to the standalone
`codex-share` repository.

Relaydeck uses `node/.data`, port `3000`, and its own operator authentication.
Starting either product does not start, configure, migrate, or mutate the
other. `POOL_DATA_DIR` must not point to `node/.data`; QuotaHub startup
rejects that configuration.

## Authentication

Users can sign in through SPACE SSO, or link a Codex provider by pasting the
contents of an existing Codex `auth.json` into the login dialog. SPACE sign-in
validates the session bearer token with
SPACE before QuotaHub loads account data, and derives the account email only
from SPACE's validation response. This automatic validation applies only to
browser sessions originally created by SPACE; `auth.json` import sessions
remain active without a SPACE browser session.
Accounts are keyed by email; Codex, Claude, and other provider credentials are
only links attached to the account, never separate identities. Codex `auth.json`
import validates the token issuer and stable subject before it imports or
refreshes credentials in the private encrypted gateway store and attaches them
to the account with the matching email. Pasted credentials are used only for
the import request and are not saved in browser storage.
Browser sessions issued by versions that supported device authentication are
revoked during migration; sign in again through SPACE or import `auth.json`.
The paste dialog accepts raw JSON and JSON surrounded by standalone Markdown
code-fence lines. When Codex rotates an enterprise SSO subject, an import with
the same email lands on the same account and refreshes the linked credential.

Provider tokens are never included in browser account or upstream responses
and are never placed in `localStorage`. Linked provider credentials cannot be
viewed or exported by a signed-in member. Browser sessions use opaque cookies
and mutating management requests require a session-bound CSRF token.

QuotaHub account sessions are permanent until logout or revocation. The
browser cookies are issued with a ten-year lifetime; clearing cookies still
requires signing in again in that browser.

After sign-in, QuotaHub waits for an immediate best-effort Codex quota
refresh before completing the browser login, then refreshes every linked Codex
account automatically every minute in batches of ten. The dashboard polls this
stored quota state and can also refresh it manually. Some Codex plans expose
only a percentage or provider units; QuotaHub shows that reported value rather
than estimating a dollar balance. When the optional delayed quota integration
is configured, QuotaHub also reads monthly Claude and AIS usage by the
provider's QuotaHub email once per hour. When Loop publishes a provider
balance, QuotaHub uses that value; otherwise it calculates the balance as
monthly cap minus usage. Those balances are approximately one hour behind,
visibly labeled with their data-through time, and used as the current sharing
balance until the next refresh.
At startup and once per hour, QuotaHub also refreshes any refreshable Codex
token that expires within 12 hours. Transient refresh failures retry with
bounded exponential backoff; revoked or missing refresh tokens require the
provider to sign in again.
When a provider's Codex credentials need reauthentication, its quota card shows
the affected state and offers `auth.json` import.
Offers, pending tickets, and share sessions show a sanitized provider issue to
both providers and consumers when the provider needs reauthentication, has a
token-refresh failure, or has exhausted its provider quota.

Users can also link Claude with a Claude CLI setup token or supported OAuth
credential JSON, or add an AIS project by entering its project ID and project
key. Each account can link at most one provider of each type (Codex, Claude,
and AIS). Reimporting or updating the linked provider refreshes its credentials;
unlink it before linking a different provider of the same type. Existing
additional links remain accessible, but no new link of that type can be added.
Claude cards use the signed-in QuotaHub email because setup tokens may not
have permission to read a Claude profile. Claude and AIS use the delayed monthly
balance when the integration has data for the provider email. That balance caps
new offers and sessions and marks the provider unavailable at zero, just like a
dollar-denominated Codex balance. It is still not a real-time provider response:
external consumption within the delay window can make the actual balance lower. Manual refresh
updates Codex quota and, when configured, Claude and AIS monthly balances. Use
**Add AIS project** and its **How to get AIS project** guide to retrieve
`project_id` and `api_key` from Compass.
Linked-provider percentage bars have a help icon explaining that Codex,
Claude, and AIS estimates can lag their live provider quota. Unknown-quota
cards retain their own explanation. Unlinking a provider removes its saved
credentials and closes related offers and share sessions.

## Sharing Flow

1. A provider publishes an offer for one imported Codex account, linked Claude
   account, or added AIS project, a dollar amount they are willing to share,
   and an optional message visible to members who can view the offer.
   Offers are checked against the provider's current stored balance. Claude and
   AIS balances are approximately one hour delayed when supplied by Loop.
2. A consumer requests a dollar quota through a ticket.
3. The provider approves the request, changes the approved amount, or rejects
   it. A partial approval closes the original offer, creates a replacement
   offer for the remaining quota, and moves other pending tickets to it.
4. Approval atomically creates a share session and a `cp_share_...` key.
5. The consumer can instead reveal one `cp_personal_...` key that routes each
   request across their active share sessions.
6. Successful priced usage is settled against the grant. QuotaHub does not pace
requests, serialize active requests for a share session, or locally cool down a
provider after a quota response; the provider and settled grant remain authoritative.

An offer that created a grant is immutable history and cannot be edited or
reopened. Providers edit the active replacement offer after a partial approval,
or publish a new offer after a full approval. A manually closed offer that never
created a grant can still be edited and reopened.

Every new QuotaHub account receives a `Default` personal key automatically.
Its secret is encrypted at rest and can be revealed or rotated from the
dashboard.

Providers can pause, resume, resize, top up, revoke, or replace a session key.
Providers and consumers can reveal the current key while the session remains
until it is revoked. Replacing a key immediately invalidates the previous key.
Session keys are pinned to the approved provider upstream. A personal key
selects an active session with the most remaining quota, keeps normal
conversation and Responses continuations on that selected session, and moves
new requests to another session when the prior one becomes unavailable, even
when the client reuses its session ID. A `previous_response_id` continuation
never switches providers after its pinned session becomes unavailable. Neither
key type can access product management routes.
If every active provider session needs reauthentication, requests return
`share_provider_reauth_required` until a provider reconnects.

Offers, sessions, personal keys, and public quota requests expire. Pending
tickets remain open until the source offer is closed or expires; direct grants
do not resolve offer tickets.
Offer and session expiry is bounded by a provider reset time when one is known.
For Codex and Loop-backed Claude/AIS balances, creating or resizing a grant is
rejected atomically when it would overcommit the stored provider balance. If a
stored balance later falls below existing commitments, affected offers and
sessions remain visible as underfunded but cannot accept or route new work
beyond their backed amount. Claude and AIS accounts without a Loop balance
remain best effort; external use can make either provider reject a request
before its local share grant is consumed.
Providers can extend an active session's expiry from **Resize share session**;
the new expiry cannot shorten the session or exceed the provider quota reset
or the 30-day session limit.
Providers can pause all sharing without deleting grants, or revoke all sharing
to close offers, reject pending tickets, and revoke sessions for one Codex
or Claude account or AIS project.

Consumers can create multiple named personal keys, optionally with an expiry,
so each device or client can be rotated or revoked independently. The dashboard
stores only privacy-safe activity totals: request and success counts, spend, and
last use. It never stores prompts, responses, models, failure history, or a row
per request.
The dashboard also shows the top ten community providers to signed-in members,
ranked by settled session usage with account emails and aggregate totals. The
admin analytics view retains both provider and consumer rankings.

## Friend Requests

A user who cannot find a suitable offer can post one request for the amount
they need, either publicly or to an email allowlist. An optional message (up to
500 characters) is visible to members who can view the request. Posting a new
request cancels their previous active request. Users can view and cancel their own
active requests from the consumer dashboard. A provider who can see the request
can grant it directly from one linked provider. A grant at or above the
requested amount fulfills the request; a smaller grant fulfills the original
and creates a replacement request for the remaining amount with the same
message, visibility, and expiry. Direct grants and offer-ticket approvals are
independent:
granting a request does not cancel offer tickets, and approving an offer ticket
does not fulfill a quota request. Every grant atomically creates a share
session and `cp_share_...` key. Requests contain no payment, rating,
or guarantee fields.
The admin request funnel counts offer tickets only; direct grants appear as
separate `direct_grant/created` audit events.

The admin page shows Overview, Operations, Usage, Activity, and Data together
in one scrollable view, with the language toggle beside the header actions.
Operations lists linked providers with their current issue, sharing status,
last observation, and active share/session record counts; it also shows
aggregate email queue health without exposing message contents. Usage displays
UTC daily session request, success, failure, and settled-usage totals recorded
from this version onward for up to 90 days. Earlier daily history cannot be
reconstructed; the older aggregate usage totals cover retained sessions only.
The approval rate divides approved tickets by reviewed (approved or rejected)
tickets. Activity supports a bounded search across actor, action, entity type,
and entity ID, with a 7-day, 30-day, or full retained-history filter. Event
details and credential contents are not returned by analytics. The Data section
shows collection counts before import and requires typing `IMPORT` to replace
the listed collections.

## Community Activity Banner

Signed-in members see a compact community banner above the leaderboard. It
summarizes active requests and usable offers visible to that viewer, including
their own posts but excluding offers they already have a pending ticket for.
Counts are unique people, not posts. Up to three names per category rotate
once per minute; restricted posts never contribute names or counts for
unauthorized viewers.
The summary is independent of table searches and pagination. Requests appear
on the left and offers on the right in equal-width columns, each with its own
single-line marquee. If only one category is available, it fills the strip.

The dashboard refreshes the summary with its five-second polling and after
sharing actions. Names open the corresponding list filtered by email (the
viewer's own name opens their "My" tab); the category action is an inline
hyperlink that moves with the message and opens the whole list. Both reset
pagination and past-data filters. Motion pauses on hover, keyboard focus,
dialogs, or hidden tabs;
hovering one side does not stop the other. The narrow layout keeps both
single-line marquees with compact category icons. Reduced-motion layouts use
static single-line text with the action link first. Empty or failed summaries
hide the banner.

## Email

QuotaHub writes notification events to a durable email outbox. With SMTP
configured, it sends them in the background and retries failures with bounded
backoff. Without SMTP, email notifications are skipped and pending outbox
entries are removed. There is no in-app notification inbox.

Email events cover ticket creation and resolution, session expiry and
revocation, key replacement and revocation, provider pause/resume,
provider-unavailable/recovered/reset transitions, and session usage crossing
80%, 95%, or 100%. Email delivery uses the account email obtained from Codex
`auth.json` import or SPACE validation.

The product database runs cleanup at startup and every six hours. Personal-key
routing pins are retained for 24 hours, completed email records for 30 days,
audit events for 90 days, and terminal offers, tickets, sessions, and quota
requests for 180 days. Request reservations and settlement deduplication exist
only in process memory and are lost on restart; completed requests leave only
aggregate activity and session-spend counters in SQLite. Active account sessions
are permanent and never expire; records for sessions explicitly revoked by
logout are retained for 180 days.
SQLite reuses pages freed by cleanup; it does not run a full `VACUUM` during
normal operation.

## API

```text
POST   /auth/codex/import
POST   /auth/logout

GET    /api/pool/me
GET    /api/pool/community-activity              # viewer-visible unique people, bounded rotating samples
GET    /api/pool/leaderboard                    # top providers/consumers by settled usage, with account emails
GET    /api/pool/admin/analytics                 # quangnghia.trinh@shopee.com only; recent events use eventCursor
GET    /api/pool/admin/export                    # admin only; full JSON snapshot (gateway records + all product tables)
POST   /api/pool/admin/import                    # admin only; restore from an export file, replacing the collections it contains
GET    /api/pool/personal-key
POST   /api/pool/personal-key/reveal
POST   /api/pool/personal-key/rotate
GET    /api/pool/personal-keys
POST   /api/pool/personal-keys
POST   /api/pool/personal-keys/:id/reveal
POST   /api/pool/personal-keys/:id/rotate
POST   /api/pool/personal-keys/:id/revoke
GET    /api/pool/upstreams
POST   /api/pool/upstreams/claude                   { token|accessToken|authJson }
POST   /api/pool/upstreams/ais                      { projectId, projectKey }
PATCH  /api/pool/upstreams/:id                      AIS: { projectId, projectKey? }; Claude: { token|accessToken|authJson }
DELETE /api/pool/upstreams/:id                      removes credentials; revokes related offers and sessions
POST   /api/pool/upstreams/:id/refresh-quota        Codex quota or optional delayed Claude/AIS observation
POST   /api/pool/upstreams/:id/test-connection
GET    /api/pool/providers/:id
POST   /api/pool/providers/:id/pause
POST   /api/pool/providers/:id/resume
POST   /api/pool/providers/:id/revoke-all
GET    /api/pool/offers
POST   /api/pool/offers
PATCH  /api/pool/offers/:id
GET    /api/pool/tickets
POST   /api/pool/tickets
POST   /api/pool/tickets/:id/cancel
POST   /api/pool/tickets/:id/approve
POST   /api/pool/tickets/:id/reject
GET    /api/pool/sessions
PATCH  /api/pool/sessions/:id
POST   /api/pool/sessions/:id/revoke
POST   /api/pool/sessions/:id/reveal-key
POST   /api/pool/sessions/:id/rotate-key
POST   /api/pool/sessions/:id/test-connection
GET    /api/pool/quota-requests
POST   /api/pool/quota-requests
POST   /api/pool/quota-requests/:id/grant             { upstreamId, quotaDollars }
POST   /api/pool/quota-requests/:id/cancel

GET    /v1/usage
GET    /v1/models
POST   /v1/responses
GET    /v1/responses                 # WebSocket upgrade
POST   /v1/chat/completions
POST   /v1/messages                  # native Anthropic Messages for AIS or Claude
POST   /v1/messages/count_tokens     # Claude only; native or local count
GET    /v1/files
POST   /v1/files
GET    /v1/files/:id
DELETE /v1/files/:id                 # deterministic unsupported_endpoint
GET    /v1/files/:id/content         # deterministic unsupported_endpoint
POST   /v1/audio/transcriptions
POST   /v1/images/generations
POST   /v1/images/edits

# Reused Codex-compatible proxy aliases
POST   /backend-api/codex/responses
GET    /backend-api/codex/responses  # WebSocket upgrade
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

The sharing list endpoints (`offers`, `tickets`, `sessions`, and
`quota-requests`) are paged. They accept `limit` (1–50, default 10), `offset`,
`q` (case-insensitive provider or consumer email search where applicable), and
`includePast=true`. The dashboard also supplies a route-specific `role` filter.
Responses contain the list field plus `totalItems`, `hasMore`, and `nextOffset`.

Gateway routes require a valid `cp_share_...` or `cp_personal_...` key in a
Bearer token; `POST /v1/messages` also accepts that key in `x-api-key`.
Personal-key model lists are the union of active-session catalogs. Ordinary
Relaydeck API keys are rejected.

QuotaHub dispatches the same Codex Responses, Chat Completions, streaming,
tool-call, compaction, model-catalog, public file/audio/image, and native
WebSocket implementations as Relaydeck. A share key limits candidate accounts
and accounting; it does not create a second protocol adapter. Public file
metadata is isolated per share session. QuotaHub accepts native `/v1/messages`
for manually added AIS projects and linked Claude accounts. Codex-native backend
API and WebSocket routes remain Codex-only.

Client-facing gateway route classification and dispatch live in
`../src/gateway-dispatch.js`, shared with Relaydeck. Future proxy or
compatibility functionality must be added to that shared layer so it reaches
both products automatically; QuotaHub-specific code is limited to share-key
authorization, session selection, and settlement.

## Configuration

```text
POOL_PORT
POOL_BIND_HOST
POOL_ALLOWED_HOSTS
POOL_ALLOWED_ORIGINS
POOL_FIREWALL_ALLOWLIST
POOL_TRUSTED_PROXIES
POOL_COOKIE_SECURE
POOL_PUBLIC_BASE_PATH
POOL_DATA_DIR
POOL_QUOTA_REFRESH_INTERVAL_MS
POOL_AI_QUOTA_SERVICE_TOKEN
POOL_AI_QUOTA_DELAY_MS
POOL_AI_QUOTA_REFRESH_INTERVAL_MS
POOL_AI_QUOTA_TIMEOUT_MS
POOL_TOKEN_REFRESH_INTERVAL_MS
POOL_SMTP_HOST
POOL_SMTP_PORT
POOL_SMTP_SECURE
POOL_SMTP_USER
POOL_SMTP_PASS
POOL_SMTP_FROM
POOL_EMAIL_DELIVERY_INTERVAL_MS
POOL_PRODUCT_CLEANUP_INTERVAL_MS
POOL_BACKUP_INTERVAL_MS
POOL_CLAUDE_CONFIG_JSON
POOL_CODEX_HOST_CIRCUIT_ENABLED
POOL_CODEX_HOST_FAILURE_THRESHOLD
POOL_CODEX_HOST_FAILURE_WINDOW_MS
POOL_CODEX_HOST_COOLDOWN_MS
POOL_CODEX_HOST_MAX_ENTRIES
POOL_CODEX_WEBSOCKET_KEEPALIVE_MS
POOL_CODEX_WEBSOCKET_IDLE_MS
POOL_CODEX_WEBSOCKET_FRAME_BYTES
POOL_CODEX_WEBSOCKET_PENDING_BYTES
POOL_CODEX_WEBSOCKET_BACKPRESSURE_BYTES
POOL_CODEX_STREAM_BOOTSTRAP_BUFFERING
POOL_CODEX_STREAM_BOOTSTRAP_BYTES
POOL_CODEX_STREAM_BOOTSTRAP_EVENTS
POOL_CODEX_STREAM_BOOTSTRAP_TIMEOUT_MS
POOL_CODEX_OPTIMIZE_MULTI_AGENT_V2
POOL_CODEX_ORPHAN_DELEGATION_COMPATIBILITY
```

The defaults bind to `127.0.0.1:3010`, allow localhost hosts, refresh Codex
sharing quota every 5 minutes, check due tokens every hour, and store data in
`node/pool/.data`. When
`POOL_AI_QUOTA_SERVICE_TOKEN` is configured, the delayed Claude/AIS integration
queries the fixed `https://loop.shopee.io` endpoint hourly with a 30-second
timeout. It uses the returned Claude/AIS balance as the sharing balance while
the provider's live quota remains authoritative. The service token remains
server-side and must not be committed. SMTP is optional; when enabled, port
`587` and a 15-second outbox delivery interval are the defaults.

`POOL_CLAUDE_CONFIG_JSON` is the Pool-only bounded JSON configuration for
Claude request shaping, header defaults, aliases, exclusions, retry, cooling,
and cloak controls. It does not inherit Relaydeck environment variables or
affect QuotaHub's delayed Loop balance policy for Claude sharing.

The shared Codex origin circuit is enabled conservatively by default. Configure
its Pool-only behavior with `POOL_CODEX_HOST_CIRCUIT_ENABLED`,
`POOL_CODEX_HOST_FAILURE_THRESHOLD`, `POOL_CODEX_HOST_FAILURE_WINDOW_MS`,
`POOL_CODEX_HOST_COOLDOWN_MS`, and `POOL_CODEX_HOST_MAX_ENTRIES`.

Set `POOL_PUBLIC_BASE_PATH=/quotahub` when a reverse proxy or API Gateway
publishes QuotaHub below that path and strips the prefix before forwarding.
The dashboard then loads its assets and management APIs from `/quotahub/`,
and displays `https://host/quotahub/v1` as the API base URL. Leave it unset
when the product is served from `/`.

## Validation

```bash
cd node
npm run pool:build
node --test pool/test/*.test.js
node --check pool/src/*.js
```
