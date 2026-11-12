import { type KinImportReport, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Command, Flag, GlobalFlag } from "effect/cli";

import { authLocationFlags, resolveCliAuthConfig } from "../../cli/config.ts";
import * as ServerConfig from "../../config.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as KinEnabled from "../KinEnabled.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { isOrgOwner } from "../lead/orgState.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { formatMoney } from "../work/money.ts";
import * as KinImport from "../work/KinImport.ts";
import * as KinRecords from "../work/KinRecords.ts";

class KinImportCliError extends Schema.TaggedError<KinImportCliError>()("KinImportCliError", {
  message: Schema.String,
}) {}
const isCliError = Schema.is(KinImportCliError);
const encodeReport = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** The org's owner: the one person whose agents these are, or the one asked for. */
const ownerOf = Effect.fn("kin.import.owner")(function* (
  orgId: KinOrgId,
  asked: Option.Option<KinPersonId>,
) {
  const sql = yield* SqlClient.SqlClient;
  const candidates = Option.isSome(asked)
    ? [asked.value]
    : (yield* sql<{ personId: string }>`SELECT DISTINCT owner_person_id AS "personId"
          FROM kin_agents WHERE org_id = ${orgId} ORDER BY owner_person_id`).map((row) =>
        KinPersonId.make(row.personId),
      );
  const fallback = candidates.length === 0 ? [KinPersonId.make(`${orgId}-owner`)] : candidates;
  const [person] = fallback;
  if (fallback.length !== 1 || person === undefined || !(yield* isOrgOwner(orgId, person)))
    return yield* new KinImportCliError({
      message: `Kin can't tell who owns ${orgId}. Pass --person with the owner's person id.`,
    });
  return person;
});

const counts = (name: string, one: KinImportReport["entries"]) =>
  `${name}: ${one.create} new, ${one.unchanged} already imported, ${one.matched} matched by name, ${one.changed} changed in Kin since (left alone), ${one.problems} with problems`;

/** The report as an operator reads it in a terminal. */
const describeReport = (report: KinImportReport) =>
  [
    `${report.applied ? "Imported" : "Plan for"} batch ${report.batch}${report.asOf === null ? "" : `, kept up until ${report.asOf}`}.`,
    ...report.lists.map(
      (one) =>
        `List ${one.name}: ${one.action}${one.adds.length === 0 ? "" : ` (${one.adds.join(", ")})`}`,
    ),
    ...report.company.map((one) => `Company ${one.field}: ${one.action}`),
    counts("Clients", report.clients),
    counts("Projects", report.projects),
    counts("Entries", report.entries),
    counts("Payments", report.payments),
    counts("Files", report.files),
    ...report.money.map(
      (one) =>
        `Money in ${one.list}: ${one.entries} entries, ${formatMoney(one.total)}, ${formatMoney(one.paid)} paid`,
    ),
    ...report.stale.map(
      (one) =>
        `Open in ${one.list} from before ${report.asOf}: ${one.open}${one.oldest === null ? "" : `, oldest ${one.oldest}`}`,
    ),
    ...report.changed.map((one) => `Changed in Kin since: ${one.key} (${one.source})`),
    ...report.problems.map(
      (one) =>
        `Problem in ${one.section}${one.source === null ? "" : ` ${one.source}`}: ${one.reason}`,
    ),
    ...(report.moreProblems === 0 ? [] : [`And ${report.moreProblems} more problems.`]),
  ].join("\n");

export const importCommand = Command.make("import", {
  ...authLocationFlags,
  file: Flag.String("file").pipe(
    Flag.withDescription(
      "A folder holding import.json and files/, or a ZIP of them. See the moving-in guide for the format.",
    ),
  ),
  apply: Flag.Boolean("apply").pipe(
    Flag.withDescription("Keep the import. Without it, Kin only reports what it would do."),
    Flag.withDefault(false),
  ),
  org: Flag.String("org").pipe(
    Flag.withSchema(KinOrgId),
    Flag.withDefault(KinOrgId.make("kin-default")),
  ),
  person: Flag.String("person").pipe(
    Flag.withSchema(KinPersonId),
    Flag.withDescription("The owner's person id, when Kin can't tell it from the org."),
    Flag.optional,
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print the report as JSON."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Move records from another system into this host's Kin: clients, projects, list entries, payments and files. Runs a plan unless --apply is given; a rerun adds only what is new.",
  ),
  Command.withHandler(
    Effect.fn("kin.import.run")(
      function* (flags) {
        const kin = yield* KinEnabled.KinEnabled.pipe(Effect.provide(KinEnabled.layer));
        if (!kin.enabled)
          return yield* new KinImportCliError({
            message: "Kin is off on this host. Run with KIN_ENABLED=true, as the Kin server does.",
          });
        const logLevel = yield* GlobalFlag.LogLevel;
        const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: flags.json });
        const report = yield* Effect.gen(function* () {
          const owner = yield* ownerOf(flags.org, flags.person);
          const imports = yield* KinImport.KinImport;
          const bundle = yield* imports.fromHost(flags.file);
          return yield* (flags.apply ? imports.apply : imports.plan)(flags.org, owner, bundle);
        }).pipe(
          Effect.provide(
            KinImport.layer.pipe(
              Layer.provideMerge(KinRecords.layer),
              Layer.provideMerge(KinEventQueue.layer),
              Layer.provideMerge(KinPersistence.layer),
              Layer.provideMerge(SqlitePersistence.layerConfig),
              Layer.provideMerge(ServerConfig.layer(config)),
              Layer.provide(Layer.succeed(References.MinimumLogLevel, "Warn")),
            ),
          ),
        );
        yield* Console.log(flags.json ? encodeReport(report) : describeReport(report));
      },
      Effect.tapError((error) =>
        isCliError(error) || error._tag === "KinChatError"
          ? Console.error(error.message)
          : Effect.void,
      ),
    ),
  ),
);
