# Phase 8: Compatibility Fixture Automation

Status: complete

Last reviewed: 2026-08-16

## Goal

Turn sanitized protocol captures from new Codex and Claude client releases into deterministic,
content-free compatibility checks. The checks replay the proxy's real request projection and make
protocol drift reviewable without contacting a provider or changing runtime compatibility facts.

## Safety Contract

- Fixtures contain only synthetic request values and public protocol metadata.
- Never retain authorization, cookies, hosts, account/project IDs, real model IDs, instructions,
  message text, tool arguments, provider messages, or response bodies.
- Rejection captures may retain only the HTTP status and structured `type`, `code`, and `param`
  values plus their field paths.
- Fixture strings and files are bounded. Secret-like values, forbidden keys, control characters,
  and unrecognized schema fields fail validation.
- Replay never contacts Codex or Compass.
- Drift reports never update fixtures, compatibility facts, or fallback allowlists.
- Updating expected results requires an explicit local `--update` invocation and code review.

## Fixture Contract

Each `fixtures/compatibility/*.json` file records:

- schema version and stable fixture ID;
- client family/version and transport profile;
- normalized public negotiation headers;
- synthetic request route/body and optional compatibility state;
- expected target route, protocol fingerprint, projected JSON shape, and structured rejection shape.

Projected shape records sorted JSON paths and primitive/container types plus sorted values of
`type` discriminator fields. It intentionally records no ordinary string or numeric values.

Supported profiles:

- `codex-public-http`
- `codex-public-sse`
- `codex-native-http`
- `codex-compact-http`
- `codex-public-websocket`
- `codex-native-websocket`
- `compass-anthropic-messages`

## TODO

- [x] Define the bounded, content-free fixture schema.
- [x] Reuse the live HTTP and public WebSocket request projection.
- [x] Add strict fixture loading, validation, and sanitization checks.
- [x] Add deterministic replay and categorized drift reporting.
- [x] Seed fixtures for every supported transport profile.
- [x] Add `npm run compatibility:check`.
- [x] Add focused tests for validation, drift, determinism, and all profiles.
- [x] Update `README.md` and `CODEX_PROXY_TODO.md`.
- [x] Run the complete Node validation and perform a second review.

## Capture Workflow

1. Record only the client version, route, negotiation headers, and JSON field/type structure.
2. Replace model names and every text-bearing value with fixed synthetic fixture values.
3. Remove all credentials, host/account/project identifiers, free-form metadata, and provider text.
4. Keep a rejection only when it can be represented using status plus structured
   `type`/`code`/`param`.
5. Add the sanitized fixture, run `npm run compatibility:update`, inspect the diff, then run
   `npm run compatibility:check`.

The update command refreshes structural expectations only. A new field remains a visible fixture
and report diff, and runtime compatibility allowlists can change only through reviewed source
changes.
