import type { AppContext, AuthContext } from "../api-context";
import { callMcpTool } from "./mcp-tool-service";
import { clampNumber } from "../common/entity-utils";
import { createMemoRecord, deleteMemosRecord, getCurrentWorkspaceIdentity, getMemoDetail, getMemoDetailRow,
  getMemosForBulkAction, importMemosRecord, listMemosForMcp, mergeMemosRecord, moveMemosToNotebook,
  restoreMemosRecord, searchMemoSummaries, updateMemoRecord } from "../notes/memo-service";

// Both remote MCP and the built-in companion use this exact dispatcher.
export const executeWorkspaceTool = (context: AppContext, auth: AuthContext, name: string, args: Record<string, unknown>) =>
  callMcpTool(context, auth, name, args, { clampNumber, createMemoRecord, deleteMemosRecord,
    getCurrentWorkspaceIdentity, getMemoDetail, getMemoDetailRow, getMemosForBulkAction, importMemosRecord,
    listMemosForMcp, mergeMemosRecord, moveMemosToNotebook, restoreMemosRecord, searchMemoSummaries, updateMemoRecord });
