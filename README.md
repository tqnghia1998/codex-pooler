# Codex Pooler — Node.js fork

This fork develops the standalone Node.js implementation in [`node/`](node/).
It provides a local dashboard plus a Codex/Compass gateway with Responses, Chat
Completions, Anthropic Messages, SSE, and WebSocket support.

## Run

Node 20+ is required.

```bash
cd node
cp .env.example .env
# set CODEX_POOLER_API_KEY in .env
npm install
npm start
```

Open `http://localhost:3000`. See [`node/README.md`](node/README.md) for setup,
routing, supported routes, storage, and operational limits.

Codex Share is a separate friend-sharing product with its own server, login,
and data. Start it with `cd node && npm run pool:start`; see
[`node/pool/README.md`](node/pool/README.md).

## Project direction

- `node/` is the only fork-owned implementation and the target for new work.
- The Elixir application outside `node/` is restored from and kept identical to
  [`icoretech/codex-pooler`](https://github.com/icoretech/codex-pooler)'s
  `main` branch. It is retained as an upstream reference, not a second fork to
  maintain.
- The previous customized Elixir fork is preserved on
  [`legacy/fork-elixir`](https://github.com/tqnghia1998/codex-pooler/tree/legacy/fork-elixir).

## Development

```bash
cd node
npm test
```

When updating upstream, retain only `node/` and the small set of Node-first
repository documents. The exact synchronization boundary is documented in
[`AGENTS.md`](AGENTS.md).
