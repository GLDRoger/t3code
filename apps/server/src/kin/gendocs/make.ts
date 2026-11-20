// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous content hash; Digest would add a service to every caller.
import * as NodeCrypto from "node:crypto";
import {
  type KinAgentId,
  KinChatError,
  type KinOrgId,
  type KinPersonId,
  KinWorkerId,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Docs from "../work/docs.ts";
import { KinRecords, type Writer } from "../work/KinRecords.ts";
import { KIN_OWNER_LEVEL } from "../work/teamView.ts";
import { isMoney, parseFields } from "../work/lists.ts";
import { dayIn, formatMoney } from "../work/money.ts";
import { ownerZone, type RecordRow } from "../work/recordRows.ts";
import { priceDraft, pricedByDocuments, unpriced } from "./amounts.ts";
import { gatherFacts, jobSensitive } from "./facts.ts";
import { issuedNumber } from "./numbering.ts";
import { computeData, type TaxRegime } from "./compute.ts";
import {
  amountProblem,
  assembleInputs,
  declaredFigures,
  issuable,
  needsEntry,
  type Value,
} from "./recipe.ts";
import { recipeLabelled } from "./recipeLabels.ts";
import { KinDocRenderer } from "./render.ts";
import type { Taken } from "./returnPath.ts";
import { KinWorkspace, type StoredRecipe } from "./workspace.ts";

// A recipe's document, made by the server in the call that asks for it: the exact inputs, rendered
// (`render.ts`), each file filed as a version of its doc with provenance from the job row written
// here. Issuing an entry makes its documents again in place.

const sha256 = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
/** Stable JSON: the same inputs hash the same whatever order they were built in. */
export const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : typeof value === "object" && value !== null
      ? `{${Object.keys(value)
          .toSorted()
          .map((key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`)
          .join(",")}}`
      : JSON.stringify(value);

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const isChatError = Schema.is(KinChatError);
const NOTHING = "Nothing was made.";

/** Who asked: an agent in its turn, or the owner from a client. */
export type Requester =
  | {
      readonly _tag: "agent";
      readonly agentId: KinAgentId;
      readonly wakeupId: string;
      readonly writer: Writer;
      readonly chatId: string | null;
      readonly answered: { readonly messageId: string; readonly personId: KinPersonId } | null;
    }
  | { readonly _tag: "owner"; readonly personId: KinPersonId; readonly writer: Writer };

export type MakeRequest = {
  readonly orgId: KinOrgId;
  readonly recipe: string;
  readonly entry: string | undefined;
  /** Only the recipe's inputs that are the requester's; never a figure Kin stores. */
  readonly given: Readonly<Record<string, unknown>>;
  /** A doc whose own text is the recipe's body, such as a PRD made a PDF with report. */
  readonly doc?: string | undefined;
  readonly title: string;
  readonly requester: Requester;
  /** Names the job: the same key again returns what it made. */
  readonly jobKey: string;
  /** Checked again in the transaction that files the result: still allowed to make it. */
  readonly admit: Effect.Effect<void, KinChatError, SqlClient.SqlClient>;
  /** Render without filing: the owner's preview. */
  readonly preview?: boolean;
};

export type MadeDocument = {
  readonly recordId: string;
  readonly key: string;
  readonly title: string;
  readonly version: number;
};
export type Made = {
  readonly jobId: string;
  readonly recipe: string;
  readonly number: string | null;
  readonly draft: boolean;
  readonly sensitive: boolean;
  readonly documents: ReadonlyArray<MadeDocument>;
  /** Only for a preview: the files, never filed. */
  readonly files: ReadonlyArray<Taken>;
  /** What this call filed, to show as cards; empty when a retry found the stored outcome. */
  readonly written: ReadonlyArray<Docs.Written>;
};

const Stored = Schema.fromJsonString(
  Schema.Struct({
    draft: Schema.Boolean,
    documents: Schema.Array(
      Schema.Struct({
        recordId: Schema.String,
        key: Schema.String,
        title: Schema.String,
        version: Schema.Number,
      }),
    ),
  }),
);
const decodeStored = Schema.decodeUnknownOption(Stored);
const encodeStored = Schema.encodeEffect(Stored);
const decodeGiven = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

type Plan = {
  readonly entry: RecordRow | undefined;
  /** The draft takes what its documents come to as its amount and tax once this one is made. */
  readonly priced: boolean;
  readonly inputs: Readonly<Record<string, Value>>;
  readonly inputsHash: string;
  readonly number: string | null;
  readonly draft: boolean;
  readonly sensitive: boolean;
  readonly docOrigin: string;
  readonly logo: { readonly bytes: Uint8Array; readonly extension: string } | null;
  readonly tax: TaxRegime;
};

/** The doc's latest text as the body (and its title as the title) of a recipe that lays out Markdown. */
const fromDoc = Effect.fn("KinDocMaker.fromDoc")(function* (
  request: MakeRequest,
  recipe: StoredRecipe,
) {
  if (request.doc === undefined) return { given: request.given, sensitive: false };
  const takes = (name: string) =>
    recipe.inputs.some((one) => one.name === name && one.from === "agent");
  if (!takes("body"))
    return yield* invalid(
      `The ${recipe.name} recipe doesn't lay out a doc's text; the report recipe does. ${NOTHING}`,
    );
  const row = yield* Docs.docRow(request.orgId, { key: request.doc }, KIN_OWNER_LEVEL);
  const latest = yield* Docs.versionOf(request.orgId, row.recordId);
  if (latest === undefined || latest.bodyKind !== "markdown")
    return yield* invalid(
      `${row.key} is a file, not text, so it is already what it is. ${NOTHING}`,
    );
  return {
    given: {
      ...(takes("title") ? { title: latest.title } : {}),
      body: latest.body,
      ...request.given,
    },
    sensitive: row.sensitive === 1 || row.inheritedSensitive === 1,
  };
});

/** A title that names its entry by key ("Invoice INV-1") names it by its issued number instead. */
const numberedTitle = (title: string, key: string | undefined, number: string | null) =>
  key === undefined || number === null
    ? title
    : title.replace(
        new RegExp(`(?<![\\w-])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "g"),
        number,
      );

/**
 * What an issued document comes to, as its recipe declares it, when that is what its entry
 * records: a document never shows a total its entry doesn't. `undefined` for any other document.
 */
const issuedFigures = (recipe: StoredRecipe, final: Plan) => {
  const entry = final.entry;
  if (entry === undefined || final.number === null || final.draft || !issuable(recipe))
    return undefined;
  const problem = amountProblem(recipe);
  if (problem !== undefined) return invalid(`${NOTHING} ${problem}`);
  const computed = computeData(final.inputs, recipe.computed, final.tax);
  if ("error" in computed) return invalid(`${NOTHING} ${computed.error}`);
  const figures = declaredFigures(recipe, computed.data);
  if ("error" in figures) return invalid(`${NOTHING} The ${recipe.name} recipe: ${figures.error}.`);
  const recorded =
    entry.amountMinor === null
      ? null
      : { minor: entry.amountMinor, currency: entry.currency ?? "" };
  if (
    recorded === null ||
    recorded.minor !== figures.total.minor ||
    recorded.currency !== figures.total.currency
  )
    return invalid(
      `${NOTHING} ${final.number}'s document comes to ${formatMoney(figures.total)}, but ${entry.key} is recorded at ${recorded === null ? "no amount" : formatMoney(recorded)}. Correct whichever is wrong, then make it again.`,
    );
  const stored = parseFields(entry.fieldsJson).tax;
  if (
    stored !== undefined &&
    stored !== null &&
    isMoney(stored) &&
    (stored.minor !== figures.tax.minor || stored.currency !== figures.tax.currency)
  )
    return invalid(
      `${NOTHING} ${final.number}'s document charges ${formatMoney(figures.tax)} of tax, but ${entry.key} records ${formatMoney(stored)}. Correct whichever is wrong, then make it again.`,
    );
  return figures;
};

/** The exact inputs from stored rows and the requester's own, and what follows from them. */
const plan = Effect.fn("KinDocMaker.plan")(function* (request: MakeRequest, recipe: StoredRecipe) {
  const records = yield* KinRecords;
  const found =
    request.entry === undefined ? undefined : yield* records.get(request.orgId, request.entry);
  const priced =
    found !== undefined && issuable(recipe) && (yield* pricedByDocuments(request.orgId, found));
  // Its lines, not the amount an earlier document set, are what this document comes to.
  const entry = priced ? unpriced(found) : found;
  if (request.entry !== undefined && entry === undefined)
    return yield* new KinChatError({
      reason: "not_found",
      message: `No entry ${request.entry}. ${NOTHING}`,
    });
  if (needsEntry(recipe) && entry === undefined)
    return yield* invalid(
      `The ${recipe.name} recipe is for one entry: name it in entry. ${NOTHING}`,
    );
  if (recipe.list !== null && entry !== undefined && entry.registerId !== recipe.list)
    return yield* invalid(
      `The ${recipe.name} recipe is for ${recipe.list} entries, and ${entry.key} isn't one. ${NOTHING}`,
    );
  const source = yield* fromDoc(request, recipe);
  const gathered = yield* gatherFacts(request.orgId, recipe, entry, source.given);
  const assembled = assembleInputs(recipe, source.given, gathered.facts, gathered.currency);
  if ("error" in assembled) return yield* assembled.error;
  // The logo's bytes are part of what was rendered, though the template sees only its path.
  // India's GST leaves the hash as it was before other taxes, so its documents read as unchanged.
  const inputsHash = sha256(
    canonical(
      gathered.logo === null && gathered.tax._tag === "gst"
        ? assembled.inputs
        : {
            inputs: assembled.inputs,
            ...(gathered.logo === null ? {} : { logo: gathered.logo.sha256 }),
            ...(gathered.tax._tag === "gst" ? {} : { tax: gathered.tax }),
          },
    ),
  );
  return {
    entry,
    priced,
    inputs: assembled.inputs,
    inputsHash,
    number: recipe.numbered ? gathered.number : null,
    draft: recipe.numbered && gathered.number === null,
    sensitive:
      source.sensitive ||
      jobSensitive(recipe, assembled.inputs, gathered) ||
      (yield* recipeLabelled(request.orgId, recipe)),
    docOrigin:
      entry === undefined
        ? `recipe:${recipe.name}:${inputsHash}`
        : `recipe:${recipe.name}:${entry.recordId}`,
    logo: gathered.logo,
    tax: gathered.tax,
  } satisfies Plan;
});

export const makeDocument = Effect.fn("KinDocMaker.make")(function* (request: MakeRequest) {
  const sql = yield* SqlClient.SqlClient;
  const workspace = yield* KinWorkspace;
  const renderer = yield* KinDocRenderer;
  const jobId = KinWorkerId.make(`rd-${sha256(`${request.orgId}:${request.jobKey}`).slice(0, 32)}`);
  const fingerprint = sha256(
    canonical({
      recipe: request.recipe,
      entry: request.entry ?? null,
      given: request.given,
      // Only when set, so a request made before docs could be named keeps its fingerprint.
      ...(request.doc === undefined ? {} : { doc: request.doc }),
      title: request.title,
      preview: request.preview === true,
    }),
  );
  // A preview files nothing, so it neither takes a request id nor finds what one made.
  const [done] =
    request.preview === true
      ? []
      : yield* sql<{
          outcomeJson: string | null;
          recipe: string;
          number: string | null;
          sensitive: number;
          request: string | null;
        }>`
    SELECT outcome_json AS "outcomeJson", recipe, number, sensitive, request_sha256 AS request
    FROM kin_doc_jobs WHERE org_id = ${request.orgId} AND worker_id = ${jobId} ORDER BY worker_id`;
  if (done?.request != null && done.request !== fingerprint)
    return yield* new KinChatError({
      reason: "not_allowed",
      message: `${NOTHING} This request id was already used to ask for a different document; ask with a new one.`,
    });
  const stored = done?.outcomeJson == null ? undefined : decodeStored(done.outcomeJson);
  if (done !== undefined && stored?._tag === "Some")
    return {
      jobId,
      recipe: done.recipe,
      number: done.number,
      draft: stored.value.draft,
      sensitive: done.sensitive === 1,
      documents: stored.value.documents,
      files: [],
      written: [],
    } satisfies Made;

  const recipes = yield* workspace.recipes(request.orgId);
  const recipe = recipes.find((one) => one.name === request.recipe);
  if (recipe === undefined)
    return yield* new KinChatError({
      reason: "not_found",
      message: `There is no recipe ${request.recipe}. Recipes here: ${recipes.map((one) => one.name).join(", ") || "none"}. ${NOTHING}`,
    });
  const first = yield* plan(request, recipe);
  const now = yield* Clock.currentTimeMillis;
  const day = dayIn(now, yield* ownerZone(request.orgId));
  const rendered = yield* renderer.render({
    orgId: request.orgId,
    recipe,
    commit: recipe.commit,
    inputs: first.inputs,
    day,
    logo: first.logo,
    tax: first.tax,
  });
  if (rendered._tag === "failed")
    return yield* invalid(`${NOTHING} The ${recipe.name} recipe didn't render: ${rendered.reason}`);
  if (request.preview === true) {
    yield* request.admit;
    return {
      jobId,
      recipe: recipe.name,
      number: first.number,
      draft: first.draft,
      sensitive: first.sensitive,
      documents: [],
      files: rendered.files,
      written: [],
    } satisfies Made;
  }
  const attachments = new Map<string, string>();
  for (const file of rendered.files)
    attachments.set(file.name, yield* renderer.store(request.orgId, jobId, file));

  const requester = request.requester;
  const agentId = requester._tag === "agent" ? requester.agentId : null;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* request.admit;
      // The figures and labels again, as they are now: what was rendered must still be them.
      const final = yield* plan(request, recipe);
      if (final.inputsHash !== first.inputsHash)
        return yield* invalid(`${NOTHING} The figures changed while Kin was rendering; ask again.`);
      const sensitive = final.sensitive || first.sensitive;
      const figures = issuedFigures(recipe, final);
      if (isChatError(figures)) return yield* figures;
      const inserted = yield* sql`INSERT INTO kin_doc_jobs (org_id, worker_id, agent_id, wakeup_id,
          mode, recipe, recipe_commit, entry_record_id, inputs_sha256, number, sensitive,
          doc_origin, worktree_path, branch, chat_id, audience, answered_message_id,
          answered_author_kind, answered_author_id, created_at, removed_at, given_json, title,
          asked_by_person_id, request_sha256)
        VALUES (${request.orgId}, ${jobId}, ${agentId ?? ""},
          ${requester._tag === "agent" ? requester.wakeupId : ""}, 'document', ${recipe.name},
          ${recipe.commit}, ${final.entry?.recordId ?? null}, ${final.inputsHash}, ${final.number},
          ${sensitive ? 1 : 0}, ${final.docOrigin}, '', '',
          ${requester._tag === "agent" ? requester.chatId : null}, 'owner_only',
          ${requester._tag === "agent" ? (requester.answered?.messageId ?? null) : null},
          ${requester._tag === "agent" && requester.answered !== null ? "person" : null},
          ${requester._tag === "agent" ? (requester.answered?.personId ?? null) : null},
          ${now}, ${now}, ${canonical(request.given)}, ${request.title},
          ${requester._tag === "owner" ? requester.personId : null}, ${fingerprint})
        ON CONFLICT (org_id, worker_id) DO NOTHING RETURNING worker_id`;
      if (inserted.length === 0)
        return yield* invalid(`${NOTHING} This request is already being made; ask again.`);
      if (figures !== undefined)
        yield* sql`INSERT INTO kin_doc_job_figures (org_id, worker_id, entry_record_id, number,
            total_minor, tax_minor, currency, taxes_json, rendered_at)
          VALUES (${request.orgId}, ${jobId}, ${final.entry!.recordId}, ${final.number},
            ${figures.total.minor}, ${figures.tax.minor}, ${figures.total.currency},
            ${canonical(figures.taxes)}, ${now})`;
      const owner: KinWorkPrincipal =
        requester._tag === "agent"
          ? { _tag: "agent", agentId: requester.agentId }
          : { _tag: "person", personId: requester.personId };
      const documents: Array<MadeDocument> = [];
      const written: Array<Docs.Written> = [];
      const named = numberedTitle(request.title, final.entry?.key, final.number);
      for (const file of rendered.files) {
        const title = rendered.files.length === 1 ? named : `${named} · ${file.name}`;
        const filed = yield* Docs.fileVersion(
          request.orgId,
          requester.writer,
          {
            ...(requester._tag === "agent" && requester.answered !== null
              ? {
                  answered: {
                    messageId: requester.answered.messageId,
                    author: { _tag: "person", personId: requester.answered.personId },
                  },
                }
              : {}),
            audience: "owner_only",
          },
          {
            docOrigin: `${final.docOrigin}:${file.name}`,
            originKey: `kin-doc-job:${jobId}:${file.name}`,
            title: title.slice(0, 200),
            summary: `Made with the ${recipe.name} recipe${final.number === null ? "" : `, ${final.number}`}${final.draft ? ", draft" : ""}`,
            owner,
            sensitive,
            ...(final.entry?.partyId == null ? {} : { partyId: final.entry.partyId }),
            file: {
              attachmentId: attachments.get(file.name)!,
              name: file.name,
              mimeType: file.mimeType,
              bytes: file.bytes.length,
              sha256: file.sha256,
              pages: file.pages,
              recipe: { name: recipe.name, commit: recipe.commit },
              inputsHash: final.inputsHash,
              workerId: jobId,
              number: final.number,
              draft: final.draft,
            },
          },
        );
        if (final.entry !== undefined)
          yield* Docs.link(
            request.orgId,
            requester.writer,
            { key: filed.row.key },
            [final.entry.key],
            "relates",
          );
        written.push(filed);
        documents.push({
          recordId: filed.row.recordId,
          key: filed.row.key,
          title: filed.row.title,
          version: filed.version.version,
        });
      }
      yield* sql`UPDATE kin_doc_jobs SET collected_at = ${now},
          outcome_json = ${yield* encodeStored({ draft: final.draft, documents })}
        WHERE org_id = ${request.orgId} AND worker_id = ${jobId}`;
      if (final.entry !== undefined && issuable(recipe))
        yield* priceDraft(request.orgId, requester.writer, final.entry.key, final.priced);
      return {
        jobId,
        recipe: recipe.name,
        number: final.number,
        draft: final.draft,
        sensitive,
        documents,
        files: [],
        written,
      } satisfies Made;
    }),
  );
});

/**
 * After an entry is issued: each document made for it from a recipe that doesn't carry its number
 * yet is made again, in place, with what was asked for it last time, so the doc gets a new version
 * that does. Asking again after one failed makes only that one again.
 */
export const remakeForEntry = Effect.fn("KinDocMaker.remake")(function* (input: {
  readonly orgId: KinOrgId;
  readonly entryKey: string;
  readonly requester: Requester;
  readonly admit: Effect.Effect<void, KinChatError, SqlClient.SqlClient>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  const entry = yield* records.get(input.orgId, input.entryKey);
  if (entry === undefined) return { documents: [], written: [], problems: [] };
  const number = (yield* issuedNumber(input.orgId, entry.recordId)) ?? "none";
  const by = input.requester._tag === "agent" ? input.requester.wakeupId : input.requester.personId;
  // The latest render per doc: what it was made with is what it is made with again.
  const rows = yield* sql<{
    recipe: string;
    givenJson: string;
    title: string;
    docOrigin: string;
  }>`SELECT recipe, given_json AS "givenJson", title, doc_origin AS "docOrigin" FROM (
      SELECT recipe, given_json, title, doc_origin, ROW_NUMBER() OVER (
        PARTITION BY doc_origin ORDER BY created_at DESC, worker_id DESC) AS latest
      FROM kin_doc_jobs
      WHERE org_id = ${input.orgId} AND entry_record_id = ${entry.recordId}
        AND given_json IS NOT NULL AND recipe IS NOT NULL AND outcome_json IS NOT NULL) made
    WHERE latest = 1 AND NOT EXISTS (SELECT 1 FROM kin_doc_jobs done
      WHERE done.org_id = ${input.orgId} AND done.doc_origin = made.doc_origin
        AND done.number = ${number} AND done.outcome_json IS NOT NULL)
    ORDER BY doc_origin LIMIT 20`;
  const documents: Array<MadeDocument> = [];
  const written: Array<Docs.Written> = [];
  const problems: Array<string> = [];
  for (const row of rows) {
    const given = decodeGiven(row.givenJson);
    const made = yield* makeDocument({
      orgId: input.orgId,
      recipe: row.recipe,
      entry: entry.key,
      given: given._tag === "Some" ? given.value : {},
      title: row.title,
      requester: input.requester,
      jobKey: `remake:${row.docOrigin}:${number}:${by}`,
      admit: input.admit,
    }).pipe(
      Effect.catchIf(isChatError, (error) =>
        Effect.sync(() => problems.push(error.message)).pipe(Effect.as(undefined)),
      ),
    );
    if (made !== undefined) {
      documents.push(...made.documents);
      written.push(...made.written);
    }
  }
  return { documents, written, problems };
});
