import {
  KinChatError,
  type KinDocDetail,
  type KinDocDiffInput,
  type KinDocGetInput,
  type KinDocHistoryInput,
  type KinDocRestoreInput,
  type KinDocRenderInput,
  type KinDocRenderResult,
  type KinDocsListInput,
  type KinOrgId,
  type KinRecipesInput,
  type KinRecipesResult,
  type KinRecipeUndoInput,
  type KinRecipeUndoResult,
  KinRecordId,
  KinRecordKey,
  type KinSearchInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { makeDocument } from "../gendocs/make.ts";
import { KinWorkspace } from "../gendocs/workspace.ts";
import { changedSections, outlineOf, patchOf } from "./docBody.ts";
import { docEmbeds } from "./docFiles.ts";
import * as Docs from "./docs.ts";
import { KinRecords } from "./KinRecords.ts";
import { LISTS } from "./lists.ts";
import { inList, ownerWriter, theOwner } from "./ownerWork.ts";
import {
  iso,
  principalId,
  recordSeq,
  selectRecords,
  unavailable,
  workFailure,
} from "./recordRows.ts";
import { search as runSearch } from "./search.ts";

/**
 * What the owner's clients read and do in Docs: read, compare, restore and search. Owner only,
 * like Work: anyone else is refused here as well as by the RPC scopes. People never write a body.
 */

const badCursor = new KinChatError({
  reason: "invalid_state",
  message: "That page cursor is stale.",
});
const offsetOf = (cursor: string | undefined) => {
  if (cursor === undefined) return Effect.succeed(0);
  const found = /^o:(\d{1,9})$/.exec(cursor);
  return found === null ? Effect.fail(badCursor) : Effect.succeed(Number.parseInt(found[1]!, 10));
};

const detailOf = Effect.fn("KinDocs.detail")(function* (
  orgId: KinOrgId,
  ref: { readonly key: string } | { readonly recordId: string },
  version?: number,
) {
  const records = yield* KinRecords;
  const row = yield* Docs.docRow(orgId, ref);
  const latest = yield* Docs.versionOf(orgId, row.recordId);
  const shown = yield* Docs.versionOf(orgId, row.recordId, version);
  if (latest === undefined) return yield* unavailable;
  if (shown === undefined)
    return yield* new KinChatError({
      reason: "not_found",
      message: `${row.key} has no version ${version}; it is at ${latest.version}.`,
    });
  const now = yield* Clock.currentTimeMillis;
  const detail = yield* records.detail(row, 0);
  return {
    ...Docs.toDocRow(row, latest, now),
    version: Docs.toVersion(shown),
    body: shown.body,
    outline: [...outlineOf(shown.body)],
    links: detail.links,
    seq: yield* recordSeq(orgId, row.recordId),
    embeds: yield* docEmbeds(orgId, row.recordId, shown.body),
  } satisfies KinDocDetail;
});

export const list = Effect.fn("KinDocs.list")(
  function* (people: ReadonlyArray<PersonIdentity>, input: KinDocsListInput) {
    yield* theOwner(people, input.orgId);
    const sql = yield* SqlClient.SqlClient;
    const records = yield* KinRecords;
    const offset = yield* offsetOf(input.cursor);
    const partyId =
      input.party === undefined
        ? undefined
        : (yield* inList(input.orgId, input.party, "clients")).recordId;
    const projectId =
      input.project === undefined
        ? undefined
        : (yield* inList(input.orgId, input.project, "projects")).recordId;
    const text = input.text?.trim().toLowerCase() ?? "";
    const where = sql.and([
      sql`r.org_id = ${input.orgId}`,
      sql`r.register_id = 'docs'`,
      input.archived === true ? sql`r.state = 'dropped'` : sql`r.state != 'dropped'`,
      ...(partyId === undefined ? [] : [sql`r.party_id = ${partyId}`]),
      ...(projectId === undefined ? [] : [sql`r.project_id = ${projectId}`]),
      ...(input.owner === undefined
        ? []
        : [sql`r.owner_kind = ${input.owner._tag} AND r.owner_id = ${principalId(input.owner)}`]),
      ...(text === ""
        ? []
        : [
            sql`(instr(lower(r.title), ${text}) > 0 OR EXISTS (SELECT 1 FROM kin_doc_versions v
              WHERE v.org_id = r.org_id AND v.record_id = r.record_id
                AND v.version = (SELECT MAX(w.version) FROM kin_doc_versions w
                  WHERE w.org_id = r.org_id AND w.record_id = r.record_id)
                AND instr(lower(v.body), ${text}) > 0))`,
          ]),
    ]);
    const limit = input.limit ?? 50;
    const [count] = yield* sql<{
      total: number;
    }>`SELECT COUNT(*) AS total FROM kin_records r WHERE ${where}`;
    const rows = yield* sql<
      Parameters<typeof Docs.toDocRow>[0]
    >`${selectRecords(sql)} WHERE ${where}
    ORDER BY r.updated_at DESC, r.key LIMIT ${limit} OFFSET ${offset}`;
    const latest = yield* Docs.latestOf(
      input.orgId,
      rows.map((row) => row.recordId),
    );
    const now = yield* Clock.currentTimeMillis;
    const next = offset + rows.length;
    return {
      docs: rows.flatMap((row) => {
        const version = latest.get(row.recordId);
        return version === undefined ? [] : [Docs.toDocRow(row, version, now)];
      }),
      total: count?.total ?? 0,
      nextCursor: next < (count?.total ?? 0) ? `o:${next}` : null,
      seq: yield* records.seq(input.orgId),
      asOf: iso(now),
    };
  },
  Effect.catchTags({ SqlError: () => unavailable }),
);

export const get = Effect.fn("KinDocs.get")(
  function* (people: ReadonlyArray<PersonIdentity>, input: KinDocGetInput) {
    yield* theOwner(people, input.orgId);
    return yield* detailOf(
      input.orgId,
      "key" in input ? { key: input.key } : { recordId: input.recordId },
      input.version,
    );
  },
  Effect.catchTags({ SqlError: () => unavailable }),
);

export const history = Effect.fn("KinDocs.history")(
  function* (people: ReadonlyArray<PersonIdentity>, input: KinDocHistoryInput) {
    yield* theOwner(people, input.orgId);
    const before = input.cursor === undefined ? undefined : /^v:(\d{1,9})$/.exec(input.cursor)?.[1];
    if (input.cursor !== undefined && before === undefined) return yield* badCursor;
    const row = yield* Docs.docRow(input.orgId, { key: input.key });
    const limit = input.limit ?? 50;
    const rows = yield* Docs.history(input.orgId, row.recordId, {
      ...(before === undefined ? {} : { before: Number.parseInt(before, 10) }),
      limit,
    });
    const last = rows.at(-1);
    return {
      versions: rows.map(Docs.toVersion),
      nextCursor:
        rows.length === limit && last !== undefined && last.version > 1
          ? `v:${last.version}`
          : null,
      seq: yield* recordSeq(input.orgId, row.recordId),
    };
  },
  Effect.catchTags({ SqlError: () => unavailable }),
);

export const diff = Effect.fn("KinDocs.diff")(
  function* (people: ReadonlyArray<PersonIdentity>, input: KinDocDiffInput) {
    yield* theOwner(people, input.orgId);
    const row = yield* Docs.docRow(input.orgId, { key: input.key });
    const to = yield* Docs.versionOf(input.orgId, row.recordId, input.to);
    if (to === undefined)
      return yield* new KinChatError({
        reason: "not_found",
        message: `${row.key} has no version ${input.to}.`,
      });
    const fromVersion = input.from ?? Math.max(1, to.version - 1);
    const from = yield* Docs.versionOf(input.orgId, row.recordId, fromVersion);
    if (from === undefined)
      return yield* new KinChatError({
        reason: "not_found",
        message: `${row.key} has no version ${fromVersion}.`,
      });
    const patch = patchOf(`${row.key}.md`, from.body, to.body);
    const sections = changedSections(from.body, to.body);
    return {
      key: row.key,
      from: Docs.toVersion(from),
      to: Docs.toVersion(to),
      patch: patch.patch,
      additions: patch.additions,
      deletions: patch.deletions,
      changedSections: sections.changed,
      removedSections: sections.removed,
    };
  },
  Effect.catchTags({ SqlError: () => unavailable }),
);

/** The owner's undo: the version comes back as a new latest one, so it can be undone too. */
export const restore = Effect.fn("KinDocs.restore")(
  function* (people: ReadonlyArray<PersonIdentity>, input: KinDocRestoreInput) {
    const person = yield* theOwner(people, input.orgId);
    yield* Docs.restore(
      input.orgId,
      ownerWriter(person),
      {},
      { key: input.key },
      {
        version: input.version,
        latest: input.latest,
        originKey: `owner-restore:${person.personId}:${input.key}:${input.version}:${input.latest}`,
      },
    );
    return yield* detailOf(input.orgId, { key: input.key });
  },
  Effect.catchTags({ SqlError: () => unavailable }),
);

export const search = Effect.fn("KinDocs.search")(
  function* (people: ReadonlyArray<PersonIdentity>, input: KinSearchInput) {
    yield* theOwner(people, input.orgId);
    const now = yield* Clock.currentTimeMillis;
    const found = yield* runSearch(input.orgId, {
      text: input.text,
      kinds: input.kinds,
      closed: input.closed,
      limit: input.limit ?? 20,
      viewer: "owner",
    });
    return {
      hits: found.hits.map((hit) => ({
        recordId: hit.recordId as never,
        key: hit.key,
        kind: hit.kind,
        title: hit.title as never,
        snippet: hit.snippet,
        ...(hit.section === undefined
          ? {}
          : { section: { id: hit.section.id, title: hit.section.title } }),
        sensitive: hit.sensitive,
        closed: hit.closed,
        updatedAt: iso(hit.updatedAt),
      })),
      indexed: found.indexed,
      asOf: iso(now),
    };
  },
  Effect.catchTags({ SqlError: () => unavailable }),
);

const DOC_KEY = `${LISTS.docs.prefix}-`;
export const subscribe = (
  people: ReadonlyArray<PersonIdentity>,
  input: { readonly orgId: KinOrgId },
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      yield* theOwner(people, input.orgId);
      const records = yield* KinRecords;
      return records.changes(input.orgId).pipe(
        Stream.filter((tick) => tick.key === undefined || tick.key.startsWith(DOC_KEY)),
        Stream.map((tick) => ({ _tag: "changed" as const, ...tick })),
      );
    }),
  );

/** The company's recipes, as the Docs screen lists them. */
export const recipes = Effect.fn("KinDocs.recipes")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinRecipesInput,
) {
  yield* theOwner(people, input.orgId);
  const stored = yield* (yield* KinWorkspace).recipes(input.orgId);
  return {
    recipes: stored.map((recipe) => ({
      name: recipe.name,
      title: recipe.title,
      description: recipe.description,
      inputs: recipe.inputs.map((one) => ({
        name: one.name,
        type: one.type,
        required: one.required,
        from: one.from,
        ...(one.description === undefined ? {} : { description: one.description }),
      })),
      outputs: [...recipe.outputs],
      list: recipe.list,
      numbered: recipe.numbered,
      sensitive: recipe.sensitive,
      changedAt: recipe.changedAt === null ? null : iso(recipe.changedAt),
      changedBy: recipe.changed,
      commit: recipe.commit,
    })),
  } satisfies KinRecipesResult;
});

const PREVIEW_BYTES = 5 * 1024 * 1024;

/**
 * The owner's "Make invoice", "Preview" and "Export month": a recipe's document made in the call,
 * with no agent turn, filed as the owner's (or, for a preview, returned and never filed).
 */
export const render = Effect.fn("KinDocs.render")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinDocRenderInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const made = yield* makeDocument({
    orgId: input.orgId,
    recipe: input.recipe,
    entry: input.entry,
    given: input.inputs ?? {},
    title: input.title ?? input.recipe,
    requester: { _tag: "owner", personId: person.personId, writer: ownerWriter(person) },
    jobKey: `owner:${person.personId}:${input.clientRequestId}`,
    admit: Effect.void,
    preview: input.preview === true,
  });
  const previewBytes = made.files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (input.preview === true && previewBytes > PREVIEW_BYTES)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: "The preview is over 5 MB; make the document instead.",
    });
  return {
    documents: made.documents.map((doc) => ({
      recordId: KinRecordId.make(doc.recordId),
      key: KinRecordKey.make(doc.key),
      title: doc.title,
      version: doc.version,
    })),
    number: made.number,
    draft: made.draft,
    sensitive: made.sensitive,
    preview:
      input.preview === true
        ? made.files.map((file) => ({
            name: file.name,
            mimeType: file.mimeType,
            base64: Buffer.from(file.bytes).toString("base64"),
          }))
        : null,
  } satisfies KinDocRenderResult;
}, workFailure);

/** The owner's undo of a recipe's last change; undoing again redoes it. */
export const undoRecipe = Effect.fn("KinDocs.undoRecipe")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinRecipeUndoInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const undone = yield* (yield* KinWorkspace).undoRecipe(input.orgId, input.recipe, {
    _tag: "owner",
    personId: person.personId,
  });
  if (undone._tag === "refused")
    return yield* new KinChatError({
      reason: "invalid_state",
      message: `Nothing changed: ${undone.reason}.`,
    });
  return {
    recipe: input.recipe,
    commit: undone.commit,
    removed: undone.removed,
  } satisfies KinRecipeUndoResult;
}, workFailure);
