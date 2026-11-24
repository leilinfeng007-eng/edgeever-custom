PRAGMA foreign_keys = ON;

-- Four fixed note categories for existing workspaces: 工作项目 (work-projects),
-- 系统问题记录 (system-issues), 个人学习 (learning-resources) and 临时记录
-- (temp-notes). New workspaces get the same set from the provisioning seeds;
-- this migration only repairs workspaces that already exist.
--
-- Safety boundary:
--   * It never deletes a notebook, never touches memos or attachments, and
--     never moves a note between notebooks.
--   * The inbox (等待分类 / id `workspace_id || '_inbox'` / `nb_inbox` /
--     slug `inbox`) and the EdgeEver demo notebooks are never modified.
--   * The only rename is 学习资料 -> 个人学习, and only while the notebook still
--     carries the seeded slug and one of the seeded translations, so a name the
--     owner chose is kept.
--   * Every statement is guarded by NOT EXISTS / name+slug predicates, so the
--     migration can run again without creating a second copy. Names are compared
--     with lower(), matching the case-insensitive matching of the read-only
--     report in apps/api/src/workspace/note-categories.ts. SQLite lower() only
--     folds ASCII, so the literals below are lowercased for Latin names and kept
--     in their seeded spelling for every other script.
--   * A canonical id that a trashed notebook still occupies is treated as taken:
--     the row is never restored or reused, and no second copy is created under
--     that id.
--   * 灵感创作 (creative-ideas) and 生活个人 (personal-life) have no category
--     mapping here: they are left exactly as they are.

-- 1. 个人学习 adopts an untouched "学习资料" notebook. The slug is unchanged so
--    notes, shares and links keep pointing at the same notebook.
UPDATE notebooks
SET name = '个人学习',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE is_deleted = 0
  AND parent_id IS NULL
  AND slug = 'learning-resources'
  AND lower(name) IN (
    '学习资料', '學習資料', 'learning resources', 'material de aprendizaje',
    'lernmaterialien', 'ressources d''apprentissage', '学習資料',
    'materiały do nauki', 'Учебные материалы'
  );

-- 2. 工作项目
INSERT INTO notebooks (
  id, workspace_id, parent_id, name, slug, icon, color, sort_order,
  is_deleted, created_at, updated_at, deleted_at
)
SELECT
  w.id || '_projects', w.id, NULL, '工作项目', 'work-projects', 'notebook', NULL, 20,
  0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL
FROM workspaces w
WHERE NOT EXISTS (
  SELECT 1
  FROM notebooks n
  WHERE n.id = w.id || '_projects'
     OR (
       n.workspace_id = w.id
       AND n.is_deleted = 0
       AND (
         lower(IFNULL(n.slug, '')) = 'work-projects'
         OR lower(n.name) IN ('工作项目', '工作專案', 'work projects')
       )
     )
);

-- 3. 系统问题记录
INSERT INTO notebooks (
  id, workspace_id, parent_id, name, slug, icon, color, sort_order,
  is_deleted, created_at, updated_at, deleted_at
)
SELECT
  w.id || '_system_issues', w.id, NULL, '系统问题记录', 'system-issues', 'notebook', NULL, 25,
  0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL
FROM workspaces w
WHERE NOT EXISTS (
  SELECT 1
  FROM notebooks n
  WHERE n.id = w.id || '_system_issues'
     OR (
       n.workspace_id = w.id
       AND n.is_deleted = 0
       AND (
         lower(IFNULL(n.slug, '')) = 'system-issues'
         OR lower(n.name) IN ('系统问题记录', '系統問題記錄', 'system issues')
       )
     )
);

-- 4. 个人学习: created only when the workspace has no learning notebook at all.
--    Runs after statement 1, so an adopted 学习资料 is not duplicated.
INSERT INTO notebooks (
  id, workspace_id, parent_id, name, slug, icon, color, sort_order,
  is_deleted, created_at, updated_at, deleted_at
)
SELECT
  w.id || '_learning', w.id, NULL, '个人学习', 'learning-resources', 'notebook', NULL, 30,
  0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL
FROM workspaces w
WHERE NOT EXISTS (
  SELECT 1
  FROM notebooks n
  WHERE n.id = w.id || '_learning'
     OR (
       n.workspace_id = w.id
       AND n.is_deleted = 0
       AND (
         lower(IFNULL(n.slug, '')) = 'learning-resources'
         OR lower(n.name) IN (
           '个人学习', '個人學習', 'personal learning',
           '学习资料', '學習資料', 'learning resources', 'material de aprendizaje',
           'lernmaterialien', 'ressources d''apprentissage', '学習資料',
           'materiały do nauki', 'Учебные материалы'
         )
       )
     )
);

-- 5. 临时记录
INSERT INTO notebooks (
  id, workspace_id, parent_id, name, slug, icon, color, sort_order,
  is_deleted, created_at, updated_at, deleted_at
)
SELECT
  w.id || '_temp', w.id, NULL, '临时记录', 'temp-notes', 'notebook', NULL, 40,
  0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL
FROM workspaces w
WHERE NOT EXISTS (
  SELECT 1
  FROM notebooks n
  WHERE n.id = w.id || '_temp'
     OR (
       n.workspace_id = w.id
       AND n.is_deleted = 0
       AND (
         lower(IFNULL(n.slug, '')) = 'temp-notes'
         OR lower(n.name) IN ('临时记录', '臨時記錄', 'temp notes')
       )
     )
);
