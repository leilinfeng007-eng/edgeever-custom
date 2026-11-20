PRAGMA foreign_keys = ON;

-- Demo notebooks are system data. Rebuild their hierarchy without touching
-- any other notebook: Work Projects stays top-level, the demo parent moves to
-- the root, and the localized demos become its children.

UPDATE notebooks
SET parent_id = NULL,
    name = 'EdgeEver 功能演示',
    slug = 'demo-features',
    sort_order = 21,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE is_deleted = 0
  AND slug = 'demo-features'
  AND name IN ('功能演示', 'Feature Demos', 'EdgeEver 功能演示');

INSERT OR IGNORE INTO notebooks (
  id, workspace_id, parent_id, name, slug, icon, color, sort_order,
  is_deleted, created_at, updated_at, deleted_at
)
SELECT
  CASE
    WHEN p.workspace_id = 'ws_default' THEN 'nb_demo_features_zh'
    ELSE p.workspace_id || '_nb_demo_features_zh'
  END,
  p.workspace_id,
  p.id,
  '中文功能演示',
  'demo-features-zh',
  'notebook',
  NULL,
  1,
  0,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  NULL
FROM notebooks p
WHERE p.is_deleted = 0
  AND p.slug = 'demo-features'
  AND p.name = 'EdgeEver 功能演示';

UPDATE memos
SET notebook_id = (
  SELECT c.id
  FROM notebooks c
  WHERE c.workspace_id = memos.workspace_id
    AND c.parent_id = memos.notebook_id
    AND c.slug = 'demo-features-zh'
    AND c.is_deleted = 0
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1
  FROM notebooks c
  WHERE c.workspace_id = memos.workspace_id
    AND c.parent_id = memos.notebook_id
    AND c.slug = 'demo-features-zh'
    AND c.is_deleted = 0
);

UPDATE notebooks
SET parent_id = (
  SELECT p.id
  FROM notebooks p
  WHERE p.workspace_id = notebooks.workspace_id
    AND p.slug = 'demo-features'
    AND p.is_deleted = 0
  LIMIT 1
),
name = '英文功能演示',
sort_order = 2,
updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE is_deleted = 0
  AND slug = 'feature-demos'
  AND name IN ('Feature Demos', '英文功能演示');
