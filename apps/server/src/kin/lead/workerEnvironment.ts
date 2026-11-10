import {
  EnvironmentId,
  OrchestratorMcpFailure,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Tool from "effect/ai/Tool";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
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

/** A call there that answers in none of this long fails, so a frozen server can't hold Kin. */
export const CALL_TIMEOUT = Duration.seconds(30);
/** The stop switch waits this long for each stop there before it kills the worker server. */
export const STOP_TIMEOUT = Duration.seconds(10);
/** Bounds on answers Kin pages through, so a hostile server can't keep Kin reading. */
export const MAX_PAGES = 50;
const MAX_REPLY_CHARS = 200_000;

/** The worker server could not be killed on this host. */
export class KinWorkerKillError extends Schema.TaggedError<KinWorkerKillError>()(
  "KinWorkerKillError",
  { cause: Schema.Defect() },
) {}

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
    /** Calls one of `tools` there, failing after `timeout` (default `CALL_TIMEOUT`). */
    readonly call: <T extends (typeof tools)[keyof typeof tools]>(
      environmentId: EnvironmentId,
      tool: T,
      params: Tool.Parameters<T>,
      options?: { readonly timeout?: Duration.Input },
    ) => Effect.Effect<Tool.Success<T>, OrchestratorMcpFailure>;
    /**
     * SIGKILLs every process of the worker server's unit on this host. The stop switch's last
     * resort when a stop there fails: it works whatever the server there answers.
     */
    readonly kill: Effect.Effect<void, KinWorkerKillError>;
  }
>()("t3/kin/lead/workerEnvironment/KinWorkerEnvironment") {}

/** The one command kin-worker.sh's sudoers entry lets `kin` run. */
const KILL_COMMAND = [
  "/usr/bin/sudo",
  "-n",
  "/usr/bin/systemctl",
  "kill",
  "-s",
  "SIGKILL",
  "kin-worker-server.service",
] as const;

const systemctlKill = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const [command, ...args] = KILL_COMMAND;
  const code = yield* spawner
    .exitCode(
      ChildProcess.make(command, args, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        forceKillAfter: "1 second",
      }),
    )
    .pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError((cause) => new KinWorkerKillError({ cause })),
    );
  if (code !== 0) return yield* new KinWorkerKillError({ cause: `exit code ${code}` });
});

const timedOut = new OrchestratorMcpFailure({
  code: "orchestration_error",
  message: "The worker environment didn't answer in time.",
});

export const make = Effect.fn("KinWorkerEnvironment.make")(function* (
  kill: Effect.Effect<void, KinWorkerKillError>,
) {
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const configured = yield* Config.option(Config.String("KIN_WORKER_ENVIRONMENT_ID")).pipe(
    Effect.orElseSucceed(() => Option.none()),
  );
  const environmentId = Option.flatMap(configured, (value) =>
    value.trim() === "" ? Option.none() : Option.some(EnvironmentId.make(value.trim())),
  );
  const call: KinWorkerEnvironment["Service"]["call"] = Effect.fn("KinWorkerEnvironment.call")(
    function* (environmentId, tool, params, options) {
      const encode = encoders.get(tool.name);
      if (encode === undefined) return yield* unavailable();
      const encoded = (yield* encode(params).pipe(Effect.mapError(unavailable))) as Record<
        string,
        unknown
      >;
      const { environmentId: _here, ...args } = encoded;
      return yield* peers
        .call({
          environmentId,
          tool: tool.name,
          arguments: args,
          limits: { runtimeMode: "full-access", interactionMode: "default" },
          success: tool.successSchema as unknown as Schema.Decoder<Tool.Success<typeof tool>>,
        })
        .pipe(
          Effect.timeoutOrElse({
            duration: options?.timeout ?? CALL_TIMEOUT,
            orElse: () => Effect.fail(timedOut),
          }),
        );
    },
  );
  return KinWorkerEnvironment.of({ environmentId, call, kill });
});

export const layer = Layer.effect(
  KinWorkerEnvironment,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* make(
      systemctlKill.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    );
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
 * What a failure there tells a lead. The text is the other server's, so it reaches the lead
 * only quoted as untrusted, after Kin's own words for its code.
 */
export const describeFailure = (error: OrchestratorMcpFailure) => {
  const known =
    error.code === "capability_denied"
      ? "The worker environment no longer accepts Kin's link."
      : error.code === "thread_not_found" || error.code === "run_not_found"
        ? "The worker's thread is gone from the worker environment."
        : error.code === "invalid_request"
          ? "The worker environment refused the request."
          : "The worker environment failed or didn't answer.";
  return { known, untrusted: error.message.slice(0, 500) };
};

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
  env.call(
    input.environmentId,
    tools.interrupt,
    {
      threadId: input.threadId,
      stop: true,
      reason: input.reason,
      clientRequestId: input.key,
    },
    { timeout: STOP_TIMEOUT },
  );

/**
 * A thread there that ended without a reply reads as no report. Reading stops after `MAX_PAGES`
 * pages or when a cursor doesn't advance; a reply keeps only its last `MAX_REPLY_CHARS`, where
 * the report block goes.
 */
export const lastReply = Effect.fn("KinWorkerEnvironment.lastReply")(function* (
  env: KinWorkerEnvironment["Service"],
  environmentId: EnvironmentId,
  threadId: ThreadId,
  runId: string,
) {
  let reply: { readonly itemId: TurnItemId; text: string; next: number | null } | undefined;
  let afterPosition: number | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
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
        text: (found.text ?? "").slice(-MAX_REPLY_CHARS),
        next: found.textTruncated ? (found.nextTextOffset ?? null) : null,
      };
    if (!read.hasMore || read.nextPosition === null) break;
    if (afterPosition !== undefined && read.nextPosition <= afterPosition) break;
    afterPosition = read.nextPosition;
  }
  if (reply === undefined) return undefined;
  for (let page = 0; reply.next !== null && page < MAX_PAGES; page++) {
    const offset: number = reply.next;
    const rest = yield* env.call(environmentId, tools.read, {
      threadId,
      itemId: reply.itemId,
      textOffset: offset,
      maxCharsPerItem: 50_000,
    });
    const part = rest.items[0];
    if (part === undefined) break;
    reply.text = (reply.text + (part.text ?? "")).slice(-MAX_REPLY_CHARS);
    const next = part.textTruncated ? (part.nextTextOffset ?? null) : null;
    reply.next = next !== null && next > offset ? next : null;
  }
  return reply.text;
});
