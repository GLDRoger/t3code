import {
  KinChatId,
  KinEvent,
  KinMessageId,
  KinOrgId,
  KinRoutineCard,
  KinWidgetId,
  WorkerReport,
  type KinAgentId,
  type KinLeadRoutine,
  type KinWidget,
  type MemoryItemHead,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as Chat from "../chat/KinChatService.ts";
import { memoryDateMillis } from "../memory/frontMatter.ts";
import * as Memory from "../memory/Memory.ts";
import * as MemoryCache from "../memory/MemoryCache.ts";
import { deferralWidgetId } from "../triggers/deferrals.ts";
import {
  renderRoutine,
  type EveningFacts,
  type MorningFacts,
  type RoutineHeader,
  type RoutineRow,
} from "./routines.ts";

type RoutineEvent = Extract<KinEvent, { readonly _tag: "routine" }>;

export interface KinRoutineGithubState {
  readonly reviews: ReadonlyArray<{
    readonly repo: string;
    readonly number: number;
    readonly title: string;
    readonly url: string;
  }>;
  readonly ciRed: ReadonlyArray<{ readonly repo: string; readonly branch: string }>;
  readonly failedRepos: number;
  readonly repos: number;
}
export interface KinRoutineGithubReaderShape {
  /** Read-only; per-repo failures are counted, never raised. */
  readonly read: (orgId: KinOrgId, login: string | null) => Effect.Effect<KinRoutineGithubState>;
}
// githubReaders.ts provides this when the Kin App is configured; without it the brief says so.
export const KinRoutineGithubReader = Context.Reference<KinRoutineGithubReaderShape | null>(
  "t3/kin/lead/RoutineContent/KinRoutineGithubReader",
  { defaultValue: () => null },
);

export class KinRoutineContentError extends Schema.TaggedError<KinRoutineContentError>()(
  "KinRoutineContentError",
  { orgId: KinOrgId, cause: Schema.Defect() },
) {}

/** Server-written morning briefs and evening summaries, posted to the lead owner's direct chat. */
export class KinRoutineContent extends Context.Service<
  KinRoutineContent,
  {
    readonly post: (
      agentId: KinAgentId,
      event: RoutineEvent,
    ) => Effect.Effect<KinWidget | null, KinRoutineContentError>;
  }
>()("t3/kin/lead/RoutineContent/KinRoutineContent") {}

const DAY_MS = 86_400_000;
const GITHUB_BUDGET = "10 seconds";
const decodeReport = Schema.decodeUnknownOption(Schema.fromJsonString(WorkerReport));
const decodeTokens = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        turnTokenUsage: Schema.optional(
          Schema.Struct({
            inputTokens: Schema.optional(Schema.Number),
            cachedInputTokens: Schema.optional(Schema.Number),
          }),
        ),
      }),
    ),
  ),
);
const encodeCard = Schema.encodeEffect(KinRoutineCard);
const isPostable = (routine: KinLeadRoutine): routine is "morning_brief" | "evening_summary" =>
  routine === "morning_brief" || routine === "evening_summary";
export const isRoutineContent = (event: KinEvent): event is RoutineEvent =>
  event._tag === "routine" && isPostable(event.routine);
const routineWidgetId = (orgId: KinOrgId, event: RoutineEvent) =>
  KinWidgetId.make(`routine:${orgId}:${event.eventId}`);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const memory = yield* Memory.Memory;
  const cache = yield* MemoryCache.MemoryCache;
  const chat = yield* Chat.KinChatService;
  const repo = yield* Repository.KinChatRepository;
  const hub = yield* Hub.KinChatHub;
  const reader = yield* KinRoutineGithubReader;

  const lead = Effect.fn("KinRoutineContent.lead")(function* (
    orgId: KinOrgId,
    agentId: KinAgentId,
  ) {
    const [row] = yield* sql<{ chatId: string; personId: string; login: string | null }>`
      SELECT l.owner_chat_id AS "chatId", a.owner_person_id AS "personId", p.github_login AS login
      FROM kin_leads l
      JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      JOIN kin_chats c ON c.org_id = l.org_id AND c.chat_id = l.owner_chat_id
      LEFT JOIN kin_people p ON p.org_id = a.org_id AND p.person_id = a.owner_person_id
      WHERE l.org_id = ${orgId} AND l.agent_id = ${agentId}
        AND a.role = 'lead' AND a.retired_at IS NULL
      ORDER BY l.agent_id`;
    return row;
  });

  const gather = Effect.fn("KinRoutineContent.gather")(function* (
    orgId: KinOrgId,
    event: RoutineEvent & { readonly routine: "morning_brief" | "evening_summary" },
    owner: { readonly personId: string; readonly login: string | null },
  ) {
    const now = yield* Clock.currentTimeMillis;
    const zone = yield* cache.ownerTimeZone(orgId);
    const local = DateTime.makeZonedUnsafe(now, { timeZone: zone });
    const dayStart = DateTime.toEpochMillis(DateTime.startOf(local, "day"));
    const dayEnd = DateTime.toEpochMillis(
      DateTime.add(DateTime.startOf(local, "day"), { days: 1 }),
    );
    const day = DateTime.formatIsoDate(local);
    const dayOf = (ms: number) =>
      DateTime.formatIsoDate(DateTime.makeZonedUnsafe(ms, { timeZone: zone }));
    const dayLabel = (ms: number) =>
      new Intl.DateTimeFormat("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        timeZone: zone,
      }).format(ms);
    const timeLabel = (ms: number) =>
      new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone: zone,
      }).format(ms);

    const all = (yield* memory.query(orgId, {})).filter(
      (item) => item.orgId === orgId && !item.duplicate,
    );
    const live = all.filter(
      (item) => item.invalid_at === null && item.superseded_by === null && item.status === "open",
    );
    const due = (item: MemoryItemHead) => memoryDateMillis(item.due);
    const byDue = (a: MemoryItemHead, b: MemoryItemHead) =>
      due(a) - due(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const dueBetween = (from: number, until: number) =>
      live
        .filter(
          (item) =>
            (item.kind === "deferral" || item.kind === "commitment") &&
            due(item) >= from &&
            due(item) < until,
        )
        .toSorted(byDue);
    const row = (item: MemoryItemHead, note?: string): RoutineRow => ({
      title: item.title,
      itemId: item.id,
      ...(note === undefined ? {} : { note }),
      ...(item.links[0] === undefined ? {} : { link: item.links[0] }),
    });

    const waitingRows = yield* sql<{ reason: string; createdAt: string; body: string | null }>`
      SELECT w.reason, w.created_at AS "createdAt", m.body
      FROM kin_waiting w
      LEFT JOIN kin_messages m ON m.org_id = w.org_id AND m.message_id = w.message_id
      WHERE w.org_id = ${orgId} AND w.person_id = ${owner.personId} AND w.resolved_at IS NULL
      ORDER BY w.created_at, w.waiting_id`;
    const waiting = waitingRows.map((waitingRow): RoutineRow => ({
      title: waitingRow.body ?? waitingRow.reason,
      note: `${waitingRow.reason}, since ${dayLabel(Date.parse(waitingRow.createdAt))}`,
    }));
    const budgetUnits = Effect.fn("KinRoutineContent.budgetUnits")(function* (budgetDay: string) {
      const [budget] = yield* sql<{ units: number }>`
        SELECT lead_units + worker_units AS units FROM kin_budget
        WHERE org_id = ${orgId} AND day = ${budgetDay} ORDER BY day`;
      return budget?.units ?? null;
    });

    if (event.routine === "morning_brief") {
      const dueToday = yield* Effect.forEach(dueBetween(dayStart, dayEnd), (item) =>
        Effect.gen(function* () {
          const base = row(item, `${timeLabel(due(item))}, ${item.owner ?? item.said_by}`);
          if (item.kind !== "deferral") return base;
          const widgetId = KinWidgetId.make(deferralWidgetId(orgId, item.id));
          const card = yield* repo.getWidget({ orgId, widgetId });
          return Option.isSome(card) &&
            card.value.type === "deferral" &&
            card.value.closedAt === null
            ? { ...base, widgetId }
            : base;
        }),
      );
      const pinged = new Set(
        (yield* sql<{ itemId: string }>`
          SELECT DISTINCT item_id AS "itemId" FROM kin_ping_ledger
          WHERE org_id = ${orgId} ORDER BY item_id`).map((ping) => ping.itemId),
      );
      const overdue = live
        .filter((item) => item.kind === "commitment" && due(item) < dayStart)
        .toSorted(byDue)
        .map((item) =>
          row(
            item,
            `since ${dayLabel(due(item))}, ${pinged.has(item.id) ? "pinged" : "no ping yet"}`,
          ),
        );
      const objectives = live
        .filter((item) => item.kind === "objective" && due(item) < dayEnd + 7 * DAY_MS)
        .toSorted(byDue)
        .map((item) =>
          row(
            item,
            due(item) < now ? `overdue since ${dayLabel(due(item))}` : `due ${dayLabel(due(item))}`,
          ),
        );
      const workers = yield* sql<{ status: string; report: string | null }>`
        SELECT status, report_json AS report FROM kin_workers
        WHERE org_id = ${orgId} AND (status = 'queued' OR (report_json IS NOT NULL AND ended_at >= ${now - DAY_MS}))
        ORDER BY started_at, worker_id`;
      const workersBlocked = workers.flatMap((worker): ReadonlyArray<RoutineRow> => {
        if (worker.status === "queued" || worker.report === null) return [];
        const report = decodeReport(worker.report);
        return Option.isSome(report) && report.value.result !== "done"
          ? [{ title: report.value.summary, note: report.value.result.replace("_", " ") }]
          : [];
      });
      const [postponed] = yield* sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM kin_events
        WHERE org_id = ${orgId} AND state = 'queued' AND budget_deferred = 1 ORDER BY n`;
      const github =
        reader === null
          ? Option.none()
          : yield* reader.read(orgId, owner.login).pipe(Effect.timeoutOption(GITHUB_BUDGET));
      const pastReview = live
        .filter((item) => memoryDateMillis(item.review_by) < now)
        .toSorted(
          (a, b) =>
            memoryDateMillis(a.review_by) - memoryDateMillis(b.review_by) ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )
        .slice(0, 3)
        .map((item) => row(item, `review by ${item.review_by}`));
      const facts: MorningFacts = {
        routine: "morning_brief",
        dueToday,
        overdue,
        waiting,
        reviews: Option.match(github, {
          onNone: () => [],
          onSome: (state) =>
            state.reviews.map((pull) => ({
              title: `${pull.repo}#${pull.number} ${pull.title}`,
              link: pull.url,
            })),
        }),
        ciRed: Option.match(github, {
          onNone: () => [],
          onSome: (state) => state.ciRed.map((red) => ({ title: `${red.repo} ${red.branch}` })),
        }),
        github:
          reader === null
            ? "off"
            : Option.isNone(github) || github.value.failedRepos > 0
              ? "partial"
              : "read",
        objectives,
        workersRunning: workers.filter((worker) => worker.status === "queued").length,
        workersBlocked,
        postponed: postponed?.n ?? 0,
        yesterdayUnits: yield* budgetUnits(dayOf(dayStart - 1)),
        pastReview,
      };
      return { day, dayLabel, timeLabel, facts };
    }

    const reports = yield* sql<{ report: string }>`
      SELECT report_json AS report FROM kin_workers
      WHERE org_id = ${orgId} AND report_json IS NOT NULL AND ended_at >= ${dayStart}
      ORDER BY ended_at, worker_id`;
    const done = reports.flatMap((report): ReadonlyArray<RoutineRow> => {
      const decoded = decodeReport(report.report);
      if (Option.isNone(decoded) || decoded.value.result !== "done") return [];
      const evidence = decoded.value.evidence.find(
        (item) => item.kind === "pr" || item.kind === "commit" || item.kind === "ci_run",
      );
      return [
        { title: decoded.value.summary, ...(evidence === undefined ? {} : { link: evidence.ref }) },
      ];
    });
    const recordedToday = (item: MemoryItemHead) => {
      const recorded = memoryDateMillis(item.recorded_at);
      return recorded >= dayStart && recorded < dayEnd;
    };
    const moved = live.flatMap((item): ReadonlyArray<RoutineRow> => {
      if (!recordedToday(item)) return [];
      const previous = all.find((old) => old.superseded_by === item.id && old.due !== item.due);
      return previous === undefined || !Number.isFinite(due(item))
        ? []
        : [row(item, `now ${dayLabel(due(item))}`)];
    });
    const missed = dueBetween(dayStart, now).map((item) =>
      row(item, `was due ${timeLabel(due(item))}, still open`),
    );
    const [failed] = yield* sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM kin_wakeups
      WHERE org_id = ${orgId} AND status IN ('failed', 'timed_out') AND started_at >= ${dayStart}
      ORDER BY n`;
    const [dreams] = yield* sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM kin_dream_runs
      WHERE org_id = ${orgId} AND owner_date = ${day} AND status = 'failed' ORDER BY n`;
    const charges = yield* sql<{ tokens: string }>`
      SELECT tokens_json AS tokens FROM kin_budget_charges
      WHERE org_id = ${orgId} AND day = ${day} ORDER BY wakeup_id`;
    let input = 0;
    let cached = 0;
    for (const charge of charges)
      for (const turn of Option.getOrElse(decodeTokens(charge.tokens), () => [])) {
        const incoming = turn.turnTokenUsage?.inputTokens ?? 0;
        if (!Number.isFinite(incoming) || incoming <= 0) continue;
        input += incoming;
        cached += Math.min(incoming, Math.max(0, turn.turnTokenUsage?.cachedInputTokens ?? 0));
      }
    const facts: EveningFacts = {
      routine: "evening_summary",
      done,
      slipped: [...moved, ...missed],
      promised: live
        .filter((item) => item.kind === "commitment" && recordedToday(item))
        .map((item) => row(item, item.said_by)),
      waiting,
      dueTomorrow: dueBetween(dayEnd, dayEnd + DAY_MS).map((item) =>
        row(item, timeLabel(due(item))),
      ),
      units: yield* budgetUnits(day),
      cacheHitRate: input === 0 ? null : cached / input,
      failedWakeups: failed?.n ?? 0,
      failedDreams: dreams?.n ?? 0,
    };
    return { day, dayLabel, timeLabel, facts };
  });

  const post = Effect.fn("KinRoutineContent.post")(
    function* (agentId: KinAgentId, event: RoutineEvent) {
      const orgId = event.orgId;
      if (!isPostable(event.routine) || event.agentId !== agentId) return null;
      const routine = event.routine;
      const widgetId = routineWidgetId(orgId, event);
      const existing = yield* repo.getWidget({ orgId, widgetId });
      if (Option.isSome(existing)) return existing.value;
      const owner = yield* lead(orgId, agentId);
      if (owner === undefined) return null;
      // Memory takes its own lock, so facts are read before the write transaction.
      const gathered = yield* gather(orgId, { ...event, routine }, owner);
      const dueMs = event.dueAt === undefined ? null : DateTime.toEpochMillis(event.dueAt);
      const header: RoutineHeader = {
        day: gathered.day,
        dayLabel: gathered.dayLabel(yield* Clock.currentTimeMillis),
        dueLabel: dueMs === null ? null : gathered.timeLabel(dueMs),
        lateByMs: event.lateByMs ?? 0,
        folded: (event.foldedRoutines ?? []).map((fold) => ({
          routine: fold.routine,
          dayLabel: gathered.dayLabel(DateTime.toEpochMillis(fold.dueAt)),
        })),
      };
      const { body, card } = renderRoutine(header, gathered.facts);
      const state = yield* encodeCard(card);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const again = yield* repo.getWidget({ orgId, widgetId });
          if (Option.isSome(again)) return again.value;
          // The chat is re-read here so the post lands only in this org's live owner chat.
          const current = yield* lead(orgId, agentId);
          if (current === undefined) return null;
          const { message } = yield* chat.notice({
            orgId,
            chatId: KinChatId.make(current.chatId),
            messageId: KinMessageId.make(widgetId),
            body,
          });
          const widget: KinWidget = {
            orgId,
            chatId: message.chatId,
            widgetId,
            messageId: message.messageId,
            widgetClass: "native",
            type: "routine",
            revision: 1,
            state,
            source: null,
            feed: null,
            awaiting: [],
            pinnedAt: null,
            closedAt: null,
            updatedAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
          };
          yield* repo.insertWidget(widget);
          yield* sql.afterCommit(hub.publish({ type: "widget.updated", orgId, widget }));
          return widget;
        }),
      );
    },
    (effect, _agentId, event) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new KinRoutineContentError({
              orgId: event.orgId,
              cause: isSqlError(cause)
                ? toPersistenceSqlError("KinRoutineContent.post")(cause)
                : cause,
            }),
        ),
      ),
  );

  return KinRoutineContent.of({ post });
});

export const layer = Layer.effect(KinRoutineContent, make).pipe(Layer.provide(MemoryCache.layer));
