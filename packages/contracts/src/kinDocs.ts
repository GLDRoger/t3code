import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinChartCardState } from "./kinChart.ts";
import { KinWorkerId } from "./kinLead.ts";
import {
  KinAgentId,
  KinChatError,
  KinChatId,
  KinDocSectionId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinText,
  KinTrimmedText,
} from "./kinChat.ts";
import {
  KinRecordChangeVia,
  KinRecordId,
  KinRecordKey,
  KinRecordLink,
  KinRecordRef,
  KinWorkActor,
  KinWorkPrincipal,
} from "./kinWork.ts";

/**
 * Docs: entries in the built-in Docs list whose point is a versioned body. Agents write and edit
 * them; people read, compare and restore. Every version is kept whole. Owner only for now.
 */

/** One heading and the text under it, up to the next heading of any level. */
export const KinDocSection = Schema.Struct({
  id: KinDocSectionId,
  /** The heading's text; empty for `top`, the text before the first heading. */
  title: KinText,
  /** 1 to 6 for a heading, 0 for `top`. */
  level: NonNegativeInt,
  chars: NonNegativeInt,
  /** Of the section's exact text: an agent's edit names the hash it read. */
  hash: TrimmedNonEmptyString,
});
export type KinDocSection = typeof KinDocSection.Type;

/** Markdown written by agents, or a file a worker made from a recipe (a PDF, sheet, deck, image). */
export const KinDocBodyKind = Schema.Literals(["markdown", "file"]);
export type KinDocBodyKind = typeof KinDocBodyKind.Type;

export const KinDocVersionKind = Schema.Literals(["created", "edited", "rewritten", "restored"]);
export type KinDocVersionKind = typeof KinDocVersionKind.Type;

/** What an edit did, by operation; the text itself is in the version. */
export const KinDocOperation = Schema.Struct({
  op: Schema.Literals([
    "create",
    "replace_section",
    "insert_after",
    "append",
    "replace_phrase",
    "retitle",
    "rewrite",
    "restore",
  ]),
  section: Schema.optional(KinDocSectionId),
});
export type KinDocOperation = typeof KinDocOperation.Type;

/**
 * Who made a version and in answer to what, set by the server from stored rows, never from what
 * an agent wrote: the agent's turn, its chat, the message it answered and who wrote that, and
 * whether only the owner could read the turn.
 */
export const KinDocProvenance = Schema.Struct({
  by: KinWorkActor,
  via: KinRecordChangeVia,
  /** The agent's turn. */
  wakeupId: Schema.NullOr(TrimmedNonEmptyString),
  chatId: Schema.NullOr(KinChatId),
  answered: Schema.NullOr(Schema.Struct({ messageId: KinMessageId, author: KinWorkPrincipal })),
  audience: Schema.NullOr(Schema.Literals(["owner_only", "shared"])),
});
export type KinDocProvenance = typeof KinDocProvenance.Type;

/**
 * A generated file, as Kin took it back from the worker: open it through the asset route with
 * `attachmentId`, `name` and `mimeType`. Everything here is set by the server from the job's
 * stored row and the file's own bytes, never from what the worker reported.
 */
export const KinDocFile = Schema.Struct({
  attachmentId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  mimeType: TrimmedNonEmptyString,
  bytes: NonNegativeInt,
  sha256: TrimmedNonEmptyString,
  /** A PDF's page count when it could be read cheaply. */
  pages: Schema.NullOr(PositiveInt),
  /** The recipe and the workspace commit it ran at; `null` for a one-off file. */
  recipe: Schema.NullOr(
    Schema.Struct({ name: TrimmedNonEmptyString, commit: TrimmedNonEmptyString }),
  ),
  /** Of the exact inputs the server gave the worker. */
  inputsHash: TrimmedNonEmptyString,
  workerId: KinWorkerId,
  /** The issued number it carries; `null` with `draft` for a draft. */
  number: Schema.NullOr(TrimmedNonEmptyString),
  draft: Schema.Boolean,
});
export type KinDocFile = typeof KinDocFile.Type;

/** One line of a doc's history: "Updated 14:02 by Growth lead · Moved the launch to 14 Dec". */
export const KinDocVersion = Schema.Struct({
  version: PositiveInt,
  at: IsoDateTime,
  kind: KinDocVersionKind,
  title: KinTrimmedText,
  summary: KinText,
  /** The version this one was made from; `null` for the first. */
  baseVersion: Schema.NullOr(PositiveInt),
  /** For a restore, the version brought back. */
  restoredFrom: Schema.NullOr(PositiveInt),
  operations: Schema.Array(KinDocOperation),
  chars: NonNegativeInt,
  provenance: KinDocProvenance,
  /** The version's file, for a `file` doc. */
  file: Schema.optional(KinDocFile),
});
export type KinDocVersion = typeof KinDocVersion.Type;

/** One row of the Docs screen. Group by `party`, `project` or `owner` on the client. */
export const KinDocRow = Schema.Struct({
  recordId: KinRecordId,
  key: KinRecordKey,
  title: KinTrimmedText,
  /** The agent or person who keeps it current. */
  owner: KinWorkPrincipal,
  party: Schema.optional(KinRecordRef),
  project: Schema.optional(KinRecordRef),
  sensitive: Schema.Boolean,
  /** True when its client or project is labelled sensitive, whatever its own label says. */
  sensitiveInherited: Schema.optional(Schema.Literal(true)),
  archived: Schema.Boolean,
  bodyKind: KinDocBodyKind,
  /** The latest version, with its "what changed" line. */
  latest: KinDocVersion,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  rev: NonNegativeInt,
});
export type KinDocRow = typeof KinDocRow.Type;

/** A doc at one version, for the reader and its contents sheet. */
/**
 * What one `kin_chart` or `kin_visual` block of a doc's body draws, in the order the blocks
 * appear. `broken` says why a block can't be drawn, so the rest still line up.
 */
export const KinDocEmbed = Schema.Union([
  Schema.TaggedStruct("chart", { chart: KinChartCardState }),
  Schema.TaggedStruct("visual", {
    title: KinTrimmedText,
    attachmentId: TrimmedNonEmptyString,
    height: PositiveInt,
  }),
  Schema.TaggedStruct("broken", { message: KinTrimmedText }),
]);
export type KinDocEmbed = typeof KinDocEmbed.Type;

export const KinDocDetail = Schema.Struct({
  ...KinDocRow.fields,
  /** The version shown: the latest unless one was asked for. */
  version: KinDocVersion,
  body: KinText,
  outline: Schema.Array(KinDocSection),
  links: Schema.Array(KinRecordLink),
  /** This doc's latest change number: compare with a `changed` event's. */
  seq: NonNegativeInt,
  /** Absent from servers that draw no blocks. */
  embeds: Schema.optional(Schema.Array(KinDocEmbed)),
});
export type KinDocDetail = typeof KinDocDetail.Type;

const PageCursor = Schema.String.check(Schema.isMaxLength(200));
const PageLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(100),
);

/** Most recently changed first. Archived docs only with `archived: true`. */
export const KinDocsListInput = Schema.Struct({
  orgId: KinOrgId,
  owner: Schema.optional(KinWorkPrincipal),
  /** A client's or vendor's key. */
  party: Schema.optional(KinRecordKey),
  project: Schema.optional(KinRecordKey),
  archived: Schema.optional(Schema.Boolean),
  /** Case-insensitive match on the title and the latest version's text. */
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  cursor: Schema.optional(PageCursor),
  limit: Schema.optional(PageLimit),
});
export type KinDocsListInput = typeof KinDocsListInput.Type;
export const KinDocsListResult = Schema.Struct({
  docs: Schema.Array(KinDocRow),
  total: NonNegativeInt,
  nextCursor: Schema.NullOr(Schema.String),
  seq: NonNegativeInt,
  asOf: IsoDateTime,
});
export type KinDocsListResult = typeof KinDocsListResult.Type;

export const KinDocGetInput = Schema.Union([
  Schema.Struct({ orgId: KinOrgId, key: KinRecordKey, version: Schema.optional(PositiveInt) }),
  Schema.Struct({
    orgId: KinOrgId,
    recordId: KinRecordId,
    version: Schema.optional(PositiveInt),
  }),
]);
export type KinDocGetInput = typeof KinDocGetInput.Type;

export const KinDocHistoryInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  cursor: Schema.optional(PageCursor),
  limit: Schema.optional(PageLimit),
});
export type KinDocHistoryInput = typeof KinDocHistoryInput.Type;
/** Newest first. */
export const KinDocHistory = Schema.Struct({
  versions: Schema.Array(KinDocVersion),
  nextCursor: Schema.NullOr(Schema.String),
  seq: NonNegativeInt,
});
export type KinDocHistory = typeof KinDocHistory.Type;

/** `from` defaults to the version before `to`; `to` to the latest. */
export const KinDocDiffInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  from: Schema.optional(PositiveInt),
  to: Schema.optional(PositiveInt),
});
export type KinDocDiffInput = typeof KinDocDiffInput.Type;
/**
 * `patch` is a unified git patch of one file (`diff --git a/<key>.md b/<key>.md`, `---`/`+++`
 * and `@@` hunks), the format T3's diff viewers parse; empty when nothing differs.
 */
export const KinDocDiff = Schema.Struct({
  key: KinRecordKey,
  from: KinDocVersion,
  to: KinDocVersion,
  patch: KinText,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  /** Ids in `to`'s outline whose text differs from `from`, or that are new. */
  changedSections: Schema.Array(KinDocSectionId),
  /** Ids in `from` that `to` no longer has. */
  removedSections: Schema.Array(KinDocSectionId),
});
export type KinDocDiff = typeof KinDocDiff.Type;

/** Brings back a version as a new one, so history is never rewritten and a restore is undoable. */
export const KinDocRestoreInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  version: PositiveInt,
  /** The latest version the owner saw; a newer one is refused as a conflict. */
  latest: PositiveInt,
});
export type KinDocRestoreInput = typeof KinDocRestoreInput.Type;

/** One input a recipe asks for, as its RECIPE.md declares it. */
export const KinRecipeInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  type: TrimmedNonEmptyString,
  required: Schema.Boolean,
  /** `agent` when the agent gives it; otherwise where Kin reads the exact value. */
  from: TrimmedNonEmptyString,
  description: Schema.optional(KinText),
});
export type KinRecipeInput = typeof KinRecipeInput.Type;
/** A recipe in the company's workspace, read from its default branch. */
export const KinRecipe = Schema.Struct({
  name: TrimmedNonEmptyString,
  title: KinTrimmedText,
  description: KinText,
  inputs: Schema.Array(KinRecipeInput),
  outputs: Schema.Array(TrimmedNonEmptyString),
  /** The list whose entry it is made for, such as `invoices`. */
  list: Schema.NullOr(TrimmedNonEmptyString),
  numbered: Schema.Boolean,
  sensitive: Schema.Boolean,
  /** Written in a turn that read something sensitive: its documents are labelled until cleared. */
  labelled: Schema.optional(Schema.Literal(true)),
  changedAt: Schema.NullOr(IsoDateTime),
  /** Kin's starter, the agent whose worker changed it last, or the owner who undid a change. */
  changedBy: Schema.Union([
    Schema.TaggedStruct("starter", {}),
    Schema.TaggedStruct("agent", { agentId: KinAgentId, workerId: Schema.NullOr(KinWorkerId) }),
    Schema.TaggedStruct("owner", { personId: KinPersonId }),
  ]),
  commit: TrimmedNonEmptyString,
});
export type KinRecipe = typeof KinRecipe.Type;
export const KinRecipesInput = Schema.Struct({ orgId: KinOrgId });
export type KinRecipesInput = typeof KinRecipesInput.Type;
export const KinRecipesResult = Schema.Struct({ recipes: Schema.Array(KinRecipe) });
export type KinRecipesResult = typeof KinRecipesResult.Type;

/**
 * The owner makes a recipe's document from a client, with no agent turn: "Make invoice" on an
 * entry, "Export month" on Money. Kin gathers the inputs and renders it in the call. `preview`
 * renders without filing and returns the file itself, at most 5 MB.
 */
export const KinDocRenderInput = Schema.Struct({
  orgId: KinOrgId,
  recipe: TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,39}$/)),
  /** The entry it is for, when the recipe reads one. */
  entry: Schema.optional(KinRecordKey),
  /** Only the recipe's inputs that aren't read from stored rows, such as `month`. */
  inputs: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  title: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(120))),
  preview: Schema.optional(Schema.Boolean),
  /** The same id again returns what that request made. */
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
});
export type KinDocRenderInput = typeof KinDocRenderInput.Type;
export const KinDocRenderResult = Schema.Struct({
  /** Each file filed as a version of its doc; empty for a preview. */
  documents: Schema.Array(
    Schema.Struct({
      recordId: KinRecordId,
      key: KinRecordKey,
      title: KinTrimmedText,
      version: PositiveInt,
    }),
  ),
  number: Schema.NullOr(TrimmedNonEmptyString),
  draft: Schema.Boolean,
  sensitive: Schema.Boolean,
  preview: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        name: TrimmedNonEmptyString,
        mimeType: TrimmedNonEmptyString,
        base64: Schema.String,
      }),
    ),
  ),
});
export type KinDocRenderResult = typeof KinDocRenderResult.Type;

/** Puts a recipe back as it was before its last change, as a new change: undo it to redo. */
export const KinRecipeUndoInput = Schema.Struct({
  orgId: KinOrgId,
  recipe: TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,39}$/)),
});
export type KinRecipeUndoInput = typeof KinRecipeUndoInput.Type;
export const KinRecipeUndoResult = Schema.Struct({
  recipe: TrimmedNonEmptyString,
  commit: TrimmedNonEmptyString,
  /** True when the change undone made the recipe, so it is gone until undone again. */
  removed: Schema.Boolean,
});
export type KinRecipeUndoResult = typeof KinRecipeUndoResult.Type;

/** The owner's label on a doc; only a person lowers one, so this is how a doc stops being sensitive. */
export const KinDocLabelInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  sensitive: Schema.Boolean,
});
export type KinDocLabelInput = typeof KinDocLabelInput.Type;

/** Clears the label a recipe got from being written after a sensitive read, as the owner saw it. */
export const KinRecipeClearLabelInput = Schema.Struct({
  ...KinRecipeUndoInput.fields,
  commit: TrimmedNonEmptyString,
});
export type KinRecipeClearLabelInput = typeof KinRecipeClearLabelInput.Type;
export const KinRecipeClearLabelResult = Schema.Struct({
  recipe: TrimmedNonEmptyString,
  commit: TrimmedNonEmptyString,
});
export type KinRecipeClearLabelResult = typeof KinRecipeClearLabelResult.Type;

export const KinDocsSubscribeInput = Schema.Struct({ orgId: KinOrgId });
export type KinDocsSubscribeInput = typeof KinDocsSubscribeInput.Type;
/** The latest change number now, then again after each change to a doc. A client refetches. */
export const KinDocsEvent = Schema.Union([
  Schema.TaggedStruct("changed", {
    seq: NonNegativeInt,
    key: Schema.optional(KinRecordKey),
  }),
]);
export type KinDocsEvent = typeof KinDocsEvent.Type;

/** What one search box looks through: Work and the light CRM's entries, and docs. */
export const KinSearchKind = Schema.Literals(["work", "clients", "contacts", "projects", "docs"]);
export type KinSearchKind = typeof KinSearchKind.Type;
export const KinSearchInput = Schema.Struct({
  orgId: KinOrgId,
  text: KinTrimmedText.check(Schema.isMaxLength(200)),
  kinds: Schema.optional(Schema.Array(KinSearchKind).check(Schema.isMaxLength(5))),
  /** Closed entries and archived docs too. */
  closed: Schema.optional(Schema.Boolean),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(50)),
  ),
});
export type KinSearchInput = typeof KinSearchInput.Type;
export const KinSearchHit = Schema.Struct({
  recordId: KinRecordId,
  key: KinRecordKey,
  kind: KinSearchKind,
  title: KinTrimmedText,
  /** A few plain words around the match; never markup. */
  snippet: KinText,
  /** For a doc, the section the match is in, to open it there. */
  section: Schema.optional(Schema.Struct({ id: KinDocSectionId, title: KinText })),
  sensitive: Schema.Boolean,
  closed: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type KinSearchHit = typeof KinSearchHit.Type;
/** Best match first. `indexed` is false when this host's SQLite has no FTS5 and search scans. */
export const KinSearchResult = Schema.Struct({
  hits: Schema.Array(KinSearchHit),
  indexed: Schema.Boolean,
  asOf: IsoDateTime,
});
export type KinSearchResult = typeof KinSearchResult.Type;

export const KIN_DOC_CARD = "doc";
/** The chat card an agent shows a doc with. Filled by the server from stored rows. */
export const KinDocCardState = Schema.Struct({
  recordId: KinRecordId,
  key: KinRecordKey,
  title: KinTrimmedText,
  version: PositiveInt,
  /** The what-changed line: when, by whom and its summary. */
  change: Schema.Struct({
    at: IsoDateTime,
    by: KinWorkActor,
    kind: KinDocVersionKind,
    summary: KinText,
  }),
  /** The version before, to open "See changes"; `null` for a new doc. */
  previousVersion: Schema.NullOr(PositiveInt),
});
export type KinDocCardState = typeof KinDocCardState.Type;

const KIN_DOCS_WS_METHODS = {
  list: "kin.docs.list",
  get: "kin.docs.get",
  history: "kin.docs.history",
  diff: "kin.docs.diff",
  restore: "kin.docs.restore",
  subscribe: "kin.docs.subscribe",
  search: "kin.search",
  recipes: "kin.docs.recipes",
  render: "kin.docs.render",
  undoRecipe: "kin.docs.undoRecipe",
  label: "kin.docs.label",
  clearRecipeLabel: "kin.docs.clearRecipeLabel",
} as const;

const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
// Owner only, on the server; a chat-only session is refused before any handler runs.
export const KinDocsRpcs = [
  Rpc.make(KIN_DOCS_WS_METHODS.list, {
    payload: KinDocsListInput,
    success: KinDocsListResult,
    error,
  }),
  Rpc.make(KIN_DOCS_WS_METHODS.get, { payload: KinDocGetInput, success: KinDocDetail, error }),
  Rpc.make(KIN_DOCS_WS_METHODS.history, {
    payload: KinDocHistoryInput,
    success: KinDocHistory,
    error,
  }),
  Rpc.make(KIN_DOCS_WS_METHODS.diff, { payload: KinDocDiffInput, success: KinDocDiff, error }),
  Rpc.make(KIN_DOCS_WS_METHODS.restore, {
    payload: KinDocRestoreInput,
    success: KinDocDetail,
    error,
  }),
  Rpc.make(KIN_DOCS_WS_METHODS.subscribe, {
    payload: KinDocsSubscribeInput,
    success: KinDocsEvent,
    error,
    stream: true,
  }),
  Rpc.make(KIN_DOCS_WS_METHODS.search, {
    payload: KinSearchInput,
    success: KinSearchResult,
    error,
  }),
  Rpc.make(KIN_DOCS_WS_METHODS.recipes, {
    payload: KinRecipesInput,
    success: KinRecipesResult,
    error,
  }),
  Rpc.make(KIN_DOCS_WS_METHODS.render, {
    payload: KinDocRenderInput,
    success: KinDocRenderResult,
    error,
  }),
  Rpc.make(KIN_DOCS_WS_METHODS.undoRecipe, {
    payload: KinRecipeUndoInput,
    success: KinRecipeUndoResult,
    error,
  }),
  Rpc.make(KIN_DOCS_WS_METHODS.label, { payload: KinDocLabelInput, success: KinDocDetail, error }),
  Rpc.make(KIN_DOCS_WS_METHODS.clearRecipeLabel, {
    payload: KinRecipeClearLabelInput,
    success: KinRecipeClearLabelResult,
    error,
  }),
] as const;

export const KIN_DOCS_RPC_SCOPES = {
  [KIN_DOCS_WS_METHODS.list]: AuthOrchestrationReadScope,
  [KIN_DOCS_WS_METHODS.get]: AuthOrchestrationReadScope,
  [KIN_DOCS_WS_METHODS.history]: AuthOrchestrationReadScope,
  [KIN_DOCS_WS_METHODS.diff]: AuthOrchestrationReadScope,
  // Writes a version, as the entry edits beside it do; it starts no agent work.
  [KIN_DOCS_WS_METHODS.restore]: AuthOrchestrationOperateScope,
  [KIN_DOCS_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
  [KIN_DOCS_WS_METHODS.search]: AuthOrchestrationReadScope,
  [KIN_DOCS_WS_METHODS.recipes]: AuthOrchestrationReadScope,
  // Files a version, as restore does; it starts no agent work.
  [KIN_DOCS_WS_METHODS.render]: AuthOrchestrationOperateScope,
  [KIN_DOCS_WS_METHODS.undoRecipe]: AuthOrchestrationOperateScope,
  // Lowers what an agent may show others: the owner's call, as the entry labels beside it are.
  [KIN_DOCS_WS_METHODS.label]: AuthOrchestrationOperateScope,
  [KIN_DOCS_WS_METHODS.clearRecipeLabel]: AuthOrchestrationOperateScope,
} as const;
