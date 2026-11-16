// @effect-diagnostics nodeBuiltinImport:off - an operator command reads the owner's files on the host.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { KinAgentId, KinOrgId } from "@t3tools/contracts";
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
import { characters, setCharacter } from "../lead/characters.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinRecords from "../work/KinRecords.ts";
import { announceToServer, cliChanges } from "./announce.ts";

class KinCharacterCliError extends Schema.TaggedError<KinCharacterCliError>()(
  "KinCharacterCliError",
  { message: Schema.String },
) {}
const isCliError = Schema.is(KinCharacterCliError);

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Which file in the folder is whose: `<domain>.md`, else the agent's name as a slug. */
const fileFor = (dir: string, files: ReadonlySet<string>, lead: { domain: string; name: string }) =>
  [`${lead.domain}.md`, `${slug(lead.name)}.md`]
    .filter((file) => files.has(file))
    .map((file) => NodePath.join(dir, file))[0];

export const characterCommand = Command.make("character", {
  ...authLocationFlags,
  agent: Flag.String("agent").pipe(
    Flag.withSchema(KinAgentId),
    Flag.withDescription("The agent's id, from `kin lead list`."),
    Flag.optional,
  ),
  file: Flag.String("file").pipe(
    Flag.withDescription("A Markdown file on this host to set as that agent's character."),
    Flag.optional,
  ),
  fromDir: Flag.String("from-dir").pipe(
    Flag.withDescription(
      "A folder of <domain>.md (or <agent-name>.md) files: sets each live agent's character from its file.",
    ),
    Flag.optional,
  ),
  org: Flag.String("org").pipe(
    Flag.withSchema(KinOrgId),
    Flag.withDefault(KinOrgId.make("kin-default")),
  ),
}).pipe(
  Command.withDescription(
    "Show or set agents' characters. Each set is a new version of the agent's character doc, so its history can bring back the one before.",
  ),
  Command.withHandler(
    Effect.fn("kin.lead.character")(
      function* (flags) {
        const kin = yield* KinEnabled.KinEnabled.pipe(Effect.provide(KinEnabled.layer));
        if (!kin.enabled)
          return yield* new KinCharacterCliError({
            message: "Kin is off on this host. Run with KIN_ENABLED=true, as the Kin server does.",
          });
        if (Option.isSome(flags.file) && Option.isNone(flags.agent))
          return yield* new KinCharacterCliError({ message: "--file needs --agent <agent id>." });
        const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel, {
          quietLogs: true,
        });
        const changes = cliChanges();
        const lines = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const leads = yield* sql<{ agentId: string; name: string; domain: string }>`
            SELECT l.agent_id AS "agentId", l.name, l.domain FROM kin_leads l
            JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
            WHERE l.org_id = ${flags.org} AND a.role = 'lead' AND a.retired_at IS NULL
            ORDER BY a.created_at, l.agent_id`;
          const wanted: Array<{ agentId: string; name: string; file: string }> = [];
          if (Option.isSome(flags.fromDir)) {
            const dir = flags.fromDir.value;
            const files = new Set(NodeFS.readdirSync(dir));
            for (const lead of leads) {
              const file = fileFor(dir, files, lead);
              if (file !== undefined) wanted.push({ ...lead, file });
            }
            if (wanted.length === 0)
              return [`No file in ${dir} matches a live agent's domain or name.`];
          } else if (Option.isSome(flags.file) && Option.isSome(flags.agent)) {
            const agentId = flags.agent.value;
            const lead = leads.find((one) => one.agentId === agentId);
            if (lead === undefined) return [`No live agent ${agentId}.`];
            wanted.push({ ...lead, file: flags.file.value });
          }
          const out: Array<string> = [];
          for (const one of wanted) {
            const body = NodeFS.readFileSync(one.file, "utf8");
            const done = yield* setCharacter(flags.org, KinAgentId.make(one.agentId), body);
            out.push(
              done.outcome === "no-agent"
                ? `${one.name}: no character doc could be made.`
                : `${one.name}: ${done.outcome === "set" ? "set" : "already this text"} (doc ${done.key}, from ${one.file}).`,
            );
          }
          if (wanted.length > 0) {
            changes.records(flags.org);
            return out;
          }
          return (yield* characters(flags.org)).map(
            (one) =>
              `${one.name} (${one.agentId}, doc ${one.key}): ${
                one.body
                  .split("\n")
                  .find((line) => line.trim() !== "" && !line.startsWith("#"))
                  ?.slice(0, 100) ?? ""
              }`,
          );
        }).pipe(
          Effect.provide(
            KinRecords.layer.pipe(
              Layer.provideMerge(KinEventQueue.layer),
              Layer.provideMerge(KinPersistence.layer),
              Layer.provideMerge(SqlitePersistence.layerConfig),
              Layer.provideMerge(ServerConfig.layer(config)),
              Layer.provide(changes.layer),
              Layer.provide(Layer.succeed(References.MinimumLogLevel, "Warn")),
            ),
          ),
        );
        yield* announceToServer(config, changes.all());
        yield* Console.log(lines.join("\n"));
      },
      Effect.tapError((error) =>
        isCliError(error) || error._tag === "KinChatError"
          ? Console.error(error.message)
          : Effect.void,
      ),
    ),
  ),
);
