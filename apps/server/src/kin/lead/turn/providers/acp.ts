import { ThreadId } from "@t3tools/contracts";
import { AcpSessionShaper } from "@t3tools/provider-acp/server/adapter";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { AgentScopeThreadId } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AcpErrors from "effect-acp/errors";
import type { AcpRequestHandler } from "effect-acp/protocol";
import type * as AcpSchema from "effect-acp/compat";

import { type KinSessionPlan, KinSessions } from "../session.ts";
import type { KinProvider } from "./provider.ts";

const DRIVER = "acpRegistry";

type Runtime = AcpSessionRuntime.AcpSessionRuntime["Service"];

/** T3's orchestration block ahead of the user's text; Kin's instructions take its place. */
const T3_INSTRUCTIONS =
  /^<t3_code_(?:orchestration_)?instructions>[\s\S]*?<\/t3_code_(?:orchestration_)?instructions>\n\n/;

const withInstructions = (
  prompt: ReadonlyArray<AcpSchema.ContentBlock>,
  instructions: string,
): ReadonlyArray<AcpSchema.ContentBlock> =>
  prompt.map((block) =>
    block.type === "text" && T3_INSTRUCTIONS.test(block.text)
      ? { ...block, text: block.text.replace(T3_INSTRUCTIONS, `${instructions}\n\n`) }
      : block,
  );

const option = (request: AcpSchema.RequestPermissionRequest, kind: "allow" | "reject") =>
  request.options.find((each) => each.kind === `${kind}_once`) ??
  request.options.find((each) => each.kind.startsWith(kind));

/**
 * Kin answers the agent's asks and T3's own file and terminal service from the plan. ACP carries
 * no reason with a refusal, and can't take back tools an agent runs without asking.
 */
const shaped = (runtime: Runtime, plan: KinSessionPlan): Runtime => {
  const guard =
    <Request, Response>(
      method: string,
      register: (handler: AcpRequestHandler<Request, Response>) => Effect.Effect<void>,
    ) =>
    (handler: AcpRequestHandler<Request, Response>) =>
      register((request, context) =>
        plan.refusal.pipe(
          Effect.flatMap((why) =>
            why === undefined
              ? handler(request, context)
              : Effect.fail(AcpErrors.AcpRequestError.invalidRequest(why, { method })),
          ),
        ),
      );
  const instructions = plan.instructions;
  return {
    ...runtime,
    ...(instructions === undefined
      ? {}
      : {
          prompt: (payload, options) =>
            runtime.prompt(
              { ...payload, prompt: withInstructions(payload.prompt, instructions) },
              options,
            ),
        }),
    // Kin decides every ask itself, as on every provider; no one is shown one.
    handleRequestPermission: () =>
      runtime.handleRequestPermission((request) =>
        plan.refusal.pipe(
          Effect.map((why) => {
            const chosen = option(request, why === undefined ? "allow" : "reject");
            return {
              outcome:
                chosen === undefined
                  ? { outcome: "cancelled" as const }
                  : { outcome: "selected" as const, optionId: chosen.optionId },
            };
          }),
        ),
      ),
    handleReadTextFile: guard("fs/read_text_file", runtime.handleReadTextFile),
    handleWriteTextFile: guard("fs/write_text_file", runtime.handleWriteTextFile),
    handleCreateTerminal: guard("terminal/create", runtime.handleCreateTerminal),
  };
};

type Shaper = (typeof AcpSessionShaper)["Service"];

/** `AcpSessionShaper` is a reference with a default, so a layer never lists it as provided. */
const install = <E, R>(base: Layer.Layer<never, E, R>) =>
  Layer.effect(
    AcpSessionShaper,
    Effect.gen(function* () {
      const before = yield* AcpSessionShaper;
      const sessions = yield* KinSessions;
      if (!sessions.enabled) return before;
      const environment = yield* HostProcess.Environment;
      return (inner): ReturnType<Shaper> => {
        const make = before(inner);
        return (input) =>
          Effect.gen(function* () {
            const thread = yield* AgentScopeThreadId;
            const plan =
              thread === undefined
                ? undefined
                : yield* sessions.plan({
                    threadId: ThreadId.make(thread),
                    cwd: input.cwd,
                    driver: DRIVER,
                    path: input.processEnvironment?.PATH ?? environment.PATH,
                    // ACP lists every MCP tool up front: there is no search to find one by.
                    toolLookup: false,
                  });
            if (plan === undefined || plan.seat === "dream") return yield* make(input);
            const confined = plan.seat === "confined";
            const runtime = yield* make({
              ...input,
              processEnvironment: {
                ...input.processEnvironment,
                ...(plan.shell === undefined
                  ? {}
                  : {
                      PATH: plan.shell.path,
                      ...(plan.shell.agentName === undefined
                        ? {}
                        : { KIN_AGENT_NAME: plan.shell.agentName }),
                    }),
              },
              clientCapabilities: confined
                ? {
                    ...input.clientCapabilities,
                    fs: { readTextFile: false, writeTextFile: false },
                    terminal: false,
                  }
                : input.clientCapabilities,
            });
            return shaped(runtime, plan);
          });
      };
    }),
  ).pipe(Layer.provide(Layer.merge(base, KinSessions.layer)));

/** ACP agents bring their own tools; Kin reaches only what they ask for and what T3 serves them. */
export const acp = {
  driver: DRIVER,
  capabilities: {},
  install,
} satisfies KinProvider<never>;
