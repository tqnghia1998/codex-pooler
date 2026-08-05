# Codex Pooler — Node.js 分支

本分支以 [`node/`](node/) 中的独立 Node.js 实现为主要开发目标。它提供本地
管理面板，以及支持 Responses、Chat Completions、Anthropic Messages、SSE 和
WebSocket 的 Codex/Compass 网关。

## 运行

需要 Node 20+。

```bash
cd node
cp .env.example .env
# 在 .env 中设置 CODEX_POOLER_API_KEY
npm install
npm start
```

打开 `http://localhost:3000`。配置、路由、支持的端点、存储方式和运行限制请见
[`node/README.md`](node/README.md)。

## 项目方向

- `node/` 是本分支唯一自行维护的实现，也是新功能的目标。
- `node/` 以外的 Elixir 应用保持与
  [`icoretech/codex-pooler`](https://github.com/icoretech/codex-pooler) 的
  `main` 分支一致，仅作为上游参考，不再维护第二套定制实现。
- 之前的定制 Elixir 分支保留在
  [`legacy/fork-elixir`](https://github.com/tqnghia1998/codex-pooler/tree/legacy/fork-elixir)。

## 开发

```bash
cd node
npm test
```

同步上游时，仅保留 `node/` 和少量 Node-first 仓库文档的差异。准确的同步边界见
[`AGENTS.md`](AGENTS.md)。
