// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous content hash; Digest would add a service to every caller.
import * as NodeCrypto from "node:crypto";
import {
  KinAgentId,
  KinChatError,
  KinChatId,
  type KinOrgId,
  KinPersonId,
  KinRecordKey,
  KinTrimmedText,
  type KinWorkerId,
  type ThreadId,
  TrimmedNonEmptyString,
  type WorkerReport,
} from "@t3tools/contracts";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { quote } from "../lead/LeadPrompt.ts";
import { reportFormat } from "../lead/workerBrief.ts";
import * as Docs from "../work/docs.ts";
import { KinRecords, type Writer } from "../work/KinRecords.ts";
import type { RecordRow } from "../work/recordRows.ts";
import { listDef } from "../work/registers.ts";
import { turnSensitive } from "../work/workerAttempts.ts";
import { entrySensitive } from "./facts.ts";
import { canonical } from "./make.ts";
import type { Value } from "./recipe.ts";
import { labelChange, recordBaseline, verifySample } from "./recipeLabels.ts";
import { KinDocRenderer } from "./render.ts";
import { RETURN_CAPS, takeOutputs } from "./returnPath.ts";
import { jobWorktree, KinWorkspace, type StoredRecipe } from "./workspace.ts";

// A worker's document job: a one-off file from the agent's brief, or writing a recipe. A recipe's
// document is made in the call instead (`make.ts`). When the run ends Kin takes back only the files
// the report names, with provenance from the job's row, or commits the recipe once its sample renders.

const recipeName = TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,39}$/));
export const DocumentInput = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(120)).annotate({
    description: "What it is, as the owner would call it: Invoice INV-12, October accounts pack.",
  }),
  recipe: Schema.optional(recipeName).annotate({
    description:
      "The recipe to run, from kin_recipes. Leave out for a one-off file made from your brief.",
  }),
  entry: Schema.optional(KinRecordKey).annotate({
    description: "The entry it is for, such as INV-12, when the recipe reads one.",
  }),
  inputs: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description:
      "Only the recipe's inputs that come from you, by name, as the owner said them. Kin reads every stored figure and works out every sum itself.",
  }),
  brief: Schema.optional(Schema.String.check(Schema.isMaxLength(20_000))).annotate({
    description:
      "For a one-off file: what to make, with every figure in it. With a recipe: anything else the owner asked. For writeRecipe: what the recipe makes and from what.",
  }),
  writeRecipe: Schema.optional(Schema.Boolean).annotate({
    description: "Write a new recipe, or change the one named in recipe, instead of making a file.",
  }),
  sourceEventId: TrimmedNonEmptyString,
});
export type DocumentInput = typeof DocumentInput.Type;
export const DocumentResult = Schema.Struct({
  /** The worker making a one-off file or writing a recipe; `null` when Kin made it in the call. */
  workerId: Schema.NullOr(Schema.String),
  threadLink: Schema.NullOr(Schema.String),
  recipe: Schema.NullOr(Schema.String),
  /** The number the file carries; `null` for a draft or an unnumbered recipe. */
  number: Schema.NullOr(Schema.String),
  draft: Schema.Boolean,
  /** The docs a recipe made, already filed and shown as a card in the chat. */
  documents: Schema.Array(
    Schema.Struct({ key: Schema.String, title: Schema.String, version: Schema.Number }),
  ),
  sensitive: Schema.optional(Schema.Literal(true)),
});

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const NO_INPUTS: Readonly<Record<string, Value>> = {};
const denied = (message: string) => new KinChatError({ reason: "not_allowed", message });
const NOTHING = "Nothing started.";

const sha256 = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

export type Plan = {
  readonly mode: "document" | "recipe";
  readonly recipe: StoredRecipe | null;
  /** The recipe a recipe job writes or changes. */
  readonly recipeName: string | null;
  readonly entry: RecordRow | undefined;
  readonly inputs: Readonly<Record<string, Value>>;
  readonly inputsJson: string;
  readonly inputsHash: string;
  readonly number: string | null;
  readonly draft: boolean;
  readonly sensitive: boolean;
  readonly docOrigin: string;
};

/** What a worker job will run with: the agent's brief, and an entry's key if it named one. */
export const planJob = Effect.fn("KinDocJobs.plan")(function* (
  orgId: KinOrgId,
  input: DocumentInput,
) {
  const workspace = yield* KinWorkspace;
  const records = yield* KinRecords;
  const recipes = yield* workspace.recipes(orgId);
  const named =
    input.recipe === undefined ? undefined : recipes.find((one) => one.name === input.recipe);
  const entry = input.entry === undefined ? undefined : yield* records.get(orgId, input.entry);
  if (input.entry !== undefined && entry === undefined)
    return yield* new KinChatError({
      reason: "not_found",
      message: `No entry ${input.entry}. ${NOTHING}`,
    });

  if (input.writeRecipe === true) {
    if (input.recipe === undefined)
      return yield* invalid(`Name the recipe to write in recipe. ${NOTHING}`);
    const inputsJson = canonical({ brief: input.brief ?? "" });
    return {
      mode: "recipe",
      recipe: named ?? null,
      recipeName: input.recipe,
      entry: undefined,
      inputs: NO_INPUTS,
      inputsJson,
      inputsHash: sha256(inputsJson),
      number: null,
      draft: false,
      sensitive: false,
      docOrigin: `recipe:${input.recipe}`,
    } satisfies Plan;
  }

  if (input.recipe !== undefined)
    return yield* new KinChatError({
      reason: "not_found",
      message:
        named === undefined
          ? `There is no recipe ${input.recipe}. Recipes here: ${recipes.map((one) => one.name).join(", ") || "none"}. Call kin_recipes, or have one written with writeRecipe. ${NOTHING}`
          : `Kin makes a recipe's document itself, in the call. ${NOTHING}`,
    });
  // A one-off file: the agent's brief is all the worker gets, plus the entry's key if named.
  if (input.inputs !== undefined && Object.keys(input.inputs).length > 0)
    return yield* invalid(`A one-off file takes its figures in brief, not inputs. ${NOTHING}`);
  if ((input.brief ?? "").trim().length === 0)
    return yield* invalid(`Say in brief what to make, with every figure it shows. ${NOTHING}`);
  const inputsJson = canonical({
    title: input.title,
    brief: input.brief,
    entry: entry?.key ?? null,
  });
  const inputsHash = sha256(inputsJson);
  return {
    mode: "document",
    recipe: null,
    recipeName: null,
    entry,
    inputs: NO_INPUTS,
    inputsJson,
    inputsHash,
    number: null,
    draft: false,
    sensitive:
      entry !== undefined && entrySensitive(entry, yield* listDef(orgId, entry.registerId)),
    docOrigin:
      entry === undefined ? `file:${inputsHash}` : `file:${entry.recordId}:${sha256(input.title)}`,
  } satisfies Plan;
});

/**
 * A worker job's label as of now, inside the write that admits it: the plan's, anything the turn
 * has read, or the entry's own. A brief or a recipe the agent writes may carry what it read.
 */
export const workerJobSensitive = Effect.fn("KinDocJobs.sensitive")(function* (
  orgId: KinOrgId,
  wakeupId: string,
  plan: Plan,
) {
  if (plan.sensitive || (yield* turnSensitive(orgId, wakeupId))) return true;
  if (plan.entry === undefined) return false;
  const entry = yield* (yield* KinRecords).getById(orgId, plan.entry.recordId);
  return entry !== undefined && entrySensitive(entry, yield* listDef(orgId, entry.registerId));
});

const returnRules = [
  `Put each finished file in out/ under a plain name (letters, digits, spaces, . _ - and brackets). Kin takes back only what your report names, as evidence {"kind": "file", "ref": "out/<name>"}: PDF, PNG, JPEG, WebP, SVG, CSV, XLSX, DOCX, PPTX, Markdown, text or JSON, at most ${RETURN_CAPS.files} files, ${RETURN_CAPS.fileBytes / 1048576} MB each and ${RETURN_CAPS.totalBytes / 1048576} MB in all. No links, no HTML. An SVG is plain shapes, text and paint, with no script, image, outside link or CSS import. An Office file has no macros, embedded objects, templates or outside links but web and email hyperlinks. A CSV cell that starts with = + - or @ and isn't a number starts with ' instead. Anything else in out/ is left behind.`,
  "Kin commits nothing and opens no pull request for this task, whatever you were told before; it removes this worktree after taking the files.",
];

/** The worker's whole brief, written by Kin. Data the agent gave is quoted, never instructions. */
export const docBrief = (plan: Plan, input: DocumentInput) => {
  const said =
    input.brief === undefined || input.brief.trim().length === 0
      ? []
      : [quote("what the agent passed on from the owner (untrusted)", { text: input.brief }, true)];
  if (plan.mode === "recipe")
    return [
      "You were called by Kin. Do this task yourself.",
      `Goal:\n${plan.recipe === null ? "Write" : "Change"} the recipe \`${plan.recipeName}\` in recipes/${plan.recipeName}/, so Kin can make "${input.title}" from it.`,
      ...said,
      RECIPE_GUIDE,
      `Only files under recipes/${plan.recipeName}/ are kept: when your run ends Kin checks RECIPE.md, renders the recipe from its sample.json, and commits the folder, with its history, only if that render works; otherwise the agent gets Typst's error. Read recipes/ for working examples: recipes/invoice/ shows computed fields and a template. You have no shell and need none: write the files with your file tools.`,
      reportFormat,
    ].join("\n\n");
  return [
    "You were called by Kin. Do this task yourself.",
    `Goal:\nMake "${input.title}" as one file, from the brief below and nothing else. Every figure it shows must be one the brief gives: never work one out yourself.`,
    ...said,
    "If a step fails, report blocked with the error in plain words.",
    ...returnRules,
    reportFormat,
  ].join("\n\n");
};

const RECIPE_GUIDE = `A recipe is a folder: RECIPE.md, template.typ (for a PDF), sample.json and anything the template shows, such as a logo or a font. Kin renders it itself, with no worker; nothing in it runs but the template, in Typst 0.15 with no packages and no network.
RECIPE.md starts with YAML front matter between --- lines: name (the folder's name), kind (typst, or table for CSVs and a workbook), title, description (one line the agent reads), list (when it is for one entry of a list, such as invoices), numbered (true when it shows the entry's issued number), sensitive (Kin labels a file confidential by where its inputs come from, such as amounts, bank details, tax ids or a sensitive entry; true here labels it so anyway), inputs, computed (typst), sheets and workbook (table), and outputs (for typst each PDF's name; for table each file's name, {month} for an input's value).
Each input has a type (text, integer, decimal, money, date, boolean, month or table with columns), required (default true for stored values, false for the agent's), a description, and from: where Kin reads it. Leave from out for the agent's own words; otherwise one of entry.key|title|state|amount|tax|date|due|notes|number, entry.fields.<field>, client.name|address|gstin|placeOfSupply|terms, company.legalName|tradeName|address|gstin|pan|placeOfSupply|sac, company.bank.accountName|accountNumber|ifsc|bankName|branch|upi, system.number|draft|today, rows.<list> (a table of that list's entries in a month, with period naming a month input; columns from key, title, state, amount, tax, date, due, client, category, number, field_<field>), or payments (a table: invoice, client, amount, paidOn).
Every figure the document shows that Kin doesn't store is a computed field, worked out by Kin in exact integers, in order, each one function: times [amount, factor], percent [amount, rate] (round: half-up, half-even, down or up), sum [amounts, or table.column], minus [a, b], first [values], each { rows: <table>, set: { <column>: <field> } } (each column it sets is one value per row: text, a number or an amount, never a table), words <amount>, date [<day>, "D MMM YYYY" | "D MMMM YYYY" | "DD/MM/YYYY" | "MMMM YYYY"], gst { taxable, total, recordedTax, rate, supplierGstin, supplierPlace, clientGstin, clientPlace, exportUnderLut } and markdown <text>. Arguments name inputs or earlier fields, or are literals.
template.typ reads #let d = json("/inputs.json"): every input and computed field, money as {minor, currency, text}; it shows money by its text and never does arithmetic on it. sys.inputs.output is the PDF being made. Put wording the owner may change in #let lines at its top.
A table recipe's sheets each have a name, the table input they show, a CSV file name, columns (header and field, amount.currency for a money column's currency) and leaveOutOfTotals; workbook names the XLSX.
sample.json holds invented values for every input, as Kin would give them: money as {"minor": <integer>, "currency": "INR"}, days as 2026-11-12.
The body after the front matter is notes for the agent on when and how to use it.`;

export type JobRow = {
  readonly orgId: KinOrgId;
  readonly workerId: KinWorkerId;
  readonly agentId: KinAgentId;
  readonly wakeupId: string;
  readonly mode: "document" | "recipe";
  readonly recipe: string | null;
  readonly recipeCommit: string;
  readonly entryRecordId: string | null;
  readonly inputsSha256: string;
  readonly number: string | null;
  readonly sensitive: number;
  readonly docOrigin: string;
  readonly chatId: string | null;
  readonly audience: "owner_only" | "shared";
  readonly answeredMessageId: string | null;
  readonly answeredAuthorKind: "person" | "agent" | null;
  readonly answeredAuthorId: string | null;
  readonly collectedAt: number | null;
  readonly outcomeJson: string | null;
  /** The worker's title: what the agent called the file. */
  readonly title: string;
};

const OutcomeJson = Schema.fromJsonString(
  Schema.Struct({
    summary: Schema.String,
    documents: Schema.Array(
      Schema.Struct({ recordId: Schema.String, key: Schema.String, title: Schema.String }),
    ),
    problems: Schema.Array(Schema.String),
    /** How the worker makes a refused file again: the agent reads it, the owner never does. */
    retry: Schema.optional(Schema.Array(Schema.String)),
  }),
);
type Outcome = typeof OutcomeJson.Type;
const decodeOutcome = Schema.decodeUnknownOption(OutcomeJson);
const decodeDocuments = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      recordId: TrimmedNonEmptyString,
      key: TrimmedNonEmptyString,
      title: KinTrimmedText,
    }),
  ),
);
const encodeOutcome = Schema.encodeEffect(OutcomeJson);

/** The report as the lead reads it: the worker's words, with what Kin itself filed and refused. */
const reported = (report: WorkerReport, outcome: Outcome): WorkerReport => ({
  ...report,
  result: outcome.documents.length === 0 && report.result === "done" ? "blocked" : report.result,
  summary: `${outcome.summary} ${report.summary}`.slice(0, 800),
  // Only what Kin filed: a worker's own refs never reach the lead as files.
  evidence: [
    ...report.evidence.filter((item) => item.kind !== "file"),
    ...outcome.documents.map((doc) => ({ kind: "link" as const, ref: doc.key, note: doc.title })),
  ],
  openQuestions: [...outcome.problems, ...(outcome.retry ?? []), ...report.openQuestions].slice(
    0,
    20,
  ),
});

export class KinDocCollector extends Context.Service<
  KinDocCollector,
  {
    /**
     * The report for a finished document job, once its files are filed, or `undefined` when
     * the worker is no document job. Collecting again returns the same outcome.
     */
    readonly collect: (
      worker: {
        readonly orgId: KinOrgId;
        readonly workerId: KinWorkerId;
        readonly threadId: ThreadId;
      },
      completed: boolean,
      report: WorkerReport,
    ) => Effect.Effect<WorkerReport | undefined>;
    /** Removes a job's worktree, its inputs first; a no-op for a worker that is no document job. */
    readonly cleanup: (orgId: KinOrgId, workerId: KinWorkerId) => Effect.Effect<void>;
    /** At startup: removes the worktree of every job whose run is over. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/kin/gendocs/DocJobs/KinDocCollector") {}

/**
 * Removes a job's worktree and records it gone once it is; until then its row says it's owed.
 * Nothing is removed unless the worktree is itself, not a link, at its own place under the
 * documents folder; the inputs go first, only from its own `in/`, never through a link put there.
 */
export const cleanupJob = Effect.fn("KinDocJobs.cleanup")(
  function* (orgId: KinOrgId, workerId: KinWorkerId) {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const workspace = yield* KinWorkspace;
    const [job] = yield* sql<{ removedAt: number | null }>`SELECT removed_at AS "removedAt"
      FROM kin_doc_jobs WHERE org_id = ${orgId} AND worker_id = ${workerId} ORDER BY worker_id`;
    if (job === undefined || job.removedAt !== null) return;
    const worktree = jobWorktree(config.worktreesDir, workerId);
    if (yield* fs.exists(worktree)) {
      const linked = yield* fs.readLink(worktree).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      const canonical = yield* fs.realPath(worktree).pipe(Effect.option);
      const documents = yield* fs.realPath(config.worktreesDir).pipe(Effect.option);
      // A link at the worktree or at any folder above it would point the removal elsewhere.
      if (
        linked ||
        Option.isNone(canonical) ||
        Option.isNone(documents) ||
        canonical.value !== path.join(documents.value, "kin-documents", workerId)
      )
        return yield* Effect.logWarning(
          "Kin left a document job's worktree: it isn't a plain folder in its own place",
          { workerId },
        );
      const inputs = yield* fs.realPath(path.join(worktree, "in")).pipe(Effect.option);
      if (Option.isSome(inputs) && inputs.value === path.join(canonical.value, "in"))
        yield* fs.remove(path.join(inputs.value, "inputs.json"), { force: true });
    }
    yield* workspace.discard(orgId, workerId);
    if (yield* fs.exists(worktree))
      return yield* Effect.logWarning("Kin couldn't remove a document job's worktree yet", {
        workerId,
      });
    yield* sql`UPDATE kin_doc_jobs SET removed_at = ${yield* Clock.currentTimeMillis}
      WHERE org_id = ${orgId} AND worker_id = ${workerId} AND removed_at IS NULL`;
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin couldn't clean up a document job", { cause }),
  ),
);

/**
 * Stores a job's outcome once. The same outcome again returns it; a different one fails, so a
 * second collection never replaces what the first filed.
 */
export const recordOutcome = Effect.fn("KinDocJobs.recordOutcome")(function* (
  orgId: KinOrgId,
  workerId: KinWorkerId,
  outcomeJson: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`UPDATE kin_doc_jobs SET collected_at = ${now}, outcome_json = ${outcomeJson}
        WHERE org_id = ${orgId} AND worker_id = ${workerId} AND collected_at IS NULL`;
      const [row] = yield* sql<{ outcomeJson: string | null }>`SELECT outcome_json AS "outcomeJson"
        FROM kin_doc_jobs WHERE org_id = ${orgId} AND worker_id = ${workerId} ORDER BY worker_id`;
      if (row?.outcomeJson !== outcomeJson)
        return yield* denied(
          "This job was already collected with another outcome; Kin kept the first.",
        );
      return outcomeJson;
    }),
  );
});

const SWEEP_PAGE = 500;
const UNCONFIRMED: Outcome = {
  summary:
    "Kin took back no file: it couldn't confirm the worker had stopped, so it couldn't trust out/. Ask again.",
  documents: [],
  problems: [],
};
const FAILED: Outcome = {
  summary: "Kin couldn't file this job's files; ask it again.",
  documents: [],
  problems: [],
};

export const makeCollectorLayer = (options: { readonly sweepPage?: number } = {}) =>
  Layer.effect(
    KinDocCollector,
    Effect.gen(function* () {
      const sweepPage = options.sweepPage ?? SWEEP_PAGE;
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const workspace = yield* KinWorkspace;
      const records = yield* KinRecords;
      const chat = yield* KinChatService;
      const scopes = yield* AgentScope;
      const renderer = yield* KinDocRenderer;
      // Workers elsewhere have no shell (`KinWorkSandbox`), so file tools are all that touched out/.
      const shellHost = (yield* HostProcess.Platform) === "linux";
      const jobContext = Effect.provideService(SqlClient.SqlClient, sql);
      const cleanup = (orgId: KinOrgId, workerId: KinWorkerId) =>
        cleanupJob(orgId, workerId).pipe(
          jobContext,
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ServerConfig, config),
          Effect.provideService(KinWorkspace, workspace),
        );

      const outcomeOf = Effect.fn("KinDocCollector.outcome")(function* (
        job: JobRow,
        completed: boolean,
        report: WorkerReport,
      ) {
        const worktree = jobWorktree(config.worktreesDir, job.workerId);
        if (job.mode === "recipe") {
          if (!completed || job.recipe === null)
            return {
              summary: "Kin kept no recipe change: the run didn't finish.",
              documents: [],
              problems: [],
            };
          const orgId = job.orgId;
          const withWorkspace = Effect.provideService(KinWorkspace, workspace);
          yield* recordBaseline(orgId).pipe(withWorkspace);
          const change = yield* workspace.applyRecipeChange(orgId, {
            workerId: job.workerId,
            recipe: job.recipe,
            agentId: job.agentId,
            verify: verifySample(renderer, orgId),
          });
          if (change._tag === "committed")
            yield* labelChange(orgId, job.recipe, change, job.sensitive === 1).pipe(withWorkspace);
          const left =
            change._tag === "refused" || change.left.length === 0
              ? []
              : [`Kin kept only recipes/${job.recipe}/; it left out ${change.left.join(", ")}.`];
          return {
            summary:
              change._tag === "committed"
                ? `Kin rendered the ${job.recipe} recipe's sample and committed it (${change.commit.slice(0, 12)}); make documents with it with kin_document.`
                : change._tag === "unchanged"
                  ? `The ${job.recipe} recipe is unchanged: the worker left nothing new in recipes/${job.recipe}/.`
                  : `Kin didn't keep the ${job.recipe} recipe: ${change.reason}.`,
            documents: [],
            problems: left,
          } satisfies Outcome;
        }
        if (!completed)
          return {
            summary: "Kin took back no file: the run didn't finish.",
            documents: [],
            problems: [],
          };
        // A recipe job from before Kin rendered recipes itself: its files are no recipe's output.
        if (job.recipe !== null)
          return {
            summary: `Kin took back no file: it now makes the ${job.recipe} recipe's documents itself, so ask for it again.`,
            documents: [],
            problems: [],
          } satisfies Outcome;
        const named = report.evidence
          .filter((item) => item.kind === "file")
          .map((item) => item.ref);
        const returned = yield* takeOutputs({ worktree, named });
        const problems = returned.refused.map((one) => `${one.name} wasn't saved: ${one.reason}.`);
        const retry = [...new Set(returned.refused.flatMap((one) => one.retry ?? []))];
        const documents: Array<Outcome["documents"][number]> = [];
        const entry =
          job.entryRecordId === null
            ? undefined
            : yield* records.getById(job.orgId, job.entryRecordId);
        const writer: Writer = {
          actor: { _tag: "agent", agentId: job.agentId },
          via: "worker",
          wakeupId: job.wakeupId,
          ...(job.chatId === null ? {} : { chatId: KinChatId.make(job.chatId) }),
        };
        for (const file of returned.taken) {
          const attachmentId = yield* renderer.store(job.orgId, job.workerId, file);
          const title = returned.taken.length === 1 ? job.title : `${job.title} · ${file.name}`;
          const written = yield* Docs.fileVersion(
            job.orgId,
            writer,
            {
              ...(job.answeredMessageId === null ||
              job.answeredAuthorKind === null ||
              job.answeredAuthorId === null
                ? {}
                : {
                    answered: {
                      messageId: job.answeredMessageId,
                      author:
                        job.answeredAuthorKind === "person"
                          ? { _tag: "person", personId: KinPersonId.make(job.answeredAuthorId) }
                          : { _tag: "agent", agentId: KinAgentId.make(job.answeredAuthorId) },
                    },
                  }),
              audience: job.audience,
            },
            {
              docOrigin: `${job.docOrigin}:${file.name}`,
              originKey: `kin-doc-job:${job.workerId}:${file.name}`,
              title: title.slice(0, 200),
              summary: "Made by a worker from the agent's brief",
              owner: { _tag: "agent", agentId: job.agentId },
              sensitive: job.sensitive === 1,
              ...(entry?.partyId === undefined ? {} : { partyId: entry.partyId }),
              file: {
                attachmentId,
                name: file.name,
                mimeType: file.mimeType,
                bytes: file.bytes.length,
                sha256: file.sha256,
                pages: file.pages,
                recipe: null,
                inputsHash: job.inputsSha256,
                workerId: job.workerId,
                number: null,
                draft: false,
              },
            },
          );
          if (entry !== undefined)
            yield* Docs.link(job.orgId, writer, { key: written.row.key }, [entry.key], "relates");
          documents.push({
            recordId: written.row.recordId,
            key: written.row.key,
            title: written.row.title,
          });
        }
        const count = documents.length;
        return {
          summary:
            count === 0
              ? "Kin filed no file from this job."
              : `Kin filed ${count === 1 ? "the file" : `${count} files`} as ${documents.map((doc) => doc.key).join(", ")}.`,
          documents,
          problems,
          ...(retry.length === 0 ? {} : { retry }),
        } satisfies Outcome;
      });

      /** A document job's outcome, filed once: a later collection returns the stored one. */
      const settle = Effect.fn("KinDocCollector.settle")(function* (
        job: JobRow,
        threadId: ThreadId,
        completed: boolean,
        workerReport: WorkerReport,
      ) {
        const stored = job.outcomeJson === null ? undefined : decodeOutcome(job.outcomeJson);
        if (stored !== undefined && stored._tag === "Some") return stored.value;
        // out/ is read only once nothing the worker started can still change it.
        const gone = yield* scopes.reap(threadId);
        const outcome =
          !gone && shellHost
            ? UNCONFIRMED
            : yield* outcomeOf(job, completed, workerReport).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Kin couldn't file a document job's files", { cause }).pipe(
                    Effect.as(FAILED),
                  ),
                ),
              );
        yield* recordOutcome(job.orgId, job.workerId, yield* encodeOutcome(outcome)).pipe(
          jobContext,
        );
        if (job.chatId !== null) {
          const documents = yield* decodeDocuments(outcome.documents);
          yield* chat
            .setTaskCardDocuments({
              orgId: job.orgId,
              chatId: KinChatId.make(job.chatId),
              threadId,
              documents,
              lastError: documents.length === 0 ? (outcome.problems[0] ?? outcome.summary) : null,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Kin couldn't update a document card", { cause }),
              ),
            );
        }
        return outcome;
      });
      const collect: KinDocCollector["Service"]["collect"] = Effect.fn("KinDocCollector.collect")(
        function* (worker, completed, workerReport) {
          const found = yield* sql<JobRow>`SELECT j.org_id AS "orgId", j.worker_id AS "workerId",
            j.agent_id AS "agentId", j.wakeup_id AS "wakeupId", j.mode, j.recipe,
            j.recipe_commit AS "recipeCommit", j.entry_record_id AS "entryRecordId",
            j.inputs_sha256 AS "inputsSha256", j.number, j.sensitive, j.doc_origin AS "docOrigin",
            j.chat_id AS "chatId", j.audience, j.answered_message_id AS "answeredMessageId",
            j.answered_author_kind AS "answeredAuthorKind", j.answered_author_id AS "answeredAuthorId",
            j.collected_at AS "collectedAt",
            j.outcome_json AS "outcomeJson", COALESCE(w.title, 'Document') AS title
          FROM kin_doc_jobs j
          LEFT JOIN kin_workers w ON w.org_id = j.org_id AND w.worker_id = j.worker_id
          WHERE j.org_id = ${worker.orgId} AND j.worker_id = ${worker.workerId}
          ORDER BY j.worker_id`.pipe(Effect.result);
          // Unreadable, it may be a document job: blocked, never handed on to be published.
          if (found._tag === "Failure") {
            yield* Effect.logWarning("Kin couldn't read a worker's document job", {
              cause: found.failure,
            });
            return reported(workerReport, FAILED);
          }
          const [job] = found.success;
          if (job === undefined) return undefined;
          // Every way out of a document job ends in its cleanup; none falls through to publishing.
          return yield* settle(job, worker.threadId, completed, workerReport).pipe(
            Effect.map((outcome) => reported(workerReport, outcome)),
            Effect.catchCause((cause) =>
              Effect.logWarning("Kin document collection failed", { cause }).pipe(
                Effect.as(reported(workerReport, FAILED)),
              ),
            ),
            Effect.ensuring(cleanup(job.orgId, job.workerId)),
          );
        },
        Effect.provideService(KinRecords, records),
        jobContext,
      );

      const sweep = Effect.fn("KinDocCollector.sweep")(
        function* () {
          // A startup scan across orgs, a page at a time: a job whose run is over owes its worktree.
          let after = { orgId: "", workerId: "" };
          for (;;) {
            const rows = yield* sql<{ orgId: KinOrgId; workerId: KinWorkerId }>`SELECT
              j.org_id AS "orgId", j.worker_id AS "workerId"
            FROM kin_doc_jobs j
            LEFT JOIN kin_workers w ON w.org_id = j.org_id AND w.worker_id = j.worker_id
            WHERE j.removed_at IS NULL
              AND (j.collected_at IS NOT NULL OR w.worker_id IS NULL OR w.ended_at IS NOT NULL)
              AND (j.org_id > ${after.orgId}
                OR (j.org_id = ${after.orgId} AND j.worker_id > ${after.workerId}))
            ORDER BY j.org_id, j.worker_id LIMIT ${sweepPage}`;
            for (const row of rows) yield* cleanup(row.orgId, row.workerId);
            if (rows.length < sweepPage) return;
            after = rows.at(-1)!;
          }
        },
        Effect.catchCause((cause) =>
          Effect.logWarning("Kin couldn't sweep document worktrees", { cause }),
        ),
      );
      return KinDocCollector.of({ collect, cleanup, sweep: sweep() });
    }),
  );
export const collectorLayer = makeCollectorLayer();
