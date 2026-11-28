import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_widgets AS w
    SET revision = w.revision + 1, state_json = json_set(w.state_json, '$.monthlyCap', r.monthly_cap)
    FROM kin_mail_rules r
    WHERE w.org_id = r.org_id AND w.type = 'mail_rule' AND r.state = 'removed'
      AND r.rule_id = json_extract(w.state_json, '$.decision.ruleId')
      AND json_extract(w.state_json, '$.decision.status') = 'on'
      AND json_extract(w.state_json, '$.decision.removedAt') IS NOT NULL
      AND json_extract(w.state_json, '$.monthlyCap') IS NOT r.monthly_cap`;
});
