import {
  KinBudget as Budget,
  KinBudgetLimits,
  type KinAgentId,
  KinChatError,
  KinChatId,
  type KinEvent,
  KinMessageId,
  type KinMessageWhen,
  type KinOrgId,
  type KinPersonId,
  type KinWakeupId,
  type ThreadId,
  type TurnTokenUsage,
  type OrchestrationV2ProviderTurnTokenUsage,
  formatKinWhen,
  KIN_TEXT_LOCALE,
  canonicalTimeZone,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { isSqlError } from "effect/sql/SqlError";
import * as SqlClient from "effect/sql/SqlClient";
import { toPersistenceSqlError, PersistenceSqlError } from "../../persistence/Errors.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import * as Chat from "../chat/KinChatRepository.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as MemoryCache from "../memory/MemoryCache.ts";
import * as Queue from "./KinEventQueue.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "./orgLeads.ts";
import { isOrgOwner } from "./orgState.ts";
import { ownerLevelSql } from "../people/KinAccess.ts";

type Priority = "P0" | "P1" | "P2" | "P3" | "P4";
export type Usage = {
  readonly providerTurnId: string;
  readonly turnTokenUsage?: TurnTokenUsage;
  readonly tokenUsage?: OrchestrationV2ProviderTurnTokenUsage;
  readonly usedTokens?: number | undefined;
};
type BudgetError = KinChatError | PersistenceSqlError;
/** Whose work a limit held back: the owner's own, or a teammate's. */
export type HeldBy = "org" | "teammates";
type Admission = {
  readonly allowed: boolean;
  readonly atLimit: boolean;
  readonly nextReset: number;
  readonly remaining: number;
  readonly heldBy: HeldBy | null;
};
/** Who a turn's event was asked by: a teammate's request never spends as the owner's. */
export const askedByTeammate = (event: KinEvent, ownerLevel: ReadonlySet<string>) =>
  ("origin" in event &&
    event.origin?.personId !== undefined &&
    !ownerLevel.has(event.origin.personId)) ||
  (event._tag === "github" && event.askedBy !== undefined && !ownerLevel.has(event.askedBy)) ||
  (event.provenance._tag === "human" && !ownerLevel.has(event.provenance.personId));
type Charge = {
  readonly orgId: KinOrgId;
  readonly wakeupId: KinWakeupId;
  readonly day: string;
  readonly units: number;
  readonly tokensJson: string;
};
// JSON has no representation for non-finite counters; retain their diagnostic values as strings.
const usageJsonValue = (value: unknown): unknown => {
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return value.map(usageJsonValue);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, usageJsonValue(item)]),
    );
  return value;
};
// No limit until the owner sets one: a limit nobody chose must never hold the company back.
const defaults: KinBudgetLimits = { leadUnits: null, workerUnits: null, teammateUnits: null };
export const USUAL_LIMITS = { leadUnits: 2_000_000, workerUnits: 6_000_000 };
const WARN_AT = 0.8;
const CHAT_TAGS = ["chat.message", "widget.action", "chat.reaction"];
const decodeLimits = Schema.decodeUnknownEffect(KinBudgetLimits);
const decodeStoredLimits = Schema.decodeUnknownEffect(Schema.fromJsonString(KinBudgetLimits));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const notFound = new KinChatError({ reason: "not_found", message: "Kin budget record not found." });
const notAllowed = new KinChatError({
  reason: "not_allowed",
  message: "Kin budget operation not allowed.",
});
const invalid = new KinChatError({ reason: "invalid_state", message: "Invalid Kin budget data." });
const isChatError = Schema.is(KinChatError);
const isPersistenceError = Schema.is(PersistenceSqlError);
const mapError = (cause: unknown): BudgetError =>
  isSqlError(cause)
    ? toPersistenceSqlError("KinBudget")(cause)
    : isChatError(cause) || isPersistenceError(cause)
      ? cause
      : invalid;

/** What waits on the daily limit, by agent: everything the owner's view or a lead may name. */
export const heldWork = Effect.fn("KinBudget.waiting")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    agentId: KinAgentId;
    name: string;
    requests: number;
    tasks: number;
    other: number;
    until: number | null;
  }>`SELECT e.agent_id AS "agentId", COALESCE(l.name, e.agent_id) AS name,
      SUM(CASE WHEN e.tag IN ${sql.in(CHAT_TAGS)} THEN 1 ELSE 0 END) AS requests,
      SUM(CASE WHEN e.tag = 'record.changed' THEN 1 ELSE 0 END) AS tasks,
      SUM(CASE WHEN e.tag NOT IN ${sql.in([...CHAT_TAGS, "record.changed"])} THEN 1 ELSE 0 END)
        AS other,
      MAX(e.not_before) AS until
    FROM kin_events e LEFT JOIN kin_leads l ON l.org_id = e.org_id AND l.agent_id = e.agent_id
    WHERE e.org_id = ${orgId} AND e.state = 'queued' AND e.budget_deferred = 1
    GROUP BY e.agent_id ORDER BY name, e.agent_id`;
  const until = Math.max(0, ...rows.map((row) => row.until ?? 0));
  return {
    until: until === 0 ? null : DateTime.formatIso(DateTime.makeUnsafe(until)),
    agents: rows.map(({ until: _until, ...row }) => row),
  };
});

/**
 * Whether teammates' turns have any daily limit: their own, else the agents'. With none, the
 * per-teammate turn cap (`LeadAccess.dailyTurns`) is lifted too; with any, it stays.
 */
export const teammatesLimited = Effect.fn("KinBudget.teammatesLimited")(function* (
  orgId: KinOrgId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [stored] = yield* sql<{ limits: string }>`SELECT limits_json AS limits
    FROM kin_budget_limits WHERE org_id = ${orgId}`;
  if (stored === undefined) return false;
  // Unreadable limits keep the cap, as they would keep a limit.
  return yield* decodeStoredLimits(stored.limits).pipe(
    Effect.map((limits) => (limits.teammateUnits ?? limits.leadUnits) !== null),
    Effect.orElseSucceed(() => true),
  );
});

export class KinBudget extends Context.Service<
  KinBudget,
  {
    readonly view: (
      people: ReadonlyArray<PersonIdentity>,
      orgId: KinOrgId,
    ) => Effect.Effect<Budget, BudgetError>;
    readonly get: (orgId: KinOrgId) => Effect.Effect<Budget, BudgetError>;
    readonly set: (
      people: ReadonlyArray<PersonIdentity>,
      input: { readonly orgId: KinOrgId; readonly limits: KinBudgetLimits },
    ) => Effect.Effect<Budget, BudgetError>;
    readonly admit: (
      orgId: KinOrgId,
      priority: Priority,
      asker?: "owner" | "teammate",
    ) => Effect.Effect<Admission, BudgetError>;
    /**
     * Returns events a limit held back to the queue until the reset, and in the same transaction
     * posts the line whoever asked sees in that chat and the owner's one notice a day per limit.
     */
    readonly defer: (input: {
      readonly orgId: KinOrgId;
      readonly agentId: KinAgentId;
      readonly wakeupId: KinWakeupId;
      readonly events: ReadonlyArray<KinEvent>;
      readonly heldBy: HeldBy;
      readonly nextReset: number;
    }) => Effect.Effect<void, BudgetError>;
    /** Today's notice to the owner for a limit that was reached, once a day. */
    readonly notifyOwner: (orgId: KinOrgId, heldBy: HeldBy) => Effect.Effect<void, BudgetError>;
    /** Whether today's limit for delegated tasks leaves room for another. */
    readonly admitTask: (orgId: KinOrgId) => Effect.Effect<boolean, BudgetError>;
    readonly promptContext: (orgId: KinOrgId) => Effect.Effect<string, BudgetError>;
    readonly charge: (input: {
      readonly orgId: KinOrgId;
      readonly wakeupId: KinWakeupId;
      readonly usage: ReadonlyArray<Usage>;
    }) => Effect.Effect<Charge, BudgetError>;
    /** A delegated task's thread bills `workerUnits` only, on the day it was first charged. */
    readonly chargeTask: (input: {
      readonly orgId: KinOrgId;
      readonly threadId: ThreadId;
      readonly usage: ReadonlyArray<Usage>;
    }) => Effect.Effect<{ readonly day: string; readonly units: number }, BudgetError>;
  }
>()("t3/kin/lead/KinBudget") {}

const validZone = (zone: string | null) => {
  if (zone === null) return null;
  try {
    return canonicalTimeZone(zone);
  } catch {
    return null;
  }
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cache = yield* MemoryCache.MemoryCache;
  const queue = yield* Queue.KinEventQueue;
  const chat = yield* Chat.KinChatRepository;
  const hub = yield* Hub.KinChatHub;
  const period = Effect.fn("KinBudget.period")(function* (orgId: KinOrgId) {
    const now = yield* Clock.currentTimeMillis;
    const zone = yield* cache.ownerTimeZone(orgId);
    const local = DateTime.makeZonedUnsafe(now, { timeZone: zone });
    return {
      day: DateTime.formatIsoDate(local),
      nextReset: DateTime.toEpochMillis(DateTime.add(DateTime.startOf(local, "day"), { days: 1 })),
      now,
    };
  });
  const ensure = Effect.fn("KinBudget.ensure")(function* (orgId: KinOrgId, day: string) {
    const rows = yield* sql`SELECT 1 FROM kin_orgs WHERE org_id = ${orgId}`;
    if (rows.length === 0) return yield* notFound;
    yield* sql`INSERT INTO kin_budget (org_id, day) VALUES (${orgId}, ${day}) ON CONFLICT DO NOTHING RETURNING org_id`;
  });
  const byLead = Effect.fn("KinBudget.byLead")(function* (orgId: KinOrgId, day: string) {
    return yield* sql<{ agentId: KinAgentId; name: string; leadUnits: number }>`
      SELECT w.agent_id AS "agentId", COALESCE(l.name, w.agent_id) AS name,
        SUM(c.units) AS "leadUnits"
      FROM kin_budget_charges c
      JOIN kin_wakeups w ON w.org_id = c.org_id AND w.wakeup_id = c.wakeup_id
      LEFT JOIN kin_leads l ON l.org_id = w.org_id AND l.agent_id = w.agent_id
      WHERE c.org_id = ${orgId} AND c.day = ${day}
      GROUP BY w.agent_id ORDER BY "leadUnits" DESC, w.agent_id`;
  });
  // A turn is a teammate's when any event in it was asked by someone below the owner's level.
  const askedByTeammates = (orgId: KinOrgId, wakeupId: KinWakeupId) =>
    sql`EXISTS (SELECT 1 FROM kin_events e
      JOIN kin_agents a ON a.org_id = e.org_id AND a.agent_id = e.agent_id
      WHERE e.org_id = ${orgId} AND e.wakeup_id = ${wakeupId}
        AND ((json_extract(e.json, '$.origin.personId') IS NOT NULL
            AND NOT ${sql.literal(ownerLevelSql("e.org_id", "json_extract(e.json, '$.origin.personId')"))})
          OR (json_extract(e.json, '$.provenance._tag') = 'human'
            AND json_extract(e.json, '$.provenance.personId') <> a.owner_person_id
            AND NOT ${sql.literal(ownerLevelSql("e.org_id", "json_extract(e.json, '$.provenance.personId')"))})
          OR (e.tag = 'github' AND json_extract(e.json, '$.askedBy') <> a.owner_person_id
            AND NOT ${sql.literal(ownerLevelSql("e.org_id", "json_extract(e.json, '$.askedBy')"))})))`;
  const waiting = (orgId: KinOrgId) =>
    heldWork(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const limitsOf = Effect.fn("KinBudget.limitsOf")(function* (stored: string | null) {
    if (stored === null) return defaults;
    const limits = yield* decodeStoredLimits(stored);
    return { ...limits, teammateUnits: limits.teammateUnits ?? null };
  });
  // `full` adds what only the owner's view needs: who spent it, and what waits.
  const snapshot = Effect.fn("KinBudget.snapshot")(function* (
    orgId: KinOrgId,
    day: string,
    full = false,
  ) {
    const [row] = yield* sql<{
      leadUnits: number;
      workerUnits: number;
      limits: string | null;
      teammates: number;
    }>`
      SELECT b.lead_units AS "leadUnits", b.worker_units AS "workerUnits", l.limits_json AS limits,
        (SELECT COALESCE(SUM(c.units), 0) FROM kin_budget_charges c
          WHERE c.org_id = b.org_id AND c.day = b.day AND c.teammate = 1) AS teammates
      FROM kin_budget b LEFT JOIN kin_budget_limits l ON l.org_id = b.org_id
      WHERE b.org_id = ${orgId} AND b.day = ${day}`;
    if (row === undefined) return yield* notFound;
    const teammates = row.teammates;
    return {
      orgId,
      day,
      leadUnits: row.leadUnits,
      workerUnits: row.workerUnits,
      limits: yield* limitsOf(row.limits),
      leads: yield* byLead(orgId, day),
      ...(full
        ? {
            ownerUnits: Math.max(0, row.leadUnits - teammates),
            teammateUnits: teammates,
            usual: USUAL_LIMITS,
            waiting: yield* waiting(orgId),
          }
        : {}),
      teammates,
    };
  });
  const read = Effect.fn("KinBudget.read")(function* (orgId: KinOrgId, full: boolean) {
    const { day } = yield* period(orgId);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* ensure(orgId, day);
        return yield* snapshot(orgId, day, full);
      }),
    );
  }, Effect.mapError(mapError));
  const get = (orgId: KinOrgId) =>
    read(orgId, true).pipe(Effect.map(({ teammates: _teammates, ...budget }) => budget));
  const left = (limit: number | null, spent: number) =>
    limit === null ? 1 : limit === 0 ? 0 : Math.max(0, limit - spent) / limit;
  /** What is left for the owner's own work: teammates' spending never takes from it. */
  const ownerShare = (budget: { leadUnits: number; teammates: number; limits: KinBudgetLimits }) =>
    left(budget.limits.leadUnits, Math.max(0, budget.leadUnits - budget.teammates));
  /** "7:00 am" on the reader's clock: a teammate's profile zone, else the owner's. */
  const clock = Effect.fn("KinBudget.clock")(function* (
    orgId: KinOrgId,
    at: number,
    reader?: KinPersonId,
  ) {
    const [person] =
      reader === undefined
        ? []
        : yield* sql<{ zone: string | null; owner: number }>`
            SELECT time_zone AS zone, EXISTS (SELECT 1 FROM kin_agents a
              WHERE a.org_id = p.org_id AND a.owner_person_id = p.person_id) AS owner
            FROM kin_people p WHERE org_id = ${orgId} AND person_id = ${reader}`;
    const own = person === undefined || person.owner === 1 ? null : validZone(person.zone);
    const timeZone = own ?? (yield* cache.ownerTimeZone(orgId));
    const text = formatKinWhen(at, "time", { zone: timeZone, locale: KIN_TEXT_LOCALE });
    // Each reader's client says it on their own clock; the body keeps this one for older ones.
    return {
      text,
      when: { at: DateTime.formatIso(DateTime.makeUnsafe(at)), zone: timeZone, text },
    };
  });
  const system = Effect.fn("KinBudget.system")(function* (input: {
    readonly orgId: KinOrgId;
    readonly chatId: KinChatId;
    readonly audience: "owner" | "chat";
    readonly messageId: string;
    readonly body: string;
    readonly now: number;
    readonly when?: KinMessageWhen;
  }) {
    // Said once: a second hold in the same turn and chat has nothing new to say.
    const said = yield* sql`SELECT 1 FROM kin_messages
      WHERE org_id = ${input.orgId} AND message_id = ${input.messageId}`;
    if (said.length > 0) return true;
    const posted = yield* chat
      .insertMessage({
        orgId: input.orgId,
        chatId: input.chatId,
        audience: input.audience,
        messageId: KinMessageId.make(input.messageId),
        author: { _tag: "system" },
        kind: "text",
        body: input.body,
        ...(input.when === undefined ? {} : { when: input.when }),
        intent: null,
        mentions: [],
        replyTo: null,
        widgetId: null,
        floorRunId: null,
        status: "posted",
        sentBy: null,
        clientMessageId: null,
        createdAt: DateTime.formatIso(DateTime.makeUnsafe(input.now)),
        editedAt: null,
      })
      .pipe(
        // Never fails the turn: a notice is dropped rather than said where others read.
        Effect.asSome,
        Effect.catchIf(Chat.isPrivateWriteRefused, () => Effect.succeedNone),
      );
    if (Option.isNone(posted)) return false;
    yield* sql.afterCommit(
      hub.publish({ type: "message.posted", orgId: input.orgId, message: posted.value }),
    );
    return true;
  });
  /** One line per limit and day, in the chief of staff's chat when there is one. */
  const ownerNotice = Effect.fn("KinBudget.ownerNotice")(function* (
    orgId: KinOrgId,
    heldBy: HeldBy | "warning",
  ) {
    const { day, nextReset, now } = yield* period(orgId);
    yield* ensure(orgId, day);
    const lead = yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN });
    if (lead === undefined) return;
    const column =
      heldBy === "org"
        ? "exhausted_notified_at"
        : heldBy === "teammates"
          ? "teammates_notified_at"
          : "warned_at";
    const [state] = yield* sql<{ sent: number | null }>`SELECT ${sql(column)} AS sent
      FROM kin_budget WHERE org_id = ${orgId} AND day = ${day}`;
    if (state?.sent != null) return;
    const { text: at, when } = yield* clock(orgId, nextReset);
    const held = yield* waiting(orgId);
    const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
    const list = held.agents
      .map((row) => {
        const parts = [
          row.requests > 0 ? plural(row.requests, "request") : null,
          row.tasks > 0 ? plural(row.tasks, "task") : null,
          row.other > 0 ? plural(row.other, "other item") : null,
        ].filter((part) => part !== null);
        return `${row.name} (${parts.join(", ")})`;
      })
      .join(", ");
    const [stored] = yield* sql<{ limits: string }>`SELECT limits_json AS limits
      FROM kin_budget_limits WHERE org_id = ${orgId}`;
    const teammateLimit = (yield* limitsOf(stored?.limits ?? null)).teammateUnits != null;
    const leads = yield* byLead(orgId, day);
    const total = leads.reduce((sum, row) => sum + row.leadUnits, 0);
    const used =
      leads.length < 2 || total <= 0
        ? ""
        : ` Used today: ${leads.map((row) => `${row.name} ${Math.round((row.leadUnits / total) * 100)}%`).join(", ")}.`;
    const body =
      heldBy === "warning"
        ? `Your agents have used 80% of today's limit. At the limit only your own messages run until ${at}. You can raise or remove the limit in Settings.`
        : heldBy === "teammates"
          ? teammateLimit
            ? `Today's limit for teammates' requests is used up, so they wait until ${at}${list === "" ? "" : `: ${list}`}. Raise or remove it in Settings to run them now.`
            : `Teammates' requests have used what's left of today's limit, so they wait until ${at}${list === "" ? "" : `: ${list}`}. Your own messages still run. Raise or remove the limit in Settings to run them now.`
          : `Today's limit for your agents is used up. Your own messages still run; ${list === "" ? "other work" : `this waits: ${list}. More`} waits until ${at}.${used} Raise or remove the limit in Settings to run it all now.`;
    const posted = yield* system({
      orgId,
      chatId: KinChatId.make(lead.ownerChatId),
      audience: "owner",
      messageId: `kin-budget${heldBy === "org" ? "" : `-${heldBy}`}:${orgId}:${day}`,
      body,
      now,
      when,
    });
    // Marked only once its line is stored, in the same transaction.
    if (posted)
      yield* sql`UPDATE kin_budget SET ${sql(column)} = ${now}
        WHERE org_id = ${orgId} AND day = ${day} AND ${sql(column)} IS NULL`;
  });
  const measure = Effect.fn("KinBudget.measure")(function* (
    usage: ReadonlyArray<Usage>,
    context: Readonly<Record<string, string>>,
  ) {
    let units = 0;
    const valid = (value: number | undefined) =>
      value !== undefined && Number.isFinite(value) && value >= 0;
    const count = (value: number | undefined) => (valid(value) ? value! : 0);
    const ids = new Set<string>();
    if (usage.length === 0)
      yield* Effect.logWarning("Kin budget turn usage unavailable", {
        ...context,
      });
    for (const turn of usage) {
      if (ids.has(turn.providerTurnId)) continue;
      ids.add(turn.providerTurnId);
      const ledger = turn.turnTokenUsage;
      const complete =
        ledger?.usageStatus === "complete" &&
        valid(ledger.inputTokens) &&
        valid(ledger.outputTokens) &&
        (ledger.cachedInputTokens === undefined || valid(ledger.cachedInputTokens));
      if (!complete) {
        yield* Effect.logWarning("Kin budget using fallback usage", {
          ...context,
          usageStatus: ledger?.usageStatus ?? "missing",
          hasUsedTokens: valid(turn.usedTokens),
        });
      }
      if (!complete && valid(turn.usedTokens)) {
        units += count(turn.usedTokens);
        continue;
      }
      const incoming = count(ledger?.inputTokens);
      const cached = Math.min(incoming, count(ledger?.cachedInputTokens));
      if (cached !== count(ledger?.cachedInputTokens))
        yield* Effect.logWarning("Kin budget clamped cached usage", {
          ...context,
        });
      units +=
        incoming -
        cached +
        0.1 * cached +
        4 * count(ledger?.outputTokens) +
        count(ledger?.otherUsage?.inputTokens) +
        4 * count(ledger?.otherUsage?.outputTokens);
    }
    if (!Number.isFinite(units)) {
      yield* Effect.logWarning("Kin budget usage overflow", {
        ...context,
      });
      units = 0;
    }
    return units;
  });
  return KinBudget.of({
    get,
    view: Effect.fn("KinBudget.view")(function* (people, orgId) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const person = people.find((p) => p.orgId === orgId);
          if (person === undefined) return yield* notFound;
          const exists =
            yield* sql`SELECT 1 FROM kin_people WHERE org_id = ${orgId} AND person_id = ${person.personId}`;
          if (exists.length === 0) return yield* notFound;
          // Amounts and who spent them are the owner's settings, never a teammate's to read.
          const owner = yield* isOrgOwner(orgId, person.personId).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          if (!owner) return yield* notAllowed;
          return yield* get(orgId);
        }),
      );
    }, Effect.mapError(mapError)),
    set: Effect.fn("KinBudget.set")(function* (people, input) {
      const limits = yield* decodeLimits(input.limits);
      const { day } = yield* period(input.orgId);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* ensure(input.orgId, day);
          const person = people.find((p) => p.orgId === input.orgId);
          if (person === undefined) return yield* notFound;
          const owner = yield* isOrgOwner(input.orgId, person.personId).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          if (!owner) return yield* notAllowed;
          // A client that predates the teammates' limit leaves it as it was.
          const [stored] = yield* sql<{ limits: string }>`SELECT limits_json AS limits
            FROM kin_budget_limits WHERE org_id = ${input.orgId}`;
          const json = yield* encodeJson({
            ...limits,
            teammateUnits:
              limits.teammateUnits !== undefined
                ? limits.teammateUnits
                : ((yield* limitsOf(stored?.limits ?? null)).teammateUnits ?? null),
          });
          yield* sql`INSERT INTO kin_budget_limits (org_id, limits_json) VALUES (${input.orgId}, ${json}) ON CONFLICT DO NOTHING RETURNING org_id`;
          yield* sql`UPDATE kin_budget_limits SET limits_json = ${json} WHERE org_id = ${input.orgId}`;
          yield* queue.reconsiderBudget(input.orgId);
          yield* (yield* KinRefreshObserver).touch(input.orgId, "budget");
          const { teammates: _teammates, ...budget } = yield* snapshot(input.orgId, day, true);
          return budget;
        }),
      );
    }, Effect.mapError(mapError)),
    admit: Effect.fn("KinBudget.admit")(function* (orgId, priority, asker = "owner") {
      const { day, nextReset } = yield* period(orgId);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* ensure(orgId, day);
          const budget = yield* snapshot(orgId, day);
          const teammateLimit = budget.limits.teammateUnits;
          // The owner's work spends against the limit less what teammates spent. A teammate's
          // spends against the teammates' limit when one is set, else what is left of the org's.
          if (asker === "teammate" && teammateLimit != null) {
            const allowed = budget.teammates < teammateLimit;
            return {
              allowed,
              atLimit: false,
              nextReset,
              remaining: left(teammateLimit, budget.teammates),
              heldBy: allowed ? null : ("teammates" as const),
            };
          }
          const remaining =
            asker === "owner"
              ? ownerShare(budget)
              : left(budget.limits.leadUnits, budget.leadUnits);
          const allowed =
            priority === "P0" ||
            (priority === "P4"
              ? remaining > 0.3
              : remaining > 0 &&
                (priority === "P1" || (priority === "P2" ? remaining >= 0.2 : remaining > 0.4)));
          return {
            allowed,
            atLimit: remaining === 0,
            nextReset,
            remaining,
            heldBy: allowed ? null : asker === "owner" ? ("org" as const) : ("teammates" as const),
          };
        }),
      );
    }, Effect.mapError(mapError)),
    defer: Effect.fn("KinBudget.defer")(
      function* (input) {
        if (input.events.length === 0) return;
        const { now } = yield* period(input.orgId);
        yield* queue.release({
          orgId: input.orgId,
          wakeupId: input.wakeupId,
          eventIds: input.events.map((event) => event.eventId),
          notBefore: input.nextReset,
          countAttempt: false,
          budgetDeferred: true,
        });
        const [lead] = yield* sql<{ name: string; ownerChatId: string }>`
        SELECT name, owner_chat_id AS "ownerChatId" FROM kin_leads
        WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} ORDER BY agent_id`;
        if (lead !== undefined) {
          const why =
            input.heldBy === "teammates"
              ? "today's limit for teammates' requests is used up"
              : "today's limit is used up";
          // Where each asked: a message's or card's own chat, reported work's, else the lead's own.
          // Each chat reads the time on the clock of the person who asked there.
          const chats = new Map<string, KinPersonId | undefined>();
          for (const event of input.events) {
            const chatId =
              "chatId" in event && event.chatId !== undefined ? event.chatId : lead.ownerChatId;
            const asker =
              "provenance" in event && event.provenance._tag === "human"
                ? event.provenance.personId
                : undefined;
            if (!chats.has(chatId) || chats.get(chatId) === undefined) chats.set(chatId, asker);
          }
          for (const [chatId, asker] of chats) {
            const { text: at, when } = yield* clock(input.orgId, input.nextReset, asker);
            yield* system({
              orgId: input.orgId,
              chatId: KinChatId.make(chatId),
              audience: "chat",
              messageId: `kin-waiting:${input.wakeupId}:${chatId}`,
              body: `${lead.name} will pick this up at ${at}: ${why}.`,
              now,
              when,
            });
          }
        }
        yield* ownerNotice(input.orgId, input.heldBy);
      },
      (effect) => sql.withTransaction(effect).pipe(Effect.mapError(mapError)),
    ),
    notifyOwner: Effect.fn("KinBudget.notifyOwner")(
      (orgId, heldBy) => ownerNotice(orgId, heldBy),
      (effect) => sql.withTransaction(effect).pipe(Effect.mapError(mapError)),
    ),
    admitTask: Effect.fn("KinBudget.admitTask")(function* (orgId) {
      const budget = yield* read(orgId, false);
      return budget.limits.workerUnits === null || budget.workerUnits < budget.limits.workerUnits;
    }),
    promptContext: Effect.fn("KinBudget.promptContext")(function* (orgId) {
      const budget = yield* read(orgId, false);
      return budget.limits.leadUnits === null
        ? "no daily limit"
        : `${Math.floor(ownerShare(budget) * 100)}% of today left`;
    }),
    charge: Effect.fn("KinBudget.charge")(function* (input) {
      const units = yield* measure(input.usage, { orgId: input.orgId, wakeupId: input.wakeupId });
      const tokensJson = yield* encodeJson(usageJsonValue(input.usage));
      const { day } = yield* period(input.orgId);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const existing =
            yield* sql`SELECT 1 FROM kin_wakeups WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId}`;
          if (existing.length === 0) return yield* notFound;
          const [stored] =
            yield* sql<Charge>`SELECT org_id AS "orgId", wakeup_id AS "wakeupId", day, units, tokens_json AS "tokensJson" FROM kin_budget_charges WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId}`;
          if (stored !== undefined && (stored.tokensJson === tokensJson || units <= stored.units))
            return stored;
          const delta = Math.max(0, units - (stored?.units ?? 0));
          const chargedUnits = Math.max(units, stored?.units ?? 0);
          yield* ensure(input.orgId, day);
          const before = yield* snapshot(input.orgId, day);
          if (!Number.isFinite(before.leadUnits + delta)) return yield* invalid;
          const [charged] = yield* sql<{ teammate: number }>`INSERT INTO kin_budget_charges
              (org_id, wakeup_id, day, units, tokens_json, teammate)
            VALUES (${input.orgId}, ${input.wakeupId}, ${day}, ${chargedUnits}, ${tokensJson},
              ${askedByTeammates(input.orgId, input.wakeupId)})
            ON CONFLICT (org_id, wakeup_id) DO UPDATE SET units = excluded.units,
              tokens_json = excluded.tokens_json, teammate = excluded.teammate
            RETURNING teammate`;
          const teammate = charged?.teammate === 1 ? 1 : 0;
          yield* sql`UPDATE kin_budget SET lead_units = lead_units + ${delta} WHERE org_id = ${input.orgId} AND day = ${day}`;
          const limit = before.limits.leadUnits;
          const ownerSpent =
            Math.max(0, before.leadUnits - before.teammates) + delta * (1 - teammate);
          if (limit !== null && limit > 0 && teammate === 0 && ownerSpent >= WARN_AT * limit)
            yield* ownerNotice(input.orgId, "warning");
          yield* sql`UPDATE kin_wakeups SET tokens_json = ${tokensJson} WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId}`;
          return {
            orgId: input.orgId,
            wakeupId: input.wakeupId,
            day: stored?.day ?? day,
            units: chargedUnits,
            tokensJson,
          };
        }),
      );
    }, Effect.mapError(mapError)),
    chargeTask: Effect.fn("KinBudget.chargeTask")(function* (input) {
      const units = yield* measure(input.usage, { orgId: input.orgId, threadId: input.threadId });
      const tokensJson = yield* encodeJson(usageJsonValue(input.usage));
      const { day } = yield* period(input.orgId);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const [stored] = yield* sql<{
            day: string;
            units: number;
            tokensJson: string;
          }>`SELECT day, units, tokens_json AS "tokensJson" FROM kin_task_charges WHERE org_id = ${input.orgId} AND thread_id = ${input.threadId} ORDER BY thread_id`;
          if (stored !== undefined && (stored.tokensJson === tokensJson || units <= stored.units))
            return { day: stored.day, units: stored.units };
          const delta = Math.max(0, units - (stored?.units ?? 0));
          const charged = stored?.day ?? day;
          yield* ensure(input.orgId, charged);
          const before = yield* snapshot(input.orgId, charged);
          if (!Number.isFinite(before.workerUnits + delta)) return yield* invalid;
          yield* sql`INSERT INTO kin_task_charges (org_id, thread_id, day, units, tokens_json)
            VALUES (${input.orgId}, ${input.threadId}, ${charged}, ${units}, ${tokensJson})
            ON CONFLICT (org_id, thread_id) DO UPDATE SET units = excluded.units,
              tokens_json = excluded.tokens_json`;
          yield* sql`UPDATE kin_budget SET worker_units = worker_units + ${delta} WHERE org_id = ${input.orgId} AND day = ${charged}`;
          return { day: charged, units };
        }),
      );
    }, Effect.mapError(mapError)),
  });
});

export const layer = Layer.effect(KinBudget, make);
