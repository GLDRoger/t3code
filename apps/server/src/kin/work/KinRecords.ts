// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@t3tools/shared/relaySigning";
import {
  KIN_RECORDS_PAGE_CAP,
  KinChatError,
  type KinAgentId,
  type KinChatId,
  type KinMessageId,
  type KinMoney,
  type KinRepeatRule,
  type KinOrgId,
  KinPersonId,
  type KinRecordChangeVia,
  type KinRecordLinkKind,
  type KinRecordRelation,
  type KinRecordSide,
  type KinRecordState,
  type KinWorkPrincipal,
  type KinWorkerId,
  KinRecordId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Statement from "effect/sql/Statement";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";

import { hashedEventId } from "../lead/eventIds.ts";
import { KinEventQueue } from "../lead/KinEventQueue.ts";
import { mentionsMoney } from "../memory/sensitivity.ts";
import { indexRecord } from "./searchIndex.ts";
import { SensitiveRefusal, withdrawAttempts } from "./workerAttempts.ts";
import {
  checkFor,
  encodeFieldValues,
  type FieldValue,
  LISTS,
  type ListName,
  parseFields,
  shownField,
} from "./lists.ts";
import { addUp, dayIn, financialYearOf, formatMoney, isCurrency, monthOf } from "./money.ts";
import {
  amountOf,
  byId,
  byKey,
  effectivelySensitive,
  encodeRepeat,
  type FieldChange,
  type Principal,
  isClosed,
  latestSeq,
  moneyDay,
  notFound,
  ownerZone,
  principal,
  principalId,
  type RecordRow,
  repeatOf,
  samePrincipal,
  selectRecords,
  sensitiveNow,
  type StoredRepeat,
  toDetail,
  toRecord,
  unavailable,
} from "./recordRows.ts";
import {
  checkFields,
  isBuiltIn,
  numberingOf,
  type ListDef,
  listDef,
  owedState,
  owesIn,
  stateLabel,
  unknownList,
  verifyRefs,
} from "./registers.ts";
import { anchorOf, nextDates } from "./repeat.ts";

/** Who is writing and how: a lead in its turn, the owner from a client, or Kin from an event. */
export type Writer = {
  readonly actor:
    | { readonly _tag: "agent"; readonly agentId: KinAgentId }
    | { readonly _tag: "person"; readonly personId: KinPersonId }
    | { readonly _tag: "system" };
  readonly via: KinRecordChangeVia;
  readonly wakeupId?: string;
  readonly chatId?: KinChatId;
  /** The human who asked for this, from stored rows: becomes the assigner of work given away. */
  readonly askedBy?: KinPersonId | null;
};

export type Fields = {
  readonly title: string;
  readonly state?: KinRecordState;
  readonly waitingOn?: KinWorkPrincipal | null;
  readonly owner: KinWorkPrincipal;
  /** A Work category, or a client's kind (`client`, `vendor`). */
  readonly category?: string | null;
  readonly side?: KinRecordSide;
  readonly dueAt?: number | null;
  readonly dueAllDay?: boolean;
  readonly notes?: string;
  readonly confirmed?: boolean;
  /** Raised by anyone; lowered only by a person, which the owner-only callers make the owner. */
  readonly sensitive?: boolean;
  /** Record ids of a client and a project in this org. */
  readonly partyId?: string | null;
  readonly projectId?: string | null;
  readonly repo?: string | null;
  /** The list's own fields; `null` removes one. */
  readonly fields?: Readonly<Record<string, FieldValue | null>>;
  /** Integer minor units in an ISO currency; only lists with an amount, and Work. */
  readonly amount?: KinMoney | null;
  /** When it happened, was issued or starts; only defined lists. */
  readonly dateAt?: number | null;
  readonly dateAllDay?: boolean;
  /** Needs a due date or a date to repeat from; not on clients, contacts or projects. */
  readonly repeat?: KinRepeatRule | null;
};
export type CreateInput = Fields & {
  /** Default `work`; a built-in list or one defined in this org. */
  readonly list?: string;
  /** A create with a key already stored returns that entry and changes nothing. */
  readonly originKey: string;
  /** A person's request (`requestHashOf`): the same key asking for something else is refused. */
  readonly requestHash?: string;
  readonly source?: { readonly chatId: KinChatId; readonly messageId: KinMessageId };
  readonly links?: ReadonlyArray<LinkInput>;
  /** When an import says it was made, and closed if it is; otherwise now. */
  readonly createdAt?: number;
  readonly closedAt?: number;
};
export type Patch = Partial<Omit<Fields, "owner">> & { readonly owner?: KinWorkPrincipal };
export type LinkInput = {
  readonly kind: KinRecordLinkKind;
  readonly target: string;
  readonly relation: KinRecordRelation;
  readonly chatId?: KinChatId | null;
  readonly label?: string | null;
};
export type QueryInput = {
  /** Default `work`. */
  readonly list?: string;
  /** `null`: entries with no client. */
  readonly partyId?: string | null;
  readonly projectId?: string;
  readonly repo?: string;
  readonly owner?: KinWorkPrincipal;
  readonly states?: ReadonlyArray<KinRecordState>;
  readonly open?: boolean;
  readonly late?: boolean;
  readonly dueBy?: number;
  readonly dueAfter?: number;
  /** Its own date, or the time it was added when it has none, in `[dateFrom, dateTo)`. */
  readonly dateFrom?: number;
  readonly dateTo?: number;
  /** A payment that still counts was received on a day in `[paidFrom, paidTo]`. */
  readonly paidFrom?: string;
  readonly paidTo?: string;
  readonly text?: string;
  readonly keys?: ReadonlyArray<string>;
  /** `null`: entries with no category. */
  readonly category?: string | null;
  readonly side?: KinRecordSide;
  readonly offset?: number;
  readonly limit?: number;
  /** The time `late` is judged at; a later page passes the first page's so offsets hold. */
  readonly at?: number;
};

/** An entry the owner closed or took from a lead while it held it open, after that commits. */
export type Withdrawal = {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly recordId: string;
  readonly key: string;
  readonly seq: number;
  /** The lead's worker attempts open on the entry when it was withdrawn: the stop's whole reach. */
  readonly workers: ReadonlyArray<{ readonly workerId: KinWorkerId; readonly startedAt: number }>;
};

const isChatError = Schema.is(KinChatError);
const encodeFields = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        field: Schema.String,
        from: Schema.NullOr(Schema.String),
        to: Schema.NullOr(Schema.String),
      }),
    ),
  ),
);
export type GroupBy = "party" | "project" | "side" | "owner" | "state" | "category";
export type TotalsBy = GroupBy | "month" | "financialYear";
/** Past this many entries with an amount, totals ask for a narrower filter instead of guessing. */
const TOTALS_CAP = 20_000;
type Sums = {
  readonly total: ReadonlyArray<KinMoney>;
  /** In a list paid over time: what its open entries still have unpaid. */
  readonly owed?: ReadonlyArray<KinMoney>;
  /** With a paid window: the payments made in it. */
  readonly received?: ReadonlyArray<KinMoney>;
};
export type Totals = Sums & {
  readonly counted: number;
  readonly groups?: ReadonlyArray<Sums & { readonly group: string | null; readonly count: number }>;
};
export type PaymentInput = {
  readonly amount: KinMoney;
  /** A day in the owner's zone. */
  readonly paidOn: string;
  readonly note?: string;
  /** Tax the payer withheld at source: it settles the invoice but is no money received. */
  readonly withheld?: boolean;
  /** A retry with the same key records nothing more; one whose payment was voided is refused. */
  readonly originKey: string;
};
const CLOSED = ["done", "dropped"] as const;
/** A retry whose first result was taken back since: answering it with that result would lie. */
const undoneRetry = (what: string) =>
  new KinChatError({
    reason: "conflict",
    message: `That retry key's ${what} was taken back since, so a retry can't stand for it. Record it again as a new one.`,
  });
const conflict = (key: string, rev: number) =>
  new KinChatError({
    reason: "conflict",
    message: `${key} changed since you read it; it is at revision ${rev} now. Read it again.`,
  });
/** What a person's create asked for, without the id it was sent under. */
export const requestHashOf = ({ clientRequestId: _, ...request }: { clientRequestId: string }) =>
  NodeCrypto.createHash("sha256").update(stableStringify(request)).digest("hex");
const recordIdFor = (orgId: string, originKey: string) =>
  KinRecordId.make(
    `rec_${NodeCrypto.createHash("sha256").update(`${orgId.length}:${orgId}${originKey}`).digest("hex").slice(0, 24)}`,
  );
const shown = (value: string | number | boolean | null | undefined) =>
  value === null || value === undefined ? null : String(value);
const shownPrincipal = (who: KinWorkPrincipal | null | undefined) =>
  who === null || who === undefined ? null : `${who._tag}:${principalId(who)}`;
const shownDue = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(ms));
const shownAmount = (money: KinMoney | null | undefined) =>
  money === null || money === undefined ? null : formatMoney(money);
const shownRepeat = (rule: KinRepeatRule | null | undefined) =>
  rule === null || rule === undefined
    ? null
    : rule.every === "days"
      ? `every ${rule.days} days`
      : `every ${rule.every}`;
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const NUMBERS_ARE_ISSUED =
  "Kin gives this list's entries their numbers when they are issued, so nothing else sets one. Issue the entry instead; an invoice numbered elsewhere keeps that number in its notes.";
const actorIdOf = (writer: Writer) =>
  writer.actor._tag === "agent"
    ? writer.actor.agentId
    : writer.actor._tag === "person"
      ? writer.actor.personId
      : null;
const paymentIdFor = (orgId: string, originKey: string) =>
  `pay_${NodeCrypto.createHash("sha256").update(`${orgId.length}:${orgId}${originKey}`).digest("hex").slice(0, 20)}`;

/** What a write may set on a list: its states, kinds, fields, and an amount, date or repeat. */
const checkInput = (
  def: ListDef,
  input: {
    readonly title?: string | undefined;
    readonly state?: KinRecordState | undefined;
    readonly category?: string | null | undefined;
    readonly fields?: Readonly<Record<string, FieldValue | null>> | undefined;
    readonly amount?: KinMoney | null | undefined;
    readonly dateAt?: number | null | undefined;
    readonly repeat?: KinRepeatRule | null | undefined;
  },
): KinChatError | undefined => {
  if (input.title !== undefined && mentionsMoney(input.title))
    return invalid(
      "A title never holds an amount: give the amount on its own and keep the title to what it was for.",
    );
  if (input.amount !== undefined && input.amount !== null) {
    if (!def.amount && def.builtIn !== "work") return invalid(`A ${def.noun} has no amount.`);
    if (!isCurrency(input.amount.currency))
      return invalid(`${input.amount.currency} is not a currency code.`);
  }
  if (input.dateAt !== undefined && input.dateAt !== null && def.builtIn !== null)
    return invalid(`A ${def.noun} has no date of its own; use due.`);
  if (
    input.repeat !== undefined &&
    input.repeat !== null &&
    def.builtIn !== null &&
    def.builtIn !== "work"
  )
    return invalid(`A ${def.noun} doesn't repeat.`);
  if (def.builtIn !== null) return checkFor(def.builtIn, input);
  if (input.state !== undefined && !def.states.includes(input.state))
    return invalid(
      `${def.name} entries are ${def.states.join(", ")}; ${input.state} is not one of them.`,
    );
  if (
    input.category !== undefined &&
    input.category !== null &&
    !def.categories.includes(input.category)
  )
    return invalid(
      def.categories.length === 0
        ? `${def.name} has no categories.`
        : `${def.name}'s categories are ${def.categories.join(", ")}.`,
    );
  return input.fields === undefined ? undefined : checkFields(def, input.fields);
};

export class KinRecords extends Context.Service<
  KinRecords,
  {
    readonly create: (
      orgId: KinOrgId,
      writer: Writer,
      input: CreateInput,
    ) => Effect.Effect<{ readonly row: RecordRow; readonly created: boolean }, KinChatError>;
    readonly update: (
      orgId: KinOrgId,
      writer: Writer,
      key: string,
      patch: Patch,
      expectedRev?: number,
      /** Logged with the change even when no column changes: a doc's new version. */
      also?: ReadonlyArray<FieldChange>,
    ) => Effect.Effect<RecordRow, KinChatError>;
    readonly link: (
      orgId: KinOrgId,
      writer: Writer,
      recordId: string,
      link: LinkInput,
    ) => Effect.Effect<boolean, KinChatError>;
    /** Money paid against an entry paid over time; in full, it is marked paid. Never more than owed. */
    readonly pay: (
      orgId: KinOrgId,
      writer: Writer,
      key: string,
      payment: PaymentInput,
    ) => Effect.Effect<{ readonly row: RecordRow; readonly paymentId: string }, KinChatError>;
    /** Takes a payment back; an entry it leaves short is owed again. */
    readonly voidPayment: (
      orgId: KinOrgId,
      writer: Writer,
      key: string,
      paymentId: string,
    ) => Effect.Effect<RecordRow, KinChatError>;
    /** Exact sums of the amounts `query`'s filter matches, per currency, and per group if asked. */
    readonly totals: (
      orgId: KinOrgId,
      input: QueryInput,
      by?: TotalsBy,
      /** Count entries with no amount too, as a list without amounts needs. */
      everyEntry?: boolean,
    ) => Effect.Effect<Totals, KinChatError>;
    readonly query: (
      orgId: KinOrgId,
      input: QueryInput,
    ) => Effect.Effect<
      { readonly rows: ReadonlyArray<RecordRow>; readonly total: number; readonly seq: number },
      KinChatError
    >;
    /** Counts per group over the same filter as `query`, most first, at most 50 groups. */
    readonly groups: (
      orgId: KinOrgId,
      input: QueryInput,
      by: GroupBy,
    ) => Effect.Effect<
      ReadonlyArray<{
        readonly group: string | null;
        readonly count: number;
        readonly late: number;
      }>,
      KinChatError
    >;
    readonly get: (
      orgId: KinOrgId,
      key: string,
    ) => Effect.Effect<RecordRow | undefined, KinChatError>;
    readonly getById: (
      orgId: KinOrgId,
      recordId: string,
    ) => Effect.Effect<RecordRow | undefined, KinChatError>;
    readonly detail: (
      row: RecordRow,
      changeLimit?: number,
    ) => Effect.Effect<Effect.Success<ReturnType<typeof toDetail>>, KinChatError>;
    readonly seq: (orgId: KinOrgId) => Effect.Effect<number, KinChatError>;
    /** The latest change number now, then again with the entry after every committed change. */
    readonly changes: (
      orgId: KinOrgId,
    ) => Stream.Stream<{ readonly seq: number; readonly key?: string }, KinChatError>;
    /** The lead runtime stops a withdrawn entry's workers; the WS side has no thread services. */
    readonly attachWithdrawals: (
      onWithdrawn: (withdrawal: Withdrawal) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/kin/work/KinRecords") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const queue = yield* KinEventQueue;
  const ticks = yield* PubSub.unbounded<{
    readonly orgId: KinOrgId;
    readonly seq: number;
    readonly key: string;
  }>();
  const provideSql = Effect.provideService(SqlClient.SqlClient, sql);
  let onWithdrawn: ((withdrawal: Withdrawal) => Effect.Effect<void>) | undefined;

  const failed = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapError((error) =>
        isChatError(error)
          ? Effect.void
          : Effect.logWarning("Kin Work failed", {
              errorTag: error._tag,
              ...(isSqlError(error) ? { message: error.message } : {}),
            }),
      ),
      Effect.mapError((error) => (isChatError(error) ? error : unavailable)),
    );
  const transaction = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
    failed(sql.withTransaction(effect));

  const ensureRegister = Effect.fn("KinRecords.ensureRegister")(function* (
    orgId: KinOrgId,
    def: ListDef,
    now: number,
  ) {
    // A defined list's register is written when it is defined; a built-in one on first use.
    if (def.builtIn !== null)
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
        VALUES (${orgId}, ${def.id}, ${def.name}, ${def.prefix}, 1, ${now})
        ON CONFLICT DO NOTHING`;
    const [register] = yield* sql<{ next: number; prefix: string }>`
      UPDATE kin_registers SET next_number = next_number + 1
      WHERE org_id = ${orgId} AND register_id = ${def.id}
      RETURNING next_number - 1 AS next, key_prefix AS prefix`;
    if (register === undefined) return yield* unavailable;
    return `${register.prefix}-${register.next}`;
  });

  const logChange = Effect.fn("KinRecords.logChange")(function* (
    orgId: KinOrgId,
    writer: Writer,
    row: { readonly recordId: string; readonly key: string; readonly rev: number },
    kind: "created" | "updated" | "linked",
    fields: ReadonlyArray<FieldChange>,
    now: number,
  ) {
    const actorId =
      writer.actor._tag === "agent"
        ? writer.actor.agentId
        : writer.actor._tag === "person"
          ? writer.actor.personId
          : null;
    const [change] = yield* sql<{ seq: number }>`INSERT INTO kin_record_changes (org_id, record_id,
        rev, at, actor_kind, actor_id, via, kind, fields_json, wakeup_id, chat_id)
      VALUES (${orgId}, ${row.recordId}, ${row.rev}, ${now}, ${writer.actor._tag}, ${actorId},
        ${writer.via}, ${kind}, ${yield* encodeFields(fields)}, ${writer.wakeupId ?? null},
        ${writer.chatId ?? null})
      RETURNING seq`;
    const seq = change?.seq ?? 0;
    yield* sql.afterCommit(PubSub.publish(ticks, { orgId, seq, key: row.key }));
    return seq;
  });

  /**
   * Wakes a lead about an entry someone else changed, with that human as the turn's provenance:
   * given to it (`assigned`, by the stored assigner), or closed or taken back while it held it
   * open (`withdrawn`, by the person who did). Slice 1 wakes only for the lead's owner; any other
   * change is recorded and waits.
   */
  const wakeLead = Effect.fn("KinRecords.wakeLead")(function* (
    orgId: KinOrgId,
    writer: Writer,
    row: { readonly recordId: string; readonly key: string; readonly registerId: string },
    to: KinWorkPrincipal,
    assignedBy: KinPersonId | null,
    seq: number,
    now: number,
    reason: "assigned" | "withdrawn" = "assigned",
  ) {
    // Looking after a client or leading a project is not an instruction to do anything.
    if (row.registerId !== "work") return false;
    if (to._tag !== "agent") return false;
    if (writer.actor._tag === "agent" && writer.actor.agentId === to.agentId) return false;
    if (assignedBy === null) return false;
    const [lead] = yield* sql<{ memberId: string; ownerPersonId: string }>`
      SELECT m.member_id AS "memberId", a.owner_person_id AS "ownerPersonId"
      FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      JOIN kin_chat_members m ON m.org_id = l.org_id AND m.chat_id = l.owner_chat_id
        AND m.principal_kind = 'person' AND m.person_id = a.owner_person_id AND m.left_at IS NULL
      WHERE l.org_id = ${orgId} AND l.agent_id = ${to.agentId} AND a.retired_at IS NULL
      ORDER BY m.member_id LIMIT 1`;
    // Only the lead's owner is an assigner this slice wakes for; a teammate's waits for slice 2.
    if (lead === undefined || lead.ownerPersonId !== assignedBy) return false;
    const key = `record-${reason}:${row.recordId}:${seq}`;
    return yield* queue
      .enqueue({
        _tag: "record.changed",
        orgId,
        agentId: to.agentId,
        eventId: hashedEventId("record", `${orgId.length}:${orgId}${key}`),
        receivedAt: DateTime.makeUnsafe(now),
        dedupeKey: key,
        provenance: {
          _tag: "human",
          personId: assignedBy as KinPersonId,
          memberId: lead.memberId as never,
        },
        recordId: KinRecordId.make(row.recordId),
        key: row.key,
        seq,
        reason,
      })
      .pipe(
        Effect.as(true),
        Effect.catchTags({
          KinEventQueueRetiredAgent: () => Effect.succeed(false),
          KinEventQueueUnknownAgent: () => Effect.succeed(false),
        }),
      );
  });

  const ownerExists = Effect.fn("KinRecords.ownerExists")(function* (
    orgId: KinOrgId,
    who: KinWorkPrincipal,
    role = "to own it",
  ) {
    const rows =
      who._tag === "agent"
        ? yield* sql`SELECT 1 FROM kin_leads l JOIN kin_agents a
            ON a.org_id = l.org_id AND a.agent_id = l.agent_id
            WHERE l.org_id = ${orgId} AND l.agent_id = ${who.agentId} AND a.retired_at IS NULL`
        : yield* sql`SELECT 1 FROM kin_people WHERE org_id = ${orgId} AND person_id = ${who.personId}`;
    if (rows.length === 0)
      return yield* new KinChatError({
        reason: "not_found",
        message: `No ${who._tag === "agent" ? "agent" : "person"} ${principalId(who).slice(0, 60)} here ${role}.`,
      });
  });

  const insertLink = Effect.fn("KinRecords.insertLink")(function* (
    orgId: KinOrgId,
    recordId: string,
    link: LinkInput,
    now: number,
  ) {
    const inserted = yield* sql`INSERT INTO kin_record_links (org_id, record_id, kind, target,
        relation, chat_id, label, created_at)
      VALUES (${orgId}, ${recordId}, ${link.kind}, ${link.target}, ${link.relation},
        ${link.chatId ?? null}, ${link.label ?? null}, ${now})
      ON CONFLICT DO NOTHING RETURNING target`;
    return inserted.length > 0;
  });

  /** A client or project this entry may point at: in this org, in that list. */
  const target = Effect.fn("KinRecords.target")(function* (
    orgId: KinOrgId,
    recordId: string,
    list: "clients" | "projects",
  ) {
    const [row] = yield* sql<{ key: string; partyId: string | null; state: KinRecordState }>`
      SELECT key, party_id AS "partyId", state FROM kin_records
      WHERE org_id = ${orgId} AND record_id = ${recordId} AND register_id = ${list}`;
    if (row === undefined)
      return yield* new KinChatError({
        reason: "not_found",
        message: `No ${LISTS[list].noun} ${recordId.slice(0, 40)} here.`,
      });
    return row;
  });

  /** Which of client and project a list may carry, and that a contact has its client. */
  const checkRefs = (
    def: ListDef,
    partyId: string | null,
    projectId: string | null,
  ): KinChatError | undefined =>
    def.builtIn === null ? undefined : builtInRefs(def.builtIn, partyId, projectId);
  const builtInRefs = (
    list: ListName,
    partyId: string | null,
    projectId: string | null,
  ): KinChatError | undefined =>
    list === "clients" && (partyId !== null || projectId !== null)
      ? new KinChatError({ reason: "invalid_state", message: "A client has no client or project." })
      : list === "contacts" && partyId === null
        ? new KinChatError({ reason: "invalid_state", message: "A contact needs its client." })
        : list !== "work" && list !== "docs" && projectId !== null
          ? new KinChatError({
              reason: "invalid_state",
              message: `A ${LISTS[list].noun} has no project.`,
            })
          : undefined;

  /** One active client, project, or contact of a client, per name: a second is a mistake. */
  const sameName = Effect.fn("KinRecords.sameName")(function* (
    orgId: KinOrgId,
    list: string,
    title: string,
    partyId: string | null,
    except: string | null,
  ) {
    if (list === "work" || list === "docs" || !isBuiltIn(list)) return;
    const [row] = yield* sql<{ key: string; sensitive: number }>`SELECT r.key,
        ${sensitiveNow(sql)} AS sensitive FROM kin_records r
      WHERE r.org_id = ${orgId} AND r.register_id = ${list} AND r.state NOT IN ${sql.in(CLOSED)}
        AND lower(r.title) = lower(${title}) AND r.record_id IS NOT ${except}
        AND (${list} != 'contacts' OR r.party_id IS ${partyId})
      ORDER BY r.key LIMIT 1`;
    if (row !== undefined) {
      const error = {
        reason: "conflict" as const,
        message: `There is already a ${LISTS[list].noun} named ${title.slice(0, 80)}: ${row.key}.`,
      };
      return yield* row.sensitive === 1 ? new SensitiveRefusal(error) : new KinChatError(error);
    }
  });

  const resolveList = Effect.fn("KinRecords.resolveList")(function* (orgId: KinOrgId, id: string) {
    const def = yield* listDef(orgId, id).pipe(provideSql);
    if (def === undefined) return yield* unknownList(id);
    return def;
  });

  /** A repeat rule with the days of the month its dates keep, or a refusal if it has no date. */
  const storedRepeat = Effect.fn("KinRecords.storedRepeat")(function* (
    orgId: KinOrgId,
    rule: KinRepeatRule,
    dueAt: number | null,
    dateAt: number | null,
  ) {
    if (dueAt === null && dateAt === null)
      return yield* invalid("A repeating entry needs a due date or a date to repeat from.");
    const zone = yield* ownerZone(orgId).pipe(provideSql);
    const dueDay = rule.every === "days" ? undefined : anchorOf(dueAt, zone);
    const dateDay = rule.every === "days" ? undefined : anchorOf(dateAt, zone);
    return {
      rule,
      ...(dueDay === undefined ? {} : { dueDay }),
      ...(dateDay === undefined ? {} : { dateDay }),
    } satisfies StoredRepeat;
  });

  /**
   * One new entry, in the caller's transaction. `wake` is false for the next occurrence of a
   * repeating entry, which is owed later and is nobody's new instruction.
   */
  const insert = Effect.fn("KinRecords.insert")(function* (
    orgId: KinOrgId,
    writer: Writer,
    input: CreateInput,
    options: { readonly wake: boolean; readonly repeat?: StoredRepeat },
  ) {
    const recordId = recordIdFor(orgId, input.originKey);
    const existing = yield* byId(orgId, recordId).pipe(provideSql);
    if (existing !== undefined) {
      const [stored] = yield* sql<{ hash: string | null }>`SELECT request_hash AS hash
        FROM kin_records WHERE org_id = ${orgId} AND record_id = ${recordId}`;
      if (
        input.requestHash !== undefined &&
        stored?.hash != null &&
        stored.hash !== input.requestHash
      )
        return yield* new KinChatError({
          reason: "not_allowed",
          message: "That retry key already created a different entry.",
        });
      return { row: existing, created: false };
    }
    const def = yield* resolveList(orgId, input.list ?? "work");
    if (def.archivedAt !== null)
      return yield* invalid(`${def.name} is archived; the owner can restore it.`);
    const list = def.id;
    const fields = Object.fromEntries(
      Object.entries(input.fields ?? {}).filter(
        (entry): entry is [string, FieldValue] => entry[1] !== null,
      ),
    );
    const invalidFor = checkInput(def, {
      title: input.title,
      state: input.state,
      category: input.category,
      fields,
      amount: input.amount,
      dateAt: input.dateAt,
      repeat: input.repeat,
    });
    if (invalidFor !== undefined) return yield* invalidFor;
    if (writer.actor._tag !== "person" && numberingOf(def) !== undefined && "number" in fields)
      return yield* invalid(NUMBERS_ARE_ISSUED);
    if (def.builtIn === null) yield* verifyRefs(orgId, def, fields).pipe(provideSql);
    const projectId = input.projectId ?? null;
    const project = projectId === null ? undefined : yield* target(orgId, projectId, "projects");
    // An entry in a client's project is part of that client's record unless it names another.
    const partyId = input.partyId !== undefined ? input.partyId : (project?.partyId ?? null);
    const invalidRefs = checkRefs(def, partyId, projectId);
    if (invalidRefs !== undefined) return yield* invalidRefs;
    const party = partyId === null ? undefined : yield* target(orgId, partyId, "clients");
    yield* sameName(orgId, list, input.title, partyId, null);
    yield* ownerExists(orgId, input.owner);
    const repeat =
      options.repeat ??
      (input.repeat === undefined || input.repeat === null
        ? undefined
        : yield* storedRepeat(orgId, input.repeat, input.dueAt ?? null, input.dateAt ?? null));
    const now = yield* Clock.currentTimeMillis;
    const key = yield* ensureRegister(orgId, def, now);
    const state = input.state ?? def.defaultState;
    const waitingOn = state === "waiting" ? (input.waitingOn ?? null) : null;
    const givenAway =
      !(writer.actor._tag === "agent" && samePrincipal(writer.actor, input.owner)) &&
      !(writer.actor._tag === "person" && samePrincipal(writer.actor, input.owner));
    const assignedBy = writer.askedBy ?? null;
    const amount = input.amount ?? null;
    yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state,
        waiting_on_kind, waiting_on_id, owner_kind, owner_id, side, category, due_at, due_all_day,
        sensitive, confirmed, notes, rev, source_chat_id, source_message_id, created_by_kind,
        created_by_id, assigned_by_person_id, assigned_at, origin_key, created_at, updated_at,
        closed_at, party_id, project_id, repo, fields_json, amount_minor, currency, date_at,
        date_all_day, repeat_json, request_hash)
      VALUES (${orgId}, ${recordId}, ${list}, ${key}, ${input.title}, ${state},
        ${waitingOn?._tag ?? null}, ${waitingOn === null ? null : principalId(waitingOn)},
        ${input.owner._tag}, ${principalId(input.owner)}, ${input.side ?? "ours"},
        ${input.category ?? null}, ${input.dueAt ?? null}, ${input.dueAllDay === true ? 1 : 0},
        ${input.sensitive === true || def.sensitive ? 1 : 0}, ${input.confirmed === false ? 0 : 1},
        ${input.notes ?? ""}, 1, ${input.source?.chatId ?? null},
        ${input.source?.messageId ?? null}, ${writer.actor._tag},
        ${writer.actor._tag === "agent" ? writer.actor.agentId : writer.actor._tag === "person" ? writer.actor.personId : null},
        ${assignedBy}, ${assignedBy === null ? null : now}, ${input.originKey},
        ${input.createdAt ?? now}, ${now}, ${isClosed(state) ? (input.closedAt ?? now) : null},
        ${partyId}, ${projectId}, ${input.repo ?? null},
        ${yield* encodeFieldValues(fields)}, ${amount?.minor ?? null}, ${amount?.currency ?? null},
        ${input.dateAt ?? null}, ${input.dateAllDay === true ? 1 : 0},
        ${repeat === undefined ? null : yield* encodeRepeat(repeat)}, ${input.requestHash ?? null})`;
    const changes: Array<FieldChange> = [
      { field: "title", from: null, to: input.title },
      { field: "state", from: null, to: state },
      { field: "owner", from: null, to: shownPrincipal(input.owner) },
      ...(input.dueAt === undefined || input.dueAt === null
        ? []
        : [{ field: "due", from: null, to: shownDue(input.dueAt) }]),
      ...(input.dateAt === undefined || input.dateAt === null
        ? []
        : [{ field: "date", from: null, to: shownDue(input.dateAt) }]),
      ...(amount === null ? [] : [{ field: "amount", from: null, to: shownAmount(amount) }]),
      ...(repeat === undefined
        ? []
        : [{ field: "repeat", from: null, to: shownRepeat(repeat.rule) }]),
      ...(waitingOn === null
        ? []
        : [{ field: "waitingOn", from: null, to: shownPrincipal(waitingOn) }]),
      ...(party === undefined ? [] : [{ field: "party", from: null, to: party.key }]),
      ...(project === undefined ? [] : [{ field: "project", from: null, to: project.key }]),
      ...(input.side === "theirs" ? [{ field: "side", from: null, to: "theirs" }] : []),
      ...(input.repo === undefined || input.repo === null
        ? []
        : [{ field: "repo", from: null, to: input.repo }]),
      ...Object.entries(fields).map(([field, value]) => ({
        field,
        from: null,
        to: shownField(value),
      })),
    ];
    const seq = yield* logChange(orgId, writer, { recordId, key, rev: 1 }, "created", changes, now);
    if (input.source !== undefined)
      yield* insertLink(
        orgId,
        recordId,
        {
          kind: "message",
          target: input.source.messageId,
          relation: "source",
          chatId: input.source.chatId,
        },
        now,
      );
    for (const link of input.links ?? []) yield* insertLink(orgId, recordId, link, now);
    yield* indexRecord(orgId, recordId).pipe(provideSql);
    if (givenAway && options.wake)
      yield* wakeLead(
        orgId,
        writer,
        { recordId, key, registerId: list },
        input.owner,
        assignedBy,
        seq,
        now,
      );
    const row = yield* byId(orgId, recordId).pipe(provideSql);
    if (row === undefined) return yield* unavailable;
    return { row, created: true };
  });

  /**
   * The next occurrence of a repeating entry that just closed: same owner, client, fields and
   * amount, its dates moved on by the rule, open. Keyed by the entry it follows, so a retry, a
   * reopen and a second close all find the one already made.
   */
  const spawnNext = Effect.fn("KinRecords.spawnNext")(function* (
    orgId: KinOrgId,
    writer: Writer,
    row: RecordRow,
  ) {
    const repeat = repeatOf(row.repeatJson);
    if (repeat === undefined) return;
    const def = yield* resolveList(orgId, row.registerId);
    // The next one is owed, so it starts in a state that is not closed; a list with none has no next.
    const state = (["open", "waiting", "doing"] as const).find((one) => def.states.includes(one));
    if (state === undefined) return;
    const zone = yield* ownerZone(orgId).pipe(provideSql);
    const next = nextDates(
      repeat,
      {
        dueAt: row.dueAt,
        dueAllDay: row.dueAllDay === 1,
        dateAt: row.dateAt,
        dateAllDay: row.dateAllDay === 1,
      },
      zone,
    );
    const owner = principal(row.ownerKind, row.ownerId);
    if (owner === null) return;
    const files = new Set(def.fields.filter((one) => one.type === "file").map((one) => one.key));
    const kept = Object.fromEntries(
      Object.entries(parseFields(row.fieldsJson)).filter(([key]) => !files.has(key)),
    );
    const amount = amountOf(row);
    yield* insert(
      orgId,
      {
        actor: { _tag: "system" },
        via: writer.via,
        ...(writer.chatId === undefined ? {} : { chatId: writer.chatId }),
        askedBy: row.assignedBy === null ? null : KinPersonId.make(row.assignedBy),
      },
      {
        list: row.registerId,
        originKey: `repeat:${row.recordId}`,
        title: row.title,
        owner,
        state,
        category: row.category,
        side: row.side,
        dueAt: next.dueAt,
        dueAllDay: row.dueAllDay === 1,
        dateAt: next.dateAt,
        dateAllDay: row.dateAllDay === 1,
        notes: row.notes,
        sensitive: row.sensitive === 1,
        confirmed: row.confirmed === 1,
        partyId: row.partyId,
        projectId: row.projectId,
        repo: row.repo,
        fields: kept,
        ...(amount === undefined ? {} : { amount }),
        links: [{ kind: "record", target: row.recordId, relation: "relates", label: row.key }],
      },
      { wake: false, repeat },
    );
  });

  const create = Effect.fn("KinRecords.create")(function* (
    orgId: KinOrgId,
    writer: Writer,
    input: CreateInput,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const result = yield* insert(orgId, writer, input, { wake: true });
        if (!result.created && result.row.state === "dropped" && input.state !== "dropped")
          return yield* undoneRetry("entry");
        // Made already closed, a repeating entry's next one is owed at once.
        if (result.created && isClosed(result.row.state))
          yield* spawnNext(orgId, writer, result.row);
        return result;
      }),
    );
  });

  const update = Effect.fn("KinRecords.update")(function* (
    orgId: KinOrgId,
    writer: Writer,
    key: string,
    patch: Patch,
    expectedRev?: number,
    also: ReadonlyArray<FieldChange> = [],
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const row = yield* byKey(orgId, key).pipe(provideSql);
        if (row === undefined) return yield* notFound(key);
        const now = yield* Clock.currentTimeMillis;
        const before = toRecord(row, now);
        const def = yield* resolveList(orgId, row.registerId);
        const list = def.id;
        const invalidFor = checkInput(def, {
          title: patch.title,
          state: patch.state,
          category: patch.category,
          fields: patch.fields,
          amount: patch.amount,
          dateAt: patch.dateAt,
          repeat: patch.repeat,
        });
        if (invalidFor !== undefined) return yield* invalidFor;
        if (
          numberingOf(def) !== undefined &&
          patch.fields !== undefined &&
          "number" in patch.fields
        ) {
          if (writer.actor._tag !== "person") return yield* invalid(NUMBERS_ARE_ISSUED);
          const issued = yield* sql`SELECT 1 FROM kin_issued_numbers
            WHERE org_id = ${orgId} AND record_id = ${row.recordId} LIMIT 1`;
          if (issued.length > 0)
            return yield* invalid(
              `${row.key} was issued its number, and an issued number never changes.`,
            );
        }
        if (def.builtIn === null && patch.fields !== undefined)
          yield* verifyRefs(orgId, def, patch.fields).pipe(provideSql);
        const changes: Array<FieldChange> = [];
        const sets: Array<Statement.Fragment> = [];
        const set = (column: string, value: string | number | null) =>
          sets.push(sql`${sql(column)} = ${value}`);
        const projectId = patch.projectId === undefined ? row.projectId : patch.projectId;
        const project =
          patch.projectId === undefined || patch.projectId === null
            ? undefined
            : yield* target(orgId, patch.projectId, "projects");
        const partyId =
          patch.partyId !== undefined
            ? patch.partyId
            : row.partyId === null && project !== undefined
              ? project.partyId
              : row.partyId;
        const invalidRefs = checkRefs(def, partyId, projectId);
        if (invalidRefs !== undefined) return yield* invalidRefs;
        if (partyId !== row.partyId) {
          const party = partyId === null ? null : yield* target(orgId, partyId, "clients");
          changes.push({ field: "party", from: row.partyKey, to: party?.key ?? null });
          set("party_id", partyId);
        }
        if (projectId !== row.projectId) {
          changes.push({ field: "project", from: row.projectKey, to: project?.key ?? null });
          set("project_id", projectId);
        }
        if (patch.repo !== undefined && patch.repo !== row.repo) {
          changes.push({ field: "repo", from: row.repo, to: patch.repo });
          set("repo", patch.repo);
        }
        if (patch.title !== undefined && patch.title !== row.title) {
          changes.push({ field: "title", from: row.title, to: patch.title });
          set("title", patch.title);
        }
        if (patch.title !== undefined || partyId !== row.partyId)
          yield* sameName(orgId, list, patch.title ?? row.title, partyId, row.recordId);
        const stored = parseFields(row.fieldsJson);
        const merged: Record<string, FieldValue> = { ...stored };
        let fieldsChanged = false;
        for (const [field, value] of Object.entries(patch.fields ?? {})) {
          const from = shownField(stored[field]);
          const to = shownField(value);
          if (from === to) continue;
          changes.push({ field, from, to });
          fieldsChanged = true;
          if (value === null) delete merged[field];
          else merged[field] = value;
        }
        if (fieldsChanged) set("fields_json", yield* encodeFieldValues(merged));
        const amount = amountOf(row) ?? null;
        const byOwner = writer.via === "owner";
        const amountChanged =
          patch.amount !== undefined &&
          (patch.amount?.minor !== amount?.minor || patch.amount?.currency !== amount?.currency);
        if (amountChanged && row.paid > 0) {
          const received = formatMoney({ minor: row.paid, currency: amount!.currency });
          // An invoice's payments are in its currency: a different one would make them nonsense.
          if (patch.amount?.currency !== amount?.currency)
            return yield* invalid(
              `${row.key} has payments in ${amount?.currency}; void them before changing its currency.`,
            );
          if (patch.amount!.minor < row.paid)
            return yield* new SensitiveRefusal({
              reason: "invalid_state",
              message: `${row.key} has ${received} received, so its amount can't be less. ${byOwner ? "Take a payment back first" : "Void a payment with payment_record first"}, then change the amount.`,
            });
        }
        // Paid or owed follows the balance whenever the amount moves; a state saying otherwise is
        // refused, while Draft and Void stay the caller's to set.
        const balanced = amountChanged && row.paid > 0;
        const owed = balanced ? patch.amount!.minor - row.paid : 0;
        const owing = owedState(def);
        if (
          balanced &&
          ((patch.state === "done" && owed > 0) || (patch.state === owing && owed === 0))
        )
          return yield* new SensitiveRefusal({
            reason: "invalid_state",
            message:
              owed > 0
                ? `${row.key} would still have ${formatMoney({ minor: owed, currency: amount!.currency })} owed, so it can't be ${stateLabel(def, "done")}. Leave the state out: recording the rest ${byOwner ? "as a payment" : "with payment_record"} marks it ${stateLabel(def, "done")}.`
                : `${row.key} would be fully paid at this amount, so it can't be ${stateLabel(def, patch.state ?? "waiting")}. Leave the state out.`,
          });
        const settled =
          balanced && patch.state === undefined && row.state !== "dropped"
            ? owed === 0
              ? def.states.includes("done")
                ? "done"
                : row.state
              : row.state === "done"
                ? (owing ?? row.state)
                : row.state
            : undefined;
        const state = patch.state ?? settled ?? row.state;
        // Closing a client or project would strand what points at it: close or move that first.
        if (
          (list === "clients" || list === "projects") &&
          isClosed(state) &&
          !isClosed(row.state)
        ) {
          const [open] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM kin_records
            WHERE org_id = ${orgId} AND (party_id = ${row.recordId} OR project_id = ${row.recordId})
              AND register_id IN ('work', 'projects') AND state NOT IN ${sql.in(CLOSED)}`;
          if ((open?.count ?? 0) > 0)
            return yield* new KinChatError({
              reason: "invalid_state",
              message: `${row.key} still has ${open!.count} open ${list === "clients" ? "entries or projects" : "entries"} pointing at it. Close or move them first.`,
            });
        }
        if (state !== row.state) {
          changes.push({ field: "state", from: row.state, to: state });
          set("state", state);
          if (isClosed(state) !== isClosed(row.state))
            set("closed_at", isClosed(state) ? now : null);
        }
        const waitingOn =
          state !== "waiting"
            ? null
            : patch.waitingOn !== undefined
              ? patch.waitingOn
              : before.waitingOn;
        if (waitingOn !== null && !samePrincipal(waitingOn, before.waitingOn))
          yield* ownerExists(orgId, waitingOn, "to wait on");
        if (
          !samePrincipal(waitingOn, before.waitingOn) ||
          (state !== "waiting" && row.waitingOnId !== null)
        ) {
          if (!samePrincipal(waitingOn, before.waitingOn))
            changes.push({
              field: "waitingOn",
              from: shownPrincipal(before.waitingOn),
              to: shownPrincipal(waitingOn),
            });
          set("waiting_on_kind", waitingOn?._tag ?? null);
          set("waiting_on_id", waitingOn === null ? null : principalId(waitingOn));
        }
        let reassigned: KinWorkPrincipal | undefined;
        if (patch.owner !== undefined && !samePrincipal(patch.owner, before.owner)) {
          if (isClosed(state))
            return yield* new KinChatError({
              reason: "invalid_state",
              message: `${row.key} is ${state}. Reopen it before giving it to someone.`,
            });
          yield* ownerExists(orgId, patch.owner);
          changes.push({
            field: "owner",
            from: shownPrincipal(before.owner),
            to: shownPrincipal(patch.owner),
          });
          set("owner_kind", patch.owner._tag);
          set("owner_id", principalId(patch.owner));
          // Reassigning never launders authority: the assigner is whoever asked for this change.
          set("assigned_by_person_id", writer.askedBy ?? null);
          set("assigned_at", writer.askedBy === undefined || writer.askedBy === null ? null : now);
          reassigned = patch.owner;
        }
        // Reopened by a person, a lead's entry is given to it again, with that person's authority.
        const reopened =
          reassigned === undefined &&
          before.owner._tag === "agent" &&
          writer.actor._tag === "person" &&
          isClosed(row.state) &&
          !isClosed(state);
        if (reopened) {
          set("assigned_by_person_id", writer.askedBy ?? null);
          set("assigned_at", writer.askedBy === undefined || writer.askedBy === null ? null : now);
        }
        if (patch.dueAt !== undefined && patch.dueAt !== row.dueAt) {
          changes.push({ field: "due", from: shownDue(row.dueAt), to: shownDue(patch.dueAt) });
          set("due_at", patch.dueAt);
        }
        if (patch.dueAllDay !== undefined && (patch.dueAllDay ? 1 : 0) !== row.dueAllDay) {
          if ((patch.dueAt === undefined ? row.dueAt : patch.dueAt) !== null)
            changes.push({
              field: "dueAllDay",
              from: shown(row.dueAllDay === 1),
              to: shown(patch.dueAllDay),
            });
          set("due_all_day", patch.dueAllDay ? 1 : 0);
        }
        if (amountChanged) {
          changes.push({
            field: "amount",
            from: shownAmount(amount),
            to: shownAmount(patch.amount),
          });
          set("amount_minor", patch.amount?.minor ?? null);
          set("currency", patch.amount?.currency ?? null);
        }
        if (patch.dateAt !== undefined && patch.dateAt !== row.dateAt) {
          changes.push({ field: "date", from: shownDue(row.dateAt), to: shownDue(patch.dateAt) });
          set("date_at", patch.dateAt);
        }
        if (patch.dateAllDay !== undefined && (patch.dateAllDay ? 1 : 0) !== row.dateAllDay)
          set("date_all_day", patch.dateAllDay ? 1 : 0);
        if (patch.repeat !== undefined) {
          const was = repeatOf(row.repeatJson)?.rule ?? null;
          if (shownRepeat(was) !== shownRepeat(patch.repeat)) {
            const stored =
              patch.repeat === null
                ? null
                : yield* storedRepeat(
                    orgId,
                    patch.repeat,
                    patch.dueAt === undefined ? row.dueAt : patch.dueAt,
                    patch.dateAt === undefined ? row.dateAt : patch.dateAt,
                  );
            changes.push({
              field: "repeat",
              from: shownRepeat(was),
              to: shownRepeat(patch.repeat),
            });
            set("repeat_json", stored === null ? null : yield* encodeRepeat(stored));
          }
        } else if (
          (patch.dueAt !== undefined || patch.dateAt !== undefined) &&
          repeatOf(row.repeatJson) !== undefined
        ) {
          // Moved dates move the days of the month later occurrences keep.
          const stored = yield* storedRepeat(
            orgId,
            repeatOf(row.repeatJson)!.rule,
            patch.dueAt === undefined ? row.dueAt : patch.dueAt,
            patch.dateAt === undefined ? row.dateAt : patch.dateAt,
          );
          set("repeat_json", yield* encodeRepeat(stored));
        }
        if (patch.notes !== undefined && patch.notes !== row.notes) {
          changes.push({ field: "notes", from: row.notes, to: patch.notes });
          set("notes", patch.notes);
        }
        if (patch.category !== undefined && patch.category !== row.category) {
          changes.push({ field: "category", from: row.category, to: patch.category });
          set("category", patch.category);
        }
        if (patch.side !== undefined && patch.side !== row.side) {
          changes.push({ field: "side", from: row.side, to: patch.side });
          set("side", patch.side);
        }
        if (patch.confirmed !== undefined && (patch.confirmed ? 1 : 0) !== row.confirmed) {
          changes.push({
            field: "confirmed",
            from: shown(row.confirmed === 1),
            to: shown(patch.confirmed),
          });
          set("confirmed", patch.confirmed ? 1 : 0);
        }
        // Anyone may raise a label; only a person lowers one, and only the owner reaches here so.
        if (patch.sensitive === true && row.sensitive === 0) {
          changes.push({ field: "sensitive", from: "false", to: "true" });
          set("sensitive", 1);
        } else if (
          patch.sensitive === false &&
          row.sensitive === 1 &&
          writer.actor._tag === "person"
        ) {
          changes.push({ field: "sensitive", from: "true", to: "false" });
          set("sensitive", 0);
        }
        changes.push(...also);
        // A retry of a change that already landed finds nothing to do: that is success.
        if (sets.length === 0 && also.length === 0) return row;
        if (expectedRev !== undefined && expectedRev !== row.rev)
          return yield* conflict(row.key, row.rev);
        const rev = row.rev + 1;
        set("rev", rev);
        set("updated_at", now);
        // Each update rewrites only the fields it changed, so two changes to one entry both land.
        yield* sql`UPDATE kin_records SET ${sql.csv(sets)}
          WHERE org_id = ${orgId} AND record_id = ${row.recordId}`;
        yield* indexRecord(orgId, row.recordId).pipe(provideSql);
        const seq = yield* logChange(
          orgId,
          writer,
          { recordId: row.recordId, key: row.key, rev },
          "updated",
          changes,
          now,
        );
        // Only a person lowers what is sensitive: any other write that would, labels the entry
        // instead, as Kin's own change. What inherits through it then stays sensitive too.
        if (
          writer.actor._tag !== "person" &&
          (row.sensitive === 1 || row.inheritedSensitive === 1) &&
          (yield* effectivelySensitive(orgId, row.recordId).pipe(provideSql)) === false
        ) {
          yield* sql`UPDATE kin_records SET sensitive = 1, rev = ${rev + 1}, updated_at = ${now}
            WHERE org_id = ${orgId} AND record_id = ${row.recordId}`;
          yield* logChange(
            orgId,
            {
              actor: { _tag: "system" },
              via: writer.via,
              ...(writer.wakeupId === undefined ? {} : { wakeupId: writer.wakeupId }),
              ...(writer.chatId === undefined ? {} : { chatId: writer.chatId }),
            },
            { recordId: row.recordId, key: row.key, rev: rev + 1 },
            "updated",
            [{ field: "sensitive", from: "false", to: "true" }],
            now,
          );
        }
        if (reassigned !== undefined)
          yield* wakeLead(orgId, writer, row, reassigned, writer.askedBy ?? null, seq, now);
        if (reopened)
          yield* wakeLead(orgId, writer, row, before.owner, writer.askedBy ?? null, seq, now);
        // A lead never keeps working an open entry a person closed or took from it.
        const withdrawnFrom: Principal | undefined =
          !isClosed(row.state) && (isClosed(state) || reassigned !== undefined)
            ? before.owner
            : undefined;
        // Told only when the person is the lead's owner; then Kin, not the lead, stops its work.
        if (
          withdrawnFrom?._tag === "agent" &&
          writer.actor._tag === "person" &&
          (yield* wakeLead(
            orgId,
            writer,
            row,
            withdrawnFrom,
            writer.actor.personId,
            seq,
            now,
            "withdrawn",
          ))
        ) {
          // The stop is recorded with the change, before anything is interrupted, so it holds
          // against publishing and outlives a restart; it never reaches work started after.
          const workers = yield* withdrawAttempts({
            orgId,
            agentId: withdrawnFrom.agentId,
            recordId: row.recordId,
            key: row.key,
            seq,
            at: now,
          }).pipe(provideSql);
          const withdrawal = {
            orgId,
            agentId: withdrawnFrom.agentId,
            recordId: row.recordId,
            key: row.key,
            seq,
            workers,
          };
          yield* sql.afterCommit(
            Effect.suspend(() =>
              onWithdrawn === undefined
                ? Effect.logError("Kin has no lead runtime to stop withdrawn work", withdrawal)
                : onWithdrawn(withdrawal),
            ),
          );
        }
        const updated = yield* byId(orgId, row.recordId).pipe(provideSql);
        if (updated === undefined) return yield* unavailable;
        if (!isClosed(row.state) && isClosed(updated.state))
          yield* spawnNext(orgId, writer, updated);
        return updated;
      }),
    );
  });

  const link = Effect.fn("KinRecords.link")(function* (
    orgId: KinOrgId,
    writer: Writer,
    recordId: string,
    input: LinkInput,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (!(yield* insertLink(orgId, recordId, input, now))) return false;
        const [row] = yield* sql<{ rev: number; key: string }>`SELECT rev, key FROM kin_records
          WHERE org_id = ${orgId} AND record_id = ${recordId}`;
        if (row === undefined) return yield* notFound(recordId);
        yield* logChange(
          orgId,
          writer,
          { recordId, key: row.key, rev: row.rev },
          "linked",
          [{ field: input.kind, from: null, to: input.label ?? input.target }],
          now,
        );
        return true;
      }),
    );
  });

  const pay = Effect.fn("KinRecords.pay")(function* (
    orgId: KinOrgId,
    writer: Writer,
    key: string,
    payment: PaymentInput,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const row = yield* byKey(orgId, key).pipe(provideSql);
        if (row === undefined) return yield* notFound(key);
        if (row.takesPayments !== 1)
          return yield* invalid(
            `${row.key} is not an invoice or in a list paid over time; payments are recorded on those.`,
          );
        const def = yield* resolveList(orgId, row.registerId);
        const paymentId = paymentIdFor(orgId, payment.originKey);
        const [earlier] = yield* sql<{
          recordId: string;
          minor: number;
          currency: string;
          paidOn: string;
          note: string;
          withheld: number;
          voidedAt: number | null;
        }>`
          SELECT record_id AS "recordId", amount_minor AS minor, currency, paid_on AS "paidOn", note,
            withheld, voided_at AS "voidedAt"
          FROM kin_record_payments WHERE org_id = ${orgId} AND origin_key = ${payment.originKey}`;
        if (earlier !== undefined) {
          if (
            earlier.recordId !== row.recordId ||
            earlier.minor !== payment.amount.minor ||
            earlier.currency !== payment.amount.currency ||
            earlier.paidOn !== payment.paidOn ||
            earlier.note !== (payment.note ?? "") ||
            earlier.withheld !== (payment.withheld === true ? 1 : 0)
          )
            return yield* new KinChatError({
              reason: "not_allowed",
              message: "That retry key already recorded a different payment.",
            });
          if (earlier.voidedAt !== null) return yield* undoneRetry("payment");
          return { row, paymentId };
        }
        if (row.state === "dropped")
          return yield* invalid(`${row.key} is void; it takes no payments.`);
        const amount = amountOf(row);
        if (amount === undefined)
          return yield* invalid(`${row.key} has no amount yet; set it before recording payments.`);
        if (payment.amount.currency !== amount.currency)
          return yield* invalid(
            `${row.key} is in ${amount.currency}; record the payment in ${amount.currency}.`,
          );
        if (payment.amount.minor <= 0) return yield* invalid("A payment is more than nothing.");
        const balance = amount.minor - row.paid;
        if (payment.amount.minor > balance)
          return yield* new SensitiveRefusal({
            reason: "invalid_state",
            message: `That is more than the ${formatMoney({ minor: balance, currency: amount.currency })} still owed on ${row.key}.`,
          });
        const now = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO kin_record_payments (org_id, payment_id, record_id, amount_minor,
            currency, paid_on, note, origin_key, created_at, created_by_kind, created_by_id,
            withheld)
          VALUES (${orgId}, ${paymentId}, ${row.recordId}, ${payment.amount.minor},
            ${payment.amount.currency}, ${payment.paidOn}, ${payment.note ?? ""},
            ${payment.originKey}, ${now}, ${writer.actor._tag}, ${actorIdOf(writer)},
            ${payment.withheld === true ? 1 : 0})`;
        const paidUp =
          payment.amount.minor === balance && row.state !== "done" && def.states.includes("done");
        const rev = row.rev + 1;
        yield* sql`UPDATE kin_records SET rev = ${rev}, updated_at = ${now},
            state = ${paidUp ? "done" : row.state},
            closed_at = ${paidUp ? now : row.closedAt},
            waiting_on_kind = ${paidUp ? null : row.waitingOnKind},
            waiting_on_id = ${paidUp ? null : row.waitingOnId}
          WHERE org_id = ${orgId} AND record_id = ${row.recordId}`;
        yield* logChange(
          orgId,
          writer,
          { recordId: row.recordId, key: row.key, rev },
          "updated",
          [
            {
              field: "payment",
              from: null,
              to: `${formatMoney(payment.amount)} on ${payment.paidOn}`,
            },
            ...(paidUp ? [{ field: "state", from: row.state, to: "done" }] : []),
          ],
          now,
        );
        const updated = yield* byId(orgId, row.recordId).pipe(provideSql);
        if (updated === undefined) return yield* unavailable;
        if (paidUp && !isClosed(row.state)) yield* spawnNext(orgId, writer, updated);
        return { row: updated, paymentId };
      }),
    );
  });

  const voidPayment = Effect.fn("KinRecords.voidPayment")(function* (
    orgId: KinOrgId,
    writer: Writer,
    key: string,
    paymentId: string,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const row = yield* byKey(orgId, key).pipe(provideSql);
        if (row === undefined) return yield* notFound(key);
        const [found] = yield* sql<{
          minor: number;
          currency: string;
          paidOn: string;
          voidedAt: number | null;
        }>`
          SELECT amount_minor AS minor, currency, paid_on AS "paidOn", voided_at AS "voidedAt"
          FROM kin_record_payments WHERE org_id = ${orgId} AND payment_id = ${paymentId}
            AND record_id = ${row.recordId}`;
        if (found === undefined)
          return yield* new KinChatError({
            reason: "not_found",
            message: `No payment ${paymentId.slice(0, 40)} on ${row.key}.`,
          });
        if (found.voidedAt !== null) return row;
        const now = yield* Clock.currentTimeMillis;
        yield* sql`UPDATE kin_record_payments SET voided_at = ${now}
          WHERE org_id = ${orgId} AND payment_id = ${paymentId}`;
        // Paid no longer, it is owed again: issued, as it was before the payment closed it.
        const owing = owedState(yield* resolveList(orgId, row.registerId));
        const reissued = row.state === "done" && owing !== undefined;
        const rev = row.rev + 1;
        yield* sql`UPDATE kin_records SET rev = ${rev}, updated_at = ${now},
            state = ${reissued ? owing : row.state}, closed_at = ${reissued ? null : row.closedAt}
          WHERE org_id = ${orgId} AND record_id = ${row.recordId}`;
        yield* logChange(
          orgId,
          writer,
          { recordId: row.recordId, key: row.key, rev },
          "updated",
          [
            {
              field: "payment",
              from: `${formatMoney({ minor: found.minor, currency: found.currency })} on ${found.paidOn}`,
              to: null,
            },
            ...(reissued ? [{ field: "state", from: "done", to: owing }] : []),
          ],
          now,
        );
        const updated = yield* byId(orgId, row.recordId).pipe(provideSql);
        if (updated === undefined) return yield* unavailable;
        return updated;
      }),
    );
  });

  const totals = Effect.fn("KinRecords.totals")(function* (
    orgId: KinOrgId,
    input: QueryInput,
    by?: TotalsBy,
    everyEntry?: boolean,
  ) {
    return yield* failed(
      Effect.gen(function* () {
        const now = input.at ?? (yield* Clock.currentTimeMillis);
        const filter =
          everyEntry === true
            ? filterOf(orgId, input, now)
            : sql.and([filterOf(orgId, input, now), sql`r.amount_minor IS NOT NULL`]);
        const [count] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_records r
          WHERE ${filter}`;
        const counted = count?.n ?? 0;
        if (counted > TOTALS_CAP)
          return yield* invalid(
            `${counted} entries match; narrow it to under ${TOTALS_CAP} by dates or category to total them.`,
          );
        const windowed = input.paidFrom !== undefined || input.paidTo !== undefined;
        const live = sql`FROM kin_record_payments p WHERE p.org_id = r.org_id
          AND p.record_id = r.record_id AND p.voided_at IS NULL`;
        const rows = yield* sql<{
          minor: number | null;
          currency: string;
          category: string | null;
          party: string | null;
          project: string | null;
          side: string;
          state: KinRecordState;
          owner: string;
          at: number;
          paid: number;
          received: number;
        }>`SELECT r.amount_minor AS minor, r.currency, r.category, r.party_id AS party,
            r.project_id AS project, r.side, r.state, r.owner_kind || ':' || r.owner_id AS owner,
            ${moneyDay(sql)} AS at,
            (SELECT COALESCE(SUM(p.amount_minor), 0) ${live}) AS paid,
            (SELECT COALESCE(SUM(p.amount_minor), 0) ${live} AND p.withheld = 0
              AND p.paid_on >= ${input.paidFrom ?? "0000-00-00"}
              AND p.paid_on <= ${input.paidTo ?? "9999-12-31"}) AS received
          FROM kin_records r WHERE ${filter} ORDER BY r.record_id`;
        const listDef = yield* resolveList(orgId, input.list ?? "work");
        const paidOverTime = listDef.payments === true;
        const amounts = (members: typeof rows): Sums => {
          const priced = members.flatMap((row) =>
            row.minor === null ? [] : [{ ...row, minor: row.minor }],
          );
          return {
            total: addUp(priced),
            ...(paidOverTime
              ? {
                  owed: addUp(
                    priced
                      .filter((row) => owesIn(listDef, row.state) && row.minor > row.paid)
                      .map((row) => ({ minor: row.minor - row.paid, currency: row.currency })),
                  ),
                }
              : {}),
            ...(windowed
              ? {
                  received: addUp(
                    priced
                      .filter((row) => row.received > 0)
                      .map((row) => ({ minor: row.received, currency: row.currency })),
                  ),
                }
              : {}),
          };
        };
        const total = amounts(rows);
        if (by === undefined) return { ...total, counted } satisfies Totals;
        const zone =
          by === "month" || by === "financialYear"
            ? yield* ownerZone(orgId).pipe(provideSql)
            : "UTC";
        const keyOf = (row: (typeof rows)[number]): string | null =>
          by === "month"
            ? monthOf(dayIn(row.at, zone))
            : by === "financialYear"
              ? financialYearOf(dayIn(row.at, zone))
              : by === "party"
                ? row.party
                : by === "owner"
                  ? row.owner
                  : row[by];
        const grouped = new Map<string | null, Array<(typeof rows)[number]>>();
        for (const row of rows) {
          const group = keyOf(row);
          const members = grouped.get(group);
          if (members === undefined) grouped.set(group, [row]);
          else members.push(row);
        }
        const groups = [...grouped].map(([group, members]) => ({
          group,
          count: members.length,
          ...amounts(members),
        }));
        // Periods read in time order; anything else most entries first.
        const ordered =
          by === "month" || by === "financialYear"
            ? groups.toSorted((a, b) => ((a.group ?? "") < (b.group ?? "") ? -1 : 1))
            : groups.toSorted(
                (a, b) => b.count - a.count || ((a.group ?? "") < (b.group ?? "") ? -1 : 1),
              );
        return { ...total, counted, groups: ordered.slice(0, 50) } satisfies Totals;
      }).pipe(
        Effect.catchDefect((defect) =>
          defect instanceof RangeError
            ? Effect.fail(invalid("Those totals are too large to add up exactly."))
            : Effect.die(defect),
        ),
      ),
    );
  });

  const filterOf = (orgId: KinOrgId, input: QueryInput, now: number) => {
    const where = [sql`r.org_id = ${orgId}`, sql`r.register_id = ${input.list ?? "work"}`];
    if (input.partyId !== undefined) where.push(sql`r.party_id IS ${input.partyId}`);
    if (input.projectId !== undefined) where.push(sql`r.project_id = ${input.projectId}`);
    if (input.repo !== undefined) where.push(sql`lower(r.repo) = lower(${input.repo})`);
    if (input.owner !== undefined)
      where.push(
        sql`r.owner_kind = ${input.owner._tag} AND r.owner_id = ${principalId(input.owner)}`,
      );
    if (input.states !== undefined && input.states.length > 0)
      where.push(sql`r.state IN ${sql.in(input.states)}`);
    else if (input.open === true) where.push(sql`r.state NOT IN ('done', 'dropped')`);
    else if (input.open === false) where.push(sql`r.state IN ('done', 'dropped')`);
    if (input.late === true)
      where.push(sql`r.due_at < ${now} AND r.state NOT IN ('done', 'dropped')`);
    else if (input.late === false)
      where.push(sql`(r.due_at IS NULL OR r.due_at >= ${now} OR r.state IN ('done', 'dropped'))`);
    if (input.dueBy !== undefined) where.push(sql`r.due_at <= ${input.dueBy}`);
    if (input.dueAfter !== undefined) where.push(sql`r.due_at >= ${input.dueAfter}`);
    if (input.dateFrom !== undefined) where.push(sql`${moneyDay(sql)} >= ${input.dateFrom}`);
    if (input.dateTo !== undefined) where.push(sql`${moneyDay(sql)} < ${input.dateTo}`);
    if (input.category !== undefined) where.push(sql`r.category IS ${input.category}`);
    if (input.paidFrom !== undefined || input.paidTo !== undefined)
      where.push(sql`EXISTS (SELECT 1 FROM kin_record_payments p
        WHERE p.org_id = r.org_id AND p.record_id = r.record_id AND p.voided_at IS NULL
          AND p.paid_on >= ${input.paidFrom ?? "0000-00-00"}
          AND p.paid_on <= ${input.paidTo ?? "9999-12-31"})`);
    if (input.side !== undefined) where.push(sql`r.side = ${input.side}`);
    if (input.keys !== undefined && input.keys.length > 0)
      where.push(sql`r.key IN ${sql.in(input.keys)}`);
    const text = input.text?.trim().toLowerCase();
    if (text !== undefined && text !== "")
      where.push(sql`(instr(lower(r.title), ${text}) > 0 OR instr(lower(r.notes), ${text}) > 0)`);
    return sql.and(where);
  };

  const query = Effect.fn("KinRecords.query")(function* (orgId: KinOrgId, input: QueryInput) {
    return yield* failed(
      Effect.gen(function* () {
        const now = input.at ?? (yield* Clock.currentTimeMillis);
        const filter = filterOf(orgId, input, now);
        const [count] = yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM kin_records r
          WHERE ${filter}`;
        const limit = Math.min(Math.max(input.limit ?? 50, 1), KIN_RECORDS_PAGE_CAP);
        // Work by what is under way and due; a directory of clients or projects by name; a defined
        // list open and soonest due first, then newest.
        const list = input.list ?? "work";
        const order =
          list === "work"
            ? sql`CASE r.state WHEN 'doing' THEN 0 WHEN 'waiting' THEN 1 WHEN 'open' THEN 2
                ELSE 3 END, r.due_at IS NULL, r.due_at, r.created_at, r.key`
            : isBuiltIn(list)
              ? sql`r.state IN ('done', 'dropped'), lower(r.title), r.key`
              : sql`r.state IN ('done', 'dropped'), r.due_at IS NULL, r.due_at,
                  ${moneyDay(sql)} DESC, r.created_at DESC, r.key`;
        const rows = yield* sql<RecordRow>`${selectRecords(sql)} WHERE ${filter}
          ORDER BY ${order}
          LIMIT ${limit} OFFSET ${Math.max(input.offset ?? 0, 0)}`;
        return { rows, total: count?.total ?? 0, seq: yield* latestSeq(orgId).pipe(provideSql) };
      }),
    );
  });

  const groups = Effect.fn("KinRecords.groups")(function* (
    orgId: KinOrgId,
    input: QueryInput,
    by: GroupBy,
  ) {
    return yield* failed(
      Effect.gen(function* () {
        const now = input.at ?? (yield* Clock.currentTimeMillis);
        const column =
          by === "party"
            ? sql`r.party_id`
            : by === "project"
              ? sql`r.project_id`
              : by === "side"
                ? sql`r.side`
                : by === "state"
                  ? sql`r.state`
                  : by === "category"
                    ? sql`r.category`
                    : sql`r.owner_kind || ':' || r.owner_id`;
        const rows = yield* sql<{ group: string | null; count: number; late: number | null }>`
          SELECT ${column} AS "group", COUNT(*) AS count,
            SUM(r.due_at IS NOT NULL AND r.due_at < ${now}
              AND r.state NOT IN ('done', 'dropped')) AS late
          FROM kin_records r WHERE ${filterOf(orgId, input, now)}
          GROUP BY 1 ORDER BY COUNT(*) DESC, 1 LIMIT 50`;
        return rows.map((row) => ({ group: row.group, count: row.count, late: row.late ?? 0 }));
      }),
    );
  });

  return KinRecords.of({
    attachWithdrawals: Effect.fn("KinRecords.attachWithdrawals")(function* (next) {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          onWithdrawn = next;
        }),
        () =>
          Effect.sync(() => {
            if (onWithdrawn === next) onWithdrawn = undefined;
          }),
      );
    }),
    create,
    update,
    link,
    pay,
    voidPayment,
    totals,
    query,
    groups,
    get: Effect.fn("KinRecords.get")(function* (orgId, key) {
      return yield* failed(byKey(orgId, key).pipe(provideSql));
    }),
    getById: Effect.fn("KinRecords.getById")(function* (orgId, recordId) {
      return yield* failed(byId(orgId, recordId).pipe(provideSql));
    }),
    detail: Effect.fn("KinRecords.detail")(function* (row, changeLimit) {
      const now = yield* Clock.currentTimeMillis;
      return yield* failed(toDetail(row, now, changeLimit).pipe(provideSql));
    }),
    seq: Effect.fn("KinRecords.seq")(function* (orgId) {
      return yield* failed(latestSeq(orgId).pipe(provideSql));
    }),
    changes: (orgId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(ticks);
          const now = yield* failed(latestSeq(orgId).pipe(provideSql));
          const first: { readonly seq: number; readonly key?: string } = { seq: now };
          return Stream.concat(
            Stream.make(first),
            Stream.fromEffectRepeat(PubSub.take(subscription)).pipe(
              Stream.filter((tick) => tick.orgId === orgId),
              Stream.map((tick) => ({ seq: tick.seq, key: tick.key })),
            ),
          );
        }),
      ),
  });
});

export const layer = Layer.effect(KinRecords, make);
