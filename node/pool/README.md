# Codex Pool

Codex Pool is a standalone quota-sharing product. It has its own server, UI,
cookies, environment, and runtime data. It reuses the Node gateway's provider
adapters and proxy compatibility code, but it does not run inside Relaydeck and
never opens Relaydeck's `node/.data`.

## Run

Node 20+ and the Codex CLI are required.

```bash
cd node
npm install
cp pool/.env.example pool/.env
npm run pool:start
# open http://localhost:3010
```

Use `npm run pool:dev` for Node watch mode. The product loads `pool/.env` when
that file exists. Its variables use the `POOL_*` prefix; Relaydeck's
`CODEX_POOLER_*` variables are not product configuration.

## Product Boundary

- Entry point: `pool/src/server.js`
- UI source: `pool/ui/`
- Generated UI: `pool/public/`
- Runtime data: `pool/.data/`
- Default port: `3010`
- Account cookies: `codex_pool_session`, `codex_pool_csrf`,
  `codex_pool_login`
- Share keys: `cp_share_...`

`pool/.data/db.sqlite` and `pool/.data/.key` are the product's private gateway
store for imported Codex credentials. `pool/.data/pool.sqlite` and
`pool/.data/.pool-key` hold product accounts, offers, tickets, sessions, key
hashes, and audit events. Back up all four files together.

Relaydeck uses `node/.data`, port `3000`, and its own operator authentication.
Starting either product does not start, configure, migrate, or mutate the
other.

## Authentication

Users can sign in through `codex login --device-auth` or paste the contents of
an existing Codex `auth.json` into the login dialog. Device login runs the CLI
with a temporary isolated `CODEX_HOME`. Both paths validate the stable token
issuer and subject, import or refresh the credentials in the private encrypted
gateway store, and create or find the same product account. Pasted credentials
are used only for the import request and are not saved in browser storage.
The paste dialog accepts raw JSON and JSON surrounded by standalone Markdown
code-fence lines. When Codex rotates an enterprise SSO subject, an import with
the same issuer and subject refreshes that same Codex Pool account. A ChatGPT
account ID or email is not used to merge Pool identities because Business
workspaces can share those values across different people.

Provider tokens are never returned to browser JavaScript or placed in
`localStorage`. Browser sessions use opaque cookies and mutating management
requests require a session-bound CSRF token.

After sign-in, Codex Pool queues an immediate provider quota refresh, then
refreshes every linked Codex account automatically every minute in batches of
ten. The dashboard polls this stored quota state and can also refresh it
manually. Some Codex plans expose only a percentage or provider units; Codex
Pool shows that reported value rather than estimating a dollar balance.

## Sharing Flow

1. A provider publishes an offer for one imported Codex account and a dollar
   quota.
2. A consumer requests a dollar quota through a ticket.
3. The provider approves the request, changes the approved amount, or rejects
   it.
4. Approval atomically creates a share session and a `cp_share_...` key.
5. The consumer uses that key against the Codex Pool origin.
6. Successful priced usage is settled against the grant.

Providers can pause, resume, resize, revoke, or replace a session key.
Providers and consumers can reveal the current key while the session remains
until it is revoked. Replacing a key immediately invalidates the previous key.
Share keys are pinned to the approved provider account and cannot access
product management routes.

## API

```text
POST   /auth/codex/start
POST   /auth/codex/import
GET    /auth/codex/status
DELETE /auth/codex/login
POST   /auth/logout

GET    /api/pool/me
GET    /api/pool/upstreams
POST   /api/pool/upstreams/:id/refresh-quota
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

GET    /v1/usage
GET    /v1/models
POST   /v1/responses
GET    /v1/responses                 # WebSocket upgrade
POST   /v1/chat/completions

# Reused Codex-compatible proxy aliases
POST   /backend-api/codex/responses
GET    /backend-api/codex/responses  # WebSocket upgrade
POST   /backend-api/codex/v1/responses
POST   /backend-api/codex/v1/chat/completions
GET    /backend-api/codex/models
```

Model routes require a valid `cp_share_...` key. Ordinary Relaydeck API keys
are rejected.

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
```

The defaults bind to `127.0.0.1:3010`, allow localhost hosts, use the `codex`
executable, refresh quota every 60 seconds, and store data in
`node/pool/.data`.

## Validation

```bash
cd node
npm run pool:build
node --test pool/test/*.test.js
node --check pool/src/*.js
```
