import { assert, describe, it } from "@effect/vitest";
import {
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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Repository from "./KinChatRepository.ts";
import * as Identity from "./KinIdentity.ts";

const database = Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory);
const repositoryLayer = Layer.provideMerge(Repository.layer, database);
const config = { orgName: "Example", ownerHandle: "owner", ownerDisplayName: "Example Owner" };
const identityLayer = Identity.KinIdentity.layer.pipe(
  Layer.provide(Layer.succeed(Identity.KinIdentityConfig, config)),
);
const start = Identity.KinIdentity.pipe(Effect.provide(identityLayer));
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
const caller = (thread = threadId, subagent = false): McpInvocationScope => ({
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
const seedAgent = Effect.fn("test.seedAgent")(function* () {
  const identity = yield* start;
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
  it.effect(
    "bootstraps once under concurrent starts and preserves configured identity on restart",
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
        const { identity, repository, owner } = yield* seedAgent();
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
        assert.deepStrictEqual(yield* identity.resolveAgent(caller()), {
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
        const restarted = yield* start;
        assert.isTrue(restarted.isAgentThread(threadId));
        assert.deepStrictEqual(
          yield* restarted.resolveAgent(caller()),
          yield* identity.resolveAgent(caller()),
        );
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
        const afterEnd = yield* start;
        assert.isFalse(afterEnd.isAgentThread(threadId));
        assert.isTrue(afterEnd.isAgentThread(secondThreadId));
        assert.deepStrictEqual(yield* afterEnd.resolveAgent(caller(secondThreadId)), {
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
      assert.include(yield* Effect.flip(start), { _tag: "KinChatError", reason: "not_found" });
      assert.lengthOf(yield* repository.listAllOrgs(), 1);
      assert.deepStrictEqual(yield* repository.listPeople({ orgId }), []);
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
