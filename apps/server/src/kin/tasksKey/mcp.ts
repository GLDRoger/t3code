import { KinChatError, KinRecordKey, KinRecordState, KinTrimmedText } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { parseBearerToken } from "../../auth/EnvironmentAuth.ts";
import { SessionStore } from "../../auth/SessionStore.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { KinServer, type Services } from "../KinServer.ts";
import { commentMine, getMine, listMine, setStateMine } from "./tasks.ts";
import { admit, type TasksKeyHolder } from "./TasksKeys.ts";

/** Who this request's key acts as, and Kin's services: provided per request by `auth` below. */
class TasksKeyCaller extends Context.Service<
  TasksKeyCaller,
  { readonly holder: TasksKeyHolder; readonly services: Context.Context<Services> }
>()("t3/kin/tasksKey/mcp/TasksKeyCaller") {}

const TaskSummary = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  state: KinRecordState,
  due: Schema.NullOr(Schema.String),
  dueDay: Schema.optional(Schema.String),
  project: Schema.NullOr(Schema.String),
});
const TaskDetail = Schema.Struct({
  ...TaskSummary.fields,
  brief: Schema.String,
  comments: Schema.Array(
    Schema.Struct({ by: Schema.String, at: Schema.String, text: Schema.String }),
  ),
});
const shared = { failure: KinChatError, failureMode: "return" as const };
const TaskKey = KinRecordKey.annotate({ description: "The task's key, such as W-12." });
const unavailable = new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });

const TasksKeyToolkit = Toolkit.make(
  // No `parameters`: an empty Struct serializes to a schema MCP clients reject.
  Tool.make("list_my_tasks", {
    ...shared,
    description:
      "List the open Kin tasks held by the person this key belongs to, soonest due first: key, title, state, due date and project.",
    success: Schema.Struct({ tasks: Schema.Array(TaskSummary), more: Schema.Boolean }),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("get_task", {
    ...shared,
    description:
      "Read one of that person's tasks: title, brief, state, due date, project and the newest comments. A task they don't hold is not found.",
    parameters: Schema.Struct({ key: TaskKey }),
    success: TaskDetail,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("comment_on_task", {
    ...shared,
    description:
      "Add a comment to one of that person's tasks. It is posted as them, marked as from their coding agent. The same text again posts nothing new.",
    parameters: Schema.Struct({
      key: TaskKey,
      text: KinTrimmedText.check(Schema.isMaxLength(4_000)).annotate({
        description: "The comment, in plain words.",
      }),
    }),
    success: Schema.Struct({ key: Schema.String, posted: Schema.Boolean }),
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("set_task_state", {
    ...shared,
    description:
      "Set one of that person's tasks to doing (started), done, or open (not started). The change is theirs, marked as from their coding agent.",
    parameters: Schema.Struct({
      key: TaskKey,
      state: Schema.Literals(["open", "doing", "done"]),
    }),
    success: TaskDetail,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
);
export const TASKS_KEY_TOOLS = Object.keys(TasksKeyToolkit.tools);

// Read from the request, not declared: tool services are built with the server, and the holder
// exists only per request. Without `auth` in front there is none, and every call fails.
const asHolder = Effect.fnUntraced(function* <A, R extends Services>(
  run: (holder: TasksKeyHolder) => Effect.Effect<A, KinChatError, R>,
) {
  const caller = yield* Effect.serviceOption(TasksKeyCaller);
  if (Option.isNone(caller)) return yield* unavailable;
  return yield* run(caller.value.holder).pipe(Effect.provideContext(caller.value.services));
});

// The key's holder is the only authority here, checked by the service; T3's caller
// declarations describe threads and clients, which a person's key is neither.
const handlers = McpToolAccess.toLayer(TasksKeyToolkit, {
  list_my_tasks: McpToolAccess.reads(Effect.fn("KinTasksKeyTools.list")(() => asHolder(listMine))),
  get_task: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.get")((input) => asHolder((holder) => getMine(holder, input.key))),
  ),
  comment_on_task: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.comment")((input) =>
      asHolder((holder) => commentMine(holder, input)),
    ),
  ),
  set_task_state: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.setState")((input) =>
      asHolder((holder) => setStateMine(holder, input)),
    ),
  ),
});

const refused = HttpServerResponse.jsonUnsafe(
  { error: "invalid_kin_key", message: "A live Kin coding agent key is required." },
  { status: 401, headers: { "cache-control": "no-store", "www-authenticate": "Bearer" } },
);

type Admitted = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  TasksKeyCaller
>;
/** Every request, every tool call: a bearer key only, re-read each time, so revoking is at once. */
// Stated, not inferred: inferred, the checker's file order can leave these as `unknown`.
const auth = HttpRouter.middleware<{ provides: TasksKeyCaller }>()<
  Types.unhandled,
  HttpServerRequest.HttpServerRequest,
  never,
  KinServer
>(
  Effect.gen(function* () {
    const kin = yield* KinServer;
    const sessions = yield* Effect.serviceOption(SessionStore);
    // Untraced: a span here would wrap the tool call; the HTTP server span already covers it.
    return Effect.fnUntraced(function* (effect: Admitted) {
      if (Option.isNone(kin.services) || Option.isNone(sessions))
        return HttpServerResponse.empty({ status: 503 });
      const services = kin.services.value;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const holder = yield* admit(parseBearerToken(request) ?? "").pipe(
        Effect.provideContext(services),
        Effect.provideService(SessionStore, sessions.value),
        Effect.orElseSucceed(() => Option.none<TasksKeyHolder>()),
      );
      if (Option.isNone(holder)) return refused;
      return yield* effect.pipe(
        Effect.provideService(TasksKeyCaller, { holder: holder.value, services }),
      );
    });
  }),
).layer;

/**
 * The T3 transport admits only what `auth` would: no agent token (the registry resolves none
 * here) and no outside MCP client, only a live key, as a caller with no thread.
 */
const keyAsClient = Layer.mergeAll(
  Layer.effect(
    McpSessionRegistry.McpSessionRegistry,
    Effect.gen(function* () {
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      return {
        ...registry,
        resolve: Effect.fn("KinTasksKey.resolveNoAgent")(() => Effect.undefined),
      };
    }),
  ),
  Layer.effect(
    McpHttpServer.McpClientAuthenticator,
    Effect.gen(function* () {
      const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
      return McpHttpServer.McpClientAuthenticator.of({
        // The holder `auth` admitted for this request; with none in front, nobody is.
        authenticate: Effect.fn("KinTasksKey.authenticate")(function* () {
          const caller = yield* Effect.serviceOption(TasksKeyCaller);
          if (Option.isNone(caller)) return undefined;
          return {
            environmentId,
            requestNamespace: `kin-tasks:${caller.value.holder.sessionId}`,
            thread: undefined,
            client: undefined,
            capabilities: new Set(),
            issuedAt: yield* Clock.currentTimeMillis,
          };
        }),
      });
    }),
  ),
);

/** `/kin/you/mcp`: these four tools and nothing else, for a person's own coding agent. */
const endpoint = McpHttpServer.layerMcpTransport(
  McpHttpServer.toolkitRegistration(TasksKeyToolkit, handlers),
).pipe(
  Layer.provide(keyAsClient),
  Layer.fresh,
  Layer.updateService(HttpRouter.HttpRouter, (router) => router.prefixed("/kin/you")),
  Layer.provide(auth),
);

/** Mounted only while Kin runs, as `/kin/mcp` is. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const kin = yield* KinServer;
    return Option.isSome(kin.services) ? endpoint : Layer.empty;
  }),
);
