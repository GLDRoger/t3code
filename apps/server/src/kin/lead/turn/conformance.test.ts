import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  KIN_CAPABILITIES,
  KIN_CAPABILITY_WORDS,
  KinAgentId,
  KinOrgId,
  kinProviderFacts,
  type KinProviderLimit,
  type ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../../config.ts";
import { kinSecretVariables } from "../../claudeConfinement.testkit.ts";
import { KinServer, type Services as KinServices } from "../../KinServer.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as KinPersistence from "../../persistence/KinPersistence.ts";
import { fullSessionRefusal } from "../AgentSession.ts";
import { SESSION_REFUSAL } from "../Audience.ts";
import { approvedWakeup, ownerOnlyWakeup } from "../Audience.testkit.ts";
import { KinAgentSessionPolicy } from "../sessionPolicy.ts";
import type { Answer, ProviderFake } from "./conformance.testkit.ts";
import { KIN_PROVIDERS } from "./providers.ts";
import { acpFake } from "./providers/acp.testkit.ts";
import { claudeFake } from "./providers/claude.testkit.ts";
import { codexFake } from "./providers/codex.testkit.ts";
import { CONFINED_WEB_SEARCH, kinInstructions } from "./session.ts";

/** Every registered provider has a fake; a provider without one fails here, not in production. */
const FAKES: ReadonlyArray<ProviderFake> = [claudeFake, codexFake, acpFake];

const AGENT = "Tech lead";
const PINNED = "/kin-home/kin-tools/gh-pinned";
const host = {
  PATH: "/usr/bin",
  HOME: "/home/kin",
  ...Object.fromEntries(kinSecretVariables.map((name) => [name, "secret"])),
};

/** Kin's policy as `AgentSession` builds it, with the turn's state set by each case. */
const kin = (
  refusal: (thread: ThreadId) => string | undefined,
  policy?: (thread: ThreadId) => Effect.Effect<string | undefined>,
) =>
  Layer.succeed(KinServer, {
    taskCardUpdater: Layer.empty,
    services: Option.some(
      Context.make(
        KinAgentSessionPolicy,
        KinAgentSessionPolicy.of({
          refusal: (thread) => policy?.(thread) ?? Effect.sync(() => refusal(thread)),
          webSearch: (thread) => Effect.sync(() => refusal(thread)),
          delegated: (thread) => Effect.succeed(thread === "task-from-lead"),
          toolDirectories: [PINNED],
          agentName: () => Effect.succeed(AGENT),
        }),
      ) as Context.Context<KinServices>,
    ),
    subscribeForViewer: Option.none(),
  });

const open = (
  fake: ProviderFake,
  thread: string,
  options: {
    readonly cwd?: (stateDir: string) => string;
    readonly refusal?: (thread: ThreadId) => string | undefined;
    /** Kin's own check, run on a database, in place of `refusal`. */
    readonly policy?: (thread: ThreadId) => Effect.Effect<string | undefined>;
    readonly enabled?: boolean;
    readonly model?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const cwd = options.cwd?.(stateDir) ?? `${stateDir}/kin/demo-a/memory-read`;
    return yield* fake.open({
      thread,
      cwd,
      model: options.model ?? fake.models[0] ?? "",
      environment: host,
    });
  }).pipe(
    Effect.provide(
      Layer.merge(
        kin(options.refusal ?? (() => undefined), options.policy),
        ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: options.enabled ?? true })),
      ),
    ),
  );

const signed = (stateDir: string) => `${stateDir}/kin/gh-sign:${PINNED}:/usr/bin`;
const asked = (answer: Effect.Effect<Answer>) => answer;
const layer = (prefix: string) =>
  ServerConfig.layerTest(process.cwd(), { prefix }).pipe(Layer.provideMerge(NodeServices.layer));

it("every registered provider has a conformance fake and its lacks match its descriptor", () => {
  assert.deepStrictEqual(
    FAKES.map((fake) => fake.driver),
    KIN_PROVIDERS.map((provider) => provider.driver),
  );
  for (const provider of KIN_PROVIDERS) {
    const facts = kinProviderFacts(provider.driver);
    assert.deepStrictEqual(
      facts?.lacks,
      KIN_CAPABILITIES.filter((capability) => !(capability in provider.capabilities)),
      provider.driver,
    );
    // A provider Kin can't hold to its rules never reaches a real owner.
    if ((facts?.limits.length ?? 0) > 0) assert.isTrue(facts?.devOnly, provider.driver);
  }
});

const limited = (driver: string, limit: KinProviderLimit) =>
  kinProviderFacts(driver)?.limits.includes(limit) ?? false;

describe.each(FAKES.map((fake) => [fake.driver, fake] as const))("Kin on %s", (driver, fake) => {
  it.effect(
    "the owner's chat: Kin's instructions, Kin's tools up front and the rare ones findable, none of the user's own config, the provider's built-ins, each shell step checked, and a shell that signs as the agent and carries no Kin secret",
    () =>
      Effect.gen(function* () {
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const owner = yield* open(fake, "kin:tech");
        assert.isTrue(owner.changed);
        assert.strictEqual(owner.instructions, kinInstructions("owner", driver));
        assert.include(owner.instructions, "GitHub repos needs no card");
        for (const capability of kinProviderFacts(driver)?.lacks ?? [])
          assert.include(owner.instructions, KIN_CAPABILITY_WORDS[capability]);
        assert.isTrue(owner.kinToolsUpFront);
        assert.isTrue(owner.deferredFindable);
        assert.strictEqual(owner.personalConfig, limited(driver, "ownConfigLoads"));
        assert.isTrue(owner.builtins);
        assert.strictEqual(owner.shell?.path, signed(stateDir));
        assert.strictEqual(owner.shell?.agentName, AGENT);
        // The GitHub App's key and Kin's other secrets never reach a shell.
        assert.strictEqual(
          owner.shell?.variables.filter((name) => kinSecretVariables.includes(name)).length === 0,
          !limited(driver, "hostEnvironment"),
        );
        assert.strictEqual(yield* asked(owner.askShell), "allowed");
        assert.strictEqual(yield* asked(owner.askRead), "allowed");
      }).pipe(Effect.provide(layer(`kin-conformance-owner-${driver}-`))),
  );

  it.effect(
    "the owner's chat once the turn read outside content, or someone joined: a shell step, and a read of its own memory, is refused with the line saying why",
    () =>
      Effect.gen(function* () {
        for (const why of [SESSION_REFUSAL.outside, SESSION_REFUSAL.aborted]) {
          const owner = yield* open(fake, "kin:tech", { refusal: () => why });
          assert.deepStrictEqual(yield* asked(owner.askShell), { refused: why });
          assert.deepStrictEqual(yield* asked(owner.askRead), { refused: why });
        }
      }).pipe(Effect.provide(layer(`kin-conformance-refused-${driver}-`))),
  );

  it.effect(
    "the owner's chat on the turn his Approve of a teammate's draft queued: Kin's own check refuses a shell step, and a read of its memory, with the line saying why",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const orgId = KinOrgId.make("org-approved");
        const agentId = KinAgentId.make("tech");
        const wakeupId = "wake-approved";
        yield* ownerOnlyWakeup({ orgId, agentId, wakeupId });
        yield* sql`UPDATE kin_wakeups SET status = 'running', thread_id = 'kin:tech',
          audience = 'owner_only' WHERE wakeup_id = ${wakeupId}`;
        const policy = (thread: ThreadId) =>
          fullSessionRefusal(thread).pipe(Effect.provideService(SqlClient.SqlClient, sql));
        // The same agent's ordinary owner-only turn has its shell.
        const plain = yield* open(fake, "kin:tech", { policy });
        assert.strictEqual(yield* asked(plain.askShell), "allowed");
        yield* approvedWakeup({ orgId, agentId, wakeupId });
        const approved = yield* open(fake, "kin:tech", { policy });
        assert.deepStrictEqual(yield* asked(approved.askShell), {
          refused: SESSION_REFUSAL.approved,
        });
        assert.deepStrictEqual(yield* asked(approved.askRead), {
          refused: SESSION_REFUSAL.approved,
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layer(`kin-conformance-approved-${driver}-`),
            KinPersistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)),
          ),
        ),
      ),
  );

  it.effect(
    "a teammate's or group chat: Kin's tools only, no shell or files, web search only where the provider runs it, none of the user's own config, and any ask refused",
    () =>
      Effect.gen(function* () {
        const shared = yield* open(fake, "kin-shared:tech", {
          refusal: () => SESSION_REFUSAL.shared,
        });
        assert.isTrue(shared.changed);
        assert.strictEqual(shared.instructions, kinInstructions("confined", driver));
        assert.isTrue(shared.kinToolsUpFront);
        assert.isTrue(shared.deferredFindable);
        assert.strictEqual(shared.personalConfig, limited(driver, "ownConfigLoads"));
        assert.isFalse(shared.builtins);
        assert.strictEqual(shared.webSearch, CONFINED_WEB_SEARCH.has(driver));
        assert.notStrictEqual(yield* asked(shared.askShell), "allowed");
        assert.notStrictEqual(yield* asked(shared.askRead), "allowed");
        // Even were Kin's policy to admit it, a chat others read never gets a shell.
        const admitted = yield* open(fake, "kin-shared:tech");
        assert.isFalse(admitted.builtins);
        assert.notStrictEqual(yield* asked(admitted.askShell), "allowed");
        assert.notStrictEqual(yield* asked(admitted.askRead), "allowed");
      }).pipe(Effect.provide(layer(`kin-conformance-shared-${driver}-`))),
  );

  it.effect(
    "a task a lead delegated: the provider's own instructions, a shell that signs as the agent with no Kin secret, and each shell step checked against the turn that asked",
    () =>
      Effect.gen(function* () {
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const scratch = () => `${stateDir}/scratch`;
        const task = yield* open(fake, "task-from-lead", { cwd: scratch });
        assert.isTrue(task.changed);
        assert.isUndefined(task.instructions);
        assert.strictEqual(task.shell?.path, signed(stateDir));
        assert.strictEqual(task.shell?.agentName, AGENT);
        assert.strictEqual(
          task.shell?.variables.filter((name) => kinSecretVariables.includes(name)).length === 0,
          !limited(driver, "hostEnvironment"),
        );
        assert.strictEqual(yield* asked(task.askShell), "allowed");
        const refused = yield* open(fake, "task-from-lead", {
          cwd: scratch,
          refusal: () => SESSION_REFUSAL.outside,
        });
        assert.deepStrictEqual(yield* asked(refused.askShell), {
          refused: SESSION_REFUSAL.outside,
        });
        assert.deepStrictEqual(yield* asked(refused.askRead), {
          refused: SESSION_REFUSAL.outside,
        });
      }).pipe(Effect.provide(layer(`kin-conformance-delegated-${driver}-`))),
  );

  it.effect(
    "on every model the provider runs, one its catalog lacks included, no Kin tool a chat allows is out of reach: a rare one waits only where the model can look it up",
    () =>
      Effect.gen(function* () {
        for (const model of fake.models)
          for (const thread of ["kin:tech", "kin-shared:tech"]) {
            const session = yield* open(fake, thread, { model });
            assert.isTrue(session.kinToolsUpFront, `${model} ${thread}`);
            assert.isTrue(
              session.heldBack.length === 0 || session.deferredFindable,
              `${model} ${thread} holds back ${session.heldBack.join(", ")}`,
            );
          }
      }).pipe(Effect.provide(layer(`kin-conformance-lookup-${driver}-`))),
  );

  it.effect("any other thread, and every thread with Kin off, is left as T3 made it", () =>
    Effect.gen(function* () {
      assert.isFalse((yield* open(fake, "thread-1", { cwd: () => "/work/project" })).changed);
      assert.isFalse((yield* open(fake, "kin:tech", { enabled: false })).changed);
    }).pipe(Effect.provide(layer(`kin-conformance-other-${driver}-`))),
  );
});
