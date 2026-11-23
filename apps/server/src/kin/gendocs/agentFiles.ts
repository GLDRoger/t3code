// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous content hash; Digest would add a service to every caller.
import * as NodeCrypto from "node:crypto";
import { KinChatError, KinWorkerId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { turnChat } from "../lead/Audience.ts";
import { isOrgPaused } from "../lead/orgState.ts";
import * as Docs from "../work/docs.ts";
import { KinRecords } from "../work/KinRecords.ts";
import { shown } from "../work/leadDocs.ts";
import { admitted, type Lead, leadTool } from "../work/leadWork.ts";
import type { RecordRow } from "../work/recordRows.ts";
import { listDef } from "../work/registers.ts";
import { entrySensitive } from "./facts.ts";
import {
  type DocumentInput,
  type DocumentResult,
  requesterOf,
  stillAdmitted,
} from "./leadDocuments.ts";
import { issuable } from "./recipe.ts";
import {
  labelChange,
  recordBaseline,
  renderSample,
  sampleContext,
  verifySample,
} from "./recipeLabels.ts";
import {
  checkReferences,
  copyReferences,
  type Reference,
  REFERENCE_CAPS,
  referenceCopy,
  ReferencesJson,
  sampleLeak,
} from "./references.ts";
import { KinDocRenderer } from "./render.ts";
import { type Taken, takeFile } from "./returnPath.ts";
import { type CheckedRecipe, jobWorktree, KinWorkspace, type VerifyChange } from "./workspace.ts";

/**
 * `kin_document` without a recipe to run: a file the agent made in its own session, filed as a
 * doc, or a recipe it writes in a folder Kin prepares and keeps once the recipe's sample renders.
 */

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const denied = (message: string) => new KinChatError({ reason: "not_allowed", message });
const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
/** A recipe for a document of money or terms: what it is written from is private whatever it reads. */
const MONEY_RECIPE = /quote|invoice|receipt|statement|contract|proposal/i;
const PAUSED = "Kin is paused by the owner, so nothing new is made until they resume it.";
type Result = typeof DocumentResult.Type;
const answer = (result: Result) => result;

/** Files each file as a version of its doc, linked to the entry, and shows its card in the chat. */
const fileTaken = Effect.fn("KinAgentFiles.file")(function* (
  lead: Lead,
  input: DocumentInput,
  requester: Effect.Success<ReturnType<typeof requesterOf>>,
  files: ReadonlyArray<Taken>,
  options: {
    readonly jobId: KinWorkerId;
    readonly entry: RecordRow | undefined;
    readonly docOrigin: (file: Taken) => string;
    readonly title: (file: Taken) => string;
    readonly summary: string;
    readonly sensitive: boolean;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const renderer = yield* KinDocRenderer;
  const stored = new Map<string, string>();
  for (const file of files)
    stored.set(file.name, yield* renderer.store(lead.orgId, options.jobId, file));
  const written = yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* stillAdmitted(lead, "kin_document", input);
      const filed: Array<Docs.Written> = [];
      for (const file of files) {
        const one = yield* Docs.fileVersion(
          lead.orgId,
          requester.writer,
          {
            ...(requester.answered === null
              ? {}
              : {
                  answered: {
                    messageId: requester.answered.messageId,
                    author: { _tag: "person", personId: requester.answered.personId },
                  },
                }),
            audience: "owner_only",
          },
          {
            docOrigin: options.docOrigin(file),
            originKey: `kin-doc-file:${options.jobId}:${file.name}`,
            title: options.title(file).slice(0, 200),
            summary: options.summary,
            owner: { _tag: "agent", agentId: lead.agentId },
            sensitive: options.sensitive,
            ...(options.entry?.partyId == null ? {} : { partyId: options.entry.partyId }),
            file: {
              attachmentId: stored.get(file.name)!,
              name: file.name,
              mimeType: file.mimeType,
              bytes: file.bytes.length,
              sha256: file.sha256,
              pages: file.pages,
              recipe: null,
              inputsHash: file.sha256,
              workerId: options.jobId,
              number: null,
              draft: false,
            },
          },
        );
        if (options.entry !== undefined)
          yield* Docs.link(
            lead.orgId,
            requester.writer,
            { key: one.row.key },
            [options.entry.key],
            "relates",
          );
        filed.push(one);
      }
      return filed;
    }),
  );
  for (const one of written) yield* shown(lead, one, true);
  return written.map((one) => ({
    key: one.row.key,
    title: one.row.title,
    version: one.version.version,
  }));
});

/** `kin_document` with `file`: the agent's own file, checked for what it is, filed as it is. */
export const fileDocument = leadTool("KinAgentFiles.document", (lead, input: DocumentInput) =>
  Effect.gen(function* () {
    yield* admitted(lead, "kin_document", input);
    if (yield* isOrgPaused(lead.orgId)) return yield* denied(PAUSED);
    if (input.file === undefined)
      return yield* invalid(
        "Nothing was filed. Without a recipe, make the file with your own tools and give its full path in file; kin_recipes lists the files Kin makes itself.",
      );
    if (
      (input.inputs !== undefined && Object.keys(input.inputs).length > 0) ||
      input.doc !== undefined ||
      input.from !== undefined ||
      (input.references ?? []).length > 0
    )
      return yield* invalid(
        "Nothing was filed. inputs, doc, from and references go with a recipe; a file you made takes only title, file and entry.",
      );
    const entry =
      input.entry === undefined
        ? undefined
        : yield* (yield* KinRecords).get(lead.orgId, input.entry);
    if (input.entry !== undefined && entry === undefined)
      return yield* new KinChatError({
        reason: "not_found",
        message: `No entry ${input.entry}. Nothing was filed.`,
      });
    const taken = yield* takeFile(input.file);
    if (!("bytes" in taken))
      return yield* invalid(
        `Nothing was filed: ${taken.name} ${taken.reason}.${taken.retry === undefined ? "" : ` ${taken.retry}`}`,
      );
    const sensitive =
      entry !== undefined && entrySensitive(entry, yield* listDef(lead.orgId, entry.registerId));
    const requester = yield* requesterOf(lead, input.sourceEventId);
    const documents = yield* fileTaken(lead, input, requester, [taken], {
      jobId: KinWorkerId.make(
        `fd-${sha256(`${lead.orgId}:${lead.wakeupId}:${input.sourceEventId}:${input.title}:${taken.sha256}`).slice(0, 32)}`,
      ),
      entry,
      docOrigin: () => `file:${entry?.recordId ?? "none"}:${sha256(input.title)}`,
      title: () => input.title,
      summary: "Made by the agent",
      sensitive,
    });
    return answer({
      recipe: null,
      number: null,
      draft: false,
      documents,
      ...(sensitive ? { sensitive: true as const } : {}),
    });
  }),
);

const decodeReferences = Schema.decodeUnknownOption(ReferencesJson);
const encodeReferences = Schema.encodeEffect(ReferencesJson);

const referencesGuide = (references: ReadonlyArray<Reference>) =>
  [
    `References: the owner sent ${references.length === 1 ? "a file" : "these files"} showing the look the documents should have, read-only in in/references/: ${references.map((one) => one.name).join(", ")}. Open each with your Read tool, which shows PDFs and images.`,
    "Copy the look, never the data: the layout, where the logo sits, colours, fonts, column order and labels, header and footer blocks, wording of fixed text such as terms. Every name, address, number, tax id and amount in them is real and stays out of the recipe: those come from Kin's inputs, and sample.json holds invented values. Kin refuses a sample holding the company's or a client's real details.",
    `Never copy a reference file into the recipe. The only exception is an image the template shows, up to ${REFERENCE_CAPS.shownImageBytes / 1048576} MB, such as a signature the owner sent; the company logo comes from company.logo, not a file.`,
  ].join("\n");

const RECIPE_GUIDE = `A recipe is a folder: RECIPE.md, template.typ (for a PDF), sample.json and anything the template shows, such as a logo or a font. Kin renders it itself; nothing in it runs but the template, in Typst 0.15 with no packages and no network.
RECIPE.md starts with YAML front matter between --- lines: name (the folder's name), kind (typst, or table for CSVs and a workbook), title, description (one line the agent reads), list (when it is for one entry of a list, such as invoices), numbered (true when it shows the entry's issued number), sensitive (Kin labels a file confidential by where its inputs come from, such as amounts, bank details, tax ids or a sensitive entry; true here labels it so anyway), inputs, computed (typst), sheets and workbook (table), and outputs (for typst each PDF's name; for table each file's name, {month} for an input's value).
Each input has a type (text, integer, decimal, money, date, boolean, code for a SAC or HSN code of 4 to 8 digits, month or table with columns), required (default true for stored values, false for the agent's), a description, and from: where Kin reads it. Leave from out for the agent's own words; otherwise one of entry.key|title|state|amount|tax|date|due|notes|number, entry.fields.<field>, client.name|address|gstin|placeOfSupply|terms, company.legalName|tradeName|address|gstin|pan|placeOfSupply|sac, company.bank.accountName|accountNumber|ifsc|bankName|branch|upi, company.logo (text: the logo's path, such as /brand/logo.png, or null when the company has none; show it with image(d.logo, height: 16mm)), company.brand.primaryColor|secondaryColor|font|footer (text: colours as #RRGGBB for rgb(), a font name, a footer line; each may be null, so keep a default), system.number|draft|today, rows.<list> (a table of that list's entries in a month, with period naming a month input, and states to keep only some of Kin's own states; columns from key, title, state, stateKey (Kin's own state), amount, tax, taxable (amount less tax, blank without a tax), date, due, client, clientGstin, placeOfSupply, category, number, matched (what a bank row was confirmed as), field_<field>), entry.payments (a table of the entry's live payments: receipt, amount, paidOn, kind, which is advance, received or tds; entry.advances keeps only the advances), payments (a table of money received in a month: invoice, client, amount, paidOn, receipt), tds (the same columns, for tax clients deducted), or reimbursements (a table of paid expenses a partner funded that were owed to them at the month's end or repaid in it: key, title, date, partner, state, repaidOn, amount).
Every figure the document shows that Kin doesn't store is a computed field, worked out by Kin in exact integers, in order, each one function: times [amount, factor], percent [amount, rate] (round: half-up, half-even, down or up), sum [amounts, or table.column], minus [a, b], first [values], each { rows: <table>, set: { <column>: <field> } } (each column it sets is one value per row: text, a number or an amount, never a table), words <amount>, date [<day>, "D MMM YYYY" | "D MMMM YYYY" | "DD/MM/YYYY" | "MMMM YYYY"], gst { taxable, total, recordedTax, rate, supplierGstin, supplierPlace, clientGstin, clientPlace, exportUnderLut } and markdown <text>. Arguments name inputs or earlier fields, or are literals.
A numbered recipe declares amount: the figure its document asks to be paid, which is what Kin issues its entry with, such as amount: { total: tax.total, tax: tax.tax, taxes: tax.taxes } for a gst field named tax, or { total: amount } for a receipt. Kin keeps no numbered recipe without it.
template.typ reads #let d = json("/inputs.json"): every input and computed field, money as {minor, currency, text}; it shows money by its text and never does arithmetic on it. sys.inputs.output is the PDF being made. Put wording the owner may change in #let lines at its top. Fonts: Poppins (geometric sans) and Mukta (humanist sans), both with Devanagari and ₹, Libertinus Serif, New Computer Modern and DejaVu Sans Mono, or a font file kept in the folder; name a fallback list such as (d.brandFont, "Poppins") when the font comes from the brand. Page size, margins, columns, their order and labels, header and footer blocks, a second page for terms (pagebreak()) and a signature image are all the template's: lay them out as the owner's format has them. Print a signatory block only with the owner's signature image; without one, print only the line that it needs no signature, naming what it is ("This is a computer-generated receipt and needs no signature."), never both. default: true in the front matter marks the recipe the agent uses for its list unless the owner asks for another, such as invoice beside invoice-export.
A table recipe's sheets each have a name, the table input they show, a CSV file name, columns (header and field, amount.currency for a money column's currency), leaveOutOfTotals, and totalsBy (a field to total per value, such as field_direction); workbook names the XLSX.
sample.json holds invented values for every input, as Kin would give them: money as {"minor": <integer>, "currency": "INR"}, days as 2026-11-12. Never a real company's or client's details. Give a logo input any non-null text and Kin renders the sample with the company's logo, or a stand-in when it has none.
The body after the front matter is notes for the agent on when and how to use it.`;

type Draft = {
  readonly jobId: KinWorkerId;
  readonly referencesJson: string | null;
  readonly sensitive: number;
  readonly compared: number;
};

const kept = (name: string, folder: string) =>
  `Edit recipes/${name}/ in ${folder} with your own tools, then call kin_document again with writeRecipe and recipe ${name} to keep it: Kin checks RECIPE.md, renders the sample and commits only that folder. Read recipes/ there for working examples: recipes/invoice/ shows computed fields, the logo and brand colours, and a template.`;

/**
 * `kin_document` with `writeRecipe`: the first call prepares a folder holding the workspace's
 * recipes for the agent to edit; a later one checks the recipe there and keeps it once its sample
 * renders, filing the sample for the owner to see. A refusal leaves the folder for another try.
 */
export const writeRecipe = leadTool("KinAgentFiles.writeRecipe", (lead, input: DocumentInput) =>
  Effect.gen(function* () {
    yield* admitted(lead, "kin_document", input);
    if (yield* isOrgPaused(lead.orgId)) return yield* denied(PAUSED);
    const name = input.recipe;
    if (name === undefined) return yield* invalid("Name the recipe to write in recipe.");
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const workspace = yield* KinWorkspace;
    const renderer = yield* KinDocRenderer;
    const [open] = yield* sql<Draft>`SELECT worker_id AS "jobId",
        references_json AS "referencesJson", sensitive, compared
      FROM kin_doc_jobs WHERE org_id = ${lead.orgId} AND agent_id = ${lead.agentId}
        AND mode = 'recipe' AND recipe = ${name} AND collected_at IS NULL AND removed_at IS NULL
      ORDER BY created_at DESC, worker_id LIMIT 1`;
    const folder = open === undefined ? undefined : jobWorktree(config.worktreesDir, open.jobId);
    const start = Effect.fn("KinAgentFiles.startDraft")(function* () {
      const chat = yield* turnChat(lead);
      const references = yield* checkReferences(lead.orgId, chat?.chatId, input.references ?? []);
      const now = yield* Clock.currentTimeMillis;
      const [{ drafts }] = (yield* sql<{ drafts: number }>`SELECT COUNT(*) AS drafts
          FROM kin_doc_jobs WHERE org_id = ${lead.orgId} AND agent_id = ${lead.agentId}
            AND mode = 'recipe' AND recipe = ${name}`) as [{ drafts: number }];
      const jobId = KinWorkerId.make(
        `rw-${sha256(`${lead.orgId}:${lead.agentId}:${name}:${drafts}`).slice(0, 32)}`,
      );
      const prepared = yield* workspace.prepare(lead.orgId, jobId, {});
      yield* copyReferences(prepared.worktree, references);
      if (open !== undefined)
        yield* sql`UPDATE kin_doc_jobs SET removed_at = ${now}
            WHERE org_id = ${lead.orgId} AND worker_id = ${open.jobId}`;
      yield* sql`INSERT INTO kin_doc_jobs (org_id, worker_id, agent_id, wakeup_id, mode, recipe,
            recipe_commit, entry_record_id, inputs_sha256, number, sensitive, doc_origin,
            worktree_path, branch, chat_id, audience, created_at, references_json)
          VALUES (${lead.orgId}, ${jobId}, ${lead.agentId}, ${lead.wakeupId}, 'recipe', ${name},
            ${prepared.base}, NULL, '', NULL,
            ${references.length > 0 || MONEY_RECIPE.test(name) ? 1 : 0}, ${`recipe:${name}`},
            ${prepared.worktree}, ${prepared.branch}, ${chat?.chatId ?? null}, 'owner_only', ${now},
            ${references.length === 0 ? null : yield* encodeReferences(references)})`;
      return answer({
        recipe: name,
        number: null,
        draft: false,
        documents: [],
        folder: prepared.worktree,
        next: [
          kept(name, prepared.worktree),
          ...(references.length === 0 ? [] : [referencesGuide(references)]),
          RECIPE_GUIDE,
        ].join("\n\n"),
      });
    });
    if (open === undefined || folder === undefined || !(yield* fs.exists(folder)))
      return yield* start();

    const jobId = open.jobId;
    const references = Option.getOrElse(
      decodeReferences(open.referencesJson ?? "[]"),
      (): ReadonlyArray<Reference> => [],
    );
    const company = yield* sampleContext(lead.orgId);
    /** Why a change can't be kept for what it holds, before it is rendered. */
    const holds = Effect.fn("KinAgentFiles.holds")(
      function* (change: CheckedRecipe) {
        if (issuable(change.recipe) && change.recipe.amount === null)
          return "it is numbered, so its front matter declares amount: the figure its document asks to be paid, such as amount: { total: tax.total, tax: tax.tax, taxes: tax.taxes }";
        const copied = referenceCopy(change.files, references, change.template);
        if (copied !== undefined) return copied;
        return yield* sampleLeak(lead.orgId, change.sample);
      },
      Effect.orElseSucceed(() => "Kin couldn't check its sample; try again"),
    );
    const refused = (reason: string) =>
      invalid(
        `Kin didn't keep the ${name} recipe: ${reason}. Fix it in ${folder} with your own tools, then call again.`,
      );
    // git can't stage a folder that isn't there yet: nothing has been written.
    const written = yield* fs.exists(path.join(folder, "recipes", name));
    const preview = written
      ? yield* workspace.previewRecipeChange(lead.orgId, { workerId: jobId, recipe: name })
      : ({ _tag: "unchanged" } as const);
    if (preview._tag === "unchanged")
      return answer({
        recipe: name,
        number: null,
        draft: false,
        documents: [],
        folder,
        next: `Nothing in recipes/${name}/ has changed yet. ${kept(name, folder)}`,
      });
    if (preview._tag === "refused") return yield* refused(preview.reason);
    const held = yield* holds(preview);
    if (held !== undefined) return yield* refused(held);
    const lookAgain = references.length > 0 && open.compared === 0;
    const rendered = yield* renderSample(renderer, lead.orgId, company, preview, lookAgain);
    if (typeof rendered === "string")
      return yield* refused(`its sample didn't render because ${rendered}`);
    // Written from the owner's files: its first page goes back once, to set beside them.
    if (lookAgain && rendered.page !== undefined) {
      const shownAt = path.join(folder, "in", "rendered", "page-1.png");
      yield* fs.makeDirectory(path.dirname(shownAt), { recursive: true });
      yield* fs.writeFile(shownAt, rendered.page.bytes);
      yield* sql`UPDATE kin_doc_jobs SET compared = 1
        WHERE org_id = ${lead.orgId} AND worker_id = ${jobId}`;
      return answer({
        recipe: name,
        number: null,
        draft: false,
        documents: [],
        folder,
        next: `It renders. Its first page, made from sample.json, is at ${shownAt}: open it with your Read tool beside in/references/ and compare the look (layout, logo, colours, fonts, spacing, columns and labels). Change the template where it differs, then call again to keep it.`,
      });
    }

    let accepted: CheckedRecipe | undefined;
    const verify: VerifyChange = Effect.fn("KinAgentFiles.verify")(function* (change) {
      const reason =
        (yield* holds(change).pipe(Effect.provideService(SqlClient.SqlClient, sql))) ??
        (yield* verifySample(renderer, lead.orgId, company)(change));
      if (reason === undefined) accepted = change;
      return reason;
    });
    yield* recordBaseline(lead.orgId);
    const change = yield* workspace.applyRecipeChange(lead.orgId, {
      workerId: jobId,
      recipe: name,
      agentId: lead.agentId,
      verify,
    });
    if (change._tag === "unchanged")
      return answer({
        recipe: name,
        number: null,
        draft: false,
        documents: [],
        folder,
        next: `Nothing in recipes/${name}/ has changed yet. ${kept(name, folder)}`,
      });
    if (change._tag === "refused") return yield* refused(change.reason);
    const sensitive = yield* labelChange(lead.orgId, name, change, open.sensitive === 1);
    const now = yield* Clock.currentTimeMillis;
    yield* sql`UPDATE kin_doc_jobs SET collected_at = ${now}, removed_at = ${now}
      WHERE org_id = ${lead.orgId} AND worker_id = ${jobId}`;
    yield* workspace.discard(lead.orgId, jobId);
    // The owner sees the new look: the sample as Kin renders it, PDF and first page.
    const sample =
      accepted === undefined
        ? undefined
        : yield* renderSample(
            renderer,
            lead.orgId,
            company,
            { ...accepted, commit: change.revision },
            true,
          );
    const files =
      sample === undefined || typeof sample === "string"
        ? []
        : sample.page === undefined
          ? sample.files
          : [...sample.files, sample.page];
    const requester = yield* requesterOf(lead, input.sourceEventId);
    const documents = yield* fileTaken(lead, input, requester, files, {
      jobId,
      entry: undefined,
      docOrigin: (file) => `recipe-sample:${name}:${file.extension}`,
      title: (file) =>
        `${accepted?.recipe.title ?? name} sample${file.extension === "png" ? " · page 1" : ""}`,
      summary: `The ${name} recipe's sample, with invented data, as Kin renders it now`,
      sensitive,
    });
    return answer({
      recipe: name,
      number: null,
      draft: false,
      documents,
      ...(sensitive ? { sensitive: true as const } : {}),
      next: `Kin rendered the ${name} recipe's sample and committed it (${change.commit.slice(0, 12)})${change.left.length === 0 ? "" : `; it left out ${change.left.join(", ")}`}. Make documents with it with kin_document; kin_recipe_undo with recipe ${name} puts the look back as it was.`,
    });
  }),
);
