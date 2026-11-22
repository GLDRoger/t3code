import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { KinServer } from "../KinServer.ts";
import { heldSensitiveMarks, sensitiveShown, type SensitiveMark } from "../work/sensitiveReads.ts";

/**
 * Agents' read tools, served on SQLite's reader pool so an agent's turn and a person's save don't
 * wait on each other. None may write (a write on a reader fails as readonly), except the turn's
 * "shown something sensitive" mark, held and written on the writer before the answer goes back.
 * `readTools.test.ts` runs each on a database with readers.
 */
const READS = [
  "records_query",
  "record_get",
  "client_read",
  "money_summary",
  "money_query",
  "dates_query",
  "deal_stages",
  "pulse_read",
  "pipeline_read",
  "people_read",
  "kin_leads",
  "kin_computer",
  "docs_search",
  "doc_read",
  "doc_history",
] as const;
export const KIN_READ_TOOLS: ReadonlySet<string> = new Set(READS);

/** Every Kin MCP call to a listed tool runs on a reader, its gates included. */
export const layer = McpHttpServer.toolCallAround((effect, { target }) =>
  !KIN_READ_TOOLS.has(target)
    ? effect
    : Effect.gen(function* () {
        const marks: Array<SensitiveMark> = [];
        const exit = yield* Effect.exit(
          NodeSqliteClient.readOnly(Effect.provideService(effect, heldSensitiveMarks, marks)),
        );
        if (marks.length > 0) {
          const kin = yield* Effect.serviceOption(KinServer);
          const services = Option.flatMap(kin, (one) => one.services);
          // No answer without its mark: one that can't be written fails the call.
          if (Option.isNone(services)) return yield* Effect.die("Kin is unavailable.");
          yield* Effect.forEach(marks, sensitiveShown, { discard: true }).pipe(
            Effect.provideService(
              SqlClient.SqlClient,
              Context.get(services.value, SqlClient.SqlClient),
            ),
            Effect.orDie,
          );
        }
        return yield* exit;
      }),
);
