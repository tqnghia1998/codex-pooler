# Phase 10: Client Release Compatibility Gate

Status: complete

Last reviewed: 2026-08-16

## Goal

Discover new Codex CLI and Claude Code releases, execute only reviewed and integrity-pinned client
packages against a local synthetic endpoint, and feed the resulting request capture through the
Phase 9 compatibility intake pipeline.

## Safety Contract

- Registry discovery is metadata-only and bounded.
- A registry version is never executed until its package and platform package identities,
  versions, executable path, and SHA-512 integrity values are committed in the reviewed manifest.
- Package downloads use exact versions, enforce HTTPS registry tarball URLs, verify SHA-512 before
  caching, and extract only the reviewed executable member.
- Client processes receive a synthetic credential and a minimal environment with temporary
  `HOME`, config, cache, state, and working directories.
- Client execution requires a supported network isolation strategy that permits loopback and
  denies external network access. Unsupported hosts fail closed.
- One client process is admitted per run with fixed wall-clock and output limits. The complete
  process group is terminated on timeout or excess output.
- The synthetic harness binds only to `127.0.0.1`, accepts one bounded generation request, and
  returns a content-free terminal response.
- Raw captures and client output remain in a temporary directory and are deleted after analysis.
- Reports contain only package/version/provenance state plus Phase 9 sanitized classifications.
- The gate never updates fixtures, adapters, defaults, compatibility facts, or fallback allowlists.

## Manifest Contract

`fixtures/compatibility-releases.json` contains:

- schema version and fixed npm registry;
- client family, root package, reviewed version, and root-package integrity;
- a fixed capture profile;
- per-platform package identity, exact package version, integrity, and executable archive member.

The root package and selected platform package metadata must both match the registry before a run.
A different `latest` version is reported as `new_release` but is not downloaded or executed.

## Command

```bash
npm run compatibility:release-check
```

Options:

- `--json`: emit deterministic JSON.
- `--fail-on-review`: fail for a newly published version or compatibility drift.
- `--offline`: skip discovery and package downloads; use already verified cached packages.
- `--client=codex|claude-code`: run one reviewed client.
- `--manifest=/path/to/manifest.json`: use another reviewed manifest.
- `--fixtures=/path/to/fixtures`: use another compatibility baseline directory.
- `--cache=/path/to/cache`: use another local package cache.

## TODO

- [x] Define a strict reviewed client-version and per-platform provenance manifest.
- [x] Add bounded latest-release discovery without executing unreviewed versions.
- [x] Download exact platform packages, verify SHA-512, and extract only reviewed executables.
- [x] Add a loopback-only synthetic client harness with bounded request capture and responses.
- [x] Execute clients with synthetic credentials, temporary state, time/output limits, and
  fail-closed external-network isolation.
- [x] Reuse Phase 9 sanitization, closest-fixture matching, and drift classification.
- [x] Emit deterministic Markdown/JSON reports and a CI-friendly failure mode.
- [x] Add synthetic-client, manifest, provenance, bounds, timeout, and report tests.
- [x] Update `README.md`, `package.json`, and `CODEX_PROXY_TODO.md`.
- [x] Run complete Node validation and a second security review.
