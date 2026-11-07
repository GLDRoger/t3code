import { assert, describe, it } from "@effect/vitest";
import {
  KinChatError,
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
  KinAgentId,
  KinOrgId,
  KinPersonId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import type { McpThreadInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Repository from "./KinChatRepository.ts";
import * as Identity from "./KinIdentity.ts";
import { startWakeupRun, authorityLayer } from "./WakeupAuthority.testkit.ts";

const database = authorityLayer;
const repositoryLayer = Layer.provideMerge(Repository.layer, database);
const config = { orgName: "Example", ownerHandle: "owner", ownerDisplayName: "Example Owner" };
const identityLayer = Identity.KinIdentity.layer.pipe(
  Layer.provide(Layer.succeed(Identity.KinIdentityConfig, config)),
);
const start = Identity.KinIdentity.pipe(Effect.provide(identityLayer));
const startInScope = Effect.fn("test.startInScope")(function* (scope: Scope.Scope) {
  const context = yield* Layer.buildWithScope(identityLayer, scope);
  return Context.get(context, Identity.KinIdentity);
});
const decodeThreadId = Schema.decodeSync(ThreadId);
const decodeOrgId = Schema.decodeSync(KinOrgId);
const decodePersonId = Schema.decodeSync(KinPersonId);
const decodeAgentId = Schema.decodeSync(KinAgentId);
const threadId = Schema.decodeSync(ThreadId)("lead-thread");
const agentId = Schema.decodeSync(KinAgentId)("lead");
const session: AuthenticatedSession = {
  sessionId: Schema.decodeSync(AuthSessionId)("owner-session"),
  subject: "browser",
  method: "browser-session-cookie",
  scopes: AuthStandardClientScopes,
};
const environmentId = Schema.decodeSync(EnvironmentId)("test-environment");
const providerInstanceId = Schema.decodeSync(ProviderInstanceId)("provider");
const caller = (thread = threadId, subagent = false): McpThreadInvocationScope => ({
  environmentId,
  capabilities: new Set(),
  issuedAt: 0,
  requestNamespace: "test",
  client: undefined,
  thread: {
    threadId: thread,
    providerSessionId: "provider-session",
    providerInstanceId,
    subagent,
  },
});
const seedAgent = Effect.fn("test.seedAgent")(function* (scope?: Scope.Scope) {
  const identity = yield* scope === undefined ? start : startInScope(scope);
  const [owner] = yield* identity.resolve(session);
  assert.isDefined(owner);
  const repository = yield* Repository.KinChatRepository;
  yield* repository.insertAgent({
    ...owner,
    agentId,
    ownerPersonId: owner.personId,
    displayName: "Lead",
    role: "lead",
    createdAt: "1970-01-01T00:00:00.000Z",
  });
  return { identity, repository, owner };
});

describe("KinIdentity", () => {
  it.effect("keeps callers waiting for the registry lock interruptible", () =>
    Effect.gen(function* () {
      const repository = yield* Repository.KinChatRepository;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const waiting = yield* Deferred.make<void>();
      const { identity, owner } = yield* seedAgent().pipe(
        Effect.provideService(Repository.KinChatRepository, {
          ...repository,
          registerAgentThread: Effect.fn("test.registerAgentThread")(function* (input) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return yield* repository.registerAgentThread(input);
          }),
        }),
      );
      const input = { orgId: owner.orgId, agentId, threadId };
      const registering = yield* identity.registerAgentThread(input).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const ending = yield* Effect.gen(function* () {
        yield* Deferred.succeed(waiting, undefined);
        return yield* identity.endAgentThread(input);
      }).pipe(Effect.forkChild);
      yield* Deferred.await(waiting);
      yield* Fiber.interrupt(ending);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(registering);
      assert.isTrue(identity.isAgentThread(threadId));
      assert.strictEqual(
        Option.getOrThrow(yield* repository.findAgentThread(threadId)).endedAt,
        null,
      );
    }).pipe(Effect.provide(repositoryLayer)),
  );

  it.effect(
    "keeps registration visible when an earlier resolution finishes after registration",
    () =>
      Effect.gen(function* () {
        const repository = yield* Repository.KinChatRepository;
        const read = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const { identity, owner } = yield* seedAgent().pipe(
          Effect.provideService(Repository.KinChatRepository, {
            ...repository,
            findAgentThread: Effect.fn("test.findAgentThread")(function* (id) {
              const result = yield* repository.findAgentThread(id);
              yield* Deferred.succeed(read, undefined);
              yield* Deferred.await(release);
              return result;
            }),
          }),
        );
        const resolving = yield* identity
          .resolveAgent(caller())
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(read);
        yield* identity.registerAgentThread({ orgId: owner.orgId, agentId, threadId });
        yield* Deferred.succeed(release, undefined);
        assert.include(yield* Fiber.join(resolving), { reason: "not_allowed" });
        assert.isTrue(identity.isAgentThread(threadId));
        assert.isTrue(Option.isSome(yield* repository.findAgentThread(threadId)));
      }).pipe(Effect.provide(repositoryLayer)),
  );

  it.effect("publishes registry changes only after the outer transaction commits", () =>
    Effect.gen(function* () {
      const { identity, repository, owner } = yield* seedAgent();
      const sql = yield* SqlClient.SqlClient;
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* identity.registerAgentThread({ orgId: owner.orgId, agentId, threadId });
            return yield* Effect.fail("rollback");
          }),
        )
        .pipe(Effect.flip);
      assert.isFalse(identity.isAgentThread(threadId));
      assert.isTrue(Option.isNone(yield* repository.findAgentThread(threadId)));
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* identity.registerAgentThread({ orgId: owner.orgId, agentId, threadId });
          assert.isFalse(identity.isAgentThread(threadId));
        }),
      );
      assert.isTrue(identity.isAgentThread(threadId));
      assert.isTrue(Option.isSome(yield* repository.findAgentThread(threadId)));
      const input = { orgId: owner.orgId, threadId };
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* identity.endAgentThread(input);
            return yield* Effect.fail("rollback");
          }),
        )
        .pipe(Effect.flip);
      assert.isTrue(identity.isAgentThread(threadId));
      assert.strictEqual(
        Option.getOrThrow(yield* repository.findAgentThread(threadId)).endedAt,
        null,
      );
      const otherThreadId = decodeThreadId("kin-identity-other-thread");
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* identity.registerAgentThread({
            orgId: owner.orgId,
            agentId,
            threadId: otherThreadId,
          });
          yield* identity.endAgentThread({ orgId: owner.orgId, threadId: otherThreadId });
        }),
      );
      assert.isFalse(identity.isAgentThread(otherThreadId));
    }).pipe(Effect.provide(repositoryLayer)),
  );

  it.effect("restores visibility when ending fails and rejects retired agents", () =>
    Effect.gen(function* () {
      const repository = yield* Repository.KinChatRepository;
      const { identity, owner } = yield* seedAgent().pipe(
        Effect.provideService(Repository.KinChatRepository, {
          ...repository,
          endAgentThread: () =>
            Effect.fail(
              new KinChatError({
                reason: "not_allowed",
                message: "Injected end failure.",
              }),
            ),
        }),
      );
      const input = { orgId: owner.orgId, agentId, threadId };
      yield* identity.registerAgentThread(input);
      yield* identity.endAgentThread(input).pipe(Effect.flip);
      assert.isTrue(identity.isAgentThread(threadId));
      assert.strictEqual(
        Option.getOrThrow(yield* repository.findAgentThread(threadId)).endedAt,
        null,
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_agents SET retired_at = '1970-01-01T00:00:01.000Z'
        WHERE org_id = ${owner.orgId} AND agent_id = ${agentId}`;
      assert.include(yield* identity.resolveAgent(caller()).pipe(Effect.flip), {
        reason: "not_allowed",
      });
      for (const id of [threadId, decodeThreadId("retired-thread")]) {
        assert.include(
          yield* identity.registerAgentThread({ ...input, threadId: id }).pipe(Effect.flip),
          { reason: "not_allowed" },
        );
      }
      assert.isTrue(
        Option.isNone(yield* repository.findAgentThread(decodeThreadId("retired-thread"))),
      );
    }).pipe(Effect.provide(repositoryLayer)),
  );

  it.effect(
    "serializes bootstrap writers with WHERE NOT EXISTS and ON CONFLICT guards and preserves stored config",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_000);
        const [first, second] = yield* Effect.all([start, start], { concurrency: "unbounded" });
        const repository = yield* Repository.KinChatRepository;
        const orgs = yield* repository.listAllOrgs();
        assert.lengthOf(orgs, 1);
        assert.strictEqual(orgs[0]?.name, config.orgName);
        assert.strictEqual(orgs[0]?.createdAt, "1970-01-01T00:00:01.000Z");
        const [owner] = yield* first.resolve(session);
        assert.isDefined(owner);
        const people = yield* repository.listPeople(owner);
        assert.lengthOf(people, 1);
        assert.strictEqual(people[0]?.displayName, config.ownerDisplayName);
        assert.strictEqual(people[0]?.handle, config.ownerHandle);
        assert.deepStrictEqual(yield* second.resolve(session), [owner]);
        yield* TestClock.setTime(2_000);
        const restarted = yield* Identity.KinIdentity.pipe(
          Effect.provide(Identity.KinIdentity.layer),
          Effect.provideService(Identity.KinIdentityConfig, {
            orgName: "Changed",
            ownerHandle: "changed",
            ownerDisplayName: "Changed",
          }),
        );
        assert.deepStrictEqual(yield* restarted.resolve(session), [owner]);
        assert.deepStrictEqual(yield* repository.listAllOrgs(), orgs);
        assert.deepStrictEqual(yield* repository.listPeople(owner), people);
        for (const missing of AuthStandardClientScopes) {
          assert.deepStrictEqual(
            yield* restarted.resolve({
              ...session,
              scopes: AuthStandardClientScopes.filter((scope) => scope !== missing),
            }),
            [],
          );
        }
        assert.deepStrictEqual(yield* restarted.resolve({ ...session, scopes: [] }), []);
      }).pipe(Effect.provide(repositoryLayer)),
  );

  it.effect(
    "registers, restores and ends agent threads without allowing identity changes or foreign orgs",
    () =>
      Effect.gen(function* () {
        const firstScope = yield* Scope.make();
        const { identity, repository, owner } = yield* seedAgent(firstScope);
        const input = { orgId: owner.orgId, agentId, threadId };
        assert.isFalse(identity.isAgentThread(threadId));
        for (const scope of [
          caller(),
          caller(threadId, true),
          { ...caller(), thread: undefined },
        ]) {
          assert.include(yield* Effect.flip(identity.resolveAgent(scope)), {
            _tag: "KinChatError",
            reason: "not_allowed",
          });
        }
        yield* identity.registerAgentThread(input);
        const original = yield* repository.getAgentThread(input);
        yield* TestClock.setTime(1_000);
        yield* identity.registerAgentThread(input);
        assert.deepStrictEqual(yield* repository.getAgentThread(input), original);
        assert.isTrue(identity.isAgentThread(threadId));
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at) VALUES ('identity-chat', ${owner.orgId}, 'team_group', 0, '1970-01-01T00:00:00.000Z')`;
        yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
          VALUES (${agentId}, ${owner.orgId}, 'Lead', 0, '{}', '[]', 'identity-chat')`;
        yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at, status, event_ids)
          VALUES ('identity-wakeup', ${owner.orgId}, ${agentId}, ${threadId}, 'test', 0, 'running', '[]')`;
        assert.isFalse(yield* Effect.isSuccess(identity.resolveAgent(caller())));
        yield* startWakeupRun(threadId, "identity-wakeup");
        assert.isTrue(yield* Effect.isSuccess(identity.resolveAgent(caller())));
        assert.isFalse(
          yield* Effect.isSuccess(identity.resolveAgent(caller(decodeThreadId("other-thread")))),
        );
        assert.deepStrictEqual(yield* identity.resolveAgent(caller()), {
          _tag: "agent",
          caller: caller().thread,
          ...input,
          ownerPersonId: owner.personId,
        });
        assert.include(yield* Effect.flip(identity.resolveAgent(caller(threadId, true))), {
          _tag: "KinChatError",
          reason: "not_allowed",
        });

        const replacementAgentId = decodeAgentId("replacement");
        yield* repository.insertAgent({
          orgId: owner.orgId,
          agentId: replacementAgentId,
          ownerPersonId: owner.personId,
          displayName: "Replacement",
          role: "lead",
          createdAt: "1970-01-01T00:00:00.000Z",
        });
        assert.include(
          yield* Effect.flip(
            identity.registerAgentThread({
              ...input,
              agentId: replacementAgentId,
            }),
          ),
          { _tag: "KinChatError", reason: "not_allowed" },
        );
        const secondThreadId = decodeThreadId("second-thread");
        yield* identity.registerAgentThread({ ...input, threadId: secondThreadId });
        assert.isFalse(yield* Effect.isSuccess(identity.resolveAgent(caller(secondThreadId))));
        const otherOrgId = decodeOrgId("other-org");
        const otherPersonId = decodePersonId("other-owner");
        const otherAgentId = decodeAgentId("other-agent");
        yield* repository.insertOrg({
          orgId: otherOrgId,
          name: "Other",
          createdAt: "1970-01-01T00:00:00.000Z",
        });
        yield* repository.insertPerson({
          orgId: otherOrgId,
          personId: otherPersonId,
          handle: "owner",
          displayName: "Other Owner",
          githubLogin: null,
          createdAt: "1970-01-01T00:00:00.000Z",
        });
        yield* repository.insertAgent({
          orgId: otherOrgId,
          agentId: otherAgentId,
          ownerPersonId: otherPersonId,
          displayName: "Other Lead",
          role: "lead",
          createdAt: "1970-01-01T00:00:00.000Z",
        });
        for (const invalid of [
          { ...input, orgId: otherOrgId },
          { ...input, agentId: otherAgentId },
          { ...input, orgId: otherOrgId, agentId: otherAgentId },
        ]) {
          assert.include(yield* Effect.flip(identity.registerAgentThread(invalid)), {
            _tag: "KinChatError",
            reason: "not_found",
          });
        }
        assert.include(
          yield* Effect.flip(identity.endAgentThread({ orgId: otherOrgId, threadId })),
          { _tag: "KinChatError", reason: "not_found" },
        );
        assert.isTrue(identity.isAgentThread(threadId));
        yield* Scope.close(firstScope, Exit.void);
        const secondScope = yield* Scope.make();
        const restarted = yield* startInScope(secondScope);
        assert.isTrue(restarted.isAgentThread(threadId));
        assert.deepStrictEqual(yield* restarted.resolveAgent(caller()), {
          _tag: "agent",
          caller: caller().thread,
          ...input,
          ownerPersonId: owner.personId,
        });
        yield* sql`UPDATE kin_wakeups SET status = 'completed', ended_at = 1000 WHERE wakeup_id = 'identity-wakeup'`;
        assert.include(yield* restarted.resolveAgent(caller()).pipe(Effect.flip), {
          reason: "not_allowed",
        });
        assert.isTrue(restarted.isAgentThread(threadId));
        assert.deepStrictEqual(yield* restarted.resolve(session), [owner]);
        assert.isTrue(yield* restarted.endAgentThread(input));
        assert.isFalse(restarted.isAgentThread(threadId));
        assert.isFalse(yield* restarted.endAgentThread(input));
        assert.include(yield* Effect.flip(restarted.resolveAgent(caller())), {
          _tag: "KinChatError",
          reason: "not_allowed",
        });
        assert.include(yield* Effect.flip(restarted.registerAgentThread(input)), {
          _tag: "KinChatError",
          reason: "not_allowed",
        });
        const ended = yield* repository.getAgentThread(input);
        assert.isTrue(Option.isSome(ended));
        if (Option.isSome(ended))
          assert.strictEqual(ended.value.endedAt, "1970-01-01T00:00:01.000Z");
        yield* Scope.close(secondScope, Exit.void);
        const afterEnd = yield* start;
        assert.isFalse(afterEnd.isAgentThread(threadId));
        assert.isTrue(afterEnd.isAgentThread(secondThreadId));
        yield* startWakeupRun(secondThreadId, "identity-wakeup");
        yield* sql`UPDATE kin_wakeups SET status = 'running', ended_at = NULL, thread_id = ${secondThreadId} WHERE wakeup_id = 'identity-wakeup'`;
        assert.deepStrictEqual(yield* afterEnd.resolveAgent(caller(secondThreadId)), {
          _tag: "agent",
          caller: caller(secondThreadId).thread,
          ...input,
          threadId: secondThreadId,
          ownerPersonId: owner.personId,
        });
      }).pipe(Effect.provide(repositoryLayer)),
  );

  it.effect("fails closed rather than assigning an existing organization's person as owner", () =>
    Effect.gen(function* () {
      const repository = yield* Repository.KinChatRepository;
      const failedBootstrap = yield* Effect.flip(
        Identity.KinIdentity.pipe(
          Effect.provide(Identity.KinIdentity.layer),
          Effect.provideService(Identity.KinIdentityConfig, { ...config, ownerDisplayName: " " }),
        ),
      );
      assert.strictEqual(failedBootstrap._tag, "PersistenceDecodeError");
      assert.deepStrictEqual(yield* repository.listAllOrgs(), []);
      const orgId = decodeOrgId("existing");
      yield* repository.insertOrg({
        orgId,
        name: "Existing",
        createdAt: "1970-01-01T00:00:00.000Z",
      });
      const unknown = yield* Effect.flip(start);
      assert.strictEqual(unknown._tag, "KinIdentityBootstrapError");
      assert.include(unknown.message, "unknown org");
      assert.include(unknown.message, "recreate the Kin tables");
      assert.lengthOf(yield* repository.listAllOrgs(), 1);
      assert.deepStrictEqual(yield* repository.listPeople({ orgId }), []);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM kin_orgs WHERE org_id = ${orgId}`;
      yield* repository.insertOrg({
        orgId: decodeOrgId("kin-default"),
        name: "Kin",
        createdAt: "1970-01-01T00:00:00.000Z",
      });
      const missingOwner = yield* Effect.flip(start);
      assert.strictEqual(missingOwner._tag, "KinIdentityBootstrapError");
      assert.include(missingOwner.message, "exists without owner person `kin-default-owner`");
      assert.include(missingOwner.message, "restore it or recreate the Kin tables");
    }).pipe(Effect.provide(repositoryLayer)),
  );

  it.effect("loads bootstrap defaults and configured names without personal data", () =>
    Effect.gen(function* () {
      for (const [env, expected] of [
        [{}, { orgName: "Kin", ownerHandle: "owner", ownerDisplayName: "Owner" }],
        [
          {
            KIN_ORG_NAME: "Example",
            KIN_OWNER_HANDLE: "example-owner",
            KIN_OWNER_DISPLAY_NAME: "Example Owner",
          },
          { orgName: "Example", ownerHandle: "example-owner", ownerDisplayName: "Example Owner" },
        ],
      ] as const) {
        const loaded = yield* Identity.KinIdentityConfig.pipe(
          Effect.provide(
            Identity.KinIdentityConfig.layer.pipe(
              Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
            ),
          ),
        );
        assert.deepStrictEqual(loaded, expected);
      }
    }),
  );
});
