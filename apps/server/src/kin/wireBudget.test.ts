// @effect-diagnostics globalDate:off anyUnknownInErrorContext:off -- fixed invented dates; each read fails in its own way and a failure is recorded as a refusal.
import { expect, layer as withLayer } from "@effect/vitest";
import {
  KIN_REFRESH_TOPICS,
  KinAgentId,
  KinChatHistoryResult,
  KinChatListEvent,
  KinChatSummary,
  KinChatStreamEvent,
  KinMoneyAnswerRpcs,
  KIN_MONEY_PARTS,
  type KinMoneyPart,
  KinPersonId,
  KinFinanceRpcs,
  KinPulseRpcs,
  type KinPulseEvent,
  type KinPulseScreenRead,
  kinPulseApply,
  type KinWorkEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { previewRow } from "./chat/chatRowPreview.ts";
import * as ChatHub from "./chat/KinChatHub.ts";
import * as ChatRepository from "./chat/KinChatRepository.ts";
import * as ChatService from "./chat/KinChatService.ts";
import * as Groups from "./chat/KinGroups.ts";
import {
  type AgentIdentity,
  KinIdentity,
  KinIdentityConfig,
  type PersonIdentity,
} from "./chat/KinIdentity.ts";
import * as RefreshHub from "./chat/KinRefreshHub.ts";
import { environment } from "./chat/TaskCard.testkit.ts";
import * as KinEventQueue from "./lead/KinEventQueue.ts";
import * as KinPersistence from "./persistence/KinPersistence.ts";
import * as Presence from "./reply/KinPresence.ts";
import { subscribeRefreshes } from "./chat/refreshes.ts";
import * as KinPulse from "./pulse/KinPulse.ts";
import * as Pulse from "./pulse/people.ts";
import budget from "./kinWireBudget.json" with { type: "json" };
import * as Docs from "./work/docs.ts";
import * as Goals from "./work/goals.ts";
import * as KinRecords from "./work/KinRecords.ts";
import * as OwnerDocs from "./work/ownerDocs.ts";
import { demandOfTick, makeMoneyStream } from "./work/moneyStream.ts";
import * as Money from "./work/ownerMoney.ts";
import * as MoneyAnswers from "./work/ownerMoneyAnswers.ts";
import * as Work from "./work/ownerWork.ts";
import * as WorkStream from "./work/workStream.ts";
import {
  as,
  BASE_SIZE,
  coOwnerId,
  created,
  day,
  layer,
  memberId,
  NOW,
  orgId,
  ownerId,
  ownerWriter,
  READS,
  rowsOf,
  SCHEMAS,
  type Services,
  seed,
  successOf,
  UNPAGED_CEILING,
  VIEWERS,
  wireBytes,
} from "./wireBudget.testkit.ts";

// What Kin's hot reads send each kind of person on an invented company; kinWireBudget.json must
// equal the measurement, so growth shows as that file's diff in the PR. At a real company's size,
// with a time ceiling per read, it runs nightly, and by hand from the repo root:
//   KIN_WIRE_ENTRIES=20000 node apps/server/scripts/kin-wire-scaled.ts

/**
 * Every viewer's `kin.work.subscribe` items for one create and one assignment, up to the
 * announcement that closes the window, and the bytes each named change makes their screen read
 * again (the task page, their due-today list and the counts, as `kinWorkRefreshOn(["work"])`).
 */
const oneChange = Effect.fn("KinWireBudget.oneChange")(function* (
  rereadBytes: ReadonlyMap<string, number>,
) {
  const records = yield* KinRecords.KinRecords;
  const listening = yield* Effect.forEach(VIEWERS, ([name, personId]) =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      let count = 0;
      const fiber = yield* WorkStream.subscribeChanged(as(personId), { orgId }).pipe(
        Stream.tap(() => (count++ === 0 ? Deferred.succeed(ready, undefined) : Effect.void)),
        // The first item is where things stand; the next one without a key closes the window.
        Stream.takeUntil((item) => count > 1 && item.key === undefined),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(ready);
      return { name, fiber };
    }),
  );
  const made = yield* Work.create(as(coOwnerId), {
    orgId,
    clientRequestId: "wire-budget-one-task",
    title: "Invented: check the logo files",
  });
  yield* Work.assign(as(ownerId), {
    orgId,
    key: made.key,
    to: { _tag: "person", personId: memberId },
  });
  yield* records.announce(orgId);
  const measured: Record<string, number> = {};
  for (const { name, fiber } of listening) {
    const items = [...(yield* Fiber.join(fiber))].slice(1, -1);
    measured[`change.${name}.items`] = items.length;
    measured[`change.${name}.bytes`] = items.reduce(
      (sum, item) => sum + wireBytes(SCHEMAS.subscribe, item),
      0,
    );
    measured[`change.${name}.rereadBytes`] =
      items.filter((item) => item.list === undefined || item.list === "work").length *
      (rereadBytes.get(name) ?? 0);
  }
  return measured;
});

/**
 * The same two changes on the row stream (`acceptRows`): what each viewer's session sends for the
 * task made and then given away, and what a reconnect with nothing changed costs. Ticks are fed to
 * each session one change at a time, as the live stream's window would.
 */
const rowsChange = Effect.fn("KinWireBudget.rowsChange")(function* () {
  const records = yield* KinRecords.KinRecords;
  const pull = yield* Stream.toPull(records.changes(orgId));
  const opening = (yield* pull)[0]!.seq;
  const measured: Record<string, number> = {};
  const bytesOf = (items: ReadonlyArray<KinWorkEvent>) =>
    items.reduce((sum, item) => sum + wireBytes(SCHEMAS.subscribe, item), 0);
  const sessions = yield* Effect.forEach(VIEWERS, ([name, personId]) =>
    Effect.gen(function* () {
      const session = yield* WorkStream.makeWorkStream(as(personId), { orgId, acceptRows: true });
      const start = yield* session.start(opening);
      measured[`rows.${name}.open.bytes`] = bytesOf(start);
      return { name, personId, session };
    }),
  );
  const cursors = new Map<string, { seq: number; team: boolean }>();
  const feed = Effect.fn("KinWireBudget.feed")(function* (change: string, key: string) {
    const ticks: Array<KinRecords.Tick> = [];
    while (!ticks.some((tick) => tick.key === key)) ticks.push(...(yield* pull));
    for (const { name, session } of sessions) {
      const items = yield* session.batch(ticks.flatMap((tick) => session.pendingOf(tick)));
      measured[`rows.${name}.${change}.items`] = items.length;
      measured[`rows.${name}.${change}.bytes`] = bytesOf(items);
      const last = items.at(-1);
      if (last?._tag === "counts" || last?._tag === "synchronized")
        cursors.set(name, { seq: last.seq, team: last.team === true });
    }
  });
  const made = yield* Work.create(as(coOwnerId), {
    orgId,
    clientRequestId: "wire-budget-row-task",
    title: "Invented: send the venue the floor plan",
  });
  yield* feed("create", made.key);
  yield* Work.assign(as(ownerId), {
    orgId,
    key: made.key,
    to: { _tag: "person", personId: memberId },
  });
  yield* feed("assign", made.key);
  for (const { name, personId } of sessions) {
    const at = cursors.get(name)!;
    const session = yield* WorkStream.makeWorkStream(as(personId), {
      orgId,
      acceptRows: true,
      afterSeq: at.seq,
      ...(at.team ? { afterTeam: true } : {}),
    });
    measured[`rows.${name}.resume.bytes`] = bytesOf(
      yield* session.start(yield* records.seq(orgId)),
    );
  }
  return measured;
});

/**
 * One doc rewritten: what each viewer's docs feed sends for it. With rows the Docs list patches
 * from the change itself; without, it reads its page again (`docsPage`).
 */
const docChange = Effect.fn("KinWireBudget.docChange")(function* () {
  const records = yield* KinRecords.KinRecords;
  const sql = yield* SqlClient.SqlClient;
  const pull = yield* Stream.toPull(records.changes(orgId));
  yield* pull;
  const measured: Record<string, number> = {};
  const sessions = yield* Effect.forEach(VIEWERS, ([name, personId]) =>
    Effect.map(OwnerDocs.makeDocsStream(as(personId), { orgId, acceptRows: true }), (session) => ({
      name,
      session,
    })),
  );
  const [doc] = yield* sql<{ key: string }>`SELECT key FROM kin_records
    WHERE org_id = ${orgId} AND register_id = 'docs' AND json_extract(fields_json, '$.home') = 'company'
    ORDER BY key LIMIT 1`;
  yield* Docs.replaceBody(
    orgId,
    ownerWriter,
    {},
    { key: doc!.key },
    {
      body: "# Invented doc 1\n\nWhat was agreed, now with the venue's new date.\n",
      summary: "Rewritten",
      originKey: "wire-budget:doc:rewrite",
    },
  );
  const ticks: Array<KinRecords.Tick> = [];
  while (!ticks.some((tick) => tick.key === doc!.key)) ticks.push(...(yield* pull));
  for (const { name, session } of sessions) {
    const events = yield* session.burst(ticks);
    measured[`docs.${name}.rewrite.bytes`] = events.reduce(
      (sum, event) => sum + wireBytes(SCHEMAS.docsEvent, event),
      0,
    );
    measured[`docs.${name}.rewrite.reads`] = events.some(
      (event) => event.key !== undefined && event.row === undefined && event.unlisted !== true,
    )
      ? 1
      : 0;
  }
  return measured;
});

/**
 * A reconnect with nothing changed: each viewer's refresh revisions heard again. A topic that
 * reads differently is one their screens read again; the bytes are what resubscribing costs.
 */
const reconnect = Effect.fn("KinWireBudget.reconnect")(function* () {
  const measured: Record<string, number> = {};
  const heard = (personId: KinPersonId) =>
    Stream.runHead(subscribeRefreshes(as(personId), { orgId })).pipe(Effect.map(Option.getOrThrow));
  for (const [name, personId] of VIEWERS) {
    const before = yield* heard(personId);
    const again = yield* heard(personId);
    measured[`reconnect.${name}.topicsMoved`] =
      KIN_REFRESH_TOPICS.filter((topic) => before[topic] !== again[topic]).length +
      (before.boot === again.boot ? 0 : 1);
    measured[`reconnect.${name}.refreshBytes`] = wireBytes(SCHEMAS.refreshes, again);
  }
  return measured;
});

/**
 * One fact in Needs attention moves (a task due soon is done): what each viewer's home is sent
 * for it over `kin.pulse.subscribe`, and that the page folded from it is a fresh read's.
 */
const attentionMove = Effect.fn("KinWireBudget.attentionMove")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const measured: Record<string, number> = {};
  yield* KinPulse.tick(orgId, NOW);
  const page = { orgId, includeHandled: true, limit: 8 } as const;
  const about = (people: ReadonlyArray<PersonIdentity>) =>
    Pulse.read(people, page).pipe(
      Effect.map((read) => ("outline" in read ? (read.outline?.records ?? []) : [])),
    );
  // A task the member holds that needs attention, so every viewer's page moves.
  const named = new Set(yield* about(as(memberId)));
  const tasks = yield* sql<{ key: string; rev: number }>`SELECT key, rev FROM kin_records
    WHERE org_id = ${orgId} AND register_id = 'work' AND state = 'open'
      AND owner_id = ${memberId} ORDER BY key`;
  const soon = tasks.find((task) => named.has(task.key));
  if (soon === undefined)
    return yield* Effect.die(new Error("No task of the member's needs attention."));
  expect(yield* about(as(ownerId))).toContain(soon.key);
  const watching = yield* Effect.forEach(VIEWERS, ([name, personId]) =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<KinPulseEvent>();
      yield* Pulse.subscribe(as(personId), page).pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const first = yield* Queue.take(events);
      if (first._tag !== "snapshot") return yield* Effect.die(new Error("No first page."));
      return { name, personId, events, held: first.read };
    }),
  );
  yield* Work.update(as(ownerId), { orgId, key: soon.key, rev: soon.rev, state: "done" });
  yield* KinPulse.tick(orgId, NOW + 60_000);
  yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
  expect(yield* about(as(ownerId))).not.toContain(soon.key);
  for (const { name, personId, events, held } of watching) {
    const change = yield* Queue.take(events);
    if (change._tag !== "changed") return yield* Effect.die(new Error(`${name}: no change`));
    const folded: KinPulseScreenRead = kinPulseApply(held, change);
    const fresh = yield* Pulse.read(as(personId), page);
    expect({ ...folded, asOf: fresh.asOf }, `${name} folds to a fresh read`).toEqual(fresh);
    measured[`attention.${name}.reads`] = 0;
    measured[`attention.${name}.bytes`] = wireBytes(SCHEMAS.pulseEvent, change);
    // A new session that names the page held, nothing having moved since.
    const resumed = yield* Stream.runHead(
      Pulse.subscribe(as(personId), { ...page, held: change.hash }),
    ).pipe(Effect.map(Option.getOrThrow));
    expect(resumed._tag, `${name} resumes`).toBe("current");
    measured[`reconnect.${name}.pulseBytes`] = wireBytes(SCHEMAS.pulseEvent, resumed);
  }
  return measured;
});

/** Money's reads an open owner-level Money screen made again for each kind of change. */
const MONEY_REREADS: ReadonlyArray<{
  readonly name: string;
  readonly onTask: boolean;
  readonly schema: Schema.Top;
  readonly run: (people: ReadonlyArray<PersonIdentity>) => Effect.Effect<object, unknown, Services>;
}> = [
  // Money's screen counts tasks among what is coming up; its line (`workOwed`) doesn't.
  {
    name: "money",
    onTask: true,
    schema: SCHEMAS.money,
    run: (p) => Money.money(p, { orgId, upcomingRows: false }),
  },
  {
    name: "owed",
    onTask: false,
    schema: SCHEMAS.money,
    run: (p) => Money.money(p, { orgId, upcomingRows: false }),
  },
  {
    name: "cash",
    onTask: false,
    schema: successOf(KinMoneyAnswerRpcs, "kin.work.cash"),
    run: (p) => MoneyAnswers.cash(p, { orgId }),
  },
  {
    name: "outlook",
    onTask: false,
    schema: successOf(KinMoneyAnswerRpcs, "kin.work.outlook"),
    run: (p) => MoneyAnswers.outlook(p, { orgId }),
  },
  {
    name: "budgets",
    onTask: false,
    schema: successOf(KinMoneyAnswerRpcs, "kin.work.budgets"),
    run: (p) => MoneyAnswers.budgets(p, { orgId }),
  },
  {
    name: "receipts",
    onTask: true,
    schema: successOf(KinFinanceRpcs, "kin.work.receipts"),
    run: (p) => Money.receipts(p, { orgId }),
  },
  {
    name: "goals",
    onTask: true,
    schema: successOf(KinPulseRpcs, "kin.goals.list"),
    run: (p) => Goals.list(p, orgId),
  },
  { name: "lists", onTask: false, schema: SCHEMAS.lists, run: (p) => Money.lists(p, { orgId }) },
];
const MONEY_SCREENS: ReadonlyArray<ReadonlyArray<KinMoneyPart>> = [
  ["summary"],
  KIN_MONEY_PARTS.filter((part) => part !== "summary"),
];

/**
 * An invoice paid, then a task renamed, with Money open: what reading again cost each viewer, and
 * what `kin.money.subscribe` sends instead. A teammate is refused the stream and keeps their reads.
 */
const moneyChange = Effect.fn("KinWireBudget.moneyChange")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords.KinRecords;
  const pull = yield* Stream.toPull(records.changes(orgId));
  yield* pull;
  const measured: Record<string, number> = {};
  const viewers = yield* Effect.forEach(VIEWERS, ([name, personId]) =>
    Effect.gen(function* () {
      const sessions = yield* Effect.forEach(MONEY_SCREENS, (parts) =>
        Effect.result(makeMoneyStream(as(personId), { orgId, parts })),
      );
      if (sessions.some((one) => one._tag === "Failure")) {
        measured[`money.${name}.streamRefused`] = 1;
        return { name, personId, sessions: [] };
      }
      const open = yield* Effect.forEach(sessions, (one) =>
        one._tag === "Success" ? one.success.start() : Effect.die(new Error("unreachable")),
      );
      measured[`money.${name}.open.bytes`] = open.reduce(
        (sum, event) => sum + wireBytes(SCHEMAS.moneyEvent, event),
        0,
      );
      return {
        name,
        personId,
        sessions: sessions.flatMap((one) => (one._tag === "Success" ? [one.success] : [])),
      };
    }),
  );
  const feed = Effect.fn("KinWireBudget.moneyFeed")(function* (
    change: string,
    key: string,
    task: boolean,
  ) {
    const ticks: Array<KinRecords.Tick> = [];
    while (!ticks.some((tick) => tick.key === key)) ticks.push(...(yield* pull));
    const demand = new Set(ticks.flatMap((tick) => [...demandOfTick(tick)]));
    for (const { name, personId, sessions } of viewers) {
      let reads = 0;
      let rereadBytes = 0;
      for (const one of MONEY_REREADS.filter((read) => !task || read.onTask)) {
        reads += 1;
        const result = yield* Effect.result(one.run(as(personId)));
        if (result._tag === "Success") rereadBytes += wireBytes(one.schema, result.success);
      }
      measured[`money.${name}.${change}.before.reads`] = reads;
      measured[`money.${name}.${change}.before.bytes`] = rereadBytes;
      if (sessions.length === 0) {
        // Not on the stream: the same reads as before.
        measured[`money.${name}.${change}.after.reads`] = reads;
        continue;
      }
      const events = (yield* Effect.forEach(sessions, (session) => session.apply(demand))).flat();
      measured[`money.${name}.${change}.after.reads`] = 0;
      measured[`money.${name}.${change}.after.items`] = events.length;
      measured[`money.${name}.${change}.after.bytes`] = events.reduce(
        (sum, event) => sum + wireBytes(SCHEMAS.moneyEvent, event),
        0,
      );
    }
  });
  const [unpaid] = yield* sql<{ key: string; minor: number }>`SELECT key, amount_minor AS minor
    FROM kin_records WHERE org_id = ${orgId} AND register_id = 'invoices' AND state = 'waiting'
    ORDER BY key LIMIT 1`;
  yield* Money.recordPayment(as(ownerId), {
    orgId,
    key: unpaid!.key as never,
    amount: { minor: unpaid!.minor, currency: "INR" },
    paidOn: day(0),
    clientRequestId: "wire-budget-paid",
  });
  yield* feed("invoicePaid", unpaid!.key, false);
  const [task] = yield* sql<{ key: string; rev: number }>`SELECT key, rev FROM kin_records
    WHERE org_id = ${orgId} AND register_id = 'work' AND state = 'open' ORDER BY key LIMIT 1`;
  yield* Work.update(as(ownerId), {
    orgId,
    key: task!.key as never,
    rev: task!.rev,
    title: "Invented: check the logo files again",
  });
  yield* feed("taskChange", task!.key, true);
  return measured;
});

/**
 * The chat list at 300 chats whose last message is an agent's 1,500-character page: the
 * snapshot every app open and reconnect sends, and one chat's row after a message.
 */
const chatList = () => {
  const section = "- An invented invoice for the venue was paid in full today.\n".repeat(25);
  const body = `## Needs you\n- Approve the venue deposit\n\n## Money\n${section}`.slice(0, 1_500);
  const decode = Schema.decodeUnknownSync(KinChatSummary);
  const chat = (i: number) =>
    decode({
      orgId,
      chatId: `chat-${i}`,
      kind: "direct",
      title: null,
      teamId: null,
      lastSeq: 400,
      lastMessageAt: created,
      createdAt: created,
      archivedAt: null,
      members: [
        { principal: { _tag: "person", personId: ownerId }, role: "owner" },
        { principal: { _tag: "agent", agentId: `agent-${i % 8}` }, role: "member" },
      ].map((member, m) => ({
        ...member,
        orgId,
        chatId: `chat-${i}`,
        memberId: `member-${i}-${m}`,
        joinedAt: created,
        leftAt: null,
        mutedUntil: null,
      })),
      lastMessage: {
        orgId,
        chatId: `chat-${i}`,
        messageId: `message-${i}`,
        seq: 400,
        author: {
          _tag: "agent",
          agentId: `agent-${i % 8}`,
          memberId: `member-${i}-1`,
          ownerPersonId: ownerId,
          threadId: `thread-${i % 8}`,
        },
        authorRole: "member",
        kind: "text",
        body,
        intent: "answer",
        mentions: [],
        replyTo: null,
        widgetId: null,
        floorRunId: null,
        status: "posted",
        sentBy: null,
        createdAt: created,
        editedAt: null,
      },
      unread: i % 4,
    });
  const chats = Array.from({ length: 300 }, (_, i) => chat(i));
  const measured: Record<string, number> = {};
  for (const [name, row] of [
    ["whole", (summary: KinChatSummary) => summary],
    ["preview", (summary: KinChatSummary) => previewRow(summary, () => false)],
  ] as const) {
    measured[`chatList.${name}.snapshotBytes`] = wireBytes(KinChatListEvent, {
      _tag: "snapshot",
      chats: chats.map(row),
      waiting: [],
    });
    measured[`chatList.${name}.chatBytes`] = wireBytes(KinChatListEvent, {
      _tag: "chat",
      chat: row(chats[0]!),
    });
  }
  return measured;
};

/** The pinned keys of one test: chat's are `chat.`, every other key is the hot reads'. */
const pinned = (chat: boolean) =>
  Object.fromEntries(Object.entries(budget).filter(([key]) => key.startsWith("chat.") === chat));

withLayer(layer)("Kin wire budget", (it) => {
  it.effect("hot reads and one change's stream match kinWireBudget.json", () =>
    Effect.gen(function* () {
      yield* seed(BASE_SIZE);
      const measured: Record<string, number> = {};
      const over: Array<string> = [];
      const rereadBytes = new Map<string, number>();
      for (const [name, personId] of VIEWERS) {
        let reread = 0;
        for (const one of READS) {
          const result = yield* Effect.result(one.run(as(personId), personId));
          if (result._tag === "Failure") {
            // A read the host refuses this viewer costs nothing to send but the refusal.
            measured[`${name}.${one.name}.refused`] = 1;
            continue;
          }
          const bytes = wireBytes(one.schema, result.success);
          measured[`${name}.${one.name}.bytes`] = bytes;
          measured[`${name}.${one.name}.rows`] = rowsOf(result.success, one.rows);
          if (!one.paged && bytes > UNPAGED_CEILING) over.push(`${name}.${one.name}: ${bytes}`);
          if (one.name === "taskPage" || one.name === "dueToday" || one.name === "summary")
            reread += bytes;
        }
        rereadBytes.set(name, reread);
      }
      Object.assign(measured, yield* oneChange(rereadBytes));
      Object.assign(measured, yield* Effect.scoped(rowsChange()));
      Object.assign(measured, yield* Effect.scoped(docChange()));
      Object.assign(measured, yield* reconnect());
      Object.assign(measured, yield* Effect.scoped(attentionMove()));
      Object.assign(measured, yield* Effect.scoped(moneyChange()));
      Object.assign(measured, chatList());

      expect(over, `Unpaged Kin reads over ${UNPAGED_CEILING} bytes: page them.`).toEqual([]);
      expect(
        measured,
        "Set kinWireBudget.json to the measured values. Growth shows in review as that file's diff; say why in the PR.",
      ).toEqual(pinned(false));
    }),
  );
});

// Chat on its own layer, without the records and pulse the reads above need.
const chatLayer = Layer.mergeAll(Groups.layer, ChatService.layer, KinEventQueue.layer).pipe(
  Layer.provideMerge(
    KinIdentity.layer.pipe(
      Layer.provide(
        Layer.succeed(KinIdentityConfig, {
          orgName: "Ambermill",
          ownerHandle: "rhea",
          ownerDisplayName: "Rhea",
        }),
      ),
    ),
  ),
  Layer.provideMerge(Presence.layer),
  Layer.provideMerge(ChatHub.layer),
  Layer.provideMerge(ChatRepository.layer),
  Layer.provideMerge(Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory)),
  Layer.provideMerge(environment),
);

const LINES = [
  "Morning all. The venue wants the final floor plan by Thursday; can we close it today?",
  "Yes. The plan from Tuesday still has the old stage. I'll draft the change and send it over.",
  "I spoke to the caterer: numbers are due Friday, and they hold the menu until then.",
  "Noted. I've put Friday on the guest list task and moved the menu tasting to next week.",
  "The pricing page copy is ready for a look. Two lines still need a number from Finance.",
  "Finance says the early bird price stays at the same amount. I've added it to the draft.",
];

/**
 * The team room as each kind of person reads it: the chat list's first item, one page of
 * history, and what their open chat is sent for a task card and for one reaction.
 */
const chatBudget = Effect.fn("KinWireBudget.chat")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* ChatRepository.KinChatRepository;
  const chats = yield* ChatService.KinChatService;
  const groups = yield* Groups.KinGroups;
  const identity = yield* KinIdentity;
  const { owner } = identity;
  const { orgId: chatOrg } = owner;
  yield* TestClock.setTime(NOW);
  const at = "2026-11-01T00:00:00.000Z";
  const agentId = KinAgentId.make("chief");
  const threadId = ThreadId.make("chief-thread");
  yield* repo.insertAgent({
    orgId: chatOrg,
    agentId,
    ownerPersonId: owner.personId,
    displayName: "Chief of staff",
    role: "lead",
    createdAt: at,
  });
  yield* identity.registerAgentThread({ orgId: chatOrg, agentId, threadId });
  const direct = yield* chats.createDirect(owner, { orgId: chatOrg, agentId });
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json,
      worker_projects_json, owner_chat_id)
    VALUES (${agentId}, ${chatOrg}, 'Chief of staff', 0, '{}', '[]', ${direct.chatId})`;
  const teammate = Effect.fn("KinWireBudget.teammate")(function* (
    id: string,
    name: string,
    access: "co_owner" | "member",
  ) {
    const personId = KinPersonId.make(id);
    yield* repo.insertPerson({
      orgId: chatOrg,
      personId,
      handle: id,
      displayName: name,
      githubLogin: null,
      access,
      createdAt: at,
    });
    return { _tag: "person" as const, orgId: chatOrg, personId };
  });
  const meera = yield* teammate("meera", "Meera", "co_owner");
  const zoya = yield* teammate("zoya", "Zoya", "member");
  const room = yield* groups.create([owner], {
    orgId: chatOrg,
    title: "Ambermill launch",
    agentIds: [agentId],
    personIds: [meera.personId, zoya.personId],
  });
  const lead: AgentIdentity = {
    _tag: "agent",
    orgId: chatOrg,
    agentId,
    ownerPersonId: owner.personId,
    threadId,
    hostPosted: true,
  };
  const speakers = [owner, lead, meera, lead, zoya, lead] as const;
  let last = 0;
  for (let i = 0; i < 30; i++) {
    const who = speakers[i % speakers.length]!;
    const sent = yield* chats.send(who, {
      chatId: room.chatId,
      clientMessageId: `wire-budget-chat-${i}`,
      body: LINES[i % LINES.length]!,
      ...(who._tag === "agent" ? { intent: "answer" as const } : {}),
    });
    last = sent.seq;
  }
  const viewers = [
    ["owner", owner],
    ["coOwner", meera],
    ["member", zoya],
  ] as const;
  const measured: Record<string, number> = {};
  const watching = yield* Effect.forEach(viewers, ([name, viewer]) =>
    Effect.gen(function* () {
      const inbox = yield* Stream.runHead(chats.subscribeChats([viewer], {})).pipe(
        Effect.map(Option.getOrThrow),
      );
      measured[`chat.${name}.inbox.bytes`] = wireBytes(KinChatListEvent, inbox);
      const page = yield* chats.history(viewer, {
        chatId: room.chatId,
        beforeSeq: last + 1,
        limit: 50,
      });
      measured[`chat.${name}.history.bytes`] = wireBytes(KinChatHistoryResult, page);
      measured[`chat.${name}.history.rows`] = page.messages.length;
      const events = yield* Queue.unbounded<KinChatStreamEvent>();
      yield* chats.subscribe(viewer, { chatId: room.chatId }).pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const first = yield* Queue.take(events);
      if (first._tag !== "backlog") return yield* Effect.die(new Error(`${name}: no backlog`));
      return { name, events };
    }),
  );
  /** Each viewer's stream up to and including the event `done` names. */
  const heard = Effect.fn("KinWireBudget.heard")(function* (
    change: string,
    done: (event: KinChatStreamEvent) => boolean,
  ) {
    for (const { name, events } of watching) {
      const items: Array<KinChatStreamEvent> = [];
      while (items.length === 0 || !done(items.at(-1)!)) items.push(yield* Queue.take(events));
      measured[`chat.${name}.${change}.items`] = items.length;
      measured[`chat.${name}.${change}.bytes`] = items.reduce(
        (sum, item) => sum + wireBytes(KinChatStreamEvent, item),
        0,
      );
    }
  });
  const card = yield* chats
    .createTaskCard({
      audience: "chat",
      orgId: chatOrg,
      chatId: room.chatId,
      authorAgentId: agentId,
      threadId: ThreadId.make("chief-task"),
      title: "Invented: redraw the floor plan with the new stage",
      model: "invented-model",
    })
    .pipe(
      Effect.provide(
        Layer.mock(OrchestratorV2)({ getThreadShell: (id) => Effect.succeed(liveThreadShell(id)) }),
      ),
    );
  yield* heard("messageWithCard", (event) =>
    event._tag === "widget" ? event.widget.widgetId === card.widgetId : false,
  );
  yield* chats.react(owner, { messageId: card.messageId, emoji: "👍", on: true });
  yield* heard("reaction", (event) => event._tag === "reaction");
  return measured;
});

withLayer(chatLayer)("Kin chat wire budget", (it) => {
  it.effect("the team room's list, history, card and reaction match kinWireBudget.json", () =>
    Effect.gen(function* () {
      const measured = yield* Effect.scoped(chatBudget());
      expect(
        measured,
        "Set kinWireBudget.json's chat keys to the measured values; say why in the PR.",
      ).toEqual(pinned(true));
    }),
  );
});
