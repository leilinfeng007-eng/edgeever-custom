CREATE INDEX idx_inbox_classification_due
  ON inbox_classification_jobs(available_at, memo_id)
  WHERE status IN ('pending', 'running');

CREATE INDEX idx_memo_contents_content_hash ON memo_contents(content_hash);
