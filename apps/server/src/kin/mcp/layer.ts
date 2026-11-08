import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Types from "effect/Types";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { parseBearerToken } from "../../auth/EnvironmentAuth.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as DreamSession from "../dreaming/DreamSession.ts";
import * as KinLead from "../lead/layer.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { KinServer } from "../KinServer.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinChatToolkit, handlers } from "./KinChatToolkit.ts";
import * as KinIssuedTokens from "./KinIssuedTokens.ts";

export class KinAgentSessions extends Context.Service<
  KinAgentSessions,
  { readonly resolveAgent: McpSessionRegistry.McpSessionRegistryShape["resolve"] }
>()("t3/kin/mcp/layer/KinAgentSessions") {}

const registration = McpHttpServer.toolkitRegistration(KinChatToolkit, handlers);
type Auth = (
  effect: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    Types.unhandled,
    McpInvocationContext | KinServer
  >,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;
const auth = HttpRouter.middleware<{ provides: McpInvocationContext | KinServer }>()(
  Effect.gen(function* () {
    const registry = yield* KinAgentSessions;
    const kin = yield* KinServer;
    // Untraced: a span here would wrap the tool call; the HTTP server span already covers it.
    return Effect.fnUntraced(function* (
      effect: Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        Types.unhandled,
        McpInvocationContext | KinServer
      >,
    ) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const scope = yield* registry.resolveAgent(parseBearerToken(request) ?? "");
      if (scope === undefined) return HttpServerResponse.empty({ status: 401 });
      if (Option.isNone(kin.services)) return HttpServerResponse.empty({ status: 503 });
      const identity = Context.get(kin.services.value, KinIdentity);
      const admitted = yield* identity.resolveAgent(scope).pipe(Effect.option);
      if (Option.isNone(admitted)) return HttpServerResponse.empty({ status: 403 });
      return yield* effect.pipe(
        Effect.provideService(McpInvocationContext, scope),
        Effect.provideService(KinServer, kin),
      );
    }) satisfies Auth;
  }),
).layer;

export const endpoint = <A, E, R>(registrations: Layer.Layer<A, E, R>) =>
  McpHttpServer.layerMcpTransport(registrations).pipe(
    Layer.provide(
      Layer.effect(
        McpSessionRegistry.McpSessionRegistry,
        Effect.gen(function* () {
          const registry = yield* McpSessionRegistry.McpSessionRegistry;
          const agents = yield* KinAgentSessions;
          return { ...registry, resolve: agents.resolveAgent };
        }),
      ),
    ),
    Layer.fresh,
    Layer.updateService(HttpRouter.HttpRouter, (router) => router.prefixed("/kin")),
    Layer.provide(auth),
  );

export const transport = (base: typeof McpHttpServer.layer) =>
  Layer.merge(
    base,
    Layer.unwrap(
      Effect.gen(function* () {
        const kin = yield* KinServer;
        // Kin leads cannot bypass their toolkit through T3 scheduling or thread-launch tools.
        return Option.isSome(kin.services)
          ? endpoint(
              Layer.mergeAll(
                registration,
                KinLead.layerMcp.pipe(
                  Layer.provide(Layer.succeedContext(kin.services.value)),
                  Layer.provide(SqlitePersistence.layerConfig),
                ),
              ),
            )
          : Layer.empty;
      }),
    ),
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
      const isDreamThread = (threadId: ThreadId) =>
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
            isDreamThread(scope.thread.threadId) ||
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
          if (isDreamThread(request.threadId)) {
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
