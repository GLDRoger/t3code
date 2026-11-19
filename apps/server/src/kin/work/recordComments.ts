// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import {
  KIN_RECORD_COMMENTS_PAGE,
  KinAgentId,
  KinAttachment,
  KinChatError,
  KinChatId,
  KinChoiceCardState,
  KinMessageId,
  type KinOrgId,
  KinPersonId,
  type KinProjectNote,
  KinRecordId,
  KinRecordKey,
  type KinRecordComment,
  type KinRecordDetail,
  type KinRecordWaiting,
  KinWidgetId,
  type KinWorkMoveCard,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { PreparedJson, shownMail } from "../connections/Sending.ts";
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

const decodeChoice = Schema.decodeUnknownOption(Schema.fromJsonString(KinChoiceCardState));
/** About-text names keys between spaces, as `instr(' ' || about || ' ', ' KEY ')` reads it. */
const aboutKeys = (about: string) => new Set(about.split(/\s+/).filter((word) => word !== ""));
// A project's note for every task is a comment on the project whose id starts so.
const NOTE_ID = "pnote_";

/** The note a project leaves on every task: its newest standing note comment, if any. */
export const projectNoteOf = Effect.fn("KinRecordComments.projectNote")(function* (
  orgId: KinOrgId,
  projectId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<CommentRow>`SELECT ${sql.literal(COLUMNS)} FROM kin_record_comments
    WHERE org_id = ${orgId} AND record_id = ${projectId} AND removed_at IS NULL
      AND substr(comment_id, 1, ${NOTE_ID.length}) = ${NOTE_ID}
    ORDER BY seq DESC LIMIT 1`;
  if (row === undefined) return undefined;
  const [project] = yield* sql<{ key: string; title: string }>`SELECT key, title FROM kin_records
    WHERE org_id = ${orgId} AND record_id = ${projectId} AND register_id = 'projects'`;
  if (project === undefined) return undefined;
  const note: KinProjectNote = {
    body: row.body,
    at: iso(row.createdAt),
    by: principalOf(row.authorKind, row.authorId),
    project: {
      recordId: KinRecordId.make(projectId),
      key: KinRecordKey.make(project.key),
      title: project.title,
    },
  };
  return note;
});

/**
 * Sets a project's note in the caller's transaction: the standing one is taken back and these
 * words, unless empty, become the note. An identical retry changes nothing; a different one fails.
 */
export const writeProjectNote = Effect.fn("KinRecordComments.writeProjectNote")(function* (input: {
  readonly orgId: KinOrgId;
  readonly projectId: string;
  readonly by:
    | { readonly _tag: "person"; readonly personId: KinPersonId }
    | { readonly _tag: "agent"; readonly agentId: KinAgentId };
  readonly requestId: string;
  readonly body: string;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const body = input.body.trim();
  const requestHash = requestHashOf(body, []);
  const by = input.by._tag === "person" ? input.by.personId : input.by.agentId;
  const commentId = `${NOTE_ID}${hash([input.orgId, input.projectId, by, input.requestId]).slice(0, 24)}`;
  const [stored] = yield* sql<{ requestHash: string }>`SELECT request_hash AS "requestHash"
    FROM kin_record_comments WHERE org_id = ${input.orgId} AND comment_id = ${commentId}`;
  if (stored !== undefined) {
    if (stored.requestHash === requestHash) return;
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "That retry key already wrote a different note.",
    });
  }
  yield* sql`UPDATE kin_record_comments
    SET removed_at = ${input.now}, removed_by_kind = ${input.by._tag}, removed_by_id = ${by}
    WHERE org_id = ${input.orgId} AND record_id = ${input.projectId} AND removed_at IS NULL
      AND substr(comment_id, 1, ${NOTE_ID.length}) = ${NOTE_ID}`;
  if (body === "") return;
  yield* sql`INSERT INTO kin_record_comments (org_id, comment_id, record_id, seq, author_kind,
      author_id, body, files_json, request_hash, created_at)
    VALUES (${input.orgId}, ${commentId}, ${input.projectId},
      (SELECT COALESCE(MAX(seq), 0) + 1 FROM kin_record_comments
        WHERE org_id = ${input.orgId} AND record_id = ${input.projectId}),
      ${input.by._tag}, ${by}, ${body}, '[]', ${requestHash}, ${input.now})
    ON CONFLICT DO NOTHING`;
});

/**
 * The newest open card about each entry in a chat this person reads: a mail to Confirm that
 * carries its document, or an agent's question naming its key. One read for every entry given,
 * with what the card's buttons post.
 */
export const waitingCards = Effect.fn("KinRecordComments.waitingCards")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  records: ReadonlyArray<{ readonly recordId: string; readonly key: string }>,
) {
  const found = new Map<string, KinWorkMoveCard>();
  if (records.length === 0) return found;
  const sql = yield* SqlClient.SqlClient;
  const reads = (alias: string) => sql`EXISTS (SELECT 1 FROM kin_chat_members m
    WHERE m.org_id = ${sql(alias)}.org_id AND m.chat_id = ${sql(alias)}.chat_id
      AND m.principal_kind = 'person' AND m.person_id = ${personId} AND m.left_at IS NULL)`;
  type Found = {
    chatId: string;
    messageId: string;
    widgetId: string;
    revision: number;
    state: string;
    at: number;
  };
  const asks = yield* sql<Found & { recordId: string; payload: string }>`SELECT
      k.entry_record_id AS "recordId", k.chat_id AS "chatId", w.message_id AS "messageId",
      k.widget_id AS "widgetId", w.revision, w.state_json AS state,
      k.payload_json AS payload, k.proposed_at AS at
    FROM kin_connection_asks k
    JOIN kin_widgets w ON w.org_id = k.org_id AND w.widget_id = k.widget_id
    WHERE k.org_id = ${orgId} AND k.state = 'open'
      AND k.entry_record_id IN ${sql.in(records.map((record) => record.recordId))}
      AND ${reads("k")}
    ORDER BY k.proposed_at DESC, k.ask_id`;
  // Open card questions are few: read this person's once and match their keys here.
  const questions = yield* sql<Found & { about: string; question: string }>`SELECT
      q.chat_id AS "chatId", w.message_id AS "messageId", q.widget_id AS "widgetId",
      w.revision, w.state_json AS state, q.about, q.question, q.asked_at AS at
    FROM kin_questions q
    JOIN kin_widgets w ON w.org_id = q.org_id AND w.widget_id = q.widget_id
    WHERE q.org_id = ${orgId} AND q.state = 'open' AND q.kind = 'card' AND ${reads("q")}
    ORDER BY q.asked_at DESC, q.question_id LIMIT 500`;
  const card = (
    kind: KinRecordWaiting["kind"],
    row: Found,
    preview: string,
    files: KinRecordWaiting["files"],
  ): KinWorkMoveCard => ({
    kind,
    chatId: KinChatId.make(row.chatId),
    messageId: KinMessageId.make(row.messageId),
    widgetId: KinWidgetId.make(row.widgetId),
    preview: oneLine(preview, 200),
    files,
    at: iso(row.at),
    revision: row.revision,
    options: Option.match(decodeChoice(row.state), {
      onNone: () => [],
      onSome: (state) => (state.answer === null ? state.options : []),
    }),
  });
  const keep = (recordId: string, next: KinWorkMoveCard, at: number) => {
    const held = found.get(recordId);
    if (held === undefined || Date.parse(held.at) < at) found.set(recordId, next);
  };
  for (const ask of asks) {
    if (found.has(ask.recordId)) continue;
    const prepared = Option.getOrUndefined(decodePrepared(ask.payload));
    if (prepared === undefined) continue;
    // The row offers Confirm, so it names what Confirm sends: a person's saved edit, when one is on the card.
    const send = Option.getOrUndefined(decodeChoice(ask.state))?.send;
    const mail = prepared._tag === "email" ? shownMail(prepared, send) : undefined;
    found.set(
      ask.recordId,
      prepared._tag === "email" && mail !== undefined
        ? {
            ...card(
              "send",
              ask,
              `To ${mail.to.join(", ")}: ${mail.subject}`,
              prepared.attachments.map((file) => ({ name: file.name, mimeType: file.mimeType })),
            ),
            ...(send?.mayHaveGone === undefined ? {} : { mayHaveGone: send.mayHaveGone }),
          }
        : card(
            "send",
            ask,
            prepared._tag === "event" ? prepared.title : "An action to confirm",
            [],
          ),
    );
  }
  const byKey = new Map(records.map((record) => [record.key, record.recordId]));
  for (const question of questions)
    for (const word of aboutKeys(question.about)) {
      const recordId = byKey.get(word);
      if (recordId !== undefined)
        keep(recordId, card("question", question, question.question, []), question.at);
    }
  return found;
});

const waitingFor = Effect.fn("KinRecordComments.waiting")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  record: { readonly recordId: string; readonly key: string },
) {
  const found = (yield* waitingCards(orgId, personId, [record])).get(record.recordId);
  if (found === undefined) return undefined;
  const { revision: _revision, options: _options, mayHaveGone: _gone, ...waiting } = found;
  return waiting satisfies KinRecordWaiting;
});

/**
 * What an entry's sheet adds for this viewer, after whatever trimmed it for them: who asked, its
 * comments with who may remove which, and the card waiting about it in a chat they read.
 */
export const sheetExtras = Effect.fn("KinRecordComments.sheetExtras")(function* (
  orgId: KinOrgId,
  viewer: SheetViewer,
  detail: Pick<
    KinRecordDetail,
    "recordId" | "key" | "askedBy" | "comments" | "olderComments" | "project"
  >,
) {
  const waiting = yield* waitingFor(orgId, viewer.person.personId, detail);
  const projectId = detail.project?.recordId;
  const projectNote =
    projectId === undefined ||
    (viewer.teammate && !(yield* personSeesRecord(orgId, viewer.person.personId, projectId)))
      ? undefined
      : yield* projectNoteOf(orgId, projectId);
  return {
    ...(detail.askedBy === undefined ? {} : { askedBy: detail.askedBy }),
    ...(detail.comments === undefined
      ? {}
      : { comments: detail.comments.map((one) => withCanRemove(viewer, one)) }),
    ...(detail.olderComments === undefined ? {} : { olderComments: detail.olderComments }),
    ...(waiting === undefined ? {} : { waiting }),
    ...(projectNote === undefined ? {} : { projectNote }),
  };
});
