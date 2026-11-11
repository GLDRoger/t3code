import * as Deferred from "effect/Deferred";
import { assert, it } from "@effect/vitest";
import {
  AuthKinChatScope,
  AuthStandardClientScopes,
  AuthSessionId,
  KinAgentId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinWakeupId,
  ThreadId,
  type KinChatId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { SessionStore } from "../../auth/SessionStore.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as Service from "../chat/KinChatService.ts";
import * as Groups from "../chat/KinGroups.ts";
import { environment } from "../chat/TaskCard.testkit.ts";
import { destination } from "../lead/Audience.ts";
import * as ChatWake from "../lead/ChatWake.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as Stop from "../lead/KinStop.ts";
import * as Presence from "../reply/KinPresence.ts";
import { KinIdentity, KinIdentityConfig } from "../chat/KinIdentity.ts";
import { layerKinAuthTest, pairSession } from "../auth/ProofKeySessions.testkit.ts";
import * as People from "./KinPeople.ts";

const database = layerKinAuthTest("kin-people-");
const identities = KinIdentity.layer.pipe(
  Layer.provide(
    Layer.succeed(KinIdentityConfig, {
      orgName: "Kin",
      ownerHandle: "owner",
      ownerDisplayName: "Owner",
    }),
  ),
  Layer.provideMerge(Repository.layer),
);
const layer = People.layer.pipe(
  Layer.provideMerge(Hub.layer),
  Layer.provideMerge(identities),
  Layer.provideMerge(database),
);
const ownerSession = {
  sessionId: AuthSessionId.make("owner"),
  subject: "browser",
  method: "browser-session-cookie" as const,
  scopes: AuthStandardClientScopes,
};

it.effect(
  "invites are owner-only, hashed, expiring and consumed once with person and narrow session",
  () =>
    Effect.gen(function* () {
      const service = yield* People.KinPeople;
      const identity = yield* KinIdentity;
      const sessions = yield* SessionStore;
      const sql = yield* SqlClient.SqlClient;
      yield* pairSession(ownerSession.sessionId);
      assert.deepEqual(yield* identity.resolve(ownerSession), [identity.owner]);
      const input = { orgId: identity.owner.orgId, displayName: "Suraj" };
      const outsider = {
        ...ownerSession,
        sessionId: AuthSessionId.make("outsider"),
        scopes: [AuthKinChatScope],
      };
      assert.equal(
        (yield* service.createInvite(outsider, input).pipe(Effect.flip))._tag,
        "KinChatError",
      );
      const invite = yield* service.createInvite(ownerSession, input);
      const rows = yield* sql<{
        secret_hash: string;
      }>`SELECT secret_hash FROM kin_people_invites WHERE org_id = ${input.orgId} AND invite_id = ${invite.inviteId}`;
      assert.match(rows[0]!.secret_hash, /^[a-f0-9]{64}$/);
      assert.notInclude(JSON.stringify(rows), invite.secret.split(".")[2]!);
      const results = yield* Effect.all(
        [
          service.accept({ secret: invite.secret }).pipe(Effect.result),
          service.accept({ secret: invite.secret }).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter((r) => r._tag === "Success").length, 1);
      const accepted = results.find((r) => r._tag === "Success");
      assert.isDefined(accepted);
      if (accepted._tag !== "Success") return;
      const member = accepted.success;
      const verified = yield* sessions.verify(member.accessToken);
      assert.deepEqual(verified.scopes, [AuthKinChatScope]);
      assert.deepEqual(yield* identity.resolve(verified), [
        { _tag: "person", orgId: input.orgId, personId: member.person.personId },
      ]);
      const rollback = yield* service.createInvite(ownerSession, {
        ...input,
        displayName: "Rollback",
        handle: "rollback",
      });
      yield* sql`CREATE TRIGGER fail_member_bind BEFORE INSERT ON kin_session_bindings BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`;
      assert.equal(
        (yield* service.accept({ secret: rollback.secret }).pipe(Effect.result))._tag,
        "Failure",
      );
      const pending = yield* sql<{
        consumed_at: number | null;
      }>`SELECT consumed_at FROM kin_people_invites WHERE org_id = ${input.orgId} AND invite_id = ${rollback.inviteId}`;
      assert.isNull(pending[0]!.consumed_at);
      assert.lengthOf(
        yield* sql`SELECT person_id FROM kin_people WHERE org_id = ${input.orgId} AND handle = 'rollback'`,
        0,
      );
      yield* sql`DROP TRIGGER fail_member_bind`;
      yield* service.accept({ secret: rollback.secret });
      const expired = yield* service.createInvite(ownerSession, {
        ...input,
        handle: "expired",
        ttlHours: 1,
      });
      yield* TestClock.adjust("1 hour");
      assert.equal(
        (yield* service.accept({ secret: expired.secret }).pipe(Effect.flip))._tag,
        "KinChatError",
      );
      assert.equal(
        (yield* service.accept({ secret: invite.secret + "x" }).pipe(Effect.flip))._tag,
        "KinChatError",
      );
      const updated = yield* service.setGithubLogin(verified, {
        orgId: input.orgId,
        personId: member.person.personId,
        githubLogin: "suraj",
      });
      assert.equal(updated.githubLogin, "suraj");
      assert.equal(
        (yield* service
          .setGithubLogin(verified, {
            orgId: input.orgId,
            personId: identity.owner.personId,
            githubLogin: "hostile",
          })
          .pipe(Effect.flip))._tag,
        "KinChatError",
      );
      yield* service.setGithubLogin(ownerSession, {
        orgId: input.orgId,
        personId: member.person.personId,
        githubLogin: "suraj-ios",
      });
      assert.lengthOf(
        (yield* service.listDevices(ownerSession, {
          orgId: input.orgId,
          personId: member.person.personId,
        })).devices,
        1,
      );
      assert.equal(
        (yield* service
          .listDevices(ownerSession, {
            orgId: KinOrgId.make("other"),
            personId: member.person.personId,
          })
          .pipe(Effect.flip))._tag,
        "KinChatError",
      );
      assert.equal(
        (yield* service
          .createInvite(ownerSession, { ...input, personId: KinPersonId.make("other-org-person") })
          .pipe(Effect.flip))._tag,
        "KinChatError",
      );
      const started = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const live = Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        return yield* Effect.never;
      }).pipe(Effect.ensuring(Deferred.succeed(stopped, undefined)));
      const invalidated = yield* Effect.raceFirst(
        live,
        sessions.awaitInvalidation(member.sessionId),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* service.revokeDevice(ownerSession, {
        orgId: input.orgId,
        personId: member.person.personId,
        sessionId: member.sessionId,
      });
      yield* Fiber.join(invalidated);
      yield* Deferred.await(stopped);
      assert.isTrue(
        (yield* sessions.verify(member.accessToken).pipe(Effect.result))._tag === "Failure",
      );
      assert.deepEqual(yield* identity.resolve(verified), []);
      const again = yield* service.createInvite(ownerSession, {
        ...input,
        personId: member.person.personId,
      });
      assert.equal(
        (yield* service.accept({ secret: again.secret })).person.personId,
        member.person.personId,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect.each(["create", "accept"] as const)("rejects owner binding at %s", (stage) =>
  Effect.gen(function* () {
    const service = yield* People.KinPeople;
    const identity = yield* KinIdentity;
    const sql = yield* SqlClient.SqlClient;
    yield* pairSession(ownerSession.sessionId);
    const input = { orgId: identity.owner.orgId, displayName: "Owner device" };
    if (stage === "create") {
      assert.propertyVal(
        yield* service
          .createInvite(ownerSession, { ...input, personId: identity.owner.personId })
          .pipe(Effect.flip),
        "reason",
        "not_allowed",
      );
    } else {
      const invite = yield* service.createInvite(ownerSession, input);
      yield* sql`UPDATE kin_people_invites SET person_id = ${identity.owner.personId} WHERE invite_id = ${invite.inviteId}`;
      assert.propertyVal(
        yield* service.accept({ secret: invite.secret }).pipe(Effect.flip),
        "reason",
        "not_found",
      );
      assert.lengthOf(yield* sql`SELECT * FROM kin_session_bindings`, 0);
    }
  }).pipe(Effect.provide(layer)),
);
it.effect("reserves invite handles and rechecks collisions at acceptance", () =>
  Effect.gen(function* () {
    const service = yield* People.KinPeople;
    const identity = yield* KinIdentity;
    const sql = yield* SqlClient.SqlClient;
    yield* pairSession(ownerSession.sessionId);
    const input = { orgId: identity.owner.orgId, displayName: "Sam" };
    const first = yield* service.createInvite(ownerSession, input);
    const second = yield* service.createInvite(ownerSession, input);
    assert.notEqual(first.handle, second.handle);
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at) VALUES ('collision', ${input.orgId}, ${first.handle}, 'Sam', '2026-01-01T00:00:00.000Z')`;
    const a = yield* service.accept({ secret: first.secret });
    const b = yield* service.accept({ secret: second.secret });
    assert.notEqual(a.person.handle, b.person.handle);
    assert.notEqual(a.person.handle, first.handle);
    const timestamps = yield* sql<{
      created_at: string;
    }>`SELECT created_at FROM kin_people WHERE person_id = ${a.person.personId}`;
    assert.match(timestamps[0]!.created_at, /^\d{4}-/);
  }).pipe(Effect.provide(layer)),
);
it.effect("GitHub routing logins are unique per org ignoring case", () =>
  Effect.gen(function* () {
    const service = yield* People.KinPeople;
    const identity = yield* KinIdentity;
    const orgId = identity.owner.orgId;
    yield* pairSession(ownerSession.sessionId);
    yield* service.setGithubLogin(ownerSession, {
      orgId,
      personId: identity.owner.personId,
      githubLogin: "OwnerLogin",
    });
    const invite = yield* service.createInvite(ownerSession, { orgId, displayName: "Member" });
    const member = yield* service.accept({ secret: invite.secret });
    const sessions = yield* SessionStore;
    const session = yield* sessions.verify(member.accessToken);
    assert.propertyVal(
      yield* service
        .setGithubLogin(session, {
          orgId,
          personId: member.person.personId,
          githubLogin: "ownerlogin",
        })
        .pipe(Effect.flip),
      "reason",
      "not_allowed",
    );
    yield* service.setGithubLogin(session, {
      orgId,
      personId: member.person.personId,
      githubLogin: "member",
    });
    yield* service.setGithubLogin(session, {
      orgId,
      personId: member.person.personId,
      githubLogin: "MEMBER",
    });
    yield* service.setGithubLogin(session, {
      orgId,
      personId: member.person.personId,
      githubLogin: null,
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("only the owner can list and revoke pending invites; revoked secrets are unknown", () =>
  Effect.gen(function* () {
    const service = yield* People.KinPeople;
    const identity = yield* KinIdentity;
    const orgId = identity.owner.orgId;
    yield* pairSession(ownerSession.sessionId);
    const invite = yield* service.createInvite(ownerSession, { orgId, displayName: "Pending" });
    const used = yield* service.createInvite(ownerSession, { orgId, displayName: "Used" });
    const member = yield* service.accept({ secret: used.secret });
    const sessions = yield* SessionStore;
    const session = yield* sessions.verify(member.accessToken);
    const input = { orgId, inviteId: invite.inviteId };
    assert.propertyVal(
      yield* service.listInvites(session, orgId).pipe(Effect.flip),
      "reason",
      "not_allowed",
    );
    assert.propertyVal(
      yield* service.revokeInvite(session, input).pipe(Effect.flip),
      "reason",
      "not_allowed",
    );
    const pending = yield* service.listInvites(ownerSession, orgId);
    assert.deepEqual(
      pending.invites.map((row) => row.inviteId),
      [invite.inviteId],
    );
    assert.deepEqual(Object.keys(pending.invites[0]!).sort(), [
      "createdAt",
      "displayName",
      "expiresAt",
      "handle",
      "inviteId",
      "personId",
    ]);
    assert.isTrue((yield* service.revokeInvite(ownerSession, input)).revoked);
    assert.deepEqual((yield* service.listInvites(ownerSession, orgId)).invites, []);
    const revoked = yield* service.accept({ secret: invite.secret }).pipe(Effect.flip);
    const unknown = yield* service
      .accept({ secret: invite.secret.replace(invite.inviteId, "unknown") })
      .pipe(Effect.flip);
    assert.propertyVal(revoked, "reason", "not_found");
    assert.propertyVal(unknown, "reason", "not_found");
    assert.equal(revoked.message, unknown.message);
    const expired = yield* service.createInvite(ownerSession, {
      orgId,
      displayName: "Expired",
      ttlHours: 1,
    });
    yield* TestClock.adjust("1 hour");
    assert.deepEqual((yield* service.listInvites(ownerSession, orgId)).invites, []);
    assert.propertyVal(
      yield* service
        .revokeInvite(ownerSession, { orgId, inviteId: expired.inviteId })
        .pipe(Effect.flip),
      "reason",
      "not_found",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "removing access signs every device out, cancels unused links and keeps the person; only the owner may",
  () =>
    Effect.gen(function* () {
      const service = yield* People.KinPeople;
      const identity = yield* KinIdentity;
      const sessions = yield* SessionStore;
      const orgId = identity.owner.orgId;
      yield* pairSession(ownerSession.sessionId);
      const first = yield* service.accept({
        secret: (yield* service.createInvite(ownerSession, { orgId, displayName: "Mira" })).secret,
      });
      const personId = first.person.personId;
      const link = () =>
        service.createInvite(ownerSession, { orgId, displayName: "Mira", personId });
      const second = yield* service.accept({ secret: (yield* link()).secret });
      const unused = yield* link();
      const other = yield* service.accept({
        secret: (yield* service.createInvite(ownerSession, { orgId, displayName: "Tomas" })).secret,
      });
      const joined = () =>
        service.list(ownerSession, orgId).pipe(Effect.map((list) => [...list.joined].sort()));
      assert.deepEqual(yield* joined(), [personId, other.person.personId].sort());

      const member = yield* sessions.verify(first.accessToken);
      assert.propertyVal(
        yield* service.removeAccess(member, { orgId, personId }).pipe(Effect.flip),
        "reason",
        "not_allowed",
      );
      assert.propertyVal(
        yield* service
          .removeAccess(ownerSession, { orgId, personId: identity.owner.personId })
          .pipe(Effect.flip),
        "reason",
        "not_allowed",
      );

      assert.isTrue((yield* service.removeAccess(ownerSession, { orgId, personId })).revoked);
      for (const device of [first, second])
        assert.equal(
          (yield* sessions.verify(device.accessToken).pipe(Effect.result))._tag,
          "Failure",
        );
      assert.deepEqual(yield* identity.resolve(member), []);
      assert.propertyVal(
        yield* service.accept({ secret: unused.secret }).pipe(Effect.flip),
        "reason",
        "not_found",
      );
      assert.deepEqual(yield* joined(), [other.person.personId]);
      const list = yield* service.list(ownerSession, orgId);
      assert.include(
        list.people.map((held) => held.personId),
        personId,
      );
      // The way back: a new link returns the same person.
      const back = yield* service.accept({ secret: (yield* link()).secret });
      assert.equal(back.person.personId, personId);
      assert.deepEqual(yield* joined(), [personId, other.person.personId].sort());
    }).pipe(Effect.provide(layer)),
);

const at = "1970-01-01T00:00:00.000Z";
const teamLayer = Layer.mergeAll(People.layer, Groups.layer, Service.layer).pipe(
  Layer.provideMerge(Stop.layer),
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(Presence.layer),
  Layer.provideMerge(Hub.layer),
  Layer.provideMerge(identities),
  Layer.provideMerge(database),
  Layer.provideMerge(environment),
);

// Review 14: removing someone left their turns running and their events queued.
it.effect(
  "removing access stops every turn and event answering them, takes them out of every chat, and a return starts fresh",
  () =>
    Effect.gen(function* () {
      const service = yield* People.KinPeople;
      const identity = yield* KinIdentity;
      const sessions = yield* SessionStore;
      const sql = yield* SqlClient.SqlClient;
      const repo = yield* Repository.KinChatRepository;
      const chats = yield* Service.KinChatService;
      const groups = yield* Groups.KinGroups;
      const queue = yield* KinEventQueue.KinEventQueue;
      const hub = yield* Hub.KinChatHub;
      const stop = yield* Stop.KinStop;
      const { owner } = identity;
      const { orgId } = owner;
      yield* pairSession(ownerSession.sessionId);
      const stopped: Array<string> = [];
      yield* stop.attach({
        pause: () => Effect.void,
        resume: () => Effect.void,
        abort: (_org, wakeupId) => Effect.sync(() => void stopped.push(wakeupId)),
      });

      const tech = KinAgentId.make("tech");
      const thread = ThreadId.make("tech-thread");
      yield* repo.insertAgent({
        orgId,
        agentId: tech,
        ownerPersonId: owner.personId,
        displayName: "Tech lead",
        role: "lead",
        createdAt: at,
      });
      yield* identity.registerAgentThread({ orgId, agentId: tech, threadId: thread });
      const ownerChat = yield* chats.createDirect(owner, { orgId, agentId: tech });
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
        VALUES (${tech}, ${orgId}, 'Tech lead', 0, '{}', '[]', ${ownerChat.chatId})`;
      const join = Effect.fn("test.join")(function* (displayName: string) {
        const accepted = yield* service.accept({
          secret: (yield* service.createInvite(ownerSession, { orgId, displayName })).secret,
        });
        return {
          accepted,
          person: { _tag: "person" as const, orgId, personId: accepted.person.personId },
        };
      });
      const mira = yield* join("Mira");
      const tomas = yield* join("Tomas");
      const allow = Effect.fn("test.allow")(function* () {
        yield* sql`INSERT INTO kin_lead_access (org_id, agent_id, person_id, granted_by, granted_at, revoked_at)
          VALUES (${orgId}, ${tech}, ${mira.person.personId}, ${owner.personId}, 0, NULL)
          ON CONFLICT (org_id, agent_id, person_id) DO UPDATE SET revoked_at = NULL`;
        return yield* chats.createDirect(mira.person, { orgId, agentId: tech });
      });
      const direct = yield* allow();
      yield* sql`INSERT INTO kin_push_devices (org_id, token, person_id, platform, aps_environment,
          session_id, created_at, updated_at)
        VALUES (${orgId}, 'mira-phone', ${mira.person.personId}, 'ios', 'production',
          ${mira.accepted.sessionId}, 0, 0)`;

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
      let sends = 0;
      const say = Effect.fn("test.say")(function* (
        who: { readonly _tag: "person"; readonly orgId: KinOrgId; readonly personId: KinPersonId },
        chatId: KinChatId,
        body: string,
      ) {
        const message = yield* chats.send(who, {
          chatId,
          body,
          mentions: [],
          clientMessageId: `send-${++sends}`,
        });
        const marker = KinMessageId.make(`marker-${sends}`);
        yield* hub.publish({
          type: "message.posted",
          orgId,
          message: { ...message, messageId: marker, author: { _tag: "system" }, kind: "system" },
        });
        while ((yield* Queue.take(seen)) !== marker);
        return message;
      });
      let wakeups = 0;
      const wake = Effect.fn("test.wake")(function* () {
        const wakeupId = KinWakeupId.make(`wakeup-${++wakeups}`);
        yield* TestClock.adjust(20_000);
        yield* Effect.scoped(queue.claim({ orgId, agentId: tech, wakeupId, model: "test" }));
        yield* sql`UPDATE kin_wakeups SET thread_id = ${thread}, audience = 'shared'
          WHERE wakeup_id = ${wakeupId}`;
        return {
          _tag: "agent" as const,
          orgId,
          agentId: tech,
          ownerPersonId: owner.personId,
          threadId: thread,
          wakeupId,
        };
      });
      const states = (personId: KinPersonId) =>
        sql<{ state: string }>`SELECT e.state FROM kin_events e
          JOIN kin_messages m ON m.message_id = json_extract(e.json, '$.messageId')
          WHERE m.author_person_id = ${personId} ORDER BY e.queued_at, e.event_id`.pipe(
          Effect.map((rows) => rows.map((row) => row.state)),
        );

      // Tomas joins a group first; Mira later. Before either, the owner wrote there alone.
      const group = yield* groups.create([owner], {
        orgId,
        title: "Launch",
        agentIds: [tech],
        personIds: [],
      });
      yield* say(owner, group.chatId, "Invented-owner-alone");
      yield* groups.addMember([owner], {
        chatId: group.chatId,
        principal: { _tag: "person", personId: tomas.person.personId },
      });
      yield* say(tomas.person, group.chatId, "Invented-tomas-early");
      yield* groups.addMember([owner], {
        chatId: group.chatId,
        principal: { _tag: "person", personId: mira.person.personId },
      });

      // Mira asks; the lead's turn is running; more of hers waits behind it.
      yield* say(mira.person, direct.chatId, "Invented-mira-question");
      const running = yield* wake();
      yield* say(mira.person, direct.chatId, "Invented-mira-followup");
      yield* say(mira.person, group.chatId, "Invented-mira-in-group");
      yield* say(tomas.person, group.chatId, "Invented-tomas-in-group");
      assert.deepStrictEqual(yield* states(mira.person.personId), ["claimed", "queued", "queued"]);
      const tomasBefore = yield* states(tomas.person.personId);

      assert.isTrue(
        (yield* service.removeAccess(ownerSession, { orgId, personId: mira.person.personId }))
          .revoked,
      );

      // The turn answering her is aborted and stopped, and may post nowhere.
      assert.deepStrictEqual(stopped, [running.wakeupId]);
      assert.strictEqual(
        yield* destination(running, direct.chatId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        ),
        "aborted",
      );
      assert.deepStrictEqual(yield* states(mira.person.personId), [
        "expired",
        "expired",
        "expired",
      ]);
      // Everyone else's stays as it was.
      assert.deepStrictEqual(yield* states(tomas.person.personId), tomasBefore);
      // Its finish requeues nothing of hers.
      yield* queue.finish({ orgId, wakeupId: running.wakeupId, status: "completed" });
      assert.deepStrictEqual(yield* states(mira.person.personId), [
        "expired",
        "expired",
        "expired",
      ]);
      // Out of every chat, every lead, every device and every later call.
      assert.isTrue(
        (yield* repo.listMembersByPerson({ orgId, personId: mira.person.personId })).every(
          (member) => member.leftAt !== null,
        ),
      );
      assert.deepStrictEqual(
        yield* sql`SELECT 1 FROM kin_lead_access WHERE person_id = ${mira.person.personId}
          AND revoked_at IS NULL`,
        [],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT 1 FROM kin_push_devices WHERE person_id = ${mira.person.personId}`,
        [],
      );
      assert.strictEqual(
        (yield* sessions.verify(mira.accepted.accessToken).pipe(Effect.result))._tag,
        "Failure",
      );
      yield* sessions.awaitInvalidation(mira.accepted.sessionId);
      assert.deepStrictEqual(
        yield* identity.resolve({
          ...ownerSession,
          sessionId: mira.accepted.sessionId,
          subject: "kin-member",
          scopes: [AuthKinChatScope],
        }),
        [],
      );
      // Leaving lowers the group's floor only to what Tomas, still there, could always read.
      const turn = yield* wake();
      assert.deepStrictEqual(
        (yield* chats.read(turn, { chatId: group.chatId, afterSeq: 0, limit: 100 })).map(
          (message) => message.body,
        ),
        ["Invented-tomas-early", "Invented-mira-in-group", "Invented-tomas-in-group"],
      );
      yield* queue.finish({ orgId, wakeupId: turn.wakeupId, status: "completed" });

      // Back again: a new joiner everywhere they are added, reading nothing from before.
      const back = yield* service.accept({
        secret: (yield* service.createInvite(ownerSession, {
          orgId,
          displayName: "Mira",
          personId: mira.person.personId,
        })).secret,
      });
      assert.strictEqual(back.person.personId, mira.person.personId);
      assert.deepStrictEqual(
        (yield* repo.listMembersByPerson({ orgId, personId: mira.person.personId })).filter(
          (member) => member.leftAt === null,
        ),
        [],
      );
      assert.strictEqual((yield* allow()).chatId, direct.chatId);
      yield* groups.addMember([owner], {
        chatId: group.chatId,
        principal: { _tag: "person", personId: mira.person.personId },
      });
      for (const chatId of [direct.chatId, group.chatId])
        assert.deepStrictEqual(
          (yield* chats.history([mira.person], { chatId, beforeSeq: 1_000, limit: 100 })).messages,
          [],
        );
      yield* say(mira.person, direct.chatId, "Invented-mira-returns");
      const fresh = yield* wake();
      assert.deepStrictEqual(
        (yield* chats.read(fresh, { chatId: direct.chatId, afterSeq: 0, limit: 100 })).map(
          (message) => message.body,
        ),
        ["Invented-mira-returns"],
      );
    }).pipe(Effect.provide(teamLayer)),
);
