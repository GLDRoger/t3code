import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A removed rule is never changed again, so its last change is when it was removed.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cards = yield* sql<{ orgId: string; widgetId: string; removedAt: number }>`
    SELECT w.org_id AS "orgId", w.widget_id AS "widgetId", r.updated_at AS "removedAt"
    FROM kin_widgets w JOIN kin_mail_rules r ON r.org_id = w.org_id
      AND r.rule_id = json_extract(w.state_json, '$.decision.ruleId')
    WHERE w.type = 'mail_rule' AND r.state = 'removed'
      AND json_extract(w.state_json, '$.decision.status') = 'on'
      AND json_extract(w.state_json, '$.decision.removedAt') IS NULL`;
  for (const { orgId, widgetId, removedAt } of cards) {
    const at = DateTime.formatIso(DateTime.makeUnsafe(removedAt));
    yield* sql`UPDATE kin_widgets SET revision = revision + 1, updated_at = ${at},
      state_json = json_set(state_json, '$.decision.removedAt', ${at})
      WHERE org_id = ${orgId} AND widget_id = ${widgetId}`;
  }
});
