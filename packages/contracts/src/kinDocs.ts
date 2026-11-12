import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  KinChatError,
  KinChatId,
  KinDocSectionId,
  KinMessageId,
  KinOrgId,
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

/** Only markdown now; generated files (PDFs, sheets) become a second kind later. */
export const KinDocBodyKind = Schema.Literals(["markdown"]);
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
export const KinDocDetail = Schema.Struct({
  ...KinDocRow.fields,
  /** The version shown: the latest unless one was asked for. */
  version: KinDocVersion,
  body: KinText,
  outline: Schema.Array(KinDocSection),
  links: Schema.Array(KinRecordLink),
  /** This doc's latest change number: compare with a `changed` event's. */
  seq: NonNegativeInt,
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
} as const;
