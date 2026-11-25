<div align="center">

# <img src="assets/brand/edgeever-icon.svg" alt="EdgeEver" width="40" align="absmiddle" /> EdgeEver Custom

**把 AI 对话、排障过程和附件整理成笔记，下次遇到同一个问题，可以接着补充。**

基于官方 EdgeEver **v2.28.2**

[官方项目](https://github.com/tianma-if/edgeever) · [MCP 接入](docs/mcp-guide.zh-CN.md) · [快速开始](#开始使用) · [English](docs/readme/README.md)

</div>

## 官方 EdgeEver 能做什么

三栏结构的笔记编辑器，左侧笔记本树、中间笔记列表、右侧正文与大纲，支持多维表格、思维导图、图表和海报等形式。

多端同步覆盖 Web、桌面、iOS 和 Android，配合浏览器插件一键剪藏网页。

原生 MCP，Claude Code、Cursor、VS Code 等客户端可以直接读写你的笔记。

可自托管：Cloudflare Workers + D1 + R2 零服务器运行，或 Docker 部署在自己的 VPS / NAS 上。

## 定制版加了什么

- **AI 对话保存与同题补充** — 把一段对话按模板存成笔记，记录结论、依据和验证结果。下次遇到同题，先查看已有笔记，再选择补充进去或另存新笔记。
- **MCP 精确更新** — Agent 先搜索到已有笔记，再只更新指定的章节，其余正文和附件引用原样保留。
- **附件读取与来源汇总** — 让 Agent 分页读取 Word、文本和 PDF，记录文件名、页码或来源，并生成按资源去重的附件汇总。
- **按笔记本授权** — 给 WorkBuddy 等客户端指定可访问的笔记本及其子笔记本，并设为只读或读写。

> **按笔记本授权**由官方 v2.31.0 引入，本 Fork 已移植，并为自定义 MCP 工具补齐授权检查。

## 一个真实场景

用 AI 排查一个问题 → 把结论和附件保存成笔记 → 下次遇到同题先查已有笔记 → 把新发现补进原笔记。

笔记因此越用越厚，而不是散落在多个对话窗口里。

## 开始使用

| 入口 | 你会得到 | 指南 |
| :--- | :--- | :--- |
| **Cloudflare 部署** | Workers + D1 + R2，零服务器运行 | [中文](docs/agent-deploy-cloudflare.zh-CN.md) · [English](docs/agent-deploy-cloudflare.md) |
| **Docker 部署** | 自托管 Web 与 API；本 Fork 需用仓库根 `Dockerfile` 构建 | [中文](docs/deploy-docker.zh-CN.md) · [English](docs/deploy-docker.md) |
| **MCP 接入** | 连接 Claude Code、Cursor、VS Code 等客户端 | [中文](docs/mcp-guide.zh-CN.md) · [English](docs/mcp-guide.md) |

Cloudflare 部署时，把指南第 1 步的 Fork 目标换成本仓库。官方一键 Docker 脚本拉取的是官方镜像，不含本 Fork 的改动。

## 本地开发

使用 `package.json` 指定的 Bun 1.3.14：

```sh
bun install --frozen-lockfile
bun run dev
```

本地 Web 与 API 一起启动；新建数据库自动登录 `owner` / `edgeever-local-dev`，重置见[本地开发](docs/local-dev-reset.zh-CN.md)。

## 详细文档

接口、参数和错误码见 [MCP 指南](docs/mcp-guide.zh-CN.md)；部署细节见上方 Cloudflare / Docker 指南。

[源码地图](docs/source-map.zh-CN.md) · [自托管架构](docs/self-hosting-architecture.zh-CN.md) · [本地开发与重置](docs/local-dev-reset.zh-CN.md) · [贡献指南](docs/CONTRIBUTING.zh-CN.md) · [AGENTS.md](AGENTS.md)

## 许可证

[AGPL-3.0](LICENSE)

---

语言：[English](docs/readme/README.md) · [简体中文](docs/readme/README.zh-CN.md) · [繁體中文](docs/readme/README.zh-TW.md) · [Español](docs/readme/README.es.md) · [Deutsch](docs/readme/README.de.md) · [Français](docs/readme/README.fr.md) · [日本語](docs/readme/README.ja.md) · [Polski](docs/readme/README.pl-PL.md) · [Русский](docs/readme/README.ru.md)
