import type * as SqlClient from "effect/sql/SqlClient";

/**
 * Whether the alert or approval row `alias` names is in a mailbox that is connected now: signed
 * in, not removed or paused, and allowed to read a thread.
 */
export const connectedNow = (sql: SqlClient.SqlClient, alias: "a" | "s") =>
  sql.unsafe(`EXISTS (SELECT 1 FROM kin_connections c WHERE c.org_id = ${alias}.org_id
    AND c.connection_id = ${alias}.connection_id AND c.removed_at IS NULL AND c.paused_at IS NULL
    AND c.state = 'active' AND EXISTS (SELECT 1 FROM kin_connection_tools t
      WHERE t.org_id = c.org_id AND t.connection_id = c.connection_id
        AND t.tool_name = 'mail_read_thread' AND t.mode = 'read' AND t.removed_at IS NULL))`);
