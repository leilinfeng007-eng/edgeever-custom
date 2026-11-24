PRAGMA foreign_keys = ON;

-- 为已有工作区补种「AI 对话通用模板」。新工作区由 provisioning 种子创建，
-- 这里只修复迁移前已经存在的工作区。幂等：同一工作区已有该 id、同名模板或
-- 同一 ai-conversation 标签时不再插入，避免重复条目。
INSERT INTO memo_templates (
  id, workspace_id, name, description, title, content_json, content_markdown, tags_json,
  created_at, updated_at
)
SELECT
  w.id || '_template_ai-conversation',
  w.id,
  'AI 对话通用模板',
  '沉淀与 AI 的对话结论：结论、关键步骤与依据、验证结果、来源链接。',
  'AI 对话通用模板',
  '{"type":"doc","content":[]}',
  '## 结论

## 关键步骤 / 依据

## 验证结果

## 来源 / 链接
',
  '["template","ai-conversation"]',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM workspaces w
WHERE NOT EXISTS (
  SELECT 1 FROM memo_templates t
  WHERE t.id = w.id || '_template_ai-conversation'
     OR (
       t.workspace_id = w.id
       AND (
         t.name = 'AI 对话通用模板'
         OR t.tags_json LIKE '%"ai-conversation"%'
       )
     )
);
