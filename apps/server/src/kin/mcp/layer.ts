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
import { KinServer } from "../KinServer.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinChatToolkit, handlers } from "./KinChatToolkit.ts";

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
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const kin = yield* KinServer;
    return Effect.fn("KinMcp.authenticate")(function* (
      effect: Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        Types.unhandled,
        McpInvocationContext | KinServer
      >,
    ) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const scope = yield* registry.resolve(parseBearerToken(request) ?? "");
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
    Layer.fresh,
    Layer.updateService(HttpRouter.HttpRouter, (router) => router.prefixed("/kin")),
    Layer.provide(auth),
  );

export const transport = (base: typeof McpHttpServer.layer) =>
  Layer.merge(base, endpoint(Layer.merge(McpHttpServer.layerTools, registration)));

export const registry = <E, R>(base: Layer.Layer<McpSessionRegistry.McpSessionRegistry, E, R>) =>
  Layer.effect(
    McpSessionRegistry.McpSessionRegistry,
    Effect.gen(function* () {
      const base = yield* McpSessionRegistry.McpSessionRegistry;
      const kin = yield* KinServer;
      return McpSessionRegistry.McpSessionRegistry.of({
        ...base,
        issue: Effect.fn("KinMcp.issue")(function* (request) {
          const issued = yield* base.issue(request);
          const isAgent =
            request.subagent !== true &&
            Option.isSome(kin.services) &&
            Context.get(kin.services.value, KinIdentity).isAgentThread(request.threadId);
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
    }),
  ).pipe(Layer.provide(base));
