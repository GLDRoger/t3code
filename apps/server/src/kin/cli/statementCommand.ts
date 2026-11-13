import { KinOrgId, KinStatementRpcs } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { RpcGroup } from "effect/rpc";

import { authLocationFlags, resolveCliAuthConfig } from "../../cli/config.ts";
import * as ServerConfig from "../../config.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { readPersistedServerRuntimeState } from "../../serverRuntimeState.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuthRuntime.ts";
import * as KinEnabled from "../KinEnabled.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { readingOf } from "../work/statements/statementReading.ts";
import { reviewOf, statementRow } from "../work/statements/statementReview.ts";
import { openRemote } from "./openRemote.ts";

class KinStatementCliError extends Schema.TaggedError<KinStatementCliError>()(
  "KinStatementCliError",
  { message: Schema.String },
) {}
const isCliError = Schema.is(KinStatementCliError);
const fail = (message: string) => Effect.fail(new KinStatementCliError({ message }));
const group = RpcGroup.make(...KinStatementRpcs);

/** Where a statement stands, in counts only: never its rows, file name or account. */
const standing = Effect.fn("kin.statement.standing")(function* (
  orgId: KinOrgId,
  statementId: string,
) {
  const stored = yield* statementRow(orgId, statementId);
  if (stored === undefined) return yield* fail(`No statement ${statementId} in ${orgId}.`);
  const sql = yield* SqlClient.SqlClient;
  const [held] = yield* sql<{ n: number }>`SELECT COUNT(DISTINCT row_index) AS n
    FROM kin_bank_statement_entries WHERE org_id = ${orgId} AND statement_id = ${statementId}`;
  const review = stored.reviewJson === null ? undefined : reviewOf(stored.reviewJson);
  const reading = readingOf(stored);
  const groups = review === undefined ? [] : [...review.matches.values()];
  const count = (name: string) => groups.filter((one) => one.group === name).length;
  return reading !== undefined && stored.status === "scanned"
    ? `Waiting on its lead to read ${reading.total} pages (${reading.read} given so far).`
    : stored.status === "needs_password"
      ? "Locked: its password card waits in the chat."
      : review === undefined
        ? `Not read (${stored.status}).`
        : [
            `${review.statement.rows.length} rows, ${review.statement.check.status === "adds_up" ? "adds up" : review.statement.check.status === "off" ? "doesn't add up" : "balances unchecked"}.`,
            `On its card: ${count("matched")} matched, ${count("choose")} to choose, ${count("unmatched")} unmatched, ${review.statement.rows.length - groups.length} already recorded.`,
            `${stored.appliedAt === null ? "Not confirmed" : "Confirmed"}; ${held?.n ?? 0} rows recorded from it.`,
          ].join(" ");
});

const rereadCommand = Command.make("reread", {
  ...authLocationFlags,
  org: Flag.String("org").pipe(
    Flag.withSchema(KinOrgId),
    Flag.withDefault(KinOrgId.make("kin-default")),
  ),
  statement: Flag.String("statement").pipe(
    Flag.withDescription("The statement's id (st_…), as kin_bank_statements has it."),
  ),
  apply: Flag.Boolean("apply").pipe(
    Flag.withDescription("Do it. Without it, Kin only reports where the statement stands."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Read a statement's stored file again, as Read again on its card does: rows already recorded stay recorded, the rest go to a fresh review card or to its lead to read, and the lead is told in its chat. A locked file with no kept password gets a password card. Reports only unless --apply is given; the server must be running.",
  ),
  Command.withHandler(
    Effect.fn("kin.statement.reread")(
      function* (flags) {
        const kin = yield* KinEnabled.KinEnabled.pipe(Effect.provide(KinEnabled.layer));
        if (!kin.enabled)
          return yield* fail(
            "Kin is off on this host. Run with KIN_ENABLED=true, as the Kin server does.",
          );
        const logLevel = yield* GlobalFlag.LogLevel;
        const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: true });
        const local = KinPersistence.layer.pipe(
          Layer.provideMerge(SqlitePersistence.layerConfig),
          Layer.provideMerge(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, "Warn")),
        );
        const now = yield* standing(flags.org, flags.statement).pipe(Effect.provide(local));
        yield* Console.log(`Now: ${now}`);
        if (!flags.apply)
          return yield* Console.log("Run again with --apply to read it again and tell its lead.");
        const result = yield* Effect.gen(function* () {
          const state = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
          if (Option.isNone(state))
            return yield* fail(
              `No running Kin server uses ${config.baseDir}. Start it, then retry.`,
            );
          const client = yield* openRemote(
            state.value.origin,
            group,
            "Kin statement CLI",
            new KinStatementCliError({
              message: `Could not reach Kin's server at ${state.value.origin}. Check that it's running.`,
            }),
          );
          return yield* client["kin.work.statementReread"]({
            orgId: flags.org,
            statementId: flags.statement,
          });
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
        yield* Console.log(
          result.status === "needs_password"
            ? "Locked, and no password is kept for its account: Kin posted a password card in its chat. When the owner opens it there, the lead is told."
            : result.status === "unreadable"
              ? "Kin couldn't read the file again; nothing changed."
              : `Read again; its lead was told in its chat. ${yield* standing(flags.org, flags.statement).pipe(Effect.provide(local))}`,
        );
      },
      Effect.tapError((error) =>
        isCliError(error) || error._tag === "KinChatError"
          ? Console.error(error.message)
          : Effect.void,
      ),
    ),
  ),
);

export const statementCommand = Command.make("statement").pipe(
  Command.withDescription("Bank and card statements Kin was sent."),
  Command.withSubcommands([rereadCommand]),
);
