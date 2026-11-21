import type {
  AcpAdapterV2RuntimeInput,
  AcpMakeRuntime,
} from "@t3tools/provider-acp/server/adapter";
import { AcpSessionShaper } from "@t3tools/provider-acp/server/adapter";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { AgentScopeThreadId } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as AcpErrors from "effect-acp/errors";
import * as SecureRandom from "effect/crypto/SecureRandom";

import type { Answer, ProviderFake } from "../conformance.testkit.ts";
import { acp } from "./acp.ts";

type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];
type Handler = (request: unknown, context: unknown) => Effect.Effect<unknown, AcpErrors.AcpError>;

const T3_PREAMBLE =
  "<t3_code_orchestration_instructions>T3's guidance</t3_code_orchestration_instructions>";

/**
 * An ACP agent process as T3 starts it: the fake records the input Kin hands it, the prompt it is
 * sent, and the handlers registered for its asks and for T3's own file and terminal service.
 */
export const acpFake: ProviderFake = {
  driver: acp.driver,
  // The agent picks its own model; Kin names none.
  models: ["agent-default"],
  open: ({ thread, cwd, environment }) =>
    Effect.gen(function* () {
      const original = {
        cwd,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      } as unknown as AcpAdapterV2RuntimeInput;
      let given = original;
      const prompts: Array<string> = [];
      const handlers = new Map<string, Handler>();
      const register = (name: string) => (handler: Handler) =>
        Effect.sync(() => void handlers.set(name, handler));
      const base = {
        prompt: (payload: { readonly prompt: ReadonlyArray<{ type: string; text?: string }> }) =>
          Effect.sync(() => {
            prompts.push(payload.prompt.map((block) => block.text ?? "").join(""));
            return { stopReason: "end_turn" };
          }),
        handleRequestPermission: register("permission"),
        handleReadTextFile: register("read"),
        handleWriteTextFile: register("write"),
        handleCreateTerminal: register("terminal"),
      } as unknown as Runtime;
      const make: AcpMakeRuntime = (input) =>
        Effect.sync(() => {
          given = input;
          return base;
        });
      const runtime = yield* Effect.gen(function* () {
        const shape = yield* AcpSessionShaper;
        return yield* shape(make)(original).pipe(Effect.provideService(AgentScopeThreadId, thread));
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            acp.install(Layer.empty),
            Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({}),
            Layer.mock(SecureRandom.SecureRandom)({}),
          ),
        ),
        Effect.provideService(HostProcess.Environment, environment),
        Effect.scoped,
        Effect.orDie,
      );
      // T3 registers its own handlers on the runtime it gets: they would run the call.
      const served = (request: unknown) => Effect.succeed(request);
      yield* runtime.handleRequestPermission(served as never);
      yield* runtime.handleReadTextFile(served as never);
      yield* runtime.handleCreateTerminal(served as never);
      yield* runtime
        .prompt({
          prompt: [{ type: "text", text: `${T3_PREAMBLE}\n\n<user_request>\nhi\n</user_request>` }],
        })
        .pipe(Effect.orDie);
      const sent = prompts[0] ?? "";
      const preamble = sent.slice(0, Math.max(0, sent.indexOf("\n\n<user_request>")));
      const served$ = (name: string, request: unknown): Effect.Effect<Answer> => {
        const handler = handlers.get(name);
        return handler === undefined
          ? Effect.succeed("person" as const)
          : handler(request, {}).pipe(
              Effect.as("allowed" as const),
              Effect.catch((error) =>
                Effect.succeed({ refused: (error as { errorMessage?: string }).errorMessage }),
              ),
            );
      };
      const capabilities = given.clientCapabilities as {
        readonly fs?: { readonly readTextFile?: boolean; readonly writeTextFile?: boolean };
        readonly terminal?: boolean;
      };
      const env = given.processEnvironment;
      return {
        changed: given !== original || runtime !== base,
        instructions: preamble === T3_PREAMBLE ? undefined : preamble,
        // ACP lists every MCP tool up front; there is no search to hold one back for.
        kinToolsUpFront: true,
        heldBack: [],
        deferredFindable: true,
        // The agent's own skills and settings load as it decides (`ownConfigLoads`).
        personalConfig: true,
        // Kin serves an ACP agent no search of its own.
        webSearch: false,
        builtins:
          capabilities.terminal !== false ||
          capabilities.fs?.readTextFile !== false ||
          capabilities.fs?.writeTextFile !== false,
        shell:
          env?.PATH === undefined
            ? undefined
            : {
                path: env.PATH,
                agentName: env.KIN_AGENT_NAME,
                // The agent inherits the host's environment (`hostEnvironment`).
                variables: Object.keys(environment),
              },
        askShell: served$("terminal", { command: "gh", args: ["pr", "list"] }),
        askRead: served$("read", { path: `${cwd}/notes.md` }),
      };
    }),
};
