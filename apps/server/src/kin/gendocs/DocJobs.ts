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
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { createDeterministicAttachmentId } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { quote } from "../lead/LeadPrompt.ts";
import { reportFormat } from "../lead/workerBrief.ts";
import * as Docs from "../work/docs.ts";
import { KinRecords, type Writer } from "../work/KinRecords.ts";
import type { RecordRow } from "../work/recordRows.ts";
import { listDef } from "../work/registers.ts";
import { entrySensitive, gatherFacts, jobSensitive } from "./facts.ts";
import { assembleInputs, needsEntry, type Value } from "./recipe.ts";
import { RETURN_CAPS, takeOutputs } from "./returnPath.ts";
import { jobWorktree, KinWorkspace, type StoredRecipe } from "./workspace.ts";

/**
 * A document job: a worker makes a file in a worktree of the org's workspace, from a recipe or
 * from the agent's brief alone, or writes a recipe. The server chooses the inputs, writes the
 * brief and, when the run ends, takes back only the files the report names (`takeOutputs`),
 * filing each as a version of a doc whose provenance comes from the job's stored row.
 */

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
      "Only the recipe's inputs that come from you, by name, as the owner said them. Kin reads every stored figure itself.",
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
  workerId: Schema.String,
  threadLink: Schema.String,
  recipe: Schema.NullOr(Schema.String),
  /** The number the file carries; `null` for a draft or an unnumbered recipe. */
  number: Schema.NullOr(Schema.String),
  draft: Schema.Boolean,
});

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const NO_INPUTS: Readonly<Record<string, Value>> = {};
const denied = (message: string) => new KinChatError({ reason: "not_allowed", message });
const NOTHING = "Nothing started.";

const sha256 = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
/** Stable JSON: the same inputs hash the same whatever order they were built in. */
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : typeof value === "object" && value !== null
      ? `{${Object.keys(value)
          .toSorted()
          .map((key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`)
          .join(",")}}`
      : JSON.stringify(value);

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
  readonly tools: ReadonlyArray<"typst">;
};

/**
 * What a job will run with, from stored rows and the agent's declared inputs only. `shell` is
 * why this host's workers have no shell, if they haven't: a recipe needs one to run.
 */
export const planJob = Effect.fn("KinDocJobs.plan")(function* (
  orgId: KinOrgId,
  input: DocumentInput,
  shell: { readonly available: true } | { readonly available: false; readonly reason: string },
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
  const noShell = (what: string) =>
    shell.available
      ? undefined
      : denied(
          `${what} runs commands, and workers on this host have no shell (${shell.reason}). A one-off text, Markdown, CSV, SVG or JSON file can still be made. ${NOTHING}`,
        );

  if (input.writeRecipe === true) {
    if (input.recipe === undefined)
      return yield* invalid(`Name the recipe to write in recipe. ${NOTHING}`);
    const refused = noShell("Writing a recipe");
    if (refused !== undefined) return yield* refused;
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
      tools: ["typst"],
    } satisfies Plan;
  }

  if (input.recipe !== undefined && named === undefined)
    return yield* new KinChatError({
      reason: "not_found",
      message: `There is no recipe ${input.recipe}. Recipes here: ${recipes.map((one) => one.name).join(", ") || "none"}. Call kin_recipes, or have one written with writeRecipe. ${NOTHING}`,
    });
  if (named === undefined) {
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
        entry === undefined
          ? `file:${inputsHash}`
          : `file:${entry.recordId}:${sha256(input.title)}`,
      tools: ["typst"],
    } satisfies Plan;
  }

  const refused = noShell(`The ${named.name} recipe`);
  if (refused !== undefined) return yield* refused;
  if (needsEntry(named) && entry === undefined)
    return yield* invalid(
      `The ${named.name} recipe is for one entry: name it in entry. ${NOTHING}`,
    );
  if (named.list !== null && entry !== undefined && entry.registerId !== named.list)
    return yield* invalid(
      `The ${named.name} recipe is for ${named.list} entries, and ${entry.key} isn't one. ${NOTHING}`,
    );
  const given = input.inputs ?? {};
  const gathered = yield* gatherFacts(orgId, named, entry, given);
  const assembled = assembleInputs(named, given, gathered.facts, gathered.currency);
  if ("error" in assembled) return yield* assembled.error;
  const inputsJson = canonical(assembled.inputs);
  const inputsHash = sha256(inputsJson);
  return {
    mode: "document",
    recipe: named,
    recipeName: named.name,
    entry,
    inputs: assembled.inputs,
    inputsJson,
    inputsHash,
    number: named.numbered ? gathered.number : null,
    draft: named.numbered && gathered.number === null,
    sensitive: jobSensitive(named, assembled.inputs, gathered),
    docOrigin:
      entry === undefined
        ? `recipe:${named.name}:${inputsHash}`
        : `recipe:${named.name}:${entry.recordId}`,
    tools: named.tools,
  } satisfies Plan;
});

const returnRules = [
  `Put each finished file in out/ under a plain name (letters, digits, spaces, . _ - and brackets). Kin takes back only what your report names, as evidence {"kind": "file", "ref": "out/<name>"}: PDF, PNG, JPEG, WebP, SVG without scripts, CSV, XLSX, DOCX, PPTX, Markdown, text or JSON, at most ${RETURN_CAPS.files} files, ${RETURN_CAPS.fileBytes / 1048576} MB each and ${RETURN_CAPS.totalBytes / 1048576} MB in all. No links, no HTML, no macros. Anything else in out/ is left behind.`,
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
      `Only files under recipes/${plan.recipeName}/ are kept: when your run ends Kin checks RECIPE.md and commits that folder, with its history. Read recipes/ for working examples. Test it on invented inputs you write in in/inputs.json, and look at what it makes; nothing in in/ or out/ is kept.`,
      reportFormat,
    ].join("\n\n");
  const recipe = plan.recipe;
  return [
    "You were called by Kin. Do this task yourself.",
    recipe === null
      ? `Goal:\nMake "${input.title}" as one file, from the brief below and nothing else. Every figure it shows must be one the brief gives: never work one out yourself.`
      : `Goal:\nMake "${input.title}" with the ${recipe.title} recipe in recipes/${recipe.name}/. in/inputs.json holds its inputs exactly as Kin gave them. Never change a figure there or work one out yourself: the recipe's script does every sum.`,
    ...(recipe === null
      ? []
      : [
          quote(
            `recipes/${recipe.name}/RECIPE.md (the org's recipe)`,
            { text: recipe.instructions },
            true,
          ),
        ]),
    ...(plan.draft
      ? ["It is a draft: it has no number yet, and it must say DRAFT where the number would be."]
      : []),
    ...said,
    "Typst and Node are on your PATH. If a step fails, report blocked with the error in plain words; never change the recipe or its numbers to get past it.",
    ...returnRules,
    reportFormat,
  ].join("\n\n");
};

const RECIPE_GUIDE = `A recipe is a folder: RECIPE.md, its scripts and its templates. RECIPE.md starts with YAML front matter between --- lines:
name (the folder's name), title, description (one line the agent reads), list (when it is for one entry of a list, such as invoices), numbered (true when it shows the entry's issued number), sensitive (Kin labels a file confidential by where its inputs come from, such as amounts, bank details, tax ids or a sensitive entry; true here labels it so anyway), tools ([typst] when it renders PDF or PNG), outputs (file names, * for a varying part), and inputs.
Each input has a type (text, integer, decimal, money, date, boolean, month or table with columns), required (default true for stored values, false for the agent's), a description, and from: where Kin reads it. Leave from out for the agent's own words; otherwise one of entry.key|title|state|amount|tax|date|due|notes|number, entry.fields.<field>, client.name|gstin|placeOfSupply|terms, company.legalName|tradeName|address|gstin|pan|placeOfSupply|sac, company.bank.accountName|accountNumber|ifsc|bankName|branch|upi, system.number|draft|today, rows.<list> (a table of that list's entries in a month, with period naming a month input; columns from key, title, state, amount, tax, date, due, client, category, number, field_<field>), or payments (a table: invoice, client, amount, paidOn). Money is {"minor": <integer>, "currency": "INR"}.
The body after the front matter tells a worker how to run it. Scripts are plain Node .mjs with no packages, run as node recipes/<name>/build.mjs in/inputs.json out; they do every sum in integer minor units. Typst templates read the data with --input; use typst compile --root . --ignore-system-fonts. Settings the owner may change go in config.json beside them.`;

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

/** `out/accounts-*.xlsx` style names, as a recipe declares its outputs. */
const matchesOutput = (patterns: ReadonlyArray<string>, name: string) =>
  patterns.some((pattern) =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*")}$`).test(
      name,
    ),
  );

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
  openQuestions: [...outcome.problems, ...report.openQuestions].slice(0, 20),
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
  }
>()("t3/kin/gendocs/DocJobs/KinDocCollector") {}

export const collectorLayer = Layer.effect(
  KinDocCollector,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const workspace = yield* KinWorkspace;
    const records = yield* KinRecords;
    const chat = yield* KinChatService;

    const store = Effect.fn("KinDocCollector.store")(function* (
      orgId: KinOrgId,
      workerId: KinWorkerId,
      file: { readonly sha256: string; readonly extension: string; readonly bytes: Uint8Array },
    ) {
      const base = createDeterministicAttachmentId("kin-chat", `${orgId}:${file.sha256}`);
      if (base === null) return yield* Effect.fail("no attachment id");
      const attachmentId = `${base}-${file.extension}`;
      const target = path.join(config.attachmentsDir, `${attachmentId}.${file.extension}`);
      // Stored by content: the same bytes again are the same file, written once.
      if (!(yield* fs.exists(target))) {
        yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
        const scratch = `${target}.${workerId}.tmp`;
        yield* fs.writeFile(scratch, file.bytes);
        yield* fs.rename(scratch, target);
      }
      return attachmentId;
    });

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
        const change = yield* workspace.applyRecipeChange(job.orgId, {
          workerId: job.workerId,
          recipe: job.recipe,
          agentId: job.agentId,
        });
        const left =
          change._tag === "refused" || change.left.length === 0
            ? []
            : [`Kin kept only recipes/${job.recipe}/; it left out ${change.left.join(", ")}.`];
        return {
          summary:
            change._tag === "committed"
              ? `Kin committed the ${job.recipe} recipe (${change.commit.slice(0, 12)}); run it with kin_document.`
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
      const named = report.evidence.filter((item) => item.kind === "file").map((item) => item.ref);
      const returned = yield* takeOutputs({ worktree, named });
      const problems = returned.refused.map((one) => `${one.name}: ${one.reason}`);
      const recipe =
        job.recipe === null
          ? undefined
          : (yield* workspace.recipes(job.orgId)).find((one) => one.name === job.recipe);
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
        if (recipe !== undefined && !matchesOutput(recipe.outputs, file.name)) {
          problems.push(`${file.name}: the ${recipe.name} recipe doesn't make a file by that name`);
          continue;
        }
        const attachmentId = yield* store(job.orgId, job.workerId, file);
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
            summary: `${job.recipe === null ? "Made" : `Made with the ${job.recipe} recipe`}${job.number === null ? "" : `, ${job.number}`}${job.number === null && recipe?.numbered === true ? ", draft" : ""}`,
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
              recipe: job.recipe === null ? null : { name: job.recipe, commit: job.recipeCommit },
              inputsHash: job.inputsSha256,
              workerId: job.workerId,
              number: job.number,
              draft: recipe?.numbered === true && job.number === null,
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
      } satisfies Outcome;
    });

    const collect: KinDocCollector["Service"]["collect"] = Effect.fn("KinDocCollector.collect")(
      function* (worker, completed, report) {
        const [job] = yield* sql<JobRow>`SELECT j.org_id AS "orgId", j.worker_id AS "workerId",
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
          ORDER BY j.worker_id`;
        if (job === undefined) return undefined;
        const stored = job.outcomeJson === null ? undefined : decodeOutcome(job.outcomeJson);
        if (stored !== undefined && stored._tag === "Some") return reported(report, stored.value);
        const outcome = yield* outcomeOf(job, completed, report).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Kin couldn't file a document job's files", { cause }).pipe(
              Effect.as({
                summary: "Kin couldn't file this job's files; ask it again.",
                documents: [],
                problems: [],
              } satisfies Outcome),
            ),
          ),
        );
        const now = yield* Clock.currentTimeMillis;
        yield* sql`UPDATE kin_doc_jobs SET collected_at = ${now}, outcome_json = ${yield* encodeOutcome(outcome)}
          WHERE org_id = ${job.orgId} AND worker_id = ${job.workerId} AND collected_at IS NULL`;
        if (job.chatId !== null) {
          const documents = yield* decodeDocuments(outcome.documents);
          yield* chat
            .setTaskCardDocuments({
              orgId: job.orgId,
              chatId: KinChatId.make(job.chatId),
              threadId: worker.threadId,
              documents,
              lastError: documents.length === 0 ? (outcome.problems[0] ?? outcome.summary) : null,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Kin couldn't update a document card", { cause }),
              ),
            );
        }
        yield* workspace.discard(job.orgId, job.workerId);
        return reported(report, outcome);
      },
      Effect.provideService(KinRecords, records),
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catchCause((cause) =>
        Effect.logWarning("Kin document collection failed", { cause }).pipe(Effect.as(undefined)),
      ),
    );
    return KinDocCollector.of({ collect });
  }),
);
