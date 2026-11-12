import {
  KinChatError,
  KinInviteId,
  KinPeopleRpcs,
  KinOrgId,
  KinPersonId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { RpcGroup } from "effect/rpc";
import { openRemote } from "./openRemote.ts";

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
const openPeopleRemote = Effect.fn("kin.people.openRemote")(function* (origin: string) {
  const client = yield* openRemote(
    origin,
    group,
    "Kin people CLI",
    new KinPeopleCliError({
      message: `Could not reach Kin's server at ${origin}. Check that it's running.`,
    }),
  );
  return { client, origin };
});

const runOnHost = Effect.fn("kin.people.runOnHost")(
  function* <A, E, R>(
    flags: CliAuthLocationFlags,
    run: (remote: Effect.Success<ReturnType<typeof openPeopleRemote>>) => Effect.Effect<A, E, R>,
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
      return yield* run(yield* openPeopleRemote(state.value.origin));
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
    Command.make("invites", {
      ...authLocationFlags,
      org: Flag.String("org").pipe(
        Flag.withSchema(KinOrgId),
        Flag.withDefault(KinOrgId.make("kin-default")),
      ),
    }).pipe(
      Command.withHandler((flags) =>
        runOnHost(flags, ({ client }) =>
          client["kin.people.listInvites"]({ orgId: flags.org }).pipe(
            Effect.flatMap((result) => Console.log(JSON.stringify(result, null, 2))),
          ),
        ),
      ),
    ),
    Command.make("revoke-invite", {
      ...authLocationFlags,
      id: Argument.String("id").pipe(Argument.withSchema(KinInviteId)),
      org: Flag.String("org").pipe(
        Flag.withSchema(KinOrgId),
        Flag.withDefault(KinOrgId.make("kin-default")),
      ),
    }).pipe(
      Command.withHandler((flags) =>
        runOnHost(flags, ({ client }) =>
          client["kin.people.revokeInvite"]({ orgId: flags.org, inviteId: flags.id }).pipe(
            Effect.flatMap(() => Console.log("Invite revoked.")),
          ),
        ),
      ),
    ),
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
