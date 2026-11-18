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

1. 按主题或可回查的编号搜索已有笔记。匹配明确时，读取旧笔记，传入 `expectedRevision`，补充到对应小节并保留原结构和附件引用。有多个候选笔记时，把新材料以 `autoClassify: false` 保存到「等待分类」，留待确认。
2. 新建并整理笔记时，调用 `select_note_template` 按用途选模板。问题报告、会议纪要、进展复盘、阅读、灵感和目标拆解分别用 `issue`、`meeting`、`progress`、`reading`、`idea`、`goals`。混合用途用 `general`，优先使用工作区的「AI 对话通用模板」。原样保存用 `verbatim`。用户指定模板时传 `templateId`。将整理好的 Markdown 与所选模板 ID 交给 `create_memo`，可带入模板的默认标题和标签。
3. 写入前先上传原件。图片紧跟对应段落，文档链接放在引用它的小节。供整篇查阅的材料放在文末「参考资料」。同一个文件只上传一次。写入时传入 `requireResourcePlacement: true` 可检查新增资源是否都有正文引用。
4. 用户明确指定笔记本时传入 `notebookId`。否则新笔记进入「等待分类」，已有普通笔记更新正文后也可回到该处重新分类。无附件的完全相同内容可以复用原笔记，用户要求另存副本时传 `allowDuplicate: true`。

Docker 或其他 Bun 自托管部署的后台归类使用 EdgeEver 配置的默认模型。它参考标题、正文、已有标签和附件名，在现有笔记本中选择归属。归属不明或模型调用失败时留在「等待分类」，可以在网页上查看状态并重试。给服务设置 `EDGE_EVER_AUTO_CLASSIFY=false` 可关闭自动归类，或设置 `EDGE_EVER_AUTO_CLASSIFY_WORKSPACE` 将其限制在指定工作区。

## 4. 上传本地文件

使用 `stage_memo_resource` 可以通过 MCP 直接上传不超过 2 MiB 的图片或文档原件。传入 `kind`、`filename`、`mimeType` 和 `dataBase64`，结果包含待绑定的 `resourceId` 与可插入的 Markdown。文件更大或客户端只能提供本地路径时，使用一次性上传 URL：

1. 调用 `create_resource_upload_url`，传入 `kind`（`image` 或 `attachment`）、`mimeType` 和准确的 `byteSize`，可选传入 `filename` 和 `label`（图片替代文本或链接文字）。无需事先创建笔记。
2. 将返回的 `curl` 命令中的 `<path-to-file>` 替换为文件路径后执行。该命令以 `PUT` 将文件发送到 `/api/public/resource-uploads`，并在 `Authorization` 请求头中携带专用的上传 Token。命令中不会出现 MCP Token。`201` 响应包含 `resourceId`、需要登录访问的 `url`，以及可插入的 `markdownImage` 或 `markdownLink`。
3. 调用 `create_memo`，在 `contentMarkdown` 中放入该 Markdown，并在 `resourceIds` 中传入资源 ID。笔记与文件一并保存；调用失败时不会保存任何内容，文件仍可用于重试。已有笔记可将 `resourceIds` 传给 `update_memo`。

每个 URL 只接受一个与声明大小和类型完全一致的文件，最大 100 MiB，有效期 15 分钟。大小或类型不符的请求会被拒绝，但不会消耗该 URL；重复一次已成功的上传会返回相同的 `resourceId`。创建它的 Token 被撤销或失去 `write:resources` 权限后，URL 也随之失效。上传后 24 小时内未绑定到笔记的文件会被删除。每个工作区最多同时保留 20 个未使用的 URL 和 100 个未绑定文件（共 1 GiB）。绑定文件需要 `write:resources` 权限。

## 5. 排障

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
