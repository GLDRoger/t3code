import { KinOrgId, KinPulseRead } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";

import { authLocationFlags, resolveCliAuthConfig } from "../../cli/config.ts";
import * as ServerConfig from "../../config.ts";
import * as KinEnabled from "../KinEnabled.ts";
import * as KinPulse from "../pulse/KinPulse.ts";

const encodeRead = Schema.encodeEffect(Schema.fromJsonString(KinPulseRead));

class KinPulseCliError extends Schema.TaggedError<KinPulseCliError>()("KinPulseCliError", {
  message: Schema.String,
}) {}
const isCliError = Schema.is(KinPulseCliError);
const fail = (message: string) => Effect.fail(new KinPulseCliError({ message }));

export const pulseCommand = Command.make("pulse", {
  ...authLocationFlags,
  org: Flag.String("org").pipe(
    Flag.withSchema(KinOrgId),
    Flag.withDescription("The Kin organisation to read."),
    Flag.withDefault(KinOrgId.make("kin-default")),
  ),
  at: Flag.String("at").pipe(
    Flag.withDescription("Read as of this time (ISO 8601, such as 2026-11-20T09:00+05:30)."),
    Flag.optional,
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print the read as JSON."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Print what needs attention as Kin computes it, as of now or --at. Reads the database read-only and wakes nobody: for test runs.",
  ),
  Command.withHandler(
    Effect.fn("kin.pulse")(
      function* (flags) {
        const kin = yield* KinEnabled.KinEnabled.pipe(Effect.provide(KinEnabled.layer));
        if (!kin.enabled)
          return yield* fail(
            "Kin is off on this host. Run with KIN_ENABLED=true, as the Kin server does.",
          );
        const at = Option.isNone(flags.at)
          ? yield* Clock.currentTimeMillis
          : yield* Option.match(DateTime.make(flags.at.value), {
              onNone: () =>
                fail(`--at ${flags.at.pipe(Option.getOrElse(() => ""))} is not a time.`),
              onSome: (time) => Effect.succeed(DateTime.toEpochMillis(time)),
            });
        const logLevel = yield* GlobalFlag.LogLevel;
        const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: true });
        // Read only and without setup: opening it the server's way would migrate it and write.
        const { dbPath } = yield* ServerConfig.ServerConfig.pipe(
          Effect.provide(ServerConfig.layer(config)),
        );
        const result = yield* KinPulse.read({
          orgId: flags.org,
          at,
          viewer: { _tag: "owner" },
          includeHandled: true,
          limit: 200,
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
        if (flags.json) return yield* Console.log(yield* encodeRead(result));
        yield* Console.log(
          `As of ${DateTime.formatIso(result.asOf)}: ${result.total} need attention.`,
        );
        for (const fact of result.facts)
          yield* Console.log(
            `${fact.wake.padEnd(5)} ${fact.sense.padEnd(16)} ${fact.subject.key} ${fact.subject.title}: ${fact.consequence}${fact.handled === null ? "" : ` [handled${fact.handled.until === null ? "" : ` until ${DateTime.formatIso(fact.handled.until)}`}]`}`,
          );
      },
      Effect.tapError((error) => (isCliError(error) ? Console.error(error.message) : Effect.void)),
    ),
  ),
);
