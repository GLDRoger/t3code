import {
  KinAgentId,
  KinChatError,
  KinNumberValueInput,
  KinPersonId,
  isKinCurrency,
  kinCurrency,
  kinOwnerLevel,
  type KinNumber,
  type KinOrgId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import { readOnly } from "@t3tools/shared/nodeSqliteClient";
import * as BigDecimal from "effect/BigDecimal";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { effectiveAudience, SHARED_REFUSAL } from "../lead/Audience.ts";
import { outsideToolAllowed, OUTSIDE_REFUSAL } from "../lead/OutsideContent.ts";
import { accessOf } from "../people/KinAccess.ts";
import { homeCurrency } from "../work/companyProfile.ts";
import { requestHashOf } from "../work/KinRecords.ts";
import { openPipelineValue } from "../work/deals.ts";
import { ownerLevelProgressOf, ownerLevelReceivedByCurrency } from "../work/goals.ts";
import { parseFields, fieldText } from "../work/lists.ts";
import { addUp, dayIn, monthOf } from "../work/money.ts";
import { ownerLevelInvoicedInMonth } from "../work/moneyViews.ts";
import { countedEntry, owedInvoices, ownerZone, startOfDay } from "../work/recordRows.ts";
import { countListStates } from "../work/registers.ts";
import { personSees } from "../work/teamView.ts";
import { latestValue, numberFields, targetless } from "./numberRows.ts";

type Agent = {
  readonly _tag: "agent";
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly wakeupId: string;
};
type Viewer = PersonIdentity | Agent;
type Reader = { readonly orgId: KinOrgId; readonly member?: KinPersonId };
const missing = new KinChatError({
  reason: "not_found",
  message: "Kin couldn't find that number.",
});
const denied = (message: string) => new KinChatError({ reason: "not_allowed", message });
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const unavailable = (cause: unknown) =>
  Effect.logWarning("Kin numbers query failed", { cause }).pipe(
    Effect.andThen(
      Effect.fail(new KinChatError({ reason: "unavailable", message: "Kin is unavailable." })),
    ),
  );

const reader = Effect.fn("KinNumbers.reader")(function* (
  viewer: Viewer,
  tool: "number_record" | "numbers_read",
  input: unknown,
): Effect.fn.Return<
  Reader,
  KinChatError | Effect.Error<ReturnType<typeof accessOf>>,
  SqlClient.SqlClient
> {
  const { orgId } = viewer;
  if (viewer._tag === "agent") {
    if ((yield* effectiveAudience(viewer)) !== "owner_only") return yield* denied(SHARED_REFUSAL);
    if (!(yield* outsideToolAllowed(viewer, tool, input))) return yield* denied(OUTSIDE_REFUSAL);
    return { orgId };
  }
  const role = yield* accessOf(orgId, viewer.personId);
  if (role === undefined) return yield* missing;
  return kinOwnerLevel(role) ? { orgId } : { orgId, member: viewer.personId };
});

const seen = (sql: SqlClient.SqlClient, viewer: Reader) =>
  viewer.member === undefined ? sql`1` : personSees(sql, viewer.member);

type Definition = {
  readonly recordId: string;
  readonly key: string;
  readonly name: string;
  readonly fields: string;
  readonly ownerKind: string;
  readonly ownerId: string | null;
  readonly createdAt: number;
};

const definitions = Effect.fn("KinNumbers.definitions")(function* (
  viewer: Reader,
  keys: ReadonlyArray<string> | undefined,
  targets: boolean,
) {
  const sql = yield* SqlClient.SqlClient;
  if (keys?.length === 0) return [];
  return yield* sql<Definition>`SELECT r.record_id AS "recordId", r.key, r.title AS name,
      r.fields_json AS fields, r.owner_kind AS "ownerKind", r.owner_id AS "ownerId",
      r.created_at AS "createdAt"
    FROM kin_records r WHERE r.org_id = ${viewer.orgId} AND r.register_id = 'goals'
      AND ${countedEntry(sql)} AND json_extract(r.fields_json, '$.measure') = 'manual'
      AND ${targets ? sql`1` : targetless(sql)}
      AND ${keys === undefined ? sql`1` : sql`r.key IN ${sql.in(keys)}`}
      AND ${seen(sql, viewer)}
    ORDER BY LENGTH(r.key), r.key`;
});

const definition = Effect.fn("KinNumbers.definition")(function* (viewer: Reader, key: string) {
  const [row] = yield* definitions(viewer, [key], viewer.member === undefined);
  const fields = row === undefined ? undefined : numberFields(parseFields(row.fields));
  if (row === undefined || fields === undefined) return yield* missing;
  return { row, fields };
});

const compute = Effect.fn("KinNumbers.compute")(function* (
  orgId: KinOrgId,
  spec: typeof import("./numberRows.ts").NumberSpec.Type,
  row: Definition,
  now: number,
  today: string,
  zone: string,
) {
  if ("count" in spec) return String(yield* countListStates(orgId, spec.count, spec.states));
  const fields = parseFields(row.fields);
  const start = fieldText(fields, "startsOn") ?? dayIn(row.createdAt, zone);
  switch (spec.builtin) {
    case "revenue_received":
      return yield* ownerLevelReceivedByCurrency(orgId, start, today);
    case "clients_won":
    case "tasks_done":
      return String(
        yield* ownerLevelProgressOf(orgId, spec.builtin, {
          start: startOfDay(start, zone),
          startsOn: start,
          until: now,
          untilDay: today,
          currency: "",
          manual: 0,
        }),
      );
    case "overdue_over_30":
      return addUp(
        (yield* owedInvoices({ orgId, now }))
          .filter((row) => row.daysOverdue > 30)
          .map((row) => row.balance),
        yield* homeCurrency(orgId),
      );
    case "pipeline_open":
      return yield* openPipelineValue(orgId);
    case "invoiced_this_month":
      return yield* ownerLevelInvoicedInMonth(orgId, monthOf(today), zone);
  }
});

const offBound = (
  value: KinNumber["value"],
  fields: NonNullable<ReturnType<typeof numberFields>>,
) => {
  const off = (decimal: BigDecimal.BigDecimal) =>
    (fields.above !== undefined &&
      BigDecimal.Order(decimal, BigDecimal.fromStringUnsafe(fields.above)) > 0) ||
    (fields.below !== undefined &&
      BigDecimal.Order(decimal, BigDecimal.fromStringUnsafe(fields.below)) < 0);
  if (value === null) return false;
  if (typeof value === "string") return off(BigDecimal.fromStringUnsafe(value));
  const currency = fields.unit?.toUpperCase();
  return value.some(
    ({ currency: code, minor }) =>
      (currency === undefined ? value.length === 1 : code === currency) &&
      off(BigDecimal.make(BigInt(minor), kinCurrency(code).decimals)),
  );
};

const staleAt = (asOf: string, every: "day" | "week" | "month") => {
  const day = DateTime.makeUnsafe(asOf);
  const after =
    every === "month"
      ? DateTime.add(day, { months: 2 })
      : DateTime.add(day, { days: every === "day" ? 2 : 14 });
  return DateTime.formatIsoDateUtc(after);
};

const readSnapshot = Effect.fn("KinNumbers.readSnapshot")(function* <A, E, R>(
  who: Viewer,
  effect: Effect.Effect<A, E, R>,
) {
  const sql = yield* SqlClient.SqlClient;
  const snapshot = sql.withTransaction(effect);
  return yield* who._tag === "person" ? readOnly(snapshot) : snapshot;
});

export const list = Effect.fn("KinNumbers.list")(
  function* (who: Viewer, keys?: ReadonlyArray<string>) {
    return yield* readSnapshot(
      who,
      Effect.gen(function* () {
        const viewer = yield* reader(who, "numbers_read", keys);
        const now = yield* Clock.currentTimeMillis;
        const zone = yield* ownerZone(viewer.orgId);
        const today = dayIn(now, zone);
        const numbers: Array<KinNumber> = [];
        for (const row of yield* definitions(viewer, keys, false)) {
          const fields = numberFields(parseFields(row.fields));
          if (fields === undefined) continue;
          const recorded =
            fields.spec === undefined
              ? yield* latestValue(viewer.orgId, row.recordId, today)
              : undefined;
          const value =
            fields.spec === undefined
              ? (recorded?.value ?? null)
              : yield* compute(viewer.orgId, fields.spec, row, now, today, zone);
          const asOf = fields.spec === undefined ? (recorded?.asOf ?? null) : today;
          const source = recorded?.source ?? fields.source;
          numbers.push({
            key: row.key,
            name: row.name,
            ...(fields.unit === undefined ? {} : { unit: fields.unit }),
            value,
            asOf,
            ...(fields.direction === undefined ? {} : { direction: fields.direction }),
            ...(fields.above === undefined ? {} : { above: fields.above }),
            ...(fields.below === undefined ? {} : { below: fields.below }),
            off: offBound(value, fields),
            stale:
              fields.every !== undefined &&
              fields.spec === undefined &&
              today > staleAt(asOf ?? dayIn(row.createdAt, zone), fields.every),
            ...(source === undefined ? {} : { source }),
            canType:
              who._tag === "person" &&
              fields.kind !== "computed" &&
              (viewer.member === undefined || fields.kind === "typed"),
          });
        }
        return { numbers };
      }),
    );
  },
  Effect.catchTags({ SqlError: unavailable, PersistenceSqlError: unavailable }),
);

export const values = Effect.fn("KinNumbers.values")(
  function* (who: Viewer, number: string, from: string, to: string) {
    return yield* readSnapshot(
      who,
      Effect.gen(function* () {
        const viewer = yield* reader(who, "numbers_read", { number, from, to });
        if (from > to) return yield* invalid("The end day comes on or after the start day.");
        const { row } = yield* definition(viewer, number);
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          asOf: string;
          value: string;
          source: string | null;
          personId: string | null;
          agentId: string | null;
          name: string;
        }>`SELECT as_of AS "asOf", value, source, person_id AS "personId", agent_id AS "agentId",
      recorder_name AS name FROM kin_number_values
    WHERE org_id = ${viewer.orgId} AND record_id = ${row.recordId} AND as_of BETWEEN ${from} AND ${to}
    ORDER BY as_of, seq`;
        return {
          number: row.key,
          values: rows.map((entry) => ({
            value: entry.value,
            asOf: entry.asOf,
            ...(entry.source === null ? {} : { source: entry.source }),
            by:
              entry.personId === null
                ? { kind: "agent" as const, id: KinAgentId.make(entry.agentId!), name: entry.name }
                : {
                    kind: "person" as const,
                    id: KinPersonId.make(entry.personId),
                    name: entry.name,
                  },
          })),
        };
      }),
    );
  },
  Effect.catchTags({ SqlError: unavailable, PersistenceSqlError: unavailable }),
);

const validValue = Schema.is(KinNumberValueInput);

export const record = Effect.fn("KinNumbers.record")(
  function* (by: Viewer, entries: ReadonlyArray<KinNumberValueInput>, clientRequestId?: string) {
    if (entries.length < 1 || entries.length > 50 || !entries.every(validValue))
      return yield* invalid(
        "Give 1 to 50 values, each with a number, a decimal value and a real as-of day.",
      );
    const sql = yield* SqlClient.SqlClient;
    const refresh = yield* KinRefreshObserver;
    const now = yield* Clock.currentTimeMillis;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const viewer = yield* reader(by, "number_record", { values: entries });
        const orgId = viewer.orgId;
        const [author] =
          by._tag === "person"
            ? yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
          WHERE org_id = ${orgId} AND person_id = ${by.personId}`
            : yield* sql<{ name: string }>`SELECT a.display_name AS name FROM kin_agents a
          JOIN kin_wakeups w ON w.org_id = a.org_id AND w.agent_id = a.agent_id
          WHERE a.org_id = ${orgId} AND a.agent_id = ${by.agentId} AND a.retired_at IS NULL
            AND a.role = 'lead' AND w.wakeup_id = ${by.wakeupId} AND w.status = 'running'`;
        if (author === undefined) return yield* missing;
        const personId = by._tag === "person" ? by.personId : null;
        const agentId = by._tag === "agent" ? by.agentId : null;
        const payload = { clientRequestId: clientRequestId ?? "", entries };
        const hash = requestHashOf(payload);
        const request =
          by._tag === "agent"
            ? stableStringify(["agent", by.agentId, by.wakeupId, hash])
            : clientRequestId === undefined
              ? undefined
              : stableStringify(["person", by.personId, clientRequestId]);
        let changed = false;
        for (const [index, entry] of entries.entries()) {
          const { row, fields } = yield* definition(viewer, entry.number);
          if (fields.kind === "computed")
            return yield* denied("Kin computes that number from its records.");
          if (
            viewer.member !== undefined &&
            (fields.kind !== "typed" || entry.source !== undefined)
          )
            return yield* denied("A teammate may only type a number shared with them.");
          if (
            by._tag === "agent" &&
            (fields.kind !== "recorded" ||
              row.ownerKind !== "agent" ||
              row.ownerId !== by.agentId ||
              entry.source === undefined)
          )
            return yield* denied("An agent may only record a sourced value for a number it keeps.");
          const currency = fields.unit?.toUpperCase();
          if (
            currency !== undefined &&
            isKinCurrency(currency) &&
            (entry.value.split(".")[1]?.length ?? 0) > kinCurrency(currency).decimals
          )
            return yield* invalid("Use the precision of the number's currency.");
          const source = entry.source ?? null;
          const writeKey = request === undefined ? null : `${request}:${index}`;
          const written =
            writeKey === null
              ? undefined
              : (yield* sql<{ hash: string }>`SELECT
          request_hash AS hash FROM kin_number_values WHERE org_id = ${orgId} AND write_key = ${writeKey}`)[0];
          if (written !== undefined) {
            if (written.hash !== hash)
              return yield* denied(
                "That recording request was already used with different values.",
              );
            continue;
          }
          const [last] = yield* sql<{
            seq: number;
            value: string;
            source: string | null;
            personId: string | null;
            agentId: string | null;
          }>`SELECT
          seq, value, source, person_id AS "personId", agent_id AS "agentId"
        FROM kin_number_values WHERE org_id = ${orgId} AND record_id = ${row.recordId} AND as_of = ${entry.asOf}
        ORDER BY seq DESC LIMIT 1`;
          if (
            writeKey === null &&
            last?.value === entry.value &&
            last.source === source &&
            last.personId === personId &&
            last.agentId === agentId
          )
            continue;
          yield* sql`INSERT INTO kin_number_values (org_id, record_id, as_of, seq, value, person_id,
          agent_id, recorder_name, source, created_at, write_key, request_hash)
        VALUES (${orgId}, ${row.recordId}, ${entry.asOf}, ${(last?.seq ?? 0) + 1}, ${entry.value},
          ${personId}, ${agentId}, ${author.name}, ${source}, ${now}, ${writeKey}, ${hash})`;
          changed = true;
        }
        if (changed) yield* refresh.touch(orgId, "numbers");
        return { recorded: entries.length };
      }),
    );
  },
  Effect.catchTags({ SqlError: unavailable, PersistenceSqlError: unavailable }),
);

export const visibleValueRevision = Effect.fn("KinNumbers.visibleValueRevision")(function* (
  person: PersonIdentity,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    recordId: string;
    count: number;
  }>`SELECT r.record_id AS "recordId", COUNT(*) AS count
    FROM kin_number_values v JOIN kin_records r ON r.org_id = v.org_id AND r.record_id = v.record_id
    WHERE v.org_id = ${person.orgId} AND r.register_id = 'goals' AND ${targetless(sql)}
      AND ${countedEntry(sql)} AND ${personSees(sql, person.personId)}
    GROUP BY r.record_id ORDER BY r.record_id`;
  return rows.map(({ recordId, count }) => `${recordId.length}:${recordId}:${count}`).join(",");
});

export class KinNumbers extends Context.Service<
  KinNumbers,
  {
    readonly list: (
      ...args: Parameters<typeof list>
    ) => Effect.Effect<Effect.Success<ReturnType<typeof list>>, KinChatError>;
    readonly values: (
      ...args: Parameters<typeof values>
    ) => Effect.Effect<Effect.Success<ReturnType<typeof values>>, KinChatError>;
    readonly record: (
      ...args: Parameters<typeof record>
    ) => Effect.Effect<Effect.Success<ReturnType<typeof record>>, KinChatError>;
  }
>()("t3/kin/numbers/KinNumbers") {}

export const layer = Layer.effect(
  KinNumbers,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const refresh = yield* KinRefreshObserver;
    return KinNumbers.of({
      list: Effect.fnUntraced(function* (...args: Parameters<typeof list>) {
        return yield* list(...args).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      }),
      values: Effect.fnUntraced(function* (...args: Parameters<typeof values>) {
        return yield* values(...args).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      }),
      record: Effect.fnUntraced(function* (...args: Parameters<typeof record>) {
        return yield* record(...args).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(KinRefreshObserver, refresh),
        );
      }),
    });
  }),
);
