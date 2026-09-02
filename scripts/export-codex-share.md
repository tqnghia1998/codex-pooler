# Export Codex Share

Synchronize the common Codex Share product and gateway modules into the
standalone repository. The standalone repository owns its Redis/KMS runtime
overlay, so those files are preserved by the exporter:

```bash
cd node
npm run export:codex-share -- --clean
```

The default target is `/Users/quangnghia.trinh/Documents/Git/codex-share`; use
`--target <directory>` for another checkout. The target must be a clean Git
repository and must already contain the standalone overlay (`src/server.js`,
`src/kms-master-key.js`, encrypted Redis persistence, and the matching project
files). The exporter fails before changing anything when that overlay is
missing. `--clean` removes only exporter-managed paths, preserving ignored
local configuration such as `.env` and `.kms/`, then exports the common files.

The exporter keeps the current `LICENSE.md`. Publishing the result under a
different license requires a separate ownership and licensing decision; this
script does not relicense code.
