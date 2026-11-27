import { KinNewInvoiceInput, type KinOrgId, type KinPersonId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinRecords } from "../work/KinRecords.ts";
import { notFound, type RecordRow } from "../work/recordRows.ts";

const decodeGiven = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const TypedInvoiceInputs = Schema.Struct({
  lines: KinNewInvoiceInput.fields.lines,
  gstRate: KinNewInvoiceInput.fields.gstRate,
});
const encodeTypedInvoiceInputs = Schema.encodeEffect(Schema.fromJsonString(TypedInvoiceInputs));

const draftJob = (recordId: string) => `typed-invoice:${recordId}`;

// The saved inputs have no recipe or outcome. Readers of filed documents ignore this row.
export const keepTypedInvoiceInputs = Effect.fn("KinDocMaker.keepTypedInvoiceInputs")(function* (
  invoice: RecordRow,
  personId: KinPersonId,
  given: typeof TypedInvoiceInputs.Type,
) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const job = draftJob(invoice.recordId);
  const givenJson = yield* encodeTypedInvoiceInputs(given);
  yield* sql`INSERT INTO kin_doc_jobs (org_id, worker_id, agent_id, wakeup_id, mode,
    recipe_commit, entry_record_id, inputs_sha256, sensitive, doc_origin, worktree_path, branch,
    audience, created_at, removed_at, given_json, asked_by_person_id)
    VALUES (${invoice.orgId}, ${job}, '', '', 'document', '', ${invoice.recordId}, '', 1,
      ${job}, '', '', 'owner_only', ${now}, ${now}, ${givenJson}, ${personId})
    ON CONFLICT (org_id, worker_id) DO NOTHING`;
});

/** The latest filed document's inputs, or the typed invoice inputs before the first PDF. */
export const entryInputs = Effect.fn("KinDocMaker.entryInputs")(function* (
  orgId: KinOrgId,
  key: string,
  options?: { readonly includeTypedDraft: true },
) {
  const sql = yield* SqlClient.SqlClient;
  const entry = yield* (yield* KinRecords).get(orgId, key);
  if (entry === undefined) return yield* notFound(key);
  const draft = options?.includeTypedDraft === true ? draftJob(entry.recordId) : null;
  const [job] = yield* sql<{ givenJson: string }>`SELECT given_json AS "givenJson"
    FROM kin_doc_jobs
    WHERE org_id = ${orgId} AND entry_record_id = ${entry.recordId} AND given_json IS NOT NULL
      AND ((recipe IS NOT NULL AND outcome_json IS NOT NULL) OR worker_id = ${draft})
    ORDER BY outcome_json IS NULL, created_at DESC, worker_id DESC LIMIT 1`;
  const decoded = job === undefined ? undefined : decodeGiven(job.givenJson);
  return decoded?._tag === "Some" ? decoded.value : {};
});
