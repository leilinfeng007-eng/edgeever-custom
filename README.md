<div align="center">
  <h1><img src="assets/brand/edgeever-icon.svg" alt="EdgeEver logo" width="48" align="absmiddle" /> EdgeEver</h1>
  <p>AI-native notes and knowledge workspace · AI 原生笔记与知识库</p>
</div>

EdgeEver combines a three-pane note editor, instant sync, attachments, AI assistants, a web clipper and a workspace-scoped MCP endpoint. This workspace is based on the official **v2.28.2 source**, including its existing changes.

EdgeEver 集成三栏笔记编辑、多端同步、附件、AI 助手、网页剪藏和工作区隔离的 MCP 接口。本工作区以官方 **v2.28.2 源码**为基线。

## 自定义版功能 / Custom fork highlights

The additions and improvements below are relative to official **v2.28.2** (the `v2.28.2` tag of `tianma-if/edgeever`), summarized from this repository's code and tests. Anything not listed behaves as upstream.
以下能力为本 Fork 相对官方 **v2.28.2**（`tianma-if/edgeever` 的 `v2.28.2` 标签）的新增或改进，依据本仓库代码与测试整理；未列出的行为与官方一致。

### AI 对话沉淀 / Saving AI conversations

`save_ai_conversation` and the assistant's save action share one rule set: they fill the workspace's 「AI 对话通用模板」 with 结论 / 关键步骤与依据 / 验证结果 / 来源与链接, use an `object｜topic` title and add the `AI沉淀` tag. Answers are stored verbatim, never re-summarized. When a same-topic note already exists, candidates (`memoId`, `title`, `notebookId`, `excerpt`) are returned without writing, and the user chooses supplement, same-topic merge or a separate copy; a supplement can target a section and pass `expectedRevision`. Migration `0101` seeds the template for existing workspaces, and new workspaces get it from provisioning.
`save_ai_conversation` 与内置助手的「保存为笔记」共用一套规则：按工作区「AI 对话通用模板」生成结论、关键步骤与依据、验证结果、来源与链接四个章节，标题为 `对象｜主题`，并打上 `AI沉淀` 标签。回答按原文保存，不二次改写或摘要。同题笔记已存在时先返回候选（`memoId`、`title`、`notebookId`、`excerpt`）且不写入，由用户选择补充、同题合并或另存新笔记；补充可指定章节并传 `expectedRevision`。迁移 `0101` 为已有工作区补种该模板，新工作区由初始化种子创建。

### MCP 章节编辑与幂等重试 / Section edits and idempotent retries

`update_memo` gains `sectionOperations`, which appends to or replaces a single Markdown section while leaving the rest of the body and attachment references untouched. A missing or duplicated heading returns `section_not_found` / `section_ambiguous` with `availableHeadings` instead of guessing or rewriting the whole note, and a revision clash returns `revision_conflict` with the current revision, notebook and title. Appends and conversation supplements accept `idempotencyKey`, applied once per workspace, tool and key, so a timed-out retry returns the first result (receipts table from migration `0102`).
`update_memo` 新增 `sectionOperations`，按 Markdown 标题对单个章节做 `append` 或 `replace`，其余正文与附件引用保持不变。标题缺失或重名返回 `section_not_found` / `section_ambiguous` 并附 `availableHeadings`，不猜测位置、不退化为全文重写；`expectedRevision` 冲突返回 `revision_conflict` 及当前版本、笔记本与标题。追加与对话补充接受 `idempotencyKey`，同一工作区、工具与 key 只生效一次，超时重试返回首次结果（迁移 `0102` 的回执表）。

### 附件读取与来源汇总 / Attachment reading and source summaries

New `read_memo_attachment` pages through Word DOCX, UTF-8 text and PDF bodies with `nextOffset`; PDFs report `pageStart`, `pageEnd` and `pageCount`, and images reach the model as real image content. Scans are not OCR'd, and encrypted or damaged files fail explicitly. Body and attachment text share a 64,000-character budget per turn (12,000 per body page), with up to four images of 2 MiB each. `set_attachment_source` records filename, pages, chapter, sheet, range and URL (`null` clears it); `update_attachment_summary` rewrites the 附件汇总 section — attachments and PDFs only, deduplicated by resource, first-seen order, identical on repeat, and 「来源未提供」 when unknown. `insert_memo_resource` places resources by section or body anchor and fails loudly instead of falling back to the end of the note.
新增 `read_memo_attachment`：按 `nextOffset` 分页读取 Word DOCX、UTF-8 文本与 PDF 正文，PDF 返回 `pageStart`、`pageEnd`、`pageCount`，图片以真实图像内容进入模型。扫描件不做 OCR，加密或损坏文件明确报错。正文与附件文本共享每回合 64,000 字符预算（单页正文 12,000 字符），每回合最多四张图片、单图 2 MiB。`set_attachment_source` 记录文件名、页码、章节、工作表、范围与链接，传 `null` 清除来源；`update_attachment_summary` 重写「附件汇总」，只收附件与 PDF、按资源去重、保持首次出现顺序，重复执行结果一致，无来源时写「来源未提供」。`insert_memo_resource` 按章节或正文锚点插入，定位失败直接报错而不退回文末。

### 笔记分类 / Note categories

Workspaces gain four fixed notebooks — 工作项目, 系统问题记录, 个人学习 and 临时记录 — alongside 等待分类 as classification targets. Migration `0100` only repairs existing workspaces: it never deletes or moves a note, and matches old localized names by alias (for example 学习资料 → 个人学习). The read-only `get_inbox_classification` tool reports job state, outcome, attempts and suggested destination. Background filing runs on a Cloudflare Cron Trigger or the Bun self-hosted timer, configurable with `EDGE_EVER_AUTO_CLASSIFY=false` or `EDGE_EVER_AUTO_CLASSIFY_WORKSPACE`; an explicit notebook choice cancels the stale job in the same transaction, while moving a note into 等待分类 requeues it. The UI shows the classification card only in 等待分类 and reads classified results on demand from 更多 → 自动分类详情.
工作区新增四个固定笔记本：工作项目、系统问题记录、个人学习、临时记录，与「等待分类」共同构成分类目标。迁移 `0100` 只修复已有工作区，不删除或移动任何笔记，并按多语言别名识别旧名称（例如「学习资料」→「个人学习」）。只读工具 `get_inbox_classification` 返回归类状态、结果、尝试次数与建议归属。后台归类由 Cloudflare Cron Trigger 或 Bun 自托管定时器驱动，可用 `EDGE_EVER_AUTO_CLASSIFY=false` 关闭，或用 `EDGE_EVER_AUTO_CLASSIFY_WORKSPACE` 限定工作区；手动指定笔记本会在同一事务内取消旧任务，移入「等待分类」则重新排队。界面只在「等待分类」展示归类型卡片，已归类笔记通过「更多 → 自动分类详情」按需读取。

### Cloudflare 与本地开发 / Cloudflare and local development

Cloudflare bindings are confined to `apps/api/src/storage/`: `createCloudflareStorageAdapter` adapts D1 and R2 to the storage interface consumed by the business layer, so routes and services never touch native bindings. `run-wrangler.mjs` gives `--local` its own `.wrangler.generated.local.toml` and ignores a remote `D1_DATABASE_ID`, so a long-running `wrangler dev --local` no longer restarts onto an empty database. Local Miniflare has no Cron Trigger, so auto-filing is disabled there, while deployments get a classification job every five minutes by default, overridable with `AUTO_CLASSIFY_CRON`. `bun run dev` starts Web and API together, and the self-hosted Bun runtime starts and gracefully stops the classification scheduler.
Cloudflare 绑定收敛到 `apps/api/src/storage/`：`createCloudflareStorageAdapter` 把 D1 与 R2 适配为业务层使用的存储接口，路由与服务不直接接触原生绑定。`run-wrangler.mjs` 为 `--local` 使用独立的 `.wrangler.generated.local.toml` 并忽略远端 `D1_DATABASE_ID`，避免长时间运行的 `wrangler dev --local` 因远端 UUID 重启到空库。本地 Miniflare 没有 Cron Trigger，因此关闭自动归类；部署环境新增默认每 5 分钟的分类任务，可用 `AUTO_CLASSIFY_CRON` 覆盖。`bun run dev` 同时启动 Web 与 API，自托管 Bun 运行时会启动并优雅停止归类调度器。

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
