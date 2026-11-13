import { KinOrgId, KinStatementRpcs } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { RpcGroup } from "effect/rpc";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { authLocationFlags, resolveCliAuthConfig } from "../../cli/config.ts";
import * as ServerConfig from "../../config.ts";
import { readPersistedServerRuntimeState } from "../../serverRuntimeState.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuthRuntime.ts";
import * as KinEnabled from "../KinEnabled.ts";
import { standingOf } from "../work/ownerStatements.ts";
import { openRemote } from "./openRemote.ts";

class KinStatementCliError extends Schema.TaggedError<KinStatementCliError>()(
  "KinStatementCliError",
  { message: Schema.String },
) {}
const isCliError = Schema.is(KinStatementCliError);
const fail = (message: string) => Effect.fail(new KinStatementCliError({ message }));
const group = RpcGroup.make(...KinStatementRpcs);

const rereadCommand = Command.make("reread", {
  ...authLocationFlags,
  org: Flag.String("org").pipe(
    Flag.withSchema(KinOrgId),
    Flag.withDescription("The Kin organisation the statement belongs to."),
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
    "Read a statement's stored file again, as Read again on its card does: rows already recorded stay recorded, the rest go to a fresh review card or to its lead to read, and the lead is told in its chat. A locked file with no kept password gets a password card. Without --apply it only reports, reading the database read-only; --apply goes through the running server.",
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
        // Read only and without setup: opening it the server's way would migrate it and write.
        const { dbPath } = yield* ServerConfig.ServerConfig.pipe(
          Effect.provide(ServerConfig.layer(config)),
        );
        const standing = standingOf(flags.org, flags.statement).pipe(
          Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })),
        );
        yield* Console.log(`Now: ${yield* standing}`);
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
              : `Read again; its lead was told in its chat. ${yield* standing}`,
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
