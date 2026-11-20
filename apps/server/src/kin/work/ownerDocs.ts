import {
  KinChatError,
  type KinDocDetail,
  type KinDocDiffInput,
  type KinDocFileInput,
  type KinDocGetInput,
  type KinDocHistoryInput,
  type KinDocLabelInput,
  type KinDocRestoreInput,
  type KinDocStartWhatWeSellInput,
  type KinDocRenderInput,
  type KinDocRenderResult,
  type KinDocsListInput,
  type KinDocsEvent,
  type KinDocsSubscribeInput,
  type KinOrgId,
  type KinRecipeClearLabelResult,
  type KinRecipeDefaultInput,
  type KinRecipeDefaultResult,
  type KinRecipeLabelInput,
  type KinRecipesInput,
  type KinRecipesResult,
  type KinRecipeUndoInput,
  type KinRecipeUndoResult,
  KinRecordId,
  KinRecordKey,
  type KinSearchInput,
  kinSlimDocRow,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { makeDocument } from "../gendocs/make.ts";
import { defaultRecipes, setDefaultRecipe as setDefault } from "../gendocs/recipeDefaults.ts";
import { recipeLabelled, setLabel, undoRecipe as undoLabelled } from "../gendocs/recipeLabels.ts";
import { KinWorkspace } from "../gendocs/workspace.ts";
import { changedSections, outlineOf, patchOf } from "./docBody.ts";
import { docEmbeds } from "./docFiles.ts";
import * as Docs from "./docs.ts";
import { KinRecords, type Tick } from "./KinRecords.ts";
import { LISTS } from "./lists.ts";
import { OFFERINGS_ORIGIN, startOfferings, withOfferings } from "./offerings.ts";
import { inList, ownerWriter, theOwner, viewerOf } from "./ownerWork.ts";
import {
  iso,
  principalId,
  recordSeq,
  selectRecords,
  unavailable,
  workFailure,
} from "./recordRows.ts";
import { KinMemoryChanges } from "../memory/MemoryChanges.ts";
import { EVERY_RECORD_KIND, search as runSearch } from "./search.ts";
import { searchIndexed } from "./searchIndex.ts";
import {
  clientMoneySeen,
  KIN_OWNER_LEVEL,
  PICTURE_DOC_ORIGIN,
  placesOf,
  seenBy,
  teamSeq,
  linkedFromOf,
  teamVisible,
  viewerOfPeople,
  type KinViewer,
} from "./teamView.ts";

/**
 * What people's clients read and do in Docs: read, compare, restore and search. The owner and
 * co-owners read every doc; anyone else with the Docs place, or leading a project, reads only the
 * docs `personSees` gives them and restores none. People never write a body.
 */

const noDocs = new KinChatError({
  reason: "not_allowed",
  message: "Only the owner or a co-owner can open Docs for you.",
});
/** The caller; for anyone besides the owner, only with the Docs place or a project they lead. */
const reader = Effect.fn("KinDocs.reader")(function* (
  people: ReadonlyArray<PersonIdentity>,
  orgId: KinOrgId,
) {
  const viewer = yield* viewerOf(people, orgId);
  if (!viewer.teammate) return undefined;
  const places = yield* placesOf(orgId, viewer.person.personId).pipe(workFailure);
  if (!places.reaches.docs) return yield* noDocs;
  return viewer.person.personId;
});

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
  viewer: KinViewer,
  version?: number,
) {
  const records = yield* KinRecords;
  const row = yield* Docs.docRow(orgId, ref, viewer);
  const latest = yield* Docs.versionOf(orgId, row.recordId);
  const found = yield* Docs.versionOf(orgId, row.recordId, version);
  const seen = yield* Docs.versionsSeen(orgId, viewer, row);
  const shown = found !== undefined && seen(found.version) ? found : undefined;
  if (latest === undefined) return yield* unavailable;
  if (shown === undefined)
    return yield* new KinChatError({
      reason: "not_found",
      message: `${row.key} has no version ${version}; it is at ${latest.version}.`,
    });
  const now = yield* Clock.currentTimeMillis;
  const detail = yield* records.detail(row, 0);
  const ids = detail.links.flatMap((link) =>
    link.kind === "record" && link.record !== undefined ? [link.record.recordId] : [],
  );
  let linked: ReadonlySet<string> | undefined;
  if (viewer._tag === "people")
    for (const person of viewer.people) {
      const seen = yield* teamVisible(orgId, person, ids);
      linked = new Set([...(linked ?? seen)].filter((id) => seen.has(id)));
    }
  return {
    ...withOfferings(Docs.toDocRow(row, latest, now), row),
    version: Docs.toVersion(shown),
    body: shown.body,
    outline: [...outlineOf(shown.body)],
    links:
      linked === undefined
        ? detail.links
        : detail.links.filter(
            (link) =>
              link.kind !== "record" ||
              (link.record !== undefined && linked.has(link.record.recordId)),
          ),
    ...(yield* linkedFromOf(orgId, row.recordId, viewer)),
    seq: yield* recordSeq(orgId, row.recordId),
    embeds: yield* docEmbeds(orgId, row.recordId, shown.body),
  } satisfies KinDocDetail;
});

/** Which docs `input` lists for `viewer`. */
const listWhere = Effect.fn("KinDocs.listWhere")(function* (
  viewer: KinViewer,
  input: Omit<KinDocsListInput, "cursor" | "limit" | "acceptSlimLatest">,
) {
  const sql = yield* SqlClient.SqlClient;
  const partyId =
    input.party === undefined
      ? undefined
      : (yield* inList(input.orgId, input.party, "clients")).recordId;
  const projectId =
    input.project === undefined
      ? undefined
      : (yield* inList(input.orgId, input.project, "projects")).recordId;
  const text = input.text?.trim().toLowerCase() ?? "";
  return sql.and([
    sql`r.org_id = ${input.orgId}`,
    sql`r.register_id = 'docs'`,
    seenBy(sql, viewer),
    input.archived === true ? sql`r.state = 'dropped'` : sql`r.state != 'dropped'`,
    ...(partyId === undefined ? [] : [sql`r.party_id = ${partyId}`]),
    // A client's money docs reach a teammate only with the Money switch (`clientMoneySeen`).
    ...(partyId === undefined || viewer._tag === "ownerLevel"
      ? []
      : viewer.people.map((person) => clientMoneySeen(sql, person))),
    ...(projectId === undefined ? [] : [sql`r.project_id = ${projectId}`]),
    ...(input.owner === undefined
      ? []
      : [sql`r.owner_kind = ${input.owner._tag} AND r.owner_id = ${principalId(input.owner)}`]),
    ...(input.kind === undefined
      ? []
      : input.kind === "other"
        ? [sql`(r.category IS NULL OR r.category = 'other')`]
        : [sql`r.category = ${input.kind}`]),
    ...(input.home === undefined
      ? []
      : [
          sql`r.party_id IS NULL AND r.project_id IS NULL`,
          input.home === "company"
            ? sql`json_extract(r.fields_json, '$.home') = 'company'`
            : sql`json_extract(r.fields_json, '$.home') IS NOT 'company'`,
        ]),
    ...(input.files === undefined
      ? []
      : [
          // A picture is a file with no other record to live on, so it stays on the shelf.
          sql`(${input.files ? sql`` : sql`NOT `}EXISTS (SELECT 1 FROM kin_doc_versions f
              WHERE f.org_id = r.org_id AND f.record_id = r.record_id AND f.body_kind = 'file')
            OR r.origin_key LIKE ${`${PICTURE_DOC_ORIGIN}%`})`,
        ]),
    ...(text === ""
      ? []
      : [
          sql`(instr(lower(r.title), ${text}) > 0 OR EXISTS (SELECT 1 FROM kin_doc_versions v
              WHERE v.org_id = r.org_id AND v.record_id = r.record_id
                AND v.version = (SELECT MAX(w.version) FROM kin_doc_versions w
                  WHERE w.org_id = r.org_id AND w.record_id = r.record_id)
                AND instr(lower(v.body), ${text}) > 0))`,
        ]),
    ...(input.changedSince === undefined
      ? []
      : [sql`r.updated_at >= ${Date.parse(input.changedSince)}`]),
    ...(input.whatWeSell === true ? [sql`r.origin_key = ${OFFERINGS_ORIGIN}`] : []),
  ]);
});

export const list = Effect.fn("KinDocs.list")(
  function* (people: ReadonlyArray<PersonIdentity>, input: KinDocsListInput) {
    const team = yield* reader(people, input.orgId);
    const sql = yield* SqlClient.SqlClient;
    const records = yield* KinRecords;
    const offset = yield* offsetOf(input.cursor);
    const where = yield* listWhere(
      team === undefined ? KIN_OWNER_LEVEL : viewerOfPeople([team]),
      input,
    );
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
        if (version === undefined) return [];
        const doc = withOfferings(Docs.toDocRow(row, version, now), row);
        return [input.acceptSlimLatest === true ? kinSlimDocRow(doc) : doc];
      }),
      total: count?.total ?? 0,
      nextCursor: next < (count?.total ?? 0) ? `o:${next}` : null,
      seq: team === undefined ? yield* records.seq(input.orgId) : yield* teamSeq(input.orgId, team),
      asOf: iso(now),
    };
  },
  Effect.catchTags({ SqlError: () => unavailable }),
);

export const get = Effect.fn("KinDocs.get")(
  function* (people: ReadonlyArray<PersonIdentity>, input: KinDocGetInput) {
    const team = yield* reader(people, input.orgId);
    return yield* detailOf(
      input.orgId,
      "key" in input ? { key: input.key } : { recordId: input.recordId },
      team === undefined ? KIN_OWNER_LEVEL : viewerOfPeople([team]),
      input.version,
    );
  },
  Effect.catchTags({ SqlError: () => unavailable }),
);

export const history = Effect.fn("KinDocs.history")(
  function* (people: ReadonlyArray<PersonIdentity>, input: KinDocHistoryInput) {
    const team = yield* reader(people, input.orgId);
    const before = input.cursor === undefined ? undefined : /^v:(\d{1,9})$/.exec(input.cursor)?.[1];
    if (input.cursor !== undefined && before === undefined) return yield* badCursor;
    const row = yield* Docs.docRow(
      input.orgId,
      { key: input.key },
      team === undefined ? KIN_OWNER_LEVEL : viewerOfPeople([team]),
    );
    const limit = input.limit ?? 50;
    const rows = yield* Docs.history(input.orgId, row.recordId, {
      ...(before === undefined ? {} : { before: Number.parseInt(before, 10) }),
      limit,
    });
    const seen = yield* Docs.versionsSeen(
      input.orgId,
      team === undefined ? KIN_OWNER_LEVEL : viewerOfPeople([team]),
      row,
    );
    const last = rows.at(-1);
    return {
      versions: rows.filter((one) => seen(one.version)).map(Docs.toVersion),
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
    const team = yield* reader(people, input.orgId);
    const viewer = team === undefined ? KIN_OWNER_LEVEL : viewerOfPeople([team]);
    const row = yield* Docs.docRow(input.orgId, { key: input.key }, viewer);
    const seen = yield* Docs.versionsSeen(input.orgId, viewer, row);
    const seenOf = (version: Effect.Success<ReturnType<typeof Docs.versionOf>>) =>
      version !== undefined && seen(version.version) ? version : undefined;
    const to = seenOf(yield* Docs.versionOf(input.orgId, row.recordId, input.to));
    if (to === undefined)
      return yield* new KinChatError({
        reason: "not_found",
        message: `${row.key} has no version ${input.to}.`,
      });
    const fromVersion = input.from ?? Math.max(1, to.version - 1);
    const from = seenOf(yield* Docs.versionOf(input.orgId, row.recordId, fromVersion));
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
    return yield* detailOf(input.orgId, { key: input.key }, KIN_OWNER_LEVEL);
  },
  Effect.catchTags({ SqlError: () => unavailable }),
);

/** The owner level starts What we sell from its empty state, then talks it through with an agent. */
export const startWhatWeSell = Effect.fn("KinDocs.startWhatWeSell")(
  function* (people: ReadonlyArray<PersonIdentity>, input: KinDocStartWhatWeSellInput) {
    const person = yield* theOwner(people, input.orgId);
    const { row } = yield* startOfferings(input.orgId, ownerWriter(person), person.personId);
    return yield* detailOf(input.orgId, { recordId: row.recordId }, KIN_OWNER_LEVEL);
  },
  Effect.catchTags({ SqlError: () => unavailable }),
);

/** At most this many remembered items lead a search; entries fill the rest. */
const MEMORY_HITS = 5;
export const search = Effect.fn("KinDocs.search")(
  function* (people: ReadonlyArray<PersonIdentity>, input: KinSearchInput) {
    const viewer = yield* viewerOf(people, input.orgId);
    const team = viewer.teammate ? viewer.person.personId : undefined;
    const now = yield* Clock.currentTimeMillis;
    const limit = input.limit ?? 20;
    const asked = input.kinds ?? [];
    const recordKinds = asked.filter((kind) => kind !== "memory");
    const everything = input.everything === true;
    // Memory is the owner level's alone: a teammate's search never reads it.
    const memory =
      everything && team === undefined && (asked.length === 0 || asked.includes("memory"))
        ? yield* Effect.serviceOption(KinMemoryChanges).pipe(
            Effect.flatMap((changes) =>
              changes._tag === "None"
                ? Effect.succeed([])
                : changes.value.search(people, {
                    orgId: input.orgId,
                    text: input.text,
                    limit: Math.min(MEMORY_HITS, limit),
                  }),
            ),
          )
        : [];
    const found =
      asked.length > 0 && recordKinds.length === 0
        ? { hits: [], indexed: yield* searchIndexed() }
        : yield* runSearch(input.orgId, {
            text: input.text,
            kinds:
              recordKinds.length > 0 ? recordKinds : everything ? EVERY_RECORD_KIND : undefined,
            closed: input.closed,
            limit: limit - memory.length,
            viewer: team === undefined ? "owner" : "team",
            scope: team === undefined ? KIN_OWNER_LEVEL : viewerOfPeople([team]),
            deals: true,
          });
    return {
      hits: [
        ...memory.map((hit) => ({
          recordId: KinRecordId.make(`memory:${hit.itemId}`),
          key: hit.itemId,
          kind: "memory" as const,
          title: (hit.title.trim() || "Untitled") as never,
          snippet: hit.snippet,
          sensitive: hit.sensitive,
          closed: false,
          updatedAt: iso(hit.recordedAt),
        })),
        ...found.hits.map((hit) => ({
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
      ],
      indexed: found.indexed,
      asOf: iso(now),
    };
  },
  Effect.catchTags({ SqlError: () => unavailable }),
);

const DOC_KEY = `${LISTS.docs.prefix}-`;
/** The Docs list a screen opens on, which `acceptRows` keeps current: not archived, no files. */
const DOCS_SHELF = { archived: false, files: false } as const;
/** As Work's stream: a burst is read once, and past this many docs it is read again whole. */
const DOCS_BATCH = 512;
const DOCS_BATCH_WINDOW = Duration.millis(50);
const DOCS_ROWS_BURST = 16;

/** One doc as the unfiltered Docs list shows this viewer, or `unlisted`, and that list's total. */
const listedOf = Effect.fn("KinDocs.listedOf")(
  function* (orgId: KinOrgId, viewer: KinViewer, key: string) {
    const sql = yield* SqlClient.SqlClient;
    const where = yield* listWhere(viewer, { orgId, ...DOCS_SHELF });
    const [count] = yield* sql<{
      total: number;
    }>`SELECT COUNT(*) AS total FROM kin_records r WHERE ${where}`;
    const [row] = yield* sql<Parameters<typeof Docs.toDocRow>[0]>`${selectRecords(sql)}
      WHERE ${sql.and([where, sql`r.key = ${key}`])}`;
    const version =
      row === undefined
        ? undefined
        : (yield* Docs.latestOf(orgId, [row.recordId])).get(row.recordId);
    const now = yield* Clock.currentTimeMillis;
    return {
      total: count?.total ?? 0,
      ...(row === undefined || version === undefined
        ? { unlisted: true as const }
        : { row: kinSlimDocRow(withOfferings(Docs.toDocRow(row, version, now), row)) }),
    };
  },
  Effect.catchTags({ SqlError: () => unavailable }),
);

/**
 * One subscriber's side of `kin.docs.subscribe`: what a burst of ticks tells them. A teammate's
 * own number moves only for docs they saw before or see after (`teamPairs`). With `acceptRows`
 * each doc's change carries it as the Docs list shows them (`listedOf`); their access is checked
 * again for each burst, and a change to it ends the stream, so rows never outlive it.
 */
export const makeDocsStream = Effect.fn("KinDocs.makeStream")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinDocsSubscribeInput,
) {
  const team = yield* reader(people, input.orgId);
  const viewer = team === undefined ? KIN_OWNER_LEVEL : viewerOfPeople([team]);
  const sql = yield* SqlClient.SqlClient;
  /**
   * A teammate's listed docs, as last told: a project's people or holders moving shows or hides its
   * docs with no change to them, and only a doc in here is ever named as gone.
   */
  const seen = new Set<string>();
  /** The docs this teammate's Docs list shows now, by key. */
  const listedKeys = Effect.fnUntraced(function* () {
    const where = yield* listWhere(viewer, { orgId: input.orgId, ...DOCS_SHELF });
    const rows = yield* sql<{ key: string }>`SELECT r.key FROM kin_records r
      WHERE ${where} ORDER BY r.key`.pipe(workFailure);
    return new Set(rows.map((one) => one.key));
  });
  /** `seen` as a fresh read lists them, after which the client holds that read. */
  const reseen = Effect.fnUntraced(function* () {
    seen.clear();
    if (team === undefined || input.acceptRows !== true) return;
    for (const key of yield* listedKeys()) seen.add(key);
  });
  yield* reseen();
  const plain = (seq: number, key?: string): KinDocsEvent => ({
    _tag: "changed",
    seq,
    ...(key === undefined ? {} : { key: KinRecordKey.make(key) }),
  });
  /** This viewer's number and doc for `tick`; null when it touched no doc they see. */
  const mine = Effect.fnUntraced(function* (
    tick: Tick,
  ): Effect.fn.Return<
    { readonly seq: number; readonly key?: string } | null,
    KinChatError,
    SqlClient.SqlClient
  > {
    if (tick.key !== undefined && !tick.key.startsWith(DOC_KEY)) return null;
    if (tick.key === undefined)
      return {
        seq: team === undefined ? tick.seq : yield* teamSeq(input.orgId, team).pipe(workFailure),
      };
    if (team === undefined) return { seq: tick.seq, key: tick.key };
    const seq = tick.team?.get(team);
    return seq === undefined ? null : { seq, key: tick.key };
  });
  /**
   * A teammate's docs a tick may have shown or hidden through a project: one that moved who holds
   * work there, or a project's own change (its people, its lead). Each at their number.
   */
  const throughProjects = Effect.fnUntraced(function* (tick: Tick) {
    if (team === undefined || tick.key === undefined || tick.key.startsWith(DOC_KEY)) return [];
    const seq = tick.team?.get(team);
    if (seq === undefined || ((tick.projects ?? []).length === 0 && tick.registerId !== "projects"))
      return [];
    const now = yield* listedKeys();
    return [...new Set([...now, ...seen])]
      .filter((key) => now.has(key) !== seen.has(key))
      .map((key) => ({ seq, key, moved: true }));
  });
  const burst = Effect.fnUntraced(function* (ticks: ReadonlyArray<Tick>) {
    const changes: Array<{
      readonly seq: number;
      readonly key?: string;
      readonly moved?: boolean;
    }> = (yield* Effect.forEach(ticks, mine)).filter((one) => one !== null);
    if (input.acceptRows !== true) return changes.map((one) => plain(one.seq, one.key));
    for (const tick of ticks) changes.push(...(yield* throughProjects(tick)));
    if (changes.length === 0) return [];
    if ((yield* reader(people, input.orgId)) !== team)
      return yield* new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });
    // A doc's own change goes out whatever it shows; one its project moved, only if that showed
    // or hid it.
    const keyed = new Map<string, { seq: number; moved: boolean }>();
    for (const one of changes)
      if (one.key !== undefined) {
        const held = keyed.get(one.key);
        keyed.set(one.key, {
          seq: Math.max(held?.seq ?? 0, one.seq),
          moved: (held?.moved ?? true) && one.moved === true,
        });
      }
    const latest = Math.max(...changes.map((one) => one.seq));
    // Too many to send whole, or a change no doc names: one read is cheaper and right.
    if (keyed.size > DOCS_ROWS_BURST || changes.some((one) => one.key === undefined)) {
      yield* reseen();
      return [plain(latest)];
    }
    const out: Array<KinDocsEvent> = [];
    for (const [key, { seq, moved }] of [...keyed].sort((a, b) => a[1].seq - b[1].seq)) {
      const listed = yield* listedOf(input.orgId, viewer, key);
      const was = seen.has(key);
      const shown = "row" in listed;
      if (shown) seen.add(key);
      else seen.delete(key);
      if (moved && shown === was) continue;
      out.push({ ...plain(seq, key), ...listed });
    }
    return out;
  });
  return { burst };
});

/** `kin.docs.subscribe`: the change number now, then each burst of changes (`makeDocsStream`). */
export const subscribe = (people: ReadonlyArray<PersonIdentity>, input: KinDocsSubscribeInput) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const session = yield* makeDocsStream(people, input);
      const ticks = (yield* KinRecords).changes(input.orgId);
      return (
        input.acceptRows === true
          ? ticks.pipe(Stream.groupedWithin(DOCS_BATCH, DOCS_BATCH_WINDOW))
          : ticks.pipe(Stream.map((tick) => [tick]))
      ).pipe(Stream.mapEffect(session.burst), Stream.flattenIterable);
    }),
  );

/** The company's recipes, as the Docs screen lists them. */
export const recipes = Effect.fn("KinDocs.recipes")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinRecipesInput,
) {
  yield* theOwner(people, input.orgId);
  const stored = yield* (yield* KinWorkspace).recipes(input.orgId);
  const labelled = yield* Effect.forEach(stored, (recipe) => recipeLabelled(input.orgId, recipe));
  const defaults = yield* defaultRecipes(input.orgId, stored);
  return {
    recipes: stored.map((recipe, index) => ({
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
      ...(defaults.has(recipe.name) ? { default: true as const } : {}),
      ...(labelled[index] === true ? { labelled: true as const, files: [...recipe.files] } : {}),
      changedAt: recipe.changedAt === null ? null : iso(recipe.changedAt),
      changedBy: recipe.changed,
      commit: recipe.commit,
    })),
  } satisfies KinRecipesResult;
}, workFailure);

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
    doc: input.doc,
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
  const undone = yield* undoLabelled(input.orgId, input.recipe, {
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

/** The owner's label on a doc: raising or lowering it, which only a person may do. */
export const label = Effect.fn("KinDocs.label")(
  function* (people: ReadonlyArray<PersonIdentity>, input: KinDocLabelInput) {
    const person = yield* theOwner(people, input.orgId);
    yield* Docs.move(
      input.orgId,
      ownerWriter(person),
      { key: input.key },
      {
        sensitive: input.sensitive,
      },
    );
    return yield* detailOf(input.orgId, { key: input.key }, KIN_OWNER_LEVEL);
  },
  Effect.catchTags({ SqlError: () => unavailable }),
);

/** The owner files a doc: its kind, and its client and project or the company. */
export const file = Effect.fn("KinDocs.file")(
  function* (people: ReadonlyArray<PersonIdentity>, input: KinDocFileInput) {
    const person = yield* theOwner(people, input.orgId);
    const partyId =
      input.party === undefined || input.party === null
        ? input.party
        : (yield* inList(input.orgId, input.party, "clients")).recordId;
    const projectId =
      input.project === undefined || input.project === null
        ? input.project
        : (yield* inList(input.orgId, input.project, "projects")).recordId;
    yield* Docs.move(
      input.orgId,
      ownerWriter(person),
      { key: input.key },
      {
        ...(partyId === undefined ? {} : { partyId }),
        ...(projectId === undefined ? {} : { projectId }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.company === undefined ? {} : { company: input.company }),
      },
      input.rev,
    );
    return yield* detailOf(input.orgId, { key: input.key }, KIN_OWNER_LEVEL);
  },
  Effect.catchTags({ SqlError: () => unavailable }),
);

/** The owner raises or lowers a recipe's label, as they saw it; only a person may lower one. */
export const labelRecipe = Effect.fn("KinDocs.labelRecipe")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinRecipeLabelInput,
) {
  const person = yield* theOwner(people, input.orgId);
  return (yield* setLabel(
    input.orgId,
    input.recipe,
    person.personId,
    input.commit,
    input.sensitive,
  )) satisfies KinRecipeClearLabelResult;
}, workFailure);

/** The owner makes a recipe the one its list's documents are made with. */
export const setDefaultRecipe = Effect.fn("KinDocs.setDefaultRecipe")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinRecipeDefaultInput,
) {
  const person = yield* theOwner(people, input.orgId);
  return (yield* setDefault(
    input.orgId,
    input.recipe,
    person.personId,
  )) satisfies KinRecipeDefaultResult;
}, workFailure);
