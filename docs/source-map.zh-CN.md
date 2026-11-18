# 源码导航（本地 v2.28.0 自定义版）

[English](source-map.md) · [项目入口](../README.md) · [完整产品说明](readme/README.zh-CN.md) · [贡献指南](CONTRIBUTING.zh-CN.md)

本目录以交付时的本地自定义源码为基线。整理目录、引用与注释时保留已有产品逻辑；没有用上游版本覆盖这份快照。后端文件名保留原名，方便在 Cursor 中按功能名搜索。

## 系统组成

| 目录 | 职责与定位入口 |
| --- | --- |
| `apps/web/src` | React Web UI；`components/` 找界面，`lib/` 找客户端状态、存储和平台桥接 |
| `apps/api/src/index.ts` | Hono 应用、认证中间件和路由注册；`fetchEdgeEverApp` 为共用请求入口，默认导出是 Worker 适配入口 |
| `apps/api/src/api-context.ts` | 请求上下文、认证身份及运行时 bindings 类型 |
| `apps/desktop/src` | Electron 主进程、预加载桥、桌面能力；Rust 本地数据服务在 `crates/desktop-sidecar` |
| `apps/mobile` | Android：Expo / React Native；不是 iOS 主客户端 |
| `apps/ios` | iOS：Swift / SwiftUI；编辑器源在 `EditorSource/` |
| `apps/extension` | Chrome、Edge、Firefox 网页剪藏 |
| `apps/site` | Astro 官网，与产品应用分开构建 |
| `packages/client/src` | 各客户端共用 REST SDK、AI 模型适配及直连请求 |
| `packages/shared/src` | 跨端类型、Zod 校验、Markdown 和结构化笔记协议 |
| `packages/public-network`、`packages/image-host`、`packages/plugin-api` | 网络安全策略、图床与插件公开接口 |
| `migrations` | 追加式 SQL；D1 和本地 SQLite 共用，禁止改写已执行文件 |
| `scripts`、`tests` | 启动/构建/维护脚本、跨模块与端到端测试 |
| `docs/readme` | 完整英文产品说明及全部既有翻译；根 README 是简明入口 |

## 后端功能目录

路由、服务与对应测试并置，不为小模块额外增加 controller/service 层级。业务通过 `storage/storage-contract.ts` 访问存储，运行时适配留在驱动中。

| 模块 | 入口与主要实现 |
| --- | --- |
| [mcp/](../apps/api/src/mcp) | `mcp-routes.ts`：`/mcp` 协议和发现；`mcp-tools.ts`：工具定义；`mcp-json-rpc.ts`：协议/参数辅助；`mcp-tool-executor.ts` → `mcp-tool-service.ts`：共用分发与权限校验；`mcp-attachment.ts`：附件工具参数和 MCP 内容块 |
| [ai/](../apps/api/src/ai) | `ai-routes.ts`：模型配置/生成准备；`ai-service.ts`：模型与凭据；`ai-provider-relay.ts`：浏览器兜底转发；`ai-prompt-*`：提示词；`companion-*`：助手状态、工具、记忆；`inbox-classification*`：本地自定义自动归档 |
| [notes/](../apps/api/src/notes) | `memo-routes.ts` → `memo-service.ts`：笔记；`memo-list-service.ts`：列表与搜索；`memo-revision-service.ts`：版本；`notebook-*`、`tag-*`：笔记本与标签；分享、表单、模板、导入与海报渲染也在此 |
| [attachments/](../apps/api/src/attachments) | `resource-routes.ts` / `resource-service.ts`：已绑定附件；`resource-upload-service.ts`：分片；`pending-resource-*`：先上传后绑定；`attachment-content.ts`：HTTP 与 MCP 共用读取/Word 提取；`attachment-content-routes.ts`：HTTP 文本读取 |
| [auth/](../apps/api/src/auth) | `auth-routes.ts`、`auth-service.ts`：登录/会话；`api-token-routes.ts`、`request-auth.ts`：令牌/权限；TOTP、密钥加解密与用户管理 |
| [storage/](../apps/api/src/storage) | `storage-contract.ts`：数据库/Blob 契约；`cloudflare-storage-adapter.ts`：D1/R2；`self-hosted-storage-adapter.ts`：SQLite/文件；`object-storage.ts` 与 S3 适配器：对象存储选择 |
| [backup/](../apps/api/src/backup) | `backup-routes.ts` → `backup-service.ts`：备份与恢复 |
| [sync/](../apps/api/src/sync) | `sync-routes.ts`：跨端增量同步 |
| [workspace/](../apps/api/src/workspace) | 工作区创建、统计、初始示例和 Demo |
| [plugins/](../apps/api/src/plugins) | 插件分发、能力、扩展和社区市场代理 |
| [tasks/](../apps/api/src/tasks) | `scheduled-task-routes.ts`：计划任务 API |
| [common/](../apps/api/src/common) | 跨模块错误、审计、ID/摘要与公共网络辅助 |

## 从请求找到代码

- MCP：`POST /mcp` → `registerMcpRoutes` / `handleMcpMessage` → `executeWorkspaceTool` → `callMcpTool` → 各业务服务。`tools/list` 与新版 `server/discover` 的发现来自同一份 `MCP_TOOLS`。工具成功返回 JSON 文本和 `structuredContent`；附件/海报读取另加专用内容块。执行失败返回 `isError: true` 和 `structuredContent.error`；协议错误走 JSON-RPC error，不能混为业务成功。
- 笔记：`/api/v1/memos` → `notes/memo-routes.ts` → `memo-service.ts`。`expectedRevision`、内容哈希与编辑会话各有职责；409 后应重新读取并协调内容，不要去掉版本校验盲重试。
- 附件：直接上传绑定到现有笔记，或 MCP 申请 pending 上传 URL → 上传原字节 → `create_memo` / `update_memo` 的 `resourceIds` 原子绑定。准备绑定只是生成 SQL，必须和笔记写入使用同一 batch；失败时文件保持 pending，已成功使用的一次性 URL 不能重新上传。
- 附件读取：`read_memo_attachment` 的 `memoId` 与 `resourceId` 必须属于当前工作区且已绑定。`content` 返回白名单图片的 image 内容块，或 Word/UTF-8 文本；Word 只提取 `word/document.xml` 的正文、段落、制表符与换行，不返回排版、图片或 OCR。`original` 返回原文件的 resource/blob，不是提取文本。图片/原文件各限 2 MiB，Word 压缩文件限 8 MiB、正文 XML 解压限 2 MiB，普通文本限 1 MiB；文本每页最多 12,000 个 UTF-16 代码单元，续读使用返回的 `nextOffset`。PDF 和旧 `.doc` 没有文本提取，超限或不支持会报错，不自动换格式。HTTP 文本接口复用相同读取规则，只接受文本结果。
- AI：普通生成和助手推理主要在 `packages/client/src/ai-direct-*`、`companion-direct-stream.ts`，供应商工厂在 `ai-model.ts`。后端负责准备上下文、凭据与工具；浏览器网络/CORS 失败才允许转发，已有 HTTP 响应或已收到流式内容后不自动再发一遍。后端 `ai/test-support/companion-model.ts` 只是测试桩，不是生产运行时。
- 自定义自动归档：`scripts/self-hosted-server.mjs` → `ai/inbox-classification.ts` → `inbox-classification-model.ts`。仅指定的本地自托管工作区启用；模型结果先检查结构、目的地序号、空结果和截断。兼容重试只针对输出错误或提供商 400/422；单次请求限时 30 秒、任务模型阶段限时 65 秒。持续输出错误、认证错误或不明确建议留在收件箱；暂时故障/429/源笔记修改才受次数上限约束重排。写前重读版本，避免等待模型时覆盖用户修改。

## 本地开发与验证

```sh
bun install --frozen-lockfile
bun run dev
bun run typecheck
bun run typecheck:mobile
bun run test
bun run build:web
bun run build:worker
bun run build:self-hosted
bun test ./apps/api/src/mcp ./apps/api/src/attachments
bun test ./scripts/readme-assets.test.mjs ./scripts/sync-readme-contributors.test.mjs
```

`bun run dev` 启动 Web 与 API；自托管入口为 `scripts/self-hosted-server.mjs`，Worker 配置在 `wrangler.toml`。模块内 `*.test.mjs` 为近代码测试，`tests/` 为跨模块测试，`tests/e2e/` 为需要浏览器/实例的端到端测试。`test:integration` 将已知需要隔离的测试单独运行。Android 调测只用 USB 真机。

更多指南：[MCP](mcp-guide.zh-CN.md)、[AI/ACP](acp-note-access.zh-CN.md)、[本地开发](local-dev-reset.zh-CN.md)、[Docker](deploy-docker.zh-CN.md)、[Cloudflare](agent-deploy-cloudflare.zh-CN.md)。
