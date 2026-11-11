import * as Deferred from "effect/Deferred";
import { assert, it } from "@effect/vitest";
import {
  AuthKinChatScope,
  AuthStandardClientScopes,
  AuthSessionId,
  KinOrgId,
  KinPersonId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { SessionStore } from "../../auth/SessionStore.ts";
import * as Repository from "../chat/KinChatRepository.ts";
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
const layer = People.layer.pipe(Layer.provideMerge(identities), Layer.provideMerge(database));
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
