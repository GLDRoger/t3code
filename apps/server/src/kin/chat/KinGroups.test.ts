import { assert, it } from "@effect/vitest";
import {
  KinAgentId,
  KinChatId,
  KinEventId,
  KinMessageId,
  KinPersonId,
  KinWakeupId,
  ThreadId,
  type KinMemberId,
  type KinMessage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ChatWake from "../lead/ChatWake.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as KinLevels from "../lead/KinLevels.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Presence from "../reply/KinPresence.ts";
import * as Hub from "./KinChatHub.ts";
import * as Repository from "./KinChatRepository.ts";
import * as Service from "./KinChatService.ts";
import * as Groups from "./KinGroups.ts";
import * as Identity from "./KinIdentity.ts";
import { environment } from "./TaskCard.testkit.ts";
// After the chat service: the two import each other, and this order is the one that loads.
import { deferralOrigin } from "../triggers/deferralOrigin.ts";

const at = "1970-01-01T00:00:00.000Z";
const layer = Layer.mergeAll(Groups.layer, Service.layer, KinEventQueue.layer).pipe(
  Layer.provideMerge(
    Identity.KinIdentity.layer.pipe(
      Layer.provide(
        Layer.succeed(Identity.KinIdentityConfig, {
          orgName: "Kin",
          ownerHandle: "owner",
          ownerDisplayName: "Owner",
        }),
      ),
    ),
  ),
  Layer.provideMerge(Presence.layer),
  Layer.provideMerge(Hub.layer),
  Layer.provideMerge(Repository.layer),
  Layer.provideMerge(Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory)),
  Layer.provideMerge(environment),
);

const threadOf = (agentId: KinAgentId) => ThreadId.make(`${agentId}-thread`);

/** The owner, two of their leads with a direct chat each, and two teammates. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Repository.KinChatRepository;
  const chats = yield* Service.KinChatService;
  const groups = yield* Groups.KinGroups;
  const identity = yield* Identity.KinIdentity;
  const queue = yield* KinEventQueue.KinEventQueue;
  const hub = yield* Hub.KinChatHub;
  const { owner } = identity;
  const { orgId } = owner;
  const lead = Effect.fn("test.lead")(function* (id: string, name: string) {
    const agentId = KinAgentId.make(id);
    yield* repo.insertAgent({
      orgId,
      agentId,
      ownerPersonId: owner.personId,
      displayName: name,
      role: "lead",
      createdAt: at,
    });
    yield* identity.registerAgentThread({ orgId, agentId, threadId: threadOf(agentId) });
    const direct = yield* chats.createDirect(owner, { orgId, agentId });
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
      VALUES (${agentId}, ${orgId}, ${name}, 0, '{}', '[]', ${direct.chatId})`;
    return agentId;
  });
  const person = Effect.fn("test.person")(function* (id: string, name: string) {
    const personId = KinPersonId.make(id);
    yield* repo.insertPerson({
      orgId,
      personId,
      handle: KinPersonId.make(id),
      displayName: KinPersonId.make(name),
      githubLogin: null,
      createdAt: at,
    });
    return { _tag: "person" as const, orgId, personId };
  });
  const tech = yield* lead("tech", "Tech lead");
  const growth = yield* lead("growth", "Growth lead");
  const priya = yield* person("priya", "Priya");
  const sam = yield* person("sam", "Sam");

  // The wake listener, with a way to wait until it has seen everything posted so far.
  const seen = yield* Queue.unbounded<string>();
  yield* Layer.build(
    ChatWake.layer.pipe(
      Layer.provide(
        Layer.succeed(Hub.KinChatHub, {
          ...hub,
          subscribeAll: hub.subscribeAll.pipe(
            Effect.map(
              Stream.tap((event) =>
                event.type === "message.posted"
                  ? Queue.offer(seen, event.message.messageId)
                  : Effect.void,
              ),
            ),
          ),
        }),
      ),
    ),
  );
  // The listener takes one event at a time, so a marker it has pulled means it finished with
  // every message before it. A system row wakes nobody.
  let markers = 0;
  const said = Effect.fn("test.said")(function* (message: KinMessage) {
    const marker = KinMessageId.make(`marker-${++markers}`);
    yield* hub.publish({
      type: "message.posted",
      orgId,
      message: { ...message, messageId: marker, author: { _tag: "system" }, kind: "system" },
    });
    while ((yield* Queue.take(seen)) !== marker);
    return message;
  });
  let sends = 0;
  const say = (
    who: Identity.PersonIdentity | Identity.AgentIdentity,
    chatId: KinChatId,
    body: string,
    mentions: ReadonlyArray<KinMemberId> = [],
  ) =>
    chats
      .send(who, {
        chatId,
        body,
        mentions,
        clientMessageId: `send-${++sends}`,
        ...(who._tag === "agent" ? { intent: "answer" as const } : {}),
      })
      .pipe(Effect.flatMap(said));
  /** Events as the queue holds them: which lead, for which message, in which wake-up. */
  const events = sql<{
    agentId: string;
    messageId: string;
    state: string;
    wakeupId: string | null;
  }>`
    SELECT agent_id AS "agentId", json_extract(json, '$.messageId') AS "messageId", state,
      wakeup_id AS "wakeupId" FROM kin_events ORDER BY queued_at, event_id`;
  let wakeups = 0;
  /** Claims everything queued for the lead, as its runner would, and returns its identity. */
  const wake = Effect.fn("test.wake")(function* (agentId: KinAgentId) {
    const wakeupId = KinWakeupId.make(`wakeup-${++wakeups}`);
    yield* TestClock.adjust(20_000);
    yield* Effect.scoped(queue.claim({ orgId, agentId, wakeupId, model: "test" }));
    yield* sql`UPDATE kin_wakeups SET thread_id = ${threadOf(agentId)} WHERE wakeup_id = ${wakeupId}`;
    return {
      _tag: "agent" as const,
      orgId,
      agentId,
      ownerPersonId: owner.personId,
      threadId: threadOf(agentId),
      wakeupId,
    };
  });
  return {
    sql,
    repo,
    chats,
    groups,
    queue,
    owner,
    orgId,
    tech,
    growth,
    priya,
    sam,
    say,
    said,
    events,
    wake,
  };
});

const reason = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (error as { readonly reason?: string }).reason),
  );

it.effect("only the owner makes a group or changes it; a teammate reads and writes in theirs", () =>
  Effect.gen(function* () {
    const { groups, chats, owner, orgId, tech, growth, priya, sam, say } = yield* seed;
    const input = { orgId, title: "Launch", agentIds: [tech, growth], personIds: [priya.personId] };
    // A teammate can't make one, and nobody makes one with a lead that isn't the owner's.
    assert.strictEqual(yield* reason(groups.create([priya], input)), "not_allowed");
    assert.strictEqual(
      yield* reason(groups.create([owner], { ...input, agentIds: [KinAgentId.make("nobody")] })),
      "not_found",
    );
    assert.strictEqual(
      yield* reason(groups.create([owner], { ...input, agentIds: [], personIds: [] })),
      "invalid_state",
    );
    const chat = yield* groups.create([owner], input);
    assert.include(chat, { kind: "team_group", title: "Launch", leadAgentId: tech });
    const { chatId } = chat;
    const view = yield* groups.members([priya], { chatId });
    assert.deepStrictEqual(
      view.members.map((member) => [member.displayName, member.role]),
      [
        ["Owner", "owner"],
        ["Growth lead", "member"],
        ["Tech lead", "member"],
        ["Priya", "member"],
      ],
    );
    const member = (name: string) =>
      view.members.find((candidate) => candidate.displayName === name)!.memberId;
    // Priya is in it: she reads and writes. Sam is not: for him it does not exist.
    yield* say(priya, chatId, "Morning all");
    assert.lengthOf(
      (yield* chats.history([priya], { chatId, beforeSeq: 100, limit: 50 })).messages,
      1,
    );
    assert.strictEqual(yield* reason(groups.members([sam], { chatId })), "not_found");
    assert.strictEqual(yield* reason(say(sam, chatId, "Hello?")), "not_found");
    // Every change is the owner's alone, whoever is in the group.
    const changes = (who: Identity.PersonIdentity) => [
      groups.addMember([who], { chatId, principal: { _tag: "person", personId: sam.personId } }),
      groups.removeMember([who], { chatId, memberId: member("Growth lead") }),
      groups.setLead([who], { chatId, agentId: growth }),
      groups.rename([who], { chatId, title: "Mine now" }),
      groups.remove([who], { chatId }),
    ];
    for (const change of changes(priya)) assert.strictEqual(yield* reason(change), "not_allowed");
    for (const change of changes(sam)) assert.strictEqual(yield* reason(change), "not_found");
    assert.include((yield* groups.members([owner], { chatId })).chat, {
      title: "Launch",
      leadAgentId: tech,
    });
    // A direct chat never takes a third: the owner makes a group instead.
    const direct = yield* chats.createDirect(owner, { orgId, agentId: tech });
    assert.strictEqual(
      yield* reason(
        groups.addMember([owner], {
          chatId: direct.chatId,
          principal: { _tag: "agent", agentId: growth },
        }),
      ),
      "not_allowed",
    );
    // The list row stays small: the viewer's own member, and who wrote the last line.
    const list = Option.getOrThrow(yield* Stream.runHead(chats.subscribeChats([owner], {})));
    if (list._tag !== "snapshot") return assert.fail("Expected a snapshot");
    const row = list.chats.find((candidate) => candidate.chatId === chatId)!;
    assert.lengthOf(row.members, 1);
    assert.strictEqual(row.lastAuthorName, "Priya");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a group message wakes the leads it names, else the group's lead, and a lead's message wakes nobody",
  () =>
    Effect.gen(function* () {
      const { groups, chats, queue, owner, orgId, tech, growth, priya, say, events, wake, sql } =
        yield* seed;
      const { chatId } = yield* groups.create([owner], {
        orgId,
        title: "Launch",
        agentIds: [tech, growth],
        personIds: [priya.personId],
      });
      const { members } = yield* groups.members([owner], { chatId });
      const member = (name: string) =>
        members.find((candidate) => candidate.displayName === name)!.memberId;
      const woken = (message: KinMessage) =>
        events.pipe(
          Effect.map((rows) =>
            rows.filter((row) => row.messageId === message.messageId).map((row) => row.agentId),
          ),
        );
      assert.deepStrictEqual(yield* woken(yield* say(owner, chatId, "Where are we?")), ["tech"]);
      assert.deepStrictEqual(
        yield* woken(yield* say(owner, chatId, "Numbers?", [member("Growth lead")])),
        ["growth"],
      );
      const both = yield* say(owner, chatId, "Both of you: ready?", [
        member("Tech lead"),
        member("Growth lead"),
      ]);
      assert.deepStrictEqual((yield* woken(both)).toSorted(), ["growth", "tech"]);

      // Each lead answers once. Tech names Growth in its reply; that wakes nobody.
      const techTurn = yield* wake(tech);
      const growthTurn = yield* wake(growth);
      const before = (yield* events).length;
      const reply = yield* say(techTurn, chatId, "Ready. Growth lead?", [member("Growth lead")]);
      assert.deepStrictEqual(yield* woken(reply), []);
      yield* say(growthTurn, chatId, "Ready too. Tech lead, anything else?", [member("Tech lead")]);
      assert.lengthOf(yield* events, before);
      // Tech has had its turn on this message: it can't answer Growth's answer, as a reply or
      // as anything else, so the two never trade messages.
      assert.strictEqual(yield* reason(say(techTurn, chatId, "Nothing else.")), "invalid_state");
      assert.strictEqual(
        yield* reason(
          chats.send(techTurn, {
            chatId,
            body: "One more thing.",
            intent: "evidence",
            clientMessageId: "again",
          }),
        ),
        "floor_not_granted",
      );
      // Asked by name, then the chat moves on before it answers: Growth keeps its one reply.
      yield* queue.finish({ orgId, wakeupId: growthTurn.wakeupId, status: "completed" });
      yield* say(owner, chatId, "Growth lead, the numbers please", [member("Growth lead")]);
      yield* say(priya, chatId, "Thanks, Tech lead");
      const late = yield* wake(growth);
      const signups = yield* say(late, chatId, "Signups are up 4%. I can break them down.");
      assert.include(signups, { status: "posted" });
      // In a group, the owner's and a teammate's reactions are feedback and wake nobody.
      yield* chats.react(owner, { messageId: signups.messageId, emoji: "👍", on: true });
      yield* chats.react(priya, { messageId: signups.messageId, emoji: "👍", on: true });
      // Nor does changing one, or taking it back.
      yield* chats.react(owner, { messageId: signups.messageId, emoji: "👎", on: true });
      yield* chats.react(owner, { messageId: signups.messageId, emoji: "👎", on: false });
      yield* chats.react(priya, { messageId: signups.messageId, emoji: "👍", on: false });
      assert.deepStrictEqual(
        yield* sql`SELECT 1 FROM kin_reactions WHERE woke_at IS NOT NULL ORDER BY 1`,
        [],
      );
      assert.deepStrictEqual(yield* sql`SELECT 1 FROM kin_reaction_wakes ORDER BY 1`, []);
      // The owner picks who answers by default, and the next unnamed message goes there.
      assert.include(yield* groups.setLead([owner], { chatId, agentId: growth }), {
        leadAgentId: growth,
      });
      assert.deepStrictEqual(yield* woken(yield* say(priya, chatId, "Thanks both")), ["growth"]);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a lead a teammate's message woke works as that teammate, alone or batched with the owner's",
  () =>
    Effect.gen(function* () {
      const { sql, groups, owner, orgId, tech, growth, priya, say, events, wake } = yield* seed;
      const { chatId } = yield* groups.create([owner], {
        orgId,
        title: "Launch",
        agentIds: [tech, growth],
        personIds: [priya.personId],
      });
      const { members } = yield* groups.members([owner], { chatId });
      const growthMember = members.find((member) => member.displayName === "Growth lead")!.memberId;
      const level = (turn: {
        readonly orgId: typeof orgId;
        readonly agentId: KinAgentId;
        readonly wakeupId: KinWakeupId;
      }) =>
        Effect.all({
          level: KinLevels.wakeupLevel(turn),
          ownerAlone: KinLevels.ownerAlone(turn),
        });
      // The replayed sequence: the owner asks Growth, then asks the group; Priya adds a request
      // before the group's lead has started.
      yield* say(owner, chatId, "Growth lead, plan the launch post", [growthMember]);
      yield* say(owner, chatId, "Fix the signup bug today");
      yield* say(priya, chatId, "And merge my branch while you're at it");
      const growthTurn = yield* wake(growth);
      const techTurn = yield* wake(tech);
      assert.deepStrictEqual((yield* events).map((row) => [row.agentId, row.wakeupId]).toSorted(), [
        ["growth", growthTurn.wakeupId],
        ["tech", techTurn.wakeupId],
        ["tech", techTurn.wakeupId],
      ]);
      // Only the owner asked Growth: it works as it does for the owner anywhere.
      assert.deepStrictEqual(yield* level(growthTurn), { level: "L2", ownerAlone: true });
      // Tech's wake-up holds the owner's message and Priya's: it works as Priya's, so it talks
      // and starts nothing, whichever message it says it is answering.
      assert.deepStrictEqual(yield* level(techTurn), { level: "L1", ownerAlone: false });
      assert.strictEqual(yield* KinLevels.originCap(techTurn), "L1");
      // A reminder set in that wake-up comes back as Priya's too, even when the lead cites the
      // owner's message for it; one set in Growth's comes back as the owner's.
      const sources = yield* sql<{ agentId: string; eventId: string; chat: string }>`
        SELECT e.agent_id AS "agentId", e.event_id AS "eventId", l.owner_chat_id AS chat
        FROM kin_events e JOIN kin_leads l ON l.agent_id = e.agent_id
        JOIN kin_messages m ON m.message_id = json_extract(e.json, '$.messageId')
        WHERE m.author_person_id = ${owner.personId} ORDER BY e.agent_id`;
      const due = (agentId: KinAgentId) => {
        const source = sources.find((row) => row.agentId === agentId)!;
        return deferralOrigin(
          sql,
          orgId,
          { chat: chatId, source_event: KinEventId.make(source.eventId) },
          { agentId, ownerChatId: KinChatId.make(source.chat) },
        );
      };
      const growthDue = yield* due(growth);
      assert.deepStrictEqual(growthDue, { agentId: growth, chatId });
      assert.strictEqual(yield* KinLevels.originLevel(orgId, growthDue!), "L2");
      const techDue = yield* due(tech);
      assert.deepStrictEqual(techDue, { agentId: tech, chatId, personId: priya.personId });
      assert.strictEqual(yield* KinLevels.originLevel(orgId, techDue!), "L1");
      // Who asked is the stored message's author: an event that claims the owner changes nothing.
      yield* sql`UPDATE kin_events SET json = json_set(json, '$.provenance.personId', ${owner.personId})
        WHERE wakeup_id = ${techTurn.wakeupId}`;
      assert.deepStrictEqual(yield* level(techTurn), { level: "L1", ownerAlone: false });
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "removing someone ends what they read, write and are asked; deleting ends the group",
  () =>
    Effect.gen(function* () {
      const { sql, groups, chats, owner, orgId, tech, growth, priya, sam, say, events } =
        yield* seed;
      const { chatId } = yield* groups.create([owner], {
        orgId,
        title: "Launch",
        agentIds: [tech, growth],
        personIds: [priya.personId],
      });
      const { members } = yield* groups.members([owner], { chatId });
      const member = (name: string) =>
        members.find((candidate) => candidate.displayName === name)!.memberId;
      const plan = yield* say(priya, chatId, "The plan is attached");
      yield* sql`INSERT INTO kin_message_attachments (attachment_id, org_id, chat_id, message_id)
      VALUES ('kin-chat-plan', ${orgId}, ${chatId}, ${plan.messageId})`;
      assert.isTrue(yield* chats.attachmentReadable([priya], "kin-chat-plan"));
      assert.isFalse(yield* chats.attachmentReadable([sam], "kin-chat-plan"));

      // Priya watches her list; being taken out removes the row there and then.
      const list = yield* Stream.toQueue(chats.subscribeChats([priya], {}), {
        capacity: "unbounded",
      });
      assert.strictEqual((yield* Queue.take(list))._tag, "snapshot");
      const open = yield* Stream.toQueue(chats.subscribe([owner], { chatId }), {
        capacity: "unbounded",
      });
      assert.strictEqual((yield* Queue.take(open))._tag, "backlog");
      yield* groups.removeMember([owner], { chatId, memberId: member("Priya") });
      // The owner's open chat hears of a change, never of a departure it could take for its own.
      const change = yield* Queue.take(open);
      assert.isTrue(change._tag === "member" && change.member.leftAt === null);
      const gone = yield* Queue.take(list);
      assert.isTrue(gone._tag === "chat" && gone.chat.members[0]?.leftAt !== null);
      assert.isFalse(yield* chats.attachmentReadable([priya], "kin-chat-plan"));
      assert.strictEqual(
        yield* reason(chats.history([priya], { chatId, beforeSeq: 100, limit: 50 })),
        "not_found",
      );
      assert.strictEqual(yield* reason(say(priya, chatId, "Still here?")), "not_found");
      assert.strictEqual(yield* reason(groups.members([priya], { chatId })), "not_found");
      // Back in under the member she was, she reads from her return on: the file came before.
      const back = yield* groups.addMember([owner], {
        chatId,
        principal: { _tag: "person", personId: priya.personId },
      });
      assert.strictEqual(back.memberId, member("Priya"));
      assert.isFalse(yield* chats.attachmentReadable([priya], "kin-chat-plan"));

      // A lead taken out no longer hears the group: what was queued for it never runs, and the
      // group keeps a lead.
      const asked = yield* say(owner, chatId, "Numbers?", [member("Growth lead")]);
      yield* groups.removeMember([owner], { chatId, memberId: member("Growth lead") });
      assert.deepStrictEqual(
        (yield* events).filter((row) => row.messageId === asked.messageId).map((row) => row.state),
        ["expired"],
      );
      // It can no longer be named here, and an unnamed message goes to the lead who is left.
      assert.strictEqual(
        yield* reason(say(owner, chatId, "Growth lead, there?", [member("Growth lead")])),
        "not_found",
      );
      const after = yield* say(owner, chatId, "Anyone on numbers?");
      assert.deepStrictEqual(
        (yield* events)
          .filter((row) => row.messageId === after.messageId)
          .map((row) => row.agentId),
        ["tech"],
      );
      yield* groups.addMember([owner], { chatId, principal: { _tag: "agent", agentId: growth } });
      yield* groups.removeMember([owner], { chatId, memberId: member("Tech lead") });
      assert.strictEqual((yield* groups.members([owner], { chatId })).chat.leadAgentId, growth);

      assert.include(yield* groups.rename([owner], { chatId, title: "Launch week" }), {
        title: "Launch week",
      });
      // Deleted, it is gone for everyone, the owner included.
      yield* groups.remove([owner], { chatId });
      for (const who of [owner, priya]) {
        assert.strictEqual(yield* reason(groups.members([who], { chatId })), "not_found");
        assert.strictEqual(yield* reason(say(who, chatId, "Anyone?")), "not_found");
        assert.isFalse(yield* chats.attachmentReadable([who], "kin-chat-plan"));
      }
      assert.isEmpty((yield* events).filter((row) => row.state === "queued"));
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "an answer changed while the lead still works on the first waits its turn, then runs",
  () =>
    Effect.gen(function* () {
      const { sql, chats, queue, owner, orgId, tech, say, said, wake } = yield* seed;
      const [direct] = yield* sql<{ chatId: KinChatId }>`SELECT owner_chat_id AS "chatId"
      FROM kin_leads WHERE agent_id = ${tech}`;
      const chatId = direct!.chatId;
      yield* say(owner, chatId, "Merge the release PR");
      const first = yield* wake(tech);
      const offer = yield* say(first, chatId, "Merged. I can tag the release too if you want.");
      yield* queue.finish({ orgId, wakeupId: first.wakeupId, status: "completed" });
      const react = (emoji: "👍" | "👎") =>
        chats
          .react(owner, { messageId: offer.messageId, emoji, on: true })
          .pipe(Effect.andThen(said(offer)));
      const reactions = sql<{
        emoji: string;
        changedFrom: string | null;
        state: string;
        wakeupId: string | null;
      }>`SELECT json_extract(json, '$.emoji') AS emoji,
        json_extract(json, '$.changedFrom') AS "changedFrom", state, wakeup_id AS "wakeupId"
      FROM kin_events WHERE tag = 'chat.reaction' ORDER BY queued_at, event_id`;
      yield* react("👍");
      const tagging = yield* wake(tech);
      yield* react("👎");
      const [yes, no] = yield* reactions;
      assert.include(yes, { emoji: "👍", changedFrom: null, wakeupId: tagging.wakeupId });
      assert.deepStrictEqual(no, {
        emoji: "👎",
        changedFrom: "👍",
        state: "queued",
        wakeupId: null,
      });
      yield* queue.finish({ orgId, wakeupId: tagging.wakeupId, status: "completed" });
      const stopping = yield* wake(tech);
      assert.deepStrictEqual(
        (yield* reactions).map((row) => row.wakeupId),
        [tagging.wakeupId, stopping.wakeupId],
      );
    }).pipe(Effect.provide(layer)),
);

// Fifth review of cfb0c8993b: everything said in a group before someone joined was the owner's
// alone, and every read path a member has must keep it from them.
it.effect(
  "someone added to a group reads nothing from before they joined, live or stored; the owner reads it all",
  () =>
    Effect.gen(function* () {
      const { sql, groups, chats, owner, orgId, tech, priya, say } = yield* seed;
      const { chatId } = yield* groups.create([owner], {
        orgId,
        title: "Launch",
        agentIds: [tech],
        personIds: [],
      });
      const before = yield* say(owner, chatId, "Invented private plan");
      yield* sql`INSERT INTO kin_message_attachments (attachment_id, org_id, chat_id, message_id)
        VALUES ('kin-chat-before', ${orgId}, ${chatId}, ${before.messageId})`;
      yield* sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class, type,
          revision, state_json, awaiting_json, updated_at)
        VALUES ('card-before', ${orgId}, ${chatId}, ${before.messageId}, 'native', 'task', 1, '{}',
          '[]', '1970-01-01T00:00:00.000Z')`;
      yield* chats.react(owner, { messageId: before.messageId, emoji: "👍", on: true });

      yield* groups.addMember([owner], {
        chatId,
        principal: { _tag: "person", personId: priya.personId },
      });
      // A moment after joining: the list row, the backlog and every page show nothing earlier.
      const list = yield* chats.subscribeChats([priya], {}).pipe(Stream.take(1), Stream.runCollect);
      const row =
        list[0]?._tag === "snapshot" ? list[0].chats.find((c) => c.chatId === chatId) : undefined;
      assert.isNull(row?.lastMessage ?? null);
      assert.strictEqual(row?.unread, 0);
      const live = yield* Stream.toQueue(
        chats.subscribe([priya], { chatId, afterSeq: 0, afterChangeSeq: 0 }),
        {
          capacity: "unbounded",
        },
      );
      const backlog = yield* Queue.take(live);
      assert.isTrue(backlog._tag === "backlog");
      if (backlog._tag === "backlog") {
        assert.deepStrictEqual(backlog.messages, []);
        assert.deepStrictEqual(backlog.widgets, []);
        assert.deepStrictEqual(backlog.reactions, []);
      }
      const page = yield* chats.history([priya], { chatId, beforeSeq: 100, limit: 50 });
      assert.deepStrictEqual(page.messages, []);
      assert.deepStrictEqual(page.widgets, []);
      assert.deepStrictEqual(page.reactions, []);
      assert.isFalse(yield* chats.attachmentReadable([priya], "kin-chat-before"));
      assert.strictEqual(
        yield* reason(chats.react(priya, { messageId: before.messageId, emoji: "👀", on: true })),
        "not_found",
      );

      // Something new on the old message reaches the owner only; what is said now reaches her.
      yield* chats.react(owner, { messageId: before.messageId, emoji: "🎉", on: true });
      const after = yield* say(owner, chatId, "Welcome, Priya");
      yield* sql`INSERT INTO kin_message_attachments (attachment_id, org_id, chat_id, message_id)
        VALUES ('kin-chat-after', ${orgId}, ${chatId}, ${after.messageId})`;
      const next = yield* Queue.take(live);
      assert.isTrue(next._tag === "message" && next.message.messageId === after.messageId);
      assert.deepStrictEqual(
        (yield* chats.history([priya], { chatId, beforeSeq: 100, limit: 50 })).messages.map(
          (message) => message.messageId,
        ),
        [after.messageId],
      );
      assert.isTrue(yield* chats.attachmentReadable([priya], "kin-chat-after"));
      const ownerPage = yield* chats.history([owner], { chatId, beforeSeq: 100, limit: 50 });
      assert.deepStrictEqual(
        ownerPage.messages.map((message) => message.messageId),
        [before.messageId, after.messageId],
      );
      assert.lengthOf(ownerPage.widgets, 1);
      assert.deepStrictEqual(
        (ownerPage.reactions ?? []).map((reaction) => reaction.emoji),
        ["🎉"],
      );
      assert.isTrue(yield* chats.attachmentReadable([owner], "kin-chat-before"));
      // The group was shared from her join, and stays so.
      const [chat] = yield* sql<{ sharedFromSeq: number | null }>`SELECT shared_from_seq AS
        "sharedFromSeq" FROM kin_chats WHERE chat_id = ${chatId}`;
      assert.strictEqual(chat?.sharedFromSeq, after.seq);
    }).pipe(Effect.provide(layer)),
);
