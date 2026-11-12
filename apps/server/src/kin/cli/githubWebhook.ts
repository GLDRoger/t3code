import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  KinChatError,
  KinGithubWebhookRpcs,
  KinGithubWebhookSecretInput,
  KinOrgId,
  ProjectId,
  type KinGithubWebhookOrgInput,
  type KinGithubWebhookSetup,
  type KinGithubWebhookSetupInput,
  type KinGithubWebhookStatus,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { RpcGroup } from "effect/rpc";
import { openRemote as openRemoteClient } from "./openRemote.ts";

import {
  authLocationFlags,
  type CliAuthLocationFlags,
  resolveCliAuthConfig,
} from "../../cli/config.ts";
import * as ServerConfig from "../../config.ts";
import { readPersistedServerRuntimeState } from "../../serverRuntimeState.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuthRuntime.ts";
import * as Keychain from "../github/Keychain.ts";
import * as KinGitHubApp from "../github/KinGitHubApp.ts";
import { KIN_GITHUB_APP_EVENTS, diffAppEvents } from "../github/KinGitHubPermissions.ts";
import { KinGitHubScope } from "../github/KinGitHubScope.ts";
import * as KinEnabled from "../KinEnabled.ts";

// The webhook service needs the running server's tunnel URL and orchestrator, so this CLI pairs
// with that server the way `t3 pair` does and calls the owner's `kin.webhooks.github.*` RPCs.

export class KinGithubWebhookCliError extends Schema.TaggedError<KinGithubWebhookCliError>()(
  "KinGithubWebhookCliError",
  { message: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
}

type CliEffect<A> = Effect.Effect<A, KinGithubWebhookCliError>;

/** The owner's webhook RPCs on the running server. */
export interface KinWebhookRemote {
  readonly setup: (input: KinGithubWebhookSetupInput) => CliEffect<KinGithubWebhookSetup>;
  readonly setSecret: (input: KinGithubWebhookSecretInput) => CliEffect<KinGithubWebhookSetup>;
  readonly rotate: (input: KinGithubWebhookOrgInput) => CliEffect<KinGithubWebhookSetup>;
  readonly remove: (input: KinGithubWebhookOrgInput) => CliEffect<void>;
  readonly status: (input: KinGithubWebhookOrgInput) => CliEffect<KinGithubWebhookStatus>;
}

export type KinAppEvents =
  | {
      readonly _tag: "checked";
      readonly slug: string;
      readonly missing: ReadonlyArray<string>;
      readonly extra: ReadonlyArray<string>;
    }
  | { readonly _tag: "unchecked"; readonly reason: string };

const fail = (message: string) => Effect.fail(new KinGithubWebhookCliError({ message }));
const isCliError = Schema.is(KinGithubWebhookCliError);
const isKinChatError = Schema.is(KinChatError);

const EVENT_LABELS: Record<(typeof KIN_GITHUB_APP_EVENTS)[number], string> = {
  check_suite: "Check suite",
  issue_comment: "Issue comment",
  issues: "Issues",
  pull_request: "Pull request",
  pull_request_review: "Pull request review",
  pull_request_review_comment: "Pull request review comment",
  push: "Push",
  workflow_run: "Workflow run",
};
const APP_SETTINGS =
  "On GitHub, open Settings → Developer settings → GitHub Apps → Kin's App → Edit.";
const EVENT_STEP = [
  "Under Permissions & events → Subscribe to events, tick these 8, then Save changes:",
  `     ${KIN_GITHUB_APP_EVENTS.map((event) => EVENT_LABELS[event]).join(", ")}`,
].join("\n");
const VERIFY_STEP =
  "Run `kin github webhook status`, then in Advanced → Recent Deliveries, Redeliver one and run status again.";
const CONNECT_MESSAGE =
  "GitHub events need T3 Connect on this host, and it's off. Link it (`connect link`), then run this again.";

const numbered = (steps: ReadonlyArray<string>) =>
  steps.map((step, index) => `${index + 1}. ${step}`).join("\n");

const newSecret = SecureRandom.SecureRandom.pipe(
  Effect.flatMap((random) => random.randomBytes(32)),
  Effect.map((bytes) => Redacted.make(Buffer.from(bytes).toString("hex"))),
);

/**
 * Turns GitHub events on. A source without a bound secret gets a new one, shown once on this
 * terminal: GitHub can't be told the secret while the App hook gate is closed.
 */
export const runSetup = Effect.fn("kin.github.webhook.setup")(function* (
  remote: KinWebhookRemote,
  input: {
    readonly orgId: KinOrgId;
    readonly projectId: ProjectId;
    readonly newSecret: boolean;
    readonly interactive: boolean;
  },
) {
  const before = yield* remote.status({ orgId: input.orgId });
  const result = yield* remote.setup({ orgId: input.orgId, projectId: input.projectId });
  if (result.status === "needs_connect") return yield* fail(CONNECT_MESSAGE);
  if (result.status === "configured")
    return yield* Console.log(
      `GitHub events are on. GitHub has the URL and secret.\n${numbered([APP_SETTINGS, EVENT_STEP, VERIFY_STEP])}`,
    );
  const keep = !input.newSecret && before.status === "on" && before.secretBound;
  if (keep)
    return yield* Console.log(
      [
        "GitHub events are already set up; the secret is unchanged.",
        numbered([
          APP_SETTINGS,
          `Under General → Webhook, Active is ticked and Webhook URL is\n     ${result.url}`,
          EVENT_STEP,
          VERIFY_STEP,
        ]),
        "Lost the secret? Run `kin github webhook setup --new-secret`.",
      ].join("\n"),
    );
  if (!input.interactive)
    return yield* fail(
      `GitHub events are set up at ${result.url}, but GitHub has no secret yet, so every delivery is refused. Kin shows a new secret only on a terminal: run this again in one (ssh -t), or pipe a secret you made to \`kin github webhook set-secret\`.`,
    );
  const secret = yield* newSecret;
  const saved = yield* remote.setSecret({ orgId: input.orgId, secret });
  if (saved.status === "needs_connect") return yield* fail(CONNECT_MESSAGE);
  yield* Console.log(
    [
      "GitHub events are on. Finish in GitHub's App settings:",
      numbered([
        APP_SETTINGS,
        [
          "Under General → Webhook, tick Active and set:",
          `     Webhook URL  ${saved.url}`,
          `     Secret       ${Redacted.value(secret)}`,
          "   then Save changes.",
        ].join("\n"),
        EVENT_STEP,
        VERIFY_STEP,
      ]),
      "This is the only time Kin shows the secret; it isn't logged. Lost it? Run `kin github webhook setup --new-secret`.",
    ].join("\n"),
  );
});

const decodeSecretInput = Schema.decodeUnknownEffect(KinGithubWebhookSecretInput);

/** Binds a secret the owner set in GitHub. `text` comes from stdin, never argv. */
export const runSetSecret = Effect.fn("kin.github.webhook.setSecret")(function* (
  remote: KinWebhookRemote,
  orgId: KinOrgId,
  text: string,
) {
  // The decode issue would carry the secret, so it never reaches the owner's terminal or a log.
  const input = yield* decodeSecretInput({ orgId, secret: text.trim() }).pipe(
    Effect.mapError(
      () =>
        new KinGithubWebhookCliError({
          message:
            "A webhook secret needs at least 16 characters and no whitespace. Pipe it in, for example: kin github webhook set-secret < secret-file",
        }),
    ),
  );
  const saved = yield* remote.setSecret(input);
  if (saved.status === "needs_connect") return yield* fail(CONNECT_MESSAGE);
  yield* Console.log(
    `Saved. Kin now accepts deliveries signed with this secret. GitHub's App settings must have the same one, with Webhook URL\n  ${saved.url}`,
  );
});

const runRotate = Effect.fn("kin.github.webhook.rotate")(function* (
  remote: KinWebhookRemote,
  orgId: KinOrgId,
) {
  const result = yield* remote.rotate({ orgId });
  if (result.status === "needs_connect") return yield* fail(CONNECT_MESSAGE);
  if (result.status === "configured")
    return yield* Console.log(`Rotated. GitHub has the new URL:\n  ${result.url}`);
  yield* Console.log(
    [
      "Rotated. The old URL has stopped working, so deliveries fail until GitHub has the new one.",
      numbered([
        APP_SETTINGS,
        `Under General → Webhook, set Webhook URL to\n     ${result.url}\n   then Save changes. The secret is unchanged.`,
      ]),
    ].join("\n"),
  );
});

const runRemove = Effect.fn("kin.github.webhook.remove")(function* (
  remote: KinWebhookRemote,
  orgId: KinOrgId,
) {
  yield* remote.remove({ orgId });
  yield* Console.log(
    `Removed. Kin no longer accepts GitHub events; its inbox thread stays archived for a later setup.\n${APP_SETTINGS} Under General → Webhook, untick Active, or GitHub keeps sending and logs each failure.`,
  );
});

/** Prints the source and the App's events; fails when something stops deliveries. */
export const runStatus = Effect.fn("kin.github.webhook.status")(function* (
  remote: KinWebhookRemote,
  orgId: KinOrgId,
  appEvents: Effect.Effect<KinAppEvents>,
) {
  const status = yield* remote.status({ orgId });
  const app = yield* appEvents;
  const problems: string[] = [];
  const lines: string[] = [];
  if (status.status === "off") {
    lines.push("GitHub events: off. Run `kin github webhook setup --project <project id>`.");
    problems.push("no GitHub source");
  } else {
    const last = status.lastDelivery;
    lines.push(
      `GitHub events: ${status.enabled ? "on" : "disabled"}, inbox in project ${status.projectId}`,
      `  URL            ${status.url ?? "none: T3 Connect is off on this host"}`,
      `  secret         ${status.secretBound ? "set" : "not set: every delivery is refused. Run `setup --new-secret`, or pipe one to `set-secret`."}`,
      `  last delivery  ${last === null ? "none yet" : `${last.receivedAt} ${last.outcome}${last.signatureVerified ? "" : ", signature not verified"}`}`,
    );
    if (!status.enabled) problems.push("the task is disabled");
    if (status.url === null) problems.push("T3 Connect is off");
    if (!status.secretBound) problems.push("no secret");
  }
  if (app._tag === "unchecked") {
    lines.push(`App events:      can't check: ${app.reason}`);
  } else {
    const ok = app.missing.length === 0 && app.extra.length === 0;
    lines.push(
      `App events:      ${app.slug}: ${ok ? "all 8 subscribed" : [app.missing.length > 0 ? `missing ${app.missing.join(", ")}` : "", app.extra.length > 0 ? `extra ${app.extra.join(", ")}` : ""].filter(Boolean).join("; ")}`,
    );
    if (app.missing.length > 0) problems.push("App events missing");
    if (app.extra.length > 0) problems.push("App has extra events");
  }
  yield* Console.log(lines.join("\n"));
  if (problems.length > 0) return yield* fail(`Not ready: ${problems.join(", ")}.`);
});

const appStack = (appId: Option.Option<string>) =>
  KinGitHubApp.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Option.match(appId, {
          onNone: () => KinGitHubApp.KinGitHubAppConfig.layer,
          onSome: (id) => Layer.succeed(KinGitHubApp.KinGitHubAppConfig, { appId: id }),
        }),
        KinGitHubScope.layer,
        FetchHttpClient.layer,
        Keychain.layer.pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );

const appEventsOnHost = Effect.fn("kin.github.webhook.appEvents")(
  function* (appId: Option.Option<string>) {
    const app = yield* KinGitHubApp.KinGitHubApp.pipe(
      Effect.flatMap((github) => github.app),
      Effect.provide(appStack(appId)),
    );
    return { _tag: "checked", slug: app.slug, ...diffAppEvents(app.events) } as const;
  },
  Effect.catch((error): Effect.Effect<KinAppEvents> =>
    Effect.succeed({
      _tag: "unchecked",
      reason:
        error._tag === "ConfigError"
          ? "the KIN_GITHUB_* settings aren't set in this shell. Load them with `set -a; . ~/.t3/service.env; set +a`."
          : error.message,
    }),
  ),
);

const group = RpcGroup.make(...KinGithubWebhookRpcs);
const CALL_TIMEOUT = "90 seconds";

/** Pairs a short-lived owner session with the running server; the scope revokes it. */
const openRemote = Effect.fn("kin.github.webhook.openRemote")(function* (origin: string) {
  // No cause: socket and fetch errors can carry the one-use ticket in their URL.
  const unreachable = new KinGithubWebhookCliError({
    message: `Could not reach Kin's server at ${origin}. Check that it's running.`,
  });
  const client = yield* openRemoteClient(origin, group, "Kin GitHub webhook CLI", unreachable);
  const call = <A, E>(effect: Effect.Effect<A, E>): CliEffect<A> =>
    effect.pipe(
      Effect.timeoutOrElse({ duration: CALL_TIMEOUT, orElse: () => Effect.fail(unreachable) }),
      Effect.mapError((error) =>
        isCliError(error)
          ? error
          : isKinChatError(error)
            ? new KinGithubWebhookCliError({ message: error.message })
            : unreachable,
      ),
    );
  return {
    setup: (input) => call(client["kin.webhooks.github.setup"](input)),
    setSecret: (input) => call(client["kin.webhooks.github.setSecret"](input)),
    rotate: (input) => call(client["kin.webhooks.github.rotate"](input)),
    remove: (input) => call(client["kin.webhooks.github.remove"](input)).pipe(Effect.asVoid),
    status: (input) => call(client["kin.webhooks.github.status"](input)),
  } satisfies KinWebhookRemote;
});

const runOnHost = Effect.fn("kin.github.webhook.runOnHost")(
  function* <A, E, R>(
    flags: CliAuthLocationFlags,
    run: (remote: KinWebhookRemote) => Effect.Effect<A, E, R>,
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

/** The secret from stdin: a hidden prompt on a terminal, else everything piped in. */
export const readSecret = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  if (yield* stdio.stdinIsTerminal)
    return Redacted.value(yield* Prompt.run(Prompt.Password({ message: "Webhook secret" })));
  return yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString);
});

const orgFlag = Flag.String("org").pipe(
  Flag.withSchema(KinOrgId),
  Flag.withDescription("The Kin org that receives the App's events."),
  Flag.withDefault(KinOrgId.make("kin-default")),
);

const setupCommand = Command.make("setup", {
  ...authLocationFlags,
  org: orgFlag,
  project: Flag.String("project").pipe(
    Flag.withSchema(ProjectId),
    Flag.withDescription(
      "The project Kin's GitHub inbox thread lives in, usually the agent's worker project (`kin lead list`).",
    ),
  ),
  newSecret: Flag.Boolean("new-secret").pipe(
    Flag.withDescription("Issue a new secret even if one is set, for a lost one."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Turn on GitHub events: prints the webhook URL, a new secret (once) and the events to tick in the App's settings. Needs T3 Connect.",
  ),
  Command.withHandler((flags) =>
    Effect.flatMap(
      Effect.flatMap(Stdio.Stdio, (stdio) => stdio.stdoutIsTerminal),
      (interactive) =>
        runOnHost(flags, (remote) =>
          runSetup(remote, {
            orgId: flags.org,
            projectId: flags.project,
            newSecret: flags.newSecret,
            interactive,
          }),
        ),
    ),
  ),
);

const statusCommand = Command.make("status", {
  ...authLocationFlags,
  org: orgFlag,
  appId: Flag.String("app-id").pipe(
    Flag.withDescription("The GitHub App id; defaults to KIN_GITHUB_APP_ID."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Show the webhook URL, secret, last delivery and the App's subscribed events. Fails when deliveries can't arrive.",
  ),
  Command.withHandler((flags) =>
    runOnHost(flags, (remote) => runStatus(remote, flags.org, appEventsOnHost(flags.appId))),
  ),
);

const setSecretCommand = Command.make("set-secret", { ...authLocationFlags, org: orgFlag }).pipe(
  Command.withDescription(
    "Bind the secret you set in the App's webhook settings. Reads it from stdin, never from arguments.",
  ),
  Command.withHandler((flags) =>
    Effect.flatMap(readSecret, (text) =>
      runOnHost(flags, (remote) => runSetSecret(remote, flags.org, text)),
    ),
  ),
);

const rotateCommand = Command.make("rotate", { ...authLocationFlags, org: orgFlag }).pipe(
  Command.withDescription(
    "Give the webhook a new URL. The old one stops at once; paste the new one into the App's settings.",
  ),
  Command.withHandler((flags) => runOnHost(flags, (remote) => runRotate(remote, flags.org))),
);

const removeCommand = Command.make("remove", { ...authLocationFlags, org: orgFlag }).pipe(
  Command.withDescription("Turn off GitHub events and delete the webhook."),
  Command.withHandler((flags) => runOnHost(flags, (remote) => runRemove(remote, flags.org))),
);

export const githubCommand = Command.make("github").pipe(
  Command.withDescription("Kin's GitHub App on this host."),
  Command.withSubcommands([
    Command.make("webhook").pipe(
      Command.withDescription("Send the GitHub App's events to Kin. Needs T3 Connect."),
      Command.withSubcommands([
        setupCommand,
        statusCommand,
        setSecretCommand,
        rotateCommand,
        removeCommand,
      ]),
    ),
  ]),
);
