import {
  KinAgentId,
  KinChatError,
  KinNumberDecimal,
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
import { sectionOnFor } from "../shell/KinShell.ts";
import type { SectionId } from "../shell/sections.ts";
import { homeCurrency } from "../work/companyProfile.ts";
import { KinRecords, requestHashOf } from "../work/KinRecords.ts";
import { openPipelineValue } from "../work/deals.ts";
import { ownerLevelProgressOf, ownerLevelReceivedByCurrency } from "../work/goals.ts";
import { parseFields, fieldText } from "../work/lists.ts";
import { addUp, dayIn, monthOf } from "../work/money.ts";
import { ownerLevelInvoicedInMonth } from "../work/moneyViews.ts";
import { countedEntry, owedInvoices, ownerZone, startOfDay } from "../work/recordRows.ts";
import { countListStates } from "../work/registers.ts";
import { personSees } from "../work/teamView.ts";
import { latestValue, liveFeeds, numberFields, targetless, type NumberSpec } from "./numberRows.ts";

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
  readonly hasTarget: number;
  readonly ownerKind: string;
  readonly ownerId: string | null;
  readonly createdAt: number;
};

const definitions = Effect.fn("KinNumbers.definitions")(function* (
  viewer: Reader,
  keys: ReadonlyArray<string> | undefined,
  includeTargets = false,
) {
  const sql = yield* SqlClient.SqlClient;
  if (keys?.length === 0) return [];
  return yield* sql<Definition>`SELECT r.record_id AS "recordId", r.key, r.title AS name,
      r.fields_json AS fields, NOT (${targetless(sql)}) AS "hasTarget", r.owner_kind AS "ownerKind", r.owner_id AS "ownerId",
      r.created_at AS "createdAt"
    FROM kin_records r WHERE r.org_id = ${viewer.orgId} AND r.register_id = 'goals'
      AND ${countedEntry(sql)}
      AND (${targetless(sql)} AND json_extract(r.fields_json, '$.measure') = 'manual'
        ${includeTargets ? sql`OR NOT (${targetless(sql)})` : sql``})
      AND ${keys === undefined ? sql`1` : sql`r.key IN ${sql.in(keys)}`}
      AND ${seen(sql, viewer)}
    ORDER BY LENGTH(r.key), r.key`;
});

const definition = Effect.fn("KinNumbers.definition")(function* (
  viewer: Reader,
  key: string,
  includeTargets = false,
) {
  const [row] = yield* definitions(viewer, [key], includeTargets);
  if (row?.hasTarget === 1)
    return yield* invalid("That is a goal with a target. Change its current figure on the goal.");
  const fields = row === undefined ? undefined : numberFields(parseFields(row.fields));
  if (row === undefined || fields === undefined) return yield* missing;
  return { row, fields };
});

const computedSections = {
  pipeline_open: "deals",
  revenue_received: "money",
  overdue_over_30: "invoices",
  invoiced_this_month: "invoices",
  clients_won: "clients",
  tasks_done: null,
  count: { deals: "deals" },
} satisfies Record<
  Extract<typeof NumberSpec.Type, { builtin: string }>["builtin"],
  SectionId | null
> & {
  count: { deals: SectionId };
};

/** The section a computed number reads, whose switch hides it; null for any other number. */
const sectionOfSpec = (spec: typeof NumberSpec.Type | undefined): SectionId | null =>
  spec === undefined
    ? null
    : "builtin" in spec
      ? computedSections[spec.builtin]
      : spec.count === "deals"
        ? computedSections.count.deals
        : null;

const shownInShell = Effect.fn("KinNumbers.shownInShell")(function* (
  orgId: KinOrgId,
  spec: typeof NumberSpec.Type | undefined,
) {
  const section = sectionOfSpec(spec);
  return section === null || (yield* sectionOnFor(orgId, section));
});

const compute = Effect.fn("KinNumbers.compute")(function* (
  orgId: KinOrgId,
  spec: typeof NumberSpec.Type,
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

/** The value compared with the limits: a decimal, or the one currency a money total counts in. */
const comparable = (value: KinNumber["value"], unit: string | undefined) => {
  if (value === null) return undefined;
  if (typeof value === "string") return BigDecimal.fromStringUnsafe(value);
  const currency = unit?.toUpperCase();
  const counted = value.find(({ currency: code }) =>
    currency === undefined ? value.length === 1 : code === currency,
  );
  return counted === undefined
    ? undefined
    : BigDecimal.make(BigInt(counted.minor), kinCurrency(counted.currency).decimals);
};

/** The side of its limits the value is on, when it is outside them. */
const offSide = (
  value: KinNumber["value"],
  fields: NonNullable<ReturnType<typeof numberFields>>,
) => {
  const decimal = comparable(value, fields.unit);
  if (decimal === undefined) return undefined;
  if (
    fields.above !== undefined &&
    BigDecimal.Order(decimal, BigDecimal.fromStringUnsafe(fields.above)) > 0
  )
    return { side: "above" as const, limit: fields.above, value: BigDecimal.format(decimal) };
  if (
    fields.below !== undefined &&
    BigDecimal.Order(decimal, BigDecimal.fromStringUnsafe(fields.below)) < 0
  )
    return { side: "below" as const, limit: fields.below, value: BigDecimal.format(decimal) };
  return undefined;
};

const staleAt = (asOf: string, every: "day" | "week" | "month") => {
  const day = DateTime.makeUnsafe(asOf);
  const after =
    every === "month"
      ? DateTime.add(day, { months: 2 })
      : DateTime.add(day, { days: every === "day" ? 2 : 14 });
  return DateTime.formatIsoDateUtc(after);
};

/** A number as it stands at `now`: its latest or computed value, and how that sits by its rules. */
const evaluate = Effect.fn("KinNumbers.evaluate")(function* (
  orgId: KinOrgId,
  row: Definition,
  fields: NonNullable<ReturnType<typeof numberFields>>,
  now: number,
  today: string,
  zone: string,
) {
  const recorded =
    fields.spec === undefined ? yield* latestValue(orgId, row.recordId, today) : undefined;
  const value =
    fields.spec === undefined
      ? (recorded?.value ?? null)
      : yield* compute(orgId, fields.spec, row, now, today, zone);
  const asOf = fields.spec === undefined ? (recorded?.asOf ?? null) : today;
  return {
    value,
    asOf,
    off: offSide(value, fields),
    stale:
      fields.every !== undefined &&
      fields.spec === undefined &&
      today > staleAt(asOf ?? dayIn(row.createdAt, zone), fields.every),
    source: recorded?.source ?? fields.source,
  };
});

/**
 * Every watched number at owner level, whatever its section's switch, for Kin's own senses: its
 * keeper (the agent holding it), the section a computed one reads, and how it stands at `now`.
 */
export const ownerLevelNumbers = Effect.fn("KinNumbers.ownerLevelNumbers")(function* (
  orgId: KinOrgId,
  now: number,
  options?: { readonly recordedOnly?: boolean },
) {
  const zone = yield* ownerZone(orgId);
  const today = dayIn(now, zone);
  const out = [];
  for (const row of yield* definitions({ orgId }, undefined)) {
    const fields = numberFields(parseFields(row.fields));
    if (fields === undefined || (options?.recordedOnly === true && fields.kind !== "recorded"))
      continue;
    out.push({
      recordId: row.recordId,
      key: row.key,
      name: row.name,
      unit: fields.unit,
      every: fields.every,
      kind: fields.kind,
      above: fields.above,
      below: fields.below,
      /** The definition's source line, which a feed's card set; a value's own may differ. */
      definedSource: fields.source,
      keeper: row.ownerKind === "agent" && row.ownerId !== null ? row.ownerId : undefined,
      section: sectionOfSpec(fields.spec),
      ...(yield* evaluate(orgId, row, fields, now, today, zone)),
    });
  }
  return out;
});

const readSnapshot = Effect.fn("KinNumbers.readSnapshot")(function* <A, E, R>(
  who: Viewer,
  effect: Effect.Effect<A, E, R>,
) {
  const sql = yield* SqlClient.SqlClient;
  const snapshot = sql.withTransaction(effect);
  return yield* who._tag === "person" ? readOnly(snapshot) : snapshot;
});

const listing = Effect.fn("KinNumbers.listing")(
  function* (who: Viewer, keys?: ReadonlyArray<string>) {
    return yield* readSnapshot(
      who,
      Effect.gen(function* () {
        const viewer = yield* reader(who, "numbers_read", keys);
        const now = yield* Clock.currentTimeMillis;
        const zone = yield* ownerZone(viewer.orgId);
        const today = dayIn(now, zone);
        const numbers: Array<KinNumber> = [];
        const kept: Array<string> = [];
        for (const row of yield* definitions(viewer, keys)) {
          const fields = numberFields(parseFields(row.fields));
          if (fields === undefined || !(yield* shownInShell(viewer.orgId, fields.spec))) continue;
          if (
            who._tag === "agent" &&
            fields.kind === "recorded" &&
            row.ownerKind === "agent" &&
            row.ownerId === who.agentId
          )
            kept.push(row.key);
          const standing = yield* evaluate(viewer.orgId, row, fields, now, today, zone);
          numbers.push({
            key: row.key,
            name: row.name,
            ...(fields.unit === undefined ? {} : { unit: fields.unit }),
            value: standing.value,
            asOf: standing.asOf,
            ...(fields.direction === undefined ? {} : { direction: fields.direction }),
            ...(fields.above === undefined ? {} : { above: fields.above }),
            ...(fields.below === undefined ? {} : { below: fields.below }),
            off: standing.off !== undefined,
            stale: standing.stale,
            ...(standing.source === undefined ? {} : { source: standing.source }),
            canType:
              who._tag === "person" &&
              fields.kind !== "computed" &&
              (viewer.member === undefined || fields.kind === "typed"),
          });
        }
        return { numbers, kept };
      }),
    );
  },
  Effect.catchTags({ SqlError: unavailable, PersistenceSqlError: unavailable }),
);

export const list = Effect.fn("KinNumbers.list")(function* (
  who: Viewer,
  keys?: ReadonlyArray<string>,
) {
  return { numbers: (yield* listing(who, keys)).numbers };
});

/**
 * The numbers an agent's turn is told of, as `numbers_read` would list them for it, and the
 * recorded ones it keeps. Refused, as that tool is, in a turn anyone below owner level reads.
 */
export const forAgent = Effect.fn("KinNumbers.forAgent")(
  function* (agent: Agent) {
    const { numbers, kept } = yield* listing(agent);
    const watched = numbers.map(({ key, name, unit, above, below }) => ({
      key,
      name,
      ...(unit === undefined ? {} : { unit }),
      ...(above === undefined ? {} : { above }),
      ...(below === undefined ? {} : { below }),
    }));
    if (kept.length === 0) return { watched, kept: [] };
    // Feeds are the agent's own schedules; the source each of its numbers names says which runs it.
    const feeds = (yield* liveFeeds(agent.orgId)).filter((one) => one.agentId === agent.agentId);
    const definitions = yield* sourcesOf(agent.orgId, kept);
    return {
      watched,
      kept: numbers
        .filter(({ key }) => kept.includes(key))
        .map(({ key, name }) => {
          const source = definitions.get(key);
          const feed = feeds.find((one) => one.feed.source === source)?.feed;
          return {
            key,
            name,
            ...(feed === undefined
              ? {}
              : { feed: { source: feed.source, every: feed.every, at: feed.at } }),
          };
        }),
    };
  },
  Effect.catchTags({ SqlError: unavailable }),
);

/** Each kept number's own source line, by key. */
const sourcesOf = Effect.fn("KinNumbers.sources")(function* (
  orgId: KinOrgId,
  keys: ReadonlyArray<string>,
) {
  const rows = yield* definitions({ orgId }, keys);
  return new Map(
    rows.flatMap((row) => {
      const source = numberFields(parseFields(row.fields))?.source;
      return source === undefined ? [] : [[row.key, source] as const];
    }),
  );
});

export const values = Effect.fn("KinNumbers.values")(
  function* (who: Viewer, number: string, from: string, to: string) {
    return yield* readSnapshot(
      who,
      Effect.gen(function* () {
        const viewer = yield* reader(who, "numbers_read", { number, from, to });
        if (from > to) return yield* invalid("The end day comes on or after the start day.");
        const { row, fields } = yield* definition(viewer, number);
        if (!(yield* shownInShell(viewer.orgId, fields.spec))) return yield* missing;
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
const normalizeDecimal = (value: string) =>
  value.replace(/^(-?)0+(?=\d)/, "$1").replace(/^-(?=0(?:\.0+)?$)/, "");

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
        const today = dayIn(now, yield* ownerZone(orgId));
        const tomorrow = DateTime.formatIsoDateUtc(
          DateTime.add(DateTime.makeUnsafe(today), { days: 1 }),
        );
        if (entries.some((entry) => entry.asOf > tomorrow))
          return yield* invalid("A value can't be dated in the future.");
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
          const { row, fields } = yield* definition(viewer, entry.number, true);
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
          const value = normalizeDecimal(entry.value);
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
            last?.value === value &&
            last.source === source &&
            last.personId === personId &&
            last.agentId === agentId
          )
            continue;
          yield* sql`INSERT INTO kin_number_values (org_id, record_id, as_of, seq, value, person_id,
          agent_id, recorder_name, source, created_at, write_key, request_hash)
        VALUES (${orgId}, ${row.recordId}, ${entry.asOf}, ${(last?.seq ?? 0) + 1}, ${value},
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

const isDecimal = Schema.is(KinNumberDecimal);

/**
 * The owner or a co-owner sets or clears a watched number's limits: a decimal sets one, null
 * clears it, absent leaves it. The number as it then reads.
 */
export const setLimit = Effect.fn("KinNumbers.setLimit")(function* (
  person: PersonIdentity,
  key: string,
  limits: { readonly above?: string | null; readonly below?: string | null },
) {
  const role = yield* accessOf(person.orgId, person.personId);
  if (role === undefined) return yield* missing;
  if (!kinOwnerLevel(role))
    return yield* denied("Only the owner or a co-owner sets a number's limits.");
  if ([limits.above, limits.below].some((limit) => typeof limit === "string" && !isDecimal(limit)))
    return yield* invalid("A limit is a plain decimal, such as 1000 or 2.5.");
  yield* definition({ orgId: person.orgId }, key);
  yield* (yield* KinRecords).update(
    person.orgId,
    {
      actor: { _tag: "person", personId: person.personId },
      via: "owner",
      askedBy: person.personId,
    },
    key,
    {
      fields: {
        ...(limits.above === undefined ? {} : { above: limits.above }),
        ...(limits.below === undefined ? {} : { below: limits.below }),
      },
    },
  );
  return (yield* list(person, [key])).numbers[0];
});

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
