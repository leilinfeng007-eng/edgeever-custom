import { companionAdviceOnly } from "@edgeever/shared";
import { COMPANION_NOTE_EDIT_MAX_CHARS, explicitDiagramKind, independentDiagramRequest, parseDiagramDocument, parseInfographicDocument, parseTableDocument, type CompanionSource, type CompanionTodo, type CompanionToolCall, type CompanionToolDefinition, type CompanionTurnInput, type MemoDetail, type MemoSummary } from "@edgeever/shared";
import type { DatabaseAdapter } from "../storage/storage-contract";
import type { AppContext } from "../api-context";
import type { CompanionScope } from "./companion-service";
import type { CompanionRunState } from "./companion-prepare";
import { COMPANION_MCP_TOOLS, validateCompanionTool } from "./companion-tool-catalog";
import { companionWorkspaceCursor, proposeCompanionToolAction } from "./companion-tool-actions";
import { describeCompanionTool } from "./companion-tool-receipts";
import { executeWorkspaceTool } from "../mcp/mcp-tool-executor";
import { getMemoDetail, type MemoSearchSummary } from "../notes/memo-service";
import { resolveWorkspaceInboxId } from "../notes/notebook-service";
export { resolveWorkspaceInboxId } from "../notes/notebook-service";
import { AppError } from "../common/app-error";

const AUTO_APPLY_WRITES = new Set(
  COMPANION_MCP_TOOLS.filter(tool => !tool.annotations.readOnlyHint).map(tool => tool.name),
);
const INBOX_DEFAULT_NOTEBOOK_TOOLS = new Set(["create_memo", "create_table_memo", "create_diagram_memo", "create_infographic_memo", "create_poster_memo", "use_note_template"]);

const withOptionalInboxNotebook = (definition: CompanionToolDefinition): CompanionToolDefinition => {
  if (!INBOX_DEFAULT_NOTEBOOK_TOOLS.has(definition.name)) return definition;
  const inputSchema = definition.inputSchema as {
    required?: string[];
    properties?: Record<string, Record<string, unknown>>;
  };
  const properties = inputSchema.properties ?? {};
  const notebookId = properties.notebookId;
  return {
    ...definition,
    inputSchema: {
      ...inputSchema,
      required: (inputSchema.required ?? []).filter(name => name !== "notebookId"),
      properties: {
        ...properties,
        ...(notebookId ? {
          notebookId: {
            ...notebookId,
            description: "Exact notebook id from find_notebooks or list_notebooks. Omit when the user did not name a notebook; the note is saved in the inbox (等待分类).",
          },
        } : {}),
      },
    },
  };
};

export { explicitDiagramKind, independentDiagramRequest };

export const requestsInfographic = (message: string) =>
  /(?:信息图|資訊圖|インフォグラフィック|\binfographic\b)/iu.test(message);

const creatingUnplacedNote = (message: string) => Boolean(explicitDiagramKind(message))
  || requestsInfographic(message)
  || /(?:新建|创建|生成|写一).{0,16}(?:笔记|备忘|流程图|思维导图|架构图|mind map|flowchart)/iu.test(message);

const asksForDestinationNotebook = (prompt: string) =>
  /笔记本|notebook/i.test(prompt) && /保存|存到|放到|放进|哪个|名称|which|name/i.test(prompt);

export type CompanionAgentSession = {
  calls: number;
  consecutiveErrors: number;
  lastErrorTool: string;
  noteRemaining: number;
  metadataRemaining: number;
  cursor: number | null;
  inspected: Record<string, number>;
  pages: Record<string, { revision: number; end: number }>;
  imageReads: number;
};

export const emptyCompanionAgentSession = (): CompanionAgentSession => ({
  calls: 0, consecutiveErrors: 0, lastErrorTool: "", noteRemaining: 64000, metadataRemaining: 24000, cursor: null, inspected: {}, pages: {}, imageReads: 0,
});

export const parseCompanionAgentSession = (value: unknown): CompanionAgentSession => {
  const fallback = emptyCompanionAgentSession();
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const record = value as Record<string, unknown>;
  const inspected = record.inspected && typeof record.inspected === "object" && !Array.isArray(record.inspected)
    ? Object.fromEntries(Object.entries(record.inspected as Record<string, unknown>)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number"))
    : {};
  return {
    pages: record.pages && typeof record.pages === "object" && !Array.isArray(record.pages)
      ? Object.fromEntries(Object.entries(record.pages as Record<string, unknown>).filter((entry): entry is [string, { revision: number; end: number }] => {
        const page = entry[1] as { revision?: number; end?: number } | null;
        return Boolean(page && Number.isSafeInteger(page.revision) && Number.isSafeInteger(page.end) && page.end! >= 0);
      })) : {},
    imageReads: typeof record.imageReads === "number" ? record.imageReads : 0,
    calls: typeof record.calls === "number" ? record.calls : 0,
    consecutiveErrors: typeof record.consecutiveErrors === "number" ? record.consecutiveErrors : 0,
    lastErrorTool: typeof record.lastErrorTool === "string" ? record.lastErrorTool : "",
    noteRemaining: typeof record.noteRemaining === "number" ? record.noteRemaining : 64000,
    metadataRemaining: typeof record.metadataRemaining === "number" ? record.metadataRemaining : 24000,
    cursor: typeof record.cursor === "number" ? record.cursor : null,
    inspected,
  };
};

const TOOL_HINTS: Record<string, string> = {
  get_memo: " Returns a page of Markdown. Follow nextOffset using offset until nextOffset=null before changing or claiming to have read the whole note. Never infer missing pages.",
  read_memo_attachment: " First list_memo_resources for real resource IDs. Content mode reads images as vision input and extracts Word DOCX/UTF-8 text. Follow nextOffset to read all text. Unsupported formats, oversized files and model vision errors must be reported accurately; never guess their contents. Cite the source note and returned attachment URL.",
  select_note_template: " Select by content purpose, independently of the destination notebook. Prefer the user's explicit template; use AI 对话通用模板 as fallback for general AI conversations. Fill only relevant sections; never invent facts to fill a template.",
  find_notebooks: " Use this whenever the user names a notebook. Notebook names are not IDs.",
  delete_notebook: " Delete an empty notebook using its exact ID from find_notebooks or resolve_notebook_path. This is separate from emptying the trash. Never trash or move its notes to make it empty unless the user explicitly requests that. If lookup is ambiguous, ask which notebook; do not guess.",
  list_notebooks: " Use this to list every notebook name. Do not guess names from the open note.",
  list_memos: " To list a named notebook, call find_notebooks first and pass that id. Without notebookId this lists the whole workspace, newest updated first. For newly created notes in a time range, use search_memos with createdAfter. If hasMore is true, say the list is incomplete.",
  search_memos: " Searches note titles and bodies, not notebook names. query is optional. For recently created or added notes, pass createdAfter (YYYY-MM-DD or ISO date-time) and omit query; never put this week/最近/新增 in query. For recently edited notes, use updatedAfter. Do not pass notebookId unless find_notebooks or list_notebooks returned it. For notes in a named notebook, find_notebooks then list_memos. If hasMore is true, say the list is incomplete.",
  list_tags: " Use this when the user names a tag.",
  create_memo: " For prose Markdown notes only. Never use this for structured tables/多维表格, 思维导图/mind maps, 流程图/flowcharts, 架构图, 信息图/infographics, or 海报/posters. Use create_poster_memo for posters. Use create_table_memo for tables, create_diagram_memo for diagrams, and create_infographic_memo for infographics. If the user did not name a notebook, omit notebookId. The note is saved in the inbox (等待分类). Do not ask which notebook.",
  create_table_memo: " Create an editable structured table/多维表格 from the user's requested field plan. Infer useful field names and types when unspecified. Select fields need explicit options. This creates an empty table; only add records if the user requested example or supplied records. If the user did not name a notebook, omit notebookId so it is saved in the inbox (等待分类). Do not ask which notebook, and do not use the open notebook unless the user named it.",
  get_table_records: " Read an existing structured table's fields, record IDs, and revision. Use this before adding a record so cell keys are actual field IDs. Do not infer field IDs from names.",
  add_table_record: " Add one requested record to a structured table. First call get_table_records, then use its field IDs and latest revision. Do not invent factual records to fill a new table.",
  create_diagram_memo: " Create an editable visual diagram note. kind=mind-map for 思维导图/mind map, flowchart for 流程图, architecture for 架构图. Never use this for 信息图/infographic; call create_infographic_memo. Omit edge ids; EdgeEver generates them. For mind maps, give a root and children with parentId; omit node type. If the user did not name a notebook, omit notebookId. The diagram is saved in the inbox (等待分类). Do not ask which notebook, and do not use the open notebook unless the user named it. Build from the open note when the user referred to it, attached it, or asked for a diagram without a separate subject. When they named a separate subject, such as 一个关于某主题的思维导图, build only that subject and do not read the open note.",
  create_poster_memo: " Create a real editable poster (海报笔记), never poster-style Markdown. Plan the key takeaway first. For informative topics such as 产业布局, summaries, comparisons and guides, provide 3–6 useful heading/body sections, not just a heading and generic subtitle. Choose grid for categories, list for steps, and a style suited to the subject. Use referenced note content and do not invent figures or sources. Quotes/slogans/minimal covers can omit sections. The tool handles editable canvas layout and encoding. If no notebook was named, omit notebookId and use the inbox. Report failure instead of substituting prose.",
  create_infographic_memo: " Create an AntV infographic note (信息图). A share, proportion, or 占比 uses template chart-pie-donut-plain-text and numeric data.values, not a mind map. If the user did not supply the figures, say in data.desc that they are illustrative and are not an official disclosure. If the user did not name a notebook, omit notebookId. The infographic is saved in the inbox (等待分类). Do not ask which notebook, and do not use the open notebook unless the user named it.",
  get_poster: " Read the existing poster canvas and elements before editing. Do not use raw Markdown for posters.",
  update_poster: " Edit poster text, colors, typography and positions after get_poster. Preserve unmentioned and locked elements. Pass the revision you read.",
  get_diagram: " Read an existing editable diagram as a semantic graph. Call this before update_diagram. Do not use get_memo when you only need the diagram structure. Do not read the open note when the user named a separate diagram subject and did not refer to that note. Do read it when they ask to change it, or to diagram the open note.",
  update_diagram: " Edit an existing diagram after get_diagram. Pass expectedRevision from get_diagram. Use add_node, update_node, remove_node, add_edge, update_edge, or remove_edge. Do not create a new diagram unless the user asked for a new note.",
  use_note_template: " Create a new memo from a template. If the user did not name a notebook, omit notebookId. The note is saved in the inbox (等待分类). Do not ask which notebook.",
  create_note_template: " Save a reusable note template from Markdown or from an existing memoId.",
  list_ai_instructions: " List the user's reusable AI instructions, including built-in ones.",
};

const TODO_WRITE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    todos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          content: { type: "string" },
          status: { type: "string", enum: ["pending", "in_progress", "completed"] },
        },
        required: ["content", "status"],
      },
    },
  },
  required: ["todos"],
} as Record<string, unknown>;

const ASK_USER_QUESTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          prompt: { type: "string" },
          inputType: { type: "string", enum: ["free_text", "single_select", "multi_select"] },
          options: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { id: { type: "string" }, label: { type: "string" } },
              required: ["id", "label"],
            },
          },
        },
        required: ["id", "prompt", "inputType"],
      },
    },
  },
  required: ["questions"],
} as Record<string, unknown>;

const companionMcpCatalog = (input: CompanionTurnInput) => COMPANION_MCP_TOOLS.filter(definition =>
  (input.allowWrites !== false && !companionAdviceOnly(input.message)) || definition.annotations.readOnlyHint);

const companionMcpDescription = (definition: (typeof COMPANION_MCP_TOOLS)[number]) => {
  const readOnly = definition.annotations.readOnlyHint;
  const autoApply = AUTO_APPLY_WRITES.has(definition.name);
  const execution = definition.name === "update_memo"
    ? " This executes immediately, including contentMarkdown. Read the complete current note before replacing its body. Content edits keep revision history."
    : readOnly || autoApply
    ? autoApply
      ? INBOX_DEFAULT_NOTEBOOK_TOOLS.has(definition.name)
        ? " This executes immediately. If notebookId is omitted, the note is saved in the inbox notebook (等待分类). Do not ask the user to choose a notebook."
        : " This executes immediately. New notes are created in the named notebook. Trashed notes go to the recycle bin; edits keep revision history."
      : ""
    : " This only proposes changes; the user must confirm the card. Supply a short _reason.";
  return `${definition.description}${TOOL_HINTS[definition.name] ?? ""}${execution}`;
};

export function companionToolDefinitions(input: CompanionTurnInput): CompanionToolDefinition[] {
  if (!input.allowNotes) return [];
  const requestedDiagramKind = explicitDiagramKind(input.message);
  const infographicRequest = requestsInfographic(input.message) && !requestedDiagramKind;
  const shareRequest = infographicRequest && /(?:占比|份额|构成比例|饼图|环形图|\bpie\b|\bdonut\b)/iu.test(input.message);
  return [
    ...companionMcpCatalog(input).map(definition => {
      const inputSchema = definition.inputSchema as Record<string, unknown>;
      let described = withOptionalInboxNotebook({ name: definition.name, description: companionMcpDescription(definition), inputSchema });
      if (definition.name === "create_diagram_memo" && requestedDiagramKind) {
        const properties = inputSchema.properties as Record<string, unknown>;
        const kind = properties.kind as Record<string, unknown>;
        described = withOptionalInboxNotebook({
          name: definition.name,
          description: `${companionMcpDescription(definition)} The user explicitly requested kind=${requestedDiagramKind}; use exactly that kind.`,
          inputSchema: {
            ...inputSchema,
            properties: { ...properties, kind: { ...kind, enum: [requestedDiagramKind] } },
          },
        });
      }
      if (definition.name === "create_diagram_memo" && infographicRequest) {
        described = {
          ...described,
          description: `${described.description} The user asked for an infographic (信息图). Do not call this tool. Call create_infographic_memo.`,
        };
      }
      if (definition.name === "create_infographic_memo" && shareRequest) {
        described = {
          ...described,
          description: `${described.description} This request is a share or 占比. Use template chart-pie-donut-plain-text with numeric data.values. Do not imitate it with a mind map.`,
        };
      }
      if (definition.name === "get_memo") {
        described = { ...described, inputSchema: { ...inputSchema, properties: {
          ...(inputSchema.properties as Record<string, unknown>),
          offset: { type: "integer", minimum: 0, description: "Start at zero, then use the returned nextOffset." },
          limit: { type: "integer", minimum: 1, maximum: 12000, description: "Markdown characters per page; default 12000." },
        } } };
      }
      if (definition.name === "read_memo_attachment") {
        const properties = inputSchema.properties as Record<string, unknown>;
        described = { ...described, inputSchema: { ...inputSchema, properties: { ...properties,
          mode: { type: "string", enum: ["content"], description: "Extract readable text or image content. Original binary documents are not model input." },
        } } };
      }
      return described;
    }),
    {
      name: "todo_write",
      description: "Replace the task list for this run. Use for multi-step work (≥3 steps). Keep at most one item in_progress.",
      inputSchema: TODO_WRITE_SCHEMA,
    },
    {
      name: "ask_user_question",
      description: "Ask the user 1-3 structured questions only when a necessary choice remains unresolved after checking the current request and recent conversation. For translation without a target language, use the conversation language guidance in the instructions instead of asking when source and target differ. Reuse a recent translation when the user asks to apply that translated content; do not ask for its language again. Do not use this to choose a notebook for a new note, diagram, infographic, or template. Do not use this to narrate writes you can already perform. Stop after calling it.",
      inputSchema: ASK_USER_QUESTION_SCHEMA,
    },
  ];
}

type CompanionExecutableTools = Record<string, { execute: (input: Record<string, unknown>) => Promise<unknown> }>;

export function createCompanionTools(args: { db: DatabaseAdapter; scope: CompanionScope; input: CompanionTurnInput;
  context?: AppContext; signal: AbortSignal; assertActive: () => Promise<void>; sources: CompanionSource[];
  run?: CompanionRunState; session?: CompanionAgentSession }): CompanionExecutableTools {
  if (!args.input.allowNotes || !args.context) return {};
  const session = args.session ?? emptyCompanionAgentSession();
  const inspected = new Map(Object.entries(session.inspected));
  const posterReads = new Map<string, number>();
  const persistSession = () => {
    session.inspected = Object.fromEntries(inspected);
  };
  const takeNoteText = (text: string, limit: number) => {
    const result = text.slice(0, Math.min(limit, session.noteRemaining));
    session.noteRemaining -= result.length;
    return result;
  };
  const remember = (memo: Pick<MemoSummary, "id" | "revision" | "notebookId"> & { title?: string | null }) => {
    const source = { id: memo.id, title: (memo.title ?? "").slice(0, 200), revision: memo.revision, notebookId: memo.notebookId };
    const index = args.sources.findIndex(item => item.id === memo.id);
    if (index < 0) args.sources.push(source); else args.sources[index] = source;
    return source;
  };
  const catalog = companionMcpCatalog(args.input);
  let notebookNames: Map<string, string> | undefined;
  const notebookName = async (id: string) => {
    try {
      if (!notebookNames) {
        const listed = await executeWorkspaceTool(args.context!, args.context!.get("auth"), "list_notebooks", {}) as { notebooks: { id: string; name: string }[] };
        notebookNames = new Map((listed.notebooks ?? []).map(notebook => [notebook.id, notebook.name]));
      }
      return notebookNames.get(id);
    } catch {
      return undefined;
    }
  };
  const mcpTools = Object.fromEntries(catalog.map(definition => {
    const readOnly = definition.annotations.readOnlyHint;
    const autoApply = AUTO_APPLY_WRITES.has(definition.name);
    return [definition.name, {
      execute: async (input: Record<string, unknown>) => {
        args.signal.throwIfAborted();
        await args.assertActive();
        if (++session.calls > 32) throw new Error("Tool call limit reached.");
        const call: CompanionToolCall = { id: crypto.randomUUID(), name: definition.name, status: "running", effects: [] };
        args.run?.tools.push(call);
        persistSession();
        await args.run?.onProgress?.();
        try {
        const { _reason, ...parameters } = input;
        const pageOffset = definition.name === "get_memo" ? (parameters.offset ?? 0) : 0;
        const pageLimit = definition.name === "get_memo" ? (parameters.limit ?? 12000) : 12000;
        if (definition.name === "get_memo") {
          delete parameters.offset; delete parameters.limit;
          if (!Number.isSafeInteger(pageOffset) || Number(pageOffset) < 0 || !Number.isSafeInteger(pageLimit) || Number(pageLimit) < 1 || Number(pageLimit) > 12000)
            throw new AppError("invalid_params", "Invalid note page offset or limit.", 400);
        }
        if (definition.name === "read_memo_attachment" && parameters.mode === "original")
          throw new AppError("attachment_format_unsupported", "Use content mode. Original binary files cannot be read as text or vision content.", 400);
        if (INBOX_DEFAULT_NOTEBOOK_TOOLS.has(definition.name) && definition.inputSchema.required?.includes("notebookId")) {
          const notebookId = parameters.notebookId;
          if (typeof notebookId !== "string" || !notebookId.trim()) {
            parameters.notebookId = await resolveWorkspaceInboxId(args.db, args.scope.workspaceId);
          }
        }
        const { args: parameters_ } = validateCompanionTool(definition.name, parameters);
        const requestedDiagramKind = explicitDiagramKind(args.input.message);
        if (definition.name === "create_diagram_memo" && requestsInfographic(args.input.message) && !requestedDiagramKind) {
          throw new AppError("invalid_params",
            "The user asked for an infographic (信息图). Call create_infographic_memo. Do not create a mind map, flowchart, or architecture diagram.", 400);
        }
        if (definition.name === "create_diagram_memo" && requestedDiagramKind && parameters_.kind !== requestedDiagramKind) {
          throw new AppError("invalid_params",
            `The user explicitly requested ${requestedDiagramKind}; create_diagram_memo.kind must be ${requestedDiagramKind}.`, 400);
        }
        const previous = () => new Map([...inspected].map(([id, revision]) => [id, { revision, title: args.sources.find(source => source.id === id)?.title }]));
        const done = async (payload: unknown) => {
          if (call.status === "running") {
            const failed = Boolean(payload && typeof payload === "object" && "error" in (payload as object));
            call.status = failed ? "error" : "done";
            if (failed) call.error = String((payload as { error: unknown }).error);
            else {
              call.effects = describeCompanionTool(definition.name, parameters_, payload, previous());
              session.consecutiveErrors = 0;
            }
            persistSession();
            await args.run?.onProgress?.();
          }
          return payload;
        };
        if ((definition.name === "get_memo" || definition.name === "get_diagram")
          && independentDiagramRequest(args.input)
          && args.input.focus?.memoId
          && String(parameters_.memoId) === args.input.focus.memoId) {
          return done({
            error: "The user did not refer to the open note and did not attach its content. Do not read it. Create the requested diagram from the user's topic alone with create_diagram_memo.",
          });
        }
        const current = await companionWorkspaceCursor(args.db, args.scope.workspaceId);
        session.cursor ??= current;
        if (session.cursor !== current) return done({ error: "Notes changed during this request. Start a fresh request." });
        if (!readOnly && !autoApply && parameters_.dryRun !== true) {
          return done(await proposeCompanionToolAction(args.db, args.scope, args.input.id,
            definition.name, parameters_, typeof _reason === "string" ? _reason : definition.title, session.cursor ?? current, inspected));
        }
        if (definition.name === "update_memo" && parameters_.dryRun !== true && typeof parameters_.contentMarkdown === "string") {
          const memo = await getMemoDetail(args.db, args.scope.workspaceId, String(parameters_.memoId));
          if (!memo || inspected.get(memo.id) !== memo.revision) {
            throw new AppError("companion_action_unread", "Read the complete source notes before changing their content.", 400);
          }
          if (parseDiagramDocument(memo.contentMarkdown)) {
            throw new AppError("invalid_params", "This is an editable diagram. Change it with update_diagram, not update_memo.", 400);
          }
          if (parseTableDocument(memo.contentMarkdown)) {
            throw new AppError("invalid_params", "This is a structured table. Do not replace it with update_memo.", 400);
          }
          if (parseInfographicDocument(memo.contentMarkdown)) {
            throw new AppError("invalid_params", "This is an infographic. Do not replace it with update_memo.", 400);
          }
          if (memo.contentMarkdown.length > COMPANION_NOTE_EDIT_MAX_CHARS || parameters_.contentMarkdown.length > COMPANION_NOTE_EDIT_MAX_CHARS) {
            throw new AppError("invalid_params", "This note edit is too large. Split it into a smaller change.", 400);
          }
          parameters_.expectedRevision = memo.revision;
        }
        if (autoApply && parameters_.dryRun !== true && (definition.name === "update_memo" || definition.name === "update_diagram" || definition.name === "update_poster" || definition.name === "restore_memo_revision")) {
          const memo = await getMemoDetail(args.db, args.scope.workspaceId, String(parameters_.memoId));
          if (!memo || inspected.get(memo.id) !== memo.revision || (definition.name === "update_poster" && posterReads.get(memo.id) !== memo.revision)) {
            throw new AppError("companion_action_unread",
              definition.name === "update_diagram"
                ? "Call get_diagram on this note before changing it."
                : "Read the complete source notes before changing their content.", 400);
          }
          if (definition.name === "update_diagram" || definition.name === "update_poster") parameters_.expectedRevision = memo.revision;
        }
        if (autoApply && parameters_.dryRun !== true && definition.name === "merge_memos") {
          const memoIds = Array.isArray(parameters_.memoIds) ? parameters_.memoIds.map(String) : [];
          for (const memoId of memoIds) {
            const memo = await getMemoDetail(args.db, args.scope.workspaceId, memoId);
            if (!memo || inspected.get(memo.id) !== memo.revision) {
              throw new AppError("companion_action_unread", "Read every source note completely before merging.", 400);
            }
          }
        }
        if ((definition.name === "get_memo" || definition.name === "get_diagram" || (definition.name === "get_poster" && posterReads.get(String(parameters_.memoId)) === inspected.get(String(parameters_.memoId)))) && inspected.has(String(parameters_.memoId))) {
          // The original full result remains in this run's model messages. Only
          // reuse it after authorization/context/cursor checks, never across runs.
          return done({ id: parameters_.memoId, revision: inspected.get(String(parameters_.memoId)), alreadyRead: true,
            message: "Use the complete result already returned in this run." });
        }
        let searchLimit: number | undefined;
        if (definition.name === "search_memos") {
          searchLimit = Math.min(Number(parameters_.limit ?? 20), 20);
          parameters_.limit = searchLimit + 1;
        }
        if (definition.name === "list_memos") {
          parameters_.limit = Math.min(Number(parameters_.limit ?? 20), 20);
          parameters_.includeContent = false;
        }
        if (definition.name === "get_diagram") parameters_.includeLayout = false;
        const result = await executeWorkspaceTool(args.context!, args.context!.get("auth"), definition.name, parameters_);
        if (autoApply && parameters_.dryRun !== true) {
          session.cursor = await companionWorkspaceCursor(args.db, args.scope.workspaceId);
          if (definition.name === "create_diagram_memo") {
            const created = result as { memo: MemoDetail; diagramKind?: string; diagram?: { nodes?: unknown[] } };
            remember(created.memo);
            return done({
              applied: true,
              id: created.memo.id,
              title: created.memo.title,
              notebookId: created.memo.notebookId,
              notebookName: await notebookName(created.memo.notebookId),
              revision: created.memo.revision,
              diagramKind: created.diagramKind,
              nodeCount: Array.isArray(created.diagram?.nodes) ? created.diagram.nodes.length : undefined,
            });
          }
          if (definition.name === "create_infographic_memo" || definition.name === "create_poster_memo") {
            const created = result as { memo: MemoDetail; template?: string };
            remember(created.memo);
            return done({
              applied: true,
              id: created.memo.id,
              title: created.memo.title,
              notebookId: created.memo.notebookId,
              notebookName: await notebookName(created.memo.notebookId),
              revision: created.memo.revision,
              template: created.template,
              ...(definition.name === "create_poster_memo" ? { poster: true } : { infographic: true }),
            });
          }
          if (definition.name === "create_table_memo") {
            const created = result as { memo: MemoDetail; fields?: unknown[] };
            remember(created.memo);
            return done({
              applied: true,
              id: created.memo.id,
              title: created.memo.title,
              notebookId: created.memo.notebookId,
              notebookName: await notebookName(created.memo.notebookId),
              revision: created.memo.revision,
              fieldCount: Array.isArray(created.fields) ? created.fields.length : undefined,
            });
          }
          if (definition.name === "update_diagram") {
            const updated = result as { memo: { id: string; title: string | null; revision: number }; diagram?: { nodes?: unknown[] }; changes?: unknown };
            inspected.set(updated.memo.id, updated.memo.revision);
            return done({
              applied: true,
              id: updated.memo.id,
              title: updated.memo.title,
              revision: updated.memo.revision,
              nodeCount: Array.isArray(updated.diagram?.nodes) ? updated.diagram.nodes.length : undefined,
              changes: updated.changes,
            });
          }
          if (definition.name === "update_memo" || definition.name === "update_poster") {
            const updated = (result as { memo: MemoDetail }).memo;
            const receipt = await done({ applied: true, id: updated.id, title: updated.title,
              notebookId: updated.notebookId, revision: updated.revision });
            inspected.set(updated.id, updated.revision);
            remember(updated);
            persistSession();
            return receipt;
          }
          if ((definition.name === "create_memo" || definition.name === "use_note_template" || definition.name === "merge_memos")
            && result && typeof result === "object" && "memo" in result) {
            remember((result as { memo: MemoDetail }).memo);
          }
          return done({ applied: true, ...(typeof result === "object" && result ? result as object : { result }) });
        }
        if (current !== await companionWorkspaceCursor(args.db, args.scope.workspaceId)) return done({ error: "Notes changed during this read. Start a fresh request." });
        if (definition.name === "read_memo_attachment") {
          const attachment = result as Awaited<ReturnType<typeof import("../mcp/mcp-attachment").readMcpAttachment>>;
          const source = await getMemoDetail(args.db, args.scope.workspaceId, attachment.attachment.memoId);
          if (source) remember(source);
          if (attachment.contentBlock.type === "text") {
            const offset = Number(parameters_.offset ?? 0);
            const text = takeNoteText(attachment.contentBlock.text, 12000);
            if (!text.length && attachment.contentBlock.text.length)
              throw new AppError("companion_read_budget", "The per-turn reading budget is exhausted. Continue in a new request; this attachment is not fully read.", 400);
            if (text.length < attachment.contentBlock.text.length) attachment.nextOffset = offset + text.length;
            attachment.contentBlock = { type: "text", text };
          } else if (++session.imageReads > 4) {
            throw new AppError("companion_image_budget", "Read at most four images per request. Continue in a new request.", 400);
          }
          return done({ ...attachment, url: `/api/v1/resources/${encodeURIComponent(attachment.attachment.id)}/blob` });
        }
        if (definition.name === "get_diagram" || definition.name === "get_poster") {
          const payload = result as { memo: { id: string; title: string | null; revision: number; notebookId?: string }; diagram: { kind?: string; nodes?: unknown[] } };
          inspected.set(payload.memo.id, payload.memo.revision);
          if (definition.name === "get_poster") posterReads.set(payload.memo.id, payload.memo.revision);
          const known = args.sources.find(source => source.id === payload.memo.id);
          remember({
            id: payload.memo.id,
            title: payload.memo.title,
            revision: payload.memo.revision,
            notebookId: known?.notebookId || payload.memo.notebookId || "",
          });
          return done(payload);
        }
        if (definition.name === "get_memo") {
          const payload = result as { memo: MemoDetail; diagram?: { kind?: string }; structuredTable?: unknown; infographic?: { template?: string } };
          const memo = payload.memo;
          remember(memo);
          if (payload.diagram) {
            inspected.set(memo.id, memo.revision);
            return done({
              id: memo.id, title: memo.title, notebookId: memo.notebookId, tags: memo.tags, revision: memo.revision,
              createdAt: memo.createdAt, updatedAt: memo.updatedAt, diagramKind: payload.diagram.kind, diagram: payload.diagram,
              message: "This is an editable diagram. Change it with update_diagram, not update_memo.",
            });
          }
          if (memo.poster) {
            return done({ id: memo.id, title: memo.title, notebookId: memo.notebookId, tags: memo.tags, revision: memo.revision,
              poster: true, message: "This is an editable poster. Read its canvas with get_poster and edit with update_poster; do not decode or replace Markdown." });
          }
          const page = session.pages[memo.id];
          const readEnd = page?.revision === memo.revision ? page.end : 0;
          if (Number(pageOffset) > readEnd || Number(pageOffset) > memo.contentMarkdown.length)
            throw new AppError("companion_unread_page", `Read the next page at offset ${readEnd}; do not skip source content.`, 400);
          const content = takeNoteText(memo.contentMarkdown.slice(Number(pageOffset)), Number(pageLimit));
          if (!content.length && memo.contentMarkdown.length > Number(pageOffset))
            throw new AppError("companion_read_budget", "The per-turn reading budget is exhausted. This note is not fully read; do not replace it.", 400);
          const end = Number(pageOffset) + content.length;
          session.pages[memo.id] = { revision: memo.revision, end: Math.max(readEnd, end) };
          const complete = session.pages[memo.id].end === memo.contentMarkdown.length;
          if (complete) inspected.set(memo.id, memo.revision); else inspected.delete(memo.id);
          return done({ id: memo.id, title: memo.title, notebookId: memo.notebookId, tags: memo.tags, revision: memo.revision,
            createdAt: memo.createdAt, updatedAt: memo.updatedAt,
            content, offset: pageOffset, nextOffset: end < memo.contentMarkdown.length ? end : null, totalCharacters: memo.contentMarkdown.length, truncated: !complete,
            ...(payload.infographic ? {
              infographic: payload.infographic,
              message: "This is an infographic note. Do not replace it with update_memo or turn it into a diagram.",
            } : payload.structuredTable ? {
              structuredTable: payload.structuredTable,
              message: "This is a structured table. Answer from this content. Do not replace it with update_memo.",
            } : {}),
          });
        }
        if (definition.name === "search_memos" || definition.name === "list_memos") {
          const listed = result as { memos: MemoSearchSummary[]; hasMore?: boolean };
          const memos = searchLimit === undefined ? listed.memos : listed.memos.slice(0, searchLimit);
          return done({
            ...listed,
            hasMore: searchLimit === undefined ? Boolean(listed.hasMore) : listed.memos.length > memos.length,
            memos: await Promise.all(memos.map(async memo => ({
              ...remember(memo),
              notebookId: memo.notebookId,
              notebookName: await notebookName(memo.notebookId),
              tags: memo.tags,
              poster: memo.poster,
              createdAt: memo.createdAt,
              updatedAt: memo.updatedAt,
              excerpt: takeNoteText(memo.excerpt, 180),
              ...(memo.snippet ? { snippet: memo.snippet } : {}),
            }))),
          });
        }
        if (definition.name === "get_poster_capabilities" || definition.name === "get_poster_preview" || definition.name === "export_poster") return done(result);
        const serialized = JSON.stringify(result);
        const text = serialized.slice(0, Math.min(8000, session.metadataRemaining));
        session.metadataRemaining -= text.length;
        return done(text.length === serialized.length ? result : { truncated: true, data: text });
        } catch (error) {
          call.status = "error";
          call.error = error instanceof AppError ? error.message : "Tool failed.";
          session.consecutiveErrors = session.lastErrorTool === definition.name ? session.consecutiveErrors + 1 : 1;
          session.lastErrorTool = definition.name;
          persistSession();
          await args.run?.onProgress?.();
          if (session.consecutiveErrors >= 3) {
            return { error: `Repeated tool failure: "${definition.name}" failed 3 times. Stop retrying it and answer with what you have.` };
          }
          throw error;
        }
      },
    }];
  }));
  return {
    ...mcpTools,
    todo_write: {
      execute: async (input: Record<string, unknown>) => {
        const todos = (Array.isArray(input.todos) ? input.todos : []) as CompanionTodo[];
        args.signal.throwIfAborted();
        await args.assertActive();
        if (!args.run) return { todos: [] };
        args.run.todos.splice(0, args.run.todos.length, ...todos.slice(0, 12).map((item, index) => ({
          id: item.id?.trim() || String(index + 1),
          content: String(item.content).slice(0, 120),
          status: item.status,
        })));
        persistSession();
        await args.run.onProgress?.();
        return { todos: args.run.todos };
      },
    },
    ask_user_question: {
      execute: async (input: Record<string, unknown>) => {
        const questions = (Array.isArray(input.questions) ? input.questions : []) as Array<{
          id: string; prompt: string; inputType: "free_text" | "single_select" | "multi_select"; options?: Array<{ id: string; label: string }>;
        }>;
        args.signal.throwIfAborted();
        await args.assertActive();
        if (!args.run) return { waiting: false };
        if (creatingUnplacedNote(args.input.message) && questions.some(question => asksForDestinationNotebook(question.prompt))) {
          return {
            waiting: false,
            error: "Do not ask which notebook. Omit notebookId. The note is saved in the inbox notebook (等待分类).",
          };
        }
        args.run.questions.splice(0, args.run.questions.length, ...questions.slice(0, 3).map(question => ({
          id: question.id.slice(0, 80),
          prompt: question.prompt.slice(0, 200),
          inputType: question.inputType,
          ...(question.options?.length ? { options: question.options.slice(0, 6).map(option => ({ id: option.id.slice(0, 80), label: option.label.slice(0, 80) })) } : {}),
        })));
        args.run.pause.ask = true;
        persistSession();
        await args.run.onProgress?.();
        return { waiting: true, message: "Stop. Wait for the user's answers in the next message." };
      },
    },
  };
}

export async function executeCompanionTurnTool(args: {
  db: DatabaseAdapter; scope: CompanionScope; context: AppContext; input: CompanionTurnInput;
  signal: AbortSignal; assertActive: () => Promise<void>; sources: CompanionSource[];
  run: CompanionRunState; session: CompanionAgentSession; name: string; toolInput: Record<string, unknown>;
}) {
  const tools = createCompanionTools(args);
  const selected = tools[args.name];
  if (!selected || typeof selected.execute !== "function") {
    throw new AppError("companion_tool_unavailable", "This tool is not available to the companion.", 400);
  }
  return selected.execute(args.toolInput);
}
