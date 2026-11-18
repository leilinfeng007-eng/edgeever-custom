CREATE TABLE inbox_classification_jobs (
  memo_id TEXT PRIMARY KEY REFERENCES memos(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  inbox_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'moved', 'retained')),
  available_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT,
  outcome TEXT
);

CREATE INDEX idx_inbox_classification_pending
  ON inbox_classification_jobs(workspace_id, available_at, memo_id)
  WHERE status IN ('pending', 'running');
