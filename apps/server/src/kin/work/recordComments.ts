// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import {
  KIN_RECORD_COMMENTS_PAGE,
  KinAgentId,
  KinAttachment,
  KinChatError,
  KinChatId,
  KinMessageId,
  type KinOrgId,
  KinPersonId,
  type KinRecordComment,
  type KinRecordDetail,
  type KinRecordWaiting,
  KinWidgetId,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { PreparedJson } from "../connections/Sending.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import { teamVisible } from "./teamView.ts";

/** Who writes a comment: a person from their own screen, or an agent in a turn for `askedBy`. */
export type CommentAuthor =
  | { readonly _tag: "person"; readonly personId: KinPersonId }
  | { readonly _tag: "agent"; readonly agentId: KinAgentId; readonly askedBy: KinPersonId | null };

type CommentRow = {
  readonly commentId: string;
  readonly recordId: string;
  readonly seq: number;
  readonly authorKind: "person" | "agent";
  readonly authorId: string;
  readonly askedBy: string | null;
  readonly body: string;
  readonly filesJson: string;
  readonly requestHash: string;
  readonly createdAt: number;
  readonly removedAt: number | null;
  readonly removedByKind: "person" | "agent" | null;
  readonly removedById: string | null;
};
const COLUMNS = `comment_id AS "commentId", record_id AS "recordId", seq,
  author_kind AS "authorKind", author_id AS "authorId", asked_by_person_id AS "askedBy", body,
  files_json AS "filesJson", request_hash AS "requestHash", created_at AS "createdAt",
  removed_at AS "removedAt", removed_by_kind AS "removedByKind", removed_by_id AS "removedById"`;

const FilesJson = Schema.fromJsonString(Schema.Array(KinAttachment));
const decodeFiles = Schema.decodeUnknownOption(FilesJson);
const encodeFiles = Schema.encodeEffect(FilesJson);
const decodePrepared = Schema.decodeUnknownOption(PreparedJson);
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const hash = (parts: ReadonlyArray<string>) =>
  NodeCrypto.createHash("sha256").update(parts.join("\n")).digest("hex");
const principalOf = (kind: "person" | "agent", id: string): KinWorkPrincipal =>
  kind === "agent"
    ? { _tag: "agent", agentId: KinAgentId.make(id) }
    : { _tag: "person", personId: KinPersonId.make(id) };
const authorId = (author: CommentAuthor) =>
  author._tag === "agent" ? author.agentId : author.personId;
const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};
const notFound = (key: string) =>
  new KinChatError({ reason: "not_found", message: `No entry ${key.slice(0, 40)} in Work.` });

/** One author's comment on one entry for one request: its retry finds the same row. */
export const commentIdFor = (
  orgId: KinOrgId,
  recordId: string,
  author: CommentAuthor,
  requestId: string,
) => `cmt_${hash([orgId, recordId, author._tag, authorId(author), requestId]).slice(0, 24)}`;

/** What a retry must repeat exactly: the words, and the files as they were asked for. */
export const requestHashOf = (body: string, files: ReadonlyArray<KinAttachment>) =>
  hash([body, ...files.map((file) => `${file.id}:${file.name}`)]);

const toComment = (row: CommentRow): KinRecordComment => {
  const removed = row.removedAt !== null;
  return {
    commentId: row.commentId,
    seq: row.seq,
    at: iso(row.createdAt),
    by: principalOf(row.authorKind, row.authorId),
    ...(row.askedBy === null ? {} : { askedBy: KinPersonId.make(row.askedBy) }),
    // A removed comment keeps its place, never its words or files.
    body: removed ? "" : row.body,
    files: removed ? [] : Option.getOrElse(decodeFiles(row.filesJson), () => []),
    ...(row.removedAt === null || row.removedByKind === null || row.removedById === null
      ? {}
      : {
          removed: { at: iso(row.removedAt), by: principalOf(row.removedByKind, row.removedById) },
        }),
  };
};

/** The viewer a sheet is drawn for: owner-level unless `teammate`. */
type SheetViewer = {
  readonly person: { readonly personId: KinPersonId };
  readonly teammate: boolean;
};

/** Whether this viewer may take a comment back: its author, or the owner level any. */
export const withCanRemove = (
  viewer: SheetViewer,
  comment: KinRecordComment,
): KinRecordComment => ({
  ...comment,
  canRemove:
    comment.removed === undefined &&
    (!viewer.teammate ||
      (comment.by._tag === "person" && comment.by.personId === viewer.person.personId)),
});

/** Whether this person sees the entry: the owner level every one, anyone else by `personSees`. */
export const personSeesRecord = Effect.fn("KinRecordComments.personSees")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  recordId: string,
) {
  if (yield* ownerLevel(orgId, personId)) return true;
  return (yield* teamVisible(orgId, personId, [recordId])).has(recordId);
});

/** The newest page of an entry's comments before `beforeSeq` (all with none), oldest first. */
export const commentsPage = Effect.fn("KinRecordComments.page")(function* (
  orgId: KinOrgId,
  recordId: string,
  beforeSeq?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<CommentRow>`SELECT ${sql.literal(COLUMNS)} FROM kin_record_comments
    WHERE org_id = ${orgId} AND record_id = ${recordId}
      AND ${beforeSeq === undefined ? sql`1 = 1` : sql`seq < ${beforeSeq}`}
    ORDER BY seq DESC LIMIT ${KIN_RECORD_COMMENTS_PAGE + 1}`;
  return {
    comments: rows.slice(0, KIN_RECORD_COMMENTS_PAGE).toReversed().map(toComment),
    older: rows.length > KIN_RECORD_COMMENTS_PAGE,
  };
});

/** The newest `limit` comments still standing, oldest first, and how many older ones stand. */
export const latestComments = Effect.fn("KinRecordComments.latest")(function* (
  orgId: KinOrgId,
  recordId: string,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<CommentRow>`SELECT ${sql.literal(COLUMNS)} FROM kin_record_comments
    WHERE org_id = ${orgId} AND record_id = ${recordId} AND removed_at IS NULL
    ORDER BY seq DESC LIMIT ${limit}`;
  const [standing] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count
    FROM kin_record_comments
    WHERE org_id = ${orgId} AND record_id = ${recordId} AND removed_at IS NULL`;
  return {
    comments: rows.toReversed().map(toComment),
    older: Math.max(0, (standing?.count ?? 0) - rows.length),
  };
});

/** Whether the author is in this org now: a person not removed, an agent not retired. */
const authorHere = Effect.fn("KinRecordComments.authorHere")(function* (
  orgId: KinOrgId,
  author: CommentAuthor,
) {
  const sql = yield* SqlClient.SqlClient;
  const person = (personId: KinPersonId) =>
    sql`SELECT 1 FROM kin_people WHERE org_id = ${orgId} AND person_id = ${personId}
      AND removed_at IS NULL`.pipe(Effect.map((rows) => rows.length > 0));
  if (author._tag === "person") return yield* person(author.personId);
  const agent = yield* sql`SELECT 1 FROM kin_agents WHERE org_id = ${orgId}
    AND agent_id = ${author.agentId} AND retired_at IS NULL`;
  return agent.length > 0 && (author.askedBy === null || (yield* person(author.askedBy)));
});

/**
 * Writes a comment in the caller's transaction, its author and entry checked against this org's
 * rows there. `sees` is the caller's own visibility check, run in the same transaction. An
 * identical retry returns the stored comment with `created` false; a different one is refused.
 */
export const insertComment = Effect.fn("KinRecordComments.insert")(function* <E>(input: {
  readonly orgId: KinOrgId;
  readonly key: string;
  readonly author: CommentAuthor;
  readonly requestId: string;
  readonly requestHash: string;
  readonly body: string;
  readonly files: ReadonlyArray<KinAttachment>;
  readonly now: number;
  readonly sees: (recordId: string) => Effect.Effect<boolean, E, SqlClient.SqlClient>;
  /** The person's own coding agent wrote it, with this key. */
  readonly codingAgentKey?: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [record] = yield* sql<{ recordId: string }>`SELECT record_id AS "recordId"
    FROM kin_records WHERE org_id = ${input.orgId} AND key = ${input.key}`;
  if (record === undefined || !(yield* input.sees(record.recordId)))
    return yield* notFound(input.key);
  if (!(yield* authorHere(input.orgId, input.author)))
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Only someone in this company can comment.",
    });
  const commentId = commentIdFor(input.orgId, record.recordId, input.author, input.requestId);
  const [stored] = yield* sql<CommentRow>`SELECT ${sql.literal(COLUMNS)} FROM kin_record_comments
    WHERE org_id = ${input.orgId} AND comment_id = ${commentId}`;
  if (stored !== undefined) {
    if (stored.requestHash !== input.requestHash)
      return yield* new KinChatError({
        reason: "not_allowed",
        message: "That retry key already wrote a different comment.",
      });
    return { comment: toComment(stored), recordId: record.recordId, created: false };
  }
  const blank = input.body.trim() === "" && input.files.length === 0;
  if (blank)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: "A comment needs words or a file.",
    });
  const [inserted] = yield* sql<CommentRow>`INSERT INTO kin_record_comments (org_id, comment_id,
      record_id, seq, author_kind, author_id, asked_by_person_id, body, files_json, request_hash,
      created_at, coding_agent_key)
    VALUES (${input.orgId}, ${commentId}, ${record.recordId},
      (SELECT COALESCE(MAX(seq), 0) + 1 FROM kin_record_comments
        WHERE org_id = ${input.orgId} AND record_id = ${record.recordId}),
      ${input.author._tag}, ${authorId(input.author)},
      ${input.author._tag === "agent" ? input.author.askedBy : null}, ${input.body},
      ${yield* encodeFiles(input.files)}, ${input.requestHash}, ${input.now},
      ${input.codingAgentKey ?? null})
    ON CONFLICT DO NOTHING
    RETURNING ${sql.literal(COLUMNS)}`;
  if (inserted === undefined)
    return yield* new KinChatError({
      reason: "unavailable",
      message: "Someone commented at the same moment; send it again.",
    });
  for (const file of input.files)
    yield* sql`INSERT INTO kin_record_comment_files (org_id, attachment_id, comment_id)
      VALUES (${input.orgId}, ${file.id.toLowerCase()}, ${commentId})
      ON CONFLICT DO NOTHING`;
  return { comment: toComment(inserted), recordId: record.recordId, created: true };
});

/**
 * Takes a comment back in the caller's transaction: its author, or someone at the owner level.
 * One already removed is returned as it is, so a retry succeeds.
 */
export const removeComment = Effect.fn("KinRecordComments.remove")(function* (input: {
  readonly orgId: KinOrgId;
  readonly key: string;
  readonly commentId: string;
  readonly by: KinPersonId;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<CommentRow>`SELECT ${sql.literal(COLUMNS)} FROM kin_record_comments c
    WHERE c.org_id = ${input.orgId} AND c.comment_id = ${input.commentId}
      AND c.record_id = (SELECT record_id FROM kin_records
        WHERE org_id = ${input.orgId} AND key = ${input.key})`;
  if (row === undefined || !(yield* personSeesRecord(input.orgId, input.by, row.recordId)))
    return yield* new KinChatError({ reason: "not_found", message: "No such comment here." });
  const files = Option.getOrElse(decodeFiles(row.filesJson), () => []);
  if (row.removedAt !== null) return { comment: toComment(row), files: [] };
  const own = row.authorKind === "person" && row.authorId === input.by;
  if (!own && !(yield* ownerLevel(input.orgId, input.by)))
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Only whoever wrote a comment, or an owner, can remove it.",
    });
  const [removed] = yield* sql<CommentRow>`UPDATE kin_record_comments
    SET removed_at = ${input.now}, removed_by_kind = 'person', removed_by_id = ${input.by}
    WHERE org_id = ${input.orgId} AND comment_id = ${row.commentId} AND removed_at IS NULL
    RETURNING ${sql.literal(COLUMNS)}`;
  yield* sql`DELETE FROM kin_record_comment_files
    WHERE org_id = ${input.orgId} AND comment_id = ${row.commentId}`;
  return { comment: toComment(removed ?? row), files };
});

/** Whether any of these people sees the entry a comment holding this file is on. */
export const commentFileReadable = Effect.fn("KinRecordComments.fileReadable")(function* (
  people: ReadonlyArray<{ readonly orgId: KinOrgId; readonly personId: KinPersonId }>,
  attachmentId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  for (const person of people) {
    const [file] = yield* sql<{ recordId: string }>`SELECT c.record_id AS "recordId"
      FROM kin_record_comment_files f JOIN kin_record_comments c
        ON c.org_id = f.org_id AND c.comment_id = f.comment_id
      WHERE f.org_id = ${person.orgId} AND f.attachment_id = ${attachmentId.toLowerCase()}
        AND c.removed_at IS NULL`;
    if (
      file !== undefined &&
      (yield* personSeesRecord(person.orgId, person.personId, file.recordId))
    )
      return true;
  }
  return false;
});

/**
 * The newest open card about this entry in a chat this person reads: a mail to Confirm that
 * carries its document, or an agent's question about its key.
 */
const waitingFor = Effect.fn("KinRecordComments.waiting")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  record: { readonly recordId: string; readonly key: string },
) {
  const sql = yield* SqlClient.SqlClient;
  const reads = (alias: string) => sql`EXISTS (SELECT 1 FROM kin_chat_members m
    WHERE m.org_id = ${sql(alias)}.org_id AND m.chat_id = ${sql(alias)}.chat_id
      AND m.principal_kind = 'person' AND m.person_id = ${personId} AND m.left_at IS NULL)`;
  const [ask] = yield* sql<{
    chatId: string;
    messageId: string;
    widgetId: string;
    payload: string;
    at: number;
  }>`SELECT k.chat_id AS "chatId", w.message_id AS "messageId", k.widget_id AS "widgetId",
      k.payload_json AS payload, k.proposed_at AS at
    FROM kin_connection_asks k
    JOIN kin_widgets w ON w.org_id = k.org_id AND w.widget_id = k.widget_id
    WHERE k.org_id = ${orgId} AND k.entry_record_id = ${record.recordId} AND k.state = 'open'
      AND ${reads("k")}
    ORDER BY k.proposed_at DESC, k.ask_id LIMIT 1`;
  const [question] = yield* sql<{
    chatId: string;
    messageId: string;
    widgetId: string;
    question: string;
    at: number;
  }>`SELECT q.chat_id AS "chatId", w.message_id AS "messageId", q.widget_id AS "widgetId",
      q.question, q.asked_at AS at
    FROM kin_questions q
    JOIN kin_widgets w ON w.org_id = q.org_id AND w.widget_id = q.widget_id
    WHERE q.org_id = ${orgId} AND q.state = 'open' AND q.kind = 'card'
      AND instr(' ' || q.about || ' ', ${` ${record.key} `}) > 0 AND ${reads("q")}
    ORDER BY q.asked_at DESC, q.question_id LIMIT 1`;
  const card = (
    kind: KinRecordWaiting["kind"],
    found: { chatId: string; messageId: string; widgetId: string; at: number },
    preview: string,
    files: KinRecordWaiting["files"],
  ): KinRecordWaiting => ({
    kind,
    chatId: KinChatId.make(found.chatId),
    messageId: KinMessageId.make(found.messageId),
    widgetId: KinWidgetId.make(found.widgetId),
    preview: oneLine(preview, 200),
    files,
    at: iso(found.at),
  });
  const send = () => {
    if (ask === undefined) return undefined;
    const prepared = Option.getOrUndefined(decodePrepared(ask.payload));
    if (prepared === undefined) return undefined;
    return prepared._tag === "email"
      ? card(
          "send",
          ask,
          `To ${prepared.to.join(", ")}: ${prepared.subject}`,
          prepared.attachments.map((file) => ({ name: file.name, mimeType: file.mimeType })),
        )
      : card("send", ask, prepared._tag === "event" ? prepared.title : "An action to confirm", []);
  };
  const sent = send();
  const asked =
    question === undefined ? undefined : card("question", question, question.question, []);
  if (sent === undefined) return asked;
  if (asked === undefined) return sent;
  return question!.at > ask!.at ? asked : sent;
});

/**
 * What an entry's sheet adds for this viewer, after whatever trimmed it for them: who asked, its
 * comments with who may remove which, and the card waiting about it in a chat they read.
 */
export const sheetExtras = Effect.fn("KinRecordComments.sheetExtras")(function* (
  orgId: KinOrgId,
  viewer: SheetViewer,
  detail: Pick<KinRecordDetail, "recordId" | "key" | "askedBy" | "comments" | "olderComments">,
) {
  const waiting = yield* waitingFor(orgId, viewer.person.personId, detail);
  return {
    ...(detail.askedBy === undefined ? {} : { askedBy: detail.askedBy }),
    ...(detail.comments === undefined
      ? {}
      : { comments: detail.comments.map((one) => withCanRemove(viewer, one)) }),
    ...(detail.olderComments === undefined ? {} : { olderComments: detail.olderComments }),
    ...(waiting === undefined ? {} : { waiting }),
  };
});
