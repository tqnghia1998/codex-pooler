# Export Codex Share

Create a standalone Codex Share repository from the maintained Node product and
the gateway modules it imports:

```bash
cd node
npm run export:codex-share -- --clean
```

The target is fixed at `/Users/quangnghia.trinh/Documents/Git/codex-share`.
`--clean` is for the initial conversion of a placeholder repository. It removes
every target file except `.git`; the target must have a clean worktree. Later
exports use `npm run export:codex-share` and replace only exporter-managed files.

The exporter keeps the current `LICENSE.md`. Publishing the result under a
different license requires a separate ownership and licensing decision; this
script does not relicense code.
