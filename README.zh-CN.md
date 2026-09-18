# Codex Pooler — Node.js 分支

本分支以 [`node/`](node/) 中的独立 Node.js 实现为主要开发目标。它提供本地
管理面板，以及支持 Responses、Chat Completions、Anthropic Messages、SSE 和
WebSocket 的 Codex、Compass 与 Claude Enterprise OAuth 网关。

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

QuotaHub 是独立的好友额度共享产品，拥有自己的服务、登录和数据。它可共享
Codex、Claude 或 AIS 访问，但其共享模型只刷新和执行 Codex 的提供方额度；
Claude 和 AIS 的共享额度是名义上的本地结算限制。使用
`cd node && npm run pool:start` 启动；详见
[`node/pool/README.md`](node/pool/README.md)。

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
