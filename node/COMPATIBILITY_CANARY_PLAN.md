# Phase 7: Compatibility Canaries

## Goal

Detect Codex and Compass protocol drift early, preserve the last-known-good proxy behavior, and
adapt only within explicit compatibility boundaries. Canaries must never send user content,
weaken authentication, expose credentials, or teach the proxy to discard arbitrary fields.

## Non-goals

- Do not copy provider client implementations or execute provider-supplied code.
- Do not probe paid generation routes by default.
- Do not infer compatibility from raw error text alone.
- Do not suppress required fields, tools, content, safety controls, or unknown request fields.
- Do not make readiness depend on an external canary succeeding.
- Do not persist credentials, request bodies, response bodies, hostnames, or account identifiers.

## Safety Model

- Disabled by default for synthetic probes; passive observation may be enabled independently.
- Reuse normal account eligibility, token refresh, pacing, host health, and deadlines.
- Probe at most one eligible account per provider capability and generation.
- Use fixed, minimal, content-free requests. Never replay customer traffic.
- Learn only allowlisted facts with a schema version, source, confidence, expiry, and generation.
- Require repeated independent evidence before activating a negative compatibility fact.
- Fence writes by credential, model-catalog, and protocol fingerprint generations.
- Preserve last-known-good facts when a probe fails for transport, quota, authentication, or host
  health reasons.
- Provide an operator kill switch and per-fact reset.

## Phase 7.1: Passive Drift Observation

- [ ] Add a bounded process-local compatibility observation registry.
- [ ] Classify evidence from already-served requests without retaining request or response content.
- [ ] Record only:
  - [ ] provider type;
  - [ ] route class;
  - [ ] protocol fingerprint hash;
  - [ ] model-family hash or static capability class;
  - [ ] allowlisted rejected field or negotiation feature;
  - [ ] stable response/error class;
  - [ ] count and first/last observation times.
- [ ] Coalesce repeated observations and retain at most 256 entries.
- [ ] Exclude caller validation failures, downstream cancellation, pacing pressure, quota failures,
  authentication failures, host outages, timeouts, and malformed provider bodies from compatibility
  learning.
- [ ] Require at least two observations separated by time or account generation before promoting a
  passive fact.
- [ ] Keep promoted facts compatible with the existing 24-hour compatibility-fact expiry.
- [ ] Add sanitized passive status to `/api/compatibility`.

## Phase 7.2: Protocol Fingerprint Watch

- [ ] Represent Codex and Anthropic negotiation defaults as a versioned fingerprint object.
- [ ] Hash only normalized public protocol values; do not include tokens, cookies, hosts, or account
  IDs.
- [ ] Detect configured/default fingerprint changes at startup.
- [ ] Invalidate only facts learned under the old fingerprint.
- [ ] Keep provider capability and model-catalog generations independent from protocol generations.
- [ ] Expose current fingerprint version/hash and stale-fact count through sanitized diagnostics.
- [ ] Add fixture coverage for future client versions, beta tokens, header casing, duplicates, and
  invalid control characters.

## Phase 7.3: Synthetic Canary Scheduler

- [ ] Add `CODEX_POOLER_COMPATIBILITY_CANARIES_ENABLED=false`.
- [ ] Add bounded configuration:
  - [ ] interval: default 6 hours, minimum 30 minutes;
  - [ ] startup jitter: default 0-10 minutes;
  - [ ] concurrency: default 1, maximum 2;
  - [ ] per-provider daily probe budget;
  - [ ] request deadline and response-size limit.
- [ ] Run no synthetic probes when there are no eligible capped accounts.
- [ ] Skip accounts in cooldown, reauthentication-required state, half-open account/host probes, or
  pacing pressure.
- [ ] Start with metadata-only probes:
  - [ ] Codex model discovery using the existing catalog path;
  - [ ] Codex quota route compatibility using the existing fallback order;
  - [ ] Compass project quota when the deployment token is configured.
- [ ] Treat existing successful production traffic as fresher evidence than a scheduled probe.
- [ ] Add deterministic jitter and generation fencing to avoid synchronized or stale writes.
- [ ] Ensure scheduler shutdown aborts queued and in-flight probes.

## Phase 7.4: Active Request-Shape Canaries

- [ ] Keep active request-shape probes behind a second explicit opt-in.
- [ ] Define probe templates in code with fixed empty/minimal content and strict byte limits.
- [ ] Never invoke tools, file uploads, image generation, audio, WebSockets, or billable generation
  by default.
- [ ] Probe one optional feature at a time against a harmless validation boundary where available.
- [ ] Accept evidence only from structured provider error fields or deterministic status/header
  contracts.
- [ ] Require two matching failures and one control success before activating field suppression.
- [ ] Permit automatic learning only for the current allowlists:
  - [ ] Codex: `max_output_tokens`, `prompt_cache_retention`, `safety_identifier`,
    `temperature`, `top_p`;
  - [ ] Compass: adaptive thinking, `temperature`, `top_k`, `top_p`.
- [ ] Never automatically expand these allowlists from provider text.
- [ ] Add a cooldown after any quota, authentication, or host-health event.

## Phase 7.5: Last-known-good and Quarantine

- [ ] Store promoted compatibility facts with:
  - [ ] schema version;
  - [ ] protocol fingerprint hash;
  - [ ] provider type and route class;
  - [ ] model-family/capability scope;
  - [ ] source: passive or synthetic;
  - [ ] confidence and evidence count;
  - [ ] creation, validation, and expiry timestamps;
  - [ ] generation fence.
- [ ] Retain the previous fact set as last-known-good during replacement.
- [ ] Quarantine contradictory new facts until independently reconfirmed.
- [ ] Roll back automatically when a learned suppression causes a deterministic control failure.
- [ ] Bound persisted facts and quarantine records to 100 per upstream.
- [ ] Clear facts on credential identity replacement or incompatible fingerprint changes.
- [ ] Add API actions to reset one fact, one upstream's facts, or all compatibility facts.

## Phase 7.6: Operator Experience

- [ ] Add `GET /api/compatibility` with sanitized aggregate status.
- [ ] Add `POST /api/compatibility/probe` for an operator-triggered bounded probe.
- [ ] Add `DELETE /api/compatibility/facts/:id` using an opaque fact ID.
- [ ] Add a dashboard Compatibility dialog showing:
  - [ ] scheduler enabled/disabled state;
  - [ ] last probe outcome class and time;
  - [ ] protocol fingerprint version;
  - [ ] active, quarantined, and stale fact counts;
  - [ ] allowlisted fact name, provider/route scope, confidence, and expiry;
  - [ ] reset and probe controls with confirmation.
- [ ] Never display upstream/account IDs, models when they identify private deployments, hostnames,
  provider bodies, or raw errors.
- [ ] Emit a dashboard event when active compatibility facts change.

## Phase 7.7: Readiness and Diagnostics Integration

- [ ] Keep compatibility canaries non-blocking for `/readyz`.
- [ ] Add a sanitized readiness detail only when canary configuration is invalid locally.
- [ ] Record probe timings and terminal outcome classes in memory.
- [ ] Persist only bounded failed probe summaries when an operator explicitly enables persistence.
- [ ] Separate compatibility exclusions from account health and host-health outcomes.
- [ ] Add metrics-friendly counters without high-cardinality labels.

## Testing Matrix

- [ ] Unit-test evidence classification, confidence promotion, expiry, quarantine, and rollback.
- [ ] Test generation fences across credential and protocol changes.
- [ ] Test scheduler jitter, daily budgets, concurrency, cancellation, and clean shutdown.
- [ ] Test that transport, quota, auth, pacing, and host failures never promote facts.
- [ ] Test every allowlisted Codex and Compass compatibility fact.
- [ ] Test contradictory evidence and last-known-good restoration.
- [ ] Test sanitization against tokens, cookies, account IDs, upstream IDs, hostnames, request bodies,
  response bodies, and raw exceptions.
- [ ] Test HTTP, SSE, compatibility helpers, native routes, and public Responses WebSockets continue
  using the same compatibility facts.
- [ ] Test canaries disabled by default and readiness remains available.
- [ ] Build and visually verify the dashboard on desktop and mobile.

## Rollout

1. Ship passive observation and the sanitized API with no behavior change.
2. Observe for at least one normal provider-update cycle.
3. Enable metadata-only synthetic probes for operators who opt in.
4. Add quarantine and last-known-good controls before any automatic promotion.
5. Enable active request-shape probes only after fixtures prove they are non-billable and harmless.
6. Keep automatic allowlist expansion out of scope; require reviewed code changes.

## Validation

```bash
cd node && npm test
cd node && node --check src/*.js
cd node && npm run build
git diff --check upstream/main...HEAD
git diff --exit-code upstream/main -- \
  ':(exclude)node/**' \
  ':(exclude).gitignore' \
  ':(exclude)README.md' \
  ':(exclude)README.zh-CN.md' \
  ':(exclude)AGENTS.md'
```
