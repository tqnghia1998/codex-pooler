# Codex Pool Standalone Implementation Plan

## Goal

Build quota sharing as a separate product under `node/pool/`. Codex Pool reuses
the maintained Node provider and proxy modules, but Relaydeck does not
initialize or expose product accounts, authentication, offers, tickets,
sessions, share keys, or product storage.

## Ownership

```text
node/
  src/                 Relaydeck and reusable gateway modules
  ui/                  Relaydeck operator dashboard
  public/              Relaydeck generated UI
  .data/               Relaydeck runtime data
  pool/
    src/               Codex Pool server, account store, and login manager
    ui/                Codex Pool UI
    public/            Codex Pool generated UI
    test/              Codex Pool tests
    .data/             Codex Pool runtime data
```

Codex Pool may import provider adapters, request translation, model discovery,
pricing, routing, and WebSocket proxy code from `node/src/`. Shared modules keep
share-session support optional. Relaydeck never passes a product store into
those hooks.

## Isolation Contract

- Relaydeck remains on port `3000`; Codex Pool defaults to `3010`.
- Relaydeck uses `CODEX_POOLER_*`; Codex Pool uses `POOL_*`.
- Relaydeck uses `node/.env`; Codex Pool uses `node/pool/.env`.
- Relaydeck uses `node/.data`; Codex Pool uses `node/pool/.data`.
- Codex Pool cookies use the `codex_pool_*` namespace.
- Codex Pool session keys use the `cp_share_...` prefix; consumer personal
  routing keys use `cp_personal_...`.
- Relaydeck has no `/auth/codex/*` or `/api/pool/*` product routes.
- Codex Pool has no upstream administration routes or operator-key fallback.
- Codex Pool proxy traffic accepts only an active share-session key.

## Product Data

Codex Pool owns two encrypted stores inside `pool/.data`:

- `db.sqlite` plus `.key`: private imported Codex upstreams and gateway runtime
  state.
- `pool.sqlite` plus `.pool-key`: accounts, browser sessions, login attempts,
  upstream ownership links, offers, tickets, share sessions, share-key hashes,
  settlements, and audit events.

No product table or column is added to Relaydeck's database. Foreign upstream
IDs in `pool.sqlite` refer only to Codex Pool's private gateway store.

## Authentication

1. The user starts `codex login --device-auth` with a temporary `CODEX_HOME`,
   or pastes an existing Codex `auth.json` into the browser login dialog.
2. Device login uses a short-lived opaque login cookie. Pasted login sends the
   JSON once to the product server without saving it in browser
   storage.
3. Both paths validate a stable token subject, import or refresh the Codex
   credentials in the private gateway store, and link the upstream to the
   product account.
4. Successful login issues an opaque account session and CSRF cookie.
5. Tokens and `auth.json` are never returned by the API or stored in
   `localStorage`.

Google OAuth is not required. Codex identity and credentials come from the same
device-login result.

## Sharing Model

- Offers are public to all signed-in accounts and contain one provider
  upstream plus a shareable dollar quota.
- Consumers create tickets for an offer's currently available quota.
- Providers approve, modify and approve, or reject.
- Approval atomically rechecks available offer capacity and creates a share
  session.
- Sessions track provider, consumer, upstream, granted quota, consumed quota,
  remaining quota, status, and a share key.
- Providers can pause, resume, resize, or revoke.
- Providers and consumers can reveal the current key until the session is
  revoked; providers can rotate it or revoke the session.
- Consumers can reveal one personal key that routes a new request to an active
  session with the most remaining quota. Session and Responses continuations
  stay pinned to their selected share session.

The first version intentionally omits visibility controls, request
minimums/maximums, model allowlists, concurrency limits, messages, automatic
approval, and provider reserves.

## Gateway Enforcement

For every `share_session` request:

1. A session key must map to an active session with positive remaining quota.
   A personal key must map to at least one such consumer session.
2. Routing is hard-pinned to the approved provider upstream.
3. Headers and continuation pins cannot select another upstream.
4. Existing credential, provider health, model capability, pacing, and
   compatibility behavior still applies.
5. Successful priced usage settles idempotently against the provider upstream
   and the selected session grant.
6. Exhausted, paused, and revoked sessions are denied before new dispatches.

Exact cost is known after completion, so the final request may exceed the
remaining grant. The full cost is recorded and later requests are blocked.

## Routes

Product management is under `/api/pool/*`; Codex device authentication remains
under `/auth/codex/*` on the independent product origin. Model and
Codex-compatible proxy routes are exposed on the same origin and accept only
`cp_share_...` keys.

## Validation

- Product store, account ownership, offer capacity, ticket approval,
  repeatable key reveal, session lifecycle, and idempotent settlement tests.
- HTTP account-session, origin, CSRF, and authorization tests.
- HTTP and WebSocket hard-pinning, exhaustion, pause, and settlement tests.
- Isolation test with separate Relaydeck and Codex Pool data roots proving:
  Relaydeck product routes are absent; cookies do not overlap; Codex Pool does
  not create product files in Relaydeck data; Codex Pool mutations do not
  change Relaydeck's database hash.
- Build and syntax checks for both products.
- Desktop and mobile browser QA for the standalone UI.
