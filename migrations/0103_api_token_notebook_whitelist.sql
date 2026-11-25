-- Per-notebook read/write access for API tokens (port of upstream v2.31.2 / PR #820).
--
-- Two additive columns:
--   notebook_access_json  NULL = unrestricted (every token created before this
--                         feature, and every "full"/"read-only" token). A JSON
--                         array of {notebookId, read, write} restricts the token
--                         to the listed notebook subtrees.
--   notebook_access_level one level for the whole whitelist: 'read' | 'write'.
--                         NULL parses as 'read'.
--
-- Nothing is rewritten for existing rows: NULL stays NULL, so旧 Token 保持原权限。
-- Rows are validated on read; grants for deleted notebooks narrow at read time.
ALTER TABLE api_tokens ADD COLUMN notebook_access_json TEXT;

ALTER TABLE api_tokens ADD COLUMN notebook_access_level TEXT
  CHECK (notebook_access_level IS NULL OR notebook_access_level IN ('read', 'write'));
