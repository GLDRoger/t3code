import { assert, it } from "@effect/vitest";
import { KinAgentId, KinChatId, KinMemberId, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Repository from "./KinChatRepository.ts";
import * as Hub from "./KinChatHub.ts";

const layer = Hub.layer.pipe(
  Layer.provideMerge(Repository.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);

it.effect("delivers only committed viewer events and isolates organizations", () =>
  Effect.gen(function* () {
    const hub = yield* Hub.KinChatHub;
    const sql = yield* SqlClient.SqlClient;
    const repo = yield* Repository.KinChatRepository;
    const orgId = KinOrgId.make("org");
    const personId = KinPersonId.make("owner");
    const chatId = KinChatId.make("chat");
    const memberId = KinMemberId.make("member");
    const now = "1970-01-01T00:00:00.000Z";
    yield* repo.insertOrg({ orgId, name: "Kin", createdAt: now });
    yield* repo.insertPerson({
      orgId,
      personId,
      handle: "owner",
      displayName: "Owner",
      githubLogin: null,
      createdAt: now,
    });
    yield* repo.createChat({
      orgId,
      chatId,
      kind: "project_group",
      title: "Test",
      teamId: null,
      directKey: null,
      createdAt: now,
      lastMessageAt: null,
      archivedAt: null,
    });
    yield* repo.addMember({
      orgId,
      chatId,
      memberId,
      principal: { _tag: "person", personId },
      role: "owner",
      joinedAt: now,
      leftAt: null,
      mutedUntil: null,
    });
    const first = yield* hub.subscribeForViewer({ _tag: "person", orgId, personId });
    const second = yield* hub.subscribeForViewer({ _tag: "person", orgId, personId });
    const event: Hub.KinChatHubEvent = { type: "read.updated", orgId, chatId, memberId, seq: 1 };
    yield* sql
      .withTransaction(
        hub.publish({ ...event, seq: 0 }).pipe(Effect.andThen(Effect.fail("rollback"))),
      )
      .pipe(Effect.flip);
    yield* hub.publish({ ...event, orgId: KinOrgId.make("other") });
    yield* sql.withTransaction(hub.publish(event));
    yield* hub.publish({ ...event, seq: 2 });
    assert.deepStrictEqual(yield* Stream.runCollect(first.pipe(Stream.take(2))), [
      event,
      { ...event, seq: 2 },
    ]);
    assert.deepStrictEqual(yield* Stream.runCollect(second.pipe(Stream.take(2))), [
      event,
      { ...event, seq: 2 },
    ]);

    // Activity reaches only the chat's members, and only when its phase changes.
    const agentId = KinAgentId.make("lead");
    const unjoined = KinChatId.make("unjoined");
    const activity = (phase: "started" | "notes_read" | "idle") => ({
      type: "activity.updated" as const,
      orgId,
      chatId,
      activity: { agentId, phase, since: 0 },
    });
    yield* hub.setActivity({ orgId, agentId, chatIds: [chatId, unjoined], phase: "started" });
    yield* hub.setActivity({ orgId, agentId, chatIds: [chatId], phase: "started" });
    yield* hub.setWorkingPhase(orgId, KinAgentId.make("other"), "notes_read");
    yield* hub.setWorkingPhase(orgId, agentId, "notes_read");
    yield* hub.setActivity({ orgId, agentId, chatIds: [chatId], phase: "idle" });
    yield* hub.setActivity({ orgId, agentId, chatIds: [chatId], phase: "idle" });
    assert.deepStrictEqual(yield* Stream.runCollect(first.pipe(Stream.take(3))), [
      activity("started"),
      activity("notes_read"),
      activity("idle"),
    ]);
    assert.isNull(yield* hub.activity(orgId, chatId));
    assert.strictEqual((yield* hub.activity(orgId, unjoined))?.phase, "notes_read");
  }).pipe(Effect.provide(layer)),
);
