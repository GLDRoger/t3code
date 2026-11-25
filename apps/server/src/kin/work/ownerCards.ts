import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ownerLevelSql } from "../people/KinAccess.ts";

/**
 * How an owner or co-owner answered a choice card, from its stored state: the option's own kind,
 * never the label or anything a lead wrote. `undefined` while unanswered or answered by anyone else.
 */
export const cardAnswer = Effect.fn("KinOwnerCards.answer")(function* (
  orgId: KinOrgId,
  widgetId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ kind: string | null }>`SELECT (SELECT json_extract(o.value, '$.kind')
        FROM json_each(w.state_json, '$.options') o
        WHERE json_extract(o.value, '$.optionId') = json_extract(w.state_json, '$.answer.optionId'))
      AS kind
    FROM kin_widgets w WHERE w.org_id = ${orgId} AND w.widget_id = ${widgetId}
      AND w.type = 'choice' AND ${sql.literal(
        ownerLevelSql("w.org_id", "json_extract(w.state_json, '$.answer.personId')"),
      )}`;
  return row === undefined ? undefined : row.kind === "yes" ? ("yes" as const) : ("no" as const);
});
