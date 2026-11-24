<div align="center">
  <h1><img src="assets/brand/edgeever-icon.svg" alt="EdgeEver logo" width="48" align="absmiddle" /> EdgeEver</h1>
  <p>AI-native notes and knowledge workspace · AI 原生笔记与知识库</p>
</div>

EdgeEver combines a three-pane note editor, instant sync, attachments, AI assistants, a web clipper and a workspace-scoped MCP endpoint. This workspace is based on the official **v2.28.2 source**, including its existing changes.

EdgeEver 集成三栏笔记编辑、多端同步、附件、AI 助手、网页剪藏和工作区隔离的 MCP 接口。本工作区以官方 **v2.28.2 源码**为基线。

## Languages / 语言

[English](docs/readme/README.md) · [简体中文](docs/readme/README.zh-CN.md) · [繁體中文](docs/readme/README.zh-TW.md) · [Español](docs/readme/README.es.md) · [Deutsch](docs/readme/README.de.md) · [Français](docs/readme/README.fr.md) · [日本語](docs/readme/README.ja.md) · [Polski](docs/readme/README.pl-PL.md) · [Русский](docs/readme/README.ru.md)

Complete product descriptions, screenshots, deployment options and acknowledgements are in the language documents above.
完整产品说明、截图、部署方案与致谢集中在以上语言文档。

## Quick start / 快速开始

Use Bun 1.3.14, as specified by `package.json`. Run from this directory:
使用 `package.json` 指定的 Bun 1.3.14，在本目录执行：

```sh
bun install --frozen-lockfile
bun run dev
```

This starts the local Web and API together. Fresh local databases use `owner` / `edgeever-local-dev` and sign in automatically. See [local development](docs/local-dev-reset.md) / [本地开发](docs/local-dev-reset.zh-CN.md) for resets and isolated data.
本地 Web 与 API 一起启动；新建本地数据库自动登录，账号为 `owner` / `edgeever-local-dev`。重置及数据隔离见上述本地开发文档。

## Code and documentation / 代码与文档导航

| Start here / 从这里开始 | Location / 位置 |
| --- | --- |
| Source map and request flow / 源码地图与调用链 | [中文](docs/source-map.zh-CN.md) · [English](docs/source-map.md) |
| REST and Remote MCP backend / 后端 | [apps/api/src](apps/api/src) |
| Web UI / Web 界面 | [apps/web/src](apps/web/src) |
| Desktop / 桌面端 | [apps/desktop](apps/desktop) · [Rust sidecar](crates/desktop-sidecar) |
| Android (Expo / React Native) | [apps/mobile](apps/mobile) |
| iOS (Swift / SwiftUI) | [apps/ios](apps/ios) |
| Web clipper / 网页剪藏 | [apps/extension](apps/extension) |
| Shared client and schemas / 共用客户端与校验 | [packages/client](packages/client) · [packages/shared](packages/shared) |
| MCP usage / MCP 使用 | [中文](docs/mcp-guide.zh-CN.md) · [English](docs/mcp-guide.md) |
| AI and ACP / AI 与 ACP | [中文](docs/acp-note-access.zh-CN.md) · [English](docs/acp-note-access.md) |
| Docker deployment / Docker 部署 | [中文](docs/deploy-docker.zh-CN.md) · [English](docs/deploy-docker.md) |
| Cloudflare deployment / Cloudflare 部署 | [中文](docs/agent-deploy-cloudflare.zh-CN.md) · [English](docs/agent-deploy-cloudflare.md) |
| Architecture / 架构 | [中文](docs/self-hosting-architecture.zh-CN.md) · [English](docs/self-hosting-architecture.md) |
| Contributing / 贡献指南 | [中文](docs/CONTRIBUTING.zh-CN.md) · [English](docs/CONTRIBUTING.md) |
| Agent rules / 代理约束 | [AGENTS.md](AGENTS.md) |
| License / 许可证 | [GNU AGPL v3](LICENSE) |

Local checks / 本地检查：

```sh
bun run typecheck
bun run typecheck:mobile
bun run test
bun run build:web
```

<!-- Command Code GitHub 写入验证 -->
