import {
  KinChatId,
  KinDeferralCard,
  KinMemoryItemId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  type KinTriggerFired,
  type MemoryItemHead,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";

import { PersistenceDecodeError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as Chat from "../chat/KinChatService.ts";
import { WorkerLaunchGate } from "../lead/Workers.ts";
import * as Memory from "../memory/Memory.ts";
import * as MemoryCache from "../memory/MemoryCache.ts";
import { readGithubLinks } from "./deferralGithub.ts";
import {
  DeferralSnapshot,
  GRACE_MS,
  HEADS_UP_MS,
  LATE_NOTE_MS,
  KinDeferralStopSwitch,
  deferralTriggerId,
  lateNote,
  ownerDateTime,
  ownerTime,
  snapshotChanges,
  startsAtLevel,
  makeDeferralCards,
  makeDeferralStarter,
} from "./deferrals.ts";
import * as KinTriggerInbox from "./KinTriggerInbox.ts";
import * as Pings from "./pings.ts";

export class KinDeferralFlowError extends Schema.TaggedError<KinDeferralFlowError>()(
  "KinDeferralFlowError",
  { orgId: KinOrgId, cause: Schema.Defect() },
) {}

export class KinDeferralFlow extends Context.Service<
  KinDeferralFlow,
  {
    /**
     * Consumes this org's pending deferral fires (recheck, heads-up, grace, start or ask),
     * then sweeps its pings so chases deliver once quiet hours end.
     */
    readonly drain: (orgId: KinOrgId) => Effect.Effect<void, KinDeferralFlowError>;
  }
>()("t3/kin/triggers/deferralFlow/KinDeferralFlow") {}

interface Run {
  readonly state: string;
  readonly dueAt: number | null;
  readonly onDue: string;
  readonly snapshot: string;
}
type Step =
  | { readonly kind: "drop" }
  | { readonly kind: "heads_up"; readonly dueAt: number }
  | { readonly kind: "due"; readonly dueAt: number; readonly grace: boolean };

/** Which step a fire takes, from its run row. Disarmed, moved and handled runs drop it. */
function classifyFire(
  run: Run | undefined,
  graceEndsAt: number | undefined,
  phase: "heads_up" | "due",
  fireAt: number,
  now: number,
): Step {
  if (run === undefined || run.state === "disarmed" || run.dueAt === null) return { kind: "drop" };
  const dueAt = run.dueAt;
  if (phase === "heads_up")
    return run.onDue === "start" &&
      run.state === "armed" &&
      fireAt === dueAt - HEADS_UP_MS &&
      now < dueAt
      ? { kind: "heads_up", dueAt }
      : { kind: "drop" };
  if (fireAt === dueAt)
    return run.state === "armed" || (run.onDue === "start" && run.state === "heads_up")
      ? { kind: "due", dueAt, grace: false }
      : { kind: "drop" };
  // A late due fire re-arms the due trigger at the end of its grace window.
  return run.onDue === "start" && run.state === "grace" && fireAt === graceEndsAt
    ? { kind: "due", dueAt, grace: true }
    : { kind: "drop" };
}

const decodeOnDue = Schema.decodeUnknownEffect(KinDeferralCard.fields.onDue);
const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(DeferralSnapshot));
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(DeferralSnapshot));
const isDecodeError = Schema.is(PersistenceDecodeError);
const isPermanent = (error: unknown) => {
  let current = error;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    if (Schema.isSchemaError(current) || isDecodeError(current)) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
};
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const SWEEP_EVERY_MS = 60_000;
const RETRY_FIRST_MS = 60_000;
const RETRY_MAX_MS = 15 * 60_000;
const GIVE_UP_MS = 24 * 60 * 60 * 1000;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const inbox = yield* KinTriggerInbox.KinTriggerInbox;
  const memory = yield* Memory.Memory;
  const cache = yield* MemoryCache.MemoryCache;
  const chat = yield* Chat.KinChatService;
  const pings = yield* Pings.KinPings;
  const ticks = yield* Scheduler.Scheduler;
  const cards = yield* makeDeferralCards;
  const start = yield* makeDeferralStarter;
  // Per process: the 24 h give-up is the durable bound, so a restart only retries sooner.
  const retries = new Map<string, { readonly notBefore: number; readonly failures: number }>();
  const sweptAt = new Map<KinOrgId, number>();

  const readRun = (orgId: KinOrgId, itemId: KinMemoryItemId) =>
    sql<Run>`SELECT state, due_at AS "dueAt", on_due AS "onDue", snapshot_json AS snapshot
      FROM kin_deferral_runs WHERE org_id = ${orgId} AND item_id = ${itemId} ORDER BY item_id`.pipe(
      Effect.map((rows) => rows[0]),
    );
  const readItem = (orgId: KinOrgId, itemId: KinMemoryItemId) =>
    memory.readItemQuietly(orgId, itemId).pipe(
      Effect.map((item): MemoryItemHead | undefined => item.head),
      Effect.catchTags({
        MemoryNotFound: () => Effect.undefined,
        MemoryDuplicateId: () => Effect.undefined,
      }),
    );
  // The item's chat when it belongs to the org, else the owner's direct chat.
  const cardChat = Effect.fn("KinDeferralFlow.cardChat")(function* (
    orgId: KinOrgId,
    item: MemoryItemHead | undefined,
  ) {
    if (item?.chat !== undefined) {
      const [own] = yield* sql`SELECT 1 FROM kin_chats
        WHERE org_id = ${orgId} AND chat_id = ${item.chat} ORDER BY chat_id`;
      if (own !== undefined) return KinChatId.make(item.chat);
    }
    const [lead] = yield* sql<{
      chatId: string;
    }>`SELECT l.owner_chat_id AS "chatId" FROM kin_leads l
      JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      WHERE l.org_id = ${orgId} AND a.retired_at IS NULL ORDER BY l.agent_id LIMIT 1`;
    return lead === undefined ? null : KinChatId.make(lead.chatId);
  });

  const prepareChase = Effect.fn("KinDeferralFlow.prepareChase")(function* (
    orgId: KinOrgId,
    item: MemoryItemHead,
    dueAt: number,
    timeZone: string,
  ) {
    const handle = item.owner ?? item.said_by;
    const [person] = yield* sql<{ personId: string }>`SELECT person_id AS "personId"
      FROM kin_people WHERE org_id = ${orgId} AND handle = ${handle} ORDER BY person_id`;
    const [owner] = yield* sql<{ owner: string; chatId: string }>`SELECT a.owner_person_id AS owner,
      l.owner_chat_id AS "chatId" FROM kin_leads l
      JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      WHERE l.org_id = ${orgId} AND a.retired_at IS NULL ORDER BY l.agent_id LIMIT 1`;
    if (person === undefined || owner === undefined || item.chat === undefined)
      return `I couldn't chase ${handle}`;
    const put = yield* pings
      .put(
        {
          orgId,
          person: KinPersonId.make(person.personId),
          itemId: item.id,
          chatId: item.chat,
          owner: KinPersonId.make(owner.owner),
          ownerChatId: KinChatId.make(owner.chatId),
          nextStep: `${item.title} was due ${ownerDateTime(dueAt, timeZone)}. What's the status?`,
        },
        item,
      )
      .pipe(Effect.result);
    if (put._tag === "Failure") {
      yield* Effect.logWarning("Kin deferral chase failed", { orgId, itemId: item.id });
      return `I couldn't chase ${handle}`;
    }
    return null;
  });

  const process = Effect.fn("KinDeferralFlow.process")(function* (
    orgId: KinOrgId,
    fire: KinTriggerFired,
    itemId: KinMemoryItemId,
    phase: "heads_up" | "due",
    now: number,
    timeZone: string,
  ) {
    const fireAt = Date.parse(fire.dueAt);
    const run = yield* readRun(orgId, itemId).pipe(NodeSqliteClient.readOnly);
    const snapshot = run === undefined ? undefined : yield* decodeSnapshot(run.snapshot);
    const step = classifyFire(run, snapshot?.graceEndsAt, phase, fireAt, now);
    if (step.kind === "drop" || run === undefined || snapshot === undefined)
      return yield* inbox.markConsumed(orgId, [fire.fireId]).pipe(Effect.as(false));

    // Read-only or idempotent I/O; a replay repeats it.
    const item = yield* readItem(orgId, itemId);
    const onDue = run.onDue;
    const decodedOnDue = yield* decodeOnDue(onDue);
    const gates: Array<string> = [];
    if (onDue === "start") {
      const github = yield* readGithubLinks(orgId, item?.links ?? snapshot.links);
      gates.push(...snapshotChanges(snapshot, item, github));
      if (yield* (yield* KinDeferralStopSwitch).isStopped(orgId))
        gates.push("the stop switch is on");
      if (!(yield* WorkerLaunchGate)) gates.push("workers can't launch yet");
    }
    // No memory or GitHub I/O below: the memory lock can wait on this writer.
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const pending = yield* sql`SELECT fire_id FROM kin_trigger_inbox WHERE org_id = ${orgId}
          AND fire_id = ${fire.fireId} AND consumed_at IS NULL ORDER BY fire_id`;
        if (pending.length === 0) return false;
        const reasons = [...gates];
        const current = yield* readRun(orgId, itemId);
        // Moved or handled since the reads above: classify again on the next tick.
        if (
          current?.state !== run.state ||
          current.dueAt !== run.dueAt ||
          current.snapshot !== run.snapshot
        )
          return false;
        const dueAt = step.dueAt;
        const title = item?.title ?? itemId;
        const card = (phase: KinDeferralCard["phase"], text: string, graceEndsAt?: number) => ({
          itemId,
          title,
          dueAt: iso(dueAt),
          onDue: decodedOnDue,
          text,
          phase,
          ...(graceEndsAt === undefined ? {} : { graceEndsAt: iso(graceEndsAt) }),
        });
        const setState = (state: string) =>
          sql`UPDATE kin_deferral_runs SET state = ${state}, updated_at = ${now}
            WHERE org_id = ${orgId} AND item_id = ${itemId} AND due_at = ${dueAt}
              AND state = ${run.state}`;
        const post = Effect.fn("KinDeferralFlow.post")(function* (state: KinDeferralCard) {
          const chatId = yield* cardChat(orgId, item);
          yield* cards.write({ orgId, itemId, state, chatId, now });
        });
        const ask = Effect.fn("KinDeferralFlow.ask")(function* (why: ReadonlyArray<string>) {
          const reason = why.length === 0 ? "" : ` I won't start it on my own: ${why.join("; ")}.`;
          yield* post(
            card(
              "asked",
              `${title} is due at ${ownerTime(dueAt, now, timeZone)}. Start it, move it to Monday, or cancel it?${reason}${lateNote(dueAt, now, timeZone)}`,
            ),
          );
          yield* setState("asked");
        });

        if (onDue === "start") {
          const [lead] = yield* sql<{ level: string }>`SELECT l.level FROM kin_leads l
            JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
            WHERE l.org_id = ${orgId} AND a.retired_at IS NULL ORDER BY l.agent_id LIMIT 1`;
          if (lead === undefined) reasons.push("there is no active lead");
          else if (!startsAtLevel(lead.level)) reasons.push(`Kin is at ${lead.level}, below L2`);
        }

        if (step.kind === "heads_up") {
          if (reasons.length > 0) yield* ask(reasons);
          else {
            yield* post(
              card("heads_up", `Starting ${title} at ${ownerTime(dueAt, now, timeZone)}.`),
            );
            yield* setState("heads_up");
          }
        } else if (onDue === "start") {
          const anchor = step.grace ? fireAt : dueAt;
          const late = now - anchor;
          if (late > GRACE_MS) yield* ask([...reasons, "it's more than 30 minutes late"]);
          else if (reasons.length > 0) yield* ask(reasons);
          else if (!step.grace && (run.state === "armed" || late > LATE_NOTE_MS)) {
            // No heads-up was shown, or it was shown too long ago: give the grace from now.
            const graceEnd = now + GRACE_MS;
            yield* post(
              card(
                "heads_up",
                `Starting ${title} at ${ownerTime(graceEnd, now, timeZone)}.${lateNote(dueAt, now, timeZone)}`,
                graceEnd,
              ),
            );
            yield* sql`UPDATE kin_triggers SET next_run_at = ${graceEnd},
              updated_at = max(updated_at, ${now})
              WHERE org_id = ${orgId} AND trigger_id = ${deferralTriggerId(itemId, "due")}
                AND enabled = 1`;
            const graced = yield* encodeSnapshot({ ...snapshot, graceEndsAt: graceEnd });
            yield* sql`UPDATE kin_deferral_runs SET snapshot_json = ${graced}
              WHERE org_id = ${orgId} AND item_id = ${itemId} AND due_at = ${dueAt}
                AND state = ${run.state}`;
            yield* setState("grace");
          } else {
            const started = yield* start({
              orgId,
              itemId,
              dueAt,
              card: card("started", ""),
              provenance: { _tag: "system" },
              at: Date.parse(fire.firedAt),
              now,
              from: run.state,
            });
            if (!started) return false;
          }
        } else if (onDue === "ask") yield* ask([]);
        else if (onDue === "chase") {
          // Inside the transaction, so a chased run always has its ping row.
          const failure =
            item === undefined
              ? "the item is gone"
              : yield* prepareChase(orgId, item, dueAt, timeZone);
          if (failure !== null) yield* ask([failure]);
          else {
            yield* setState("chased");
            yield* inbox.markConsumed(orgId, [fire.fireId]);
            return true;
          }
        } else {
          const chatId = yield* cardChat(orgId, item);
          if (chatId !== null)
            yield* chat.notice({
              orgId,
              chatId,
              messageId: KinMessageId.make(`deferral-remind:${orgId}:${fire.fireId}`),
              body: `Reminder: ${title}.${lateNote(dueAt, now, timeZone)}`,
            });
          yield* setState("reminded");
        }
        yield* inbox.markConsumed(orgId, [fire.fireId]);
        return false;
      }),
    );
  });

  // Best effort: the owner hears about a deferral Kin gave up on.
  const noticeFailure = Effect.fn("KinDeferralFlow.noticeFailure")(function* (
    orgId: KinOrgId,
    fire: KinTriggerFired,
    itemId: KinMemoryItemId,
    timeZone: string,
  ) {
    const run = yield* readRun(orgId, itemId);
    if (run === undefined || !["start", "ask", "chase"].includes(run.onDue)) return;
    const chatId = yield* cardChat(orgId, undefined);
    if (chatId === null) return;
    const title = (yield* readItem(orgId, itemId))?.title ?? itemId;
    const dueAt = run.dueAt ?? Date.parse(fire.dueAt);
    yield* chat.notice({
      orgId,
      chatId,
      messageId: KinMessageId.make(`deferral-failed:${orgId}:${fire.fireId}`),
      body: `I couldn't handle the deferral ${title} due ${ownerDateTime(dueAt, timeZone)}.`,
    });
  });

  const drain = Effect.fn("KinDeferralFlow.drain")(
    function* (orgId: KinOrgId) {
      const now = yield* Clock.currentTimeMillis;
      let chased = false;
      // The only pings sweeper: chases and their day-two escalations deliver from here.
      const sweep = Effect.suspend(() => {
        const last = sweptAt.get(orgId);
        if (!chased && last !== undefined && now - last < SWEEP_EVERY_MS) return Effect.void;
        sweptAt.set(orgId, now);
        return pings
          .sweep(orgId)
          .pipe(
            Effect.catch((cause) => Effect.logWarning("Kin pings sweep failed", { orgId, cause })),
          );
      });
      yield* Effect.gen(function* () {
        const timeZone = yield* cache.ownerTimeZone(orgId);
        const fires = yield* inbox.listPending(orgId, 100, "deferral");
        // Catch-up fires share received_at; handle them by due time.
        for (const fire of fires.toSorted(
          (a, b) =>
            Date.parse(a.dueAt) - Date.parse(b.dueAt) ||
            (a.fireId < b.fireId ? -1 : a.fireId > b.fireId ? 1 : 0),
        )) {
          if (fire.payload.kind !== "time" || fire.payload.subject.type !== "deferral") continue;
          const { itemId, phase } = fire.payload.subject;
          const retry = retries.get(fire.fireId);
          const giveUp = now - Date.parse(fire.dueAt) > GIVE_UP_MS;
          if (retry !== undefined && now < retry.notBefore && !giveUp) continue;
          yield* process(orgId, fire, itemId, phase, now, timeZone).pipe(
            Effect.tap((put) =>
              Effect.sync(() => {
                retries.delete(fire.fireId);
                if (put) chased = true;
              }),
            ),
            Effect.mapError((cause) =>
              isSqlError(cause) ? toPersistenceSqlError("KinDeferralFlow.drain")(cause) : cause,
            ),
            Effect.catch((cause) =>
              Effect.gen(function* () {
                const consume = isPermanent(cause) || giveUp;
                const failures = (retry?.failures ?? 0) + 1;
                yield* (consume || failures === 1 ? Effect.logWarning : Effect.logDebug)(
                  "Kin deferral fire processing failed",
                  {
                    orgId,
                    fireId: fire.fireId,
                    cause,
                    failures,
                    disposition: consume ? "consumed" : "retry",
                  },
                );
                if (!consume) {
                  const delay = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (failures - 1));
                  retries.set(fire.fireId, { notBefore: now + delay, failures });
                  return;
                }
                retries.delete(fire.fireId);
                yield* noticeFailure(orgId, fire, itemId, timeZone).pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("Kin deferral failure notice failed", {
                      orgId,
                      fireId: fire.fireId,
                      cause,
                    }),
                  ),
                );
                yield* inbox.markConsumed(orgId, [fire.fireId]);
              }),
            ),
          );
        }
      }).pipe(Effect.ensuring(sweep));
    },
    (effect, orgId) =>
      effect.pipe(Effect.mapError((cause) => new KinDeferralFlowError({ orgId, cause }))),
  );

  yield* ticks.register(
    "kin-deferrals",
    Effect.gen(function* () {
      // Scheduler maintenance scans organizations; each drain is org-scoped.
      const orgs = yield* sql<{ orgId: string }>`SELECT org_id AS "orgId" FROM kin_orgs
        ORDER BY org_id`;
      for (const { orgId } of orgs)
        yield* drain(KinOrgId.make(orgId)).pipe(
          Effect.catch((cause) => Effect.logWarning("Kin deferral tick failed", { orgId, cause })),
        );
    }).pipe(Effect.catch((cause) => Effect.logWarning("Kin deferral scan failed", { cause }))),
  );
  return KinDeferralFlow.of({ drain });
});

export const layer = Layer.effect(KinDeferralFlow, make).pipe(
  Layer.provide(Pings.layer),
  Layer.provide(MemoryCache.layer),
);
