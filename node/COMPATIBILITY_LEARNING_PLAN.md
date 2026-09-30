# Phase 7: Passive Compatibility Learning

Status: complete

Last reviewed: 2026-08-16

## Goal

Learn narrowly scoped Codex and Compass compatibility facts from structured failures already seen
while proxying real requests. Never retain request content, credentials, provider bodies, hosts,
account identifiers, or private model names.

## Contract

- Observe only allowlisted structured compatibility rejections.
- Require two independent observations before changing later requests.
- Apply a learned fallback immediately to the request that encountered it.
- Scope facts by provider, route class, hashed model label, and versioned protocol fingerprint.
- Fence promotion by credential and model-catalog generation.
- Expire facts after 24 hours.
- Keep at most 256 observations in memory and 100 active records per upstream.
- Clear persisted facts when credentials change.
- Expose only sanitized fingerprints, counts, allowlisted feature names, timestamps, and opaque IDs.
- Never expand fallback allowlists automatically.

## Removed Scope

Metadata-only synthetic probes are intentionally omitted. They duplicate model-discovery and
quota-refresh scheduling without exercising client request compatibility. Active provider
request-shape probes remain deferred until a proven non-billable validation boundary exists.

## TODO

- [x] Add bounded passive observation and independent-evidence promotion.
- [x] Version normalized Codex HTTP/WebSocket and Anthropic protocol fingerprints.
- [x] Persist bounded generation-fenced facts.
- [x] Apply the same facts across HTTP, SSE, compaction, and public WebSocket paths.
- [x] Add sanitized status and reset APIs plus dashboard controls.
- [x] Test allowlists, generation fencing, expiry, bounds, and sanitization.
- [ ] Add active request-shape probes only after a non-billable validation boundary is proven.

## Validation

```bash
cd node
npm test
node --check src/*.js
npm run build
```
