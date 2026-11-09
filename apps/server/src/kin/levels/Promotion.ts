import {
  KIN_SHADOW_CHANGES_MAX,
  KIN_SHADOW_REVIEW_TEXT_MAX,
  KinActionTarget,
  KinChatError,
  KinChatId,
  KinEventId,
  KinMessageId,
  KinPersonId,
  KinPromotionCard,
  KinShadowReviewCard,
  KinWidgetId,
  type KinActionId,
  KinLevel,
  KinAgentId,
  ThreadId,
  type KinLevelsGetInput,
  type KinLevelsRaiseResult,
  type KinLevelsReviewInput,
  type KinLevelsReviewResult,
  type KinLevelsSetInput,
  type KinLevelsShadowMemoryInput,
  type KinLevelsView,
  type KinOrgId,
  type KinPromotionStats,
  type KinShadowVerdict,
  type KinWidget,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  KinPendingActions,
  KIN_PROMOTION_REQUESTER,
  kinTargetDigest,
} from "../approvals/PendingActions.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import * as MemoryCache from "../memory/MemoryCache.ts";
import * as KinLevels from "../lead/KinLevels.ts";
import { describe } from "../lead/LevelGate.ts";
import { isOwnerReviewedPath } from "../memory/lint.ts";

const DAY_MS = 86_400_000;
const REVIEW_ENTRIES = 50;
const OPEN_ACTION_STATES = ["awaiting_approval", "approved", "executing"];

/** The writer's preview, keep or discard, attached by the lead runtime that owns the writer. */
export type KinShadowSettle = (
  orgId: KinOrgId,
  agentId: KinAgentId,
  choice:
    | { readonly _tag: "preview" }
    | { readonly _tag: "discard" }
    | { readonly _tag: "keep"; readonly paths: ReadonlyArray<string> },
) => Effect.Effect<
  { readonly paths: ReadonlyArray<string> },
  { readonly _tag: string; readonly reason?: string | undefined }
>;

type Lead = { readonly orgId: KinOrgId; readonly agentId: KinAgentId };

/**
 * The owner's side of levels (lead spec, "Level promotion"): read, lower, verdicts, the promotion
 * card and asking to raise. Raising only creates a `set_level` action; the owner's signed grant
 * and the executor's `set_level` handler apply it. No MCP tool or agent path reaches this service.
 */
export class KinPromotion extends Context.Service<
  KinPromotion,
  {
    readonly view: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinLevelsGetInput,
    ) => Effect.Effect<KinLevelsView, KinChatError>;
    readonly review: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinLevelsReviewInput,
    ) => Effect.Effect<KinLevelsReviewResult, KinChatError>;
    readonly lower: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinLevelsSetInput,
    ) => Effect.Effect<KinLevelsView, KinChatError>;
    readonly raise: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinLevelsSetInput,
    ) => Effect.Effect<KinLevelsRaiseResult, KinChatError>;
    readonly deferPromotion: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinLevelsGetInput,
    ) => Effect.Effect<KinLevelsView, KinChatError>;
    readonly shadowMemory: (
      people: ReadonlyArray<PersonIdentity>,
      input: KinLevelsShadowMemoryInput,
    ) => Effect.Effect<KinLevelsView, KinChatError>;
    /** The evening summary's cards: today's review card and, when eligible, the promotion card. */
    readonly evening: (lead: Lead) => Effect.Effect<void>;
    readonly attachShadowMemory: (
      settle: KinShadowSettle,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/kin/levels/Promotion/KinPromotion") {}

const reviewWidgetId = (agentId: KinAgentId, day: string) =>
  KinWidgetId.make(`shadow-review:${agentId}:${day}`);
const promotionWidgetId = (agentId: KinAgentId, to: KinLevel) =>
  KinWidgetId.make(`promotion:${agentId}:${to}`);
const decodePromotion = Schema.decodeUnknownEffect(KinPromotionCard);
const encodePromotion = Schema.encodeEffect(KinPromotionCard);
const decodeReview = Schema.decodeUnknownEffect(KinShadowReviewCard);
const encodeReview = Schema.encodeEffect(KinShadowReviewCard);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeLevel = Schema.decodeUnknownEffect(KinLevel);
const decodeTarget = Schema.decodeUnknownEffect(Schema.fromJsonString(KinActionTarget));
type OpenRaiseState = "awaiting_approval" | "approved" | "executing";
const isOpenRaiseState = (state: string): state is OpenRaiseState =>
  OPEN_ACTION_STATES.includes(state);

const promotionTitle = (name: string, stats: KinPromotionStats) =>
  stats.eligible
    ? `${name} is ready for ${stats.to}: ${stats.fine} of ${stats.reviewed} reviewed would have gone out unchanged, none harmful, none unreviewed.`
    : `${name}'s trial for ${stats.to ?? stats.from}: ${stats.fine} of ${stats.reviewed} reviewed would have gone out unchanged, ${stats.harmful === 0 ? "none" : stats.harmful} harmful, ${stats.unreviewed} unreviewed.`;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const refused = (reason: KinChatError["reason"], message: string) =>
  new KinChatError({ reason, message });
const notAllowed = refused("not_allowed", "Only the lead's owner can change its level.");
const notFound = refused("not_found", "Kin record not found.");
const unavailable = refused("unavailable", "Kin is unavailable.");
const LEVEL_REFUSALS: Record<KinLevels.KinLevelRefused["reason"], KinChatError> = {
  not_a_lead: notFound,
  not_found: notFound,
  not_running: refused("invalid_state", "The lead isn't running."),
  conflict: refused("invalid_state", "The level changed meanwhile; refresh and try again."),
  limit: refused("limit", "The level can't change now."),
  invalid_level: refused(
    "invalid_state",
    "Lower goes down; raise goes up one level, or a chat back up to the lead's level.",
  ),
  not_eligible: refused("invalid_state", "The lead isn't eligible for the next level yet."),
  not_granted: refused("not_allowed", "Raising a level needs the owner's signed approval."),
};

const isKinChatError = Schema.is(KinChatError);
const isLevelRefused = Schema.is(KinLevels.KinLevelRefused);
const toChatError = (error: unknown) =>
  isKinChatError(error)
    ? Effect.fail(error)
    : isLevelRefused(error)
      ? Effect.fail(LEVEL_REFUSALS[error.reason])
      : Effect.logWarning("Kin levels failed", error).pipe(
          Effect.andThen(Effect.fail(unavailable)),
        );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const chat = yield* KinChatService;
  const repo = yield* Repository.KinChatRepository;
  const hub = yield* Hub.KinChatHub;
  const cache = yield* MemoryCache.MemoryCache;
  const pending = yield* KinPendingActions;
  let settle: KinShadowSettle | undefined;

  const withSql = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, SqlClient.SqlClient, sql);
  const run = <A>(operation: string, effect: Effect.Effect<A, SqlError.SqlError>) =>
    effect.pipe(Effect.mapError(toPersistenceSqlError(operation)));
  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((error) =>
          SqlError.isSqlError(error)
            ? toPersistenceSqlError("KinPromotion.transaction")(error)
            : error,
        ),
      );

  /** The caller is the lead's own owner, read from stored rows in the caller's org. */
  const asOwner = Effect.fn("KinPromotion.asOwner")(function* (
    people: ReadonlyArray<PersonIdentity>,
    lead: Lead,
  ) {
    const person = people.find((candidate) => candidate.orgId === lead.orgId);
    if (person === undefined) return yield* notFound;
    const rows = yield* run(
      "KinPromotion.asOwner",
      sql`SELECT 1 FROM kin_leads l
        JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
        JOIN kin_people p ON p.org_id = a.org_id AND p.person_id = a.owner_person_id
        WHERE l.org_id = ${lead.orgId} AND l.agent_id = ${lead.agentId}
          AND a.role = 'lead' AND a.retired_at IS NULL AND a.owner_person_id = ${person.personId}
        ORDER BY l.agent_id`,
    );
    if (rows.length === 0) return yield* notAllowed;
    return person;
  });

  // The lead's owner and its direct chat; cards preview entries, so they go nowhere else.
  const ownerChat = Effect.fn("KinPromotion.ownerChat")(function* (lead: Lead) {
    const [row] = yield* run(
      "KinPromotion.ownerChat",
      sql<{ name: string; chatId: string; owner: string }>`
        SELECT l.name, l.owner_chat_id AS "chatId", a.owner_person_id AS owner FROM kin_leads l
        JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
        JOIN kin_chats c ON c.org_id = l.org_id AND c.chat_id = l.owner_chat_id AND c.kind = 'direct'
        WHERE l.org_id = ${lead.orgId} AND l.agent_id = ${lead.agentId}
          AND a.role = 'lead' AND a.retired_at IS NULL
        ORDER BY l.agent_id`,
    );
    return row;
  });

  const putCard = Effect.fn("KinPromotion.putCard")(function* (input: {
    readonly lead: Lead;
    readonly widgetId: KinWidgetId;
    readonly type: "shadow_review" | "promotion";
    readonly title: string;
    readonly state: unknown;
    readonly create: boolean;
    readonly waiting: boolean;
    readonly closed: boolean;
  }) {
    const { orgId } = input.lead;
    yield* transaction(
      Effect.gen(function* () {
        const owner = yield* ownerChat(input.lead);
        if (owner === undefined) return;
        const updatedAt = iso(yield* Clock.currentTimeMillis);
        const awaiting = input.waiting ? [KinPersonId.make(owner.owner)] : [];
        const closedAt = input.closed ? updatedAt : null;
        const existing = yield* repo.getWidget({ orgId, widgetId: input.widgetId });
        if (Option.isNone(existing)) {
          if (!input.create) return;
          const { message } = yield* chat.notice({
            orgId,
            chatId: KinChatId.make(owner.chatId),
            messageId: KinMessageId.make(input.widgetId),
            body: input.title,
          });
          const widget: KinWidget = {
            orgId,
            chatId: message.chatId,
            widgetId: input.widgetId,
            messageId: message.messageId,
            widgetClass: "native",
            type: input.type,
            revision: 1,
            state: input.state,
            source: null,
            feed: null,
            awaiting,
            pinnedAt: null,
            closedAt,
            updatedAt,
          };
          yield* repo.insertWidget(widget);
          yield* sql.afterCommit(hub.publish({ type: "widget.updated", orgId, widget }));
          return;
        }
        const current = existing.value;
        if (current.type !== input.type) return;
        if (
          stableStringify(current.state) === stableStringify(input.state) &&
          (current.closedAt === null) === (closedAt === null) &&
          current.awaiting.length === awaiting.length
        )
          return;
        const widget = yield* repo.updateWidget({
          ...current,
          state: input.state,
          awaiting,
          closedAt,
          expectedRevision: current.revision,
          updatedAt,
        });
        yield* sql.afterCommit(hub.publish({ type: "widget.updated", orgId, widget }));
      }),
    );
  });

  const stats = (lead: Lead) =>
    withSql(KinLevels.promotionStats(lead)).pipe(
      Effect.map(({ levelSince, ...promotion }) => ({ promotion, levelSince })),
    );

  /** The review card for the owner-local day holding `at`; `create` only from the evening. */
  const drawReview = Effect.fn("KinPromotion.drawReview")(function* (
    lead: Lead,
    at: number,
    create: boolean,
  ) {
    const zone = yield* cache.ownerTimeZone(lead.orgId);
    const start = DateTime.startOf(DateTime.makeZonedUnsafe(at, { timeZone: zone }), "day");
    const from = DateTime.toEpochMillis(start);
    const until = DateTime.toEpochMillis(DateTime.add(start, { days: 1 }));
    const day = DateTime.formatIsoDate(start);
    const [count] = yield* run(
      "KinPromotion.reviewCount",
      sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_shadow_entries
        WHERE org_id = ${lead.orgId} AND agent_id = ${lead.agentId}
          AND created_at >= ${from} AND created_at < ${until}
        ORDER BY n`,
    );
    const total = count?.n ?? 0;
    if (total === 0) return;
    const [open] = yield* run(
      "KinPromotion.reviewUnreviewed",
      sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_shadow_entries
        WHERE org_id = ${lead.orgId} AND agent_id = ${lead.agentId}
          AND created_at >= ${from} AND created_at < ${until} AND verdict IS NULL
        ORDER BY n`,
    );
    const unreviewed = open?.n ?? 0;
    const owner = yield* ownerChat(lead);
    if (owner === undefined) return;
    // Unreviewed entries first, so the newest day's backlog never hides behind reviewed ones.
    const rows = yield* run(
      "KinPromotion.reviewEntries",
      sql<{
        entryId: string;
        tool: string;
        level: string;
        unlocksLevel: string;
        wouldTarget: string;
        json: string;
        createdAt: number;
        verdict: KinShadowVerdict | null;
      }>`SELECT entry_id AS "entryId", tool, level, unlocks_level AS "unlocksLevel",
          would_target AS "wouldTarget", input_json AS json, created_at AS "createdAt", verdict
        FROM kin_shadow_entries
        WHERE org_id = ${lead.orgId} AND agent_id = ${lead.agentId}
          AND created_at >= ${from} AND created_at < ${until}
        ORDER BY verdict IS NOT NULL, created_at, entry_id LIMIT ${REVIEW_ENTRIES}`,
    );
    const { promotion } = yield* stats(lead);
    const title = `Review what ${owner.name} would have done today: ${total - unreviewed} of ${total} reviewed, ${unreviewed} unreviewed`;
    const card = yield* decodeReview({
      agentId: lead.agentId,
      title,
      day,
      total,
      unreviewed,
      entries: yield* Effect.forEach(
        rows.toSorted((a, b) => a.createdAt - b.createdAt || (a.entryId < b.entryId ? -1 : 1)),
        (row) =>
          Effect.map(decodeJson(row.json), (parsed) => {
            const shown = describe(row.tool, parsed, KIN_SHADOW_REVIEW_TEXT_MAX);
            return {
              entryId: row.entryId,
              tool: row.tool,
              level: row.level,
              unlocksLevel: row.unlocksLevel,
              wouldTarget: row.wouldTarget,
              preview: shown.text,
              truncated: shown.truncated,
              createdAt: iso(row.createdAt),
              verdict: row.verdict,
            };
          }),
      ),
      promotion,
    });
    yield* putCard({
      lead,
      widgetId: reviewWidgetId(lead.agentId, day),
      type: "shadow_review",
      title,
      state: yield* encodeReview(card),
      create,
      waiting: false,
      closed: false,
    });
  });

  const readPromotion = Effect.fn("KinPromotion.readPromotion")(function* (
    orgId: KinOrgId,
    widgetId: KinWidgetId,
  ) {
    const widget = yield* repo.getWidget({ orgId, widgetId });
    if (Option.isNone(widget) || widget.value.type !== "promotion") return undefined;
    return yield* decodePromotion(widget.value.state);
  });

  const putPromotion = Effect.fn("KinPromotion.putPromotion")(function* (
    lead: Lead,
    card: KinPromotionCard,
  ) {
    yield* putCard({
      lead,
      widgetId: promotionWidgetId(lead.agentId, card.stats.to ?? card.stats.from),
      type: "promotion",
      title: card.title,
      state: yield* encodePromotion(card),
      create: true,
      waiting: card.status === "ready" || card.shadowMemory === "pending",
      closed:
        card.status === "closed" || (card.status === "raised" && card.shadowMemory !== "pending"),
    });
  });

  const actionOpen = Effect.fn("KinPromotion.actionOpen")(function* (
    orgId: KinOrgId,
    actionId: KinActionId | null,
  ) {
    if (actionId === null) return false;
    const action = yield* pending.get({ orgId, actionId });
    return Option.isSome(action) && OPEN_ACTION_STATES.includes(action.value.state);
  });

  /** What Keep would commit, for the card; null when the writer can't list it now. */
  const listShadow = Effect.fn("KinPromotion.listShadow")(function* (lead: Lead) {
    if (settle === undefined) return null;
    return yield* settle(lead.orgId, lead.agentId, { _tag: "preview" }).pipe(
      Effect.map(({ paths }) => {
        const ownerReviewed = paths.filter(isOwnerReviewedPath);
        return {
          paths: paths.slice(0, KIN_SHADOW_CHANGES_MAX),
          truncated: paths.length > KIN_SHADOW_CHANGES_MAX,
          ownerReviewed: ownerReviewed.slice(0, KIN_SHADOW_CHANGES_MAX),
        };
      }),
      Effect.catch((error) =>
        Effect.logWarning("Kin shadow memory list failed", { errorTag: error._tag }).pipe(
          Effect.as(null),
        ),
      ),
    );
  });

  /** Lead spec step 3: one card in the owner's direct chat once the lead is eligible. */
  const refresh = Effect.fn("KinPromotion.refresh")(function* (lead: Lead) {
    const { promotion } = yield* stats(lead);
    const owner = yield* ownerChat(lead);
    if (owner === undefined) return;
    const now = yield* Clock.currentTimeMillis;
    // The card that asked for the level the lead now holds has been granted.
    const reached = yield* readPromotion(
      lead.orgId,
      promotionWidgetId(lead.agentId, promotion.from),
    );
    if (reached?.status === "awaiting_approval") {
      const fromL0 = reached.stats.from === "L0";
      yield* putPromotion(lead, {
        ...reached,
        status: "raised",
        shadowMemory: fromL0 ? "pending" : null,
        shadowChanges: fromL0 ? yield* listShadow(lead) : null,
      });
    } else if (
      reached?.status === "raised" &&
      reached.shadowMemory === "pending" &&
      reached.shadowChanges === null
    ) {
      const listed = yield* listShadow(lead);
      if (listed !== null) yield* putPromotion(lead, { ...reached, shadowChanges: listed });
    }
    if (promotion.to === null) return;
    const to = promotion.to;
    const title = promotionTitle(owner.name, promotion);
    const ready = {
      agentId: lead.agentId,
      title,
      stats: promotion,
      status: "ready" as const,
      actionId: null,
      deferredUntil: null,
      shadowMemory: null,
      shadowChanges: null,
    };
    const card = yield* readPromotion(lead.orgId, promotionWidgetId(lead.agentId, to));
    if (card === undefined) {
      if (promotion.eligible) yield* putPromotion(lead, ready);
      return;
    }
    const updated = { ...card, title, stats: promotion };
    switch (card.status) {
      case "awaiting_approval":
        if (yield* actionOpen(lead.orgId, card.actionId)) return yield* putPromotion(lead, updated);
        return yield* putPromotion(
          lead,
          promotion.eligible ? ready : { ...updated, status: "closed" },
        );
      case "deferred": {
        const until = card.deferredUntil === null ? 0 : Date.parse(card.deferredUntil);
        return yield* putPromotion(lead, promotion.eligible && now >= until ? ready : updated);
      }
      case "ready":
        return yield* putPromotion(
          lead,
          promotion.eligible ? ready : { ...updated, status: "closed" },
        );
      case "closed":
        if (promotion.eligible) yield* putPromotion(lead, ready);
        return;
      case "raised":
        // The lead is back below this card's level: its shadow-memory choice no longer applies.
        return yield* putPromotion(
          lead,
          promotion.eligible
            ? ready
            : { ...updated, status: "closed", shadowMemory: null, shadowChanges: null },
        );
    }
  });

  const bestEffort = (what: string) =>
    Effect.catchCause((cause) => Effect.logWarning(`Kin ${what} failed`, { cause }));
  const refreshCards = (lead: Lead) => refresh(lead).pipe(bestEffort("promotion card refresh"));

  const openRaises = Effect.fn("KinPromotion.openRaises")(function* (lead: Lead) {
    const rows = yield* run(
      "KinPromotion.openRaises",
      sql<{ actionId: KinActionId; revision: number; state: string; targetJson: string }>`
        SELECT action_id AS "actionId", revision, state, target_json AS "targetJson"
        FROM kin_pending_actions
        WHERE org_id = ${lead.orgId} AND kind = 'set_level'
          AND json_extract(target_json, '$.agentId') = ${lead.agentId}
          AND state IN ('awaiting_approval', 'approved', 'executing')
        ORDER BY created_at, action_id`,
    );
    return yield* Effect.forEach(rows, (row) =>
      decodeTarget(row.targetJson).pipe(
        Effect.map((target) =>
          target._tag === "level" && isOpenRaiseState(row.state)
            ? [{ ...row, state: row.state, chatId: target.chatId ?? null, level: target.level }]
            : [],
        ),
      ),
    ).pipe(Effect.map((all) => all.flat()));
  });

  /**
   * A lower level withdraws the raises it overtook: the lead's own and every chat's above a new
   * lead level, or that chat's above a new chat cap. An executing raise is refused by its handler.
   */
  const closeRaises = Effect.fn("KinPromotion.closeRaises")(function* (
    lead: Lead,
    lowered: { readonly chatId?: KinChatId | undefined; readonly level: KinLevel },
  ) {
    for (const raise of yield* openRaises(lead)) {
      if (raise.state === "executing" || KinLevels.atLeast(lowered.level, raise.level)) continue;
      if (lowered.chatId !== undefined && raise.chatId !== lowered.chatId) continue;
      yield* pending.transition({
        orgId: lead.orgId,
        actionId: raise.actionId,
        revision: raise.revision,
        to: raise.state === "approved" ? "voided" : "cancelled",
        reason: "level_lowered",
      });
    }
  });

  const view = Effect.fn("KinPromotion.view")(function* (lead: Lead) {
    const { promotion, levelSince } = yield* stats(lead);
    const chats = yield* run(
      "KinPromotion.chatLevels",
      sql<{ chatId: string; level: string; since: number }>`
        SELECT chat_id AS "chatId", level, level_since AS since FROM kin_chat_levels
        WHERE org_id = ${lead.orgId} AND agent_id = ${lead.agentId}
        ORDER BY chat_id`,
    );
    return {
      orgId: lead.orgId,
      agentId: lead.agentId,
      level: promotion.from,
      levelSince: iso(levelSince),
      chats: yield* Effect.forEach(chats, (row) =>
        decodeLevel(row.level).pipe(
          Effect.map((level) => ({
            chatId: KinChatId.make(row.chatId),
            level,
            levelSince: iso(row.since),
          })),
        ),
      ),
      promotion,
      pendingRaises: (yield* openRaises(lead)).map(({ actionId, chatId, level, state }) => ({
        actionId,
        chatId,
        level,
        state,
      })),
    } satisfies KinLevelsView;
  });

  const promotion = KinPromotion.of({
    view: Effect.fn("KinPromotion.get")(function* (people, input) {
      yield* asOwner(people, input);
      return yield* view(input);
    }, Effect.catch(toChatError)),

    review: Effect.fn("KinPromotion.review")(function* (people, input) {
      const now = yield* Clock.currentTimeMillis;
      const reviewed = yield* transaction(
        Effect.gen(function* () {
          const [entry] = yield* run(
            "KinPromotion.entry",
            sql<{ agentId: string; level: string; verdict: string | null; createdAt: number }>`
                SELECT agent_id AS "agentId", level, verdict, created_at AS "createdAt"
                FROM kin_shadow_entries WHERE org_id = ${input.orgId} AND entry_id = ${input.entryId}
                ORDER BY entry_id`,
          );
          if (entry === undefined) return yield* notFound;
          const lead = { orgId: input.orgId, agentId: KinAgentId.make(entry.agentId) };
          yield* asOwner(people, lead);
          const updated = yield* run(
            "KinPromotion.verdict",
            sql`UPDATE kin_shadow_entries SET verdict = ${input.verdict},
                  verdict_note = ${input.note ?? null}, reviewed_at = ${now}
                WHERE org_id = ${input.orgId} AND entry_id = ${input.entryId}
                  AND agent_id = ${lead.agentId}
                RETURNING entry_id`,
          );
          if (updated.length === 0) return yield* notFound;
          const done = { lead, createdAt: entry.createdAt, loweredTo: null };
          // Lead spec step 5: harm in what the lead did at L1 or above costs it a level.
          const { promotion } = yield* stats(lead);
          const below = KinLevels.previousLevel(promotion.from);
          if (
            input.verdict !== "harmful" ||
            entry.verdict === "harmful" ||
            entry.level === "L0" ||
            below === undefined
          )
            return done;
          yield* withSql(KinLevels.lower({ ...lead, level: below }));
          const owner = yield* ownerChat(lead);
          if (owner !== undefined)
            yield* chat.notice({
              orgId: input.orgId,
              chatId: KinChatId.make(owner.chatId),
              messageId: KinMessageId.make(`kin-level-lowered:${input.entryId}`),
              body: `${owner.name} moved down to ${below}: you marked something it did at ${entry.level} as harmful. Raising it again takes another trial and your approval.`,
            });
          return { ...done, loweredTo: below };
        }),
      );
      if (reviewed.loweredTo !== null)
        yield* closeRaises(reviewed.lead, { level: reviewed.loweredTo }).pipe(
          bestEffort("raise withdrawal"),
        );
      yield* drawReview(reviewed.lead, reviewed.createdAt, false).pipe(
        bestEffort("review card refresh"),
      );
      yield* refreshCards(reviewed.lead);
      return { entryId: input.entryId, verdict: input.verdict, loweredTo: reviewed.loweredTo };
    }, Effect.catch(toChatError)),

    lower: Effect.fn("KinPromotion.lower")(function* (people, input) {
      yield* asOwner(people, input);
      yield* withSql(KinLevels.lower(input));
      yield* closeRaises(input, input).pipe(bestEffort("raise withdrawal"));
      yield* refreshCards(input);
      return yield* view(input);
    }, Effect.catch(toChatError)),

    raise: Effect.fn("KinPromotion.raise")(function* (people, input) {
      const person = yield* asOwner(people, input);
      const chatKey = input.chatId ?? "";
      // The lead, chat membership and eligibility are checked in the write that creates the row.
      const actionId = yield* transaction(
        Effect.gen(function* () {
          yield* withSql(KinLevels.checkRaise(input));
          const sameTarget = sql`kind = 'set_level' AND org_id = ${input.orgId}
              AND json_extract(target_json, '$.agentId') = ${input.agentId}
              AND json_extract(target_json, '$.level') = ${input.level}
              AND IFNULL(json_extract(target_json, '$.chatId'), '') = ${chatKey}`;
          const [open] = yield* run(
            "KinPromotion.openRaise",
            sql<{ actionId: KinActionId }>`SELECT action_id AS "actionId" FROM kin_pending_actions
                WHERE ${sameTarget} AND state IN ('awaiting_approval', 'approved', 'executing')
                ORDER BY created_at DESC, action_id LIMIT 1`,
          );
          if (open !== undefined) return open.actionId;
          // A closed request (rejected, expired) gets a fresh one; a double tap lands on one row.
          const [count] = yield* run(
            "KinPromotion.raiseCount",
            sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_pending_actions WHERE ${sameTarget}
                ORDER BY n`,
          );
          const owner = yield* ownerChat(input);
          const target = {
            _tag: "level" as const,
            agentId: input.agentId,
            ...(input.chatId === undefined ? {} : { chatId: input.chatId }),
            level: input.level,
          };
          const created = yield* pending.create({
            orgId: input.orgId,
            kind: "set_level",
            target,
            resolved: { _tag: "none" },
            targetDigest: kinTargetDigest("set_level", target, { _tag: "none" }),
            reason: `Raise ${owner?.name ?? "the lead"} to ${input.level}${input.chatId === undefined ? "" : " in this chat"}, from the owner's promotion card.`,
            requestedBy: {
              agentId: KinAgentId.make(KIN_PROMOTION_REQUESTER),
              threadId: ThreadId.make(KIN_PROMOTION_REQUESTER),
            },
            provenance: {
              startedBy: { humanId: person.personId },
              startedByRole: "owner",
              chain: [],
              ceilingBelowOwner: false,
            },
            source: KinEventId.make(
              `promotion:${input.agentId}:${chatKey || "lead"}:${input.level}:${count?.n ?? 0}`,
            ),
          });
          return created.action.id;
        }),
      );
      if (input.chatId === undefined) {
        const card = yield* readPromotion(
          input.orgId,
          promotionWidgetId(input.agentId, input.level),
        );
        const { promotion } = yield* stats(input);
        if (card !== undefined)
          yield* putPromotion(input, {
            ...card,
            stats: promotion,
            status: "awaiting_approval",
            actionId,
            deferredUntil: null,
          });
      }
      return { actionId };
    }, Effect.catch(toChatError)),

    deferPromotion: Effect.fn("KinPromotion.deferPromotion")(function* (people, input) {
      yield* asOwner(people, input);
      const { promotion } = yield* stats(input);
      const card =
        promotion.to === null
          ? undefined
          : yield* readPromotion(input.orgId, promotionWidgetId(input.agentId, promotion.to));
      if (card === undefined || card.status !== "ready")
        return yield* refused("invalid_state", "There is no promotion card to put off.");
      const now = yield* Clock.currentTimeMillis;
      yield* putPromotion(input, {
        ...card,
        stats: promotion,
        status: "deferred",
        deferredUntil: iso(now + 7 * DAY_MS),
      });
      return yield* view(input);
    }, Effect.catch(toChatError)),

    shadowMemory: Effect.fn("KinPromotion.shadowMemory")(function* (people, input) {
      yield* asOwner(people, input);
      const { promotion } = yield* stats(input);
      // At L0 the lead still reads and writes its shadow branch.
      if (promotion.from === "L0")
        return yield* refused(
          "invalid_state",
          "The lead is still at L0; its shadow memory is in use.",
        );
      if (settle === undefined)
        return yield* refused("unavailable", "Kin memory isn't running on this host.");
      const card = yield* readPromotion(input.orgId, promotionWidgetId(input.agentId, "L1"));
      const pendingCard = card?.shadowMemory === "pending" ? card : undefined;
      const notKept = (message: string) =>
        refused("invalid_state", `Shadow memory wasn't kept: ${message}`);
      const relist = Effect.gen(function* () {
        if (pendingCard === undefined) return;
        const listed = yield* listShadow(input);
        yield* putPromotion(input, { ...pendingCard, shadowChanges: listed });
      }).pipe(bestEffort("shadow memory list"));
      let choice: Parameters<KinShadowSettle>[2] = { _tag: "discard" };
      if (input.choice === "keep") {
        // The owner's tap is the review, so Keep commits only a list the card showed in full.
        const shown = pendingCard?.shadowChanges ?? null;
        if (shown === null) {
          yield* relist;
          return yield* notKept(
            "check the changed paths on the promotion card, then choose again.",
          );
        }
        if (shown.ownerReviewed.length > 0)
          return yield* notKept(
            `it changes paths you review in a pull request (${shown.ownerReviewed.slice(0, 5).join(", ")}). Start clean instead.`,
          );
        if (shown.truncated)
          return yield* notKept(
            "it changes more paths than the card can list. Start clean instead.",
          );
        choice = { _tag: "keep", paths: shown.paths };
      }
      yield* settle(input.orgId, input.agentId, choice).pipe(
        Effect.catch((error) =>
          error._tag === "MemorySyncConflict"
            ? relist.pipe(Effect.andThen(Effect.fail(notKept(`${error.reason ?? "it changed"}.`))))
            : Effect.fail(
                error._tag === "MemorySecretBlocked"
                  ? notKept("it contains what looks like a secret. Start clean instead.")
                  : unavailable,
              ),
        ),
      );
      if (pendingCard !== undefined)
        yield* putPromotion(input, {
          ...pendingCard,
          shadowMemory: input.choice === "keep" ? "kept" : "discarded",
        });
      return yield* view(input);
    }, Effect.catch(toChatError)),

    evening: Effect.fn("KinPromotion.evening")(function* (lead) {
      yield* drawReview(lead, yield* Clock.currentTimeMillis, true).pipe(
        bestEffort("evening review card"),
      );
      yield* refreshCards(lead);
    }),

    attachShadowMemory: Effect.fn("KinPromotion.attachShadowMemory")(function* (next) {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          settle = next;
        }),
        () =>
          Effect.sync(() => {
            if (settle === next) settle = undefined;
          }),
      );
    }),
  });
  return { promotion, cards: KinLevels.KinPromotionCards.of({ refresh: refreshCards }) };
});

export const layer = Layer.effectContext(
  make.pipe(
    Effect.map(({ promotion, cards }) =>
      Context.make(KinPromotion, promotion).pipe(Context.add(KinLevels.KinPromotionCards, cards)),
    ),
  ),
).pipe(Layer.provide(MemoryCache.layer));
