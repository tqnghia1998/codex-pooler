# Phase 9: Automated Compatibility Intake

Status: complete

Last reviewed: 2026-08-16

## Goal

Convert a bounded local Codex or Claude client capture into a sanitized fixture draft and a
deterministic review report. Intake should make new client releases cheap to inspect without
uploading captures, contacting providers, or automatically changing runtime compatibility policy.

## Capture Contract

An intake capture is a local JSON object containing:

- schema version, transport profile, and client family/version;
- request path, headers, JSON body, and optional WebSocket `generate`;
- optional response status and JSON body.

Captures may contain credentials and user/provider content. They are input only and must never be
committed. The sanitizer:

- retains only allowlisted negotiation headers;
- drops credential, cookie, host, account, project, and token fields at every depth;
- replaces models, IDs, names, content, URLs, binary data, numbers, and dynamic schema keys with
  deterministic fixture markers;
- preserves bounded public field names, JSON types, booleans, and token-shaped enum/discriminator
  values;
- retains only structured rejection status plus `type`, `code`, and `param`;
- deduplicates repeated sanitized array shapes and applies strict byte/depth/node bounds.

## Review Contract

The intake report selects the closest committed fixture with the same transport profile and emits:

- client-version and protocol-fingerprint changes;
- request and projected JSON path/type additions or removals;
- new or removed `type` discriminator values;
- structured rejection field changes;
- a stable adapter error code/param when live projection rejects the draft;
- explicit review suggestions.

Intake never edits committed fixtures, runtime compatibility facts, or fallback allowlists. A draft
is written only when the operator supplies `--output`.

## TODO

- [x] Define the bounded capture, sanitizer, and review contracts.
- [x] Implement deterministic sanitization and structured rejection extraction.
- [x] Match the closest same-profile fixture.
- [x] Classify negotiation, shape, discriminator, rejection, and adapter drift.
- [x] Add the intake CLI and CI-friendly failure mode.
- [x] Add a synthetic corpus for future Codex fields/tools and Claude content blocks.
- [x] Add focused tests and documentation.
- [x] Run complete validation and a second review.
