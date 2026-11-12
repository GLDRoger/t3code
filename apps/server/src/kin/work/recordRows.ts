import {
  EnvironmentId,
  KIN_RECORD_CHANGES_CAP,
  KinAgentId,
  KinChatError,
  KinChatId,
  KinMessageId,
  KinPersonId,
  KinAttachment,
  KinRecordId,
  KinRepeatRule,
  ThreadId,
  type KinFileRef,
  type KinOrgId,
  type KinPayment,
  type KinPartyKind,
  type KinRecord,
  type KinRecordCategory,
  type KinRecordChange,
  type KinRecordDetail,
  type KinRecordLink,
  type KinRecordSide,
  type KinRecordState,
  type KinWorkActor,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { parseFields } from "./lists.ts";
import { isBuiltIn } from "./registers.ts";

/** The plain rows behind `KinRecords`: reads and the shapes they decode into. No writes here. */

export type Principal = KinWorkPrincipal;
export type Actor = KinWorkActor;
export type RecordRow = {
  readonly orgId: string;
  readonly recordId: string;
  readonly registerId: string;
  readonly key: string;
  readonly title: string;
  readonly state: KinRecordState;
  readonly waitingOnKind: "person" | "agent" | null;
  readonly waitingOnId: string | null;
  readonly ownerKind: "person" | "agent";
  readonly ownerId: string;
  readonly side: KinRecordSide;
  /** A Work category, or a client's kind. */
  readonly category: string | null;
  readonly dueAt: number | null;
  readonly dueAllDay: number;
  readonly sensitive: number;
  readonly confirmed: number;
  readonly notes: string;
  readonly rev: number;
  readonly sourceChatId: string | null;
  readonly sourceMessageId: string | null;
  readonly createdByKind: "person" | "agent" | "system";
  readonly createdById: string | null;
  readonly assignedBy: string | null;
  readonly assignedAt: number | null;
  readonly originKey: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt: number | null;
  readonly partyId: string | null;
  readonly projectId: string | null;
  readonly repo: string | null;
  readonly fieldsJson: string;
  readonly working: number;
  readonly pullUrl: string | null;
  readonly partyKey: string | null;
  readonly partyTitle: string | null;
  readonly partyCategory: string | null;
  readonly projectKey: string | null;
  readonly projectTitle: string | null;
  /** Its client, its project or its project's client is labelled sensitive. */
  readonly inheritedSensitive: number;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly dateAt: number | null;
  readonly dateAllDay: number;
  readonly repeatJson: string | null;
  /** Payments not voided, in its own currency. */
  readonly paid: number;
  /** Of `paid`, tax the payer withheld at source rather than paid in. */
  readonly withheld: number;
  /** Its list's entries are paid over time: Invoices, or a list whose definition says so. */
  readonly takesPayments: number;
};

export const unavailable = new KinChatError({
  reason: "unavailable",
  message: "Work is unavailable right now. Try again.",
});
export const notFound = (key: string) =>
  new KinChatError({ reason: "not_found", message: `No entry ${key.slice(0, 40)} in Work.` });

const isChatError = Schema.is(KinChatError);
/** A Work read or write that failed for any reason but a refusal: logged, and "unavailable". */
export const workFailure = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, KinChatError, R> =>
  effect.pipe(
    Effect.tapError((error) =>
      isChatError(error)
        ? Effect.void
        : Effect.logWarning("Kin Work failed", { errorTag: error._tag }),
    ),
    Effect.mapError((error) => (isChatError(error) ? error : unavailable)),
  );
export const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
export const isClosed = (state: KinRecordState) => state === "done" || state === "dropped";
export const principal = (kind: string | null, id: string | null): Principal | null =>
  id === null
    ? null
    : kind === "person"
      ? { _tag: "person", personId: KinPersonId.make(id) }
      : kind === "agent"
        ? { _tag: "agent", agentId: KinAgentId.make(id) }
        : null;
export const principalId = (who: Principal) => (who._tag === "person" ? who.personId : who.agentId);
export const samePrincipal = (left: Principal | null, right: Principal | null) =>
  left === null || right === null
    ? left === right
    : left._tag === right._tag && principalId(left) === principalId(right);
export const actorOf = (kind: string, id: string | null): Actor =>
  kind === "system" ? { _tag: "system" } : (principal(kind, id) ?? { _tag: "system" });

/** Whether `r`'s client, its project or its project's client is labelled sensitive (design 4.9). */
const inheritedSensitive = (sql: SqlClient.SqlClient) => sql`EXISTS (SELECT 1 FROM kin_records s
    WHERE s.org_id = r.org_id AND s.sensitive = 1 AND s.record_id IN (r.party_id, r.project_id,
      (SELECT p.party_id FROM kin_records p WHERE p.org_id = r.org_id AND p.record_id = r.project_id)))`;

/** `r`'s own label or one it inherits: the one definition every sensitivity check uses. */
export const sensitiveNow = (sql: SqlClient.SqlClient) =>
  sql`(r.sensitive = 1 OR ${inheritedSensitive(sql)})`;

/**
 * Whether an entry is sensitive now: its own label, or its client's, project's or project's
 * client's. Reads through the caller's transaction; `undefined` when the org has no such entry.
 */
export const effectivelySensitive = Effect.fn("KinRecords.effectivelySensitive")(function* (
  orgId: KinOrgId,
  recordId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ sensitive: number }>`SELECT ${sensitiveNow(sql)} AS sensitive
    FROM kin_records r WHERE r.org_id = ${orgId} AND r.record_id = ${recordId}`;
  return row === undefined ? undefined : row.sensitive === 1;
});

/** Whether `r`'s list is paid over time, as `registers.ts` reads a definition. */
const takesPayments = (sql: SqlClient.SqlClient) =>
  sql`(r.register_id = 'invoices' OR EXISTS (SELECT 1 FROM kin_registers g
    WHERE g.org_id = r.org_id AND g.register_id = r.register_id AND g.built_in = 0
      AND json_extract(g.definition_json, '$.payments') = 1))`;

/**
 * The columns every read selects, with the derived ones: a running worker, the last PR, the client
 * and project as they are now, and the label they lend it. Joins stay inside the entry's org.
 */
/** An entry's money day: its own date, else when it was added. Filters, groups and Money share it. */
export const moneyDay = (sql: SqlClient.SqlClient) => sql`COALESCE(r.date_at, r.created_at)`;

export const selectRecords = (sql: SqlClient.SqlClient) => sql`
  SELECT r.org_id AS "orgId", r.record_id AS "recordId", r.register_id AS "registerId", r.key,
    r.title, r.state,
    r.waiting_on_kind AS "waitingOnKind", r.waiting_on_id AS "waitingOnId",
    r.owner_kind AS "ownerKind", r.owner_id AS "ownerId", r.side, r.category,
    r.due_at AS "dueAt", r.due_all_day AS "dueAllDay", r.sensitive, r.confirmed, r.notes, r.rev,
    r.source_chat_id AS "sourceChatId", r.source_message_id AS "sourceMessageId",
    r.created_by_kind AS "createdByKind", r.created_by_id AS "createdById",
    r.assigned_by_person_id AS "assignedBy", r.assigned_at AS "assignedAt",
    r.origin_key AS "originKey", r.created_at AS "createdAt", r.updated_at AS "updatedAt",
    r.closed_at AS "closedAt", r.party_id AS "partyId", r.project_id AS "projectId", r.repo,
    r.fields_json AS "fieldsJson",
    r.amount_minor AS "amountMinor", r.currency, r.date_at AS "dateAt",
    r.date_all_day AS "dateAllDay", r.repeat_json AS "repeatJson",
    (SELECT COALESCE(SUM(p.amount_minor), 0) FROM kin_record_payments p
      WHERE p.org_id = r.org_id AND p.record_id = r.record_id AND p.voided_at IS NULL) AS paid,
    (SELECT COALESCE(SUM(p.amount_minor), 0) FROM kin_record_payments p
      WHERE p.org_id = r.org_id AND p.record_id = r.record_id AND p.voided_at IS NULL
        AND p.withheld = 1) AS withheld,
    ${takesPayments(sql)} AS "takesPayments",
    pa.key AS "partyKey", pa.title AS "partyTitle", pa.category AS "partyCategory",
    pj.key AS "projectKey",
    pj.title AS "projectTitle",
    ${inheritedSensitive(sql)} AS "inheritedSensitive",
    EXISTS (SELECT 1 FROM kin_record_links l JOIN kin_workers k
        ON k.org_id = l.org_id AND k.worker_id = l.target
      WHERE l.org_id = r.org_id AND l.record_id = r.record_id AND l.kind = 'worker'
        AND k.ended_at IS NULL) AS working,
    (SELECT l.target FROM kin_record_links l WHERE l.org_id = r.org_id
      AND l.record_id = r.record_id AND l.kind = 'pull_request'
      ORDER BY l.created_at DESC, l.target LIMIT 1) AS "pullUrl"
  FROM kin_records r
  LEFT JOIN kin_records pa ON pa.org_id = r.org_id AND pa.record_id = r.party_id
  LEFT JOIN kin_records pj ON pj.org_id = r.org_id AND pj.record_id = r.project_id`;

export const byKey = Effect.fn("KinRecords.byKey")(function* (orgId: KinOrgId, key: string) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<RecordRow>`${selectRecords(sql)}
    WHERE r.org_id = ${orgId} AND r.key = ${key} ORDER BY r.record_id`;
  return row;
});
export const byId = Effect.fn("KinRecords.byId")(function* (orgId: KinOrgId, recordId: string) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<RecordRow>`${selectRecords(sql)}
    WHERE r.org_id = ${orgId} AND r.record_id = ${recordId} ORDER BY r.record_id`;
  return row;
});

const pullNumber = (url: string) => {
  const found = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url)?.[1];
  return found === undefined ? undefined : Number.parseInt(found, 10);
};

const WORK_CATEGORIES: ReadonlyArray<string> = ["task", "issue", "obligation"];
/** A client's category says whether it is one we sell to or buy from. */
export const partyKind = (category: string | null): KinPartyKind =>
  category === "vendor" ? "vendor" : "client";
const refOf = (recordId: string | null, key: string | null, title: string | null) =>
  recordId === null || key === null || title === null
    ? undefined
    : { recordId: KinRecordId.make(recordId), key, title: title as KinRecord["title"] };

export const toRecord = (row: RecordRow, now: number): KinRecord => {
  const number = row.pullUrl === null ? undefined : pullNumber(row.pullUrl);
  const ref = refOf(row.partyId, row.partyKey, row.partyTitle);
  const party = ref === undefined ? undefined : { ...ref, kind: partyKind(row.partyCategory) };
  const project = refOf(row.projectId, row.projectKey, row.projectTitle);
  return {
    recordId: KinRecordId.make(row.recordId),
    orgId: row.orgId as KinOrgId,
    key: row.key,
    title: row.title as KinRecord["title"],
    state: row.state,
    waitingOn: row.state === "waiting" ? principal(row.waitingOnKind, row.waitingOnId) : null,
    owner: principal(row.ownerKind, row.ownerId) ?? {
      _tag: "agent",
      agentId: KinAgentId.make(row.ownerId),
    },
    category:
      row.category !== null && WORK_CATEGORIES.includes(row.category)
        ? (row.category as KinRecordCategory)
        : null,
    side: row.side,
    dueAt: row.dueAt === null ? null : iso(row.dueAt),
    dueAllDay: row.dueAllDay === 1,
    late: row.dueAt !== null && row.dueAt < now && !isClosed(row.state),
    confirmed: row.confirmed === 1,
    sensitive: row.sensitive === 1,
    working: row.working === 1,
    pullRequest: row.pullUrl === null || number === undefined ? null : { url: row.pullUrl, number },
    rev: row.rev,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    closedAt: row.closedAt === null ? null : iso(row.closedAt),
    ...(party === undefined ? {} : { party }),
    ...(project === undefined ? {} : { project }),
    ...(row.repo === null ? {} : { repo: row.repo }),
    ...(row.inheritedSensitive === 1 ? { sensitiveInherited: true as const } : {}),
    ...moneyOf(row),
  };
};

/** Its amount, own date and repeat; in a defined list, the list, its category and a balance. */
const moneyOf = (row: RecordRow) => {
  const amount = amountOf(row);
  const repeat = repeatOf(row.repeatJson);
  return {
    ...(isBuiltIn(row.registerId) ? {} : { list: row.registerId }),
    ...(row.category === null || isBuiltIn(row.registerId) ? {} : { listCategory: row.category }),
    ...(amount === undefined ? {} : { amount }),
    ...(row.dateAt === null ? {} : { dateAt: iso(row.dateAt), dateAllDay: row.dateAllDay === 1 }),
    ...(repeat === undefined ? {} : { repeat: repeat.rule }),
    ...(amount === undefined || row.takesPayments !== 1
      ? {}
      : {
          balance: { minor: Math.max(amount.minor - row.paid, 0), currency: amount.currency },
          received: { minor: row.paid - row.withheld, currency: amount.currency },
          ...(row.withheld === 0
            ? {}
            : { tdsDeducted: { minor: row.withheld, currency: amount.currency } }),
        }),
  };
};
export const amountOf = (row: RecordRow) =>
  row.amountMinor === null || row.currency === null
    ? undefined
    : { minor: row.amountMinor, currency: row.currency };

/** A repeat rule as stored, with the day of the month each date keeps. */
export const StoredRepeat = Schema.Struct({
  rule: KinRepeatRule,
  dueDay: Schema.optional(Schema.Int),
  dateDay: Schema.optional(Schema.Int),
});
export type StoredRepeat = typeof StoredRepeat.Type;
const RepeatJson = Schema.fromJsonString(StoredRepeat);
const decodeRepeat = Schema.decodeUnknownOption(RepeatJson);
export const encodeRepeat = Schema.encodeEffect(RepeatJson);
export const repeatOf = (json: string | null) =>
  json === null ? undefined : Option.getOrUndefined(decodeRepeat(json));

type ChangeRow = {
  readonly seq: number;
  readonly at: number;
  readonly actorKind: string;
  readonly actorId: string | null;
  readonly via: KinRecordChange["via"];
  readonly kind: KinRecordChange["kind"];
  readonly fieldsJson: string;
};
type LinkRow = {
  readonly kind: KinRecordLink["kind"];
  readonly relation: KinRecordLink["relation"];
  readonly target: string;
  readonly chatId: string | null;
  readonly label: string | null;
  readonly createdAt: number;
  readonly otherId: string | null;
  readonly otherKey: string | null;
  readonly otherTitle: string | null;
  readonly workerId: string | null;
  readonly workerThreadId: string | null;
  readonly workerEnvironmentId: string | null;
  readonly workerEndedAt: number | null;
  readonly workerPullUrl: string | null;
  readonly workerPullNumber: number | null;
};
export type FieldChange = {
  readonly field: string;
  readonly from: string | null;
  readonly to: string | null;
};

export const parseChanges = (json: string): ReadonlyArray<FieldChange> => {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as ReadonlyArray<FieldChange>) : [];
  } catch {
    return [];
  }
};

const changesOf = Effect.fn("KinRecords.changesOf")(function* (
  orgId: KinOrgId,
  recordId: string,
  limit: number = KIN_RECORD_CHANGES_CAP,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<ChangeRow>`SELECT seq, at, actor_kind AS "actorKind",
      actor_id AS "actorId", via, kind, fields_json AS "fieldsJson"
    FROM kin_record_changes WHERE org_id = ${orgId} AND record_id = ${recordId}
    ORDER BY seq DESC LIMIT ${limit}`;
  return rows.map((row): KinRecordChange => ({
    seq: row.seq,
    at: iso(row.at),
    by: actorOf(row.actorKind, row.actorId),
    via: row.via,
    kind: row.kind,
    fields: parseChanges(row.fieldsJson).filter((change) => change.field.trim() !== ""),
  }));
});

const linksOf = Effect.fn("KinRecords.linksOf")(function* (orgId: KinOrgId, recordId: string) {
  const sql = yield* SqlClient.SqlClient;
  // Same-org joins only: the other end is opened by what this host stores, never by the target text.
  const rows = yield* sql<LinkRow>`SELECT l.kind, l.relation, l.target, l.chat_id AS "chatId",
      l.label, l.created_at AS "createdAt",
      o.record_id AS "otherId", o.key AS "otherKey", o.title AS "otherTitle",
      k.worker_id AS "workerId", k.thread_id AS "workerThreadId",
      k.environment_id AS "workerEnvironmentId", k.ended_at AS "workerEndedAt",
      k.pull_request_url AS "workerPullUrl", k.pull_request_number AS "workerPullNumber"
    FROM kin_record_links l
    LEFT JOIN kin_records o ON l.kind = 'record' AND o.org_id = l.org_id AND o.record_id = l.target
    LEFT JOIN kin_workers k ON l.kind = 'worker' AND k.org_id = l.org_id AND k.worker_id = l.target
    WHERE l.org_id = ${orgId} AND l.record_id = ${recordId}
    ORDER BY l.created_at, l.kind, l.target`;
  return rows.map((row): KinRecordLink => ({
    kind: row.kind,
    relation: row.relation,
    target: row.target,
    chatId: row.chatId === null ? null : KinChatId.make(row.chatId),
    label: row.label,
    createdAt: iso(row.createdAt),
    ...(row.otherId === null || row.otherKey === null || row.otherTitle === null
      ? {}
      : {
          record: {
            recordId: KinRecordId.make(row.otherId),
            key: row.otherKey,
            title: row.otherTitle as KinRecord["title"],
          },
        }),
    ...(row.workerId === null
      ? {}
      : {
          worker: {
            threadId: row.workerThreadId === null ? null : ThreadId.make(row.workerThreadId),
            remoteEnvironmentId:
              row.workerEnvironmentId === null ? null : EnvironmentId.make(row.workerEnvironmentId),
            running: row.workerEndedAt === null,
            pullRequest:
              row.workerPullUrl === null || row.workerPullNumber === null
                ? null
                : { url: row.workerPullUrl, number: row.workerPullNumber },
          },
        }),
  }));
});

export const toDetail = Effect.fn("KinRecords.toDetail")(function* (
  row: RecordRow,
  now: number,
  changeLimit?: number,
) {
  const orgId = row.orgId as KinOrgId;
  return {
    ...toRecord(row, now),
    notes: row.notes,
    source: {
      chatId: row.sourceChatId === null ? null : KinChatId.make(row.sourceChatId),
      messageId: row.sourceMessageId === null ? null : KinMessageId.make(row.sourceMessageId),
    },
    assignedBy: principal("person", row.assignedBy),
    assignedAt: row.assignedAt === null ? null : iso(row.assignedAt),
    createdBy: actorOf(row.createdByKind, row.createdById),
    links: yield* linksOf(orgId, row.recordId),
    changes: yield* changesOf(orgId, row.recordId, changeLimit),
    seq: yield* recordSeq(orgId, row.recordId),
    ...(isBuiltIn(row.registerId) ? {} : yield* definedDetail(row)),
  } satisfies KinRecordDetail;
});

const decodeAttachments = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(KinAttachment)),
);
/** A defined list's fields, the files they keep and, where it is paid over time, its payments. */
const definedDetail = Effect.fn("KinRecords.definedDetail")(function* (row: RecordRow) {
  const sql = yield* SqlClient.SqlClient;
  const orgId = row.orgId as KinOrgId;
  const fields = parseFields(row.fieldsJson);
  const ids = [
    ...new Set(
      Object.values(fields).flatMap((value) =>
        Array.isArray(value) ? (value as ReadonlyArray<string>) : [],
      ),
    ),
  ];
  const stored =
    ids.length === 0
      ? []
      : yield* sql<{ id: string; chatId: string; messageId: string; json: string | null }>`
          SELECT a.attachment_id AS id, a.chat_id AS "chatId", a.message_id AS "messageId",
            m.attachments_json AS json
          FROM kin_message_attachments a
          JOIN kin_messages m ON m.org_id = a.org_id AND m.message_id = a.message_id
          WHERE a.org_id = ${orgId} AND a.attachment_id IN ${sql.in(ids)} AND m.status <> 'deleted'
          ORDER BY a.attachment_id`;
  const files = stored.flatMap((file): ReadonlyArray<KinFileRef> => {
    const found = Option.getOrElse(decodeAttachments(file.json ?? "[]"), () => []).find(
      (attachment) => attachment.id === file.id,
    );
    return found === undefined
      ? []
      : [
          {
            attachmentId: file.id,
            name: found.name,
            mimeType: found.mimeType,
            chatId: KinChatId.make(file.chatId),
            messageId: KinMessageId.make(file.messageId),
          },
        ];
  });
  const payments = row.takesPayments === 1 ? yield* paymentsOf(orgId, row.recordId) : undefined;
  return {
    fields,
    ...(files.length === 0 ? {} : { files }),
    ...(payments === undefined ? {} : { payments }),
  };
});

const paymentsOf = Effect.fn("KinRecords.paymentsOf")(function* (
  orgId: KinOrgId,
  recordId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    paymentId: string;
    minor: number;
    currency: string;
    paidOn: string;
    note: string;
    createdAt: number;
    voidedAt: number | null;
    withheld: number;
  }>`SELECT payment_id AS "paymentId", amount_minor AS minor, currency, paid_on AS "paidOn",
      note, created_at AS "createdAt", voided_at AS "voidedAt", withheld
    FROM kin_record_payments WHERE org_id = ${orgId} AND record_id = ${recordId}
    ORDER BY paid_on DESC, created_at DESC, payment_id`;
  const receipts =
    rows.length === 0
      ? []
      : yield* sql<{ payment: string; key: string; number: string | null; doc: string | null }>`
        SELECT json_extract(r.fields_json, '$.payment') AS payment, r.key, n.number,
          (SELECT d.key FROM kin_doc_jobs j
            JOIN kin_doc_versions v ON v.org_id = j.org_id AND v.worker_id = j.worker_id
            JOIN kin_records d ON d.org_id = v.org_id AND d.record_id = v.record_id
            WHERE j.org_id = r.org_id AND j.entry_record_id = r.record_id AND j.recipe = 'receipt'
            ORDER BY j.created_at DESC LIMIT 1) AS doc
        FROM kin_records r
        LEFT JOIN kin_issued_numbers n ON n.org_id = r.org_id AND n.record_id = r.record_id
        WHERE r.org_id = ${orgId} AND r.register_id = 'receipts' AND r.state <> 'dropped'
          AND json_extract(r.fields_json, '$.payment') IN ${sql.in(rows.map((row) => row.paymentId))}
        ORDER BY r.key`;
  const numbers = yield* notedReceiptNumbers(
    orgId,
    rows.map((row) => row.note),
  );
  return rows.map((payment): KinPayment => {
    const receipt = receipts.find((one) => one.payment === payment.paymentId);
    const noted = numbers.get(payment.note);
    return {
      paymentId: payment.paymentId,
      amount: { minor: payment.minor, currency: payment.currency },
      paidOn: payment.paidOn,
      note: payment.note,
      recordedAt: iso(payment.createdAt),
      voidedAt: payment.voidedAt === null ? null : iso(payment.voidedAt),
      ...(payment.withheld === 1 ? { withheld: true as const } : {}),
      receipt:
        receipt === undefined && noted === undefined
          ? null
          : {
              key: receipt?.key ?? null,
              number: receipt?.number ?? noted ?? null,
              receivedOn: payment.paidOn,
              amount: { minor: payment.minor, currency: payment.currency },
              document: receipt?.doc ?? null,
            },
    };
  });
});

/** `QST-RN/2026-27/001`: a receipt number another system issued, written in a payment's note. */
const RECEIPT_IN_NOTE =
  /(?<![A-Za-z0-9/-])([A-Za-z][A-Za-z0-9-]{0,7}\/(?:\d{2})?\d{2}-\d{2}\/\d{1,9})(?![A-Za-z0-9/-])/g;
/** Every number in a note shaped like a receipt number, in order. */
export const receiptNumbersIn = (note: string) =>
  [...note.matchAll(RECEIPT_IN_NOTE)].map((found) => found[1]!);
/**
 * The receipt number each payment note holds, such as "Advance received; receipt note
 * QST-RN/2026-27/001": its first number of that shape that isn't a number of an entry in another
 * list, such as the invoice's own. Notes with none aren't in the map.
 */
export const notedReceiptNumbers = Effect.fn("KinRecords.notedReceiptNumbers")(function* (
  orgId: KinOrgId,
  notes: ReadonlyArray<string>,
) {
  const found = new Map(notes.map((note) => [note, receiptNumbersIn(note)] as const));
  const shaped = [...new Set([...found.values()].flat())];
  const noted = new Map<string, string>();
  if (shaped.length === 0) return noted;
  const sql = yield* SqlClient.SqlClient;
  const other = new Set(
    (yield* sql<{ number: string }>`SELECT number FROM kin_issued_numbers
      WHERE org_id = ${orgId} AND register_id <> 'receipts' AND number IN ${sql.in(shaped)}`).map(
      (row) => row.number,
    ),
  );
  for (const [note, numbers] of found) {
    const number = numbers.find((one) => !other.has(one));
    if (number !== undefined) noted.set(note, number);
  }
  return noted;
});

export const recordSeq = Effect.fn("KinRecords.recordSeq")(function* (
  orgId: KinOrgId,
  recordId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ seq: number | null }>`SELECT MAX(seq) AS seq FROM kin_record_changes
    WHERE org_id = ${orgId} AND record_id = ${recordId}`;
  return row?.seq ?? 0;
});

/** The latest change number in an org, which clients and cursors compare against. */
export const latestSeq = Effect.fn("KinRecords.latestSeq")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ seq: number | null }>`SELECT MAX(seq) AS seq FROM kin_record_changes
    WHERE org_id = ${orgId}`;
  return row?.seq ?? 0;
});

/** The owner's IANA zone, for all-day due dates; UTC when unset. */
export const ownerZone = Effect.fn("KinRecords.ownerZone")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ zone: string | null }>`SELECT time_zone AS zone
    FROM kin_trigger_settings WHERE org_id = ${orgId} ORDER BY org_id`.pipe(
    Effect.orElseSucceed(() => []),
  );
  const zone = row?.zone ?? "UTC";
  return validZone(zone) ? zone : "UTC";
});
const validZone = (zone: string) => {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone !== "";
  } catch {
    return false;
  }
};

const dayStart = (day: string, zone: string) => {
  const [year, month, date] = day.split("-").map((part) => Number.parseInt(part, 10));
  return DateTime.makeZonedUnsafe(
    { year: year ?? 1970, month: month ?? 1, day: date ?? 1 },
    { timeZone: zone, adjustForTimeZone: true },
  );
};
/** A calendar day's last millisecond in `zone`: an all-day entry is late only once it is over. */
export const endOfDay = (day: string, zone: string) =>
  DateTime.toEpochMillis(DateTime.add(dayStart(day, zone), { days: 1 })) - 1;
/** A calendar day's first millisecond in `zone`. */
export const startOfDay = (day: string, zone: string) =>
  DateTime.toEpochMillis(dayStart(day, zone));
