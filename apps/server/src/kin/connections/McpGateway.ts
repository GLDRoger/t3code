import { McpClient, McpClientError, McpProtocol, type McpSchema } from "effect/ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";

import { EgressRefused } from "./EgressGuard.ts";
import { capturing } from "./OpenWorldHints.ts";
import { CONNECTION_LIMITS } from "./limits.ts";

export type GatewayTarget = {
  readonly connectionId: string;
  readonly url: string;
  /** The version that last worked; tried first. */
  readonly protocolVersion: string | null;
  readonly headers: Redacted.Redacted<Readonly<Record<string, string>>> | undefined;
};

/**
 * Why a request to a connection failed, in Kin's own words: a server's error text is outside
 * text, so none of it reaches the owner or an agent from here.
 */
export class KinGatewayError extends Schema.TaggedError<KinGatewayError>()("KinGatewayError", {
  reason: Schema.Literals([
    "refused_address",
    "key_refused",
    "unreachable",
    "timeout",
    "too_large",
    "protocol",
  ]),
  message: Schema.String,
}) {}

export class KinMcpGateway extends Context.Service<
  KinMcpGateway,
  {
    readonly listTools: (target: GatewayTarget) => Effect.Effect<
      {
        readonly protocolVersion: McpClient.ProtocolVersion;
        readonly instructions: string | undefined;
        readonly tools: ReadonlyArray<McpSchema.Tool>;
        /** `openWorldHint === true` as the server sent it, by tool name. */
        readonly openWorld: ReadonlyMap<string, boolean>;
      },
      KinGatewayError
    >;
    readonly callTool: (
      target: GatewayTarget,
      tool: McpSchema.Tool,
      args: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<McpSchema.CallToolResult, KinGatewayError>;
    /** Drops the open client: after a key change, removal or a failed session. */
    readonly invalidate: (connectionId: string) => Effect.Effect<void>;
  }
>()("t3/kin/connections/McpGateway/KinMcpGateway") {}

const PROTOCOLS = [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25] as const;

const egressRefusal = (error: unknown, depth = 0): string | undefined => {
  if (depth > 8 || !Predicate.isObject(error)) return undefined;
  // @effect-diagnostics-next-line instanceOfSchema:off -- a plain Error class, not a schema.
  if (error instanceof EgressRefused) return error.message;
  return (
    egressRefusal(Reflect.get(error, "cause"), depth + 1) ??
    egressRefusal(Reflect.get(error, "reason"), depth + 1)
  );
};

const gatewayError = (error: McpClientError.McpClientError, host: string) => {
  const reason = error.reason;
  const refused = egressRefusal(error);
  if (refused !== undefined)
    return new KinGatewayError({ reason: "refused_address", message: refused });
  switch (reason._tag) {
    case "HttpError":
      return reason.status === 401 || reason.status === 403
        ? new KinGatewayError({
            reason: "key_refused",
            message: `${host} refused the key (${reason.status}). The owner can replace it in the connection's settings.`,
          })
        : new KinGatewayError({
            reason: "unreachable",
            message: `${host} answered with an error (HTTP ${reason.status}).`,
          });
    case "TimeoutError":
      return new KinGatewayError({ reason: "timeout", message: `${host} didn't answer in time.` });
    case "LimitError":
      return new KinGatewayError({
        reason: "too_large",
        message: `${host} sent more than Kin reads in one message or listing.`,
      });
    case "TransportError":
    case "ClosedError":
      return new KinGatewayError({ reason: "unreachable", message: `Kin couldn't reach ${host}.` });
    default:
      return new KinGatewayError({
        reason: "protocol",
        message: `${host} returned an error${"code" in reason && reason.code !== undefined ? ` (code ${reason.code})` : ""}.`,
      });
  }
};

/** A server that doesn't speak the newer protocol answers its first request like this. */
const speaksOlder = (error: McpClientError.McpClientError) => {
  const reason = error.reason;
  return (
    (reason._tag === "ProtocolError" && reason.code === -32601) ||
    (reason._tag === "HttpError" && (reason.status === 400 || reason.code === -32601)) ||
    reason._tag === "UnsupportedError"
  );
};

/** The session is gone or the key changed: a new client is needed, the request never ran. */
const stale = (error: McpClientError.McpClientError) =>
  (error.reason._tag === "ClosedError" && error.reason.sessionExpired === true) ||
  (error.reason._tag === "HttpError" && error.reason.status === 404);

type Open = { readonly scope: Scope.Closeable; readonly client: McpClient.McpClient };

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const open = new Map<string, Open>();
  const opening = yield* Semaphore.make(1);
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...open.values()], (entry) => Scope.close(entry.scope, Exit.void), {
      discard: true,
    }),
  );

  const connectWith = Effect.fnUntraced(function* (
    target: GatewayTarget,
    protocol: (typeof PROTOCOLS)[number],
    through: HttpClient.HttpClient,
  ) {
    const scope = yield* Scope.make();
    return yield* McpClient.make({
      name: "kin",
      version: "1",
      timeout: CONNECTION_LIMITS.timeout,
      discoveryLimits: {
        maxPages: CONNECTION_LIMITS.maxPages,
        maxItems: CONNECTION_LIMITS.maxTools,
      },
    }).pipe(
      Effect.provideServiceEffect(
        McpClient.Transport,
        McpClient.http({
          url: target.url,
          protocol,
          headers: target.headers === undefined ? undefined : Redacted.value(target.headers),
          maxMessageBytes: CONNECTION_LIMITS.maxMessageBytes,
        }),
      ),
      Effect.provideService(HttpClient.HttpClient, through),
      Scope.provide(scope),
      Effect.map((client): Open => ({ scope, client })),
      Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
    );
  });

  /** The stored version first, then the others, while the server says it speaks an older one. */
  const connect = (target: GatewayTarget, through = http) => {
    const order = PROTOCOLS.toSorted(
      (a, b) =>
        Number(b.protocolVersion === target.protocolVersion) -
        Number(a.protocolVersion === target.protocolVersion),
    );
    const attempt = (index: number): Effect.Effect<Open, McpClientError.McpClientError> =>
      connectWith(target, order[index]!, through).pipe(
        Effect.catchIf(
          (error) => index < order.length - 1 && speaksOlder(error),
          () => attempt(index + 1),
        ),
      );
    return attempt(0);
  };

  const client = Effect.fn("KinMcpGateway.client")(function* (target: GatewayTarget) {
    const held = open.get(target.connectionId);
    if (held !== undefined) return held.client;
    return yield* opening.withPermits(1)(
      Effect.gen(function* () {
        const again = open.get(target.connectionId);
        if (again !== undefined) return again.client;
        const entry = yield* connect(target);
        open.set(target.connectionId, entry);
        return entry.client;
      }),
    );
  });

  const invalidate = Effect.fn("KinMcpGateway.invalidate")(function* (connectionId: string) {
    const held = open.get(connectionId);
    if (held === undefined) return;
    open.delete(connectionId);
    yield* Scope.close(held.scope, Exit.void);
  });

  /** One retry with a fresh client when the session expired: the request never ran. */
  const withClient = <A>(
    target: GatewayTarget,
    use: (client: McpClient.McpClient) => Effect.Effect<A, McpClientError.McpClientError>,
  ) => {
    const once = client(target).pipe(Effect.flatMap(use));
    const host = new URL(target.url).host;
    return once.pipe(
      Effect.catchIf(stale, () => invalidate(target.connectionId).pipe(Effect.andThen(once))),
      Effect.tapError((error) =>
        stale(error) || error.reason._tag === "HttpError"
          ? invalidate(target.connectionId)
          : Effect.void,
      ),
      Effect.mapError((error) => gatewayError(error, host)),
    );
  };

  return KinMcpGateway.of({
    // Its own session each time: a server's instructions arrive only when a session starts.
    listTools: Effect.fn("KinMcpGateway.listTools")(function* (target) {
      const openWorld = new Map<string, boolean>();
      return yield* Effect.acquireUseRelease(
        connect(target, capturing(http, openWorld)),
        ({ client }) =>
          client.listTools().pipe(
            Effect.map((tools) => ({
              protocolVersion: client.protocolVersion,
              instructions: client.instructions,
              tools,
              openWorld,
            })),
          ),
        ({ scope }) => Scope.close(scope, Exit.void),
      ).pipe(Effect.mapError((error) => gatewayError(error, new URL(target.url).host)));
    }),
    callTool: Effect.fn("KinMcpGateway.callTool")(function* (target, tool, args) {
      return yield* withClient(target, (client) =>
        client.callTool({ tool, arguments: args }, { timeout: CONNECTION_LIMITS.timeout }),
      );
    }),
    invalidate,
  });
});

/** Needs the guarded client from `EgressGuard`; tests give it a fake server behind the guard. */
export const layer = Layer.effect(KinMcpGateway, make);
