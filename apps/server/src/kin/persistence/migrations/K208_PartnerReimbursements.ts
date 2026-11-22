import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Expenses gain Funded by, Reimbursement and Repaid on, all or none within 20 fields. No entry is
 * changed: an imported one that says a partner paid stays counted as before until the owner says
 * who it was and whether it is still owed (Money, `kin.work.matchPartner`).
 */

const ADDED = [
  { key: "fundedBy", label: "Funded by", type: "person", sensitive: false },
  {
    key: "reimbursement",
    label: "Reimbursement",
    type: "choice",
    choices: ["owed", "repaid", "not reimbursable"],
    sensitive: false,
  },
  { key: "repaidOn", label: "Repaid on", type: "date", sensitive: false },
] as const;
const MAX_FIELDS = 20;

const Definition = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({
      fields: Schema.Array(
        Schema.StructWithRest(Schema.Struct({ key: Schema.Unknown, label: Schema.Unknown }), [
          Schema.Record(Schema.String, Schema.Unknown),
        ]),
      ),
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
);
const decodeDefinition = Schema.decodeUnknownOption(Definition);
const encodeDefinition = Schema.encodeEffect(Definition);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const lists = yield* sql<{ orgId: string; json: string }>`SELECT org_id AS "orgId",
      definition_json AS json
    FROM kin_registers WHERE register_id = 'expenses' AND built_in = 0 ORDER BY org_id`;
  for (const list of lists) {
    const decoded = decodeDefinition(list.json);
    if (Option.isNone(decoded)) continue;
    const definition = decoded.value;
    const missing = ADDED.filter((one) =>
      definition.fields.every((field) => field.key !== one.key),
    );
    if (missing.length === 0 || definition.fields.length + missing.length > MAX_FIELDS) continue;
    const json = yield* encodeDefinition({
      ...definition,
      fields: [...definition.fields, ...missing],
    }).pipe(Effect.orDie);
    yield* sql`UPDATE kin_registers SET definition_json = ${json}, rev = rev + 1
      WHERE org_id = ${list.orgId} AND register_id = 'expenses' AND built_in = 0`;
  }
});
