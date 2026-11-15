import {
  KinBudget as Budget,
  KinBudgetLimits,
  type KinAgentId,
  KinChatError,
  KinChatId,
  type KinEvent,
  KinMessageId,
  type KinOrgId,
  type KinWakeupId,
  type KinWorkerId,
  type RunId,
  type TurnTokenUsage,
  type OrchestrationV2ProviderTurnTokenUsage,
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
import * as Chat from "../chat/KinChatRepository.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as MemoryCache from "../memory/MemoryCache.ts";
import * as Queue from "./KinEventQueue.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "./orgLeads.ts";
import { isOrgOwner } from "./orgState.ts";

type Priority = "P0" | "P1" | "P2" | "P3" | "P4";
export type Usage = {
  readonly providerTurnId: string;
  readonly turnTokenUsage?: TurnTokenUsage;
  readonly tokenUsage?: OrchestrationV2ProviderTurnTokenUsage;
  readonly usedTokens?: number | undefined;
};
type BudgetError = KinChatError | PersistenceSqlError;
/** Which limit held a turn back: the owner's for the whole org, or the one for teammates. */
export type HeldBy = "org" | "teammates";
type Admission = {
  readonly allowed: boolean;
  readonly cheapOnly: boolean;
  readonly nextReset: number;
  readonly remaining: number;
  readonly heldBy: HeldBy | null;
};
/** Who a turn's event was asked by: a teammate's request never spends as the owner's. */
export const askedByTeammate = (event: KinEvent, ownerPersonId: string) =>
  ("origin" in event && event.origin?.personId !== undefined) ||
  (event.provenance._tag === "human" && event.provenance.personId !== ownerPersonId);
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
     * Events a limit held back: whoever asked sees a line in that chat at once, and the owner one
     * notice a day per limit, with what waits.
     */
    readonly held: (input: {
      readonly orgId: KinOrgId;
      readonly agentId: KinAgentId;
      readonly wakeupId: KinWakeupId;
      readonly events: ReadonlyArray<KinEvent>;
      readonly heldBy: HeldBy;
      readonly nextReset: number;
    }) => Effect.Effect<void, BudgetError>;
    /** Today's notice to the owner for a limit that was reached, once a day. */
    readonly notifyOwner: (orgId: KinOrgId, heldBy: HeldBy) => Effect.Effect<void, BudgetError>;
    readonly admitWorker: (orgId: KinOrgId) => Effect.Effect<boolean, BudgetError>;
    readonly promptContext: (orgId: KinOrgId) => Effect.Effect<string, BudgetError>;
    readonly charge: (input: {
      readonly orgId: KinOrgId;
      readonly wakeupId: KinWakeupId;
      readonly usage: ReadonlyArray<Usage>;
    }) => Effect.Effect<Charge, BudgetError>;
    /** Worker runs bill worker units only; lead turns, including Claude's otherUsage, stay lead units. */
    readonly chargeWorker: (input: {
      readonly orgId: KinOrgId;
      readonly workerId: KinWorkerId;
      readonly runId: RunId;
      readonly usage: ReadonlyArray<Usage>;
    }) => Effect.Effect<{ readonly day: string; readonly units: number }, BudgetError>;
  }
>()("t3/kin/lead/KinBudget") {}

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
  // A turn counts as a teammate's when any event in it was asked by someone besides its owner.
  const teammateUnits = Effect.fn("KinBudget.teammateUnits")(function* (
    orgId: KinOrgId,
    day: string,
  ) {
    const [row] = yield* sql<{ units: number }>`SELECT COALESCE(SUM(c.units), 0) AS units
      FROM kin_budget_charges c WHERE c.org_id = ${orgId} AND c.day = ${day}
        AND EXISTS (SELECT 1 FROM kin_events e
          JOIN kin_agents a ON a.org_id = e.org_id AND a.agent_id = e.agent_id
          WHERE e.org_id = c.org_id AND e.wakeup_id = c.wakeup_id
            AND (json_extract(e.json, '$.origin.personId') IS NOT NULL
              OR (json_extract(e.json, '$.provenance._tag') = 'human'
                AND json_extract(e.json, '$.provenance.personId') <> a.owner_person_id)))`;
    return row?.units ?? 0;
  });
  const waiting = Effect.fn("KinBudget.waiting")(function* (orgId: KinOrgId) {
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
  const limitsOf = Effect.fn("KinBudget.limitsOf")(function* (stored: string | null) {
    if (stored === null) return defaults;
    const limits = yield* decodeStoredLimits(stored);
    return { ...limits, teammateUnits: limits.teammateUnits ?? null };
  });
  // `full` adds what only the owner's view needs: the teammates' spend and what waits.
  const snapshot = Effect.fn("KinBudget.snapshot")(function* (
    orgId: KinOrgId,
    day: string,
    full = false,
  ) {
    const [row] = yield* sql<{ leadUnits: number; workerUnits: number; limits: string | null }>`
      SELECT b.lead_units AS "leadUnits", b.worker_units AS "workerUnits", l.limits_json AS limits
      FROM kin_budget b LEFT JOIN kin_budget_limits l ON l.org_id = b.org_id
      WHERE b.org_id = ${orgId} AND b.day = ${day}`;
    if (row === undefined) return yield* notFound;
    return {
      orgId,
      day,
      leadUnits: row.leadUnits,
      workerUnits: row.workerUnits,
      limits: yield* limitsOf(row.limits),
      leads: yield* byLead(orgId, day),
      ...(full
        ? { teammateUnits: yield* teammateUnits(orgId, day), waiting: yield* waiting(orgId) }
        : {}),
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
  const get = (orgId: KinOrgId) => read(orgId, true);
  const share = (budget: Budget) =>
    budget.limits.leadUnits === null
      ? 1
      : budget.limits.leadUnits === 0
        ? 0
        : Math.max(0, budget.limits.leadUnits - budget.leadUnits) / budget.limits.leadUnits;
  const clock = Effect.fn("KinBudget.clock")(function* (orgId: KinOrgId, at: number) {
    const timeZone = yield* cache.ownerTimeZone(orgId);
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone })
      .format(at)
      .replace(/\s?AM$/, " am")
      .replace(/\s?PM$/, " pm");
  });
  const system = Effect.fn("KinBudget.system")(function* (input: {
    readonly orgId: KinOrgId;
    readonly chatId: KinChatId;
    readonly audience: "owner" | "chat";
    readonly messageId: string;
    readonly body: string;
    readonly now: number;
  }) {
    // Said once: a second hold in the same turn and chat has nothing new to say.
    const said = yield* sql`SELECT 1 FROM kin_messages
      WHERE org_id = ${input.orgId} AND message_id = ${input.messageId}`;
    if (said.length > 0) return;
    const posted = yield* chat
      .insertMessage({
        orgId: input.orgId,
        chatId: input.chatId,
        audience: input.audience,
        messageId: KinMessageId.make(input.messageId),
        author: { _tag: "system" },
        kind: "text",
        body: input.body,
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
    if (Option.isSome(posted))
      yield* hub.publish({ type: "message.posted", orgId: input.orgId, message: posted.value });
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
    const updated = yield* sql`UPDATE kin_budget SET ${sql(column)} = ${now}
      WHERE org_id = ${orgId} AND day = ${day} AND ${sql(column)} IS NULL RETURNING org_id`;
    if (updated.length === 0) return;
    const at = yield* clock(orgId, nextReset);
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
    const leads = yield* byLead(orgId, day);
    const total = leads.reduce((sum, row) => sum + row.leadUnits, 0);
    const used =
      leads.length < 2 || total <= 0
        ? ""
        : ` Used today: ${leads.map((row) => `${row.name} ${Math.round((row.leadUnits / total) * 100)}%`).join(", ")}.`;
    const body =
      heldBy === "warning"
        ? `Your agents have used 80% of today's limit. At the limit only your own messages run, on the cheaper model, until ${at}. You can raise or remove the limit in Settings.`
        : heldBy === "teammates"
          ? `Today's limit for teammates' requests is used up, so they wait until ${at}${list === "" ? "" : `: ${list}`}. Raise or remove it in Settings to run them now.`
          : `Today's limit for your agents is used up. Your own messages still run, on the cheaper model; ${list === "" ? "other work" : `this waits: ${list}. More`} waits until ${at}.${used} Raise or remove the limit in Settings to run it all now.`;
    yield* system({
      orgId,
      chatId: KinChatId.make(lead.ownerChatId),
      audience: "owner",
      messageId: `kin-budget${heldBy === "org" ? "" : `-${heldBy}`}:${orgId}:${day}`,
      body,
      now,
    });
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
          return yield* snapshot(input.orgId, day, true);
        }),
      );
    }, Effect.mapError(mapError)),
    admit: Effect.fn("KinBudget.admit")(function* (orgId, priority, asker = "owner") {
      const { day, nextReset } = yield* period(orgId);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* ensure(orgId, day);
          const budget = yield* snapshot(orgId, day);
          const remaining = share(budget);
          const teammateLimit = budget.limits.teammateUnits;
          const teammatesOut =
            asker === "teammate" &&
            teammateLimit != null &&
            (yield* teammateUnits(orgId, day)) >= teammateLimit;
          const withinOrg =
            priority === "P0" ||
            (priority === "P4"
              ? remaining > 0.3
              : remaining > 0 &&
                (priority === "P1" || (priority === "P2" ? remaining >= 0.2 : remaining > 0.4)));
          const allowed = withinOrg && !teammatesOut;
          return {
            allowed,
            cheapOnly: remaining === 0,
            nextReset,
            remaining,
            heldBy: allowed ? null : teammatesOut ? ("teammates" as const) : ("org" as const),
          };
        }),
      );
    }, Effect.mapError(mapError)),
    held: Effect.fn("KinBudget.held")(function* (input) {
      if (input.events.length === 0) return;
      const { now } = yield* period(input.orgId);
      const [lead] = yield* sql<{ name: string; ownerChatId: string }>`
        SELECT name, owner_chat_id AS "ownerChatId" FROM kin_leads
        WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} ORDER BY agent_id`;
      if (lead !== undefined) {
        const at = yield* clock(input.orgId, input.nextReset);
        const why =
          input.heldBy === "teammates"
            ? "today's limit for teammates' requests is used up"
            : "today's limit is used up";
        // Where each asked: a message's or card's own chat, reported work's, else the lead's own.
        const chats = new Set(
          input.events.map((event) =>
            "chatId" in event && event.chatId !== undefined ? event.chatId : lead.ownerChatId,
          ),
        );
        for (const chatId of chats)
          yield* system({
            orgId: input.orgId,
            chatId: KinChatId.make(chatId),
            audience: "chat",
            messageId: `kin-waiting:${input.wakeupId}:${chatId}`,
            body: `${lead.name} will pick this up at ${at}: ${why}.`,
            now,
          });
      }
      yield* ownerNotice(input.orgId, input.heldBy);
    }, Effect.mapError(mapError)),
    notifyOwner: Effect.fn("KinBudget.notifyOwner")(
      (orgId, heldBy) => ownerNotice(orgId, heldBy),
      Effect.mapError(mapError),
    ),
    admitWorker: Effect.fn("KinBudget.admitWorker")(function* (orgId) {
      const budget = yield* read(orgId, false);
      return budget.limits.workerUnits === null || budget.workerUnits < budget.limits.workerUnits;
    }),
    promptContext: Effect.fn("KinBudget.promptContext")(function* (orgId) {
      const budget = yield* read(orgId, false);
      return budget.limits.leadUnits === null
        ? "no daily limit"
        : `${Math.floor(share(budget) * 100)}% of today left`;
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
          yield* sql`INSERT INTO kin_budget_charges (org_id, wakeup_id, day, units, tokens_json)
            VALUES (${input.orgId}, ${input.wakeupId}, ${day}, ${chargedUnits}, ${tokensJson})
            ON CONFLICT (org_id, wakeup_id) DO UPDATE SET units = excluded.units, tokens_json = excluded.tokens_json`;
          yield* sql`UPDATE kin_budget SET lead_units = lead_units + ${delta} WHERE org_id = ${input.orgId} AND day = ${day}`;
          const limit = before.limits.leadUnits;
          if (limit !== null && limit > 0 && before.leadUnits + delta >= WARN_AT * limit)
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
    chargeWorker: Effect.fn("KinBudget.chargeWorker")(function* (input) {
      const units = yield* measure(input.usage, {
        orgId: input.orgId,
        workerId: input.workerId,
        runId: input.runId,
      });
      const tokensJson = yield* encodeJson(usageJsonValue(input.usage));
      const { day } = yield* period(input.orgId);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const worker =
            yield* sql`SELECT 1 FROM kin_workers WHERE org_id = ${input.orgId} AND worker_id = ${input.workerId} ORDER BY worker_id`;
          if (worker.length === 0) return yield* notFound;
          const [stored] = yield* sql<{
            day: string;
            units: number;
            tokensJson: string;
          }>`SELECT day, units, tokens_json AS "tokensJson" FROM kin_worker_charges WHERE org_id = ${input.orgId} AND run_id = ${input.runId} ORDER BY run_id`;
          if (stored !== undefined && (stored.tokensJson === tokensJson || units <= stored.units))
            return { day: stored.day, units: stored.units };
          const delta = Math.max(0, units - (stored?.units ?? 0));
          yield* ensure(input.orgId, day);
          const before = yield* snapshot(input.orgId, day);
          if (!Number.isFinite(before.workerUnits + delta)) return yield* invalid;
          const inserted =
            yield* sql`INSERT INTO kin_worker_charges (org_id, worker_id, run_id, day, units, tokens_json)
            VALUES (${input.orgId}, ${input.workerId}, ${input.runId}, ${day}, ${units}, ${tokensJson})
            ON CONFLICT DO NOTHING RETURNING run_id`;
          if (inserted.length === 0)
            yield* sql`UPDATE kin_worker_charges SET units = ${units}, tokens_json = ${tokensJson}
              WHERE org_id = ${input.orgId} AND run_id = ${input.runId}`;
          yield* sql`UPDATE kin_budget SET worker_units = worker_units + ${delta} WHERE org_id = ${input.orgId} AND day = ${day}`;
          return { day: stored?.day ?? day, units };
        }),
      );
    }, Effect.mapError(mapError)),
  });
});

export const layer = Layer.effect(KinBudget, make);
