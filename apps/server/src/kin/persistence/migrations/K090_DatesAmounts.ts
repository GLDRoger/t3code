import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A Dates list takes an amount, as a renewal's fee: lists made from the preset before it did are
 * changed only by adding that, so no entry changes.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_registers
    SET definition_json = json_set(definition_json, '$.amount', json('true')), rev = rev + 1
    WHERE register_id = 'dates' AND built_in = 0
      AND json_extract(definition_json, '$.amount') = 0`;
});
