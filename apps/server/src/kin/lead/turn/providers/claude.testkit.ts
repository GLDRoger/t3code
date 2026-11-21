import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ClaudeAdapterV2 from "../../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { hookDecision } from "../../../claudeConfinement.testkit.ts";
import type { ProviderFake } from "../conformance.testkit.ts";
import { KIN_DEFERRED_TOOLS } from "../../deferredTools.ts";
import { claude } from "./claude.ts";

const Runner = ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;

/** Claude's session is one options object; the fake records what Kin hands the SDK. */
export const claudeFake: ProviderFake = {
  driver: claude.driver,
  // The second predates tool_reference blocks: Claude Code lists every tool for it itself.
  models: ["claude-opus-5-5", "claude-3-5-haiku"],
  open: ({ thread, cwd, model, environment }) =>
    Effect.gen(function* () {
      const original = ClaudeAdapterV2.makeClaudeQueryOptions({
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model,
        },
        nativeThreadId: "native",
        resume: false,
        cwd,
        attachmentsDir: "/attachments",
        environment,
        mcpServers: { "t3-code": { type: "http", url: "http://127.0.0.1:3773/kin/mcp" } },
      });
      const opened: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOptions> = [];
      const base = Layer.succeed(
        Runner,
        Runner.of({
          allocateSessionId: Effect.succeed("session"),
          open: (input) =>
            Effect.sync(() => opened.push(input.options)).pipe(
              Effect.andThen(Effect.die("no Claude process in the fake")),
            ),
          forkSession: () => Effect.die("unused"),
          subagentLaunchToolUseId: () => Effect.die("unused"),
          subagentModel: () => Effect.succeed(null),
          assertComplete: Effect.void,
        }),
      );
      yield* Effect.gen(function* () {
        yield* (yield* Runner)
          .open({
            threadId: ThreadId.make(thread),
            providerSessionId: ProviderSessionId.make("session"),
            options: original,
          })
          .pipe(Effect.exit);
      }).pipe(Effect.provide(claude.install(base)), Effect.orDie);
      const options = opened[0] ?? original;
      const settings = typeof options.settings === "object" ? options.settings : undefined;
      // A preset (or no list) is Claude Code's whole tool set, ToolSearch with it.
      const listed = Array.isArray(options.tools) ? options.tools : undefined;
      const searchable =
        options.env?.ENABLE_TOOL_SEARCH === "true" &&
        (listed === undefined || listed.includes("ToolSearch"));
      const servers = Object.values(options.mcpServers ?? {});
      const prompt = options.systemPrompt;
      return {
        changed: options !== original,
        instructions:
          typeof prompt === "object" && !Array.isArray(prompt) && prompt.type === "custom"
            ? String(prompt.prompt)
            : undefined,
        kinToolsUpFront:
          servers.length > 0 &&
          servers.every((server) => "alwaysLoad" in server && server.alwaysLoad === true),
        // Each rare tool carries `deferredMeta` (`deferredTools.ts`); Claude Code holds it back
        // only while ToolSearch is on, and turns that off itself for a model without it.
        heldBack: searchable ? [...KIN_DEFERRED_TOOLS] : [],
        deferredFindable: searchable,
        personalConfig: !(
          options.settingSources?.length === 0 &&
          options.strictMcpConfig === true &&
          settings?.autoMemoryEnabled === false
        ),
        builtins:
          listed === undefined ||
          listed.some((tool) => tool !== "ToolSearch" && tool !== "WebSearch"),
        webSearch: listed === undefined || listed.includes("WebSearch"),
        shell:
          options.env === undefined
            ? undefined
            : {
                path: options.env.PATH,
                agentName: options.env.KIN_AGENT_NAME,
                variables: Object.keys(environment).filter(
                  (name) => options.env?.[name] !== undefined,
                ),
              },
        askShell: Effect.promise(() => hookDecision(options, "Bash", { command: "gh pr list" })),
        askRead: Effect.promise(() => hookDecision(options, "Read", { file_path: "notes.md" })),
      };
    }),
};
