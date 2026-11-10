import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  KinChatError,
  KinPeopleRpcs,
  KinOrgId,
  KinPersonId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, RpcGroup, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import {
  authLocationFlags,
  type CliAuthLocationFlags,
  resolveCliAuthConfig,
} from "../../cli/config.ts";
import * as ServerConfig from "../../config.ts";
import { readPersistedServerRuntimeState } from "../../serverRuntimeState.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuthRuntime.ts";
import * as KinEnabled from "../KinEnabled.ts";

const fail = (message: string) => Effect.fail(new KinChatError({ reason: "unavailable", message }));
class KinPeopleCliError extends Schema.TaggedError<KinPeopleCliError>()("KinPeopleCliError", {
  message: Schema.String,
}) {}
const isCliError = Schema.is(KinPeopleCliError);
const group = RpcGroup.make(...KinPeopleRpcs);
const AccessToken = Schema.Struct({ access_token: Schema.String });
const Ticket = Schema.Struct({ ticket: Schema.String });

/** Pairs a short-lived owner session with the running server; the scope revokes it. */
const openRemote = Effect.fn("kin.people.openRemote")(function* (origin: string) {
  // No cause: socket and fetch errors can carry the one-use ticket in their URL.
  const unreachable = new KinPeopleCliError({
    message: `Could not reach Kin's server at ${origin}. Check that it's running.`,
  });
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const tag = Buffer.from(yield* (yield* SecureRandom.SecureRandom).randomBytes(4)).toString("hex");
  const label = `Kin people CLI ${tag}`;
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
  return { client, origin };
});

const runOnHost = Effect.fn("kin.people.runOnHost")(
  function* <A, E, R>(
    flags: CliAuthLocationFlags,
    run: (remote: Effect.Success<ReturnType<typeof openRemote>>) => Effect.Effect<A, E, R>,
  ) {
    const kin = yield* KinEnabled.KinEnabled.pipe(Effect.provide(KinEnabled.layer));
    if (!kin.enabled)
      return yield* fail(
        "Kin is off on this host. Run with KIN_ENABLED=true, as the Kin server does.",
      );
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: true });
    return yield* Effect.gen(function* () {
      const state = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
      if (Option.isNone(state))
        return yield* fail(`No running Kin server uses ${config.baseDir}. Start it, then retry.`);
      return yield* run(yield* openRemote(state.value.origin));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(
          EnvironmentAuth.layerRuntime.pipe(
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, "Warn")),
          ),
          FetchHttpClient.layer,
        ),
      ),
    );
  },
  Effect.tapError((error) => (isCliError(error) ? Console.error(error.message) : Effect.void)),
);

export const peopleCommand = Command.make("people").pipe(
  Command.withSubcommands([
    Command.make("invite", {
      ...authLocationFlags,
      name: Argument.String("name"),
      url: Flag.String("url").pipe(
        Flag.optional,
        Flag.withDescription("Reachable server origin to use in the invite link."),
      ),
      org: Flag.String("org").pipe(
        Flag.withSchema(KinOrgId),
        Flag.withDefault(KinOrgId.make("kin-default")),
      ),
      person: Flag.String("person").pipe(Flag.withSchema(KinPersonId), Flag.optional),
    }).pipe(
      Command.withHandler((flags) =>
        runOnHost(flags, ({ client, origin }) =>
          Effect.gen(function* () {
            const base = yield* Effect.try({
              try: () => new URL(Option.getOrElse(flags.url, () => origin)),
              catch: () => new KinPeopleCliError({ message: "Use an http or https server URL." }),
            });
            if (!["http:", "https:"].includes(base.protocol) || base.username || base.password)
              return yield* new KinPeopleCliError({
                message: "Use an http or https server URL without credentials.",
              });
            if (["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))
              yield* Console.error(
                "This link works only on this machine. Use --url with a server address your teammate can reach.",
              );
            const invite = yield* client["kin.people.createInvite"]({
              orgId: flags.org,
              displayName: flags.name,
              ...Option.match(flags.person, {
                onNone: () => ({}),
                onSome: (personId) => ({ personId }),
              }),
            });
            const link = new URL("/kin/invite", base.origin);
            link.hash = invite.secret;
            yield* Console.log(link.href);
          }),
        ),
      ),
    ),
  ]),
);
