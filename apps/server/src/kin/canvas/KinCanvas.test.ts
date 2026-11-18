// @effect-diagnostics globalDate:off -- fixed invented dates.
// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  KinAgentId,
  KinChatError,
  KinChatId,
  type KinCanvasEvent,
  type KinCanvasRead,
  KinOrgId,
  KinPersonId,
  KinWakeupId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import * as RefreshHub from "../chat/KinRefreshHub.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Presence from "../reply/KinPresence.ts";
import * as KinImport from "../work/KinImport.ts";
import * as KinRecords from "../work/KinRecords.ts";
import * as Work from "../work/ownerWork.ts";
import * as KinCanvas from "./KinCanvas.ts";

// An invented company: two projects, a member on the first, a private task and one elsewhere.

const orgId = KinOrgId.make("org");
const ownerId = KinPersonId.make("owner");
const coOwnerId = KinPersonId.make("meera");
const memberId = KinPersonId.make("zoya");
const lead = KinAgentId.make("lead");
const NOW = Date.parse("2026-11-12T06:00:00.000Z");
const created = "2026-01-01T00:00:00.000Z";
const NOW_ISO = new Date(NOW).toISOString();
const day = (offset: number) => new Date(NOW + offset * 86_400_000).toISOString().slice(0, 10);
const as = (personId: KinPersonId): ReadonlyArray<PersonIdentity> => [
  { _tag: "person", orgId, personId },
];
const owner = as(ownerId);
const coOwner = as(coOwnerId);
const member = as(memberId);

const TASKS = {
  open: { title: "Invented: open", project: "p1", state: "open" },
  done: { title: "Invented: done", project: "p1", state: "done" },
  dropped: { title: "Invented: dropped", project: "p1", state: "dropped" },
  doing: { title: "Invented: doing", project: "p1", state: "doing" },
  late: { title: "Invented: late", project: "p1", state: "waiting", due: day(-3) },
  secret: { title: "Invented: private", project: "p1", state: "open", due: day(5) },
  elsewhere: { title: "Invented: elsewhere", project: "p2", state: "open" },
} as const;
type Task = keyof typeof TASKS;

const importLines = () => [
  JSON.stringify({ format: "kin-import", version: 1, batch: "canvas", source: "canvas test" }),
  JSON.stringify({ client: { source: "c1", name: "Invented Client", createdAt: day(-30) } }),
  JSON.stringify({ project: { source: "p1", name: "Alpha", client: "c1", createdAt: day(-20) } }),
  JSON.stringify({ project: { source: "p2", name: "Beta", client: "c1", createdAt: day(-20) } }),
  ...Object.entries(TASKS).map(([source, task]) =>
    JSON.stringify({
      entry: {
        source,
        list: "work",
        title: task.title,
        project: task.project,
        state: task.state,
        createdAt: day(-10),
        ...("due" in task ? { due: task.due } : {}),
        ...(task.state === "done" || task.state === "dropped" ? { closedAt: day(-1) } : {}),
      },
    }),
  ),
];

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* TestClock.setTime(NOW);
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Studio', ${created})`;
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, 'Asia/Kolkata', '08:00', '18:00', '02:00', 0, 1, '09:00', '[]')`;
  for (const [person, access] of [
    [ownerId, "owner"],
    [coOwnerId, "co_owner"],
    [memberId, "member"],
  ] as const)
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
      VALUES (${person}, ${orgId}, ${person}, ${person}, ${created}, ${access})`;
  yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
    VALUES ('session-zoya', ${orgId}, ${memberId}, 0)`;
  yield* (yield* KinImport.KinImport).apply(orgId, ownerId, Stream.fromIterable(importLines()));
  const rows = yield* sql<{ key: string; title: string; registerId: string }>`SELECT key, title,
      register_id AS "registerId" FROM kin_records WHERE org_id = ${orgId} ORDER BY key`;
  const keyOf = (title: string) => rows.find((row) => row.title === title)!.key;
  const keys = Object.fromEntries(
    Object.entries(TASKS).map(([name, task]) => [name, keyOf(task.title)]),
  ) as Record<Task, string>;
  const alpha = keyOf("Alpha");
  const beta = keyOf("Beta");
  yield* sql`UPDATE kin_records SET fields_json = json_set(fields_json, '$.members',
      json('["person:zoya"]')) WHERE org_id = ${orgId} AND key = ${alpha}`;
  yield* sql`UPDATE kin_records SET sensitive = 1 WHERE org_id = ${orgId} AND key = ${keys.secret}`;
  return { keys, alpha, beta };
});

const identity = Layer.mock(KinIdentity)({
  owner: { _tag: "person" as const, orgId, personId: ownerId },
  isAgentThread: () => false,
  isLeadThread: () => false,
});
const gate = Layer.mock(KinLevelGate)({
  ask: () => Effect.fail(new KinChatError({ reason: "unavailable", message: "No chat here." })),
});
const layer = KinCanvas.layer.pipe(
  Layer.provideMerge(KinImport.layer),
  Layer.provideMerge(Layer.mergeAll(KinRecords.layer, identity, gate)),
  Layer.provideMerge(Presence.layer),
  Layer.provideMerge(Hub.layer),
  Layer.provideMerge(Repository.layer),
  Layer.provideMerge(RefreshHub.layer),
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-canvas-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
);

const revOf = Effect.fn("KinCanvasTest.rev")(function* (key: string) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ rev: number }>`SELECT rev FROM kin_records
    WHERE org_id = ${orgId} AND key = ${key}`;
  return row!.rev;
});
const later = TestClock.adjust(1_000);
const refusal = <A, R>(effect: Effect.Effect<A, KinChatError, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );
/** Every key a read names, wherever it sits. */
const named = (read: KinCanvasRead | ReadonlyArray<KinCanvasEvent>) => JSON.stringify(read);

/** The owner's arrangement: cards, a widget of each kind, and widgets a member can't read. */
const arrange = Effect.fn("KinCanvasTest.arrange")(function* (seeded: Effect.Success<typeof seed>) {
  const canvas = yield* KinCanvas.KinCanvas;
  const sql = yield* SqlClient.SqlClient;
  const { keys, alpha, beta } = seeded;
  yield* canvas.place(owner, {
    orgId,
    places: [alpha, beta, keys.open, keys.secret, keys.elsewhere].map((key, i) => ({
      key,
      x: i * 100,
      y: 0,
    })),
  });
  const progress = yield* canvas.widgetAdd(owner, {
    orgId,
    kind: "progress",
    source: alpha,
    place: { x: 0, y: 400 },
  });
  const facts = yield* canvas.widgetAdd(owner, { orgId, kind: "facts", source: alpha });
  const countdown = yield* canvas.widgetAdd(owner, {
    orgId,
    kind: "countdown",
    source: keys.late,
  });
  const hiddenProgress = yield* canvas.widgetAdd(owner, {
    orgId,
    kind: "progress",
    source: beta,
    place: { x: 100, y: 400 },
  });
  const hiddenCountdown = yield* canvas.widgetAdd(owner, {
    orgId,
    kind: "countdown",
    source: keys.secret,
  });
  yield* sql`INSERT INTO kin_canvas_widgets (widget_id, org_id, kind, source_record_id, source_key,
      source_title, added_by_kind, added_by_id, added_at)
    VALUES ('cw_gone000', ${orgId}, 'countdown', 'record-gone', 'W-999', 'Invented: removed',
      'person', ${ownerId}, ${NOW})`;
  return { progress, facts, countdown, hiddenProgress, hiddenCountdown };
});

it.effect("each viewer reads only the places and widgets of entries they may read", () =>
  Effect.gen(function* () {
    const seeded = yield* seed;
    const { keys, alpha, beta } = seeded;
    const canvas = yield* KinCanvas.KinCanvas;
    const widgets = yield* arrange(seeded);

    const mine = yield* canvas.read(owner, { orgId });
    assert.isTrue(mine.canArrange);
    assert.deepStrictEqual(
      mine.places.map((one) => one.key).toSorted(),
      [
        alpha,
        beta,
        keys.open,
        keys.secret,
        keys.elsewhere,
        widgets.progress.id,
        widgets.hiddenProgress.id,
      ].toSorted(),
    );
    const value = (read: KinCanvasRead, id: string) =>
      read.widgets.find((widget) => widget.id === id)?.value;
    assert.deepStrictEqual(value(mine, widgets.progress.id), {
      _tag: "progress",
      done: 1,
      total: 5,
    });
    assert.deepStrictEqual(value(mine, widgets.facts.id), {
      _tag: "facts",
      open: 4,
      doing: 1,
      waiting: 1,
      late: 1,
    });
    assert.deepStrictEqual(value(mine, widgets.countdown.id), {
      _tag: "countdown",
      at: widgets.countdown.value._tag === "countdown" ? widgets.countdown.value.at : null,
      allDay: true,
      closed: false,
    });
    const gone = mine.widgets.find((widget) => widget.id === "cw_gone000");
    assert.deepStrictEqual(gone?.value, { _tag: "gone" });
    assert.strictEqual(gone?.source.title, "Invented: removed");
    const kindOf = (id: string) => mine.widgets.find((widget) => widget.id === id)?.sourceKind;
    assert.deepStrictEqual(
      [kindOf(widgets.progress.id), kindOf(widgets.countdown.id), gone?.sourceKind],
      ["project", "task", undefined],
    );
    expect(yield* canvas.read(coOwner, { orgId })).toEqual(mine);

    const theirs = yield* canvas.read(member, { orgId });
    assert.isFalse(theirs.canArrange);
    assert.deepStrictEqual(
      theirs.places.map((one) => one.key).toSorted(),
      [alpha, keys.open, widgets.progress.id].toSorted(),
    );
    assert.deepStrictEqual(
      theirs.widgets.map((widget) => widget.id),
      [widgets.progress.id, widgets.facts.id, widgets.countdown.id],
    );
    // The private task is no task of theirs: the project counts without it.
    assert.deepStrictEqual(value(theirs, widgets.progress.id), {
      _tag: "progress",
      done: 1,
      total: 4,
    });
    assert.deepStrictEqual(value(theirs, widgets.facts.id), {
      _tag: "facts",
      open: 3,
      doing: 1,
      waiting: 1,
      late: 1,
    });
    for (const hidden of [keys.secret, keys.elsewhere, beta, "Invented: removed"])
      assert.notInclude(named(theirs), `"${hidden}"`);
  }).pipe(Effect.provide(layer)),
);

it.effect("a widget's value follows its source, and only owner-level people arrange", () =>
  Effect.gen(function* () {
    const seeded = yield* seed;
    const { keys, alpha } = seeded;
    const canvas = yield* KinCanvas.KinCanvas;
    const widgets = yield* arrange(seeded);

    yield* Work.update(owner, {
      orgId,
      key: keys.late,
      rev: yield* revOf(keys.late),
      state: "done",
    });
    const read = yield* canvas.read(owner, { orgId });
    const value = (id: string) => read.widgets.find((widget) => widget.id === id)?.value;
    assert.deepStrictEqual(value(widgets.progress.id), { _tag: "progress", done: 2, total: 5 });
    assert.deepInclude(value(widgets.countdown.id), { _tag: "countdown", closed: true });
    assert.deepStrictEqual(value(widgets.facts.id), {
      _tag: "facts",
      open: 3,
      doing: 1,
      waiting: 0,
      late: 0,
    });

    const place = { orgId, places: [{ key: keys.open, x: 1, y: 1 }] };
    assert.strictEqual(yield* refusal(canvas.place(member, place)), "not_allowed");
    assert.strictEqual(
      yield* refusal(canvas.unplace(member, { orgId, keys: [keys.open] })),
      "not_allowed",
    );
    assert.strictEqual(
      yield* refusal(canvas.widgetAdd(member, { orgId, kind: "countdown", source: keys.open })),
      "not_allowed",
    );
    assert.strictEqual(
      yield* refusal(canvas.widgetRemove(member, { orgId, id: widgets.progress.id })),
      "not_allowed",
    );
    assert.strictEqual(
      yield* refusal(canvas.place(owner, { orgId, places: [{ key: "W-999", x: 0, y: 0 }] })),
      "not_found",
    );
    assert.strictEqual(
      yield* refusal(canvas.place(owner, { orgId, places: [{ key: "cw_nothing", x: 0, y: 0 }] })),
      "not_found",
    );
    assert.strictEqual(
      yield* refusal(canvas.widgetAdd(owner, { orgId, kind: "progress", source: keys.open })),
      "invalid_state",
    );

    yield* canvas.unplace(owner, { orgId, keys: [alpha] });
    yield* canvas.widgetRemove(owner, { orgId, id: widgets.progress.id });
    const after = yield* canvas.read(owner, { orgId });
    assert.notInclude(
      after.places.map((one) => one.key),
      alpha,
    );
    assert.notInclude(
      after.places.map((one) => one.key),
      widgets.progress.id,
    );
    assert.notInclude(
      after.widgets.map((widget) => widget.id),
      widgets.progress.id,
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("since lists others' changes after the last look, folded per entry", () =>
  Effect.gen(function* () {
    const { keys, alpha } = yield* seed;
    const canvas = yield* KinCanvas.KinCanvas;
    yield* Work.assign(owner, {
      orgId,
      key: keys.doing,
      to: { _tag: "person", personId: memberId },
    });

    assert.deepStrictEqual((yield* canvas.read(member, { orgId })).since, {
      seenAt: null,
      changes: [],
      more: 0,
    });
    yield* later;
    yield* canvas.seen(member, { orgId });
    yield* canvas.seen(coOwner, { orgId });
    yield* later;
    yield* Work.update(owner, {
      orgId,
      key: keys.open,
      rev: yield* revOf(keys.open),
      title: "Invented: open, renamed",
    });
    yield* later;
    yield* Work.update(owner, {
      orgId,
      key: keys.open,
      rev: yield* revOf(keys.open),
      state: "doing",
    });
    yield* later;
    yield* Work.update(coOwner, {
      orgId,
      key: keys.open,
      rev: yield* revOf(keys.open),
      title: "Invented: open, again",
    });
    yield* later;
    yield* Work.update(member, {
      orgId,
      key: keys.doing,
      rev: yield* revOf(keys.doing),
      state: "waiting",
    });
    yield* Work.update(owner, {
      orgId,
      key: keys.secret,
      rev: yield* revOf(keys.secret),
      title: "Invented: private, renamed",
    });
    yield* Work.update(owner, {
      orgId,
      key: keys.elsewhere,
      rev: yield* revOf(keys.elsewhere),
      state: "doing",
    });
    yield* later;
    const made = yield* Work.create(owner, {
      orgId,
      clientRequestId: "canvas-new-task",
      title: "Invented: new in Alpha",
      project: alpha,
    });

    const since = (yield* canvas.read(member, { orgId })).since;
    assert.strictEqual(since.more, 0);
    assert.deepStrictEqual(
      since.changes.map(({ key, by, others, count, created }) => ({
        key,
        by,
        others,
        count,
        created,
      })),
      [
        {
          key: made.key,
          by: { _tag: "person", personId: ownerId },
          others: 0,
          count: 1,
          created: true,
        },
        {
          key: keys.open,
          by: { _tag: "person", personId: coOwnerId },
          others: 1,
          count: 3,
          created: false,
        },
      ],
    );
    assert.strictEqual(since.changes[1]!.title, "Invented: open, again");
    const theirs = (yield* canvas.read(coOwner, { orgId })).since.changes.map((one) => one.key);
    expect(theirs).toEqual(
      expect.arrayContaining([keys.secret, keys.elsewhere, keys.doing, keys.open, made.key]),
    );

    yield* later;
    yield* canvas.seen(member, { orgId });
    yield* later;
    yield* Work.update(owner, {
      orgId,
      key: keys.open,
      rev: yield* revOf(keys.open),
      state: "done",
    });
    const next = (yield* canvas.read(member, { orgId })).since.changes;
    assert.deepStrictEqual(
      next.map((one) => [one.key, one.count]),
      [[keys.open, 1]],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("activity shows agents in the viewer's chats and only the entries they may read", () =>
  Effect.gen(function* () {
    const { keys } = yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const canvas = yield* KinCanvas.KinCanvas;
    const presence = yield* Presence.KinPresence;
    const at = NOW_ISO;
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id,
        created_at) VALUES (${lead}, ${orgId}, 'Invented Lead', 'lead', ${ownerId}, ${at})`;
    for (const [chat, person] of [
      ["owner-chat", ownerId],
      ["member-chat", memberId],
    ] as const) {
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
        VALUES (${chat}, ${orgId}, 'team_group', 0, ${at})`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind,
          person_id, role, joined_at)
        VALUES (${`${chat}-person`}, ${orgId}, ${chat}, 'person', ${person}, 'member', ${at})`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind,
          agent_id, role, joined_at)
        VALUES (${`${chat}-lead`}, ${orgId}, ${chat}, 'agent', ${lead}, 'member', ${at})`;
    }
    // What the agent's running wake-ups changed: one task the member reads, two they don't.
    for (const [wakeup, key] of [
      ["wake-member", keys.open],
      ["wake-member", keys.elsewhere],
      ["wake-member", keys.secret],
      ["wake-owner", keys.secret],
    ] as const)
      yield* sql`INSERT INTO kin_record_changes (org_id, record_id, rev, at, actor_kind, actor_id,
          via, kind, fields_json, wakeup_id)
        SELECT org_id, record_id, rev, ${NOW}, 'agent', ${lead}, 'lead', 'updated', '[]', ${wakeup}
        FROM kin_records WHERE org_id = ${orgId} AND key = ${key}`;
    const line = (wakeup: string) => ({
      agentId: lead,
      wakeupId: KinWakeupId.make(wakeup),
      state: "working" as const,
      label: null,
      startedAt: at,
      since: at,
    });
    yield* presence.set(orgId, KinChatId.make("owner-chat"), line("wake-owner"));
    yield* presence.set(orgId, KinChatId.make("member-chat"), line("wake-member"));

    const theirs = (yield* canvas.read(member, { orgId })).activity;
    assert.deepStrictEqual(theirs, [
      {
        agentId: lead,
        name: "Invented Lead",
        chatId: KinChatId.make("member-chat"),
        state: "working",
        label: null,
        startedAt: at,
        keys: [keys.open],
      },
    ]);
    const mine = (yield* canvas.read(owner, { orgId })).activity;
    assert.deepStrictEqual(
      mine.map((one): ReadonlyArray<unknown> => [one.chatId, one.keys]),
      [["owner-chat", [keys.secret]]],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("the live canvas sends each viewer only what their read would show", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const seeded = yield* seed;
      const { keys } = seeded;
      const canvas = yield* KinCanvas.KinCanvas;
      const records = yield* KinRecords.KinRecords;
      const widgets = yield* arrange(seeded);

      // A place the owner moves reaches a co-owner's open canvas.
      const events = yield* Queue.unbounded<KinCanvasEvent>();
      yield* canvas.subscribe(coOwner, { orgId }).pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      assert.strictEqual((yield* Queue.take(events))._tag, "snapshot");
      yield* canvas.place(owner, { orgId, places: [{ key: keys.open, x: 7, y: 8 }] });
      assert.deepStrictEqual(yield* Queue.take(events), {
        _tag: "placed",
        places: [{ key: keys.open, x: 7, y: 8 }],
      });

      // A member's session hears of their own entries' places only.
      const theirs = yield* canvas.session(member, { orgId });
      yield* theirs.start();
      const moved = [
        { key: keys.secret, x: 1, y: 1 },
        { key: keys.open, x: 2, y: 2 },
      ];
      yield* canvas.place(owner, { orgId, places: moved });
      assert.deepStrictEqual(yield* theirs.news({ _tag: "placed", places: moved }), [
        { _tag: "placed", places: [{ key: keys.open, x: 2, y: 2 }] },
      ]);
      assert.deepStrictEqual(yield* theirs.news({ _tag: "unplaced", keys: [keys.secret] }), []);
      assert.deepStrictEqual(
        yield* theirs.news({ _tag: "widgetRemoved", id: widgets.hiddenProgress.id }),
        [],
      );

      // A task done in Alpha moves Alpha's widgets for everyone who reads them.
      const mine = yield* canvas.session(owner, { orgId });
      yield* mine.start();
      const pull = yield* Stream.toPull(records.changes(orgId));
      yield* pull;
      yield* Work.update(owner, {
        orgId,
        key: keys.open,
        rev: yield* revOf(keys.open),
        state: "done",
      });
      const ticks: Array<KinRecords.Tick> = [];
      while (!ticks.some((tick) => tick.key === keys.open)) ticks.push(...(yield* pull));
      const progress = (sent: ReadonlyArray<KinCanvasEvent>) =>
        sent.flatMap((event) =>
          event._tag === "widget" && event.widget.id === widgets.progress.id
            ? [event.widget.value]
            : [],
        );
      const ownerSent = yield* mine.ticks(ticks);
      assert.deepStrictEqual(progress(ownerSent), [{ _tag: "progress", done: 2, total: 5 }]);
      const memberSent = yield* theirs.ticks(ticks);
      assert.deepStrictEqual(progress(memberSent), [{ _tag: "progress", done: 2, total: 4 }]);
      assert.deepStrictEqual(memberSent.map((event) => event._tag).toSorted(), [
        "widget",
        "widget",
      ]);
      for (const hidden of [
        keys.secret,
        keys.elsewhere,
        widgets.hiddenProgress.id,
        widgets.hiddenCountdown.id,
      ])
        assert.notInclude(named(memberSent), `"${hidden}"`);

      // A co-owner made a member: the owner's next move starts their canvas over as a member's.
      const sql = yield* SqlClient.SqlClient;
      const demoted = yield* canvas.session(coOwner, { orgId });
      yield* demoted.start();
      yield* sql`UPDATE kin_people SET access = 'member'
        WHERE org_id = ${orgId} AND person_id = ${coOwnerId}`;
      const afterDemotion = yield* demoted.news({ _tag: "placed", places: moved });
      assert.deepStrictEqual(
        afterDemotion.map((event) => event._tag),
        ["snapshot"],
      );
      assert.notInclude(named(afterDemotion), `"${keys.secret}"`);
    }),
  ).pipe(Effect.provide(layer)),
);
