import {
  EnvironmentId,
  OrchestratorMcpFailure,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Tool from "effect/ai/Tool";
import { OrchestratorToolkit } from "../../mcp/toolkits/orchestrator/tools.ts";
import { ProjectToolkit } from "../../mcp/toolkits/project/tools.ts";
import { unavailable } from "../../mcp/threadAccess.ts";
import * as PeerMcpClient from "../../peer/PeerMcpClient.ts";

/** The tools Kin calls in the worker environment. */
export const tools = {
  capabilities: OrchestratorToolkit.tools.orchestrator_capabilities,
  projects: ProjectToolkit.tools.t3_project_list,
  launch: ProjectToolkit.tools.t3_thread_launch,
  read: OrchestratorToolkit.tools.t3_thread_read,
  send: OrchestratorToolkit.tools.t3_thread_send,
  wait: OrchestratorToolkit.tools.t3_thread_wait,
  interrupt: OrchestratorToolkit.tools.t3_thread_interrupt,
};

const encoders = new Map(
  Object.values(tools).map((tool) => [
    tool.name,
    Schema.encodeUnknownEffect(tool.parametersSchema as Schema.Encoder<unknown>),
  ]),
);

/**
 * Where workers run: a plain T3 server under its own OS user, linked from this one. A worker's
 * shell there holds no credential for this server and can't read its state; nothing here ever
 * runs a worker thread. Calls go out as the link with full-access limits, which the link's own
 * access still caps there.
 */
export class KinWorkerEnvironment extends Context.Service<
  KinWorkerEnvironment,
  {
    /** `KIN_WORKER_ENVIRONMENT_ID`; none when the host has no worker environment. */
    readonly environmentId: Option.Option<EnvironmentId>;
    /** Calls one of `tools` there. */
    readonly call: <T extends (typeof tools)[keyof typeof tools]>(
      environmentId: EnvironmentId,
      tool: T,
      params: Tool.Parameters<T>,
    ) => Effect.Effect<Tool.Success<T>, OrchestratorMcpFailure>;
  }
>()("t3/kin/lead/workerEnvironment/KinWorkerEnvironment") {}

export const layer = Layer.effect(
  KinWorkerEnvironment,
  Effect.gen(function* () {
    const peers = yield* PeerMcpClient.PeerMcpClient;
    const configured = yield* Config.option(Config.String("KIN_WORKER_ENVIRONMENT_ID")).pipe(
      Effect.orElseSucceed(() => Option.none()),
    );
    const environmentId = Option.flatMap(configured, (value) =>
      value.trim() === "" ? Option.none() : Option.some(EnvironmentId.make(value.trim())),
    );
    const call: KinWorkerEnvironment["Service"]["call"] = Effect.fn("KinWorkerEnvironment.call")(
      function* (environmentId, tool, params) {
        const encode = encoders.get(tool.name);
        if (encode === undefined) return yield* unavailable();
        const encoded = (yield* encode(params).pipe(Effect.mapError(unavailable))) as Record<
          string,
          unknown
        >;
        const { environmentId: _here, ...args } = encoded;
        return yield* peers.call({
          environmentId,
          tool: tool.name,
          arguments: args,
          limits: { runtimeMode: "full-access", interactionMode: "default" },
          success: tool.successSchema as unknown as Schema.Decoder<Tool.Success<typeof tool>>,
        });
      },
    );
    return KinWorkerEnvironment.of({ environmentId, call });
  }),
);

/** Whether workers can start here at all: a worker environment is configured. */
export const workersConfigured = Effect.serviceOption(KinWorkerEnvironment).pipe(
  Effect.map((env) => Option.isSome(Option.flatMap(env, (value) => value.environmentId))),
);

/** Refusals no retry can change: the link is gone or revoked, or the thread is gone there. */
export const isFinal = (error: OrchestratorMcpFailure) =>
  error.code === "capability_denied" ||
  error.code === "thread_not_found" ||
  error.code === "run_not_found";

/**
 * Stops a worker's thread there as its Stop button does: its turn, queued messages and
 * delegated tasks. `key` names the stop, so a resend is recorded there once.
 */
export const stopThere = (
  env: KinWorkerEnvironment["Service"],
  input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly key: string;
    readonly reason: string;
  },
) =>
  env.call(input.environmentId, tools.interrupt, {
    threadId: input.threadId,
    stop: true,
    reason: input.reason,
    clientRequestId: input.key,
  });

/** A thread there that ended without a reply reads as no report. */
export const lastReply = Effect.fn("KinWorkerEnvironment.lastReply")(function* (
  env: KinWorkerEnvironment["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
  runId: string,
) {
  let reply: { readonly itemId: TurnItemId; text: string; next: number | null } | undefined;
  let afterPosition: number | undefined;
  while (true) {
    const read = yield* env.call(environmentId, tools.read, {
      threadId,
      view: "messages",
      limit: 100,
      ...(afterPosition === undefined ? {} : { afterPosition }),
    });
    const found = read.items.findLast(
      (item) => item.type === "assistant_message" && item.runId === runId,
    );
    if (found !== undefined)
      reply = {
        itemId: found.itemId,
        text: found.text ?? "",
        next: found.textTruncated ? (found.nextTextOffset ?? null) : null,
      };
    if (!read.hasMore || read.nextPosition === null) break;
    afterPosition = read.nextPosition;
  }
  if (reply === undefined) return undefined;
  while (reply.next !== null) {
    const rest = yield* env.call(environmentId, tools.read, {
      threadId,
      itemId: reply.itemId,
      textOffset: reply.next,
      maxCharsPerItem: 50_000,
    });
    const part = rest.items[0];
    if (part === undefined) break;
    reply.text += part.text ?? "";
    reply.next = part.textTruncated ? (part.nextTextOffset ?? null) : null;
  }
  return reply.text;
});
