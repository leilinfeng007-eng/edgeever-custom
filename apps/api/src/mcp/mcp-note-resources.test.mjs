import { expect, test } from "bun:test";
import { validateMcpResourcePlacement } from "./mcp-note-resources.ts";

const db = {
  prepare: () => {
    throw new Error("Duplicate-reference validation must not query the database.");
  },
};

const image = (id, label = "图") => `![${label}](/api/v1/resources/${id}/blob)`;

test("blocks inserting an existing attachment reference twice and keeps other sections intact", async () => {
  const existing = `## 正文\n\n${image("res_abc")}\n`;
  const markdown = `${existing}\n## 补充\n\n${image("res_abc")}\n`;
  await expect(validateMcpResourcePlacement(db, "ws", markdown, [], {
    id: "memo",
    contentMarkdown: existing,
    allowRemoval: false,
  })).rejects.toMatchObject({ code: "attachment_duplicate_reference", status: 409 });
});

test("allows duplicate references only when explicitly requested", async () => {
  const existing = `## 正文\n\n${image("res_abc")}\n`;
  const markdown = `${existing}\n## 补充\n\n${image("res_abc")}\n`;
  await expect(validateMcpResourcePlacement(db, "ws", markdown, [], {
    id: "memo",
    contentMarkdown: existing,
    allowRemoval: false,
    allowDuplicateReferences: true,
  })).resolves.toBeUndefined();
});

test("allows keeping a single existing reference and adding a new pending one", async () => {
  const existing = `## 正文\n\n${image("res_abc")}\n`;
  const markdown = `${existing}\n## 补充\n\n${image("res_new")}\n`;
  await expect(validateMcpResourcePlacement(db, "ws", markdown, ["res_new"], {
    id: "memo",
    contentMarkdown: existing,
    allowRemoval: false,
  })).resolves.toBeUndefined();
});

test("requires a pending upload to appear in the submitted Markdown", async () => {
  await expect(validateMcpResourcePlacement(db, "ws", "没有附件", ["res_missing"], undefined))
    .rejects.toMatchObject({ code: "attachment_position_required", status: 400 });
});
