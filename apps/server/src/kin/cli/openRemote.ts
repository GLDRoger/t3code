import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, RpcGroup, RpcSerialization, Rpc } from "effect/rpc";
import { Socket } from "effect/socket";
import * as EnvironmentAuth from "../auth/EnvironmentAuthRuntime.ts";
const AccessToken = Schema.Struct({ access_token: Schema.String });
const Ticket = Schema.Struct({ ticket: Schema.String });

/** Pairs a short-lived owner session with the running server; the scope revokes it. */
export const openRemote = Effect.fn("kin.cli.openRemote")(function* <R extends Rpc.Any, E>(
  origin: string,
  group: RpcGroup.RpcGroup<R>,
  labelPrefix: string,
  unreachable: E,
) {
  // No cause: socket and fetch errors can carry the one-use ticket in their URL.
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const tag = Buffer.from(yield* (yield* SecureRandom.SecureRandom).randomBytes(4)).toString("hex");
  const label = `${labelPrefix} ${tag}`;
  const pairing = yield* auth.issuePairingCredential({ label });
  yield* Effect.addFinalizer(() =>
    Effect.andThen(
      Effect.ignore(auth.revokePairingLink(pairing.id)),
      auth.listSessions().pipe(
        Effect.flatMap((sessions) =>
          Effect.forEach(
            sessions.filter((session) => session.client.label === label),
            (session) => auth.revokeSession(session.sessionId),
            { discard: true },
          ),
        ),
        Effect.ignore,
      ),
    ),
  );
  const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  const post = <A>(request: HttpClientRequest.HttpClientRequest, schema: Schema.Decoder<A>) =>
    http.execute(request).pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(() => unreachable),
    );
  const { access_token } = yield* post(
    HttpClientRequest.post(new URL("/oauth/token", origin)).pipe(
      HttpClientRequest.bodyUrlParams({
        grant_type: AuthTokenExchangeGrantType,
        subject_token: pairing.credential,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
      }),
    ),
    AccessToken,
  );
  const { ticket } = yield* post(
    HttpClientRequest.post(new URL("/api/auth/websocket-ticket/rpc", origin)).pipe(
      HttpClientRequest.setHeaders({
        authorization: `Bearer ${access_token}`,
        [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
      }),
    ),
    Ticket,
  );
  const wsUrl = new URL("/ws", origin);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, ORCHESTRATION_PROTOCOL_VERSION_TEXT);
  wsUrl.searchParams.set("wsTicket", ticket);
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(Socket.layerWebSocket(wsUrl.href)),
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provide(RpcSerialization.layerJson),
    ),
  );
  const client = yield* RpcClient.make(group).pipe(Effect.provideContext(protocol));
  return client;
});
