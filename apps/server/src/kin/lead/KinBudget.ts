import {
  KinBudget as Budget,
  KinBudgetLimits,
  KinChatError,
  KinChatId,
  KinMessageId,
  type KinOrgId,
  type KinWakeupId,
  type TurnTokenUsage,
  type OrchestrationV2ProviderTurnTokenUsage,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { isSqlError } from "effect/sql/SqlError";
import * as SqlClient from "effect/sql/SqlClient";
import { toPersistenceSqlError, PersistenceSqlError } from "../../persistence/Errors.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import * as Chat from "../chat/KinChatRepository.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as MemoryCache from "../memory/MemoryCache.ts";
import * as Queue from "./KinEventQueue.ts";

type Priority = "P0" | "P1" | "P2" | "P3" | "P4";
type Usage = {
  readonly providerTurnId: string;
  readonly turnTokenUsage?: TurnTokenUsage;
  readonly tokenUsage?: OrchestrationV2ProviderTurnTokenUsage;
  readonly usedTokens?: number | undefined;
};
type BudgetError = KinChatError | PersistenceSqlError;
type Admission = {
  readonly allowed: boolean;
  readonly cheapOnly: boolean;
  readonly nextReset: number;
  readonly remaining: number;
};
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
const defaults = { leadUnits: 2_000_000, workerUnits: 6_000_000 };
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
    readonly admit: (orgId: KinOrgId, priority: Priority) => Effect.Effect<Admission, BudgetError>;
    readonly admitWorker: (orgId: KinOrgId) => Effect.Effect<boolean, BudgetError>;
    readonly promptContext: (orgId: KinOrgId) => Effect.Effect<string, BudgetError>;
    readonly charge: (input: {
      readonly orgId: KinOrgId;
      readonly wakeupId: KinWakeupId;
      readonly usage: ReadonlyArray<Usage>;
    }) => Effect.Effect<Charge, BudgetError>;
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
  const snapshot = Effect.fn("KinBudget.snapshot")(function* (orgId: KinOrgId, day: string) {
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
      limits: row.limits === null ? defaults : yield* decodeStoredLimits(row.limits),
    };
  });
  const get = Effect.fn("KinBudget.get")(function* (orgId: KinOrgId) {
    const { day } = yield* period(orgId);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* ensure(orgId, day);
        return yield* snapshot(orgId, day);
      }),
    );
  }, Effect.mapError(mapError));
  const share = (budget: Budget) =>
    budget.limits.leadUnits === 0
      ? 0
      : Math.max(0, budget.limits.leadUnits - budget.leadUnits) / budget.limits.leadUnits;
  const notifyExhausted = Effect.fn("KinBudget.notifyExhausted")(function* (
    orgId: KinOrgId,
    day: string,
    now: number,
  ) {
    const [lead] = yield* sql<{
      chatId: string;
    }>`SELECT owner_chat_id AS "chatId" FROM kin_leads WHERE org_id = ${orgId} ORDER BY agent_id LIMIT 1`;
    if (lead === undefined) return;
    const updated =
      yield* sql`UPDATE kin_budget SET exhausted_notified_at = ${now} WHERE org_id = ${orgId} AND day = ${day} AND exhausted_notified_at IS NULL RETURNING org_id`;
    if (updated.length === 0) return;
    const message = yield* chat.insertMessage({
      orgId,
      chatId: KinChatId.make(lead.chatId),
      messageId: KinMessageId.make(`kin-budget:${orgId}:${day}`),
      author: { _tag: "system" },
      kind: "text",
      body: "Today's Kin lead budget is exhausted. Only urgent owner messages will run, on the cheap model. Raise the limits in settings to resume other work.",
      intent: null,
      mentions: [],
      replyTo: null,
      widgetId: null,
      floorRunId: null,
      status: "posted",
      sentBy: null,
      clientMessageId: null,
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      editedAt: null,
    });
    yield* hub.publish({ type: "message.posted", orgId, message });
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
          // The reserved bootstrap owner is authoritative before a lead is configured.
          const owner =
            yield* sql`SELECT 1 FROM kin_people p WHERE p.org_id = ${input.orgId} AND p.person_id = ${person.personId}
          AND ((p.org_id = 'kin-default' AND p.person_id = 'kin-default-owner'
            AND NOT EXISTS (SELECT 1 FROM kin_leads WHERE org_id = p.org_id)) OR EXISTS (
            SELECT 1 FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
            WHERE l.org_id = p.org_id AND a.owner_person_id = p.person_id))`;
          if (owner.length === 0) return yield* notAllowed;
          const json = yield* encodeJson(limits);
          yield* sql`INSERT INTO kin_budget_limits (org_id, limits_json) VALUES (${input.orgId}, ${json}) ON CONFLICT DO NOTHING RETURNING org_id`;
          yield* sql`UPDATE kin_budget_limits SET limits_json = ${json} WHERE org_id = ${input.orgId}`;
          yield* queue.reconsiderBudget(input.orgId);
          return yield* snapshot(input.orgId, day);
        }),
      );
    }, Effect.mapError(mapError)),
    admit: Effect.fn("KinBudget.admit")(function* (orgId, priority) {
      const { day, nextReset, now } = yield* period(orgId);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* ensure(orgId, day);
          const remaining = share(yield* snapshot(orgId, day));
          if (remaining === 0) yield* notifyExhausted(orgId, day, now);
          const allowed =
            priority === "P0" ||
            (priority === "P4"
              ? remaining > 0.3
              : remaining > 0 &&
                (priority === "P1" || (priority === "P2" ? remaining >= 0.2 : remaining > 0.4)));
          return { allowed, cheapOnly: remaining === 0, nextReset, remaining };
        }),
      );
    }, Effect.mapError(mapError)),
    admitWorker: Effect.fn("KinBudget.admitWorker")(function* (orgId) {
      const budget = yield* get(orgId);
      return budget.workerUnits < budget.limits.workerUnits;
    }),
    promptContext: Effect.fn("KinBudget.promptContext")(function* (orgId) {
      return `${Math.floor(share(yield* get(orgId)) * 100)}% of today left`;
    }),
    charge: Effect.fn("KinBudget.charge")(function* (input) {
      let units = 0;
      const valid = (value: number | undefined) =>
        value !== undefined && Number.isFinite(value) && value >= 0;
      const count = (value: number | undefined) => (valid(value) ? value! : 0);
      const ids = new Set<string>();
      if (input.usage.length === 0)
        yield* Effect.logWarning("Kin budget turn usage unavailable", {
          orgId: input.orgId,
          wakeupId: input.wakeupId,
        });
      for (const turn of input.usage) {
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
            orgId: input.orgId,
            wakeupId: input.wakeupId,
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
            orgId: input.orgId,
            wakeupId: input.wakeupId,
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
          orgId: input.orgId,
          wakeupId: input.wakeupId,
        });
        units = 0;
      }
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
  });
});

export const layer = Layer.effect(KinBudget, make);
