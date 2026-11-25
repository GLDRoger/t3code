import {
  type KinAttachment,
  KinChatError,
  type KinOrgId,
  KinPersonId,
  type KinProjectNoteInput,
  type KinRecordComment,
  KinRecordKey,
  type KinWorkCommentInput,
  type KinWorkCommentRemoveInput,
  type KinWorkCommentsInput,
  KIN_RECORD_COMMENT_MAX,
  KinWorkLinkAddInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { PendingUploadOwner } from "../../assets/AttachmentUpload.ts";
import { KinAttachmentStore } from "../chat/KinAttachmentStore.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { alsoOnPeople, type AssignNotice, tellPeople } from "./assignNotices.ts";
import { KinRecords } from "./KinRecords.ts";
import { KinToolText } from "./leadSchemas.ts";
import { admitted, leadTool, type Lead, namer, viewOf, viewWriter, writerFor } from "./leadWork.ts";
import { type CodingAgentConnection, connectionReaches } from "./codingAgent.ts";
import {
  type ActingBy,
  actingAs,
  addLinkBy,
  connectionViewer,
  found,
  removeLinkBy,
  tellOnScreen,
  viewerOf,
} from "./ownerWork.ts";
import {
  canHearRecord,
  commentIdFor,
  commentsPage,
  insertComment,
  personSeesRecord,
  projectNoteOf,
  removeComment,
  requestHashOf,
  withCanRemove,
  writeProjectNote,
} from "./recordComments.ts";
import { isClosed, isSuggestion, notFound, workFailure } from "./recordRows.ts";
import { viewVisible } from "./teamView.ts";

const NOTICE_WORDS = 280;
const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/**
 * A person says something on an entry they see, with files they just uploaded. When an agent
 * holds it, it is woken once with their words, on their authority. Nothing on the entry changes.
 * Through their coding agent's connection, the entry must also be one its key reaches.
 */
export const comment = Effect.fn("KinWorkComments.comment")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkCommentInput,
  uploader?: PendingUploadOwner,
  connection?: CodingAgentConnection,
) {
  const viewer = yield* viewerOf(people, input.orgId);
  const personId = viewer.person.personId;
  const author = { _tag: "person" as const, personId };
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  const requested = input.attachments ?? [];
  const requestHash = requestHashOf(input.body, requested);
  const write = Effect.fn("KinWorkComments.write")(
    function* (files: ReadonlyArray<KinAttachment>) {
      if (connection !== undefined) yield* connectionViewer(people, connection, input.orgId);
      const written = yield* insertComment({
        orgId: input.orgId,
        key: input.key,
        author,
        requestId: input.clientRequestId,
        requestHash,
        body: input.body,
        files,
        now: yield* Clock.currentTimeMillis,
        sees: (recordId) =>
          connection === undefined
            ? personSeesRecord(input.orgId, personId, recordId)
            : Effect.zipWith(
                personSeesRecord(input.orgId, personId, recordId),
                connectionReaches(connection, recordId),
                (screen, key) => screen && key,
              ),
        ...(connection === undefined ? {} : { codingAgentKey: connection.sessionId }),
      });
      const holder = yield* records.getById(input.orgId, written.recordId);
      if (written.created && holder?.ownerKind === "agent")
        yield* records.commented(input.orgId, personId, holder, written.comment.seq, input.body);
      return { shown: withCanRemove(viewer, written.comment), created: written.created };
    },
    sql.withTransaction,
    workFailure,
  );
  const posted = Effect.fn("KinWorkComments.posted")(function* (
    written: Effect.Success<ReturnType<typeof write>>,
  ) {
    if (written.created) yield* tellReaders(viewer.person, input.key, written.shown);
    return { comment: written.shown, created: written.created };
  });
  if (requested.length === 0) return yield* posted(yield* write([]));
  // A retry finds its comment before its uploads are claimed a second time.
  const row = yield* found(input.orgId, { key: input.key });
  const id = commentIdFor(input.orgId, row.recordId, author, input.clientRequestId);
  const stored = yield* sql`SELECT 1 FROM kin_record_comments
    WHERE org_id = ${input.orgId} AND comment_id = ${id}`.pipe(workFailure);
  if (stored.length > 0) return yield* posted(yield* write([]));
  const store = yield* Effect.serviceOption(KinAttachmentStore);
  if (Option.isNone(store) || uploader === undefined)
    return yield* new KinChatError({
      reason: "unavailable",
      message: "Files can't be kept here right now.",
    });
  const claimed = yield* store.value.claim(requested, uploader);
  const written = yield* write(claimed.attachments).pipe(
    Effect.onError(() => store.value.release(claimed)),
  );
  yield* store.value.discardPending(requested);
  return yield* posted(written);
});

/**
 * Whoever holds the task and whoever asked for it, once each, still here and seeing it, never
 * `author`: who hears a comment on it.
 */
const commentNotices = Effect.fn("KinWorkComments.notices")(function* (
  orgId: KinOrgId,
  row: AssignNotice["row"],
  body: string,
  author: string | null,
) {
  const sql = yield* SqlClient.SqlClient;
  const [asked] = yield* sql<{ askedBy: string | null }>`SELECT asked_by_person_id AS "askedBy"
    FROM kin_records WHERE org_id = ${orgId} AND record_id = ${row.recordId}`;
  const readers = new Set(
    [
      row.ownerKind === "person" ? row.ownerId : null,
      asked?.askedBy ?? null,
      ...(row.registerId !== "work" || isSuggestion(row) || isClosed(row.state)
        ? []
        : alsoOnPeople(row)),
    ].filter((one): one is string => one !== null && one !== author),
  );
  const why = oneLine(body, NOTICE_WORDS);
  const notices: Array<AssignNotice> = [];
  for (const reader of readers) {
    const personId = KinPersonId.make(reader);
    if (!(yield* canHearRecord(orgId, personId, row.recordId))) continue;
    notices.push({ personId, kind: "commented", row, why: why === "" ? null : why });
  }
  return notices;
});

/** A person's comment is told as they hear it given, from the team agent. */
const tellReaders = Effect.fn("KinWorkComments.tellReaders")(
  function* (person: PersonIdentity, key: string, written: KinRecordComment) {
    const records = yield* KinRecords;
    const row = yield* records.get(person.orgId, key);
    if (row === undefined || row.registerId !== "work") return;
    const notices = yield* commentNotices(person.orgId, row, written.body, person.personId);
    yield* tellOnScreen(person, `comment:${written.commentId}`, notices);
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin couldn't tell people about a comment", cause),
  ),
);

/** Its author takes a comment back, or the owner level any; its files go with it. */
export const removeOne = Effect.fn("KinWorkComments.remove")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkCommentRemoveInput,
) {
  const viewer = yield* viewerOf(people, input.orgId);
  const sql = yield* SqlClient.SqlClient;
  const removed = yield* Effect.gen(function* () {
    return yield* removeComment({
      orgId: input.orgId,
      key: input.key,
      commentId: input.commentId,
      by: viewer.person.personId,
      now: yield* Clock.currentTimeMillis,
    });
  }).pipe(sql.withTransaction, workFailure);
  const store = yield* Effect.serviceOption(KinAttachmentStore);
  if (Option.isSome(store) && removed.files.length > 0)
    yield* store.value.remove(removed.files.map((file) => file.id));
  return { comment: withCanRemove(viewer, removed.comment) };
});

/** The page of an entry's comments before `beforeSeq`, for someone who sees it. */
export const page = Effect.fn("KinWorkComments.page")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkCommentsInput,
) {
  const viewer = yield* viewerOf(people, input.orgId);
  const row = yield* found(input.orgId, { key: input.key });
  if (
    !(yield* personSeesRecord(input.orgId, viewer.person.personId, row.recordId).pipe(workFailure))
  )
    return yield* notFound(input.key);
  const shown = yield* commentsPage(input.orgId, row.recordId, input.beforeSeq).pipe(workFailure);
  return {
    comments: shown.comments.map((one) => withCanRemove(viewer, one)),
    older: shown.older,
  };
});

/**
 * The owner level sets a project's one note for every task, or clears it with empty words. Each
 * of its tasks reads it at the top of its Activity, to whoever sees the project.
 */
const projectNoteBy = Effect.fn("KinWorkComments.projectNote")(function* (
  by: ActingBy,
  input: KinProjectNoteInput,
) {
  const author = by.writer.actor;
  const sql = yield* SqlClient.SqlClient;
  return yield* Effect.gen(function* () {
    let owners = by.viewers.length > 0;
    for (const viewer of by.viewers)
      owners = owners && (yield* ownerLevel(input.orgId, viewer.person.personId));
    if (!owners || author._tag === "system")
      return yield* new KinChatError({
        reason: "not_allowed",
        message: "Only an owner can change a project's note for every task.",
      });
    const [project] = yield* sql<{ recordId: string }>`SELECT record_id AS "recordId"
      FROM kin_records WHERE org_id = ${input.orgId} AND key = ${input.key}
        AND register_id = 'projects'`;
    if (project === undefined) return yield* notFound(input.key);
    yield* writeProjectNote({
      orgId: input.orgId,
      projectId: project.recordId,
      by: author,
      requestId: input.clientRequestId,
      body: input.body,
      now: yield* Clock.currentTimeMillis,
    });
    return { note: (yield* projectNoteOf(input.orgId, project.recordId)) ?? null };
  }).pipe(sql.withTransaction, workFailure);
});
export const projectNote = (people: ReadonlyArray<PersonIdentity>, input: KinProjectNoteInput) =>
  actingAs(people, input.orgId).pipe(Effect.flatMap((by) => projectNoteBy(by, input)));

export const CommentInput = Schema.Struct({
  key: KinRecordKey.annotate({ description: "The entry's key, such as W-12." }),
  body: KinToolText(4_000, "What you want to say, in plain words."),
});
export const CommentResult = Schema.Struct({
  key: Schema.String,
  commentId: Schema.String,
  told: Schema.optional(Schema.Array(Schema.String)),
});

/**
 * A lead says something on an entry it may see, for the people of its turn. Whoever holds it and
 * whoever asked for it are told once each in their own chat. A retry of the same words in the same turn writes nothing more.
 */
const runComment = Effect.fnUntraced(function* (lead: Lead, input: typeof CommentInput.Type) {
  yield* admitted(lead, "record_comment", input);
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  const team = yield* viewOf(lead);
  const owned = yield* writerFor(lead);
  const writer = team === undefined ? owned : viewWriter(owned, team);
  const author = {
    _tag: "agent" as const,
    agentId: lead.agentId,
    askedBy: writer.askedBy ?? null,
  };
  const requestHash = requestHashOf(input.body, []);
  const written = yield* Effect.gen(function* () {
    return yield* insertComment({
      orgId: lead.orgId,
      key: input.key,
      author,
      requestId: `${lead.wakeupId}:${requestHash}`,
      requestHash,
      body: input.body,
      files: [],
      now: yield* Clock.currentTimeMillis,
      sees: (recordId) =>
        team === undefined ? Effect.succeed(true) : viewVisible(lead.orgId, team.people, recordId),
    });
  }).pipe(sql.withTransaction, workFailure);
  const result = { key: input.key, commentId: written.comment.commentId };
  const row = yield* records.getById(lead.orgId, written.recordId);
  if (!written.created || row === undefined) return result;
  const told = yield* commentNotices(lead.orgId, row, input.body, author.askedBy).pipe(
    Effect.flatMap((notices) => tellPeople(lead, notices)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Kin couldn't tell people about a comment", cause).pipe(
        Effect.as(new Set<string>()),
      ),
    ),
  );
  if (told.size === 0) return result;
  const name = yield* namer(lead);
  return {
    ...result,
    told: [...told].map(
      (id) => name({ _tag: "person", personId: KinPersonId.make(id) }) ?? "a person",
    ),
  };
});
export const leadComment = leadTool("KinWorkComments.leadComment", runComment);

/**
 * The people a lead's write is for, each checked as their own screen checks them: those behind a
 * turn others read, else the lead's owner. The change is the lead's, for them.
 */
const actingFor = Effect.fn("KinWorkComments.actingFor")(function* (lead: Lead) {
  const sql = yield* SqlClient.SqlClient;
  const team = yield* viewOf(lead);
  const people =
    team !== undefined
      ? team.people
      : (yield* sql<{ owner: string }>`SELECT owner_person_id AS owner FROM kin_agents
          WHERE org_id = ${lead.orgId} AND agent_id = ${lead.agentId}`).map((row) =>
          KinPersonId.make(row.owner),
        );
  const viewers = [];
  for (const personId of people)
    viewers.push(yield* viewerOf([{ _tag: "person", orgId: lead.orgId, personId }], lead.orgId));
  const owned = yield* writerFor(lead);
  return {
    viewers,
    writer: team === undefined ? owned : viewWriter(owned, team),
  } satisfies ActingBy;
});

export const LinkInput = Schema.Struct({
  key: KinRecordKey,
  url: KinWorkLinkAddInput.fields.url,
  name: KinWorkLinkAddInput.fields.name,
  remove: Schema.optional(Schema.Literal(true)),
});
export const LinkResult = Schema.Struct({
  key: Schema.String,
  /** The entry's web links after the change. */
  links: Schema.Array(Schema.Struct({ url: Schema.String, name: Schema.optional(Schema.String) })),
});

/** A lead adds or takes off a web link on an entry, as the people of its turn may on their screens. */
const runLink = Effect.fnUntraced(function* (lead: Lead, input: typeof LinkInput.Type) {
  yield* admitted(lead, "record_link", input);
  const by = yield* actingFor(lead);
  const at = { orgId: lead.orgId, key: input.key, url: input.url };
  const sheet =
    input.remove === true
      ? yield* removeLinkBy(by, at)
      : yield* addLinkBy(by, { ...at, ...(input.name === undefined ? {} : { name: input.name }) });
  return {
    key: sheet.key,
    links: sheet.links.flatMap((link) =>
      link.kind === "url"
        ? [{ url: link.target, ...(link.label == null ? {} : { name: link.label }) }]
        : [],
    ),
  };
});
export const leadLink = leadTool("KinWorkComments.leadLink", runLink);

export const NoteInput = Schema.Struct({
  key: KinRecordKey,
  note: Schema.NullOr(KinToolText(KIN_RECORD_COMMENT_MAX)),
});
export const NoteResult = Schema.Struct({
  key: Schema.String,
  note: Schema.NullOr(Schema.String),
});

/** A lead sets or clears a project's note for every task, as its owner level may. */
const runNote = Effect.fnUntraced(function* (lead: Lead, input: typeof NoteInput.Type) {
  yield* admitted(lead, "project_note", input);
  const body = input.note ?? "";
  const written = yield* projectNoteBy(yield* actingFor(lead), {
    orgId: lead.orgId,
    key: input.key,
    clientRequestId: `${lead.wakeupId}:${requestHashOf(body, [])}`,
    body,
  });
  return { key: input.key, note: written.note?.body ?? null };
});
export const leadProjectNote = leadTool("KinWorkComments.leadProjectNote", runNote);
