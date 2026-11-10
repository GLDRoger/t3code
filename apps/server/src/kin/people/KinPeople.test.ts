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
