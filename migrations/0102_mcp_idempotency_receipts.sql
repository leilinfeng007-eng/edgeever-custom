-- MCP 写入幂等回执：调用方为一次追加/补充提供 idempotencyKey 后，
-- 同一工作区、同一工具、同一 key 的请求只生效一次；超时重试返回第一次的结果。
-- 用户日后有意重复相同操作时换一个 key 或不传即可。
CREATE TABLE IF NOT EXISTS mcp_idempotency_receipts (
  workspace_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  memo_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, tool, idempotency_key)
);
