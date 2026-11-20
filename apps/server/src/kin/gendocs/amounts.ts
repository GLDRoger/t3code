import { KinChatId, KinMessageId, type KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatService } from "../chat/KinChatService.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "../lead/orgLeads.ts";
import { KinRecords, type Writer } from "../work/KinRecords.ts";
import { formatMoney } from "../work/money.ts";
import { countedEntry, type RecordRow, recordName } from "../work/recordRows.ts";
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
      const body = `${recordName(one.key, one.number)} was issued with no amount, so it isn't counted in what you're owed. ${yield* believed(orgId, entry)}`;
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
