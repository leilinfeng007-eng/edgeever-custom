# <img src="assets/brand/edgeever-icon.svg" alt="EdgeEver" width="32" /> EdgeEver Custom

**把 AI 对话、项目排障和附件证据，沉淀成可以持续补充的笔记。**

Turn AI conversations, troubleshooting sessions, and attachment evidence into notes you keep extending.

本项目基于官方 EdgeEver **v2.28.2**。和只保存一次回答不同，它更关心同一主题第二次出现时：把新的验证结果补进原有章节，同时保留最初的附件、PDF 页码和来源。三栏编辑、多端同步、网页剪藏等完整产品能力见[官方多语言说明](docs/readme/README.zh-CN.md)；本页聚焦本 Fork 的沉淀与补充流程。

## 开始使用

| 入口 | 你会得到 | 文档 |
| :--- | :--- | :--- |
| **Cloudflare 部署** | Workers + D1 + R2；分类队列由 Cron Trigger 定时处理 | [中文](docs/agent-deploy-cloudflare.zh-CN.md) · [English](docs/agent-deploy-cloudflare.md) |
| **Docker 部署** | Bun + SQLite + 本地文件或 S3 兼容存储 | [中文](docs/deploy-docker.zh-CN.md) · [English](docs/deploy-docker.md) |
| **MCP 接入** | 把 EdgeEver 接到 Claude Code、Cursor、VS Code 等客户端 | [中文](docs/mcp-guide.zh-CN.md) · [English](docs/mcp-guide.md) |

Cloudflare 指南第 1 步的 Fork 目标请换成本仓库。官方一键 Docker 脚本拉取的是官方镜像，不含本 Fork 的改动；要使用这些改动，请用仓库根 `Dockerfile` 自行构建。

一条完整的链路是这样的：

```text
排障完成
  → 保存对话与验证结果      save_ai_conversation
  → 下次命中同题笔记
  → 新结果补进指定章节      save_ai_conversation · duplicate: supplement
  → 回查原附件与 PDF 页码    read_memo_attachment
```

## 一个排障场景

线上接口报 502。你和 AI 定位到网关超时，改完配置并验证通过。

1. **保存这次排障**：`save_ai_conversation` 按「AI 对话通用模板」写入结论、关键步骤 / 依据、验证结果、来源 / 链接四节；标题为 `对象｜主题`，并加上 `AI沉淀` 标签。回答按原文保存，不二次摘要。
2. **下次命中同题**：再次遇到同类问题时，工具先返回候选（`memoId`、`title`、`notebookId`、`excerpt`）且不写入。选择补充后，传 `memoId`、`duplicate: "supplement"`、`section` 与 `expectedRevision`，只改「验证结果」这一节；也可以直接用 `update_memo` 的 `sectionOperations` 对该节做 `append` 或 `replace`，其余正文和附件引用保持不变。
3. **回查证据**：`read_memo_attachment` 按 `nextOffset` 分页读取 PDF，返回 `pageStart`、`pageEnd`、`pageCount`；`set_attachment_source` 记录页码与来源，`update_attachment_summary` 重写「附件汇总」。原附件仍可定位到具体页码。

## 相对官方 v2.28.2 的改进

- **AI 对话沉淀与同题补充**：把一段对话存成结构固定的笔记；同题已存在时先列候选，再选择补充、合并或另存，补充只动指定章节。参数见 [MCP 指南 §3.2](docs/mcp-guide.zh-CN.md)。
- **MCP 章节编辑**：`update_memo` 的 `sectionOperations` 对单个 Markdown 章节做 `append` / `replace`，其余正文与附件引用不变；标题缺失、重名或版本冲突会明确报错；`idempotencyKey` 让超时重试只生效一次。参数见 [MCP 指南 §4](docs/mcp-guide.zh-CN.md)。
- **附件来源与汇总**：分页读取 Word DOCX、UTF-8 文本和 PDF，PDF 返回页码范围；图片以真实图像内容进入模型，扫描件不做 OCR，加密或损坏文件会明确报错。`set_attachment_source` 记录文件名、页码、章节、工作表、范围和 URL；`update_attachment_summary` 按资源去重生成「附件汇总」。参数见 [MCP 指南 §5](docs/mcp-guide.zh-CN.md)。
- **等待分类与四类笔记本**：工作项目、系统问题记录、个人学习、临时记录四个固定笔记本，加上「等待分类」。后台归类在 Cloudflare 由 Cron Trigger、在 Bun 自托管由定时器驱动；手动指定笔记本会在同一事务内取消旧任务。参数见 [MCP 指南 §8](docs/mcp-guide.zh-CN.md)。

部署侧增加的是分类队列的定时处理和本地 Miniflare 的 D1 配置隔离：Cloudflare 默认每 5 分钟触发一次归类任务，可用 `AUTO_CLASSIFY_CRON` 覆盖；本地没有 Cron Trigger，因此不会自动归类。`run-wrangler.mjs` 为 `--local` 使用独立的 `.wrangler.generated.local.toml`，并忽略远端 `D1_DATABASE_ID`，避免本地库因远端 UUID 切换到空库。D1/R2 适配层沿用官方 v2.28.2。

## 本地启动

使用 `package.json` 指定的 Bun 1.3.14：

```sh
bun install --frozen-lockfile
bun run dev
```

`bun run dev` 同时启动本地 Web 与 API。新建本地数据库会自动登录，账号为 `owner` / `edgeever-local-dev`；重置或隔离本地数据见[本地开发](docs/local-dev-reset.zh-CN.md)。

## 文档

| 主题 | 入口 |
| :--- | :--- |
| 源码地图与调用链 | [中文](docs/source-map.zh-CN.md) · [English](docs/source-map.md) |
| 自托管架构 | [中文](docs/self-hosting-architecture.zh-CN.md) · [English](docs/self-hosting-architecture.md) |
| MCP 完整指南 | [中文](docs/mcp-guide.zh-CN.md) · [English](docs/mcp-guide.md) |
| 代码目录 | [apps/api](apps/api) · [apps/web](apps/web) · [apps/mobile](apps/mobile) · [apps/ios](apps/ios) · [apps/desktop](apps/desktop) · [apps/extension](apps/extension) |
| 贡献指南 | [中文](docs/CONTRIBUTING.zh-CN.md) · [English](docs/CONTRIBUTING.md) · [AGENTS.md](AGENTS.md) |
| 许可证 | [GNU AGPL v3](LICENSE) |

## 语言

[English](docs/readme/README.md) · [简体中文](docs/readme/README.zh-CN.md) · [繁體中文](docs/readme/README.zh-TW.md) · [Español](docs/readme/README.es.md) · [Deutsch](docs/readme/README.de.md) · [Français](docs/readme/README.fr.md) · [日本語](docs/readme/README.ja.md) · [Polski](docs/readme/README.pl-PL.md) · [Русский](docs/readme/README.ru.md)

以上为官方多语言完整产品说明；本页只保留本 Fork 的定位与改动。
