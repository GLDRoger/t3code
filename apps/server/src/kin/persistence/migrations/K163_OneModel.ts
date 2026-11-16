import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * An agent runs on one model: each lead and company default keeps its old strong one. The old
 * `strong` and `cheap` stay beside it for Workers.ts alone, until that is deleted.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of ["kin_leads", "kin_agent_defaults"])
    yield* sql`UPDATE ${sql(table)} SET models_json = json_set(json_extract(models_json, '$.strong'),
        '$.strong', json_extract(models_json, '$.strong'), '$.cheap', json_extract(models_json, '$.cheap'))
      WHERE json_valid(models_json) AND json_type(models_json, '$.strong') = 'object'`;
});
