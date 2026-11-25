// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  KinAgentId,
  KinOrgId,
  KinPersonId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as Refresh from "../chat/KinRefreshHub.ts";
import { SHARED_REFUSAL } from "../lead/Audience.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import { inheritOutside, OUTSIDE_REFUSAL, stampEvent } from "../lead/OutsideContent.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinSchedules from "../triggers/kinSchedules.ts";
import { recordingSchedules } from "../triggers/kinSchedules.testkit.ts";
import { answerChange } from "../work/companyProfile.ts";
import * as KinRecords from "../work/KinRecords.ts";
import { feedTurn, makeFeeds } from "./feeds.ts";
import * as Numbers from "./KinNumbers.ts";
import { recordWatched } from "./mcp.ts";
import { answerNumbersChange } from "./answer.ts";
import { watch } from "./watch.ts";

// Invented company, people and sources only.
const orgId = KinOrgId.make("org");
const ownerId = KinPersonId.make("owner");
const mateId = KinPersonId.make("mate");
const lead = KinAgentId.make("lead");
const at = "2026-11-11T00:00:00.000Z";
const NOW = Date.parse("2026-11-12T06:00:00.000Z");
const SOURCE = "Invented analytics: DAU insight";

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("fixture"),
  requestNamespace: "fixture",
  issuedAt: 0,
  capabilities: new Set(),
  client: undefined,
  thread: {
    threadId: ThreadId.make("lead-thread"),
    providerSessionId: "fixture",
    providerInstanceId: ProviderInstanceId.make("claude"),
  },
};
const identity = Layer.mock(KinIdentity)({
  owner: { _tag: "person" as const, orgId, personId: ownerId },
  isAgentThread: () => true,
  isLeadThread: () => true,
  resolveAgent: () =>
    Effect.succeed({
      _tag: "agent" as const,
      orgId,
      agentId: lead,
      ownerPersonId: ownerId,
      threadId: ThreadId.make("lead-thread"),
    }),
});
// Kin's card for the owner, stored and bound in one transaction, as the chat service does.
const gate = Layer.unwrap(
  Effect.map(SqlClient.SqlClient, (sql) =>
    Layer.mock(KinLevelGate)({
      ask: (_agent, input, bind) =>
        Effect.gen(function* () {
          const widgetId = `choice:${input.clientMessageId}`;
          const state = { question: input.question, detail: input.detail ?? null, answer: null };
          const [{ seq }] = (yield* sql<{ seq: number }>`SELECT 1000 + COUNT(*) AS seq
            FROM kin_widgets`) as [{ seq: number }];
          yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
              author_agent_id, author_owner_person_id, author_thread_id, author_member_id,
              author_role, kind, body, mentions_json, status, created_at)
            VALUES (${`card-${widgetId}`}, ${orgId}, ${input.chatId}, ${seq}, 'agent', ${lead},
              ${ownerId}, 'lead-thread', 'lead-chat-lead', 'member', 'text', '', '[]', 'posted',
              ${at})
            ON CONFLICT DO NOTHING`;
          yield* sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class,
              type, revision, state_json, awaiting_json, updated_at)
            VALUES (${widgetId}, ${orgId}, ${input.chatId}, ${`card-${widgetId}`}, 'native',
              'choice', 1, ${JSON.stringify(state)}, ${JSON.stringify([ownerId])}, ${at})
            ON CONFLICT DO NOTHING`;
          if (bind !== undefined) yield* bind({ widgetId } as never);
          return { widgetId } as never;
        }).pipe(sql.withTransaction, Effect.orDie),
      closeReplaced: (_agent, widgetIds) =>
        Effect.forEach(
          widgetIds,
          (widgetId) => sql`UPDATE kin_widgets SET closed_at = ${at} WHERE widget_id = ${widgetId}`,
        ).pipe(Effect.asVoid, Effect.orDie),
    }),
  ),
);
const saves: Array<KinSchedules.SaveInput> = [];
const cancels: Array<string> = [];
const layer = Layer.mergeAll(
  KinRecords.layer,
  identity,
  gate,
  Refresh.layer,
  recordingSchedules(saves, cancels),
).pipe(
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-numbers-watch-" })),
  Layer.provideMerge(NodeServices.layer),
);

/** The owner (Rhea), a member (Meera) and one lead with its direct chat with the owner. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  saves.length = 0;
  cancels.length = 0;
  yield* TestClock.setTime(NOW);
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', ${at})`;
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, 'UTC', '08:30', '18:00', '02:00', 0, 1, '09:00', '{}')`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
    VALUES (${ownerId}, ${orgId}, 'rhea', 'Rhea', ${at}, 'owner'),
      (${mateId}, ${orgId}, 'meera', 'Meera', ${at}, 'member')`;
  yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
    VALUES (${orgId}, 'goals', 'Goals', 'G', 1, ${NOW})`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id,
      created_at, retired_at)
    VALUES (${lead}, ${orgId}, 'Chief of staff', 'lead', ${ownerId}, ${at}, NULL)`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
    VALUES ('lead-chat', ${orgId}, 'direct', 'owner:lead', 0, ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id,
      role, joined_at)
    VALUES ('lead-chat-owner', ${orgId}, 'lead-chat', 'person', ${ownerId}, 'owner', ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id,
      role, joined_at)
    VALUES ('lead-chat-lead', ${orgId}, 'lead-chat', 'agent', ${lead}, 'member', ${at})`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
    VALUES ('team-chat', ${orgId}, 'team_group', 0, ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id,
      role, joined_at)
    VALUES ('team-chat-mate', ${orgId}, 'team-chat', 'person', ${mateId}, 'member', ${at})`;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
      worker_projects_json, owner_chat_id)
    VALUES (${lead}, ${orgId}, 'Chief of staff', 0, 'lead-thread', '{}', '[]', 'lead-chat')`;
});

/** A turn woken by the owner in their chat with the lead, or by Meera in a group. */
const turn = (n: number, audience: "owner_only" | "shared" = "owner_only") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [personId, chatId, memberId] =
      audience === "owner_only"
        ? [ownerId, "lead-chat", "lead-chat-owner"]
        : [mateId, "team-chat", "team-chat-mate"];
    yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE status = 'running'`;
    yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
        author_person_id, author_member_id, author_role, kind, body, mentions_json, status,
        created_at)
      VALUES (${`msg-${n}`}, ${orgId}, ${chatId}, ${n}, 'human', ${personId}, ${memberId},
        'member', 'text', 'Invented: watch our daily users', '[]', 'posted', ${at})`;
    yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at,
        status, event_ids, audience)
      VALUES (${`wake-${n}`}, ${orgId}, ${lead}, 'lead-thread', 'test', 0, 'running',
        ${JSON.stringify([`event-${n}`])}, ${audience})`;
    const event = {
      _tag: "chat.message",
      orgId,
      agentId: lead,
      eventId: `event-${n}`,
      receivedAt: at,
      dedupeKey: null,
      provenance: { _tag: "human", personId, memberId },
      chatId,
      messageId: `msg-${n}`,
    };
    yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
        received_at, queued_at, state, wakeup_id)
      VALUES (${`event-${n}`}, ${orgId}, ${lead}, 'chat.message', 'P0', ${JSON.stringify(event)},
        0, 0, 'claimed', ${`wake-${n}`})`;
  });

const cards = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ widgetId: string; chatId: string; detail: string; closed: number }>`SELECT
      w.widget_id AS "widgetId", w.chat_id AS "chatId",
      json_extract(w.state_json, '$.detail') AS detail, w.closed_at IS NOT NULL AS closed
    FROM kin_profile_changes c JOIN kin_widgets w ON w.widget_id = c.widget_id
    ORDER BY c.rowid`;
});
const answer = (widgetId: string, personId: KinPersonId, confirmed = true) =>
  answerNumbersChange({ orgId, widgetId, personId, confirmed, via: "tap", now: NOW });
const watched = Effect.map(Numbers.ownerLevelNumbers(orgId, NOW), (numbers) =>
  numbers.map(({ key, name, below, every, definedSource, keeper }) => ({
    key,
    name,
    below,
    every,
    definedSource,
    keeper,
  })),
);
const dailyUsers = {
  numbers: [
    { name: "Daily users", unit: "users", below: "1000" },
    { name: "Weekly users", unit: "users" },
  ],
  feed: { source: SOURCE, every: "day" as const, at: "08:00" },
};

it.effect(
  "an agent proposes numbers on one card; the owner's Confirm makes them and one feed in their chat",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* turn(1);
      // Named but not watched: the way forward, and nothing recorded.
      const unwatched = yield* Effect.flip(
        recordWatched(scope, {
          values: [{ number: "Daily users", value: "940", asOf: "2026-11-11", source: SOURCE }],
        }),
      );
      assert.strictEqual(
        unwatched.message,
        `"Daily users" isn't a watched number yet: propose it with numbers_watch.`,
      );
      const proposed = yield* watch(scope, dailyUsers);
      assert.deepStrictEqual(proposed.proposed, [
        `Watch "Daily users": speak up below 1,000 users; from "${SOURCE}", fetched every day at 08:00`,
        `Watch "Weekly users": no limit; from "${SOURCE}", fetched every day at 08:00`,
      ]);
      const [card] = yield* cards;
      assert.deepInclude(card, { chatId: "lead-chat", detail: proposed.proposed.join("\n") });
      assert.deepStrictEqual(yield* watched, [], "nothing is watched before Confirm");
      // Another card's answers don't take this one, nor this one another's.
      assert.isUndefined(
        yield* answerChange({
          orgId,
          widgetId: card!.widgetId,
          personId: ownerId,
          confirmed: true,
          via: "tap",
          now: NOW,
        }),
      );
      assert.isUndefined(yield* answer("choice:other", ownerId));

      // A member's Confirm is refused and makes nothing.
      assert.include(yield* Effect.flip(answer(card!.widgetId, mateId)), {
        reason: "not_allowed",
      });
      assert.deepStrictEqual(yield* watched, []);

      // The owner's Confirm makes exactly those numbers, kept by the agent that asked, once.
      assert.deepInclude(yield* answer(card!.widgetId, ownerId), { title: "Watching" });
      const made = {
        below: undefined,
        every: "day" as const,
        definedSource: SOURCE,
        keeper: lead,
      };
      assert.deepStrictEqual(yield* watched, [
        { ...made, key: "G-1", name: "Daily users", below: "1000" },
        { ...made, key: "G-2", name: "Weekly users" },
      ]);
      assert.include(yield* Effect.flip(answer(card!.widgetId, ownerId)), {
        reason: "widget_changed",
      });

      // Its feed is one schedule, in the owner's direct chat with the keeper, made once.
      const schedules = yield* KinSchedules.KinSchedules;
      yield* makeFeeds(orgId, schedules);
      yield* makeFeeds(orgId, schedules);
      assert.lengthOf(saves, 1);
      const [save] = saves;
      assert.deepStrictEqual(
        {
          agentId: save?.agentId,
          chatId: save?.chatId,
          saidBy: save?.saidBy,
          existing: save?.existing,
          ownerTime: save?.ownerTime,
        },
        {
          agentId: lead,
          chatId: "lead-chat",
          saidBy: ownerId,
          existing: false,
          ownerTime: { at: "08:00", days: [0, 1, 2, 3, 4, 5, 6] },
        },
      );
      const scheduleId = saves[0]!.scheduleId;

      // Its run asks for every number it keeps from that source, as of yesterday.
      assert.deepStrictEqual(yield* feedTurn(orgId, scheduleId, NOW), {
        text: `Record "Daily users" (G-1) and "Weekly users" (G-2) from "${SOURCE}" as of 2026-11-11. If this is the first run, record up to 28 days back. If the source can't be read, say so in one line and record nothing. When it is recorded, reply NO_REPLY: a fetch that worked needs no message, and Kin tells you separately if a number is outside its limit.`,
      });
      // The keeper's prompt says where and when it fetches them.
      yield* turn(2);
      assert.deepStrictEqual(
        (yield* Numbers.forAgent({ _tag: "agent", orgId, agentId: lead, wakeupId: "wake-2" })).kept,
        ["G-1", "G-2"].map((key, index) => ({
          key,
          name: index === 0 ? "Daily users" : "Weekly users",
          feed: { source: SOURCE, every: "day", at: "08:00" },
        })),
      );
      // A number named, not keyed, is found among the watched ones.
      yield* recordWatched(scope, {
        values: [{ number: "daily users", value: "940", asOf: "2026-11-11", source: SOURCE }],
      });
      // An archived number is left out; one already recorded for the day isn't asked again.
      yield* (yield* KinRecords.KinRecords).update(
        orgId,
        { actor: { _tag: "person", personId: ownerId }, via: "owner" },
        "G-2",
        { state: "dropped" },
      );
      assert.isUndefined(yield* feedTurn(orgId, scheduleId, NOW));
      assert.include(
        (yield* feedTurn(orgId, scheduleId, NOW + 24 * 60 * 60_000))?.text,
        `Record "Daily users" (G-1) from`,
      );
      // Stopping the schedule stops the feed.
      yield* schedules.cancel(orgId, scheduleId);
      assert.isUndefined(yield* feedTurn(orgId, scheduleId, NOW + 24 * 60 * 60_000));
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a newer card for the same source replaces the older; a card older than what it names is refused",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* turn(1);
      yield* watch(scope, dailyUsers);
      yield* turn(2);
      yield* watch(scope, { ...dailyUsers, numbers: [{ name: "Daily users", below: "900" }] });
      yield* turn(3);
      yield* watch(scope, {
        numbers: [{ name: "Daily users", below: "800" }],
        feed: { source: "Invented store console", every: "week", at: "09:00" },
      });
      const [older, newer, other] = yield* cards;
      assert.deepStrictEqual(
        [older!.closed, newer!.closed, other!.closed],
        [1, 0, 0],
        "only the older card for the same source closes",
      );
      assert.include((yield* Effect.flip(answer(older!.widgetId, ownerId))).message, "replaced");

      // The other card made "Daily users" since: the newer card names a number that changed.
      yield* answer(other!.widgetId, ownerId);
      const stale = yield* Effect.flip(answer(newer!.widgetId, ownerId));
      assert.include(stale, { reason: "conflict" });
      assert.strictEqual(
        stale.message,
        "A number or feed on this card changed since it was made, so nothing was changed. Ask for it again.",
      );
      assert.deepStrictEqual(
        (yield* watched).map(({ key, below }) => ({ key, below })),
        [{ key: "G-1", below: "800" }],
      );

      // A card for an existing number changes it; Cancel changes nothing.
      yield* turn(4);
      const change = yield* watch(scope, { numbers: [{ name: "daily users", below: "700" }] });
      assert.deepStrictEqual(change.proposed, [
        'Change "Daily users" (G-1): speak up below 700 (now below 800)',
      ]);
      assert.deepInclude(yield* answer((yield* cards).at(-1)!.widgetId, ownerId, false), {
        title: "Not watched",
      });
      assert.strictEqual((yield* watched)[0]!.below, "800");
    }).pipe(Effect.provide(layer)),
);

it.effect("the owner level sets and clears a number's limits; a member can't", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* turn(1);
    yield* watch(scope, dailyUsers);
    yield* answer((yield* cards)[0]!.widgetId, ownerId);
    const owner = { _tag: "person" as const, orgId, personId: ownerId };
    const set = yield* Numbers.setLimit(owner, "G-2", { above: "5000", below: "100" });
    assert.deepInclude(set, { key: "G-2", above: "5000", below: "100" });
    const cleared = yield* Numbers.setLimit(owner, "G-2", { above: null });
    assert.isUndefined(cleared?.above);
    assert.strictEqual(cleared?.below, "100");
    assert.include(
      yield* Effect.flip(Numbers.setLimit({ ...owner, personId: mateId }, "G-2", { below: "1" })),
      { reason: "not_allowed" },
    );
    assert.strictEqual((yield* watched)[1]!.below, "100");
  }).pipe(Effect.provide(layer)),
);

it.effect("a shared chat or a turn that read outside text can't propose numbers", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    yield* turn(1, "shared");
    assert.deepInclude(yield* Effect.flip(watch(scope, dailyUsers)), {
      reason: "not_allowed",
      message: SHARED_REFUSAL,
    });
    yield* turn(2);
    yield* stampEvent(orgId, "event-2", "connection:conn-mail");
    yield* inheritOutside({ orgId, wakeupId: "wake-2", eventIds: ["event-2"] });
    assert.deepInclude(yield* Effect.flip(watch(scope, dailyUsers)), {
      reason: "not_allowed",
      message: OUTSIDE_REFUSAL,
    });
    assert.lengthOf(yield* sql`SELECT 1 FROM kin_profile_changes`, 0);
    assert.lengthOf(yield* sql`SELECT 1 FROM kin_widgets`, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("a source given as a connection's id reads as that connection's name", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_connections (org_id, connection_id, preset, label, kind, url,
        url_host, auth, reach, state, created_at, updated_at)
      VALUES (${orgId}, 'conn-ph1', 'posthog', 'PostHog', 'remote', 'https://invented.example',
        'invented.example', 'key', 'closed', 'active', 0, 0)`;
    yield* turn(1);
    const proposed = yield* watch(scope, {
      numbers: [{ name: "Daily users", below: "1000" }],
      feed: { source: "conn-ph1", every: "day", at: "08:00" },
    });
    assert.notInclude(proposed.proposed.join("\n"), "conn-ph1");
    assert.include(proposed.proposed[0], `from "PostHog", fetched every day at 08:00`);
    yield* answer((yield* cards)[0]!.widgetId, ownerId);
    assert.strictEqual((yield* watched)[0]!.definedSource, "PostHog");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a card is bound to what it was drawn from, and the agent that asks keeps the number",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* turn(1);
      yield* watch(scope, dailyUsers);
      yield* answer((yield* cards)[0]!.widgetId, ownerId);
      // The owner took Daily users over by hand since.
      yield* sql`UPDATE kin_records SET owner_kind = 'person', owner_id = ${ownerId}
      WHERE org_id = ${orgId} AND key = 'G-1'`;
      yield* turn(2);
      const change = yield* watch(scope, { numbers: [{ name: "Daily users", below: "900" }] });
      assert.deepStrictEqual(change.proposed, [
        'Change "Daily users" (G-1): speak up below 900 users (now below 1,000 users); kept by Chief of staff (was Rhea)',
      ]);
      // Its direction changed after the card was drawn: Confirm changes nothing.
      yield* sql`UPDATE kin_records SET rev = rev + 1,
        fields_json = json_set(fields_json, '$.direction', 'up')
      WHERE org_id = ${orgId} AND key = 'G-1'`;
      const stale = yield* Effect.flip(answer((yield* cards).at(-1)!.widgetId, ownerId));
      assert.strictEqual(
        stale.message,
        "A number or feed on this card changed since it was made, so nothing was changed. Ask for it again.",
      );
      // Asked again and confirmed: the asking agent keeps it.
      yield* turn(3);
      yield* watch(scope, { numbers: [{ name: "Daily users", below: "900" }] });
      yield* answer((yield* cards).at(-1)!.widgetId, ownerId);
      assert.deepInclude((yield* watched)[0], { key: "G-1", below: "900", keeper: lead });
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "the card shows how a feed is read and what a computed number counts, and binds both",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* turn(1);
      const how = "Open the DAU insight and read each day's unique users.";
      const fed = yield* watch(scope, {
        numbers: [{ name: "Daily users", below: "1000" }],
        feed: { source: SOURCE, every: "day", at: "08:00", how },
      });
      assert.deepStrictEqual(fed.proposed, [
        `Watch "Daily users": speak up below 1,000; from "${SOURCE}", fetched every day at 08:00`,
        `How: ${how}`,
      ]);
      assert.strictEqual((yield* cards)[0]!.detail, fed.proposed.join("\n"));
      // What Confirm applies is what the card showed: changed words since are refused.
      yield* sql`UPDATE kin_profile_changes
      SET patch_json = json_set(patch_json, '$.feed.how', 'Read the private breakdown too.')`;
      assert.include(yield* Effect.flip(answer((yield* cards)[0]!.widgetId, ownerId)), {
        reason: "conflict",
      });
      yield* turn(2);
      const counted = yield* watch(scope, {
        numbers: [
          {
            name: "Open deals",
            below: "5",
            direction: "up",
            compute: { count: "deals", states: ["open", "waiting"] },
          },
          { name: "Money in", compute: { builtin: "revenue_received" } },
        ],
      });
      assert.deepStrictEqual(counted.proposed, [
        'Watch "Open deals": speak up below 5; Kin counts Deals in open or waiting, higher is better',
        'Watch "Money in": no limit; Kin works out money received from its own records',
      ]);
    }).pipe(Effect.provide(layer)),
);

it.effect("a number the team sees says so on the card when it gains a feed or a limit", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    yield* turn(1);
    yield* watch(scope, { numbers: [{ name: "Stock on hand" }] });
    yield* answer((yield* cards)[0]!.widgetId, ownerId);
    // The owner shared it with the team for typing it in.
    yield* sql`UPDATE kin_records SET team_shared = 1 WHERE org_id = ${orgId} AND key = 'G-1'`;
    yield* turn(2);
    const fed = yield* watch(scope, {
      numbers: [{ name: "Stock on hand" }],
      feed: { source: "Invented warehouse sheet", every: "day", at: "07:00" },
    });
    assert.deepStrictEqual(fed.proposed, [
      'Change "Stock on hand" (G-1): no limit; from "Invented warehouse sheet", fetched every day at 07:00. The team sees this number, so they will see what is fetched.',
    ]);
    yield* turn(3);
    const limited = yield* watch(scope, { numbers: [{ name: "Stock on hand", below: "20" }] });
    assert.deepStrictEqual(limited.proposed, [
      'Change "Stock on hand" (G-1): speak up below 20 (now no limit). The team sees this number and its limit.',
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("one source has one schedule: a paused feed is reused and resumed, never doubled", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const schedules = yield* KinSchedules.KinSchedules;
    yield* turn(1);
    yield* watch(scope, dailyUsers);
    yield* answer((yield* cards)[0]!.widgetId, ownerId);
    yield* makeFeeds(orgId, schedules);
    // A person paused it, then the owner asked for the feed again.
    yield* sql`UPDATE kin_schedules SET pending_enabled = 0`;
    yield* turn(2);
    yield* watch(scope, { ...dailyUsers, numbers: [{ name: "Daily users", below: "900" }] });
    yield* answer((yield* cards).at(-1)!.widgetId, ownerId);
    yield* makeFeeds(orgId, schedules);
    assert.deepStrictEqual(cancels, []);
    assert.deepStrictEqual(
      yield* sql`SELECT schedule_id AS "scheduleId", pending_enabled AS paused FROM kin_schedules
        WHERE deleted_at IS NULL ORDER BY schedule_id`,
      [{ scheduleId: saves[0]!.scheduleId, paused: null }],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("a source moving to another keeper takes all its numbers, on one card, in place", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const schedules = yield* KinSchedules.KinSchedules;
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id,
        created_at) VALUES ('fin', ${orgId}, 'Finance', 'lead', ${ownerId}, ${at})`;
    yield* turn(1);
    yield* watch(scope, dailyUsers);
    yield* answer((yield* cards)[0]!.widgetId, ownerId);
    yield* makeFeeds(orgId, schedules);
    // Finance keeps the source and both its numbers now.
    yield* sql`UPDATE kin_records SET owner_id = 'fin' WHERE org_id = ${orgId}`;
    yield* sql`UPDATE kin_schedules SET agent_id = 'fin'`;
    yield* turn(2);
    const moving = yield* watch(scope, {
      ...dailyUsers,
      numbers: [{ name: "Daily users", below: "900" }],
    });
    assert.deepStrictEqual(moving.proposed, [
      `Change "Daily users" (G-1): speak up below 900 users (now below 1,000 users); from "${SOURCE}", fetched every day at 08:00; kept by Chief of staff (was Finance)`,
      `"${SOURCE}" moves from Finance to Chief of staff, with 2 numbers.`,
    ]);
    yield* answer((yield* cards).at(-1)!.widgetId, ownerId);
    assert.deepStrictEqual(
      (yield* watched).map(({ key, keeper }) => ({ key, keeper })),
      [
        { key: "G-1", keeper: lead },
        { key: "G-2", keeper: lead },
      ],
    );
    yield* makeFeeds(orgId, schedules);
    // The same schedule, saved in place for the new keeper: never none, never two.
    assert.deepStrictEqual(cancels, []);
    assert.deepStrictEqual(
      yield* sql`SELECT schedule_id AS "scheduleId", agent_id AS "agentId" FROM kin_schedules
        WHERE deleted_at IS NULL ORDER BY schedule_id`,
      [{ scheduleId: saves[0]!.scheduleId, agentId: lead }],
    );
  }).pipe(Effect.provide(layer)),
);
