import { describe, expect, test } from "bun:test";
import { MCP_TOOLS } from "./mcp-tools";
import { assertOpenAiCompatibleToolSchema, COMPANION_MCP_TOOLS } from "../ai/companion-tool-catalog";

describe("MCP tool catalog", () => {
  test("keeps tool names unique and schemas object-shaped", () => {
    const names = MCP_TOOLS.map((tool) => tool.name);

    expect(new Set(names).size).toBe(names.length);
    expect(MCP_TOOLS.length).toBeGreaterThan(20);
    for (const tool of MCP_TOOLS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema).toEqual({ type: "object" });
      expect(tool.annotations.openWorldHint).toBe(false);
    }
  });

  test("keeps Agent tool JSON schemas compatible with OpenAI-style function calling", () => {
    expect(COMPANION_MCP_TOOLS.length).toBeGreaterThan(20);
    expect(() => assertOpenAiCompatibleToolSchema({ type: "object", oneOf: [] }, "bad_tool"))
      .toThrow(/oneOf/);
    expect(() => assertOpenAiCompatibleToolSchema({ type: "object", anyOf: [] }, "bad_tool"))
      .toThrow(/anyOf/);
    expect(() => assertOpenAiCompatibleToolSchema({ properties: { op: { const: "add_node" } } }, "bad_tool"))
      .toThrow(/const/);
    for (const tool of COMPANION_MCP_TOOLS) {
      expect(() => assertOpenAiCompatibleToolSchema(tool.inputSchema, tool.name)).not.toThrow();
    }
  });

  test("marks reads and destructive writes consistently", () => {
    const byName = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));

    expect(byName.get("get_memo")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(byName.get("get_inbox_classification")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(byName.get("get_inbox_classification")?.inputSchema).toMatchObject({
      required: ["memoId"],
      properties: { memoId: { type: "string", minLength: 1 } },
    });
    expect(byName.get("create_memo")?.inputSchema.properties.purpose.enum).toContain("verbatim");
    expect(byName.get("create_memo")?.inputSchema.properties).toMatchObject({
      source: { type: "string", maxLength: 80 },
      sourceId: { type: "string", maxLength: 512 },
    });
    expect(byName.get("update_memo")?.inputSchema.properties.sectionOperations).toMatchObject({
      minItems: 1,
      maxItems: 20,
      items: { required: ["heading", "mode", "contentMarkdown"] },
    });
    expect(byName.get("trash_memos")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(byName.get("move_memos")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(byName.get("create_infographic_memo")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(byName.get("create_infographic_memo")?.inputSchema.properties.template.enum).toContain("chart-pie-donut-plain-text");
    expect(byName.get("create_poster_memo")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    expect(COMPANION_MCP_TOOLS.some(tool => tool.name === "create_poster_memo")).toBe(true);
    expect(byName.get("create_diagram_memo")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(byName.get("create_diagram_memo")?.inputSchema).toMatchObject({
      required: ["notebookId", "kind", "nodes"],
      properties: {
        kind: { enum: ["mind-map", "flowchart", "architecture"] },
        nodes: {
          minItems: 1,
          maxItems: 200,
          items: { required: ["id", "label"] },
        },
        edges: { maxItems: 400 },
        layout: { properties: { direction: { enum: ["left-to-right", "top-to-bottom"] } } },
      },
    });
    expect(byName.get("create_diagram_memo")?.inputSchema.properties.nodes.items.properties.x).toBeUndefined();
    expect(byName.get("create_diagram_memo")?.inputSchema.properties.nodes.items.properties.width).toBeUndefined();
    expect(byName.get("create_diagram_memo")?.inputSchema.properties.edges.items.properties.id).toBeUndefined();
    expect(byName.get("get_diagram")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(byName.get("get_diagram")?.inputSchema).toMatchObject({
      required: ["memoId"],
      properties: { includeLayout: { type: "boolean" } },
    });
    expect(byName.get("update_diagram")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(byName.get("update_diagram")?.inputSchema).toMatchObject({
      required: ["memoId", "expectedRevision", "operations"],
      properties: {
        operations: {
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            required: ["op"],
            properties: {
              op: { enum: ["add_node", "update_node", "remove_node", "add_edge", "update_edge", "remove_edge"] },
            },
          },
        },
      },
    });
    expect(byName.get("update_diagram")?.inputSchema.properties.operations.items.oneOf).toBeUndefined();
    expect(byName.get("update_diagram")?.inputSchema.properties.operations.items.properties.op.const).toBeUndefined();
    expect(byName.get("update_diagram")?.inputSchema.properties.operations.items.properties.edge.properties.id)
      .toEqual({ type: "string", minLength: 1, maxLength: 100 });
    expect(byName.get("rename_notebook")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(byName.get("rename_notebook")?.inputSchema).toMatchObject({
      required: ["notebookId", "name"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 80 },
      },
    });
    expect(byName.get("list_note_templates")?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(byName.get("delete_note_template")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(byName.get("restore_default_ai_instructions")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(byName.get("search_memos")?.inputSchema.properties.createdAfter.format).toBeUndefined();
    expect(byName.get("search_memos")?.description).toContain("createdAfter");
  });

  test("describes the conversation, section and attachment workflows", () => {
    const byName = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));

    // 归属默认行为写进描述，客户端无需靠猜测。
    expect(byName.get("update_memo")?.description).toContain("stays in the note's current notebook");
    expect(byName.get("update_memo")?.description).toContain("autoClassify=true");
    expect(byName.get("update_memo")?.inputSchema.properties.autoClassify.description)
      .toContain("works even when automatic classification is off");
    expect(byName.get("create_memo")?.inputSchema.properties.notebookId.description).toContain("等待分类");

    // 保存对话：模板、补充、同题合并、另存、重新分类。
    const conversation = byName.get("save_ai_conversation");
    expect(conversation?.inputSchema.properties.duplicate.enum).toEqual(["ask", "supplement", "merge", "new"]);
    expect(conversation?.description).toContain("AI 对话通用模板");
    expect(conversation?.description).toContain("AI沉淀");
    expect(conversation?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.get("update_memo")?.description).toContain("sectionOperations");

    // 附件：来源、插入、汇总。
    expect(byName.get("set_attachment_source")?.inputSchema.properties.source.type).toEqual(["object", "null"]);
    expect(byName.get("set_attachment_source")?.annotations).toMatchObject({ destructiveHint: false, idempotentHint: true });
    expect(byName.get("update_attachment_summary")?.inputSchema.required).toEqual(["memoId", "expectedRevision"]);
    expect(byName.get("update_attachment_summary")?.annotations).toMatchObject({ destructiveHint: false, idempotentHint: true });
    expect(byName.get("insert_memo_resource")?.inputSchema.properties.anchor.properties)
      .toMatchObject({ section: expect.any(Object), afterText: expect.any(Object), beforeText: expect.any(Object) });
    expect(byName.get("upload_memo_attachment")?.inputSchema.properties.source.properties.page.minimum).toBe(1);

    expect(() => assertOpenAiCompatibleToolSchema(conversation.inputSchema, "save_ai_conversation")).not.toThrow();
    expect(() => assertOpenAiCompatibleToolSchema(
      byName.get("set_attachment_source").inputSchema, "set_attachment_source",
    )).not.toThrow();
    expect(() => assertOpenAiCompatibleToolSchema(
      byName.get("insert_memo_resource").inputSchema, "insert_memo_resource",
    )).not.toThrow();
  });
});
