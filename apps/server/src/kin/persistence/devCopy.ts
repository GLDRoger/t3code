import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Kin tables `migrate-dev-db` never copies: bank alerts are read from the owner's mail. */
export const KIN_UNCOPIED_TABLES: ReadonlyArray<string> = [
  "kin_bank_alert_senders",
  "kin_bank_alerts",
];

const ALERT_CARDS = "kin-bank-alert-%";

/** A bank alert card, its taps and whatever waits on it carry the mail's words: none survive the copy. */
export const dropKinPrivateRows = Effect.fn("KinDevCopy.dropPrivateRows")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ table: string; column: string }>`
    SELECT m.name AS "table", c.name AS "column"
    FROM main.sqlite_master m, pragma_table_info(m.name, 'main') c
    WHERE m.type = 'table' AND substr(m.name, 1, 4) = 'kin_'
      AND c.name IN ('widget_id', 'message_id')
    ORDER BY m.name, c.name`;
  for (const { table, column } of columns)
    yield* sql.unsafe(`DELETE FROM main."${table}" WHERE "${column}" LIKE '${ALERT_CARDS}'`)
      .unprepared;
});
