import { KinApprovalError, KinKeyThumbprint } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import {
  authLocationFlags,
  type CliAuthLocationFlags,
  resolveCliAuthConfig,
} from "../../cli/config.ts";
import * as ServerConfig from "../../config.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as Audit from "../approvals/Audit.ts";
import * as KeySeal from "../approvals/KeySeal.ts";
import type { KinPendingEnrolment } from "../approvals/HostKeyCeremony.ts";
import * as KinEnabled from "../KinEnabled.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";

export class KinApprovalsCliError extends Schema.TaggedError<KinApprovalsCliError>()(
  "KinApprovalsCliError",
  { message: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
}

const HARDWARE: Record<string, string> = {
  secure_enclave: "Secure Enclave",
  strongbox: "StrongBox",
  tee: "TEE",
};

const at = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);
const isRefusal = Schema.is(KinApprovalError);
const isCliError = Schema.is(KinApprovalsCliError);

const describe = (enrolment: KinPendingEnrolment, index: number) =>
  [
    `${index + 1}) ${enrolment.deviceLabel} (${enrolment.platform}, ${HARDWARE[enrolment.hardware] ?? enrolment.hardware}, attested)`,
    `   key      ${enrolment.thumbprint}`,
    `   org      ${enrolment.orgId}, person ${enrolment.humanId}`,
    `   session  ${enrolment.sessionId} (${enrolment.sessionSubject ?? "unknown"}${enrolment.sessionClient === null ? "" : `, ${enrolment.sessionClient}`})`,
    `   created  ${at(enrolment.createdAt)}; the code works until ${at(enrolment.expiresAt)}, ${enrolment.attemptsLeft} ${enrolment.attemptsLeft === 1 ? "try" : "tries"} left`,
  ].join("\n");

const normalizeCode = (value: string) => value.replace(/\s+/g, "");

/** Opens this host's database and secrets as the server's OS user, the way `kin lead` does. */
const runOnHost = Effect.fn("kin.approvals.runOnHost")(
  function* <A, E, R>(
    flags: CliAuthLocationFlags,
    run: (ceremony: typeof import("../approvals/HostKeyCeremony.ts")) => Effect.Effect<A, E, R>,
  ) {
    const kin = yield* KinEnabled.KinEnabled.pipe(Effect.provide(KinEnabled.layer));
    if (!kin.enabled)
      return yield* new KinApprovalsCliError({
        message: "Kin is off on this host. Run with KIN_ENABLED=true, as the Kin server does.",
      });
    const logLevel = yield* GlobalFlag.LogLevel;
    // Migration and startup logs would bury the list the owner reads; warnings still show.
    const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: true });
    const ceremony = yield* Effect.promise(() => import("../approvals/HostKeyCeremony.ts"));
    return yield* run(ceremony).pipe(
      // A refusal is an answer for the owner, printed once below, not a crash with a trace.
      Effect.mapError((error) =>
        isRefusal(error) ? new KinApprovalsCliError({ message: error.message }) : error,
      ),
      Effect.provide(
        ceremony.layer.pipe(
          Layer.provide(Layer.merge(Audit.layer, KeySeal.layer)),
          Layer.provide(KinPersistence.layer),
          Layer.provideMerge(
            Layer.mergeAll(ServerSecretStore.layer, SqlitePersistence.layerConfig),
          ),
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, "Warn")),
        ),
      ),
    );
  },
  Effect.tapError((error) => (isCliError(error) ? Console.error(error.message) : Effect.void)),
);

const pick = Effect.fn("kin.approvals.pick")(function* (
  pending: ReadonlyArray<KinPendingEnrolment>,
  key: Option.Option<KinKeyThumbprint>,
) {
  if (Option.isSome(key)) {
    const found = pending.find((enrolment) => enrolment.thumbprint === key.value);
    if (found === undefined)
      return yield* new KinApprovalsCliError({
        message: `No phone is waiting with key ${key.value}.`,
      });
    return found;
  }
  if (pending.length === 1) return pending[0]!;
  if (!interactive())
    return yield* new KinApprovalsCliError({
      message: "Several phones are waiting. Pass --key with the one to confirm.",
    });
  return yield* Prompt.run(
    Prompt.Select({
      message: "Which phone is yours?",
      choices: pending.map((enrolment, index) => ({
        title: `${index + 1}) ${enrolment.deviceLabel}, key ${enrolment.thumbprint.slice(0, 12)}…`,
        value: enrolment,
      })),
    }),
  );
});

const askCode = Effect.fn("kin.approvals.askCode")(function* (flag: Option.Option<string>) {
  if (Option.isSome(flag)) return normalizeCode(flag.value);
  if (!interactive())
    return yield* new KinApprovalsCliError({
      message: "Pass --code with the 6 digits the phone shows.",
    });
  const typed = yield* Prompt.run(
    Prompt.String({
      message: "The 6-digit code on the phone",
      validate: (value: string) =>
        /^\d{6}$/.test(normalizeCode(value))
          ? Effect.succeed(value)
          : Effect.fail("Type the 6 digits the phone shows."),
    }),
  );
  return normalizeCode(typed);
});

const confirmKeyCommand = Command.make("confirm-key", {
  ...authLocationFlags,
  key: Flag.String("key").pipe(
    Flag.withSchema(KinKeyThumbprint),
    Flag.withDescription("The waiting key's thumbprint, from the list. Needed when several wait."),
    Flag.optional,
  ),
  code: Flag.String("code").pipe(
    Flag.withDescription("The 6-digit code the phone shows. Asked for when omitted."),
    Flag.optional,
  ),
  recover: Flag.Boolean("recover").pipe(
    Flag.withDescription(
      "Lost phone: also revoke this person's other approver keys, then activate this one. Audited.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Allow a phone to approve, from the Kin host: lists the phones waiting, then takes the code one shows. The usual way is Allow in Kin on the web or desktop, under Settings, then Approvals.",
  ),
  Command.withHandler((flags) =>
    runOnHost(flags, (module) =>
      Effect.gen(function* () {
        const ceremony = yield* module.KinHostKeyCeremony;
        const pending = yield* ceremony.listPending();
        if (pending.length === 0)
          return yield* new KinApprovalsCliError({
            message:
              "No phone is waiting. On the phone, open Kin, then Approvals, and tap Set up approvals.",
          });
        yield* Console.log(
          `Phones waiting for this host:\n\n${pending.map(describe).join("\n\n")}\n`,
        );
        const chosen = yield* pick(pending, flags.key);
        const code = yield* askCode(flags.code);
        const result = yield* ceremony.confirm({
          orgId: chosen.orgId,
          thumbprint: chosen.thumbprint,
          sessionId: chosen.sessionId,
          code,
          recover: flags.recover,
        });
        yield* Console.log(
          [
            `Confirmed. ${result.key.deviceLabel} can approve for ${result.key.orgId}.`,
            ...result.revoked.map((thumbprint) => `Revoked ${thumbprint}.`),
            "On the phone, tap I've entered it.",
          ].join("\n"),
        );
      }),
    ),
  ),
);

export const approvalsCommand = Command.make("approvals").pipe(
  Command.withDescription("Confirm phones that approve Kin's privileged actions."),
  Command.withSubcommands([confirmKeyCommand]),
);
