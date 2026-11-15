import type {
  KinConnection,
  KinConnectionId,
  KinConnectionPreset,
  KinConnectionReach,
  KinConnectionState,
  KinConnectionTool,
  KinConnectionToolDefinition,
  KinConnectionToolMode,
  KinOrgId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as SqlClient from "effect/sql/SqlClient";

export type ConnectionRow = {
  readonly connectionId: KinConnectionId;
  readonly preset: KinConnectionPreset | null;
  readonly label: string;
  readonly kind: "remote" | "builtin";
  readonly url: string | null;
  readonly urlHost: string;
  readonly auth: "none" | "key" | "oauth";
  readonly authHeader: string | null;
  readonly reach: KinConnectionReach;
  readonly state: KinConnectionState;
  readonly accountLabel: string | null;
  readonly protocolVersion: string | null;
  readonly instructionsText: string | null;
  readonly instructionsDigest: string | null;
  readonly instructionsAcceptedText: string | null;
  readonly instructionsAcceptedDigest: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly listedAt: number | null;
  readonly lastOkAt: number | null;
  readonly lastError: string | null;
  readonly pausedAt: number | null;
  readonly removedAt: number | null;
};

export type ToolRow = {
  readonly connectionId: KinConnectionId;
  readonly name: string;
  readonly definitionJson: string;
  readonly acceptedJson: string | null;
  readonly pinDigest: string;
  readonly acceptedDigest: string | null;
  readonly mode: KinConnectionToolMode;
  readonly suggestedMode: KinConnectionToolMode;
  readonly openWorld: number;
  readonly firstSeenAt: number;
  readonly changedAt: number | null;
  readonly acceptedAt: number | null;
  readonly removedAt: number | null;
};

/** Callable: on, not removed, and listed exactly as the owner accepted it. */
export const callable = (tool: ToolRow) =>
  tool.mode !== "off" && tool.removedAt === null && tool.pinDigest === tool.acceptedDigest;
/** Changed since the owner accepted it; a tool never accepted is new, not changed. */
export const changed = (tool: ToolRow) =>
  tool.removedAt === null && tool.acceptedDigest !== null && tool.pinDigest !== tool.acceptedDigest;

const connectionColumns = (sql: SqlClient.SqlClient) => sql`connection_id AS "connectionId",
  preset, label, kind, url, url_host AS "urlHost", auth, auth_header AS "authHeader", reach,
  state, account_label AS "accountLabel", protocol_version AS "protocolVersion",
  instructions_text AS "instructionsText", instructions_digest AS "instructionsDigest",
  instructions_accepted_text AS "instructionsAcceptedText",
  instructions_accepted_digest AS "instructionsAcceptedDigest", created_at AS "createdAt",
  updated_at AS "updatedAt", listed_at AS "listedAt", last_ok_at AS "lastOkAt",
  last_error AS "lastError", paused_at AS "pausedAt", removed_at AS "removedAt"`;

const toolColumns = (sql: SqlClient.SqlClient) => sql`connection_id AS "connectionId",
  tool_name AS name, definition_json AS "definitionJson", accepted_json AS "acceptedJson",
  pin_digest AS "pinDigest", accepted_digest AS "acceptedDigest", mode,
  suggested_mode AS "suggestedMode", open_world AS "openWorld", first_seen_at AS "firstSeenAt",
  changed_at AS "changedAt", accepted_at AS "acceptedAt", removed_at AS "removedAt"`;

export const liveConnections = Effect.fn("KinConnectionRows.live")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<ConnectionRow>`SELECT ${connectionColumns(sql)} FROM kin_connections
    WHERE org_id = ${orgId} AND removed_at IS NULL ORDER BY created_at, connection_id`;
});

export const connectionById = Effect.fn("KinConnectionRows.byId")(function* (
  orgId: KinOrgId,
  connectionId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<ConnectionRow>`SELECT ${connectionColumns(sql)} FROM kin_connections
    WHERE org_id = ${orgId} AND connection_id = ${connectionId} AND removed_at IS NULL
    ORDER BY connection_id`;
  return row;
});

export const toolsOf = Effect.fn("KinConnectionRows.tools")(function* (
  orgId: KinOrgId,
  connectionId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<ToolRow>`SELECT ${toolColumns(sql)} FROM kin_connection_tools
    WHERE org_id = ${orgId} AND connection_id = ${connectionId} ORDER BY tool_name`;
});

/**
 * The live connection an agent named: by id, else by label or service, ignoring case. Several
 * matches are `ambiguous`, so a guess never picks one.
 */
export const resolveConnection = Effect.fn("KinConnectionRows.resolve")(function* (
  orgId: KinOrgId,
  name: string,
) {
  const live = yield* liveConnections(orgId);
  const byId = live.find((row) => row.connectionId === name);
  if (byId !== undefined) return { _tag: "found" as const, row: byId };
  const wanted = name.trim().toLowerCase();
  const matches = live.filter((row) => row.label.toLowerCase() === wanted || row.preset === wanted);
  if (matches.length === 1) return { _tag: "found" as const, row: matches[0]! };
  return { _tag: matches.length === 0 ? ("missing" as const) : ("ambiguous" as const), live };
});

const field = (value: unknown, name: string) =>
  Predicate.hasProperty(value, name) ? value[name] : undefined;
const text = (value: unknown) => (typeof value === "string" ? value : null);

const definition = (json: string | null): KinConnectionToolDefinition | null => {
  if (json === null) return null;
  const tool: unknown = JSON.parse(json);
  return {
    name: String(field(tool, "name")),
    title: text(field(tool, "title")),
    description: text(field(tool, "description")),
    inputSchema: field(tool, "inputSchema"),
    annotations: field(tool, "annotations") ?? null,
  };
};

export const toolView = (row: ToolRow): KinConnectionTool => ({
  connectionId: row.connectionId,
  name: row.name,
  definition: definition(row.definitionJson)!,
  accepted: definition(row.acceptedJson),
  pinDigest: row.pinDigest,
  mode: row.mode,
  suggestedMode: row.suggestedMode,
  openWorld: row.openWorld === 1,
  changed: changed(row),
  firstSeenAt: row.firstSeenAt,
  changedAt: row.changedAt,
  acceptedAt: row.acceptedAt,
  removedAt: row.removedAt,
});

export const connectionView = (
  row: ConnectionRow,
  tools: ReadonlyArray<ToolRow>,
): KinConnection => ({
  connectionId: row.connectionId,
  preset: row.preset,
  label: row.label,
  kind: row.kind,
  url: row.url,
  urlHost: row.urlHost,
  auth: row.auth,
  reach: row.reach,
  state: row.state,
  paused: row.pausedAt !== null,
  accountLabel: row.accountLabel,
  protocolVersion: row.protocolVersion,
  instructions: row.instructionsText,
  instructionsDigest: row.instructionsDigest,
  acceptedInstructions: row.instructionsAcceptedText,
  changedTools: tools.filter(changed).length,
  readTools: tools.filter((tool) => callable(tool) && tool.mode === "read").length,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  listedAt: row.listedAt,
  lastOkAt: row.lastOkAt,
  lastError: row.lastError,
});

const TOOL_NAME = /^[\w.-]{1,64}$/;
const PROMPT_TOOLS = 8;

/**
 * The owner-only prompt's line on what is connected: each live connection's label, account,
 * how many tools agents may read with and up to eight of their names. `undefined` with none.
 */
export const promptLine = Effect.fn("KinConnectionRows.promptLine")(function* (orgId: KinOrgId) {
  const rows = yield* liveConnections(orgId);
  if (rows.length === 0) return undefined;
  const parts = yield* Effect.forEach(rows, (row) =>
    toolsOf(orgId, row.connectionId).pipe(
      Effect.map((tools) => {
        const read = tools.filter((tool) => callable(tool) && tool.mode === "read");
        // Names are the server's: only plain identifiers reach the prompt unquoted.
        const names = read.map((tool) => tool.name).filter((name) => TOOL_NAME.test(name));
        const shown = names.slice(0, PROMPT_TOOLS).join(", ");
        const more = names.length > PROMPT_TOOLS ? ", …" : "";
        const who = `${JSON.stringify(row.label)}${row.accountLabel === null ? "" : ` ${JSON.stringify(row.accountLabel)}`}`;
        return row.pausedAt !== null || row.state === "needs_sign_in" || row.state === "error"
          ? `${who} (not reachable now)`
          : `${who} (read: ${read.length} tools${read.length === 0 ? "" : `: ${shown}${more}`})`;
      }),
    ),
  );
  return `Connected services, reached with kin_connection_tools and kin_connection_call: ${parts.join("; ")}.`;
});
