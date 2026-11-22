import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Expenses gain Funded by, Reimbursement and Repaid on, all or none within 20 fields; an import's
 * `paidFrom` (where an entry came from) reads Source. Kin keeps no person's address, so a Paid
 * entry an import left `paidPersonallyBy` on is marked owed and matched to nobody, on its history.
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
const OWED_CHANGE = JSON.stringify([{ field: "reimbursement", from: null, to: "owed" }]);

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
  const now = yield* Clock.currentTimeMillis;
  const lists = yield* sql<{ orgId: string; json: string }>`SELECT org_id AS "orgId",
      definition_json AS json
    FROM kin_registers WHERE register_id = 'expenses' AND built_in = 0 ORDER BY org_id`;
  for (const list of lists) {
    const decoded = decodeDefinition(list.json);
    if (Option.isNone(decoded)) continue;
    const definition = decoded.value;
    const fields = definition.fields;
    const missing = ADDED.filter((one) => fields.every((field) => field.key !== one.key));
    const fits = fields.length + missing.length <= MAX_FIELDS;
    const renames = fields.some((field) => field.key === "paidFrom" && field.label === "Paid from");
    const next = [
      ...fields.map((field) =>
        field.key === "paidFrom" && field.label === "Paid from"
          ? { ...field, label: "Source" }
          : field,
      ),
      ...(fits ? missing : []),
    ];
    if (renames || (fits && missing.length > 0)) {
      const json = yield* encodeDefinition({ ...definition, fields: next }).pipe(Effect.orDie);
      yield* sql`UPDATE kin_registers SET definition_json = ${json}, rev = rev + 1
        WHERE org_id = ${list.orgId} AND register_id = 'expenses' AND built_in = 0`;
    }
    // A list's own `reimbursement` of another kind keeps what it holds.
    const marks = next.some(
      (field) =>
        field.key === "reimbursement" &&
        field.type === "choice" &&
        Array.isArray(field.choices) &&
        field.choices.includes("owed"),
    );
    if (!marks) continue;
    const value = (key: string) =>
      sql`CASE WHEN json_valid(fields_json) THEN json_extract(fields_json, ${`$.${key}`}) END`;
    const marked = yield* sql<{ recordId: string; rev: number }>`UPDATE kin_records
      SET fields_json = json_set(fields_json, '$.reimbursement', 'owed'), rev = rev + 1,
        updated_at = ${now}
      WHERE org_id = ${list.orgId} AND register_id = 'expenses' AND state = 'done'
        AND trim(COALESCE(${value("paidPersonallyBy")}, '')) <> ''
        AND ${value("reimbursement")} IS NULL
        AND ${value("fundedBy")} IS NULL
      RETURNING record_id AS "recordId", rev`;
    for (const row of marked)
      yield* sql`INSERT INTO kin_record_changes (org_id, record_id, rev, at, actor_kind, actor_id,
          via, kind, fields_json)
        VALUES (${list.orgId}, ${row.recordId}, ${row.rev}, ${now}, 'system', NULL, 'import',
          'updated', ${OWED_CHANGE})`;
  }
});
