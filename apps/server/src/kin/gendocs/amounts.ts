import { KinChatId, KinMessageId, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatService } from "../chat/KinChatService.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "../lead/orgLeads.ts";
import { KinRecords, type Writer } from "../work/KinRecords.ts";
import { countedEntry, type RecordRow } from "../work/recordRows.ts";
import { computeData } from "./compute.ts";
import { gatherFacts } from "./facts.ts";
import * as Numbers from "./numbering.ts";
import { assembleInputs, type Money } from "./recipe.ts";
import { KinWorkspace } from "./workspace.ts";

/**
 * What an issued entry is for: the total and tax its own document comes to, worked out again from
 * what it was last made with, so an invoice carries the figure its PDF shows.
 */

export type Figures =
  | { readonly _tag: "figures"; readonly total: Money; readonly tax: Money }
  | { readonly _tag: "unworkable"; readonly reason: string };

const decodeGiven = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const isMoney = (value: unknown): value is Money =>
  typeof value === "object" &&
  value !== null &&
  Number.isSafeInteger(Reflect.get(value, "minor")) &&
  typeof Reflect.get(value, "currency") === "string";
const exact = (value: Money): Money => ({ minor: value.minor, currency: value.currency });

/**
 * The figures of the entry's latest recipe document that works out GST (`gst` in its computed
 * fields), from what it was last asked with and the rows as they are now; `undefined` when no
 * such document was made for it.
 */
const entryFigures = Effect.fn("KinDocAmounts.figures")(function* (
  orgId: KinOrgId,
  entry: RecordRow,
) {
  const sql = yield* SqlClient.SqlClient;
  const jobs = yield* sql<{ recipe: string; givenJson: string }>`SELECT recipe,
      given_json AS "givenJson" FROM kin_doc_jobs
    WHERE org_id = ${orgId} AND entry_record_id = ${entry.recordId} AND recipe IS NOT NULL
      AND given_json IS NOT NULL AND outcome_json IS NOT NULL
    ORDER BY created_at DESC, worker_id DESC LIMIT 20`;
  if (jobs.length === 0) return undefined;
  const recipes = yield* (yield* KinWorkspace).recipes(orgId);
  for (const job of jobs) {
    const recipe = recipes.find((one) => one.name === job.recipe);
    const field = recipe?.computed.find(
      ([, spec]) => typeof spec === "object" && spec !== null && "gst" in spec,
    )?.[0];
    if (recipe === undefined || field === undefined) continue;
    const decoded = decodeGiven(job.givenJson);
    const given = decoded._tag === "Some" ? decoded.value : {};
    const gathered = yield* gatherFacts(orgId, recipe, entry, given);
    const assembled = assembleInputs(recipe, given, gathered.facts, gathered.currency);
    if ("error" in assembled)
      return { _tag: "unworkable", reason: assembled.error.message } satisfies Figures;
    const computed = computeData(assembled.inputs, recipe.computed);
    if ("error" in computed)
      return { _tag: "unworkable", reason: computed.error } satisfies Figures;
    const gst: unknown = computed.data[field];
    const total: unknown = typeof gst === "object" && gst !== null ? Reflect.get(gst, "total") : 0;
    const tax: unknown = typeof gst === "object" && gst !== null ? Reflect.get(gst, "tax") : 0;
    if (!isMoney(total) || !isMoney(tax)) continue;
    return { _tag: "figures", total: exact(total), tax: exact(tax) } satisfies Figures;
  }
  return undefined;
});

/**
 * Issues the entry `key` (`Numbers.issue`) with what its own document comes to, worked out in the
 * same transaction that takes its number.
 */
export const issueEntry = Effect.fn("KinDocAmounts.issue")(function* (
  orgId: KinOrgId,
  writer: Writer,
  key: string,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const row = yield* (yield* KinRecords).get(orgId, key);
      const figures =
        row === undefined ||
        row.state === "dropped" ||
        (yield* Numbers.issuedNumber(orgId, row.recordId)) !== undefined
          ? undefined
          : yield* entryFigures(orgId, row);
      return yield* Numbers.issue(orgId, writer, key, figures);
    }),
  );
});

const SYSTEM: Writer = { actor: { _tag: "system" }, via: "import" };
const noticeId = (orgId: KinOrgId) => KinMessageId.make(`kin-invoice-amounts:${orgId}`);

/**
 * Issued invoices with no amount, as issuing left them before it wrote one: each whose own document
 * still works out exactly gets that total and tax; the rest are named to the owner in one notice,
 * once, and left as they are. Safe to run at every start.
 */
export const repairIssuedAmounts = Effect.fn("KinDocAmounts.repair")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  const rows = yield* sql<{ key: string; number: string; byKind: string; byId: string }>`SELECT
      r.key, n.number, n.issued_by_kind AS "byKind", n.issued_by_id AS "byId"
    FROM kin_issued_numbers n
    JOIN kin_records r ON r.org_id = n.org_id AND r.record_id = n.record_id
    WHERE n.org_id = ${orgId} AND n.register_id = 'invoices' AND r.register_id = 'invoices'
      AND r.amount_minor IS NULL AND ${countedEntry(sql)}
    ORDER BY n.issued_at, n.number LIMIT 500`;
  const repaired: Array<string> = [];
  const left: Array<{ readonly key: string; readonly number: string }> = [];
  for (const one of rows) {
    const done = yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* records.get(orgId, one.key);
        if (row === undefined || row.amountMinor !== null) return false;
        const figures = yield* entryFigures(orgId, row);
        if (figures?._tag !== "figures") return false;
        yield* records.update(orgId, SYSTEM, row.key, {
          amount: figures.total,
          fields: { tax: figures.tax },
        });
        return true;
      }),
    );
    if (done) repaired.push(one.key);
    else left.push({ key: one.key, number: one.number });
  }
  if (left.length === 0) return { repaired, left };
  const id = noticeId(orgId);
  const [posted] = yield* sql`SELECT 1 FROM kin_messages
    WHERE org_id = ${orgId} AND message_id = ${id}`;
  if (posted !== undefined) return { repaired, left };
  const issuer = rows.find((row) => row.key === left[0]!.key && row.byKind === "agent")?.byId;
  const [own] =
    issuer === undefined
      ? []
      : yield* sql<{ chatId: string }>`SELECT owner_chat_id AS "chatId" FROM kin_leads
          WHERE org_id = ${orgId} AND agent_id = ${issuer}`;
  const chatId =
    own?.chatId ?? (yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN }))?.ownerChatId;
  if (chatId === undefined) return { repaired, left };
  const named = left.map((one) => `${one.number} (${one.key})`).join(", ");
  const many = left.length > 1;
  yield* (yield* KinChatService).notice({
    orgId,
    chatId: KinChatId.make(chatId),
    messageId: id,
    audience: "owner",
    body: `Kin found ${many ? `${left.length} issued invoices` : "an issued invoice"} with no amount, so ${many ? "they aren't" : "it isn't"} counted in what you're owed: ${named}. Kin can't work ${many ? "their totals" : "its total"} out from a document, so tell your agent ${many ? "their amounts" : "its amount"} and it will record ${many ? "them" : "it"}.`,
  });
  return { repaired, left };
});
