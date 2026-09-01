# Codex Share

Codex Share is a standalone quota-sharing product. It has its own server, UI,
cookies, environment, and runtime data. It reuses the Node gateway's provider
adapters and proxy compatibility code, but it does not run inside Relaydeck and
never opens Relaydeck's `node/.data`.

Codex Share is for informal sharing between friends. Offers and requests are
free: the product has no payments, pricing marketplace, ratings, reputation
score, or service guarantee. Providers can pause or revoke access at any time,
and consumers should treat shared quota as best-effort.

## Run

Node 20+ and the Codex CLI are required.

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
- Account cookies: `codex_pool_session`, `codex_pool_csrf`,
  `codex_pool_login`
- Share keys: `cp_share_...`
- Personal keys: `cp_personal_...`

`pool/.data/db.sqlite` and `pool/.data/.key` are the product's private gateway
store for imported Codex credentials. `pool/.data/pool.sqlite` and
`pool/.data/.pool-key` hold product accounts, offers, tickets, sessions, key
hashes, and audit events. Back up all four files together.

Relaydeck uses `node/.data`, port `3000`, and its own operator authentication.
Starting either product does not start, configure, migrate, or mutate the
other. `POOL_DATA_DIR` must not point to `node/.data`; Codex Share startup
rejects that configuration.

## Authentication

Users can sign in through `codex login --device-auth` or paste the contents of
an existing Codex `auth.json` into the login dialog. Device login runs the CLI
with a temporary isolated `CODEX_HOME`. Both paths validate the stable token
issuer and subject, import or refresh the credentials in the private encrypted
gateway store, and create or find the same product account. Pasted credentials
are used only for the import request and are not saved in browser storage.
The paste dialog accepts raw JSON and JSON surrounded by standalone Markdown
code-fence lines. When Codex rotates an enterprise SSO subject, an import with
the same issuer and subject refreshes that same Codex Share account. A ChatGPT
account ID or email is not used to merge Pool identities because Business
workspaces can share those values across different people.

Provider tokens are never included in ordinary browser account or upstream
responses and are never placed in `localStorage`. The signed-in owner can
explicitly reveal the current credential export from a linked provider card.
Browser sessions use opaque cookies and mutating management requests
require a session-bound CSRF token.

Codex Share account sessions are permanent until logout or revocation. The
browser cookies are issued with a ten-year lifetime; clearing cookies still
requires signing in again in that browser.

After sign-in, Codex Share waits for an immediate best-effort Codex quota
refresh before completing the browser login, then
refreshes every linked Codex account automatically every minute in batches of
ten. The dashboard polls this stored quota state and can also refresh it
manually. Some Codex plans expose only a percentage or provider units; Codex
Share shows that reported value rather than estimating a dollar balance.
At startup and once per hour, Codex Share also refreshes any refreshable Codex token
that expires within 12 hours. Transient refresh failures retry with bounded
exponential backoff; revoked or missing refresh tokens require the provider to
sign in again.
When a provider's Codex credentials need reauthentication, its quota card shows
the affected state and offers both sign-in and `auth.json` import actions.
Offers, pending tickets, and share sessions show a sanitized provider issue to
both providers and consumers when the provider needs reauthentication, has a
token-refresh failure, is in cooldown, or has exhausted its provider quota.

After signing in, a user can also add an AISwitch project by entering its
project ID and project key. AISwitch does not expose a quota query to this
product, so its owner sets the current **manual share budget** in USD. Codex
Share reserves offers against that amount and decrements it only for settled
usage through share sessions. Updating the budget replaces the pool-side
remaining amount; it does not query or change AISwitch, and outside use of the
project is not visible here. Use **Add AISwitch project** and its **How to get
AISwitch project** guide to retrieve `project_id` and `api_key` from Compass.

## Sharing Flow

1. A provider publishes an offer for one imported Codex account or manually
   added AISwitch project and a dollar
   quota. The offer reserves that amount from the provider's currently
   offerable quota.
2. A consumer requests a dollar quota through a ticket.
3. The provider approves the request, changes the approved amount, or rejects
   it.
4. Approval atomically creates a share session and a `cp_share_...` key.
5. The consumer can instead reveal one `cp_personal_...` key that routes each
   request across their active share sessions.
6. Successful priced usage is settled against the grant.

Every new Codex Share account receives a `Default` personal key automatically.
Its secret is encrypted at rest and can be revealed or rotated from the
dashboard.

Providers can pause, resume, resize, top up, revoke, or replace a session key.
Providers and consumers can reveal the current key while the session remains
until it is revoked. Replacing a key immediately invalidates the previous key.
Session keys are pinned to the approved provider upstream. A personal key
selects an active session with the most remaining quota, keeps normal
conversation and Responses continuations on that selected session, and moves
to another session only for a new request after the prior session becomes
unavailable. Neither key type can access product management routes.
If every active provider session needs Codex reauthentication, requests return
`share_provider_reauth_required` until a provider signs in again.

Offers, tickets, sessions, personal keys, and public quota requests expire.
Offer and session expiry is bounded by the provider quota reset when that reset
is known. Creating or resizing a grant is rejected atomically when it would
overcommit the provider's current quota. If provider quota later falls below
existing commitments, affected offers and sessions remain visible as
underfunded but cannot accept or route new work beyond their backed amount.
Providers can extend an active session's expiry from **Resize share session**;
the new expiry cannot shorten the session or exceed the provider quota reset
or the 30-day session limit.
Providers can pause all sharing without deleting grants, or revoke all sharing
to close offers, reject pending tickets, and revoke sessions for one Codex
account.

Consumers can create multiple named personal keys, optionally with an expiry,
so each device or client can be rotated or revoked independently. The dashboard
shows privacy-safe activity totals: request and success counts, spend, recent
models, last use, and sanitized failure codes. It never stores prompts or
responses in this activity history.

## Friend Requests

A user who cannot find a suitable offer can post one public request for the
amount they need. Posting a new request cancels their previous active request.
Friends can use that amount and expiry to prefill a matching offer; the normal
manual ticket approval flow still applies. Requests contain no payment,
message, rating, or guarantee fields.

## Email

Codex Share writes notification events to a durable email outbox. With SMTP
configured, it sends them in the background and retries failures with bounded
backoff. Without SMTP, email notifications are skipped and pending outbox
entries are removed. There is no in-app notification inbox.

Email events cover ticket creation and resolution, session expiry and
revocation, key replacement and revocation, provider pause/resume,
provider-unavailable/recovered/reset transitions, and session usage crossing
80%, 95%, or 100%. Email delivery uses the account email obtained from Codex
sign-in.

The product database runs cleanup at startup and every six hours. Expired login
attempts are retained for 24 hours, personal-key routing pins for 24 hours,
completed email records for 30 days, terminal reservations and settlement
dedupe records for 30 days, audit events for 90 days, and terminal offers,
tickets, sessions, and quota requests for 180 days. Active account sessions are
permanent and never expire; records for sessions explicitly revoked by logout
are retained for 180 days. SQLite reuses pages freed by cleanup; it does not run
a full `VACUUM` during normal operation.

## API

```text
POST   /auth/codex/start
POST   /auth/codex/import
GET    /auth/codex/status
DELETE /auth/codex/login
POST   /auth/logout

GET    /api/pool/me
GET    /api/pool/personal-key
POST   /api/pool/personal-key/reveal
POST   /api/pool/personal-key/rotate
GET    /api/pool/personal-keys
POST   /api/pool/personal-keys
POST   /api/pool/personal-keys/:id/reveal
POST   /api/pool/personal-keys/:id/rotate
POST   /api/pool/personal-keys/:id/revoke
GET    /api/pool/upstreams
POST   /api/pool/upstreams/aiswitch                 { projectId, projectKey, quotaDollars }
GET    /api/pool/upstreams/credentials
POST   /api/pool/upstreams/:id/refresh-quota
PUT    /api/pool/upstreams/:id/manual-budget        { quotaDollars }
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
POST   /api/pool/quota-requests/:id/cancel

GET    /v1/usage
GET    /v1/models
POST   /v1/responses
GET    /v1/responses                 # WebSocket upgrade
POST   /v1/chat/completions
POST   /v1/messages                  # AISwitch only
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

Gateway routes require a valid `cp_share_...` or `cp_personal_...` key in a
Bearer token; `POST /v1/messages` also accepts that key in `x-api-key`.
Personal-key model lists are the union of active-session catalogs. Ordinary
Relaydeck API keys are rejected.

Codex Share dispatches the same Codex Responses, Chat Completions, streaming,
tool-call, compaction, model-catalog, public file/audio/image, and native
WebSocket implementations as Relaydeck. A share key limits candidate accounts
and accounting; it does not create a second protocol adapter. Public file
metadata is isolated per share session. Codex Share accepts `/v1/messages`
for manually added AISwitch projects. Codex-native backend API and
WebSocket routes remain Codex-only.

Client-facing gateway route classification and dispatch live in
`../src/gateway-dispatch.js`, shared with Relaydeck. Future proxy or
compatibility functionality must be added to that shared layer so it reaches
both products automatically; Codex Share-specific code is limited to share-key
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
POOL_CODEX_CLI
POOL_DATA_DIR
POOL_QUOTA_REFRESH_INTERVAL_MS
POOL_TOKEN_REFRESH_INTERVAL_MS
POOL_SMTP_HOST
POOL_SMTP_PORT
POOL_SMTP_SECURE
POOL_SMTP_USER
POOL_SMTP_PASS
POOL_SMTP_FROM
POOL_EMAIL_DELIVERY_INTERVAL_MS
POOL_PRODUCT_CLEANUP_INTERVAL_MS
```

The defaults bind to `127.0.0.1:3010`, allow localhost hosts, use the `codex`
executable, refresh quota every 60 seconds, check due tokens every hour, and
store data in `node/pool/.data`. SMTP is optional; when enabled, port `587` and
a 15-second outbox delivery interval are the defaults.

## Validation

```bash
cd node
npm run pool:build
node --test pool/test/*.test.js
node --check pool/src/*.js
```
