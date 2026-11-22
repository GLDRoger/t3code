import type { ThreadId } from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous diagnostic hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Types from "effect/Types";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { parseBearerToken } from "../../auth/EnvironmentAuth.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { McpToolPolicy } from "./toolPolicy.ts";
import {
  type McpThreadInvocationScope,
  type McpThreadCaller,
} from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as DreamSession from "../dreaming/DreamSession.ts";
import * as AgentSession from "../lead/AgentSession.ts";
import * as KinLead from "../lead/layer.ts";
import * as DevClock from "../DevClock.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { ThreadLaunchService } from "../../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { KinServer } from "../KinServer.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinChatToolkit, handlers } from "./KinChatToolkit.ts";
import * as KinConnectionsMcp from "../connections/mcp.ts";
import * as KinIssuedTokens from "./KinIssuedTokens.ts";
import * as KinToolGate from "./KinToolGate.ts";

export class KinAgentSessions extends Context.Service<
  KinAgentSessions,
  { readonly resolveAgent: McpSessionRegistry.McpSessionRegistryShape["resolve"] }
>()("t3/kin/mcp/layer/KinAgentSessions") {}

const registration = McpHttpServer.toolkitRegistration(KinChatToolkit, handlers);

const fromJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const toJson = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/**
 * A sha256 of each `tools/list` result a lead's session was served: two sessions' lines with the
 * same hash carried the same tool block, which the prompt cache needs. A streamed reply isn't read.
 */
const logToolList = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
  response: HttpServerResponse.HttpServerResponse,
  thread: McpThreadCaller | undefined,
) {
  if (request.method !== "POST" || response.body._tag !== "Uint8Array") return;
  const message = yield* Effect.orElseSucceed(request.json, () => undefined);
  if (!Predicate.isReadonlyObject(message) || message.method !== "tools/list") return;
  // An SSE frame per line of the JSON-RPC reply, which is one line.
  const text = new TextDecoder()
    .decode(response.body.body)
    .trim()
    .replace(/^data: /, "");
  const reply = fromJson(text);
  if (Option.isNone(reply) || !Predicate.isReadonlyObject(reply.value)) return;
  const result = reply.value.result;
  if (!Predicate.isReadonlyObject(result) || !Array.isArray(result.tools)) return;
  const encoded = toJson(result);
  if (Option.isNone(encoded)) return;
  const served = encoded.value;
  yield* Effect.logInfo("Kin endpoint tool list.", {
    threadId: thread?.threadId,
    providerSessionId: thread?.providerSessionId,
    toolListSha256: NodeCrypto.createHash("sha256").update(served).digest("hex"),
    toolListBytes: new TextEncoder().encode(served).length,
    tools: result.tools.length,
  });
});
class KinBearerScope extends Context.Service<KinBearerScope, McpThreadInvocationScope>()(
  "t3/kin/mcp/layer/KinBearerScope",
) {}

type Auth = (
  effect: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    Types.unhandled,
    KinBearerScope | KinServer | KinIdentity
  >,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;
const auth = HttpRouter.middleware<{ provides: KinBearerScope | KinServer | KinIdentity }>()(
  Effect.gen(function* () {
    const registry = yield* KinAgentSessions;
    const kin = yield* KinServer;
    // Untraced: a span here would wrap the tool call; the HTTP server span already covers it.
    return Effect.fnUntraced(function* (
      effect: Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        Types.unhandled,
        KinBearerScope | KinServer | KinIdentity
      >,
    ) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const scope = yield* registry.resolveAgent(parseBearerToken(request) ?? "");
      if (scope === undefined) return HttpServerResponse.empty({ status: 401 });
      if (Option.isNone(kin.services)) return HttpServerResponse.empty({ status: 503 });
      const identity = Context.get(kin.services.value, KinIdentity);
      const admitted = yield* identity.resolveAgent(scope).pipe(Effect.option);
      if (Option.isNone(admitted)) return HttpServerResponse.empty({ status: 403 });
      const response = yield* effect.pipe(
        Effect.provideService(KinBearerScope, scope),
        Effect.provideService(KinServer, kin),
        Effect.provideService(KinIdentity, identity),
      );
      yield* logToolList(request, response, scope.thread).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Kin tool list log failed", { cause })),
      );
      return response;
    }) satisfies Auth;
  }),
).layer;

// Whatever is registered here, every tool call passes the gate first.
export const endpoint = <A, E, R>(registrations: Layer.Layer<A, E, R>) =>
  McpHttpServer.layerMcpTransport(
    Layer.mergeAll(registrations, KinToolGate.layer, AgentSession.endpointVisibility),
  ).pipe(
    Layer.provide(
      Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const registry = yield* McpSessionRegistry.McpSessionRegistry;
          return {
            ...registry,
            // Kin auth already checked the bearer and agent before the transport runs.
            resolve: Effect.fn("KinMcp.resolveAdmittedBearer")(() =>
              Effect.serviceOption(KinBearerScope).pipe(Effect.map(Option.getOrUndefined)),
            ),
          };
        }),
      ),
    ),
    Layer.fresh,
    Layer.updateService(HttpRouter.HttpRouter, (router) => router.prefixed("/kin")),
    Layer.provide(auth),
  );

/** `/mcp` is always `base`, T3's own; with Kin on, under Kin's policy for a lead's delegated tasks. */
export const transport = (base: typeof McpHttpServer.layer) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const kin = yield* KinServer;
      if (Option.isNone(kin.services)) return base;
      // T3's own tools are served here too, shown to a lead only as `AgentSession` allows:
      // never scheduling or thread-launch tools, which would start work outside Kin's chats.
      return Layer.merge(
        base.pipe(
          Layer.provide(Layer.succeed(McpToolPolicy, KinToolGate.workerPolicy(kin.services.value))),
        ),
        endpoint(
          Layer.mergeAll(
            McpHttpServer.layerTools,
            registration,
            KinConnectionsMcp.registration.pipe(
              Layer.provide(Layer.succeedContext(kin.services.value)),
            ),
            KinLead.layerRuntime.pipe(
              // Agents' turns run on Kin's clock; T3's orchestration keeps the one its worker reads.
              Layer.provide(
                Layer.mergeAll(
                  DevClock.realClockFor(OrchestratorV2),
                  DevClock.realClockFor(ThreadLaunchService),
                  DevClock.realClockFor(ThreadManagementService),
                ),
              ),
              Layer.provide(Layer.succeedContext(kin.services.value)),
              Layer.provide(SqlitePersistence.layerConfig),
            ),
          ),
        ),
      );
    }),
  );

export const registry = <E, R>(base: Layer.Layer<McpSessionRegistry.McpSessionRegistry, E, R>) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const base = yield* McpSessionRegistry.McpSessionRegistry;
      const kin = yield* KinServer;
      const agentSessions = new Map<string, ThreadId>();
      const tokens = yield* KinIssuedTokens.make;
      const isAgentThread = (thread: {
        readonly threadId: ThreadId;
        readonly subagent?: boolean;
      }) =>
        thread.subagent !== true &&
        Option.isSome(kin.services) &&
        Context.get(kin.services.value, KinIdentity).isAgentThread(thread.threadId);
      // Dream threads read untrusted material, so they get no MCP authority on either endpoint.
      const readsUntrusted = (threadId: ThreadId) =>
        Option.isSome(kin.services) && threadId.startsWith(DreamSession.threadPrefix);
      const resolveAgent = Effect.fn("KinMcp.resolveAgent")(function* (token: string) {
        const scope = yield* base.resolve(token);
        return scope !== undefined &&
          isAgentThread(scope.thread) &&
          agentSessions.has(scope.thread.providerSessionId)
          ? scope
          : undefined;
      });
      const wrapped = McpSessionRegistry.McpSessionRegistry.of({
        ...base,
        resolve: Effect.fn("KinMcp.resolve")(function* (token) {
          const scope = yield* base.resolve(token);
          if (scope === undefined) return undefined;
          return isAgentThread(scope.thread) ||
            readsUntrusted(scope.thread.threadId) ||
            agentSessions.has(scope.thread.providerSessionId)
            ? undefined
            : scope;
        }),
        revokeProviderSession: Effect.fn("KinMcp.revokeProviderSession")(function* (id) {
          yield* base.revokeProviderSession(id);
          yield* tokens.revokeProviderSession(id);
          agentSessions.delete(id);
        }),
        revokeThread: Effect.fn("KinMcp.revokeThread")(function* (threadId) {
          yield* base.revokeThread(threadId);
          yield* tokens.revokeThread(threadId);
          for (const [id, owner] of agentSessions) if (owner === threadId) agentSessions.delete(id);
        }),
        revokeAll: base.revokeAll.pipe(
          Effect.andThen(tokens.revokeAll),
          Effect.tap(() => Effect.sync(() => agentSessions.clear())),
        ),
        issue: Effect.fn("KinMcp.issue")(function* (request) {
          const issued = yield* base.issue(request);
          if (readsUntrusted(request.threadId)) {
            yield* base.revokeProviderSession(issued.config.providerSessionId);
            return issued;
          }
          yield* tokens.record(issued.config.authorizationHeader, {
            providerSessionId: issued.config.providerSessionId,
            threadId: request.threadId,
          });
          const isAgent = isAgentThread(request);
          if (isAgent) agentSessions.set(issued.config.providerSessionId, request.threadId);
          return isAgent
            ? {
                config: {
                  ...issued.config,
                  endpoint: issued.config.endpoint.replace(/\/mcp$/, "/kin/mcp"),
                },
              }
            : issued;
        }),
      });
      return Context.make(McpSessionRegistry.McpSessionRegistry, wrapped).pipe(
        Context.add(KinAgentSessions, { resolveAgent }),
        Context.add(KinIssuedTokens.KinIssuedTokens, tokens.service),
      );
    }),
  ).pipe(Layer.provide(base));
