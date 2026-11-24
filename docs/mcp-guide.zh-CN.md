# 在 MCP 客户端与 AI Agent 中使用 EdgeEver

[English](mcp-guide.md)

## 1. 连接客户端

在 **个人中心** → **API / MCP** 中为每个客户端单独创建 Token，然后点击 **复制 MCP 配置**。搜索和总结选 **只读访问**，需要新建或修改笔记时选 **完全访问**。如果 Token 泄露，在这里删除它并创建新的 Token。

远程客户端通过 Streamable HTTP 连接。使用实例地址加 `/mcp`，例如 `https://notes.example.com/mcp`，并发送 `Authorization: Bearer <token>`。请确认复制的地址指向你的 EdgeEver 实例。

### Cursor 等支持 `mcpServers` 的客户端

将 **复制 MCP 配置** 得到的 JSON 粘贴到客户端的 MCP 设置中。下面是 `mcpServers` 示例。请把真实 Token 留在本地，避免提交到仓库。

```json
{
  "mcpServers": {
    "edgeever": {
      "url": "https://notes.example.com/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add --scope user --transport http edgeever https://notes.example.com/mcp \
  --header "Authorization: Bearer <token>"
claude mcp get edgeever   # 应显示 "Connected"
```

省略 `--scope user` 可将配置限制在当前项目。

### VS Code

在 `.vscode/mcp.json` 或用户级 `mcp.json` 中使用 `servers` 和 `type: "http"`。以下示例会提示输入 Token，也可以改用环境变量 `${env:EDGEEVER_TOKEN}`。

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "edgeever-token",
      "description": "EdgeEver API Token",
      "password": true
    }
  ],
  "servers": {
    "edgeever": {
      "type": "http",
      "url": "https://notes.example.com/mcp",
      "headers": { "Authorization": "Bearer ${input:edgeever-token}" }
    }
  }
}
```

### 仅支持 stdio 的客户端

安装 Bun，在仓库根目录保存连接配置，再让客户端启动桥接脚本。将示例路径替换为脚本的实际绝对路径。

```bash
# 一次性：在 ~/.edgeever/config.json 中保存配置
bun run cli -- profile set personal --url https://notes.example.com --token "<token>"

# 在客户端中运行：
bun /path/to/edgeever/scripts/edgeever-mcp-stdio.mjs --profile personal
```

也可以用 `EDGEEVER_URL` 和 `EDGEEVER_TOKEN` 环境变量代替 `--profile`。只支持 OAuth 的连接器无法直接连接。如果客户端能启动本地命令，可使用此桥接。

## 2. 验证连接

让 Agent 调用 `get_current_user`，核对返回的账号、工作区和 Token 权限。再让它调用 `list_notebooks`，确认能读取笔记本。

可以在客户端自定义指令、`AGENTS.md` 或 `CLAUDE.md` 中加一条规则。例如「新笔记放进『Agent 笔记』，先搜索同主题笔记。删除或合并前先征得我的同意。」

使用 `get_memo` 读取普通笔记，或在 `list_memos` 中设置 `includeContent: true` 获取全文时，响应会提供笔记元数据和一份 `contentMarkdown` 正文。已有集成如果读取 `contentJson` 或 `contentText`，请传入 `format: "all"` 以保留原有响应。

使用 `search_memos` 进行关键词搜索时，如果能在正文中定位查询词或其中的词项，结果还会包含最多 200 个字符的 `snippet` 命中片段，并保留原有 `excerpt` 摘要。无法定位正文命中的结果（包括仅标题或标签命中）沿用现有摘要。如果答案涉及片段外的上下文，请继续读取笔记全文。

## 3. 将 AI 对话保存为普通笔记

1. 按主题或可回查的编号搜索已有笔记。匹配明确时，读取旧笔记，传入 `expectedRevision`，补充到对应小节并保留原结构和附件引用。用户点名了目标笔记且匹配唯一时，用 `save_ai_conversation` 传 `memoId` + `duplicate: "supplement"` 直接补充；同名有多条时先让用户选择。有多个候选笔记但不属于同题合并时，可把新材料保存到「等待分类」留待确认。
2. 新建并整理笔记时，调用 `select_note_template` 按用途选模板。问题报告、会议纪要、进展复盘、阅读、灵感和目标拆解分别用 `issue`、`meeting`、`progress`、`reading`、`idea`、`goals`。混合用途用 `general`，优先使用工作区的「AI 对话通用模板」。原样保存用 `verbatim`。用户指定模板时传 `templateId`。将整理好的 Markdown 与所选模板 ID 交给 `create_memo`，可带入模板的默认标题和标签。
3. 写入前先上传原件。图片紧跟对应段落，文档链接放在引用它的小节。供整篇查阅的材料放在文末「参考资料」。同一个文件只上传一次。写入时传入 `requireResourcePlacement: true` 可检查新增资源是否都有正文引用。
4. 用户明确指定笔记本时传入 `notebookId`，笔记本优先。否则新笔记进入「等待分类」。无附件的完全相同内容可以复用原笔记，用户要求另存副本时传 `allowDuplicate: true`。

### 3.1 笔记归属（新建 / 更新 / 恢复）

- **新建**：指定 `notebookId` 就直接存入目标；未指定则进入「等待分类」。`autoClassify` 只决定收件箱里的新笔记是否排队，不影响显式目标。
- **更新**：普通更新默认**留在原笔记本**，不必再传 `autoClassify: false`。需要移动时传 `notebookId`（显式目标优先）；需要重新分类时传 `autoClassify: true`，笔记会移入「等待分类」。
- **移入与排队分开**：移入「等待分类」和「启动自动分类」是两件事。`EDGE_EVER_AUTO_CLASSIFY=false` 时仍能把笔记移入「等待分类」，只是不会创建分类任务。
- **恢复**：优先回原笔记本；原笔记本已删除时才回「等待分类」。

### 3.2 保存对话（`save_ai_conversation`）

明确的对话沉淀场景使用 `save_ai_conversation`，而不是通用 `create_memo`。它复用「AI 对话通用模板」的四个章节（结论、关键步骤 / 依据、验证结果、来源 / 链接）、「对象｜主题」标题和 `AI沉淀` 标签。

| 场景 | 调用 |
|---|---|
| 保存为新笔记 | `{"message":"…","response":"…","object":"产品发布计划"}` → 进「等待分类」 |
| 补充指定笔记（原地） | 加 `memoId` + `expectedRevision` + `duplicate:"supplement"`，可选 `section:{heading,mode}` |
| 同题合并 | 加 `memoId` + `duplicate:"merge"`：补充后移入「等待分类」（自动分类关闭时只移动） |
| 另存新笔记 | 候选返回后传 `duplicate:"new"` |
| 重新分类 | 普通笔记更新时传 `autoClassify:true`，或保存对话时 `duplicate:"merge"` |

标题已有同题笔记时返回 `duplicate_match_found`，`error.candidates` 含 `memoId`、`title`、`notebookId`、`excerpt`（该笔记的简短正文片段，与笔记列表同一摘要来源），供客户端展示「补充已有／另存新笔记」。候选只是读取结果，返回候选时不会写入任何笔记；只有用户选定后才产生一次写入。

## 4. 章节更新与并发保护

- 优先用 `update_memo` 的 `sectionOperations`：`append` 追加到该章节、`replace` 只替换该章节，其余正文和附件引用保持不变。不要为了改一处而重写全文。
- 章节缺失返回 `section_not_found`，标题重名返回 `section_ambiguous`，两者都带 `availableHeadings`，笔记不会被改动；据返回的章节重新定位，不要退回全文重写。
- 传 `expectedRevision` 做并发保护；冲突返回 `revision_conflict` 并附带 `currentRevision`、`notebookId`、`title`，重新读取后再改。
- 追加和同题补充可传可选 `idempotencyKey`：同一次请求超时重试只生效一次。用户日后有意追加相同文字时，换一个 key 或省略它。

## 5. 附件：来源、插入与汇总

完整流程是「上传 → 插入指定位置 → 设置或修改来源 → 更新汇总 → 读回核对」：

1. 用 `upload_memo_attachment`（≤2 MiB，可带 `source`）、`stage_memo_resource` 或 `create_resource_upload_url` 上传。
2. 用 `insert_memo_resource` 按章节（`anchor:{section,position}`）或正文锚点（`afterText` / `beforeText`）插入；定位失败返回 `section_not_found` / `section_ambiguous` / `anchor_not_found`，不回退到文末。
3. 用 `set_attachment_source` 设置或修改来源，复用同一套格式（`文件名 · P.3-5 · 章节：X · 工作表：X · 范围：A1:C9 · url · 说明：X`），支持页码、章节、工作表与范围；`source: null` 清除来源。
4. 用 `update_attachment_summary`（传 `expectedRevision`）更新「附件汇总」。正文附件卡片保留，文末每个附件只显示一条链接和最新来源；重复调用幂等。
5. 用 `get_memo` / `list_memo_resources` 读回核对正文与来源。

## 6. 上传本地文件

使用 `stage_memo_resource` 可以通过 MCP 直接上传不超过 2 MiB 的图片或文档原件。传入 `kind`、`filename`、`mimeType` 和 `dataBase64`，结果包含待绑定的 `resourceId` 与可插入的 Markdown。文件更大或客户端只能提供本地路径时，使用一次性上传 URL：

1. 调用 `create_resource_upload_url`，传入 `kind`（`image` 或 `attachment`）、`mimeType` 和准确的 `byteSize`，可选传入 `filename` 和 `label`（图片替代文本或链接文字）。无需事先创建笔记。
2. 将返回的 `curl` 命令中的 `<path-to-file>` 替换为文件路径后执行。该命令以 `PUT` 将文件发送到 `/api/public/resource-uploads`，并在 `Authorization` 请求头中携带专用的上传 Token。命令中不会出现 MCP Token。`201` 响应包含 `resourceId`、需要登录访问的 `url`，以及可插入的 `markdownImage` 或 `markdownLink`。
3. 调用 `create_memo`，在 `contentMarkdown` 中放入该 Markdown，并在 `resourceIds` 中传入资源 ID。笔记与文件一并保存；调用失败时不会保存任何内容，文件仍可用于重试。已有笔记可将 `resourceIds` 传给 `update_memo`。

每个 URL 只接受一个与声明大小和类型完全一致的文件，最大 100 MiB，有效期 15 分钟。大小或类型不符的请求会被拒绝，但不会消耗该 URL；重复一次已成功的上传会返回相同的 `resourceId`。创建它的 Token 被撤销或失去 `write:resources` 权限后，URL 也随之失效。上传后 24 小时内未绑定到笔记的文件会被删除。每个工作区最多同时保留 20 个未使用的 URL 和 100 个未绑定文件（共 1 GiB）。绑定文件需要 `write:resources` 权限。

Docker 或其他 Bun 自托管部署的后台归类使用 EdgeEver 配置的默认模型。它参考标题、正文、已有标签和附件名，在现有笔记本中选择归属。归属不明或模型调用失败时留在「等待分类」，可以在网页上查看状态并重试。给服务设置 `EDGE_EVER_AUTO_CLASSIFY=false` 可关闭自动归类，或设置 `EDGE_EVER_AUTO_CLASSIFY_WORKSPACE` 将其限制在指定工作区。关闭后仍可用 `autoClassify: true` 把笔记移入「等待分类」，只是不会创建分类任务。

## 7. 排障

| 现象 | 原因与处理 |
|---|---|
| `401`，提示 "Authentication required" | 客户端没有发送凭据。检查是否设置了 `Authorization` 请求头，包括请求头名称和 `Bearer ` 前缀。 |
| `401`，且 `WWW-Authenticate` 响应头包含 `error="invalid_token"` | Token 已发送但被拒绝。确认它属于当前实例；如果已被删除或替换，创建新 Token 并更新客户端。 |
| `403` "Origin is not allowed" | 基于浏览器的客户端发送了外部 `Origin`。请在浏览器外运行客户端，或使用 stdio 桥接。 |
| 客户端报告 JSON 无效或收到 HTML 页面 | URL 没有指向服务器上的 `/mcp`（例如拼写错误、`//mcp` 或桌面应用地址）。 |
| 修改数据的工具被拒绝 | Token 为只读。确实需要写入时，再为该客户端创建 **完全访问** Token。 |
| 上传 URL 返回 `410` | 该 URL 已用于其他文件或已过期。请重新调用 `create_resource_upload_url`。 |
| 上传 URL 返回 `400` 或 `415` | 文件与声明的 `byteSize` 或 `mimeType` 不符。用 `wc -c` 核对大小后重新发送同一文件。 |
| `create_memo` 提示资源不是待绑定的上传 | ID 有误、已被绑定，或文件未在 24 小时内绑定。请重新上传。 |

较旧的实例可能对缺少凭据和 Token 被拒绝返回相同的通用 `401`。先核对实例地址、请求头和 Token。

## 8. 自定义版内置助手与分类界面

网页右侧的内置助手与外部 MCP 共用笔记和附件服务，不需要本机 ACP。点击「引用当前笔记」后，输入框上方显示可移除的笔记引用；选区和上传文件保留各自的移除入口。未引用正文时，当前笔记仅提供定位信息，助手按问题需要调用读取工具。

- 「仅建议」限制本回合只读；直接输入「先给建议，不要修改笔记」也会在服务端移除写入工具。明确要求修改时执行现有工具，并保留版本和并发校验。
- 「读取附件」「提取待办」「对比笔记」是只读快捷操作。附件读取复用 `list_memo_resources` 和 `read_memo_attachment`；图片通过真实的图像内容进入模型，Word DOCX/UTF-8/PDF 文本按 `nextOffset` 继续读取。PDF 文本返回 `pageStart`/`pageEnd`/`pageCount`，引用时标注页码；无文本层的扫描件需要 OCR，加密或损坏文件直接报错。图片需要所选模型支持视觉输入；不自动换模型或猜测未读取内容。Excel 没有正文提取器，可继续使用已有的文件上传/预览能力。
- 笔记正文每页最多 12,000 字符，单回合读取正文和附件文本的共享预算为 64,000 字符；未连续读完的笔记不能整篇替换。每回合最多读取四张图片，单图 2 MiB。Word、文本的原有文件大小和安全校验保持不变。多步处理最多 16 个模型步骤、32 次工具调用；到达工具步骤上限时保留已完成记录并提供继续入口，未读完或失败不能报告全部完成。
- 工具记录默认收起，展开可查看任务状态、操作、实际笔记链接和失败原因。保存、追加回答使用已经完成的原回答，不再次调用模型改写。重复点击或网络重试复用同一份操作记录。追加只支持普通文本笔记，先保存编辑器草稿，再校验最新版本；不覆盖已有正文和附件引用。未指定归属的保存或追加会进入等待分类。
- 新建经过整理的笔记时，助手可按用途选择模板，保留外部 MCP 既有的模板、去重和正文内附件位置规则；「保存为新笔记」按钮明确按原回答保存，不强行套空模板。回答中的原附件链接仍指向原资源，不额外复制附件。
- 分类卡片只在「等待分类」中展示处理、失败和重试。已归类笔记可从编辑器「更多 → 自动分类详情」按需读取结果；没有记录的旧笔记不会被标成自动分类成功。调整归属使用标准笔记本选择器或批量移动，不再提供重复的「移回等待分类」按钮。
- 通过网页标准移动功能移入等待分类会重新排队；手动指定其它笔记本会在同一事务中取消旧分类任务，旧模型结果不能覆盖新选择。外部 MCP 或内置助手明确指定笔记本时仍尊重指定位置。

此更新不增加数据库迁移，继续使用迁移 `0098`。本地测试使用独立临时数据和模拟模型，模型真实回答质量与腾讯云上线后的浏览器交互需要在目标实例验收。
