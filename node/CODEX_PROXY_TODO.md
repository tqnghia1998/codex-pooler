# Codex Proxy Reliability and Compatibility TODO

Status: Phases 1 through 10 complete; active provider request-shape probes remain intentionally deferred

Last reviewed: 2026-08-16

Reference audit:

- OpenCodex `v2.21.0`
- Commit `2a1604e37f5123e301f8282741734195e524f47f`
- Scope: Codex behavior only; OpenCodex's universal-provider architecture is out of scope

## Goals

- Discover newly available Codex models without requiring a Relaydeck release.
- Stop routing to an account immediately when upstream explicitly reports quota exhaustion.
- Avoid trying every account during a shared ChatGPT origin or local-network outage.
- Preserve session affinity, response continuation affinity, spending caps, explicit pins, and safe
  pre-output failover.
- Keep all retained state bounded and safe for the existing single-process architecture.
- Degrade to known-good behavior when discovery, quota metadata, or new response fields are invalid.

## Non-goals

- Do not modify the Elixir reference implementation.
- Do not add OpenCodex's third-party provider adapters, combos, sidecars, Codex shim, profile
  injection, or continuation spill storage.
- Do not automatically consume plan reset credits.
- Do not make successful request payloads or response content persistent.
- Do not infer account failure from caller errors or untrusted error-message text.

## Phase 0: Contracts and Fixtures

- [x] Document the model-catalog aggregation contract:
  - [x] A model reported by one usable Codex account is advertised.
  - [x] A model is routed only to accounts known to support it.
  - [x] Unknown account capability remains eligible until authoritative discovery says otherwise.
  - [x] Explicit per-upstream and per-scope model restrictions remain authoritative.
  - [x] The static catalog remains the cold-start and no-account fallback.
- [x] Document failure classes and their routing effects:
  - [x] `2xx`: success and recovery evidence.
  - [x] `401/403`: credential failure after the existing refresh retry.
  - [x] `402/429`: immediate quota cooldown.
  - [x] Other `4xx`: caller or compatibility failure with no account-health penalty.
  - [x] `5xx`, timeout, connection reset, and TLS failure: account-transient evidence.
  - [x] Proven DNS or pre-connect reachability failure: host-level evidence.
- [x] Add reusable test coverage for model discovery responses, `Retry-After`, quota reset headers,
  malformed headers, transport error cause chains, and concurrent requests.
- [x] Define bounded cooldown defaults before implementation. Phase 2 intentionally has no runtime
  override names; configuration belongs to a later operator-policy phase.

## Phase 1: Dynamic Codex Model Catalog

### Model discovery module

- [x] Add a dedicated `src/codex-model-catalog.js` module.
- [x] Fetch `/backend-api/codex/models` with the current Codex protocol version and validated
  protocol headers.
- [x] Use eligible Codex accounts and the normal credential-refresh path.
- [x] Bound the request header timeout, body idle timeout, response bytes, and accepted model count.
- [x] Validate model identifiers and ignore malformed rows without trusting arbitrary metadata.
- [x] Preserve safe upstream fields needed by native Codex clients, while synthesizing stable
  OpenAI-compatible fields for `/v1/models`.

### Cache behavior

- [x] Cache successful discovery per Codex account for five minutes.
- [x] Keep the last-known-good result after its freshness period.
- [x] Suppress repeated failed discovery attempts for 30 seconds.
- [x] Coalesce concurrent discovery for the same account and credential generation.
- [x] Fence cache writes so discovery started with replaced credentials cannot publish stale data.
- [x] Invalidate or refresh an account's catalog after account deletion, token replacement, reauthentication,
  or an authoritative model-not-found response.
- [x] Bound retained account catalogs and prune deleted or least-recently-used entries.

### Aggregation and routing

- [x] Build one advertised catalog from usable account catalogs plus the static fallback.
- [x] Keep deterministic model ordering and ETag generation.
- [x] Record per-account model support separately from operator routing restrictions.
- [x] Prefer authoritative live capability data, but never let a discovery outage remove the
  last-known-good model list.
- [x] Treat an authoritative empty catalog carefully:
  - [x] Do not erase another account's valid models.
  - [x] Do not route known unsupported models to that account.
  - [x] Retain the static fallback when no account has a known-good catalog.
- [x] Update image host-model selection to use the same catalog service.
- [x] Update `/v1/models`, `/backend-api/codex/models`, and model ETag headers to use the aggregated
  catalog.

### Observability and tests

- [x] Expose sanitized catalog status: source, freshness, last success, last failure class, and
  model count. Do not expose credentials or raw upstream errors.
- [x] Add tests for fresh cache hits, stale-if-error fallback, cold-start fallback, ETags,
  concurrent coalescing, generation fencing, account deletion, malformed/oversized responses,
  heterogeneous accounts, and model-specific routing.
- [x] Update `README.md` to remove the hardcoded-catalog limitation and describe fallback behavior.

### Phase 1 acceptance

- [x] A newly returned upstream model appears without a process restart or code change.
- [x] Ten concurrent model-list requests trigger at most one discovery request per selected account.
- [x] A discovery outage continues serving the last-known-good catalog.
- [x] A model discovered only on account A is never sent to account B once B has authoritative
  capability data.
- [x] Existing explicit model restrictions and scope restrictions continue to pass unchanged.

## Phase 2: Status-aware Account Cooldowns

### Failure classification

- [x] Add a single bounded classifier shared by HTTP, SSE-first-event, raw HTTP, and WebSocket
  connection paths.
- [x] Classify from status codes, validated headers, structured upstream error fields, and bounded
  transport error codes.
- [x] Never classify from arbitrary error-message substrings.
- [x] Treat redirects and caller `4xx` responses as neutral account-health evidence.
- [x] Treat `402` as quota exhaustion where Codex returns it for plan limits.

### Cooldown calculation

- [x] Parse `Retry-After` delta-seconds and HTTP-date forms.
- [x] Reject non-finite, negative, malformed, or excessively large values.
- [x] Honor valid explicit `Retry-After` up to a documented maximum.
- [x] Parse known Codex quota reset headers in seconds or milliseconds.
- [x] Cap reset-derived cooldowns more tightly than explicit `Retry-After`.
- [x] Use a bounded default cooldown when no valid timing metadata exists.
- [x] Preserve and relay the upstream `Retry-After` value when returning the terminal failure.

### Account health state

- [x] Extend circuit state with failure class, cooldown source, cooldown start, and next eligible
  time.
- [x] Open an account cooldown immediately on one `402/429`.
- [x] Keep generic transient failures on threshold-based escalation.
- [x] Mark a Codex account reauthentication-required after the existing refresh retry still returns
  `401/403`.
- [x] Clear stale session affinity when an account becomes quota-cooled or reauthentication-required.
- [x] Preserve response continuation safety: do not silently move a committed continuation to a
  different account.
- [x] Add generation-fenced half-open/probe leases so stale in-flight success cannot clear a newer
  cooldown.
- [x] Permit bounded early probes only for reset-derived cooldowns.
- [x] Never probe before an explicit `Retry-After` expires.
- [x] Add an operator action to clear an account cooldown without deleting unrelated history.

### Transport coverage

- [x] Apply identical account-health settlement to:
  - [x] Public Responses HTTP and SSE.
  - [x] Chat Completions adapters.
  - [x] Native Codex HTTP routes.
  - [x] Public and native Responses WebSockets.
  - [x] Compatibility and image/file/audio helper routes that select Codex accounts.
- [x] Ensure client cancellation and local admission failures do not count against an account.
- [x] Ensure a successful terminal response clears only eligible transient state.

### Tests

- [x] Add table-driven tests for every failure class.
- [x] Test `Retry-After` seconds, HTTP dates, zero, malformed values, and maximum clamping.
- [x] Test seconds- and milliseconds-based reset timestamps.
- [x] Test immediate same-request failover after `429`.
- [x] Test explicit/session pins and continuation pins under cooldown.
- [x] Test probe success, probe failure, concurrent probes, and stale probe generations.
- [x] Test equivalent behavior across HTTP, SSE, raw routes, compatibility helpers, and WebSockets.

### Phase 2 acceptance

- [x] One explicit quota response removes the account from ordinary selection until its cooldown
  permits retry.
- [x] Caller mistakes never cool an account.
- [x] A successful stale request cannot clear a newer quota cooldown.
- [x] All transports agree on failure classification and cooldown behavior.

## Phase 3: Shared Codex Host Health

### Conservative transport attribution

- [x] Add a host-health module keyed by normalized Codex origin.
- [x] Walk a bounded error `cause` chain and recognize only proven pre-connect codes:
  `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ENETUNREACH`, `ENETDOWN`, and `EHOSTUNREACH`.
- [x] Keep timeout, `ECONNRESET`, `EPIPE`, TLS, redirect, HTTP, authentication, and unknown failures
  account-attributed.
- [x] Reset host failure evidence when any admitted request receives a real HTTP response.

### Shared circuit

- [x] Make the host circuit configurable and initially disabled or conservatively thresholded.
- [x] Bound host-health entries and failure windows.
- [x] Issue generation-fenced admission leases.
- [x] Open a short shared cooldown after the configured number of proven pre-connect failures.
- [x] Admit at most one half-open probe after cooldown.
- [x] Return a retryable local failure with `Retry-After` while the host circuit is open.
- [x] Do not charge blocked host-circuit requests to an account's circuit.

### Tests and acceptance

- [x] Test bounded cause traversal and false-positive cases.
- [x] Test that one DNS outage does not iterate across every Codex account.
- [x] Test that an HTTP response closes host reachability state even if its status is an error.
- [x] Test concurrent requests, stale leases, half-open admission, and bounded pruning.
- [x] Confirm ordinary account failover is unchanged when the host circuit is disabled.

## Phase 4: Routing Strategies

- [x] Keep the current priority plus least-recent-success behavior as the default.
- [x] Add an optional `most-remaining-quota` strategy.
- [x] Compare normalized remaining percentages only within the same priority tier.
- [x] Keep accounts with unknown quota eligible and avoid always placing them last.
- [x] Preserve explicit account selection, session affinity, continuation affinity, capability
  filtering, spending caps, and circuit exclusions ahead of strategy ordering.
- [x] Add deterministic tie-breaking to prevent request-order instability.
- [x] Consider an explicit round-robin strategy only if operators need predictable distribution.
  Current least-recent-success behavior already provides fair distribution without another mode.
- [x] Do not add fill-first unless a concrete account-draining workflow requires it.
- [x] Add dashboard/API configuration and dry-run routing diagnostics.
- [x] Test stale quota, unknown quota, equal quota, priority tiers, cooldown recovery, and affinity.

## Phase 5: Optional Request Pacing

- [x] Keep pacing opt-in.
- [x] Prefer per-account pacing so one account's limit does not delay healthy accounts.
- [x] Support account-wide and optional model-specific minimum start intervals.
- [x] Make waits abort-aware.
- [x] Bound queue depth and maximum queued age.
- [x] Return `429` with a computed `Retry-After` when the local queue is full or expired.
- [x] Do not interpret pacing admission failure as account or host failure.
- [x] Expose only queue depth, next slot, and last start time.
- [x] Test fairness, cancellation, queue overflow, expired entries, account deletion, and config
  changes while requests are queued.

## Phase 6: Readiness and Diagnostics

### Readiness

- [x] Keep `/healthz` as immediate process liveness.
- [x] Make `/readyz` exact-GET readiness with `200` only after:
  - [x] SQLite and encryption key initialization succeed.
  - [x] API-key configuration succeeds.
  - [x] Initial token recovery has settled enough to identify usable accounts.
  - [x] Initial quota refresh has settled or degraded safely.
  - [x] Initial model discovery has succeeded or selected a documented fallback.
- [x] Return sanitized `pending`, `ready`, or `failed` state.
- [x] Return `503` with `Retry-After: 1` while pending or failed.
- [x] Never expose credential, path, provider-body, or raw exception details.

### Routing diagnostics

- [x] Record bounded structured exclusion reasons for terminal failures.
- [x] Add attempt timings for queue wait, credential preparation, connection, first response
  header, first SSE event, and terminal completion.
- [x] Keep successful detailed traces in memory only unless a later operator requirement justifies
  persistence.
- [x] Continue retaining at most 100 terminal failure records.
- [x] Sanitize hostnames, tokens, account IDs, request bodies, and upstream response bodies.

## Phase 7: Passive Compatibility Learning

- [x] Add bounded passive structured-evidence observation and repeated-evidence promotion.
- [x] Version and hash normalized Codex HTTP/WebSocket and Anthropic protocol fingerprints.
- [x] Persist bounded generation-fenced facts.
- [x] Add sanitized compatibility status, reset APIs, and dashboard controls.
- [x] Add focused compatibility, fingerprint, sanitization, and transport regression tests.
- [x] Remove metadata-only synthetic probes that duplicated model and quota refresh without testing
  request compatibility.
- [ ] Implement active request-shape probes only after a non-billable provider validation boundary is
  proven.

## Phase 8: Compatibility Fixture Automation

- [x] Add a strict content-free fixture schema for Codex and Claude client protocol captures.
- [x] Replay fixtures through the live HTTP and public WebSocket request projection.
- [x] Cover public HTTP/SSE, native HTTP, compact, public/native WebSocket, and Compass Messages.
- [x] Record only normalized negotiation fingerprints, JSON paths/types, `type` discriminators, and
  structured rejection status/code/param fields.
- [x] Reject credentials, hosts, account/project/model identifiers, real request content, provider
  messages, unknown schema fields, oversized files, and secret-like values.
- [x] Produce sorted deterministic Markdown or JSON drift reports without network access.
- [x] Keep fixture expectation updates explicit and never mutate runtime compatibility allowlists.
- [x] Add `compatibility:check` and `compatibility:update` package commands plus focused tests.
- [x] Complete the full validation checklist and second review.

## Phase 9: Automated Compatibility Intake

- [x] Add a bounded local capture envelope for every Phase 8 transport profile.
- [x] Sanitize request headers, bodies, WebSocket envelopes, and structured rejections without
  retaining credentials, hosts, model/account/project IDs, content, URLs, binary data, arbitrary
  object keys, provider messages, or response bodies.
- [x] Preserve only protocol-significant field names, JSON types, booleans, negotiation tokens,
  `type` discriminators, and stable rejection status/type/code/param values.
- [x] Preserve strict JSON-schema relationships using deterministic synthetic property,
  definition, and local-reference names.
- [x] Match the closest same-profile committed fixture with deterministic shape similarity.
- [x] Classify client-version, protocol-fingerprint, request/projected shape, discriminator,
  structured-rejection, unsupported-field, and adapter-projection changes.
- [x] Emit fixed review suggestions without modifying compatibility facts or fallback allowlists.
- [x] Add `compatibility:intake`, optional sanitized draft output, JSON reports, and
  `--fail-on-review` for CI.
- [x] Add a synthetic corpus for future Codex fields/tools, Claude content blocks, structured
  rejection changes, and adapter-incompatible MCP requests.
- [x] Add focused sanitization, determinism, matching, media, schema, WebSocket, CLI, and bounds
  tests plus a second review.

## Phase 10: Client Release Compatibility Gate

- [x] Add a reviewed manifest for Codex CLI and Claude Code root/platform packages.
- [x] Discover latest versions without executing unreviewed releases.
- [x] Verify exact registry package identity, version, tarball origin, and SHA-512 integrity.
- [x] Extract only the reviewed executable archive member into a bounded local cache.
- [x] Execute clients with synthetic credentials and temporary state against a loopback-only
  synthetic endpoint.
- [x] Require fail-closed external-network isolation plus process, timeout, request, and output
  limits.
- [x] Feed captures through Phase 9 sanitization and emit deterministic review reports.
- [x] Never update fixtures, adapters, defaults, compatibility facts, or fallback allowlists.
- [x] Add `compatibility:release-check`, focused tests, documentation, and a second review.

## Rollout Order

- [x] Release Phase 1 independently.
- [x] Release Phase 2 behind focused regression coverage for every transport.
- [x] Observe Phase 2 before enabling the shared host circuit.
- [x] Ship Phase 3 with a disabled or conservative default and documented tuning.
- [x] Add Phase 4 without changing the default; retain Phase 5 until burst-load data justifies it.
- [x] Add Phase 6 readiness before recommending container orchestration health checks.

## Validation Checklist

- [x] Run `cd node && npm test`.
- [x] Run `cd node && node --check src/*.js`.
- [x] Run `cd node && npm run build` after dashboard changes.
- [x] Run `git diff --check upstream/main...HEAD`.
- [x] Confirm no non-Node upstream files changed outside the repository allowlist.
- [x] Confirm `.data/`, `.env`, credentials, raw provider errors, and request content are not added
  to git.
- [x] Update `node/README.md` in the same change as each behavior or configuration addition.

## Recommended First Slice

- [x] Implement the model-catalog module with static fallback, five-minute freshness, stale-if-error,
  30-second failure suppression, concurrent coalescing, and generation-fenced writes.
- [x] Wire `/v1/models` and native model routes.
- [x] Add per-account capability-aware routing after catalog serving is stable.
- [x] Follow with immediate `Retry-After`/quota-reset account cooldowns.
- [x] Add the shared host circuit last, once account-level outcome settlement is centralized.

## Next Phase

Phase 10 is specified in `COMPATIBILITY_RELEASE_GATE_PLAN.md`. Use the reviewed release gate to
discover new client versions and run pinned clients only inside a local synthetic boundary, then
explicitly review every manifest, fixture, adapter, or fallback change. Active provider
request-shape probes remain deferred until a proven non-billable validation boundary exists.
