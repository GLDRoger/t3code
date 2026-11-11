// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import {
  KIN_RECORDS_PAGE_CAP,
  KinChatError,
  type KinAgentId,
  type KinChatId,
  type KinMessageId,
  type KinOrgId,
  type KinPersonId,
  type KinRecordCategory,
  type KinRecordChangeVia,
  type KinRecordLinkKind,
  type KinRecordRelation,
  type KinRecordSide,
  type KinRecordState,
  type KinWorkPrincipal,
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
import {
  byId,
  byKey,
  type FieldChange,
  type Principal,
  isClosed,
  latestSeq,
  notFound,
  principalId,
  type RecordRow,
  samePrincipal,
  selectRecords,
  toDetail,
  toRecord,
  unavailable,
} from "./recordRows.ts";

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
  readonly category?: KinRecordCategory | null;
  readonly side?: KinRecordSide;
  readonly dueAt?: number | null;
  readonly dueAllDay?: boolean;
  readonly notes?: string;
  readonly confirmed?: boolean;
  readonly sensitive?: boolean;
};
export type CreateInput = Fields & {
  /** A create with a key already stored returns that entry and changes nothing. */
  readonly originKey: string;
  readonly source?: { readonly chatId: KinChatId; readonly messageId: KinMessageId };
  readonly links?: ReadonlyArray<LinkInput>;
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
  readonly owner?: KinWorkPrincipal;
  readonly states?: ReadonlyArray<KinRecordState>;
  readonly open?: boolean;
  readonly late?: boolean;
  readonly dueBy?: number;
  readonly dueAfter?: number;
  readonly text?: string;
  readonly keys?: ReadonlyArray<string>;
  readonly category?: KinRecordCategory;
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
const WORK = { registerId: "work", name: "Work", prefix: "W" } as const;
const conflict = (key: string, rev: number) =>
  new KinChatError({
    reason: "conflict",
    message: `${key} changed since you read it; it is at revision ${rev} now. Read it again.`,
  });
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
    ) => Effect.Effect<RecordRow, KinChatError>;
    readonly link: (
      orgId: KinOrgId,
      writer: Writer,
      recordId: string,
      link: LinkInput,
    ) => Effect.Effect<boolean, KinChatError>;
    readonly query: (
      orgId: KinOrgId,
      input: QueryInput,
    ) => Effect.Effect<
      { readonly rows: ReadonlyArray<RecordRow>; readonly total: number; readonly seq: number },
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

  const ensureWork = Effect.fn("KinRecords.ensureWork")(function* (orgId: KinOrgId, now: number) {
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
      VALUES (${orgId}, ${WORK.registerId}, ${WORK.name}, ${WORK.prefix}, 1, ${now})
      ON CONFLICT DO NOTHING`;
    const [register] = yield* sql<{ next: number; prefix: string }>`
      UPDATE kin_registers SET next_number = next_number + 1
      WHERE org_id = ${orgId} AND register_id = ${WORK.registerId}
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
    row: { readonly recordId: string; readonly key: string },
    to: KinWorkPrincipal,
    assignedBy: KinPersonId | null,
    seq: number,
    now: number,
    reason: "assigned" | "withdrawn" = "assigned",
  ) {
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
        message: `No ${who._tag === "agent" ? "lead" : "person"} ${principalId(who).slice(0, 60)} here ${role}.`,
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

  const create = Effect.fn("KinRecords.create")(function* (
    orgId: KinOrgId,
    writer: Writer,
    input: CreateInput,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const recordId = recordIdFor(orgId, input.originKey);
        const existing = yield* byId(orgId, recordId).pipe(provideSql);
        if (existing !== undefined) return { row: existing, created: false };
        yield* ownerExists(orgId, input.owner);
        const now = yield* Clock.currentTimeMillis;
        const key = yield* ensureWork(orgId, now);
        const state = input.state ?? "open";
        const waitingOn = state === "waiting" ? (input.waitingOn ?? null) : null;
        const givenAway =
          !(writer.actor._tag === "agent" && samePrincipal(writer.actor, input.owner)) &&
          !(writer.actor._tag === "person" && samePrincipal(writer.actor, input.owner));
        const assignedBy = writer.askedBy ?? null;
        yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state,
            waiting_on_kind, waiting_on_id, owner_kind, owner_id, side, category, due_at, due_all_day,
            sensitive, confirmed, notes, rev, source_chat_id, source_message_id, created_by_kind,
            created_by_id, assigned_by_person_id, assigned_at, origin_key, created_at, updated_at,
            closed_at)
          VALUES (${orgId}, ${recordId}, ${WORK.registerId}, ${key}, ${input.title}, ${state},
            ${waitingOn?._tag ?? null}, ${waitingOn === null ? null : principalId(waitingOn)},
            ${input.owner._tag}, ${principalId(input.owner)}, ${input.side ?? "ours"},
            ${input.category ?? null}, ${input.dueAt ?? null}, ${input.dueAllDay === true ? 1 : 0},
            ${input.sensitive === true ? 1 : 0}, ${input.confirmed === false ? 0 : 1},
            ${input.notes ?? ""}, 1, ${input.source?.chatId ?? null},
            ${input.source?.messageId ?? null}, ${writer.actor._tag},
            ${writer.actor._tag === "agent" ? writer.actor.agentId : writer.actor._tag === "person" ? writer.actor.personId : null},
            ${assignedBy}, ${assignedBy === null ? null : now}, ${input.originKey}, ${now}, ${now},
            ${isClosed(state) ? now : null})`;
        const fields: Array<FieldChange> = [
          { field: "title", from: null, to: input.title },
          { field: "state", from: null, to: state },
          { field: "owner", from: null, to: shownPrincipal(input.owner) },
          ...(input.dueAt === undefined || input.dueAt === null
            ? []
            : [{ field: "due", from: null, to: shownDue(input.dueAt) }]),
          ...(waitingOn === null
            ? []
            : [{ field: "waitingOn", from: null, to: shownPrincipal(waitingOn) }]),
        ];
        const seq = yield* logChange(
          orgId,
          writer,
          { recordId, key, rev: 1 },
          "created",
          fields,
          now,
        );
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
        if (givenAway)
          yield* wakeLead(orgId, writer, { recordId, key }, input.owner, assignedBy, seq, now);
        const row = yield* byId(orgId, recordId).pipe(provideSql);
        if (row === undefined) return yield* unavailable;
        return { row, created: true };
      }),
    );
  });

  const update = Effect.fn("KinRecords.update")(function* (
    orgId: KinOrgId,
    writer: Writer,
    key: string,
    patch: Patch,
    expectedRev?: number,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const row = yield* byKey(orgId, key).pipe(provideSql);
        if (row === undefined) return yield* notFound(key);
        const now = yield* Clock.currentTimeMillis;
        const before = toRecord(row, now);
        const changes: Array<FieldChange> = [];
        const sets: Array<Statement.Fragment> = [];
        const set = (column: string, value: string | number | null) =>
          sets.push(sql`${sql(column)} = ${value}`);
        if (patch.title !== undefined && patch.title !== row.title) {
          changes.push({ field: "title", from: row.title, to: patch.title });
          set("title", patch.title);
        }
        const state = patch.state ?? row.state;
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
        // Raise only: lowering a label is the owner's tap, in a later slice.
        if (patch.sensitive === true && row.sensitive === 0) {
          changes.push({ field: "sensitive", from: "false", to: "true" });
          set("sensitive", 1);
        }
        // A retry of a change that already landed finds nothing to do: that is success.
        if (sets.length === 0) return row;
        if (expectedRev !== undefined && expectedRev !== row.rev)
          return yield* conflict(row.key, row.rev);
        const rev = row.rev + 1;
        set("rev", rev);
        set("updated_at", now);
        // Each update rewrites only the fields it changed, so two changes to one entry both land.
        yield* sql`UPDATE kin_records SET ${sql.csv(sets)}
          WHERE org_id = ${orgId} AND record_id = ${row.recordId}`;
        const seq = yield* logChange(
          orgId,
          writer,
          { recordId: row.recordId, key: row.key, rev },
          "updated",
          changes,
          now,
        );
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
          const withdrawal = {
            orgId,
            agentId: withdrawnFrom.agentId,
            recordId: row.recordId,
            key: row.key,
            seq,
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

  const query = Effect.fn("KinRecords.query")(function* (orgId: KinOrgId, input: QueryInput) {
    return yield* failed(
      Effect.gen(function* () {
        const now = input.at ?? (yield* Clock.currentTimeMillis);
        const where = [sql`r.org_id = ${orgId}`];
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
          where.push(
            sql`(r.due_at IS NULL OR r.due_at >= ${now} OR r.state IN ('done', 'dropped'))`,
          );
        if (input.dueBy !== undefined) where.push(sql`r.due_at <= ${input.dueBy}`);
        if (input.dueAfter !== undefined) where.push(sql`r.due_at >= ${input.dueAfter}`);
        if (input.category !== undefined) where.push(sql`r.category = ${input.category}`);
        if (input.side !== undefined) where.push(sql`r.side = ${input.side}`);
        if (input.keys !== undefined && input.keys.length > 0)
          where.push(sql`r.key IN ${sql.in(input.keys)}`);
        const text = input.text?.trim().toLowerCase();
        if (text !== undefined && text !== "")
          where.push(
            sql`(instr(lower(r.title), ${text}) > 0 OR instr(lower(r.notes), ${text}) > 0)`,
          );
        const filter = sql.and(where);
        const [count] = yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM kin_records r
          WHERE ${filter}`;
        const limit = Math.min(Math.max(input.limit ?? 50, 1), KIN_RECORDS_PAGE_CAP);
        const rows = yield* sql<RecordRow>`${selectRecords(sql)} WHERE ${filter}
          ORDER BY CASE r.state WHEN 'doing' THEN 0 WHEN 'waiting' THEN 1 WHEN 'open' THEN 2
              ELSE 3 END,
            r.due_at IS NULL, r.due_at, r.created_at, r.key
          LIMIT ${limit} OFFSET ${Math.max(input.offset ?? 0, 0)}`;
        return { rows, total: count?.total ?? 0, seq: yield* latestSeq(orgId).pipe(provideSql) };
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
    query,
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
