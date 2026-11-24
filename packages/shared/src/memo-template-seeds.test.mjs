import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MEMO_TEMPLATE_SEEDS,
  defaultMemoTemplateId,
  localizeDefaultMemoTemplate,
  localizeMemoTemplateSeed,
} from "./memo-template-seeds.ts";
import {
  AI_CONVERSATION_TEMPLATE_MARKDOWN,
  AI_CONVERSATION_TEMPLATE_NAME,
  listMarkdownHeadings,
} from "./note-workflow.ts";

describe("memo template seeds", () => {
  test("provides six unique editable starter templates in Chinese, English, Japanese, and Polish", () => {
    expect(DEFAULT_MEMO_TEMPLATE_SEEDS).toHaveLength(6);
    expect(new Set(DEFAULT_MEMO_TEMPLATE_SEEDS.map((seed) => seed.key)).size).toBe(6);
    expect(localizeMemoTemplateSeed(DEFAULT_MEMO_TEMPLATE_SEEDS[0], "zh-CN").title).toBe("灵感速记");
    expect(localizeMemoTemplateSeed(DEFAULT_MEMO_TEMPLATE_SEEDS[0], "en-GB").title).toBe("Quick Spark");
    expect(localizeMemoTemplateSeed(DEFAULT_MEMO_TEMPLATE_SEEDS[0], "ja-JP").title).toBe("ひらめきメモ");
    expect(localizeMemoTemplateSeed(DEFAULT_MEMO_TEMPLATE_SEEDS[0], "pl-PL").title).toBe("Szybka notatka");
    expect(localizeMemoTemplateSeed(DEFAULT_MEMO_TEMPLATE_SEEDS[0], "ko-KR").title).toBe("Quick Spark");
    expect(localizeMemoTemplateSeed(DEFAULT_MEMO_TEMPLATE_SEEDS[0], null).title).toBe("灵感速记");
  });

  test("ships the shared AI conversation template with its contract name, body, tag and every locale", () => {
    const seed = DEFAULT_MEMO_TEMPLATE_SEEDS.find((item) => item.key === "ai-conversation");
    expect(seed).toMatchObject({ key: "ai-conversation", translationKey: "aiConversation", tag: "ai-conversation" });
    expect(seed.translations["zh-CN"]).toMatchObject({
      title: AI_CONVERSATION_TEMPLATE_NAME,
      contentMarkdown: AI_CONVERSATION_TEMPLATE_MARKDOWN,
    });
    expect(Object.keys(seed.translations)).toHaveLength(9);
    for (const translation of Object.values(seed.translations)) {
      expect(translation.title.trim()).toBeTruthy();
      expect(translation.description.trim()).toBeTruthy();
      // Every language keeps the same four sections in the same order.
      expect(listMarkdownHeadings(translation.contentMarkdown)).toHaveLength(4);
    }
    expect(defaultMemoTemplateId("ws_1", seed.key)).toBe("ws_1_template_ai-conversation");
  });

  test("uses workspace-scoped deterministic ids", () => {
    expect(defaultMemoTemplateId("ws_1", "meeting")).toBe("ws_1_template_meeting");
  });

  describe("default template display language", () => {
    const [quickNote] = DEFAULT_MEMO_TEMPLATE_SEEDS;
    const stored = (locale, overrides = {}) => {
      const translation = quickNote.translations[locale];
      return {
        id: "ws_default_template_quick-note",
        name: translation.title,
        description: translation.description,
        title: translation.title,
        contentMarkdown: translation.contentMarkdown,
        tags: ["template", "quick-note"],
        ...overrides,
      };
    };

    test("shows an unedited default template in the viewer's language, whatever language it was stored in", () => {
      expect(localizeDefaultMemoTemplate(stored("zh-CN"), "pl-PL")).toEqual(stored("pl"));
      expect(localizeDefaultMemoTemplate(stored("pl"), "ja")).toEqual(stored("ja"));
      expect(localizeDefaultMemoTemplate(stored("ja"), "fr-FR")).toEqual(stored("fr"));
      expect(localizeDefaultMemoTemplate(stored("ja"), "it-IT")).toEqual(stored("en-US"));
    });

    test("keeps templates the user edited or created as they are", () => {
      const renamed = stored("zh-CN", { name: "My spark" });
      const rewritten = stored("en-US", { contentMarkdown: "## Mine" });
      const custom = { ...stored("en-US"), id: "template_abc" };

      expect(localizeDefaultMemoTemplate(renamed, "pl")).toBe(renamed);
      expect(localizeDefaultMemoTemplate(rewritten, "pl")).toBe(rewritten);
      expect(localizeDefaultMemoTemplate(custom, "pl")).toBe(custom);
    });

    test("keeps a default template whose tags were changed", () => {
      const retagged = stored("zh-CN", { tags: ["template", "quick-note", "mine"] });
      const reordered = stored("zh-CN", { tags: ["quick-note", "template"] });

      expect(localizeDefaultMemoTemplate(retagged, "pl")).toBe(retagged);
      expect(localizeDefaultMemoTemplate(reordered, "pl")).toBe(reordered);
    });

    test("does not mix fields from different translations", () => {
      const mixed = stored("zh-CN", { description: quickNote.translations["en-US"].description });

      expect(localizeDefaultMemoTemplate(mixed, "pl")).toBe(mixed);
    });
  });
});
