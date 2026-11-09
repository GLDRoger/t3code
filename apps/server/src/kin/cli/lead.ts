import {
  AuthSessionId,
  KinAgentId,
  KinPersonId,
  ModelSelection,
  ProjectId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import {
  authLocationFlags,
  type CliAuthLocationFlags,
  resolveCliAuthConfig,
} from "../../cli/config.ts";
import * as ServerConfig from "../../config.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuthRuntime.ts";
import * as KinEnabled from "../KinEnabled.ts";
import type * as Provision from "../lead/KinLeadProvision.ts";

export class KinLeadCliError extends Schema.TaggedError<KinLeadCliError>()("KinLeadCliError", {
  message: Schema.String,
}) {
  override readonly [Runtime.errorReported] = false;
}

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeModel = Schema.decodeUnknownEffect(ModelSelection);

const modelFlag = (name: "strong" | "cheap") =>
  Flag.String(name).pipe(
    Flag.withDescription(
      `The lead's ${name} model as <provider instance id>:<model>, for example \`codex:gpt-5.5\`.`,
    ),
  );

const parseModel = Effect.fn("kin.lead.parseModel")(function* (
  flag: "strong" | "cheap",
  value: string,
) {
  const invalid = new KinLeadCliError({
    message: `--${flag} must be <provider instance id>:<model>, for example codex:gpt-5.5.`,
  });
  const split = value.indexOf(":");
  if (split < 1) return yield* invalid;
  return yield* decodeModel({
    instanceId: value.slice(0, split),
    model: value.slice(split + 1),
  }).pipe(Effect.mapError(() => invalid));
});

const isCliError = Schema.is(KinLeadCliError);

/** Runs a `kin lead` step against this host's database, the way `auth pairing` does. */
const runOnHost = Effect.fn("kin.lead.runOnHost")(
  function* <A, E>(
    flags: CliAuthLocationFlags & { readonly json: boolean },
    run: (
      provision: typeof Provision,
    ) => Effect.Effect<A, E, Provision.Requirements | EnvironmentAuth.EnvironmentAuth>,
  ) {
    const kin = yield* KinEnabled.KinEnabled.pipe(Effect.provide(KinEnabled.layer));
    if (!kin.enabled)
      return yield* new KinLeadCliError({
        message: "Kin is off on this host. Run with KIN_ENABLED=true, as the Kin server does.",
      });
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: flags.json });
    const provision = yield* Effect.promise(() => import("../lead/KinLeadProvision.ts"));
    const isRefusal = Schema.is(provision.KinLeadProvisionError);
    return yield* run(provision).pipe(
      Effect.tapError((error) => (isRefusal(error) ? Console.error(error.message) : Effect.void)),
      Effect.provide(
        provision.layer.pipe(
          Layer.provideMerge(EnvironmentAuth.layerRuntime),
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(
            Layer.succeed(References.MinimumLogLevel, flags.json ? "Error" : config.logLevel),
          ),
        ),
      ),
    );
  },
  Effect.tapError((error) => (isCliError(error) ? Console.error(error.message) : Effect.void)),
);

const describe = (lead: Provision.LeadSummary) =>
  [
    `${lead.name} (${lead.agentId})`,
    `  org ${lead.orgId}, level ${lead.level}, owner ${lead.ownerPersonId}`,
    `  owner chat ${lead.ownerChatId}`,
    `  strong ${lead.models.strong.instanceId}:${lead.models.strong.model}, cheap ${lead.models.cheap.instanceId}:${lead.models.cheap.model}`,
    `  worker projects ${lead.workerProjects.length === 0 ? "none" : lead.workerProjects.join(", ")}`,
    `  ${lead.retiredAt === null ? "live" : `retired ${lead.retiredAt}`}`,
  ].join("\n");

const ownerFrom = Effect.fn("kin.lead.ownerFrom")(function* (flags: {
  readonly session: Option.Option<AuthSessionId>;
  readonly person: Option.Option<KinPersonId>;
}) {
  if (Option.isSome(flags.session) === Option.isSome(flags.person))
    return yield* new KinLeadCliError({ message: "Pass exactly one of --session or --person." });
  if (Option.isSome(flags.person)) return { _tag: "person", personId: flags.person.value } as const;
  const sessionId = Option.getOrThrow(flags.session);
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = (yield* auth.listSessions()).find((row) => row.sessionId === sessionId);
  if (session === undefined)
    return yield* new KinLeadCliError({
      message: `No active session ${sessionId}. \`auth session list\` shows the active ones.`,
    });
  return {
    _tag: "session",
    session: {
      sessionId: session.sessionId,
      subject: session.subject,
      method: session.method,
      scopes: session.scopes,
      expiresAt: session.expiresAt,
    },
  } as const;
});

const workerProjectsFlag = Flag.String("worker-project").pipe(
  Flag.withSchema(ProjectId),
  Flag.withDescription("A project the lead's workers may run in. Repeat for more."),
  Flag.atLeast(0),
);

const createCommand = Command.make("create", {
  ...authLocationFlags,
  session: Flag.String("session").pipe(
    Flag.withSchema(AuthSessionId),
    Flag.withDescription(
      "A paired client's session id (`auth session list`). Its owner gets the lead.",
    ),
    Flag.optional,
  ),
  person: Flag.String("person").pipe(
    Flag.withSchema(KinPersonId),
    Flag.withDescription("The Kin owner's person id, instead of --session."),
    Flag.optional,
  ),
  name: Flag.String("name").pipe(
    Flag.withSchema(TrimmedNonEmptyString),
    Flag.withDescription("The lead's display name."),
  ),
  strong: modelFlag("strong"),
  cheap: modelFlag("cheap"),
  workerProjects: workerProjectsFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Create this host's lead at L0 with a direct chat to its owner. A re-run reports the existing lead.",
  ),
  Command.withHandler((flags) =>
    runOnHost(flags, (provision) =>
      Effect.gen(function* () {
        const models = {
          strong: yield* parseModel("strong", flags.strong),
          cheap: yield* parseModel("cheap", flags.cheap),
        };
        const owner = yield* ownerFrom(flags);
        const result = yield* provision.create({
          owner,
          name: flags.name,
          models,
          workerProjects: flags.workerProjects,
        });
        if (flags.json) return yield* Console.log(encodeJson(result));
        yield* Console.log(
          result._tag === "created"
            ? `Created lead at L0:\n${describe(result.lead)}\nPhones that are already open show its chat after they reconnect.`
            : `Org ${result.lead.orgId} already has this lead; nothing changed:\n${describe(result.lead)}`,
        );
      }),
    ),
  ),
);

const listCommand = Command.make("list", { ...authLocationFlags, json: jsonFlag }).pipe(
  Command.withDescription("List this host's leads, live and retired."),
  Command.withHandler((flags) =>
    runOnHost(flags, (provision) =>
      Effect.gen(function* () {
        const leads = yield* provision.list();
        if (flags.json) return yield* Console.log(encodeJson(leads));
        yield* Console.log(leads.length === 0 ? "No leads." : leads.map(describe).join("\n\n"));
      }),
    ),
  ),
);

const retireCommand = Command.make("retire", {
  ...authLocationFlags,
  agentId: Argument.String("agent-id").pipe(
    Argument.withSchema(KinAgentId),
    Argument.withDescription("The lead's agent id, from `kin lead list`."),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Retire a lead. Its rows stay; the server expires its queued events and ends its thread.",
  ),
  Command.withHandler((flags) =>
    runOnHost(flags, (provision) =>
      Effect.gen(function* () {
        const result = yield* provision.retire(flags.agentId);
        if (flags.json) return yield* Console.log(encodeJson(result));
        yield* Console.log(
          result._tag === "retired"
            ? `Retired ${result.lead.name} (${result.lead.agentId}). Its tool calls stop now; a running server ends its thread after the current wake-up (up to 15 minutes; pause Kin to halt it now), a stopped one when it next starts.`
            : `${result.lead.name} (${result.lead.agentId}) was already retired at ${result.lead.retiredAt}.`,
        );
      }),
    ),
  ),
);

const projectsCommand = Command.make("projects", {
  ...authLocationFlags,
  agentId: Argument.String("agent-id").pipe(
    Argument.withSchema(KinAgentId),
    Argument.withDescription("The lead's agent id, from `kin lead list`."),
  ),
  workerProjects: workerProjectsFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Replace a live lead's worker projects. Pass none to clear them. Applies to its next tool call.",
  ),
  Command.withHandler((flags) =>
    runOnHost(flags, (provision) =>
      Effect.gen(function* () {
        const result = yield* provision.setWorkerProjects(flags.agentId, flags.workerProjects);
        if (flags.json) return yield* Console.log(encodeJson(result));
        yield* Console.log(`Updated worker projects:\n${describe(result.lead)}`);
      }),
    ),
  ),
);

export const kinCommand = Command.make("kin").pipe(
  Command.withDescription("Kin host operator commands. Needs KIN_ENABLED=true."),
  Command.withSubcommands([
    Command.make("lead").pipe(
      Command.withDescription(
        "Create, list, retire and set the worker projects of this host's Kin lead.",
      ),
      Command.withSubcommands([createCommand, listCommand, retireCommand, projectsCommand]),
    ),
  ]),
);
