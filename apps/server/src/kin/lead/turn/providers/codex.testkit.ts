import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import type * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CodexAdapterV2 from "../../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { AGENT_THREAD_ENV } from "../../../../preview/PortScanner.ts";
import type { ProviderFake } from "../conformance.testkit.ts";
import { codex, KIN_RARE_SERVER } from "./codex.ts";

type Handler = (payload: unknown) => Effect.Effect<unknown>;
type Config = Readonly<Record<string, unknown>>;

/** Codex's shell keeps a variable whose name matches one of these globs (`include_only`). */
const kept = (patterns: ReadonlyArray<string>, name: string) =>
  patterns.some((pattern) =>
    new RegExp(`^${pattern.replaceAll(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`).test(
      name,
    ),
  );

/**
 * One `codex app-server` that answers like the real one: a native id for each thread it starts
 * and the user's own MCP servers on `config/read`. T3's own handlers would show an ask to a person.
 */
/** Codex's bundled catalog, as far as these fakes go: 6.1 Sol and no later model. */
const CATALOG = ["gpt-6.1-sol"];

export const codexFake: ProviderFake = {
  driver: codex.driver,
  models: [...CATALOG, "gpt-unlisted-1"],
  open: ({ thread, cwd, model, environment }) =>
    Effect.gen(function* () {
      const sent: Array<{ readonly method: string; readonly params: Config }> = [];
      const handlers = new Map<string, Handler>();
      const answer = (method: string, params: Config) =>
        Effect.sync(() => {
          sent.push({ method, params });
          if (method === "config/read")
            return { config: { mcp_servers: { chrome: {}, "t3-code": {} } } };
          return method === "thread/start" ? { thread: { id: "native" } } : {};
        });
      const client = {
        raw: { request: answer },
        request: (method: string, params: Config) =>
          method === "model/list"
            ? Effect.succeed({ data: CATALOG.map((id) => ({ model: id })), nextCursor: null })
            : answer(method, params),
        handleServerRequest: (method: string, handler: Handler) =>
          Effect.sync(() => void handlers.set(method, handler)),
        handleServerNotification: () => Effect.void,
      } as unknown as CodexClient.CodexAppServerClient["Service"];
      const base = Layer.succeed(
        CodexAdapterV2.CodexAppServerClientFactory,
        CodexAdapterV2.CodexAppServerClientFactory.of({ open: () => Effect.succeed(client) }),
      );
      // What T3's adapter sends for a thread: its MCP servers and its id on the shell's env.
      const original = {
        model,
        cwd,
        config: {
          "mcp_servers.t3-code": { url: "http://127.0.0.1:3773/kin/mcp" },
          "mcp_servers.t3-code-direct": { url: "http://127.0.0.1:3773/kin/mcp" },
          [`shell_environment_policy.set.${AGENT_THREAD_ENV}`]: thread,
        },
      };
      const opened = yield* Effect.gen(function* () {
        const factory = yield* CodexAdapterV2.CodexAppServerClientFactory;
        const session = yield* factory.open({
          instanceId: ProviderInstanceId.make("codex"),
          threadId: ThreadId.make(thread),
          providerSessionId: ProviderSessionId.make("session"),
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd },
          settings: {} as never,
          environment,
        });
        for (const method of ["item/commandExecution/requestApproval", "execCommandApproval"])
          yield* session.handleServerRequest(
            method as never,
            (() => Effect.succeed("shown to a person")) as never,
          );
        yield* session.raw.request("thread/start", original);
        return session;
      }).pipe(Effect.provide(codex.install(base)), Effect.scoped, Effect.orDie);
      void opened;
      const started: Config =
        sent.find(({ method }) => method === "thread/start")?.params ?? original;
      const config = (started.config ?? {}) as Config;
      const server = (name: string) => config[`mcp_servers.${name}`] as Config | undefined;
      const rare = server(KIN_RARE_SERVER)?.enabled_tools;
      const hidden = server("t3-code")?.disabled_tools;
      const patterns = config["shell_environment_policy.include_only"];
      const shellPath = config["shell_environment_policy.set.PATH"];
      const agentName = config["shell_environment_policy.set.KIN_AGENT_NAME"];
      const handler = handlers.get("item/commandExecution/requestApproval");
      // Codex asks for every command, a read of the agent's own memory included.
      const ask = (command: string, commandActions: ReadonlyArray<unknown>) =>
        handler === undefined
          ? Effect.succeed("person" as const)
          : handler({
              threadId: "native",
              turnId: "turn-1",
              itemId: "item-1",
              command,
              commandActions,
            }).pipe(
              Effect.map((decided) => {
                if (decided === "shown to a person") return "person" as const;
                const steer = sent.findLast(({ method }) => method === "turn/steer");
                const text = (
                  steer?.params.input as ReadonlyArray<{ text?: string }> | undefined
                )?.[0]?.text;
                return (decided as { decision?: string }).decision === "accept"
                  ? ("allowed" as const)
                  : { refused: text };
              }),
              Effect.orDie,
            );
      return {
        // An untouched call goes out as the very object the adapter made.
        changed: started !== original,
        instructions:
          typeof started.baseInstructions === "string" ? started.baseInstructions : undefined,
        kinToolsUpFront: (server("t3-code")?.omit_tools_from as unknown) !== undefined,
        heldBack: Array.isArray(rare) ? (rare as ReadonlyArray<string>) : [],
        // Codex gives a model outside its catalog fallback metadata: no tool search.
        deferredFindable:
          CATALOG.includes(model) &&
          Array.isArray(rare) &&
          rare.length > 0 &&
          Array.isArray(hidden) &&
          rare.every((tool) => hidden.includes(tool)),
        personalConfig:
          config["mcp_servers.chrome.enabled"] !== false ||
          config["skills.include_instructions"] !== false,
        builtins: !(Array.isArray(started.environments) && started.environments.length === 0),
        webSearch: config["web_search"] !== "disabled",
        shell:
          typeof shellPath !== "string"
            ? undefined
            : {
                path: shellPath,
                agentName: typeof agentName === "string" ? agentName : undefined,
                variables: Array.isArray(patterns)
                  ? Object.keys(environment).filter((name) => kept(patterns as string[], name))
                  : Object.keys(environment),
              },
        askShell: ask("gh pr list", [{ type: "unknown", command: "gh pr list" }]),
        askRead: ask("cat notes.md", [
          { type: "read", command: "cat notes.md", name: "notes.md", path: "notes.md" },
        ]),
      };
    }),
};
