import { expect, it } from "@effect/vitest";
import {
  KinAgentId,
  KinChatId,
  KinEvent,
  KinMemberId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinWakeupId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinLeadPrompt } from "../lead/LeadPrompt.ts";
import * as Memory from "../memory/Memory.ts";
import * as Chat from "./KinChatRepository.ts";
import { authorityLayer } from "./WakeupAuthority.testkit.ts";

const orgId = KinOrgId.make("fixture-org");
const agentId = KinAgentId.make("fixture-lead");
const chatId = KinChatId.make("fixture-direct");
const personId = KinPersonId.make("fixture-owner");
const memberId = KinMemberId.make("fixture-member");
const timestamp = "2026-11-08T00:00:00.000Z";
const decodeEvent = Schema.decodeSync(KinEvent);

// What the lead remembers lives outside the chat's rows; a clear has no way to reach it.
const memory = Layer.succeed(
  Memory.Memory,
  Memory.Memory.of({
    withWriterLock: (_org, effect) => effect,
    anchor: () => Effect.succeed("fixture"),
    record: () => Effect.void,
    recover: () => Effect.void,
    withHistoryRewrite: () => Effect.die("Unused"),
    withLandingLock: (_org, effect) => effect,
    landingState: () => Effect.die("Unused"),
    purgeInFlight: () => Effect.die("Unused"),
    historyGeneration: () => Effect.die("Unused"),
    readPromptSnapshot: () =>
      Effect.succeed({ rules: "Invented rules", index: "- [fact] Launch day is Friday" }),
    ensureCheckouts: () => Effect.die("Unused"),
    prepareWakeup: () => Effect.die("Unused"),
    readIndex: () => Effect.die("Unused"),
    readRules: () => Effect.die("Unused"),
    query: () => Effect.succeed([]),
    readItem: () => Effect.die("Unused"),
    readItemQuietly: (org, id) => Effect.fail(new Memory.MemoryNotFound({ orgId: org, id })),
    rebuildIndex: () => Effect.die("Unused"),
    rebuildCache: () => Effect.die("Unused"),
    syncCheckout: () => Effect.die("Unused"),
  }),
);
const layer = KinLeadPrompt.layer.pipe(
  Layer.provideMerge(Layer.merge(Chat.layer.pipe(Layer.provide(authorityLayer)), memory)),
  Layer.provideMerge(authorityLayer),
);

it.effect(
  "a lead's next prompt after a clear has none of the cleared chat and all of its memory",
  () =>
    Effect.gen(function* () {
      const repo = yield* Chat.KinChatRepository;
      const sql = yield* SqlClient.SqlClient;
      const prompt = yield* KinLeadPrompt;
      yield* repo.insertOrg({ orgId, name: "Invented team", createdAt: timestamp });
      yield* repo.insertPerson({
        orgId,
        personId,
        displayName: "Fixture",
        handle: "fixture",
        githubLogin: null,
        createdAt: timestamp,
      });
      yield* repo.insertAgent({
        orgId,
        agentId,
        displayName: "Fixture lead",
        role: "lead",
        ownerPersonId: personId,
        createdAt: timestamp,
      });
      yield* repo.createChat({
        orgId,
        chatId,
        kind: "direct",
        title: null,
        teamId: null,
        lastMessageAt: null,
        createdAt: timestamp,
        archivedAt: null,
        directKey: `${personId}:${agentId}`,
      });
      for (const [id, principal, role] of [
        [memberId, { _tag: "person", personId }, "owner"],
        [KinMemberId.make("lead-member"), { _tag: "agent", agentId }, "member"],
      ] as const)
        yield* repo.addMember({
          orgId,
          chatId,
          memberId: id,
          principal,
          role,
          joinedAt: timestamp,
          leftAt: null,
          mutedUntil: null,
        });
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
      VALUES (${agentId}, ${orgId}, 'Lead', 0, '{}', '[]', ${chatId})`;
      const say = (id: string, body: string) =>
        repo.insertMessage({
          orgId,
          chatId,
          messageId: KinMessageId.make(id),
          author: { _tag: "human", personId, memberId },
          kind: "text",
          body,
          intent: null,
          mentions: [],
          replyTo: null,
          widgetId: null,
          floorRunId: null,
          status: "posted",
          sentBy: null,
          createdAt: timestamp,
          editedAt: null,
          clientMessageId: null,
        });
      /** The prompt of a turn answering `messageId`, as its wake-up would build it. */
      const answering = Effect.fn("test.answering")(function* (messageId: string) {
        const wakeupId = KinWakeupId.make(`wake-${messageId}`);
        const event = decodeEvent({
          _tag: "chat.message",
          orgId,
          agentId,
          chatId,
          messageId,
          eventId: `event-${messageId}`,
          receivedAt: timestamp,
          dedupeKey: null,
          provenance: { _tag: "human", personId, memberId },
        });
        yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status, event_ids)
        VALUES (${wakeupId}, ${orgId}, ${agentId}, 'model', 0, 'completed', '[]')`;
        yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at, queued_at, state, wakeup_id)
        VALUES (${event.eventId}, ${orgId}, ${agentId}, ${event._tag}, 'P0', ${JSON.stringify(event)}, 0, 0, 'done', ${wakeupId})`;
        return yield* prompt.build({
          orgId,
          agentId,
          wakeupId,
          memoryHead: "head",
          events: [event],
          lane: { chatId, mode: "reply" },
        });
      });

      yield* say("secret", "The launch code is tangerine");
      // A lead's own earlier answer, and the owner's reaction to it, also feed its next turn.
      yield* sql`UPDATE kin_chats SET last_seq = last_seq + 1 WHERE org_id = ${orgId} AND chat_id = ${chatId}`;
      yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_agent_id,
        author_owner_person_id, author_thread_id, author_member_id, author_role, kind, body, mentions_json,
        status, created_at)
      SELECT 'answer', ${orgId}, ${chatId}, last_seq, 'agent', ${agentId}, ${personId}, 'fixture-thread',
        'lead-member', 'member', 'text', 'Noted the tangerine code', '[]', 'posted', ${timestamp}
      FROM kin_chats WHERE org_id = ${orgId} AND chat_id = ${chatId}`;
      yield* sql`INSERT INTO kin_reactions (org_id, chat_id, message_id, member_id, emoji, created_at)
      VALUES (${orgId}, ${chatId}, 'answer', ${memberId}, '👎', 1)`;
      yield* say("before", "Which code did I give you?");
      const before = yield* answering("before");
      expect(before).toContain("The launch code is tangerine");
      expect(before).toContain("Noted the tangerine code");

      yield* repo.clearChat({ orgId, chatId, clearedAt: timestamp, clearedAtMs: 2 });
      yield* say("after", "Which code did I give you?");
      const after = yield* answering("after");
      expect(after).not.toContain("tangerine");
      expect(after).toContain("Which code did I give you?");
      expect(after).toContain("Launch day is Friday");
    }).pipe(Effect.provide(layer)),
);
