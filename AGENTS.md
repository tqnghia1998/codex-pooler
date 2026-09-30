# Node-first fork notes

This repository is a Node.js-first fork of `icoretech/codex-pooler`.

## Ownership boundary

- `node/` is the only maintained implementation. Add fork functionality there.
- The Elixir application is an untouched upstream reference. Do not modify
  Elixir source, tests, migrations, configuration, build scripts, or deployment
  files for fork features.
- The only intentional non-Node differences from `upstream/main` are
  `.gitignore`, `README.md`, `README.zh-CN.md`, and this file.
- The customized Elixir fork before this boundary change is preserved on
  `legacy/fork-elixir`; do not merge it into `main`.

## Upstream synchronization

The canonical upstream remote is `upstream`.

```bash
git fetch upstream
git rebase upstream/main
git diff --exit-code upstream/main -- \
  ':(exclude)node/**' \
  ':(exclude).gitignore' \
  ':(exclude)README.md' \
  ':(exclude)README.zh-CN.md' \
  ':(exclude)AGENTS.md'
```

The final command must have no output. Resolve upstream changes in the
allowlisted documents only when necessary; port worthwhile gateway behavior to
`node/` rather than changing the Elixir implementation.

## Features, improvements, and bug fixes

For every new feature, improvement, optimization, refactor, or bug fix, assess
QuotaHub impact even when the user has not said "sync". Apply the same check
after an upstream rebase or cherry-pick; inspect the actual changes rather
than assuming they are shared automatically.

- Classify the change as shared gateway behavior, QuotaHub-only product
  behavior, or Relaydeck-only UI/admin/tooling. Base this on callers and
  contracts, not on whether local telemetry shows usage.
- Implement shared behavior once in `node/` gateway modules consumed by both
  apps. Do not leave a protocol fix or feature wired only into Relaydeck's
  server, or duplicate it in QuotaHub to avoid updating the shared gateway.
- For shared changes, inspect standalone imports and the publisher's entry
  and dependency lists. Account for any new modules, packages, assets,
  exports, initialization, routes, or configuration. Prepare necessary
  publisher and QuotaHub integration changes within the requested scope;
  identify any remaining work explicitly rather than silently omitting it.
- Preserve QuotaHub's identity, share authorization/accounting, and Redis/KMS
  contracts. Storage/performance improvements must retain Redis write
  tracking and durability, not only pass the source SQLite tests.
- Add regression coverage for fixes and behavior coverage for new features
  in the owning repo, plus downstream integration coverage where affected.
  Tests against an older vendor pin do not validate the new shared change.
- Keep QuotaHub-only features in standalone. Leave Relaydeck-only features
  out of the vendor and explain why no sync is needed. Elixir-only upstream
  changes need a deliberate Node port before either Node app can use them.

An ordinary feature/improvement/bug-fix request is not a request to publish.
Unless syncing is also requested, leave publication pending and avoid the
standalone publishing lifecycle commands. When syncing is requested, use the
full procedure below for all applicable features, improvements, and fixes.
In the final report state QuotaHub impact and sync status: not applicable
(with reason), required (with remaining steps), or synced (with gateway pin
and validation). Do not describe source-only work as already available in
QuotaHub.

## Syncing code to codex-share

Treat "sync code to codex-share", "sync QuotaHub", "port the gateway", and
similar requests as an audited update of the standalone app's minimal gateway
snapshot, including any necessary QuotaHub integration. Do not copy this whole
repository or revive the old embedded/SQLite QuotaHub app.

- Standalone app: `~/Documents/Git/codex-share`.
- Default publishing source:
  `~/Documents/space-app-vibing/codex-pooler-worktrees/main`.
- Confirm these against `git worktree list` and the standalone
  `package.json` scripts; do not assume the current checkout is the source.
- Read the standalone `AGENTS.md`, `README.md`, and
  `scripts/publish-gateway.mjs` before syncing.

### Ownership and privacy

Shared protocols, routing, compatibility, pricing, and gateway optimizations
belong in `node/`. QuotaHub owns its UI, product server, share authorization
integration, Redis/KMS persistence, and DW relay in the standalone repository.
Preserve its `CODEX_GATEWAY_IDENTITY=codex-share` initialization.

The standalone `vendor/gateway` submodule tracks that repository's own
internal `gateway` branch, exposed as `@quotahub/gateway/gateway/*`. It must
not point at this repository's remote. Publish only required runtime modules
and package metadata; never restore the full Node/Relaydeck snapshot, source
Git ancestry, UI, docs, tests, fixtures, or build tooling to that branch.
Do not add Relaydeck branding, source repository URLs, source commit
identifiers, or provenance metadata to standalone files or snapshot messages.
Inspect copied code and package metadata for leaks before publishing.

### Sync procedure

1. Inspect both worktrees and the vendor pin without discarding user changes.
   Confirm the requested changes are committed in the configured source
   checkout. The publisher requires the entire source checkout to be clean;
   it neither fetches/rebases source `main` nor includes another worktree's
   changes. Do not silently publish an older `main` when the requested work is
   elsewhere. Arrange the intended commit/integration first, with authorization.
2. Compare the existing vendor snapshot with the candidate source and review
   the requested feature/optimization changes, not just the submodule SHA.
   A rebase that changes only upstream Elixir code adds no Node behavior:
   relevant behavior must first be deliberately ported into `node/`.
3. Audit coverage in `scripts/publish-gateway.mjs`. It currently has fixed
   `GATEWAY_ENTRY_MODULES`, a fixed `GATEWAY_RUNTIME_DEPENDENCIES` allowlist,
   and a regex import walker. Existing included modules and recognized
   relative imports carry over; new entry points, side-effect/computed
   imports, workers, runtime assets, and npm packages need explicit review.
   Update the publisher/dependencies if needed; do not assume automatic
   discovery or fail-closed validation already exists.
4. Check new routes, initialization, configuration, and storage contracts in
   QuotaHub. Wire necessary changes into its server and `POOL_*` configuration,
   preserve share accounting and Redis durability, and add focused integration
   tests. Source dashboard/admin features are not automatically product features.
5. Run the source Node tests, syntax checks, and upstream-boundary checks
   documented below; build the source UI if changed. Review the candidate
   runtime files, dependencies, and privacy boundary before publishing.
6. From the standalone checkout, initialize the existing submodule with
   `git submodule update --init --recursive`, then run `npm run build`.
   This publishes a minimal snapshot to the standalone remote's `gateway`
   branch, updates the local vendor pin, and builds the UI. It is not a
   local-only build or dry run. `npm test`, `npm start`, and `npm run dev`
   also invoke it. For an explicit alternative source, invoke
   `node scripts/publish-gateway.mjs /absolute/path/to/source-checkout`;
   subsequent build/test scripts still use their configured default.
7. In standalone, run `npm install --package-lock-only`, `npm ci`, `npm test`,
   syntax-check each `src/*.js` file, and run `git diff --check`. Ensure the
   default source remains the intended one for the repeated publish step.
   Inspect vendor imports, dependency resolution, and behavior tests, not just
   a successful UI build. Review `git diff --submodule=log` and lockfile changes.
8. Report the gateway pin, included changes, intentional exclusions, integration
   work, tests, and any remaining steps. A sync request includes the publisher's
   normal gateway snapshot push unless the user says local-only/no-push.
   Commit or push source/product branches and redeploy only when requested.
   The standalone vendor pointer and any integration/lockfile changes must be
   committed and pushed before another checkout can reproduce the update.
   Do not force-push or rewrite history as part of a normal sync.

For a local-only/no-push request, do not run those publishing lifecycle scripts.
After dependencies are installed, use `npx --no-install vite build` and
`node --import ./src/gateway-identity.js --test test/*.test.js` in standalone
to validate its currently pinned gateway. These commands do not sync a new
snapshot. Report any unpublished sync work explicitly.

## Node development

- Node 20+ is required.
- Use `cd node && npm test` before committing changes.
- `node/.data/` and `node/.env` are local credential state. Never commit them.
- Read `node/README.md` before changing supported routes, routing, quota,
  spending-cap, storage, or compatibility behavior. Keep it accurate.
- Treat every route or protocol behavior that OpenAI, Codex, or Claude Code
  clients can invoke as used, even when local configs or telemetry show no
  traffic. Only code with zero callers anywhere may be removed as dead.

## Node UI / Astryx

- The dashboard UI lives in `node/ui/` and uses the Astryx component library:
  https://astryx.atmeta.com/components
- Use React 19 with `@astryxdesign/core` and
  `@astryxdesign/theme-neutral`; import the library reset, Astryx base CSS,
  and the neutral theme CSS before rendering `Theme` with `neutralTheme`.
- Prefer raw Astryx components such as `AppShell`, `Card`, `Section`,
  `Layout`, `Grid`, `HStack`, `VStack`, `Text`, `Heading`, `Button`, and the
  form components. The dashboard uses the neutral dark theme for its page
  background. Do not add custom CSS files, manual CSS declarations,
  visual `className` hooks, or inline `style` props for dashboard layout or
  appearance; use component props and theme tokens instead.
- Run `cd node && npm run build` after UI changes. Generated files in
  `node/public/` are build output and should not be edited by hand.

## Validation

For Node changes:

```bash
cd node && npm test
node --check src/*.js
```

For every branch update:

```bash
git diff --check upstream/main...HEAD
git diff --exit-code upstream/main -- \
  ':(exclude)node/**' \
  ':(exclude).gitignore' \
  ':(exclude)README.md' \
  ':(exclude)README.zh-CN.md' \
  ':(exclude)AGENTS.md'
```
