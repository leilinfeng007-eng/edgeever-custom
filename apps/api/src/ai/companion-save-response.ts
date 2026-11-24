import { z } from "zod";
import {
  AI_NOTE_TAG,
  markdownToDoc,
  normalizeTags,
  parseDiagramDocument,
  parseInfographicDocument,
  parsePosterDocument,
  parseTableDocument,
} from "@edgeever/shared";
import type { AppContext } from "../api-context";
import { getActorLabel, getAuditActor } from "../auth/request-auth";
import { AppError } from "../common/app-error";
import { sha256 } from "../common/hash-utils";
import { createMemoRecord, getMemoDetail, updateMemoRecord } from "../notes/memo-service";
import { findMemoDuplicates, type MemoDuplicateCandidate } from "../notes/memo-duplicate-service";
import { resolveWorkspaceInboxId } from "../notes/notebook-service";
import {
  appendToEnd,
  buildAiConversationMarkdown,
  buildConversationTitle,
  questionSummary,
} from "../notes/ai-note-service";
import { applyNoteSectionOperations } from "../mcp/mcp-note-sections";
import { enqueueInboxClassification } from "./inbox-classification";
import { getCompanionTurn, turnFocus, type CompanionScope } from "./companion-service";

export { buildAiConversationMarkdown };

export const SaveCompanionResponseSchema = z.object({
  action: z.enum(["create", "append"]),
  /** Only for create: how to treat an existing note about the same topic. */
  duplicate: z.enum(["ask", "supplement", "new"]).optional(),
  memoId: z.string().min(1).max(100).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  expectedContentHash: z.string().length(64).optional(),
  title: z.string().trim().min(1).max(160).optional(),
  tags: z.array(z.string()).max(24).optional(),
  /** Target section of the note; omitted means the very end of the note. */
  section: z.object({
    heading: z.string().trim().min(1).max(200),
    mode: z.enum(["append", "replace"]),
  }).strict().optional(),
}).strict();

export type SaveCompanionResponseInput = z.infer<typeof SaveCompanionResponseSchema>;

/**
 * A same-topic note already exists. The 409 carries the candidates so a client
 * can offer 「补充已有」 or 「另存新笔记」 instead of guessing.
 */
export class CompanionDuplicateMatchError extends AppError {
  readonly candidates: MemoDuplicateCandidate[];

  constructor(candidates: MemoDuplicateCandidate[]) {
    super(
      "duplicate_match_found",
      "A note about the same topic already exists. Choose to supplement it or save a new note.",
      409,
      { candidates },
    );
    this.name = "CompanionDuplicateMatchError";
    this.candidates = candidates;
  }
}

const isStructuredNote = (markdown: string) =>
  Boolean(parseDiagramDocument(markdown) || parseTableDocument(markdown)
    || parseInfographicDocument(markdown) || parsePosterDocument(markdown));

const conflict = (message: string) => new AppError("companion_action_conflict", message, 409);

/** Save the persisted answer exactly, without a second model call rewriting it.
 * Receipt and mutation commit atomically so retries cannot append/create twice. */
export async function saveCompanionResponse(c: AppContext, scope: CompanionScope, turnId: string,
  input: SaveCompanionResponseInput) {
  const db = c.env.storage.db;
  const turn = await getCompanionTurn(db, scope, turnId);
  if (!turn || turn.status !== "completed" || !turn.response.trim())
    throw new AppError("companion_response_unavailable", "Only a completed, non-empty answer can be saved.", 409);
  const duplicate = input.duplicate ?? "ask";
  if (input.action === "append" && input.duplicate !== undefined)
    throw new AppError("invalid_params", "A duplicate choice only applies when creating a note.", 400);
  if (input.action === "append" && (!input.memoId || input.expectedRevision === undefined))
    throw new AppError("invalid_params", "Appending requires the current note and its revision.", 400);
  if (input.action === "create" && duplicate === "supplement"
    && (!input.memoId || input.expectedRevision === undefined))
    throw new AppError("invalid_params", "Supplementing a note requires that note and its revision.", 400);
  // The receipt key covers everything that changes what would be written, so a
  // retried request with the same intent reuses the first result.
  const key = await sha256(JSON.stringify([
    scope.workspaceId, scope.ownerId, turnId, input.action, duplicate,
    input.memoId ?? "", input.section?.heading ?? "", input.section?.mode ?? "",
  ]));
  const id = `reply_${key}`;
  const previous = async () => {
    const receipt = await db.prepare("SELECT result_memo_id FROM companion_actions WHERE id = ? AND workspace_id = ? AND owner_id = ? AND status = 'applied'")
      .bind(id, scope.workspaceId, scope.ownerId).first<{ result_memo_id: string }>();
    if (!receipt) return null;
    const memo = await getMemoDetail(db, scope.workspaceId, receipt.result_memo_id);
    if (!memo) throw new AppError("companion_saved_note_unavailable", "The saved note is unavailable. Check the trash before creating another copy.", 409);
    return { memo, reused: true };
  };
  const existing = await previous();
  if (existing) return existing;
  const actor = getAuditActor(c);
  const auth = c.get("auth");
  const inboxId = await resolveWorkspaceInboxId(db, scope.workspaceId);
  const now = new Date().toISOString();
  const receipt = (memoId: string, toolName: "create_memo" | "update_memo") => db.prepare(`INSERT INTO companion_actions
    (id, turn_id, workspace_id, owner_id, payload_json, status, result_memo_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, 'applied', ?, ?, ?)`)
    .bind(id, turnId, scope.workspaceId, scope.ownerId, JSON.stringify({ plan: {
      kind: "tool", toolName, arguments: { sourceTurnId: turnId }, reason: "Save answer requested by the user",
    }, notes: [] }), memoId, now, now);
  // Compare-and-set on the revision and the row timestamp: a concurrent edit or
  // a move between read and write aborts the batch instead of overwriting.
  const expectedState = (revision: number, memoId: string, updatedAt: string) =>
    db.prepare(`UPDATE memo_contents SET revision = CASE WHEN revision = ? AND EXISTS
      (SELECT 1 FROM memos m WHERE m.id = ? AND m.workspace_id = ? AND m.updated_at = ? AND m.is_deleted = 0 AND m.is_archived = 0)
      THEN revision ELSE NULL END WHERE memo_id = ?`)
      .bind(revision, memoId, scope.workspaceId, updatedAt, memoId);
  // The turn remembers the note it was opened on; that note is the 对象 of the title.
  const focus = turnFocus(turn);
  const noteTitle = async (memoId: string | undefined) =>
    memoId ? (await getMemoDetail(db, scope.workspaceId, memoId))?.title ?? null : null;
  // 「对象」is the note the conversation is bound to; without one the answer is
  // about the AI conversation itself.
  const objectTitle = (input.memoId ? await noteTitle(input.memoId) : null)
    ?? focus.title?.trim()
    ?? await noteTitle(focus.memoId);
  const title = input.title ?? buildConversationTitle({
    object: objectTitle,
    topic: questionSummary(turn.message),
  });
  // A note about this answer is wrapped in the shared template; an addition to
  // an existing note writes the answer itself, so its own sections are not
  // duplicated inside the target section.
  const body = buildAiConversationMarkdown({ message: turn.message, response: turn.response });
  const addition = turn.response.trim();
  const after = (memoId: string) => [receipt(memoId, "create_memo"),
    ...enqueueInboxClassification(c.env, auth, inboxId, memoId, true)];
  const touch = (memoId: string) => [receipt(memoId, "update_memo")];
  try {
    if (input.action === "create") {
      if (duplicate === "supplement") {
        const source = await getMemoDetail(db, scope.workspaceId, input.memoId!);
        if (!source || source.isDeleted || source.isArchived || source.revision !== input.expectedRevision)
          throw conflict("The note changed. Refresh it before supplementing it.");
        if (input.expectedContentHash && source.contentHash !== input.expectedContentHash)
          throw conflict("The note content changed. Refresh it before supplementing it.");
        if (isStructuredNote(source.contentMarkdown))
          throw new AppError("companion_append_unsupported", "Append to a prose note, or save this answer as a new note.", 400);
        const contentMarkdown = input.section
          ? applyNoteSectionOperations(source.contentMarkdown, [{
            heading: input.section.heading, mode: input.section.mode, contentMarkdown: addition,
          }])
          : appendToEnd(source.contentMarkdown, addition);
        // The target keeps its notebook and tags; only the AI marker is added
        // and no inbox classification is queued for an existing note.
        const tags = normalizeTags([...source.tags, ...(input.tags ?? []), AI_NOTE_TAG]);
        const result = await updateMemoRecord(db, scope.workspaceId, source.id, {
          expectedRevision: source.revision,
          contentMarkdown,
          tags,
          ...(input.title ? { title: input.title } : {}),
        }, actor, getActorLabel(c), false, {
          before: [expectedState(source.revision, source.id, source.updatedAt)],
          after: touch,
        });
        if (!("memo" in result)) throw new AppError(result.error, result.message, result.status ?? 409);
        return { memo: result.memo, reused: false };
      }
      const contentHash = await sha256(body + JSON.stringify(markdownToDoc(body)));
      const candidates = await findMemoDuplicates(db, scope.workspaceId, { title, contentHash });
      if (duplicate === "ask" && candidates.length) throw new CompanionDuplicateMatchError(candidates);
      const memo = await createMemoRecord(db, scope.workspaceId, {
        notebookId: inboxId, title, contentMarkdown: body,
        tags: normalizeTags([AI_NOTE_TAG, ...(input.tags ?? [])]),
      }, actor, getActorLabel(c), after);
      return { memo, reused: false };
    }
    const source = await getMemoDetail(db, scope.workspaceId, input.memoId!);
    if (!source || source.isDeleted || source.isArchived || source.revision !== input.expectedRevision)
      throw conflict("The note changed. Refresh it before appending.");
    if (input.expectedContentHash && source.contentHash !== input.expectedContentHash)
      throw conflict("The note content changed. Refresh it before appending.");
    if (isStructuredNote(source.contentMarkdown))
      throw new AppError("companion_append_unsupported", "Append to a prose note, or save this answer as a new note.", 400);
    const contentMarkdown = input.section
      ? applyNoteSectionOperations(source.contentMarkdown, [{
        heading: input.section.heading, mode: input.section.mode, contentMarkdown: turn.response.trim(),
      }])
      : appendToEnd(source.contentMarkdown, turn.response);
    // Appending to the note the user is editing must not move it: a note in a
    // regular notebook keeps its explicit location. Only an inbox note is
    // queued again, matching the manual-edit rule used by the HTTP route.
    const staysInInbox = source.notebookId === inboxId;
    const result = await updateMemoRecord(db, scope.workspaceId, source.id, {
      expectedRevision: source.revision, contentMarkdown,
    }, actor, getActorLabel(c), false, {
      before: [expectedState(source.revision, source.id, source.updatedAt)],
      after: memoId => staysInInbox
        ? [...touch(memoId), ...enqueueInboxClassification(c.env, auth, inboxId, memoId, true)]
        : touch(memoId),
    });
    if (!("memo" in result)) throw new AppError(result.error, result.message, result.status ?? 409);
    return { memo: result.memo, reused: false };
  } catch (error) {
    const applied = await previous();
    if (applied) return applied;
    throw error;
  }
}
