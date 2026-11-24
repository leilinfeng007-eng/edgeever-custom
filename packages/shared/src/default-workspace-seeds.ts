import { resolveSupportedLocale, type SupportedLocale } from "./i18n/locales";

export type DefaultNotebookKey = "inbox" | "projects" | "system-issues" | "learning" | "temp";

export type DefaultNotebookSeed = {
  key: DefaultNotebookKey;
  slug: string;
  color: string | null;
  sortOrder: number;
  names: Record<SupportedLocale, string>;
};

/**
 * Notebooks that older installations seeded but new workspaces no longer get:
 * 灵感创作 (creative) and 生活个人 (personal). They stay in the sidebar of every
 * existing workspace, so a first sign-in still localizes their untouched names.
 * They are never provisioned for a new workspace.
 */
export type LegacyNotebookNameSeed = {
  slug: string;
  names: Record<SupportedLocale, string>;
};

// zh-CN is the language the installation migrations seed. Keep it first so
// the localization guard can recognise names that nobody has changed yet.
// color stays null so the sidebar uses the shared slate icon. A hue is stored
// only after someone saves an appearance.
export const DEFAULT_NOTEBOOK_SEEDS: readonly DefaultNotebookSeed[] = [
  {
    key: "inbox",
    slug: "inbox",
    color: null,
    sortOrder: 10,
    names: {
      "zh-CN": "等待分类",
      "zh-TW": "等待分類",
      "en-US": "Inbox",
      es: "Bandeja de entrada",
      de: "Eingang",
      fr: "Boîte de réception",
      ja: "受信トレイ",
      pl: "Skrzynka",
      ru: "Входящие",
    },
  },
  {
    key: "projects",
    slug: "work-projects",
    color: null,
    sortOrder: 20,
    names: {
      "zh-CN": "工作项目",
      "zh-TW": "工作專案",
      "en-US": "Work Projects",
      es: "Proyectos de trabajo",
      de: "Arbeitsprojekte",
      fr: "Projets professionnels",
      ja: "仕事のプロジェクト",
      pl: "Projekty zawodowe",
      ru: "Рабочие проекты",
    },
  },
  {
    key: "system-issues",
    slug: "system-issues",
    color: null,
    sortOrder: 25,
    names: {
      "zh-CN": "系统问题记录",
      "zh-TW": "系統問題記錄",
      "en-US": "System Issues",
      es: "Incidencias del sistema",
      de: "Systemprobleme",
      fr: "Incidents système",
      ja: "システム問題記録",
      pl: "Problemy systemowe",
      ru: "Системные проблемы",
    },
  },
  {
    // The slug is kept so existing "学习资料" notebooks are adopted as "个人学习".
    key: "learning",
    slug: "learning-resources",
    color: null,
    sortOrder: 30,
    names: {
      "zh-CN": "个人学习",
      "zh-TW": "個人學習",
      "en-US": "Personal Learning",
      es: "Aprendizaje personal",
      de: "Persönliches Lernen",
      fr: "Apprentissage personnel",
      ja: "個人学習",
      pl: "Nauka własna",
      ru: "Личное обучение",
    },
  },
  {
    key: "temp",
    slug: "temp-notes",
    color: null,
    sortOrder: 40,
    names: {
      "zh-CN": "临时记录",
      "zh-TW": "臨時記錄",
      "en-US": "Temp Notes",
      es: "Notas temporales",
      de: "Temporäre Notizen",
      fr: "Notes temporaires",
      ja: "一時メモ",
      pl: "Notatki tymczasowe",
      ru: "Временные заметки",
    },
  },
];

// Localization only: these slugs are no longer seeded for new workspaces.
export const LEGACY_NOTEBOOK_NAME_SEEDS: readonly LegacyNotebookNameSeed[] = [
  {
    slug: "creative-ideas",
    names: {
      "zh-CN": "灵感创作",
      "zh-TW": "靈感創作",
      "en-US": "Creative Ideas",
      es: "Ideas creativas",
      de: "Kreative Ideen",
      fr: "Idées créatives",
      ja: "アイデアと創作",
      pl: "Pomysły i twórczość",
      ru: "Творческие идеи",
    },
  },
  {
    slug: "personal-life",
    names: {
      "zh-CN": "生活个人",
      "zh-TW": "生活個人",
      "en-US": "Personal Life",
      es: "Vida personal",
      de: "Persönliches",
      fr: "Vie personnelle",
      ja: "暮らしと個人",
      pl: "Życie prywatne",
      ru: "Личная жизнь",
    },
  },
];

export const localizeDefaultNotebookName = (
  seed: DefaultNotebookSeed,
  locale: string | null | undefined,
) => seed.names[resolveSupportedLocale(locale)];

// Stable notebook id suffix per key. It is not derived from the key itself,
// because `system-issues` would otherwise produce a hyphenated id.
export const DEFAULT_NOTEBOOK_ID_SUFFIXES: Record<DefaultNotebookKey, string> = {
  inbox: "inbox",
  projects: "projects",
  "system-issues": "system_issues",
  learning: "learning",
  temp: "temp",
};

export const defaultNotebookId = (workspaceId: string, key: DefaultNotebookKey) =>
  `${workspaceId}_${DEFAULT_NOTEBOOK_ID_SUFFIXES[key]}`;

export const WELCOME_MEMO_ID = "memo_welcome";

/**
 * The welcome note as the installation migrations leave it (0001_initial.sql,
 * repaired by 0014_repair_seed_memo_content_hash.sql): its title, the content
 * hash, and revision 0 written by the `system` actor. Any edit, including a
 * title-only one, changes the title, the revision, or the actor, so together
 * they identify a welcome note nobody has touched.
 */
export const WELCOME_MEMO_SEED_TITLE = "欢迎来到 EdgeEver";
export const WELCOME_MEMO_SEED_CONTENT_HASH = "4edcf7092f86c561210d4eb788e96f28ec5c045f93952c82f5f57e1902f548bd";
// Migration 0071 repairs the original seed's literal backslash-n and advances it to revision 1.
export const WELCOME_MEMO_REPAIRED_CONTENT_HASH = "30fae5a337f8b9709505c5ab00ee921410b78632c14f4b7577c88aea0f9fc390";

export type WelcomeMemoTranslation = {
  title: string;
  paragraphs: [string, string];
};

export const WELCOME_MEMO_TRANSLATIONS: Record<SupportedLocale, WelcomeMemoTranslation> = {
  "zh-CN": {
    title: "欢迎来到 EdgeEver",
    paragraphs: [
      "这是第一条 EdgeEver 笔记，三栏、边缘、Agent-ready。",
      "接下来可以创建笔记本、写笔记、搜索内容，并把多条笔记合并成一条新的长期笔记。",
    ],
  },
  "zh-TW": {
    title: "歡迎來到 EdgeEver",
    paragraphs: [
      "這是第一篇 EdgeEver 筆記，三欄、邊緣運算、Agent-ready。",
      "接下來可以建立筆記本、撰寫筆記、搜尋內容，並將多篇筆記合併為一篇新的長期筆記。",
    ],
  },
  "en-US": {
    title: "Welcome to EdgeEver",
    paragraphs: [
      "This is your first EdgeEver note: three panes, running on the edge, ready for AI agents.",
      "Next, create notebooks, write notes, search your content, and merge several notes into a new long-term note.",
    ],
  },
  ja: {
    title: "EdgeEver へようこそ",
    paragraphs: [
      "これは EdgeEver の最初のノートです。3 ペイン構成でエッジ上で動作し、AI エージェントとも連携できます。",
      "ノートブックを作成してノートを書き、内容を検索し、複数のノートを 1 つの新しい長期ノートにまとめてみましょう。",
    ],
  },
  pl: {
    title: "Witaj w EdgeEver",
    paragraphs: [
      "To Twoja pierwsza notatka w EdgeEver: trzy panele, działanie na brzegu sieci i gotowość do pracy z agentami AI.",
      "Teraz możesz tworzyć notatniki, pisać notatki, przeszukiwać treści i scalać kilka notatek w jedną nową, trwałą notatkę.",
    ],
  },
  ru: {
    title: "Добро пожаловать в EdgeEver",
    paragraphs: [
      "Это первая заметка в EdgeEver: три панели, работа на краю сети и готовность к агентам ИИ.",
      "Дальше можно создавать блокноты, писать заметки, искать по содержимому и объединять несколько заметок в одну новую долгосрочную.",
    ],
  },
  es: {
    title: "Bienvenido a EdgeEver",
    paragraphs: [
      "Esta es su primera nota en EdgeEver: tres paneles, en el edge y lista para agentes de IA.",
      "A continuación, cree libretas, escriba notas, busque contenido y fusione varias notas en una nueva nota a largo plazo.",
    ],
  },
  de: {
    title: "Willkommen bei EdgeEver",
    paragraphs: [
      "Dies ist Ihre erste EdgeEver-Notiz: drei Bereiche, auf dem Edge ausgeführt und bereit für KI-Agenten.",
      "Erstellen Sie als Nächstes Notizbücher, schreiben Sie Notizen, durchsuchen Sie Inhalte und führen Sie mehrere Notizen zu einer neuen Notiz zusammen.",
    ],
  },
  fr: {
    title: "Bienvenue sur EdgeEver",
    paragraphs: [
      "Voici votre première note EdgeEver : trois panneaux, déployée sur l'Edge et prête pour les agents IA.",
      "Vous pouvez maintenant créer des carnets, rédiger des notes, effectuer des recherches et fusionner plusieurs notes en une nouvelle note durable.",
    ],
  },
};

export type WelcomeMemoContent = {
  title: string;
  excerpt: string;
  contentJson: string;
  contentMarkdown: string;
  contentText: string;
};

// Mirrors the document shape of the welcome note in migrations/0001_initial.sql:
// a level-2 heading followed by two paragraphs.
export const buildWelcomeMemoContent = (locale: string | null | undefined): WelcomeMemoContent => {
  const { title, paragraphs } = WELCOME_MEMO_TRANSLATIONS[resolveSupportedLocale(locale)];
  const text = (value: string) => [{ type: "text", text: value }];
  return {
    title,
    excerpt: paragraphs[0],
    contentJson: JSON.stringify({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: text(title) },
        ...paragraphs.map((paragraph) => ({ type: "paragraph", content: text(paragraph) })),
      ],
    }),
    contentMarkdown: [`## ${title}`, ...paragraphs].join("\n\n"),
    contentText: [title, ...paragraphs].join(" "),
  };
};
