import {
  KinChatError,
  KinChatId,
  KinMessageId,
  KinDocFile,
  type KinDocOperation,
  type KinDocRow,
  type KinDocVersion,
  type KinDocVersionKind,
  type KinOrgId,
  type KinRecordRelation,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";

import {
  applyOperations,
  DOC_BODY_MAX,
  normalize,
  type Operation,
  rewriteRefusal,
} from "./docBody.ts";
import { KinRecords, type Writer } from "./KinRecords.ts";
import { listOf } from "./lists.ts";
import { actorOf, iso, principal, type RecordRow, toRecord, unavailable } from "./recordRows.ts";
import { indexRecord } from "./searchIndex.ts";

/**
 * Docs over the records engine: a doc is a `docs` entry, so owner, client, project, label, links
 * and change log are `KinRecords`'; its body is `kin_doc_versions`, every version whole. Each
 * write is one transaction: the version, the entry's change, and its search rows.
 */

/** Who made a version and in answer to what, read from stored rows by the caller. */
export type Provenance = {
  readonly answered?: {
    readonly messageId: string;
    readonly author: KinWorkPrincipal;
  };
  readonly audience?: "owner_only" | "shared";
};

type VersionRow = {
  readonly version: number;
  readonly title: string;
  readonly body: string;
  readonly kind: KinDocVersionKind;
  readonly summary: string;
  readonly operationsJson: string;
  readonly baseVersion: number | null;
  readonly restoredFrom: number | null;
  readonly actorKind: string;
  readonly actorId: string | null;
  readonly via: KinDocVersion["provenance"]["via"];
  readonly wakeupId: string | null;
  readonly chatId: string | null;
  readonly answeredMessageId: string | null;
  readonly answeredAuthorKind: string | null;
  readonly answeredAuthorId: string | null;
  readonly audience: "owner_only" | "shared" | null;
  readonly bodyKind: "markdown" | "file";
  readonly fileJson: string | null;
  readonly createdAt: number;
};

const Operations = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ op: Schema.String, section: Schema.optional(Schema.String) })),
);
const encodeOperations = Schema.encodeEffect(Operations);
const decodeOperations = Schema.decodeUnknownOption(Operations);
const FileJson = Schema.fromJsonString(KinDocFile);
const encodeFile = Schema.encodeEffect(FileJson);
const decodeFile = Schema.decodeUnknownOption(FileJson);
const KNOWN_OPS: ReadonlyArray<KinDocOperation["op"]> = [
  "create",
  "replace_section",
  "insert_after",
  "append",
  "replace_phrase",
  "retitle",
  "rewrite",
  "restore",
];

const isChatError = Schema.is(KinChatError);
const failed = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((error) =>
      isChatError(error)
        ? Effect.void
        : Effect.logWarning("Kin Docs failed", {
            errorTag: error._tag,
            ...(isSqlError(error) ? { message: error.message } : {}),
          }),
    ),
    Effect.mapError((error) => (isChatError(error) ? error : unavailable)),
  );
const transaction = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => failed(sql.withTransaction(effect)));

export const docNotFound = (key: string) =>
  new KinChatError({ reason: "not_found", message: `No doc ${key.slice(0, 40)}.` });
const fileOnly = (key: string) =>
  new KinChatError({
    reason: "invalid_state",
    message: `${key} is a generated file, so its text isn't edited here. Make it again to change it; every version is kept.`,
  });
const stale = (key: string, latest: number) =>
  new KinChatError({
    reason: "conflict",
    message: `${key} is at version ${latest} now, so nothing was changed. Read it again.`,
  });

const selectVersion = (sql: SqlClient.SqlClient) => sql`SELECT version, title, body, kind, summary,
    operations_json AS "operationsJson", base_version AS "baseVersion",
    restored_from AS "restoredFrom", actor_kind AS "actorKind", actor_id AS "actorId", via,
    wakeup_id AS "wakeupId", chat_id AS "chatId", answered_message_id AS "answeredMessageId",
    answered_author_kind AS "answeredAuthorKind", answered_author_id AS "answeredAuthorId",
    audience, body_kind AS "bodyKind", file_json AS "fileJson", created_at AS "createdAt"
  FROM kin_doc_versions`;

export const toVersion = (row: VersionRow): KinDocVersion => {
  const answeredBy = principal(row.answeredAuthorKind, row.answeredAuthorId);
  const file =
    row.bodyKind === "file" && row.fileJson !== null
      ? Option.getOrUndefined(decodeFile(row.fileJson))
      : undefined;
  return {
    ...(file === undefined ? {} : { file }),
    version: row.version,
    at: iso(row.createdAt),
    kind: row.kind,
    title: row.title as KinDocVersion["title"],
    summary: row.summary,
    baseVersion: row.baseVersion,
    restoredFrom: row.restoredFrom,
    operations: Option.getOrElse(decodeOperations(row.operationsJson), () => []).flatMap(
      (operation): ReadonlyArray<KinDocOperation> =>
        KNOWN_OPS.includes(operation.op as KinDocOperation["op"])
          ? [
              {
                op: operation.op as KinDocOperation["op"],
                ...(operation.section === undefined ? {} : { section: operation.section }),
              },
            ]
          : [],
    ),
    chars: row.body.length,
    provenance: {
      by: actorOf(row.actorKind, row.actorId),
      via: row.via,
      wakeupId: row.wakeupId,
      chatId: row.chatId === null ? null : KinChatId.make(row.chatId),
      answered:
        row.answeredMessageId === null || answeredBy === null
          ? null
          : { messageId: KinMessageId.make(row.answeredMessageId), author: answeredBy },
      audience: row.audience,
    },
  };
};

/** A version of a doc in this org; the latest when `version` is absent. */
export const versionOf = Effect.fn("KinDocs.version")(function* (
  orgId: KinOrgId,
  recordId: string,
  version?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<VersionRow>`${selectVersion(sql)}
    WHERE org_id = ${orgId} AND record_id = ${recordId}
      AND (${version ?? null} IS NULL OR version = ${version ?? null})
    ORDER BY version DESC LIMIT 1`;
  return row;
});

/** A doc by key or id, in this org's Docs list; anything else, another org's included, is unknown. */
export const docRow = Effect.fn("KinDocs.row")(function* (
  orgId: KinOrgId,
  ref: { readonly key: string } | { readonly recordId: string },
) {
  const records = yield* KinRecords;
  const row =
    "key" in ref ? yield* records.get(orgId, ref.key) : yield* records.getById(orgId, ref.recordId);
  if (row === undefined || listOf(row.registerId) !== "docs")
    return yield* docNotFound("key" in ref ? ref.key : "with that id");
  return row;
});

export const toDocRow = (row: RecordRow, latest: VersionRow, now: number): KinDocRow => {
  const record = toRecord(row, now);
  return {
    recordId: record.recordId,
    key: record.key,
    title: record.title,
    owner: record.owner,
    ...(record.party === undefined ? {} : { party: record.party }),
    ...(record.project === undefined ? {} : { project: record.project }),
    sensitive: record.sensitive,
    ...(record.sensitiveInherited === true ? { sensitiveInherited: true as const } : {}),
    archived: row.state === "dropped",
    bodyKind: latest.bodyKind,
    latest: toVersion(latest),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    rev: record.rev,
  };
};

const tooLong = (length: number) =>
  new KinChatError({
    reason: "invalid_state",
    message: `A doc holds at most ${DOC_BODY_MAX} characters; this is ${length}.`,
  });

const insertVersion = Effect.fn("KinDocs.insertVersion")(function* (
  orgId: KinOrgId,
  recordId: string,
  writer: Writer,
  provenance: Provenance,
  version: {
    readonly version: number;
    readonly title: string;
    readonly body: string;
    readonly kind: KinDocVersionKind;
    readonly summary: string;
    readonly operations: ReadonlyArray<KinDocOperation>;
    readonly baseVersion: number | null;
    readonly restoredFrom?: number;
    readonly originKey: string;
    readonly now: number;
    readonly file?: KinDocFile;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const file = version.file;
  const actorId =
    writer.actor._tag === "agent"
      ? writer.actor.agentId
      : writer.actor._tag === "person"
        ? writer.actor.personId
        : null;
  const answered = provenance.answered;
  yield* sql`INSERT INTO kin_doc_versions (org_id, record_id, version, body_kind, body, title, kind,
      summary, operations_json, base_version, restored_from, actor_kind, actor_id, via, wakeup_id,
      chat_id, answered_message_id, answered_author_kind, answered_author_id, audience, origin_key,
      created_at, file_json, file_attachment_id, worker_id)
    VALUES (${orgId}, ${recordId}, ${version.version}, ${file === undefined ? "markdown" : "file"},
      ${version.body}, ${version.title},
      ${version.kind}, ${version.summary}, ${yield* encodeOperations(version.operations)},
      ${version.baseVersion}, ${version.restoredFrom ?? null}, ${writer.actor._tag}, ${actorId},
      ${writer.via}, ${writer.wakeupId ?? null}, ${writer.chatId ?? null},
      ${answered?.messageId ?? null}, ${answered?.author._tag ?? null},
      ${answered === undefined ? null : answered.author._tag === "person" ? answered.author.personId : answered.author.agentId},
      ${provenance.audience ?? null}, ${version.originKey}, ${version.now},
      ${file === undefined ? null : yield* encodeFile(file)}, ${file?.attachmentId ?? null},
      ${file?.workerId ?? null})`;
});

/** The version an identical earlier call made, so a retry returns it and changes nothing. */
const madeBy = Effect.fn("KinDocs.madeBy")(function* (orgId: KinOrgId, originKey: string) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ recordId: string; version: number }>`SELECT record_id AS "recordId",
      version FROM kin_doc_versions WHERE org_id = ${orgId} AND origin_key = ${originKey}
    ORDER BY version LIMIT 1`;
  return row;
});

export type Written = {
  readonly row: RecordRow;
  readonly version: VersionRow;
  readonly created: boolean;
};

const settle = Effect.fn("KinDocs.settle")(function* (orgId: KinOrgId, recordId: string) {
  const records = yield* KinRecords;
  const row = yield* records.getById(orgId, recordId);
  const version = yield* versionOf(orgId, recordId);
  if (row === undefined || version === undefined) return yield* unavailable;
  return { row, version };
});

export const create = Effect.fn("KinDocs.create")(function* (
  orgId: KinOrgId,
  writer: Writer,
  provenance: Provenance,
  input: {
    readonly title: string;
    readonly body: string;
    readonly owner: KinWorkPrincipal;
    readonly summary: string;
    readonly partyId?: string | null;
    readonly projectId?: string | null;
    readonly sensitive?: boolean;
    readonly originKey: string;
    readonly source?: { readonly chatId: KinChatId; readonly messageId: KinMessageId };
  },
) {
  const body = normalize(input.body);
  if (body.length > DOC_BODY_MAX) return yield* tooLong(body.length);
  return yield* transaction(
    Effect.gen(function* () {
      const records = yield* KinRecords;
      const { row, created } = yield* records.create(orgId, writer, {
        list: "docs",
        originKey: input.originKey,
        title: input.title,
        owner: input.owner,
        ...(input.partyId === undefined ? {} : { partyId: input.partyId }),
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.sensitive === true ? { sensitive: true } : {}),
        ...(input.source === undefined ? {} : { source: input.source }),
      });
      if (listOf(row.registerId) !== "docs") return yield* unavailable;
      if (!created) return { ...(yield* settle(orgId, row.recordId)), created };
      const now = yield* Clock.currentTimeMillis;
      yield* insertVersion(orgId, row.recordId, writer, provenance, {
        version: 1,
        title: input.title,
        body,
        kind: "created",
        summary: input.summary,
        operations: [{ op: "create" }],
        baseVersion: null,
        originKey: input.originKey,
        now,
      });
      yield* indexRecord(orgId, row.recordId);
      return { ...(yield* settle(orgId, row.recordId)), created };
    }),
  );
});

/** A new version from the current one, logged on the entry; `title` renames it with it. */
const revise = Effect.fn("KinDocs.revise")(function* (
  orgId: KinOrgId,
  writer: Writer,
  provenance: Provenance,
  row: RecordRow,
  current: VersionRow,
  next: {
    readonly title: string;
    readonly body: string;
    readonly kind: KinDocVersionKind;
    readonly summary: string;
    readonly operations: ReadonlyArray<KinDocOperation>;
    readonly restoredFrom?: number;
    readonly originKey: string;
    readonly file?: KinDocFile;
  },
) {
  const records = yield* KinRecords;
  const now = yield* Clock.currentTimeMillis;
  const version = current.version + 1;
  yield* insertVersion(orgId, row.recordId, writer, provenance, {
    ...next,
    version,
    baseVersion: current.version,
    now,
  });
  yield* records.update(
    orgId,
    writer,
    row.key,
    next.title === row.title ? {} : { title: next.title },
    undefined,
    [{ field: "version", from: String(current.version), to: String(version) }],
  );
  return { ...(yield* settle(orgId, row.recordId)), created: true };
});

/** The same call again in the same turn returns what it made; anything else starts fresh. */
const retried = Effect.fn("KinDocs.retried")(function* (
  orgId: KinOrgId,
  recordId: string,
  originKey: string,
) {
  const made = yield* madeBy(orgId, originKey);
  if (made === undefined) return undefined;
  if (made.recordId !== recordId)
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "That retry names another doc.",
    });
  const records = yield* KinRecords;
  const row = yield* records.getById(orgId, recordId);
  const version = yield* versionOf(orgId, recordId, made.version);
  if (row === undefined || version === undefined) return yield* unavailable;
  return { row, version, created: false };
});

export const edit = Effect.fn("KinDocs.edit")(function* (
  orgId: KinOrgId,
  writer: Writer,
  provenance: Provenance,
  ref: { readonly key: string },
  input: {
    readonly operations: ReadonlyArray<Operation>;
    readonly summary: string;
    readonly originKey: string;
  },
) {
  return yield* transaction(
    Effect.gen(function* () {
      const row = yield* docRow(orgId, ref);
      const again = yield* retried(orgId, row.recordId, input.originKey);
      if (again !== undefined) return again;
      const current = yield* versionOf(orgId, row.recordId);
      if (current === undefined) return yield* unavailable;
      if (current.bodyKind === "file") return yield* fileOnly(row.key);
      const applied = applyOperations(current.body, row.title, input.operations);
      if (applied._tag === "refused") return yield* applied.error;
      // Every operation already holds: a retry of an edit that landed, so nothing to write.
      if (applied.body === current.body && applied.title === row.title)
        return { row, version: current, created: false };
      return yield* revise(orgId, writer, provenance, row, current, {
        title: applied.title,
        body: applied.body,
        kind: "edited",
        summary: input.summary,
        operations: applied.ops,
        originKey: input.originKey,
      });
    }),
  );
});

export const rewrite = Effect.fn("KinDocs.rewrite")(function* (
  orgId: KinOrgId,
  writer: Writer,
  provenance: Provenance,
  ref: { readonly key: string },
  input: {
    readonly body: string;
    readonly baseVersion: number;
    readonly summary: string;
    readonly originKey: string;
  },
) {
  const body = normalize(input.body);
  if (body.length > DOC_BODY_MAX) return yield* tooLong(body.length);
  return yield* transaction(
    Effect.gen(function* () {
      const row = yield* docRow(orgId, ref);
      const again = yield* retried(orgId, row.recordId, input.originKey);
      if (again !== undefined) return again;
      const current = yield* versionOf(orgId, row.recordId);
      if (current === undefined) return yield* unavailable;
      if (current.bodyKind === "file") return yield* fileOnly(row.key);
      if (current.version !== input.baseVersion) return yield* stale(row.key, current.version);
      const refused = rewriteRefusal(current.body, body);
      if (refused !== undefined) return yield* refused;
      return yield* revise(orgId, writer, provenance, row, current, {
        title: row.title,
        body,
        kind: "rewritten",
        summary: input.summary,
        operations: [{ op: "rewrite" }],
        originKey: input.originKey,
      });
    }),
  );
});

/** Brings a version back as a new one. Refused when the latest is not the one the caller saw. */
export const restore = Effect.fn("KinDocs.restore")(function* (
  orgId: KinOrgId,
  writer: Writer,
  provenance: Provenance,
  ref: { readonly key: string },
  input: {
    readonly version: number;
    readonly latest: number;
    readonly summary?: string;
    readonly originKey: string;
  },
) {
  return yield* transaction(
    Effect.gen(function* () {
      const row = yield* docRow(orgId, ref);
      const again = yield* retried(orgId, row.recordId, input.originKey);
      if (again !== undefined) return again;
      const current = yield* versionOf(orgId, row.recordId);
      if (current === undefined) return yield* unavailable;
      if (current.bodyKind === "file") return yield* fileOnly(row.key);
      if (current.version !== input.latest) return yield* stale(row.key, current.version);
      const old = yield* versionOf(orgId, row.recordId, input.version);
      if (old === undefined)
        return yield* new KinChatError({
          reason: "not_found",
          message: `${row.key} has no version ${input.version}; it is at ${current.version}.`,
        });
      if (old.version === current.version) return { row, version: current, created: false };
      return yield* revise(orgId, writer, provenance, row, current, {
        title: old.title,
        body: old.body,
        kind: "restored",
        summary: input.summary ?? `Restored version ${old.version}`,
        operations: [{ op: "restore" }],
        restoredFrom: old.version,
        originKey: input.originKey,
      });
    }),
  );
});

/**
 * A generated file as the next version of the doc `docOrigin` names, made with it on first use.
 * `originKey` is the build's own, so collecting the same build again changes nothing.
 */
export const fileVersion = Effect.fn("KinDocs.fileVersion")(function* (
  orgId: KinOrgId,
  writer: Writer,
  provenance: Provenance,
  input: {
    readonly docOrigin: string;
    readonly originKey: string;
    readonly title: string;
    readonly summary: string;
    readonly owner: KinWorkPrincipal;
    readonly sensitive: boolean;
    readonly partyId?: string | null;
    readonly projectId?: string | null;
    readonly file: KinDocFile;
  },
) {
  return yield* transaction(
    Effect.gen(function* () {
      const records = yield* KinRecords;
      const { row, created } = yield* records.create(orgId, writer, {
        list: "docs",
        originKey: input.docOrigin,
        title: input.title,
        owner: input.owner,
        ...(input.partyId === undefined ? {} : { partyId: input.partyId }),
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.sensitive ? { sensitive: true } : {}),
      });
      if (listOf(row.registerId) !== "docs") return yield* unavailable;
      const again = yield* retried(orgId, row.recordId, input.originKey);
      if (again !== undefined) return again;
      const now = yield* Clock.currentTimeMillis;
      const current = created ? undefined : yield* versionOf(orgId, row.recordId);
      const version = {
        title: input.title,
        body: "",
        summary: input.summary,
        originKey: input.originKey,
        file: input.file,
      };
      if (current === undefined) {
        yield* insertVersion(orgId, row.recordId, writer, provenance, {
          ...version,
          version: 1,
          kind: "created",
          operations: [{ op: "create" }],
          baseVersion: null,
          now,
        });
        yield* indexRecord(orgId, row.recordId);
        return { ...(yield* settle(orgId, row.recordId)), created: true };
      }
      // A sensitive build makes the whole doc sensitive; a later plain one never unlabels it.
      if (input.sensitive && row.sensitive === 0)
        yield* records.update(orgId, writer, row.key, { sensitive: true });
      return yield* revise(orgId, writer, provenance, row, current, {
        ...version,
        kind: "rewritten",
        operations: [{ op: "rewrite" }],
      });
    }),
  );
});

/** Client, project, owner, label or archive: entry fields, logged, with no new version. */
export const move = Effect.fn("KinDocs.move")(function* (
  orgId: KinOrgId,
  writer: Writer,
  ref: { readonly key: string },
  patch: {
    readonly partyId?: string | null;
    readonly projectId?: string | null;
    readonly owner?: KinWorkPrincipal;
    readonly sensitive?: boolean;
    readonly archived?: boolean;
  },
) {
  return yield* transaction(
    Effect.gen(function* () {
      const records = yield* KinRecords;
      const row = yield* docRow(orgId, ref);
      yield* records.update(orgId, writer, row.key, {
        ...(patch.partyId === undefined ? {} : { partyId: patch.partyId }),
        ...(patch.projectId === undefined ? {} : { projectId: patch.projectId }),
        ...(patch.owner === undefined ? {} : { owner: patch.owner }),
        ...(patch.sensitive === undefined ? {} : { sensitive: patch.sensitive }),
        ...(patch.archived === undefined ? {} : { state: patch.archived ? "dropped" : "open" }),
      });
      return yield* settle(orgId, row.recordId);
    }),
  );
});

/** Links a doc and entries or other docs both ways, so each shows the other. */
export const link = Effect.fn("KinDocs.link")(function* (
  orgId: KinOrgId,
  writer: Writer,
  ref: { readonly key: string },
  targets: ReadonlyArray<string>,
  relation: KinRecordRelation,
) {
  return yield* transaction(
    Effect.gen(function* () {
      const records = yield* KinRecords;
      const row = yield* docRow(orgId, ref);
      const linked: Array<{
        readonly key: string;
        readonly title: string;
        readonly added: boolean;
      }> = [];
      for (const key of targets) {
        const other = yield* records.get(orgId, key);
        if (other === undefined)
          return yield* new KinChatError({
            reason: "not_found",
            message: `No entry or doc ${key.slice(0, 40)}. Nothing was linked.`,
          });
        if (other.recordId === row.recordId)
          return yield* new KinChatError({
            reason: "invalid_state",
            message: "A doc can't link to itself.",
          });
        const there = yield* records.link(orgId, writer, row.recordId, {
          kind: "record",
          target: other.recordId,
          relation,
        });
        const back = yield* records.link(orgId, writer, other.recordId, {
          kind: "record",
          target: row.recordId,
          relation: "relates",
        });
        linked.push({ key: other.key, title: other.title, added: there || back });
      }
      return linked;
    }),
  );
});

export const history = Effect.fn("KinDocs.history")(function* (
  orgId: KinOrgId,
  recordId: string,
  page: { readonly before?: number; readonly limit: number },
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<VersionRow>`${selectVersion(sql)}
    WHERE org_id = ${orgId} AND record_id = ${recordId}
      AND (${page.before ?? null} IS NULL OR version < ${page.before ?? null})
    ORDER BY version DESC LIMIT ${page.limit}`;
  return rows;
});

/** Latest versions of many docs at once, for a list page. */
export const latestOf = Effect.fn("KinDocs.latestOf")(function* (
  orgId: KinOrgId,
  recordIds: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  if (recordIds.length === 0) return new Map<string, VersionRow>();
  const rows = yield* sql<
    VersionRow & { readonly recordId: string }
  >`SELECT v.record_id AS "recordId",
      v.version, v.title, v.body, v.kind, v.summary, v.operations_json AS "operationsJson",
      v.base_version AS "baseVersion", v.restored_from AS "restoredFrom",
      v.actor_kind AS "actorKind", v.actor_id AS "actorId", v.via, v.wakeup_id AS "wakeupId",
      v.chat_id AS "chatId", v.answered_message_id AS "answeredMessageId",
      v.answered_author_kind AS "answeredAuthorKind", v.answered_author_id AS "answeredAuthorId",
      v.audience, v.body_kind AS "bodyKind", v.file_json AS "fileJson", v.created_at AS "createdAt"
    FROM kin_doc_versions v
    WHERE v.org_id = ${orgId} AND v.record_id IN ${sql.in(recordIds)}
      AND v.version = (SELECT MAX(w.version) FROM kin_doc_versions w
        WHERE w.org_id = v.org_id AND w.record_id = v.record_id)
    ORDER BY v.record_id`;
  return new Map(rows.map((row) => [row.recordId, row]));
});
