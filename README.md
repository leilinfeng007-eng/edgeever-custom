# <img src="assets/brand/edgeever-icon.svg" alt="EdgeEver" width="32" /> EdgeEver Custom

把 AI 对话、排障过程和附件证据沉淀成可以持续补充的笔记。

Turn AI conversations, troubleshooting notes, and attachment evidence into notes you can keep extending.

基于官方 EdgeEver **v2.28.2**。三栏编辑、多端同步、网页剪藏与 MCP 等官方能力保持不变。

## 开始使用

| 入口 | 你会得到 | 指南 |
| :--- | :--- | :--- |
| **Cloudflare 部署** | Workers + D1 + R2，零服务器运行 | [中文](docs/agent-deploy-cloudflare.zh-CN.md) · [English](docs/agent-deploy-cloudflare.md) |
| **Docker 部署** | 自托管 Web 与 API；本 Fork 需用仓库根 `Dockerfile` 构建 | [中文](docs/deploy-docker.zh-CN.md) · [English](docs/deploy-docker.md) |
| **MCP 接入** | 连接 Claude Code、Cursor、VS Code 等客户端 | [中文](docs/mcp-guide.zh-CN.md) · [English](docs/mcp-guide.md) |

Cloudflare 部署时，把指南第 1 步的 Fork 目标换成本仓库。官方一键 Docker 脚本拉取的是官方镜像，不含本 Fork 的改动。

## 主要改进

以下为本 Fork 相对官方 v2.28.2 的改进：

- **对话保存与同题补充**：把一段 AI 对话存成带结论、依据、验证结果和来源的笔记；同题再次出现时，先查看已有笔记，再选择补充或另存。
- **MCP 搜索与章节更新**：在官方 MCP 搜索之上，让 Agent 先找到已有笔记，再只更新指定章节，保留其余正文和附件引用。
- **附件读取与来源汇总**：让 Agent 分页读取 Word、文本和 PDF，记录文件名、页码和来源，并生成按资源去重的附件汇总。
- **笔记分类与 Web 界面**：新笔记可以先进入「等待分类」，再自动归入工作项目、系统问题记录或个人学习，也可以手动放进临时记录；Web 端统一主题并补齐多语言文案，保存、补充和分类结果都能在同一界面完成。
- **部署与 HTTP 兼容**：Cloudflare 分类任务按 Cron 自动运行，本地开发使用独立的 D1 配置；Cloudflare Workers 的重定向兼容问题已修复，自动分类请求不会再因此失败，模型密钥也不会随重定向转发到其他源。

接口、参数和错误码见 [MCP 指南](docs/mcp-guide.zh-CN.md)；部署细节见上方 Cloudflare / Docker 指南。

## 本地启动与文档

使用 `package.json` 指定的 Bun 1.3.14：

```sh
bun install --frozen-lockfile
bun run dev
```

本地 Web 与 API 一起启动；新建数据库自动登录 `owner` / `edgeever-local-dev`，重置见[本地开发](docs/local-dev-reset.zh-CN.md)。

文档：[源码地图](docs/source-map.zh-CN.md) · [自托管架构](docs/self-hosting-architecture.zh-CN.md) · [MCP 指南](docs/mcp-guide.zh-CN.md) · [贡献指南](docs/CONTRIBUTING.zh-CN.md) · [AGENTS.md](AGENTS.md) · [AGPL-3.0](LICENSE)

语言：[English](docs/readme/README.md) · [简体中文](docs/readme/README.zh-CN.md) · [繁體中文](docs/readme/README.zh-TW.md) · [Español](docs/readme/README.es.md) · [Deutsch](docs/readme/README.de.md) · [Français](docs/readme/README.fr.md) · [日本語](docs/readme/README.ja.md) · [Polski](docs/readme/README.pl-PL.md) · [Русский](docs/readme/README.ru.md)
