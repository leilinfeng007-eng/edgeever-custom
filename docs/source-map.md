# Source map (v2.28.2 customized edition)

[简体中文](source-map.zh-CN.md) · [Project entry](../README.md) · [Full product guide](readme/README.md) · [Contributing](CONTRIBUTING.md)

This edition uses upstream v2.28.2 while retaining the customized layout, MCP attachment reader and note classification. Backend filenames are retained so Cursor searches still find familiar feature names.

## System components

| Location | Responsibility and entry point |
| --- | --- |
| `apps/web/src` | React Web UI; `components/` for views, `lib/` for client state, persistence and platform bridges |
| `apps/api/src/index.ts` | Hono application, authentication middleware and route registration; `fetchEdgeEverApp` is the shared request entry, the default export adapts Workers |
| `apps/api/src/api-context.ts` | Request context, authenticated identity and runtime bindings |
| `apps/desktop/src` | Electron main process, preload bridge and desktop capabilities; Rust local data services live in `crates/desktop-sidecar` |
| `apps/mobile` | Android: Expo / React Native; not the main iOS client |
| `apps/ios` | iOS: Swift / SwiftUI; editor source lives in `EditorSource/` |
| `apps/extension` | Chrome, Edge and Firefox web clipping |
| `apps/site` | Astro product site, built separately from the application |
| `packages/client/src` | Shared REST client, AI provider adapters and direct model requests |
| `packages/shared/src` | Cross-platform types, Zod validation, Markdown and structured-note protocols |
| `packages/public-network`, `packages/image-host`, `packages/plugin-api` | Public network policy, image hosting and public plugin interfaces |
| `migrations` | Append-only SQL shared by D1 and SQLite; never rewrite applied migrations |
| `scripts`, `tests` | Startup/build/maintenance scripts, cross-module and end-to-end tests |
| `docs/readme` | Full English description and existing translations; the root README is the short entry point |

## Backend modules

Routes, services and their tests live together. Small modules do not need additional controller/service layers. Business code uses `storage/storage-contract.ts`; runtime details stay in infrastructure adapters.

| Module | Entry points and implementations |
| --- | --- |
| [mcp/](../apps/api/src/mcp) | `mcp-routes.ts`: `/mcp` transport/discovery; `mcp-tools.ts`: tool definitions; `mcp-json-rpc.ts`: protocol/argument helpers; `mcp-tool-executor.ts` → `mcp-tool-service.ts`: shared dispatch and authorization; `mcp-attachment.ts`: tool arguments and MCP content blocks |
| [ai/](../apps/api/src/ai) | `ai-routes.ts`: model configuration/generation preparation; `ai-service.ts`: models/credentials; `ai-provider-relay.ts`: browser fallback relay; `ai-prompt-*`: prompts; `companion-*`: assistant state, tools and memory; `inbox-classification*`: customized local classification |
| [notes/](../apps/api/src/notes) | `memo-routes.ts` → `memo-service.ts`: notes; `memo-list-service.ts`: listing/search; `memo-revision-service.ts`: revisions; `notebook-*`, `tag-*`: notebooks/tags; sharing, forms, templates, imports and poster rendering also live here |
| [attachments/](../apps/api/src/attachments) | `resource-routes.ts` / `resource-service.ts`: bound attachments; `resource-upload-service.ts`: multipart uploads; `pending-resource-*`: upload before binding; `attachment-content.ts`: shared HTTP/MCP reads and Word extraction; `attachment-content-routes.ts`: HTTP text reads |
| [auth/](../apps/api/src/auth) | `auth-routes.ts`, `auth-service.ts`: login/sessions; `api-token-routes.ts`, `request-auth.ts`: tokens/scopes; TOTP, secret encryption and user administration |
| [storage/](../apps/api/src/storage) | `storage-contract.ts`: database/Blob contracts; `cloudflare-storage-adapter.ts`: D1/R2; `self-hosted-storage-adapter.ts`: SQLite/files; `object-storage.ts` and S3 adapters: storage selection |
| [backup/](../apps/api/src/backup) | `backup-routes.ts` → `backup-service.ts`: backup and restoration |
| [sync/](../apps/api/src/sync) | `sync-routes.ts`: incremental cross-platform synchronization |
| [workspace/](../apps/api/src/workspace) | Workspace provisioning, statistics, initial examples and Demo |
| [plugins/](../apps/api/src/plugins) | Plugin distribution, capabilities, extensions and community registry proxy |
| [tasks/](../apps/api/src/tasks) | `scheduled-task-routes.ts`: scheduled-task API |
| [common/](../apps/api/src/common) | Shared errors, audit, IDs/hashing and public-network helpers |

## Follow a request

- MCP: `POST /mcp` → `registerMcpRoutes` / `handleMcpMessage` → `executeWorkspaceTool` → `callMcpTool` → business services. `tools/list` and modern `server/discover` use the same `MCP_TOOLS`. Successful calls contain JSON text and `structuredContent`; attachment/poster reads add dedicated content blocks. Execution failures return `isError: true` and `structuredContent.error`; transport/protocol errors use JSON-RPC error responses.
- Notes: `/api/v1/memos` → `notes/memo-routes.ts` → `memo-service.ts`. Revision checks, content hashes and edit sessions guard different boundaries. After a 409, reload and reconcile; do not remove version checks and blindly retry.
- Attachments: upload directly into an existing note, or obtain a pending upload URL through MCP → upload original bytes → atomically bind `resourceIds` in `create_memo` / `update_memo`. Preparing a binding only builds SQL; execute it in the same batch as the note mutation. Failed batches leave files pending. A successfully consumed single-use URL cannot be uploaded again.
- Attachment reads: `read_memo_attachment` requires a `memoId` / `resourceId` pair already bound inside the current workspace. `content` returns an image block for allowlisted images, or Word/UTF-8 text. Word extraction reads only `word/document.xml` body text, paragraphs, tabs and breaks; it does not preserve layout, extract embedded images or perform OCR. `original` returns original bytes in a resource/blob. Image/original reads are limited to 2 MiB each; Word archives to 8 MiB and inflated body XML to 2 MiB; plain text to 1 MiB. Text pages contain at most 12,000 UTF-16 code units; continue with the returned `nextOffset`. PDF and legacy `.doc` have no text extractor. Oversized/unsupported content fails without automatic format fallback. The HTTP text endpoint shares these rules and accepts only text results.
- AI: ordinary generation and assistant inference mainly live in `packages/client/src/ai-direct-*` and `companion-direct-stream.ts`; provider construction lives in `ai-model.ts`. The backend prepares context, credentials and tools. Browser network/CORS failure may use the relay; an HTTP response or streamed content prevents automatic duplicate calls. Backend `ai/test-support/companion-model.ts` is a test harness, not production inference.
- Customized inbox classification: `scripts/self-hosted-server.mjs` → `ai/inbox-classification.ts` → `inbox-classification-model.ts`. Only the configured self-hosted workspace enables it. Model responses are checked for shape, destination range, empty output and truncation. Compatibility fallback is restricted to output errors or provider 400/422. Each request has a 30-second timeout; the job's model phase has a 65-second budget. Persistent output/authentication errors and uncertain suggestions retain the note in the inbox; temporary failures/429/source edits requeue within the attempt limit. The source revision is re-read before writing so user edits made during inference are protected.

## Local development and checks

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

`bun run dev` starts Web and API together. The self-hosted entry is `scripts/self-hosted-server.mjs`; Workers configuration lives in `wrangler.toml`. Module `*.test.mjs` files are colocated tests, `tests/` contains cross-module checks, and `tests/e2e/` requires browser/instance setup. `test:integration` runs known isolation-sensitive cases separately. Android debugging requires a USB physical device.

More guides: [MCP](mcp-guide.md), [AI/ACP](acp-note-access.md), [local development](local-dev-reset.md), [Docker](deploy-docker.md), [Cloudflare](agent-deploy-cloudflare.md).

Built-in attachment reading lives in `ai/companion-agent-tools.ts`; model image-message adaptation in `packages/client/src/companion-model-messages.ts`. Persisted-answer saves and idempotent receipts live in `ai/companion-save-response.ts`. Classification list cards and on-demand details live in `InboxClassificationPanel.tsx` and `NoteClassificationDetails.tsx`.
