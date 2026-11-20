import { KinChatError, KinChatId, KinMessageId, type KinOrgId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatService } from "../chat/KinChatService.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "../lead/orgLeads.ts";
import { KinRecords, type Writer } from "../work/KinRecords.ts";
import { isMoney, parseFields } from "../work/lists.ts";
import { formatMoney } from "../work/money.ts";
import { countedEntry, type RecordRow } from "../work/recordRows.ts";
import { listDef } from "../work/registers.ts";
import { computeData } from "./compute.ts";
import { gatherFacts } from "./facts.ts";
import * as Numbers from "./numbering.ts";
import {
  amountProblem,
  assembleInputs,
  declaredFigures,
  type Figures,
  issuable,
} from "./recipe.ts";
import { KinWorkspace, type StoredRecipe } from "./workspace.ts";

/**
 * What an entry is issued with: the amount its documents declare (`amount:` in their recipe), as
 * they would render now. An issued document's own figures are kept as rendered
 * (`kin_doc_job_figures`); nothing here writes an amount to an entry already issued.
 */

export type Documented =
  | { readonly _tag: "figures"; readonly figures: Figures }
  | { readonly _tag: "refused"; readonly reason: string };

const isChatError = Schema.is(KinChatError);
const decodeGiven = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** What the recipe makes for `entry` from `given` comes to, worked out as rendering it would. */
const documentFigures = Effect.fn("KinDocAmounts.documentFigures")(function* (
  orgId: KinOrgId,
  recipe: StoredRecipe,
  entry: RecordRow,
  given: Readonly<Record<string, unknown>>,
) {
  const gathered = yield* gatherFacts(orgId, recipe, entry, given);
  const assembled = assembleInputs(recipe, given, gathered.facts, gathered.currency);
  if ("error" in assembled) return { error: assembled.error.message };
  const computed = computeData(assembled.inputs, recipe.computed, gathered.tax);
  if ("error" in computed) return { error: computed.error };
  return declaredFigures(recipe, computed.data);
});

/**
 * What the entry's documents, each as it was last asked for and as issuing makes it again, come
 * to; `undefined` when it has none from a numbered recipe. Refused when a recipe declares no
 * amount, a document can't be worked out, or two of them disagree.
 */
const documented = Effect.fn("KinDocAmounts.documented")(function* (
  orgId: KinOrgId,
  entry: RecordRow,
) {
  const sql = yield* SqlClient.SqlClient;
  const jobs = yield* sql<{ recipe: string; givenJson: string }>`SELECT recipe,
      given_json AS "givenJson" FROM (
      SELECT recipe, given_json, ROW_NUMBER() OVER (
        PARTITION BY doc_origin ORDER BY created_at DESC, worker_id DESC) AS latest
      FROM kin_doc_jobs
      WHERE org_id = ${orgId} AND entry_record_id = ${entry.recordId}
        AND given_json IS NOT NULL AND recipe IS NOT NULL AND outcome_json IS NOT NULL) made
    WHERE latest = 1 ORDER BY recipe LIMIT 20`;
  if (jobs.length === 0) return undefined;
  const recipes = yield* (yield* KinWorkspace).recipes(orgId);
  let found: Figures | undefined;
  for (const job of jobs) {
    const recipe = recipes.find((one) => one.name === job.recipe);
    if (recipe === undefined || !issuable(recipe)) continue;
    const problem = amountProblem(recipe);
    if (problem !== undefined) return { _tag: "refused", reason: problem } satisfies Documented;
    const decoded = decodeGiven(job.givenJson);
    const figures = yield* documentFigures(
      orgId,
      recipe,
      entry,
      decoded._tag === "Some" ? decoded.value : {},
    );
    if ("error" in figures)
      return {
        _tag: "refused",
        reason: `Kin can't work out what its ${recipe.name} document comes to: ${figures.error}.`,
      } satisfies Documented;
    if (
      found !== undefined &&
      (found.total.minor !== figures.total.minor || found.total.currency !== figures.total.currency)
    )
      return {
        _tag: "refused",
        reason: `its documents disagree: one comes to ${formatMoney(found.total)}, its ${recipe.name} document to ${formatMoney(figures.total)}.`,
      } satisfies Documented;
    found = figures;
  }
  return found === undefined
    ? undefined
    : ({ _tag: "figures", figures: found } satisfies Documented);
});

const recordedTax = (entry: RecordRow) => {
  const stored = parseFields(entry.fieldsJson).tax;
  return stored !== undefined && stored !== null && isMoney(stored) ? stored : undefined;
};

/** The entry without its amount and tax, as its documents read it when they set them. */
export const unpriced = (entry: RecordRow): RecordRow => {
  const { tax: _tax, ...fields } = parseFields(entry.fieldsJson);
  return { ...entry, amountMinor: null, fieldsJson: JSON.stringify(fields) };
};

/**
 * Whether the entry's documents set its amount and tax: it isn't issued, and has none yet or holds
 * what they come to from their own lines. An amount a person typed, billed as it is, stays theirs.
 */
export const pricedByDocuments = Effect.fn("KinDocAmounts.pricedByDocuments")(function* (
  orgId: KinOrgId,
  entry: RecordRow,
) {
  if ((yield* Numbers.issuedNumber(orgId, entry.recordId)) !== undefined) return false;
  if (entry.amountMinor === null) return true;
  const now = yield* documented(orgId, unpriced(entry)).pipe(
    Effect.catchIf(isChatError, () => Effect.undefined),
  );
  if (now?._tag !== "figures") return false;
  const { total, tax } = now.figures;
  const stored = recordedTax(entry);
  return (
    entry.amountMinor === total.minor &&
    entry.currency === total.currency &&
    (stored === undefined || (stored.minor === tax.minor && stored.currency === tax.currency))
  );
});

/**
 * Writes what the draft `key`'s documents come to from their lines onto it as its amount and tax,
 * as issuing would, in the transaction that made one. Unless they `priced` it before, an amount
 * it holds that they don't come to stays; an issued entry is never touched here.
 */
export const priceDraft = Effect.fn("KinDocAmounts.priceDraft")(function* (
  orgId: KinOrgId,
  writer: Writer,
  key: string,
  priced: boolean,
) {
  const records = yield* KinRecords;
  const row = yield* records.get(orgId, key);
  if (row === undefined || row.state === "dropped") return;
  if ((yield* Numbers.issuedNumber(orgId, row.recordId)) !== undefined) return;
  const def = yield* listDef(orgId, row.registerId);
  // A receipt's amount is what was received, never its document's.
  if (def === undefined || !def.amount || def.id === "receipts") return;
  const now = yield* documented(orgId, unpriced(row)).pipe(
    Effect.catchIf(isChatError, () => Effect.undefined),
  );
  if (now?._tag !== "figures" || now.figures.total.minor === 0) return;
  const { total, tax } = now.figures;
  const same = row.amountMinor === total.minor && row.currency === total.currency;
  if (!priced && row.amountMinor !== null && !same) return;
  const stored = recordedTax(row);
  const taxField = def.fields.some((field) => field.key === "tax" && field.type === "money");
  const patch = {
    ...(same ? {} : { amount: total }),
    ...(taxField && (stored?.minor !== tax.minor || stored.currency !== tax.currency)
      ? { fields: { tax } }
      : {}),
  };
  if (Object.keys(patch).length > 0) yield* records.update(orgId, writer, row.key, patch);
});

/** Drafts read per page at start, so an org with many is read through, never in one go. */
const FILL_PAGE = 100;

/**
 * At start: each draft made before drafts carried their document's figures, with a document and
 * no amount, gets them now (`priceDraft`); one that can't be worked out is left as it was.
 */
export const fillDraftAmounts = Effect.fn("KinDocAmounts.fill")(function* (
  page: number = FILL_PAGE,
) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  const system: Writer = { actor: { _tag: "system" }, via: "import" };
  let filled = 0;
  let after = { orgId: "", recordId: "" };
  for (;;) {
    // A startup scan across orgs; each entry is priced within its own org.
    const rows = yield* sql<{ orgId: KinOrgId; recordId: string; key: string }>`SELECT
        r.org_id AS "orgId", r.record_id AS "recordId", r.key FROM kin_records r
      WHERE r.amount_minor IS NULL AND r.state <> 'dropped'
        AND (r.org_id > ${after.orgId} OR (r.org_id = ${after.orgId} AND r.record_id > ${after.recordId}))
        AND EXISTS (SELECT 1 FROM kin_doc_jobs j WHERE j.org_id = r.org_id
          AND j.entry_record_id = r.record_id AND j.given_json IS NOT NULL
          AND j.recipe IS NOT NULL AND j.outcome_json IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM kin_issued_numbers n
          WHERE n.org_id = r.org_id AND n.record_id = r.record_id)
      ORDER BY r.org_id, r.record_id LIMIT ${page}`;
    for (const one of rows) {
      const priced = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* priceDraft(one.orgId, system, one.key, true);
            return (yield* records.get(one.orgId, one.key))?.amountMinor != null;
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Kin couldn't give a draft its document's amount", {
              orgId: one.orgId,
              key: one.key,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(false)),
          ),
        );
      if (priced) filled += 1;
    }
    if (rows.length < page) break;
    after = rows.at(-1)!;
  }
  return filled;
});

/**
 * Issues the entry `key` (`Numbers.issue`) with what its documents come to, worked out in the
 * transaction that takes its number: the amount it is issued with, or the reason it isn't.
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
          : yield* documented(orgId, row);
      return yield* Numbers.issue(orgId, writer, key, figures);
    }),
  );
});

const noticeId = (orgId: KinOrgId, recordId: string) =>
  KinMessageId.make(`kin-invoice-amount:${orgId}:${recordId}`);
/** Candidates read per page, so an org with many is read through, never in one go. */
const NOTICE_PAGE = 100;

/** What Kin can say of an invoice's amount: what its issued document showed, else what it would now. */
const believed = Effect.fn("KinDocAmounts.believed")(function* (orgId: KinOrgId, entry: RecordRow) {
  const sql = yield* SqlClient.SqlClient;
  const [kept] = yield* sql<{ minor: number; currency: string }>`SELECT total_minor AS minor,
      currency FROM kin_doc_job_figures
    WHERE org_id = ${orgId} AND entry_record_id = ${entry.recordId}
    ORDER BY rendered_at DESC, worker_id DESC LIMIT 1`;
  if (kept !== undefined)
    return `Its issued document shows ${formatMoney(kept)}: confirm that, or tell your agent the right amount, and it records it.`;
  const now = yield* documented(orgId, entry).pipe(Effect.orElseSucceed(() => undefined));
  return now?._tag === "figures"
    ? `Its document comes to ${formatMoney(now.figures.total)} with today's details, which may not be what it showed when it was issued: confirm that, or tell your agent the right amount, and it records it.`
    : "Kin can't tell its amount from a document: tell your agent its amount, and it records it.";
});

/**
 * Tells the owner of each issued invoice with no amount, which isn't counted in what is owed.
 * Writes no amount, ever: only a notice, in an owner-only chat (the issuing agent's, else the chief
 * of staff's), and that it was told, so each is told once. One no chat takes is told next start.
 */
export const reportIssuedWithoutAmount = Effect.fn("KinDocAmounts.report")(function* (
  orgId: KinOrgId,
  page: number = NOTICE_PAGE,
) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  const chats = yield* KinChatService;
  const reported: Array<string> = [];
  const kept: Array<string> = [];
  let after = "";
  for (;;) {
    const rows = yield* sql<{
      recordId: string;
      key: string;
      number: string;
      byKind: string;
      byId: string;
    }>`SELECT r.record_id AS "recordId", r.key, n.number, n.issued_by_kind AS "byKind",
        n.issued_by_id AS "byId"
      FROM kin_issued_numbers n
      JOIN kin_records r ON r.org_id = n.org_id AND r.record_id = n.record_id
      WHERE n.org_id = ${orgId} AND n.register_id = 'invoices' AND r.register_id = 'invoices'
        AND r.amount_minor IS NULL AND ${countedEntry(sql)} AND n.record_id > ${after}
        AND NOT EXISTS (SELECT 1 FROM kin_amount_notices a
          WHERE a.org_id = n.org_id AND a.record_id = n.record_id)
      ORDER BY n.record_id LIMIT ${page}`;
    for (const one of rows) {
      const entry = yield* records.get(orgId, one.key);
      if (entry === undefined || entry.amountMinor !== null) continue;
      const body = `${one.number} (${one.key}) was issued with no amount, so it isn't counted in what you're owed. ${yield* believed(orgId, entry)}`;
      const [own] =
        one.byKind === "agent"
          ? yield* sql<{ chatId: string }>`SELECT l.owner_chat_id AS "chatId" FROM kin_leads l
              JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
                AND a.retired_at IS NULL
              WHERE l.org_id = ${orgId} AND l.agent_id = ${one.byId}`
          : [];
      const chief = (yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN }))?.ownerChatId;
      const messageId = noticeId(orgId, one.recordId);
      let told: string | undefined;
      for (const chatId of new Set([own?.chatId, chief].filter((id) => id !== undefined))) {
        const posted = yield* chats
          .notice({ orgId, chatId: KinChatId.make(chatId), messageId, audience: "owner", body })
          .pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
        if (posted) {
          told = chatId;
          break;
        }
      }
      if (told === undefined) {
        kept.push(one.key);
        continue;
      }
      yield* sql`INSERT INTO kin_amount_notices (org_id, record_id, message_id, chat_id, reported_at)
        VALUES (${orgId}, ${one.recordId}, ${messageId}, ${told}, ${yield* Clock.currentTimeMillis})
        ON CONFLICT (org_id, record_id) DO NOTHING`;
      reported.push(one.key);
    }
    if (rows.length < page) break;
    after = rows.at(-1)!.recordId;
  }
  return { reported, kept };
});
