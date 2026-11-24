# Using EdgeEver with MCP clients and AI agents

[简体中文](mcp-guide.zh-CN.md)

## 1. Connect a client

Open **Profile** → **API / MCP**, create a separate token for each client, then select **Copy MCP config**. Choose **Read-only** for search and summaries or **Full access** if the client needs to create or edit notes. If a token leaks, delete it here and create a replacement.

Remote clients connect over Streamable HTTP. Use your instance URL followed by `/mcp`, such as `https://notes.example.com/mcp`, and send `Authorization: Bearer <token>`. Check that the copied URL points to your EdgeEver instance.

### Cursor and other clients that use `mcpServers`

Paste the JSON from **Copy MCP config** into your client's MCP settings. The example below shows the `mcpServers` format. Keep the actual token in local settings outside version control.

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
claude mcp get edgeever   # should report "Connected"
```

Omit `--scope user` to register the server for the current project only.

### VS Code

Use `servers` and `type: "http"` in `.vscode/mcp.json` or your user-level `mcp.json`. This example prompts for the token. You can also use `${env:EDGEEVER_TOKEN}` to read it from the environment.

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "edgeever-token",
      "description": "EdgeEver API token",
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

### Clients that only support stdio

Install Bun, save a connection profile from the repository root, then configure the client to launch the bridge. Replace the example path with the script's absolute path.

```bash
# Once: save a profile in ~/.edgeever/config.json
bun run cli -- profile set personal --url https://notes.example.com --token "<token>"

# In the client, run:
bun /path/to/edgeever/scripts/edgeever-mcp-stdio.mjs --profile personal
```

You can use the `EDGEEVER_URL` and `EDGEEVER_TOKEN` environment variables instead of `--profile`. OAuth-only connectors cannot connect directly. Use the bridge if your client can launch a local command.

## 2. Verify the connection

Ask the agent to call `get_current_user` and check the account, workspace and token scopes. Then ask it to call `list_notebooks` to confirm read access.

Add a rule in your client's custom instructions, `AGENTS.md` or `CLAUDE.md`. For example, “Put new notes in Agent notes and search for an existing note on the topic first. Ask me before deleting or merging notes.”

When reading a prose memo with `get_memo` or listing full bodies with `list_memos` and `includeContent: true`, the response includes `contentMarkdown` as the only full body, alongside memo metadata. If an existing integration reads `contentJson` or `contentText`, pass `format: "all"` to retain the previous response.

Keyword searches with `search_memos` also return a `snippet` of up to 200 characters when the query or its terms can be located in the body. The original `excerpt` is retained. Results without a located body match, including title-only or tag-only matches, use the existing summary. Read the memo when the answer depends on context outside the snippet.

## 3. Save an AI conversation as a prose note

1. Search for the topic or a stable identifier. When the match is clear, read the existing note and update its relevant section using `expectedRevision`. Keep its structure and existing file references. When the user names one exact target note, call `save_ai_conversation` with `memoId` and `duplicate: "supplement"`. When several notes share the name, ask the user first. When candidates exist but this is not a same-topic merge, you can save the new material in the inbox for review.
2. For a new formatted note, call `select_note_template` with its purpose. Supported purposes are `issue`, `meeting`, `progress`, `reading`, `idea`, `goals`, `general`, and `verbatim`. Give the user's chosen `templateId` if specified. Mixed-purpose notes use the workspace's general AI conversation template when present. Write the final Markdown and include the chosen template ID in `create_memo` to apply its title fallback and tags. Keep verbatim text as supplied.
3. Stage each file before writing. Put images next to the paragraph they illustrate, and document links in the sections that cite them. Use a final **References** section for files that apply to the whole note, and reuse the same resource ID for later citations. Pass `requireResourcePlacement: true` to check that each new resource is referenced.
4. Supply `notebookId` when the user explicitly chooses a notebook; the explicit notebook always wins. Otherwise new notes enter 等待分类 (the inbox). Exact matches without attachments can return the existing note. Use `allowDuplicate: true` when a separate copy was requested.

### 3.1 Where a note lives (create / update / restore)

- **Create**: an explicit `notebookId` saves straight into that notebook; without one the note starts in 等待分类. `autoClassify` only decides whether an inbox note is queued; it never overrides an explicit destination.
- **Update**: a normal edit **stays in the current notebook**; callers no longer need `autoClassify: false` to keep the note in place. Pass `notebookId` to move it (explicit target wins), or `autoClassify: true` to move it back to 等待分类 for re-classification.
- **Move and queue are separate**: moving into 等待分类 and starting classification are different things. With `EDGE_EVER_AUTO_CLASSIFY=false` a note can still be moved into 等待分类; no classification job is created.
- **Restore**: a trashed note returns to its original notebook; only when that notebook was deleted does it return to 等待分类.

### 3.2 Saving a conversation (`save_ai_conversation`)

Use `save_ai_conversation` for deliberate conversation capture instead of the generic `create_memo`. It reuses the AI conversation template's four sections (结论, 关键步骤 / 依据, 验证结果, 来源 / 链接), the 「对象｜主题」 title, and the `AI沉淀` tag.

| Case | Call |
|---|---|
| Save as a new note | `{"message":"…","response":"…","object":"Release plan"}` → starts in 等待分类 |
| Supplement a named note in place | add `memoId` + `expectedRevision` + `duplicate:"supplement"`, optional `section:{heading,mode}` |
| Same-topic merge | add `memoId` + `duplicate:"merge"`: supplement, then move to 等待分类 (move only when classification is off) |
| Save separately | after candidates are returned, pass `duplicate:"new"` |
| Re-classify | `autoClassify:true` on a plain update, or `duplicate:"merge"` when saving a conversation |

When the title already exists, the call returns `duplicate_match_found` and `error.candidates` with `memoId`, `title`, `notebookId` and `excerpt` — a short body passage taken from the same summary the note list uses — so the client can offer 「补充已有」 or 「另存新笔记」. Candidates are a read-only result: nothing is written until the user picks one.

## 4. Section updates and concurrency

- Prefer `update_memo` with `sectionOperations`: `append` adds to that section, `replace` rewrites only it, and all other text and attachment references stay intact. Never rewrite the whole note to change one place.
- A missing heading returns `section_not_found`; a duplicated heading returns `section_ambiguous`. Both include `availableHeadings` and leave the note unchanged; retarget the section rather than falling back to a full rewrite.
- Pass `expectedRevision` for optimistic concurrency. A conflict returns `revision_conflict` with `currentRevision`, `notebookId` and `title`; read the note again before retrying.
- Appends and supplements accept an optional `idempotencyKey`: a timed-out retry of the same request applies once. To deliberately append identical text later, use a different key or omit it.

## 5. Attachments: source, insertion and summary

The full flow is upload → insert at a chosen place → set or change the source → update the summary → read back to confirm:

1. Upload with `upload_memo_attachment` (≤2 MiB, optional `source`), `stage_memo_resource`, or `create_resource_upload_url`.
2. Insert with `insert_memo_resource` by unique section (`anchor:{section,position}`) or unique body text (`afterText` / `beforeText`). A failed lookup returns `section_not_found` / `section_ambiguous` / `anchor_not_found` and never falls back to the end of the note.
3. Set or change the source with `set_attachment_source`, reusing the shared format (`filename · P.3-5 · 章节：X · 工作表：X · 范围：A1:C9 · url · 说明：X`); page ranges, chapters, worksheets and ranges are supported, and `source: null` clears it.
4. Update 附件汇总 with `update_attachment_summary` (pass `expectedRevision`). Attachment cards stay in the body; each attachment appears once at the end with one link and its latest source, and repeat calls are idempotent.
5. Read back with `get_memo` / `list_memo_resources` to confirm the body and sources.

## 6. Attach local files

Use `stage_memo_resource` to send an original local image or file up to 2 MiB directly through MCP. Pass `kind`, `filename`, `mimeType`, and `dataBase64`. The response includes a pending `resourceId` and the Markdown snippet. For larger files, or if the client can only supply a local path, use a one-time upload URL:

1. Call `create_resource_upload_url` with `kind` (`image` or `attachment`), `mimeType`, the exact `byteSize`, and optionally `filename` and `label` (alt text or link label). No memo is needed.
2. Run the returned `curl` command after replacing `<path-to-file>`. It sends the file with `PUT` to `/api/public/resource-uploads` and carries a dedicated upload token in the `Authorization` header. The MCP token is never part of the command. The `201` response contains `resourceId`, the authenticated `url` and the `markdownImage` or `markdownLink` to insert.
3. Call `create_memo` with that Markdown in `contentMarkdown` and the ids in `resourceIds`. The memo and its files are saved together; if the call fails, nothing is saved and the files stay available for a retry. For an existing memo, pass `resourceIds` to `update_memo`.

Each URL accepts one file of exactly the declared size and type, up to 100 MiB, for 15 minutes. A request with the wrong size or type is rejected without using up the URL, and repeating a successful upload returns the same `resourceId`. The URL also stops working when the token that created it is revoked or loses `write:resources`. An uploaded file that is not bound to a memo within 24 hours is deleted. A workspace can hold up to 20 unused URLs and 100 unbound files (1 GiB) at a time. Binding requires `write:resources`.

On Docker and other Bun self-hosted deployments, the background classifier uses EdgeEver's default model. It uses the note title, body, tags and attachment names, and chooses an existing notebook. Unclear notes and model failures stay in the inbox. The inbox UI shows classification status and lets users retry. Set `EDGE_EVER_AUTO_CLASSIFY=false` in the service environment to turn off automatic classification, or set `EDGE_EVER_AUTO_CLASSIFY_WORKSPACE` to limit it to one workspace. When classification is off, `autoClassify: true` still moves a note into 等待分类; it just does not create a classification job.

## 7. Troubleshoot

| Symptom | Cause and fix |
|---|---|
| `401` with "Authentication required" | The client sent no credentials. Check that the `Authorization` header is set, including the header name and the `Bearer ` prefix. |
| `401` with `error="invalid_token"` in the `WWW-Authenticate` header | The token was sent but rejected. Check that it belongs to this instance; if it was deleted or replaced, create a new token and update the client. |
| `403` "Origin is not allowed" | A browser-based client sent a foreign `Origin`. Run the client outside the browser or through the stdio bridge. |
| The client reports invalid JSON or an HTML page | The URL does not point at `/mcp` on the server (for example a typo, `//mcp`, or the desktop app address). |
| Tools that change data are refused | The token is read-only. Use **Full access** only if the client needs to write. |
| An upload URL returns `410` | It was already used for another file or has expired. Call `create_resource_upload_url` again. |
| An upload URL returns `400` or `415` | The file does not match the declared `byteSize` or `mimeType`. Check the size with `wc -c` and send the same file again. |
| `create_memo` reports a resource is not a pending upload | The id is wrong, already bound, or the file was not bound within 24 hours. Upload it again. |

Older instances may return the same generic `401` for missing and rejected credentials. Check the instance URL, header and token first.

## 8. Custom built-in assistant and classification UI

The Web sidebar shares note and attachment services with external MCP clients; local ACP is not required. Referencing the current note shows a removable context chip. Selection and uploaded files retain their own remove controls. Without the body attached, editor identity only locates the note; tools read it when relevant to the request.

- **Advice only** restricts a turn to read tools. Explicit advice-only wording also removes write tools on the server. Requested edits use existing revision and concurrency guards.
- **Read attachments**, **Extract tasks** and **Compare notes** are read-only shortcuts. `list_memo_resources` and `read_memo_attachment` share the external MCP reader. Actual image content reaches the model; DOCX/UTF-8/PDF text is paged using `nextOffset`. PDF text returns `pageStart`/`pageEnd`/`pageCount`, so cite pages; scanned PDFs without a text layer need OCR and encrypted or damaged files fail explicitly. Images require a vision-capable selected model. Unsupported input is not guessed, and no automatic model switch occurs. Excel has no text extractor; existing upload/preview features remain available.
- Note pages contain up to 12,000 characters. A turn shares a 64,000-character note/attachment text budget. A note cannot be replaced before its pages have been read contiguously. Up to four images per turn, each at most 2 MiB, are read. Existing Word/text file limits and validation remain. Turns allow 16 model steps and 32 tool calls. Ending on a tool-call limit preserves receipts and offers Continue; incomplete reading or failed operations are not full completion.
- Collapsed tool history exposes tasks, operations, real note links and errors. Saving/appending uses the persisted completed answer without a second model rewrite. Retries reuse the same operation receipt. Append supports prose notes, flushes editor drafts and checks the latest revision; existing text and attachment references are preserved. Unplaced saves/appends enter the inbox.
- Formatted new notes can select a template by purpose and reuse external MCP deduplication and inline resource placement rules. **Save as new note** intentionally preserves the answer verbatim rather than forcing empty template sections. Existing attachment links reference the original resources; they are not duplicated.
- Classification cards appear only in the inbox. Filed notes expose results on demand under **More → Classification details**. Legacy notes without records are not labelled as automatically filed. Standard notebook selectors and batch Move replace the duplicate undo button.
- A standard Web move into the inbox queues analysis. Choosing another notebook cancels old leases in the same transaction, so an earlier model result cannot override the choice. Explicit destinations from external MCP or the built-in assistant remain authoritative.

No database migration is added; migration `0098` remains current. Local tests use isolated temporary data and simulated providers. Actual model quality and target-instance browser interactions require Tencent Cloud acceptance after deployment.
