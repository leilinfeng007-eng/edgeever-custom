import { noteTemplatePurposes } from "./mcp-note-template";
/**
 * MCP 公开工具目录：集中声明工具名、输入 schema、说明与能力标记。
 * 返回内容和错误封装见 mcp-routes；执行校验与工作区权限见 mcp-tool-service，不能仅依赖发现 schema。
 */
import { posterPatchInputSchema, posterOperationsInputSchema } from "./mcp-poster-schema";
import { ARCHITECTURE_RESOURCE_ICONS, INFOGRAPHIC_NOTE_TEMPLATES, POSTER_FORMATS, POSTER_TEMPLATES, POSTER_TEMPLATE_SELECTION_INSTRUCTION, TABLE_FIELD_TYPES } from "@edgeever/shared";

const DIAGRAM_IR_NODE_TYPES = [
  "topic",
  "process",
  "decision",
  "start",
  "end",
  "terminator",
  "client",
  "frontend",
  "service",
  "database",
  "storage",
  "queue",
  "security",
  "external",
  "boundary",
] as const;

const diagramNodeProperties = {
  id: { type: "string", minLength: 1, maxLength: 100 },
  label: { type: "string", maxLength: 500 },
  type: { type: "string", enum: [...DIAGRAM_IR_NODE_TYPES] },
  parentId: { type: "string", minLength: 1, maxLength: 100 },
  resourceIcon: { type: "string", enum: [...ARCHITECTURE_RESOURCE_ICONS] },
};

const diagramNodeSchema = {
  type: "object",
  required: ["id", "label"],
  additionalProperties: false,
  properties: diagramNodeProperties,
};

const diagramEdgeProperties = {
  source: { type: "string", minLength: 1, maxLength: 100 },
  target: { type: "string", minLength: 1, maxLength: 100 },
  label: { type: "string", maxLength: 500 },
  type: { type: "string", enum: ["dependency", "request", "async", "data"] },
  bidirectional: { type: "boolean" },
};

const diagramEdgeSchema = {
  type: "object",
  required: ["source", "target"],
  additionalProperties: false,
  properties: diagramEdgeProperties,
};

const mutableDiagramEdgeSchema = {
  ...diagramEdgeSchema,
  properties: {
    id: { type: "string", minLength: 1, maxLength: 100 },
    ...diagramEdgeProperties,
  },
};

const tableFieldSchema = {
  type: "object",
  required: ["name", "type"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 80 },
    type: { type: "string", enum: [...TABLE_FIELD_TYPES] },
    options: { type: "array", maxItems: 40, items: { type: "string", minLength: 1, maxLength: 80 } },
  },
};

const infographicLabel = {
  type: "object",
  additionalProperties: false,
  required: ["label"],
  properties: {
    label: { type: "string", minLength: 1, maxLength: 160 },
    desc: { type: "string", maxLength: 240 },
  },
};

const infographicChild = {
  type: "object",
  additionalProperties: false,
  required: ["label"],
  properties: {
    label: { type: "string", minLength: 1, maxLength: 160 },
    desc: { type: "string", maxLength: 240 },
    children: { type: "array", maxItems: 8, items: infographicLabel },
  },
};

const infographicDataSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 160 },
    desc: { type: "string", maxLength: 240 },
    values: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "value"],
        properties: {
          label: { type: "string", minLength: 1, maxLength: 80 },
          value: { type: "number" },
        },
      },
    },
    compares: { type: "array", maxItems: 4, items: infographicChild },
    sequences: { type: "array", maxItems: 12, items: infographicLabel },
    lists: { type: "array", maxItems: 12, items: infographicLabel },
    root: infographicChild,
    nodes: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 40 },
          label: { type: "string", minLength: 1, maxLength: 80 },
          desc: { type: "string", maxLength: 240 },
        },
      },
    },
    relations: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["from", "to"],
        properties: {
          from: { type: "string", minLength: 1, maxLength: 40 },
          to: { type: "string", minLength: 1, maxLength: 40 },
          direction: { type: "string", maxLength: 20 },
        },
      },
    },
  },
};

const MCP_TOOL_DEFINITIONS = [
  {
    name: "get_current_user",
    description:
      "Identify the EdgeEver user and personal workspace authorized by the current session or API token. Use this before imports when the destination account must be confirmed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "get_inbox_classification",
    description: "Read the automatic inbox classification state for one note: enabled, job status, outcome, attempts, failure reason, suggested destination and tags, canApply and canUndo. Read-only. Use it after creating or updating a note without an explicit notebook, or when filing failed; a pending or retained note stays in the inbox and must not be moved by guessing.",
    inputSchema: {
      type: "object",
      required: ["memoId"],
      additionalProperties: false,
      properties: {
        memoId: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: "search_memos",
    description: "Search active EdgeEver memos by text, tag, notebook, time range, pin state, resource presence, or poster type. Results retain their excerpt and add a snippet of up to 200 characters when the query or its terms can be located in the body. Snippets may omit surrounding conditions; read the memo when more context is needed. Use poster=true to find editable poster notes (海报笔记); do not search for the word 海报 to identify the type. query is optional. For recently created or added notes, pass createdAfter and omit query; do not put this week/最近/新增 in query. Time bounds accept YYYY-MM-DD or ISO date-time.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string" },
        notebookId: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        createdAfter: { type: "string", description: "ISO 8601 date (YYYY-MM-DD) or date-time. Date-only means 00:00:00.000Z." },
        createdBefore: { type: "string", description: "ISO 8601 date (YYYY-MM-DD) or date-time. Date-only means 23:59:59.999Z." },
        updatedAfter: { type: "string", description: "ISO 8601 date (YYYY-MM-DD) or date-time. Date-only means 00:00:00.000Z." },
        updatedBefore: { type: "string", description: "ISO 8601 date (YYYY-MM-DD) or date-time. Date-only means 23:59:59.999Z." },
        isPinned: { type: "boolean" },
        hasResources: { type: "boolean" },
        poster: { type: "boolean", description: "true: only editable posters; false: exclude posters; omitted: all types." },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: "list_memos",
    description: 'List EdgeEver memo summaries with pagination. Use poster=true to list only editable poster notes (海报笔记), false to exclude them. With includeContent=true, prose bodies are Markdown only by default. Use format="all" for legacy body fields.',
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        notebookId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        offset: { type: "integer", minimum: 0 },
        includeContent: { type: "boolean" },
        format: { type: "string", enum: ["all"], description: "Return Markdown, plain text, and editor JSON for prose when includeContent is true." },
        includeDeleted: { type: "boolean" },
        poster: { type: "boolean", description: "Filter by editable poster type before pagination." },
      },
    },
  },
  {
    name: "get_memo",
    description: 'Read a memo. Prose bodies are Markdown only by default. Use format="all" for legacy body fields. Specialized memos retain their existing responses.',
    inputSchema: {
      type: "object",
      required: ["memoId"],
      additionalProperties: false,
      properties: {
        memoId: { type: "string" },
        format: { type: "string", enum: ["all"], description: "Return Markdown, plain text, and editor JSON for prose." },
        includeDeleted: { type: "boolean" },
      },
    },
  },
  {
    name: "create_memo",
    description: "Save a completed prose note. Search for existing notes first. Read a clearly matching note and update it when adding material. An exact repeat with the same title and content is reused; identical content under a different title, or a matching title with different content, returns duplicate_match_found/duplicate_match_ambiguous. Read the returned candidates and update one instead of creating a copy, or pass allowDuplicate=true only when the user explicitly wants another copy. When no template is given, pass purpose so the server selects the matching template (falling back to the general AI conversation template); the user's templateId always wins. Fill only relevant sections, save the complete effective content, and omit empty sections and template instructions. Omit notebookId unless the user chose a notebook. Stage files first, paste each returned Markdown snippet in its relevant section, and include its resourceId; put whole-document reference files in a References section at the end. To save verbatim, keep the original text. For an editable poster, use create_poster_memo.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        notebookId: { type: "string", minLength: 1, description: "Explicit user-selected notebook; the note is saved there directly. Omit to start in the workspace inbox (等待分类)." },
        autoClassify: { type: "boolean", description: "Only affects the inbox: true (default) queues the new note for classification when that feature is enabled; false keeps it in 等待分类 without queueing. An explicit notebookId is always left untouched." },
        allowDuplicate: { type: "boolean", description: "Allow a separate copy when the user explicitly requests one." },
        templateId: { type: "string", minLength: 1, description: "Explicit workspace template; takes priority over purpose." },
        purpose: { type: "string", enum: noteTemplatePurposes, description: "Note purpose used to select a template when templateId is absent. Unknown purposes use the general AI conversation template." },
        source: { type: "string", maxLength: 80, description: "Stable source identifier with sourceId, such as an agent or integration name; makes retries idempotent." },
        sourceId: { type: "string", maxLength: 512, description: "Stable id from the source system; a repeat updates the original note instead of creating a copy." },
        requireResourcePlacement: { type: "boolean", description: "Set true when adding files to verify each resource appears in the submitted Markdown." },
        title: { type: "string" },
        contentMarkdown: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
        resourceIds: {
          type: "array",
          maxItems: 20,
          uniqueItems: true,
          items: { type: "string" },
          description: "Pending uploads from stage_memo_resource or create_resource_upload_url to bind to this memo, in the same operation. Requires write:resources.",
        },
      },
    },
  },
  {
    name: "get_table_records",
    description: "Read the fields and a page of records from one structured table memo. Use field IDs and record IDs for subsequent writes. Returns the memo revision for optimistic concurrency.",
    inputSchema: {
      type: "object", required: ["memoId"], additionalProperties: false,
      properties: {
        memoId: { type: "string", minLength: 1 },
        recordId: { type: "string", minLength: 1 },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "create_table_memo",
    description: "Create an editable structured table memo from a field plan. Infer field names and types from the user's request, then pass explicit fields. The table starts empty; add_table_record can populate it. Select fields require options.",
    inputSchema: {
      type: "object", required: ["notebookId", "title", "fields"], additionalProperties: false,
      properties: {
        notebookId: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1, maxLength: 160 },
        tags: { type: "array", maxItems: 100, items: { type: "string" } },
        fields: { type: "array", minItems: 1, maxItems: 40, items: tableFieldSchema },
      },
    },
  },
  {
    name: "update_table_schema",
    description: "Apply field changes to one structured table memo. First use dryRun to preview changedCellCount and removedAttachmentCount. If existing cell values would change, pass allowDataChanges=true to execute. Operations run in order and use stable field IDs from get_table_records.",
    inputSchema: {
      type: "object", required: ["memoId", "expectedRevision", "operations"], additionalProperties: false,
      properties: {
        memoId: { type: "string", minLength: 1 },
        expectedRevision: { type: "integer", minimum: 0 },
        dryRun: { type: "boolean" },
        allowDataChanges: { type: "boolean" },
        operations: {
          type: "array", minItems: 1, maxItems: 40,
          items: {
            type: "object", required: ["op"], additionalProperties: false,
            properties: {
              op: { type: "string", enum: ["add_field", "update_field", "remove_field"] },
              fieldId: { type: "string", minLength: 1 },
              field: tableFieldSchema,
              changes: {
                type: "object", minProperties: 1, additionalProperties: false,
                properties: tableFieldSchema.properties,
              },
            },
          },
        },
      },
    },
  },
  {
    name: "add_table_record",
    description: "Add one record to an existing structured table memo. cells maps field IDs to values; attachment fields accept arrays of resource IDs already uploaded to this memo. Pass the revision returned by get_table_records.",
    inputSchema: {
      type: "object", required: ["memoId", "expectedRevision", "cells"], additionalProperties: false,
      properties: {
        memoId: { type: "string", minLength: 1 },
        expectedRevision: { type: "integer", minimum: 0 },
        cells: { type: "object", additionalProperties: true },
      },
    },
  },
  {
    name: "update_table_record",
    description: "Update selected cells of one record in a structured table memo. Other cells remain unchanged. Attachment fields accept arrays of resource IDs already uploaded to this memo.",
    inputSchema: {
      type: "object", required: ["memoId", "recordId", "expectedRevision", "cells"], additionalProperties: false,
      properties: {
        memoId: { type: "string", minLength: 1 },
        recordId: { type: "string", minLength: 1 },
        expectedRevision: { type: "integer", minimum: 0 },
        cells: { type: "object", minProperties: 1, additionalProperties: true },
      },
    },
  },
  {
    name: "delete_table_record",
    description: "Delete one record from a structured table memo by record ID. This also releases attachments used only by the removed record.",
    inputSchema: {
      type: "object", required: ["memoId", "recordId", "expectedRevision"], additionalProperties: false,
      properties: {
        memoId: { type: "string", minLength: 1 },
        recordId: { type: "string", minLength: 1 },
        expectedRevision: { type: "integer", minimum: 0 },
      },
    },
  },
  {
    name: "create_infographic_memo",
    description:
      "Create an AntV infographic note (信息图). Use this for 信息图, infographic, 占比, 构成, 饼图, 柱状图, 折线图, 对比, 四象限, 时间线, and a process infographic. Do not use create_diagram_memo, create_memo, or a mind map. Use chart-pie-donut-plain-text with data.values for a share or 占比; chart-column-simple for columns; chart-line-plain-text for a trend; compare-binary-horizontal-badge-card-vs for two subjects with matched children; compare-quadrant-quarter-simple-card for four quadrants; sequence-timeline-rounded-rect-node for a timeline; sequence-steps-simple for steps; list-grid-simple for a parallel list; hierarchy-tree-tech-style-capsule-item for a tree; relation-network-simple-circle-node for a network. Fill only the data array that matches the template. data.title is the note title. If the user did not supply the figures, say in data.desc that the values are illustrative and are not an official disclosure. 思维导图, 流程图, and 架构图 still use create_diagram_memo.",
    inputSchema: {
      type: "object",
      required: ["notebookId", "template", "data"],
      additionalProperties: false,
      properties: {
        notebookId: { type: "string", minLength: 1 },
        title: { type: "string", maxLength: 160 },
        template: { type: "string", enum: [...INFOGRAPHIC_NOTE_TEMPLATES] },
        data: infographicDataSchema,
        tags: { type: "array", maxItems: 100, items: { type: "string" } },
      },
    },
  },
  {
    name: "create_diagram_memo",
    description:
      "Create an editable visual diagram memo from a semantic graph; EdgeEver generates node sizes, coordinates, edge IDs, and a deterministic layout. Mind maps and flowcharts always start with the default plain theme; any supplied theme is ignored for those kinds. For mind maps, omit node type and use parentId for hierarchy. Flowchart node types are process, decision, start, or end. Architecture node types are client, frontend, service, database, storage, queue, security, external, or boundary; boundary nodes contain components through those components' parentId and cannot be edge endpoints. Give every architecture boundary at least one contained component, or omit the boundary rather than creating an empty section.",
    inputSchema: {
      type: "object",
      required: ["notebookId", "kind", "nodes"],
      additionalProperties: false,
      properties: {
        notebookId: { type: "string", minLength: 1 },
        title: { type: "string", maxLength: 160 },
        kind: { type: "string", enum: ["mind-map", "flowchart", "architecture"] },
        theme: { type: "string", description: "Color scheme for architecture diagrams. Mind maps and flowcharts always start with the default plain theme.", enum: ["plain", "brand", "sun", "wa", "island", "rose", "mint", "cosmos", "tea", "naive", "macaron", "ocean", "ink", "classic", "paper"] },
        structure: { type: "string", enum: ["map", "line", "capsule", "box", "circle", "ellipse", "hexagon", "logic", "tree", "brace", "org", "timeline", "fishbone"] },
        layout: {
          type: "object",
          additionalProperties: false,
          properties: {
            direction: { type: "string", enum: ["left-to-right", "top-to-bottom"] },
          },
        },
        tags: { type: "array", maxItems: 100, items: { type: "string" } },
        nodes: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: diagramNodeSchema,
        },
        edges: {
          type: "array",
          maxItems: 400,
          items: diagramEdgeSchema,
        },
      },
    },
  },
  {
    name: "create_poster_memo",
    description: POSTER_TEMPLATE_SELECTION_INSTRUCTION + " Create an editable poster note (海报笔记). Use this when asked to generate a poster, not create_memo or update_memo with poster-style prose. First plan the takeaway and content hierarchy. For explanatory topics (industry layouts, knowledge summaries, comparisons or guides), supply 3–6 concise sections with heading/body and choose layout=grid for categories or layout=list for steps. Do not reduce an informative topic to a title and generic subtitle. Use supplied note content when referenced; do not invent statistics, sources or brand relationships. For quotes, slogans or an explicitly minimal cover, omit sections. Optional badge/footer require sections. EdgeEver compiles editable elements and fits text to the selected format. Do not inspect other notes or local files to reverse-engineer the poster format. If this tool fails, report the error; never silently substitute an ordinary Markdown note. Use get_poster then update_poster only for subsequent edits.",
    inputSchema: {
      type: "object", required: ["notebookId", "title", "heading"], additionalProperties: false,
      properties: {
        notebookId: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1, maxLength: 160 },
        heading: { type: "string", minLength: 1, maxLength: 80 }, subtitle: { type: "string", maxLength: 240 },
        layout: { type: "string", enum: ["auto", "grid", "list"], description: "With sections: grid for categories/comparisons, list for ordered steps; auto adapts to canvas aspect ratio." },
        badge: { type: "string", maxLength: 24, description: "Optional short topic label; requires sections." },
        footer: { type: "string", maxLength: 100, description: "Optional takeaway or supplied source; requires sections. Never invent attribution." },
        sections: { type: "array", minItems: 2, maxItems: 6, description: "Main content for informative posters. Each section must convey a distinct useful point, not repeat the subtitle.", items: { type: "object", additionalProperties: false, required: ["heading", "body"], properties: { heading: { type: "string", minLength: 1, maxLength: 32 }, body: { type: "string", minLength: 1, maxLength: 120 } } } },
        template: { type: "string", enum: [...POSTER_TEMPLATES], description: "Basic server style ID from templates in get_poster_capabilities; select using its zhUse/enUse. Full browser designs use request_poster_render.templateId." },
        format: { type: "string", enum: POSTER_FORMATS.map(format => format.id) },
        tags: { type: "array", maxItems: 100, items: { type: "string" } },
      },
    },
  },
  {
    name: "request_poster_render",
    description: "Queue a fresh PNG preview on an online desktop/Web client. Read get_poster and pass expectedRevision. Optional templateId applies a full browser design template, preserving additional decorations; use for the initial design of a new poster, or an explicitly requested template change to an existing poster. Requires write:memos and write:resources. Returns a job, not an image. No online client means pending; query get_poster_render_job and only claim rendered after completed, then get_poster_preview. Pending expires after 10 minutes; rendering after 2 minutes. Do not busy-poll.",
    inputSchema: { type: "object", required: ["memoId", "expectedRevision"], additionalProperties: false, properties: { memoId: { type: "string", minLength: 1 }, expectedRevision: { type: "integer", minimum: 0 }, templateId: { type: "string", description: "ID from browserDesignTemplates in get_poster_capabilities" } } },
  },
  {
    name: "get_poster_render_job",
    description: "Read client render status: pending, rendering, completed or failed. Completion provides resultRevision; read get_poster_preview for the current image. A pending task needs an online desktop/Web workspace. Poll at intervals of at least 5 seconds, never loop rapidly or claim success early.",
    inputSchema: { type: "object", required: ["jobId"], additionalProperties: false, properties: { jobId: { type: "string", minLength: 1 } } },
  },
  {
    name: "get_poster_capabilities",
    description: "Read before creating a poster. Discover supported poster templates with bilingual zhUse/enUse descriptions and recommended platform IDs (fit), fonts, platform dimensions, limits, detailed editing fields, operations and rendering/export availability. Read before designing or guessing parameter values.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "get_poster_preview",
    description: "Read the current saved rendered preview of a poster. Returns available=false when it has not been rendered after edits. Never treat source data or an old preview as current. For a fresh image call request_poster_render; an online desktop/Web workspace renders it.",
    inputSchema: { type: "object", required: ["memoId"], additionalProperties: false, properties: { memoId: { type: "string", minLength: 1 } } },
  },
  {
    name: "export_poster",
    description: "Export a poster's editable JSON source or its current saved preview image. This does not render a new image; saved_preview fails clearly when no current browser-rendered preview exists. Return the source as a .json file, not as a raster image. Image URLs require normal authenticated resource access.",
    inputSchema: { type: "object", required: ["memoId", "format"], additionalProperties: false, properties: { memoId: { type: "string", minLength: 1 }, format: { type: "string", enum: ["source", "saved_preview"] } } },
  },
  {
    name: "get_poster",
    description: "Read an editable poster's canvas, element IDs, text, colors and geometry. Read before update_poster; never decode or replace poster Markdown.",
    inputSchema: { type: "object", required: ["memoId"], additionalProperties: false, properties: { memoId: { type: "string", minLength: 1 } } },
  },
  {
    name: "update_poster",
    description: "Edit an existing poster: typography, image crop, shapes, strokes, shadows, visibility, elements, layers, groups, canvas and platform sizes. Read get_poster_capabilities for supported fields and operation arguments. Edits run first, operations next in order, resize last. Use operations lock=false in a separate call before editing locked elements. apply_template replaces all elements and is only for an explicit template change. Image resource IDs must belong to this poster. Preserve unmentioned elements and locked elements. Read get_poster first and pass its expectedRevision. Use dryRun to validate without saving. Changes invalidate the saved preview; call request_poster_render to have an online desktop/Web client render a fresh one.",
    inputSchema: {
      type: "object", required: ["memoId", "expectedRevision"], additionalProperties: false,
      properties: {
        memoId: { type: "string", minLength: 1 }, expectedRevision: { type: "integer", minimum: 0 }, dryRun: { type: "boolean" },
        background: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
        backgroundGradient: { type: ["object", "null"], additionalProperties: false, required: ["kind", "from", "to"], properties: {
          kind: { type: "string", enum: ["linear", "radial"] }, from: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }, to: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }, angle: { type: "number", minimum: -360, maximum: 360 },
        } },
        canvas: { type: "object", required: ["width", "height"], additionalProperties: false, properties: {
          width: { type: "integer", minimum: 320, maximum: 4096 }, height: { type: "integer", minimum: 320, maximum: 4096 }, scaleElements: { type: "boolean" },
        } },
        platform: { type: "string", description: "Platform ID from get_poster_capabilities. Resizes the canvas and scales elements. Do not combine with canvas." },
        operations: posterOperationsInputSchema,
        edits: { type: "array", maxItems: 100, items: {
          type: "object", required: ["id", "patch"], additionalProperties: false,
          properties: { id: { type: "string", minLength: 1 }, patch: posterPatchInputSchema,
          },
        } },
      },
    },
  },
  {
    name: "get_diagram",
    description:
      "Read an editable diagram as a semantic graph. Coordinates and dimensions are omitted by default; set includeLayout only for an explicit visual-layout task.",
    inputSchema: {
      type: "object",
      required: ["memoId"],
      additionalProperties: false,
      properties: {
        memoId: { type: "string", minLength: 1 },
        includeLayout: { type: "boolean", description: "Include node coordinates and dimensions. Defaults to false." },
      },
    },
  },
  {
    name: "update_diagram",
    description:
      "Apply validated semantic operations to an existing diagram while preserving unaffected authored layout. Use expectedRevision to prevent concurrent overwrites. Set reflow to all only when the user explicitly wants a complete automatic layout.",
    inputSchema: {
      type: "object",
      required: ["memoId", "expectedRevision", "operations"],
      additionalProperties: false,
      properties: {
        memoId: { type: "string", minLength: 1 },
        expectedRevision: { type: "integer", minimum: 0 },
        dryRun: { type: "boolean" },
        reflow: { type: "string", enum: ["preserve", "all"] },
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            required: ["op"],
            additionalProperties: false,
            properties: {
              op: {
                type: "string",
                enum: ["add_node", "update_node", "remove_node", "add_edge", "update_edge", "remove_edge"],
              },
              node: diagramNodeSchema,
              nodeId: { type: "string", minLength: 1 },
              edge: mutableDiagramEdgeSchema,
              edgeId: { type: "string", minLength: 1 },
              changes: {
                type: "object",
                additionalProperties: false,
                properties: {
                  label: { type: "string", maxLength: 500 },
                  type: { type: "string", enum: [...DIAGRAM_IR_NODE_TYPES] },
                  parentId: { type: "string", maxLength: 100 },
                  resourceIcon: { type: "string", enum: [...ARCHITECTURE_RESOURCE_ICONS] },
                  source: { type: "string", minLength: 1, maxLength: 100 },
                  target: { type: "string", minLength: 1, maxLength: 100 },
                  bidirectional: { type: "boolean" },
                },
              },
              cascade: { type: "boolean" },
            },
          },
        },
      },
    },
  },
  {
    name: "import_memos",
    description:
      "Import up to 25 memos from an external service with database-backed idempotency. Reusing the same source and externalId returns skipped instead of creating a duplicate. Results are reported per item.",
    inputSchema: {
      type: "object",
      required: ["source", "notebookId", "items"],
      additionalProperties: false,
      properties: {
        source: {
          type: "string",
          minLength: 1,
          maxLength: 80,
          pattern: "^[A-Za-z0-9._-]+$",
          description: "Stable source identifier such as flomo, notion, memos, or evernote.",
        },
        notebookId: { type: "string", description: "Destination notebook for every item in this batch." },
        dryRun: { type: "boolean", description: "Validate and report existing items without creating memos." },
        items: {
          type: "array",
          minItems: 1,
          maxItems: 25,
          items: {
            type: "object",
            required: ["externalId"],
            additionalProperties: false,
            properties: {
              externalId: {
                type: "string",
                minLength: 1,
                maxLength: 512,
                description: "Stable ID from the source system. It is the idempotency key within source and workspace.",
              },
              title: { type: "string", maxLength: 160 },
              contentMarkdown: { type: "string" },
              tags: { type: "array", maxItems: 100, items: { type: "string" } },
              createdAt: { type: "string", format: "date-time" },
              updatedAt: { type: "string", format: "date-time" },
            },
          },
        },
      },
    },
  },
  {
    name: "update_memo",
    description: "Update an existing prose note in place with its original structure and attachment references. Read get_memo first and pass its expectedRevision. Prefer sectionOperations to append to or replace one uniquely named section without touching other sections or their attachments; unreplaced text and referenced files are preserved. Pass contentMarkdown only for a full-body rewrite the user requested, and never re-apply a template automatically. Keep existing attachment snippets in place, add new file snippets in the relevant section, and put whole-document reference files in a References section at the end. A normal edit stays in the note's current notebook: omit notebookId and the note does not move. To move it, pass notebookId (explicit target wins). To send it back to 等待分类 for re-classification, pass autoClassify=true; that works even when automatic classification is off. A repeated request with no real change does not requeue classification. Example: {\"memoId\":\"memo_1\",\"expectedRevision\":3,\"sectionOperations\":[{\"heading\":\"验证结果\",\"mode\":\"append\",\"contentMarkdown\":\"- 本地通过\"}]}. To edit a poster use get_poster then update_poster.",
    inputSchema: {
      type: "object",
      required: ["memoId"],
      additionalProperties: false,
      properties: {
        memoId: { type: "string" },
        title: { type: "string" },
        isPinned: { type: "boolean" },
        contentMarkdown: { type: "string" },
        sectionOperations: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          description: "Append to or replace uniquely named sections. Cannot be combined with contentMarkdown. A missing or duplicated heading returns a conflict that lists availableHeadings and leaves the note unchanged; retarget the section instead of rewriting the whole note.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["heading", "mode", "contentMarkdown"],
            properties: {
              heading: { type: "string", minLength: 1, maxLength: 200 },
              mode: { type: "string", enum: ["append", "replace"] },
              contentMarkdown: { type: "string" },
            },
          },
        },
        tags: { type: "array", items: { type: "string" } },
        notebookId: { type: "string", minLength: 1, description: "Explicit user-selected destination; moving while updating. Omit to keep the note where it is." },
        autoClassify: { type: "boolean", description: "true moves the note to 等待分类 for re-classification (works even when automatic classification is off). false keeps the current location. Omit for the default: stay put." },
        idempotencyKey: { type: "string", maxLength: 200, description: "Optional; a timed-out retry of the same append/supplement with this key applies once. Omit it for a deliberate repeat of identical text." },
        requireResourcePlacement: { type: "boolean", description: "Set true when adding files to verify each resource appears in the submitted Markdown." },
        allowAttachmentReferenceRemoval: { type: "boolean", description: "Set only if the user explicitly asks to remove a reference from the body." },
        allowDuplicateAttachmentReferences: { type: "boolean", description: "Set only if the user explicitly wants the same existing file inserted again. Defaults to blocking duplicate references." },
        expectedRevision: { type: "integer", minimum: 0 },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
        resourceIds: {
          type: "array",
          maxItems: 20,
          uniqueItems: true,
          items: { type: "string" },
          description: "Pending uploads from stage_memo_resource or create_resource_upload_url to bind to this memo, in the same operation. Requires write:resources.",
        },
      },
    },
  },
  {
    name: "trash_memos",
    description: "Move one or more active memos, including editable posters, to trash. This is recoverable through restore_memos. Find the exact IDs with search_memos or list_memos (poster=true for posters); never guess IDs. Use dryRun to preview affected memos.",
    inputSchema: {
      type: "object",
      required: ["memoIds"],
      additionalProperties: false,
      properties: {
        memoIds: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
        dryRun: { type: "boolean" },
      },
    },
  },
  {
    name: "restore_memos",
    description: "Restore one or more trashed memos. If the original notebook is gone, memos are restored to the default inbox.",
    inputSchema: {
      type: "object",
      required: ["memoIds"],
      additionalProperties: false,
      properties: {
        memoIds: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
        dryRun: { type: "boolean" },
      },
    },
  },
  {
    name: "move_memos",
    description: "Move one or more active memos to another notebook. Use dryRun to preview affected memos.",
    inputSchema: {
      type: "object",
      required: ["memoIds", "notebookId"],
      additionalProperties: false,
      properties: {
        memoIds: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
        notebookId: { type: "string" },
        dryRun: { type: "boolean" },
      },
    },
  },
  {
    name: "add_tags_to_memos",
    description: "Add tags to one or more active memos. Use dryRun to preview changed tags.",
    inputSchema: {
      type: "object",
      required: ["memoIds", "tags"],
      additionalProperties: false,
      properties: {
        memoIds: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
        tags: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } },
        dryRun: { type: "boolean" },
      },
    },
  },
  {
    name: "remove_tags_from_memos",
    description: "Remove tags from one or more active memos. Use dryRun to preview changed tags.",
    inputSchema: {
      type: "object",
      required: ["memoIds", "tags"],
      additionalProperties: false,
      properties: {
        memoIds: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
        tags: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } },
        dryRun: { type: "boolean" },
      },
    },
  },
  {
    name: "rename_tag",
    description: "Rename a tag across all active memos. This merges into an existing tag with the same normalized name.",
    inputSchema: {
      type: "object",
      required: ["from", "to"],
      additionalProperties: false,
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        dryRun: { type: "boolean" },
      },
    },
  },
  {
    name: "delete_tag",
    description: "Remove a tag from all active memos.",
    inputSchema: {
      type: "object",
      required: ["tag"],
      additionalProperties: false,
      properties: {
        tag: { type: "string" },
        dryRun: { type: "boolean" },
      },
    },
  },
  {
    name: "merge_memos",
    description: "Merge multiple active memos into a new memo and soft-delete the sources.",
    inputSchema: {
      type: "object",
      required: ["memoIds"],
      additionalProperties: false,
      properties: {
        memoIds: { type: "array", minItems: 2, maxItems: 50, items: { type: "string" } },
        notebookId: { type: "string" },
        title: { type: "string" },
      },
    },
  },
  {
    name: "upload_memo_image",
    description:
      "Upload a base64-encoded image resource to a memo and return Markdown that can be inserted into memo content. Images are stored as provided; server-side compression is disabled to avoid Cloudflare Images quota usage. For a file on disk, prefer create_resource_upload_url.",
    inputSchema: {
      type: "object",
      required: ["memoId", "mimeType", "dataBase64"],
      additionalProperties: false,
      properties: {
        memoId: { type: "string" },
        filename: { type: "string" },
        mimeType: { type: "string", enum: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml"] },
        dataBase64: { type: "string" },
        alt: { type: "string" },
      },
    },
  },
  {
    name: "stage_memo_resource",
    description: "Upload an original image or file (up to 2 MiB) through MCP before writing a note. Put the returned markdownImage or markdownLink in the matching section of the final note and bind resourceId with create_memo or update_memo. Use create_resource_upload_url for larger files.",
    inputSchema: {
      type: "object",
      required: ["kind", "filename", "mimeType", "dataBase64"],
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["image", "attachment"] },
        filename: { type: "string", minLength: 1 },
        mimeType: { type: "string", minLength: 1 },
        dataBase64: { type: "string", minLength: 1, maxLength: 2796460 },
        label: { type: "string", minLength: 1 },
        source: {
          type: "object",
          additionalProperties: false,
          description: "Attachment source stored with the file and used by 附件汇总. Optional.",
          properties: {
            filename: { type: "string", maxLength: 400 },
            page: { type: "integer", minimum: 1, maximum: 100000 },
            pageEnd: { type: "integer", minimum: 1, maximum: 100000 },
            chapter: { type: "string", maxLength: 400 },
            sheet: { type: "string", maxLength: 400 },
            range: { type: "string", maxLength: 400 },
            url: { type: "string", maxLength: 2000 },
            note: { type: "string", maxLength: 400 },
          },
        },
      },
    },
  },
  {
    name: "create_resource_upload_url",
    description:
      "Create a single-use URL to upload a local image or attachment (up to 100 MiB) without sending its bytes through a tool call and without an existing memo. Run the returned curl command from a shell that can read the file, replacing <path-to-file>; the request must send exactly byteSize bytes of mimeType content. The URL expires after 15 minutes. The PUT response contains resourceId, an authenticated url and Markdown; then pass the Markdown in contentMarkdown and the resourceId in resourceIds to create_memo, or to update_memo for an existing memo. Unbound uploads are deleted after 24 hours.",
    inputSchema: {
      type: "object",
      required: ["kind", "mimeType", "byteSize"],
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["image", "attachment"] },
        mimeType: { type: "string" },
        filename: { type: "string" },
        byteSize: { type: "integer", minimum: 1, maximum: 104857600 },
        label: { type: "string", description: "Image alt text or attachment link label used in the returned Markdown." },
        source: {
          type: "object",
          additionalProperties: false,
          description: "Attachment source stored with the file and used by 附件汇总. Optional.",
          properties: {
            filename: { type: "string", maxLength: 400 },
            page: { type: "integer", minimum: 1, maximum: 100000 },
            pageEnd: { type: "integer", minimum: 1, maximum: 100000 },
            chapter: { type: "string", maxLength: 400 },
            sheet: { type: "string", maxLength: 400 },
            range: { type: "string", maxLength: 400 },
            url: { type: "string", maxLength: 2000 },
            note: { type: "string", maxLength: 400 },
          },
        },
      },
    },
  },
  {
    name: "upload_memo_attachment",
    description: "Upload a base64-encoded attachment resource to a memo and return Markdown link text that can be inserted into memo content. For a file on disk, prefer create_resource_upload_url.",
    inputSchema: {
      type: "object",
      required: ["memoId", "filename", "mimeType", "dataBase64"],
      additionalProperties: false,
      properties: {
        memoId: { type: "string" },
        filename: { type: "string" },
        mimeType: { type: "string" },
        dataBase64: { type: "string" },
        label: { type: "string" },
        source: {
          type: "object",
          additionalProperties: false,
          description: "Attachment source stored with the file and used by 附件汇总. Optional.",
          properties: {
            filename: { type: "string", maxLength: 400 },
            page: { type: "integer", minimum: 1, maximum: 100000 },
            pageEnd: { type: "integer", minimum: 1, maximum: 100000 },
            chapter: { type: "string", maxLength: 400 },
            sheet: { type: "string", maxLength: 400 },
            range: { type: "string", maxLength: 400 },
            url: { type: "string", maxLength: 2000 },
            note: { type: "string", maxLength: 400 },
          },
        },
      },
    },
  },
  {
    name: "read_memo_attachment",
    description: "Read a file from an active memo directly through MCP. Get resourceId from list_memo_resources. Default content mode returns image data or extracts text from DOCX, UTF-8 text, and text-layer PDF attachments. PDF text is paginated with pageStart/pageEnd/pageCount; pass nextOffset as offset to continue. Scanned PDFs without a text layer return pdf_no_text_layer and require OCR; encrypted, damaged, and oversized files return explicit errors. Never treat mode=original or an unreadable file as extracted text. Use mode=original only to receive an embedded original file up to 2 MiB. Requires read:memos and read:resources.",
    inputSchema: {
      type: "object",
      required: ["memoId", "resourceId"],
      additionalProperties: false,
      properties: {
        memoId: { type: "string" },
        resourceId: { type: "string" },
        mode: { type: "string", enum: ["content", "original"] },
        offset: { type: "integer", minimum: 0 },
      },
    },
  },
  {
    name: "list_memo_resources",
    description: "List active resources attached to a memo.",
    inputSchema: {
      type: "object",
      required: ["memoId"],
      additionalProperties: false,
      properties: {
        memoId: { type: "string" },
      },
    },
  },
  {
    name: "list_resources",
    description: "List active workspace resources with storage summary.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
    },
  },
  {
    name: "list_memo_revisions",
    description: "List revision history for a memo.",
    inputSchema: {
      type: "object",
      required: ["memoId"],
      additionalProperties: false,
      properties: {
        memoId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "restore_memo_revision",
    description: "Restore a memo to a previous revision. Use dryRun to preview the target revision.",
    inputSchema: {
      type: "object",
      required: ["memoId", "revisionId"],
      additionalProperties: false,
      properties: {
        memoId: { type: "string" },
        revisionId: { type: "string" },
        dryRun: { type: "boolean" },
      },
    },
  },
  {
    name: "move_notebook",
    description: "Move a notebook under another notebook or root and update its sort order.",
    inputSchema: {
      type: "object",
      required: ["notebookId"],
      additionalProperties: false,
      properties: {
        notebookId: { type: "string" },
        parentId: { type: ["string", "null"] },
        sortOrder: { type: "integer" },
      },
    },
  },
  {
    name: "delete_notebook",
    description: "Soft-delete a notebook and all its empty descendants. Refuses deletion if any active note exists in the subtree; never deletes notes. The default inbox is protected. Resolve paths with resolve_notebook_path first and use the exact notebookId. Use dryRun to preview affected notebook IDs without changes. Concurrent changes require a fresh preview and retry.",
    inputSchema: {
      type: "object",
      required: ["notebookId"],
      additionalProperties: false,
      properties: {
        notebookId: { type: "string", minLength: 1, description: "Exact EdgeEver notebook ID obtained from a unique path resolution or lookup." },
        dryRun: { type: "boolean", description: "Preview the empty subtree without deleting it." },
      },
    },
  },
  {
    name: "create_notebook",
    description: "Create a notebook at the root or under another notebook.",
    inputSchema: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1, maxLength: 80 },
        parentId: { type: ["string", "null"] },
        sortOrder: { type: "integer" },
      },
    },
  },
  {
    name: "rename_notebook",
    description: "Rename an active notebook in the authenticated user's workspace.",
    inputSchema: {
      type: "object",
      required: ["notebookId", "name"],
      additionalProperties: false,
      properties: {
        notebookId: { type: "string", description: "The exact EdgeEver notebook ID." },
        name: { type: "string", minLength: 1, maxLength: 80 },
      },
    },
  },
  {
    name: "get_notebook",
    description: "Get one active notebook by ID from the authenticated user's workspace.",
    inputSchema: {
      type: "object",
      required: ["notebookId"],
      additionalProperties: false,
      properties: {
        notebookId: { type: "string", description: "The exact EdgeEver notebook ID." },
      },
    },
  },
  {
    name: "find_notebooks",
    description: "Find active notebooks by name, optionally restricted to a parent notebook or the workspace root.",
    inputSchema: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1, description: "Full or partial notebook name, matched case-insensitively." },
        parentId: {
          type: ["string", "null"],
          description: "Parent notebook ID. Pass null to search only root notebooks; omit to search all levels.",
        },
        exact: { type: "boolean", description: "Require an exact name match. Defaults to false." },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: "resolve_notebook_path",
    description:
      "Resolve a slash-separated notebook path such as 'Imports/Flomo' to one exact notebook. Returns a diagnostic result instead of guessing when a segment is missing or ambiguous.",
    inputSchema: {
      type: "object",
      required: ["path"],
      additionalProperties: false,
      properties: {
        path: { type: "string", minLength: 1, description: "Slash-separated notebook names from the workspace root." },
      },
    },
  },
  {
    name: "list_notebooks",
    description:
      "List active notebooks in the authenticated user's workspace. Every returned notebook is owned by that workspace; notebooks from other users are never returned.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "list_tags",
    description: "List tags and memo counts.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "get_workspace_stats",
    description: "Get notebook, memo, tag, and resource counts for workspace diagnostics.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "list_note_templates",
    description: "List reusable note templates in the authenticated user's workspace, including their Markdown content and tags.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "select_note_template",
    description: "Select an editable workspace template before writing a new prose note. Choose by intended output: issue for a bug to reproduce or track, meeting for decisions and actions, progress for a period review, reading for article/book/course notes, idea for creative capture, goals for goal breakdown. Use general for mixed conversations, deployments, troubleshooting notes, or decisions. Use verbatim for original text. An explicitly requested templateId takes priority.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        purpose: { type: "string", enum: noteTemplatePurposes },
        templateId: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: "get_note_template",
    description: "Get one reusable note template by its exact EdgeEver template ID.",
    inputSchema: {
      type: "object",
      required: ["templateId"],
      additionalProperties: false,
      properties: {
        templateId: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: "create_note_template",
    description: "Create a reusable note template from supplied Markdown or an existing memo in the authenticated user's workspace.",
    inputSchema: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1, maxLength: 160 },
        description: { type: "string", maxLength: 500 },
        memoId: { type: "string", minLength: 1, description: "Existing memo to copy into the template." },
        title: { type: ["string", "null"], maxLength: 160 },
        contentMarkdown: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "update_note_template",
    description: "Update the name, description, title, Markdown content, or tags of a reusable note template.",
    inputSchema: {
      type: "object",
      required: ["templateId"],
      additionalProperties: false,
      properties: {
        templateId: { type: "string", minLength: 1 },
        name: { type: "string", minLength: 1, maxLength: 160 },
        description: { type: ["string", "null"], maxLength: 500 },
        title: { type: ["string", "null"], maxLength: 160 },
        contentMarkdown: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "delete_note_template",
    description: "Permanently delete a reusable note template from the authenticated user's workspace.",
    inputSchema: {
      type: "object",
      required: ["templateId"],
      additionalProperties: false,
      properties: {
        templateId: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: "save_ai_conversation",
    description: "Save a finished AI conversation into a note using the AI conversation template (「AI 对话通用模板」: 结论 / 关键步骤 / 依据 / 验证结果 / 来源 / 链接, tagged AI沉淀) and the 「对象｜主题」 title. Use this for deliberate conversation capture; use create_memo for an ordinary note. Without memoId the answer becomes a new note in the workspace inbox unless notebookId is given. Pass memoId (and expectedRevision) when the user named one exact note: that note is supplemented in place, keeps its notebook and tags, and gains the AI沉淀 tag. If the title already exists, the call returns duplicate_match_found with candidates (memoId, title, notebook, excerpt of each note's body) so the user can choose 「补充已有」 (resend with memoId) or 「另存新笔记」 (duplicate=new). Example: {\"message\":\"如何安排发布节奏？\",\"response\":\"...\",\"object\":\"产品发布计划\"}. For a same-topic merge queue the note in the inbox even when auto-classification is off: pass reclassify=true (or omit it when the target is already in the inbox) and the note is moved to the inbox; classification only starts if that feature is enabled.",
    inputSchema: {
      type: "object",
      required: ["message", "response"],
      additionalProperties: false,
      properties: {
        message: { type: "string", minLength: 1, maxLength: 20000, description: "The user's question or request that started the exchange." },
        response: { type: "string", minLength: 1, maxLength: 200000, description: "The finished answer, saved verbatim inside the template." },
        object: { type: "string", maxLength: 160, description: "「对象」 side of the title, usually the topic note or project." },
        topic: { type: "string", maxLength: 200, description: "「主题」 side of the title; defaults to the first sentence of message." },
        title: { type: "string", maxLength: 160, description: "Explicit title; overrides object/topic." },
        memoId: { type: "string", minLength: 1, description: "Exact note to supplement. Must be unique, otherwise ask the user." },
        expectedRevision: { type: "integer", minimum: 0, description: "Required with memoId; rejects a stale supplement." },
        section: {
          type: "object",
          additionalProperties: false,
          required: ["heading", "mode"],
          description: "Target section when supplementing. Omit to append at the end of the note.",
          properties: {
            heading: { type: "string", minLength: 1, maxLength: 200 },
            mode: { type: "string", enum: ["append", "replace"] },
          },
        },
        notebookId: { type: "string", minLength: 1, description: "Explicit destination for a new note. Omit to start in the inbox." },
        duplicate: { type: "string", enum: ["ask", "supplement", "merge", "new"], description: "How to treat a same-topic note. ask (default) returns candidates; supplement (with memoId) adds to that note in place; merge (with memoId) adds to it and moves it back to 等待分类 for re-classification, even when automatic classification is off; new creates a separate note." },
        reclassify: { type: "boolean", description: "Move an existing note back to the inbox for re-classification (user asked for it, or a same-topic merge). Works even when automatic classification is off." },
        expectedContentHash: { type: "string", length: 64, description: "Optional content hash guard for supplementing." },
        tags: { type: "array", maxItems: 24, items: { type: "string" }, description: "Extra tags; AI沉淀 is always added." },
        idempotencyKey: { type: "string", maxLength: 200, description: "Optional; a retry with the same key returns the first result instead of appending twice." },
      },
    },
  },
  {
    name: "set_attachment_source",
    description: "Set or clear the source of one attachment resource: page range, chapter, worksheet, cell range, source URL or note. Reuses the shared 「来源」 format (filename · P.3-5 · 章节：X · 工作表：X · 范围：A1:C9 · url · 说明：X). Example: {\"memoId\":\"memo_1\",\"resourceId\":\"res_1\",\"source\":{\"page\":2,\"chapter\":\"方法\"}}. Pass source=null to clear it. After changing a source, call update_attachment_summary so the note's 附件汇总 shows the latest value.",
    inputSchema: {
      type: "object",
      required: ["memoId", "resourceId"],
      additionalProperties: false,
      properties: {
        memoId: { type: "string", minLength: 1 },
        resourceId: { type: "string", minLength: 1 },
        source: {
          type: ["object", "null"],
          additionalProperties: false,
          description: "Source fields; null clears the source.",
          properties: {
            filename: { type: "string", maxLength: 400 },
            page: { type: "integer", minimum: 1, maximum: 100000 },
            pageEnd: { type: "integer", minimum: 1, maximum: 100000 },
            chapter: { type: "string", maxLength: 400 },
            sheet: { type: "string", maxLength: 400 },
            range: { type: "string", maxLength: 400 },
            url: { type: "string", maxLength: 2000 },
            note: { type: "string", maxLength: 400 },
          },
        },
      },
    },
  },
  {
    name: "update_attachment_summary",
    description: "Rebuild the note's 「附件汇总」 section from its attachment cards and resources. Each attachment appears once with one link and its latest source; existing cards in the body are preserved and a repeat call is idempotent. Pass expectedRevision from get_memo. Returns total, changed, and unchanged when nothing needed rewriting.",
    inputSchema: {
      type: "object",
      required: ["memoId", "expectedRevision"],
      additionalProperties: false,
      properties: {
        memoId: { type: "string", minLength: 1 },
        expectedRevision: { type: "integer", minimum: 0 },
        expectedContentHash: { type: "string", length: 64 },
      },
    },
  },
  {
    name: "insert_memo_resource",
    description: "Insert an already-uploaded resource into a specific place in the note instead of rewriting the body. Anchor it by a unique section heading (position start/end) or by unique surrounding body text (afterText/beforeText). The resource must belong to this memo (upload it first with upload_memo_attachment, stage_memo_resource or create_resource_upload_url). Returns the new revision; a missing or ambiguous anchor returns section_not_found/section_ambiguous or anchor_not_found/anchor_ambiguous with the available headings, and the note is left unchanged.",
    inputSchema: {
      type: "object",
      required: ["memoId", "resourceId", "anchor"],
      additionalProperties: false,
      properties: {
        memoId: { type: "string", minLength: 1 },
        resourceId: { type: "string", minLength: 1 },
        anchor: {
          type: "object",
          additionalProperties: false,
          description: "One of: {section, position?} | {afterText} | {beforeText}.",
          properties: {
            section: { type: "string", minLength: 1, maxLength: 200 },
            position: { type: "string", enum: ["start", "end"] },
            afterText: { type: "string", minLength: 1 },
            beforeText: { type: "string", minLength: 1 },
          },
        },
        label: { type: "string", maxLength: 400, description: "Link text override for the inserted card." },
        expectedRevision: { type: "integer", minimum: 0 },
      },
    },
  },
  {
    name: "use_note_template",
    description: "Create a new memo from a reusable note template in the selected notebook.",
    inputSchema: {
      type: "object",
      required: ["templateId", "notebookId"],
      additionalProperties: false,
      properties: {
        templateId: { type: "string", minLength: 1 },
        notebookId: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: "list_ai_instructions",
    description: "List reusable AI instructions in the authenticated user's workspace, including built-in and custom entries.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        locale: { type: "string", description: "Optional locale such as en-US or zh-CN for unmodified built-in instructions." },
      },
    },
  },
  {
    name: "get_ai_instruction",
    description: "Get one reusable AI instruction by its exact EdgeEver instruction ID.",
    inputSchema: {
      type: "object",
      required: ["instructionId"],
      additionalProperties: false,
      properties: {
        instructionId: { type: "string", minLength: 1 },
        locale: { type: "string" },
      },
    },
  },
  {
    name: "create_ai_instruction",
    description: "Create a custom reusable AI instruction in the authenticated user's workspace.",
    inputSchema: {
      type: "object",
      required: ["name", "instruction"],
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1, maxLength: 80 },
        description: { type: "string", maxLength: 200 },
        instruction: { type: "string", minLength: 1, maxLength: 2000 },
        parameterKind: { type: "string", enum: ["none", "target-language", "tone"], default: "none" },
        resultMode: { type: "string", enum: ["append", "replace", "both"], default: "both" },
        locale: { type: "string" },
      },
    },
  },
  {
    name: "update_ai_instruction",
    description: "Update the text or execution behavior of a built-in or custom reusable AI instruction.",
    inputSchema: {
      type: "object",
      required: ["instructionId"],
      additionalProperties: false,
      properties: {
        instructionId: { type: "string", minLength: 1 },
        name: { type: "string", minLength: 1, maxLength: 80 },
        description: { type: ["string", "null"], maxLength: 200 },
        instruction: { type: "string", minLength: 1, maxLength: 2000 },
        parameterKind: { type: "string", enum: ["none", "target-language", "tone"] },
        resultMode: { type: "string", enum: ["append", "replace", "both"] },
        locale: { type: "string" },
      },
    },
  },
  {
    name: "delete_ai_instruction",
    description: "Delete a reusable AI instruction. Deleted built-in instructions can be restored later.",
    inputSchema: {
      type: "object",
      required: ["instructionId"],
      additionalProperties: false,
      properties: {
        instructionId: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: "restore_default_ai_instructions",
    description: "Restore missing built-in AI instructions without overwriting edited instructions or custom entries.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        locale: { type: "string" },
      },
    },
  },
];

const READ_ONLY_MCP_TOOLS = new Set([
  "get_current_user",
  "get_inbox_classification",
  "search_memos",
  "list_memos",
  "get_memo",
  "get_table_records",
  "get_diagram",
  "get_poster",
  "get_poster_capabilities",
  "get_poster_render_job",
  "get_poster_preview",
  "export_poster",
  "list_memo_resources",
  "read_memo_attachment",
  "list_resources",
  "list_memo_revisions",
  "get_notebook",
  "find_notebooks",
  "resolve_notebook_path",
  "list_notebooks",
  "list_tags",
  "get_workspace_stats",
  "list_note_templates",
  "select_note_template",
  "get_note_template",
  "list_ai_instructions",
  "get_ai_instruction",
]);
const NON_DESTRUCTIVE_MCP_TOOLS = new Set([
  "create_memo",
  "save_ai_conversation",
  "create_table_memo",
  "create_diagram_memo",
  "create_infographic_memo",
  "create_poster_memo",
  "import_memos",
  "restore_memos",
  "move_memos",
  "add_tags_to_memos",
  "upload_memo_image",
  "create_resource_upload_url",
  "stage_memo_resource",
  "upload_memo_attachment",
  "insert_memo_resource",
  "set_attachment_source",
  "update_attachment_summary",
  "move_notebook",
  "create_notebook",
  "rename_notebook",
  "create_note_template",
  "update_note_template",
  "use_note_template",
  "create_ai_instruction",
  "update_ai_instruction",
  "restore_default_ai_instructions",
]);
const IDEMPOTENT_MCP_TOOLS = new Set([
  "delete_notebook",
  "restore_memos",
  "move_memos",
  "add_tags_to_memos",
  "remove_tags_from_memos",
  "import_memos",
  "move_notebook",
  "rename_notebook",
  "update_note_template",
  "update_ai_instruction",
  "restore_default_ai_instructions",
  "set_attachment_source",
  "update_attachment_summary",
]);

export const MCP_TOOLS = MCP_TOOL_DEFINITIONS.map((tool) => {
  const readOnly = READ_ONLY_MCP_TOOLS.has(tool.name);
  return {
    ...tool,
    title: tool.name.split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" "),
    outputSchema: { type: "object" },
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: readOnly ? false : !NON_DESTRUCTIVE_MCP_TOOLS.has(tool.name),
      idempotentHint: readOnly || IDEMPOTENT_MCP_TOOLS.has(tool.name),
      openWorldHint: false,
    },
  };
});
