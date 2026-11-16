import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** An agent runs on one model: each lead and company default keeps its old strong one. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of ["kin_leads", "kin_agent_defaults"])
    yield* sql`UPDATE ${sql(table)} SET models_json = json_extract(models_json, '$.strong')
      WHERE json_valid(models_json) AND json_type(models_json, '$.strong') = 'object'`;
});
