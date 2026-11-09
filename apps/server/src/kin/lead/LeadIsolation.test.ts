import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as DreamIsolation from "../dreaming/DreamIsolation.ts";
import * as LeadIsolation from "./LeadIsolation.ts";

const optionsAt = (cwd: string) =>
  ClaudeAdapterV2.makeClaudeQueryOptions({
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-6",
    },
    nativeThreadId: "native",
    resume: false,
    cwd,
    attachmentsDir: "/attachments",
    mcpServers: { kin: { type: "http", url: "http://127.0.0.1/kin" } },
  });

it.effect.each([
  [true, true],
  [true, false],
  [false, true],
])(
  "a Kin lead loads user settings only (KIN_ENABLED=%s, lead wrapper outside=%s)",
  ([enabled, leadOutside]) =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const opened: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOptions> = [];
      const base = Layer.succeed(
        ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
        ClaudeAdapterV2.ClaudeAgentSdkQueryRunner.of({
          allocateSessionId: Effect.succeed("session"),
          open: (input) =>
            Effect.sync(() => opened.push(input.options)).pipe(
              Effect.andThen(Effect.die("unused session")),
            ),
          forkSession: () => Effect.die("unused fork"),
          subagentLaunchToolUseId: () => Effect.die("unused lookup"),
          assertComplete: Effect.void,
        }),
      );
      const lead = optionsAt(`${stateDir}/kin/demo-a/memory-read`);
      const other = optionsAt("/work/project");
      const dream = optionsAt(`${stateDir}/kin/demo-a/dreams/fixture`);
      yield* Effect.gen(function* () {
        const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
        for (const [threadId, options] of [
          ["kin:lead", lead],
          ["thread-1", other],
          ["kin-dream:fixture:extract", dream],
        ] as const)
          yield* runner
            .open({
              threadId: ThreadId.make(threadId),
              providerSessionId: ProviderSessionId.make("session"),
              options,
            })
            .pipe(Effect.exit);
      }).pipe(
        Effect.provide(
          (leadOutside
            ? LeadIsolation.claudeQueryRunner(DreamIsolation.claudeQueryRunner(base))
            : DreamIsolation.claudeQueryRunner(LeadIsolation.claudeQueryRunner(base))
          ).pipe(
            Layer.provide(
              ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: enabled })),
            ),
          ),
        ),
      );
      const [leadOpened, otherOpened, dreamOpened] = opened;
      assert.strictEqual(otherOpened, other);
      assert.deepStrictEqual(dreamOpened?.settingSources, []);
      if (!enabled) {
        assert.strictEqual(leadOpened, lead);
        return;
      }
      assert.deepStrictEqual(leadOpened, { ...lead, settingSources: ["user"] });
      assert.isDefined(leadOpened?.mcpServers?.kin);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "kin-lead-isolation-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);
