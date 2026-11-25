import {
  KinChatError,
  KinInviteId,
  kinIsLocalOnlyHost,
  KinPeopleCreateInviteInput,
  type KinPeopleListInvitesResult,
  KinPeopleRpcs,
  KinOrgId,
  KinPersonId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { RpcGroup } from "effect/rpc";
import { openRemote, remoteLayer } from "./openRemote.ts";

import {
  authLocationFlags,
  type CliAuthLocationFlags,
  resolveCliAuthConfig,
} from "../../cli/config.ts";
import { readPersistedServerRuntimeState } from "../../serverRuntimeState.ts";
import * as KinEnabled from "../KinEnabled.ts";

class KinPeopleCliError extends Schema.TaggedError<KinPeopleCliError>()("KinPeopleCliError", {
  message: Schema.String,
}) {
  override readonly [Runtime.errorReported] = false;
}
const fail = (message: string) => Effect.fail(new KinPeopleCliError({ message }));
const isCliError = Schema.is(KinPeopleCliError);
const isKinChatError = Schema.is(KinChatError);
/** A refusal from the host or its server becomes one plain line; defects still report in full. */
const plainly = (notFound: string) => (error: unknown) =>
  isCliError(error)
    ? error
    : new KinPeopleCliError({
        message:
          isKinChatError(error) && error.reason === "not_found"
            ? notFound
            : typeof error === "object" && error !== null && "message" in error
              ? String(error.message)
              : String(error),
      });
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
    notFound: string,
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
    }).pipe(Effect.scoped, Effect.provide(remoteLayer(config)));
  },
  (effect, _flags, notFound) => Effect.mapError(effect, plainly(notFound)),
  Effect.tapError((error) => (isCliError(error) ? Console.error(error.message) : Effect.void)),
);

const orgFlag = Flag.String("org").pipe(
  Flag.withSchema(KinOrgId),
  Flag.withDescription("The Kin organisation."),
  Flag.withDefault(KinOrgId.make("kin-default")),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const describeInvite = (invite: KinPeopleListInvitesResult["invites"][number]) =>
  `${invite.displayName} (@${invite.handle}), invite ${invite.inviteId}${invite.personId === null ? "" : `, for person ${invite.personId}`}, expires ${invite.expiresAt}`;

export const peopleCommand = Command.make("people").pipe(
  Command.withDescription(
    "Invite people to this host's Kin, and list or revoke the invites not yet accepted. Talks to the running Kin server.",
  ),
  Command.withSubcommands([
    Command.make("invites", {
      ...authLocationFlags,
      org: orgFlag,
      json: Flag.Boolean("json").pipe(
        Flag.withDescription("Emit JSON instead of human-readable output."),
        Flag.withDefault(false),
      ),
    }).pipe(
      Command.withDescription("List the org's invites that are not yet accepted or revoked."),
      Command.withHandler((flags) =>
        runOnHost(flags, `No org ${flags.org} on this host.`, ({ client }) =>
          client["kin.people.listInvites"]({ orgId: flags.org }).pipe(
            Effect.flatMap((result) =>
              Console.log(
                flags.json
                  ? encodeJson(result)
                  : result.invites.length === 0
                    ? "No open invites."
                    : result.invites.map(describeInvite).join("\n"),
              ),
            ),
          ),
        ),
      ),
    ),
    Command.make("revoke-invite", {
      ...authLocationFlags,
      id: Argument.String("id").pipe(
        Argument.withSchema(KinInviteId),
        Argument.withDescription("The invite's id, from `kin people invites`."),
      ),
      org: orgFlag,
    }).pipe(
      Command.withDescription("Revoke an invite, so its link no longer lets anyone in."),
      Command.withHandler((flags) =>
        runOnHost(flags, `No open invite ${flags.id} in org ${flags.org}.`, ({ client }) =>
          client["kin.people.revokeInvite"]({ orgId: flags.org, inviteId: flags.id }).pipe(
            Effect.flatMap(() => Console.log("Invite revoked.")),
          ),
        ),
      ),
    ),
    Command.make("invite", {
      ...authLocationFlags,
      name: Argument.String("name").pipe(
        Argument.withSchema(KinPeopleCreateInviteInput.fields.displayName),
        Argument.withDescription("The invited person's display name, up to 80 characters."),
      ),
      url: Flag.String("url").pipe(
        Flag.optional,
        Flag.withDescription("Reachable server origin to use in the invite link."),
      ),
      org: orgFlag,
      person: Flag.String("person").pipe(
        Flag.withSchema(KinPersonId),
        Flag.withDescription(
          "An existing person's id: the invite adds a device for them instead of a new person.",
        ),
        Flag.optional,
      ),
    }).pipe(
      Command.withDescription(
        "Create an invite and print its link, to send to the person yourself. The link is shown once.",
      ),
      Command.withHandler((flags) =>
        runOnHost(flags, `No org ${flags.org} on this host.`, ({ client, origin }) =>
          Effect.gen(function* () {
            const base = yield* Effect.try({
              try: () => new URL(Option.getOrElse(flags.url, () => origin)),
              catch: () => new KinPeopleCliError({ message: "Use an http or https server URL." }),
            });
            if (!["http:", "https:"].includes(base.protocol) || base.username || base.password)
              return yield* new KinPeopleCliError({
                message: "Use an http or https server URL without credentials.",
              });
            if (kinIsLocalOnlyHost(base.hostname))
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
