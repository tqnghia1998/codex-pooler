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
