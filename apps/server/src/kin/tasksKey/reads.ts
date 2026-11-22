import { KinChatError, type KinRecordKey } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { KinMemoryChanges } from "../memory/MemoryChanges.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import { keyHidden } from "../work/codingAgent.ts";
import * as Deals from "../work/deals.ts";
import * as Clients from "../work/ownerClients.ts";
import * as Docs from "../work/ownerDocs.ts";
import { money, moneyViewer } from "../work/ownerMoney.ts";
import { connectionViewer, list } from "../work/ownerWork.ts";
import { workFailure } from "../work/recordRows.ts";
import {
  clientRows,
  clientSheet,
  docPage,
  docRows,
  memoryLines,
  moneySheet,
  pageOf,
  projectRows,
  projectSheet,
} from "../you/projection.ts";
import { asPerson } from "./tasks.ts";
import type { TasksKeyHolder } from "./TasksKeys.ts";

/**
 * What a person's coding agent reads beyond their tasks: each through the read their own screen
 * makes, as them, in one transaction with the key's own check (`connectionViewer`), minus what no
 * key reaches (`keyHidden`, `keySensitive`): private stays in Kin, whoever holds the key.
 */

const ROWS = 50;
const MEMORY_LINES = 20;

/** One answer for whatever this person can't open, and for what was never there. */
export const unknownKey = new KinChatError({ reason: "not_found", message: "Not found." });
const hidden = (error: KinChatError) =>
  error.reason === "not_found" || error.reason === "not_allowed" ? unknownKey : error;
/** A filter naming a client or project they can't see lists nothing, as one never there does. */
const noneFor =
  <A>(empty: A) =>
  <B, R>(effect: Effect.Effect<B, KinChatError, R>) =>
    effect.pipe(
      Effect.catchIf(
        (error) => error.reason === "not_found",
        () => Effect.succeed(empty),
      ),
    );
const noMemory = new KinChatError({
  reason: "not_allowed",
  message: "Only the owner or a co-owner can read what Kin remembers.",
});

/** A screen read's rows without any that no key reaches. */
const shown = Effect.fn("KinTasksKeyReads.shown")(function* <
  T extends { readonly recordId: string },
>(holder: TasksKeyHolder, rows: ReadonlyArray<T>) {
  const out = yield* keyHidden(
    holder.orgId,
    rows.map((row) => row.recordId),
  );
  return rows.filter((row) => !out.has(row.recordId));
});
/** One opened that no key reaches answers as one never there. */
const reachable = Effect.fn("KinTasksKeyReads.reachable")(function* (
  holder: TasksKeyHolder,
  recordId: string,
) {
  if ((yield* keyHidden(holder.orgId, [recordId])).size > 0) return yield* unknownKey;
});

/** The key's checks, then `read` as the person their screens see, in one transaction. */
const readAs = Effect.fn("KinTasksKeyReads.readAs")(function* <
  A,
  E extends { readonly _tag: string },
  R,
>(holder: TasksKeyHolder, read: (people: ReadonlyArray<PersonIdentity>) => Effect.Effect<A, E, R>) {
  const sql = yield* SqlClient.SqlClient;
  const { connection, people } = asPerson(holder);
  return yield* connectionViewer(people, connection, holder.orgId).pipe(
    Effect.andThen(read(people)),
    sql.withTransaction,
    workFailure,
  );
});

/** The person's own open tasks, as `list_my_tasks` reads them. */
const myOpenTasks = (holder: TasksKeyHolder, people: ReadonlyArray<PersonIdentity>) =>
  list(people, { orgId: holder.orgId, limit: 100 }, asPerson(holder).connection).pipe(
    Effect.flatMap((page) =>
      "records" in page
        ? Effect.succeed(page.records)
        : Effect.die("Work answered a coding agent's list in compact rows"),
    ),
  );

/**
 * The person's Projects list. Without Clients a member has no such list, so it is the projects
 * of their own open tasks, each as its project page opens to them.
 */
export const listProjects = Effect.fn("KinTasksKeyReads.listProjects")(function* (
  holder: TasksKeyHolder,
  input: {
    readonly text?: string | undefined;
    readonly client?: KinRecordKey | undefined;
    readonly mine?: boolean | undefined;
  },
) {
  const { connection } = asPerson(holder);
  return yield* readAs(holder, (people) =>
    Clients.projects(people, {
      orgId: holder.orgId,
      limit: ROWS,
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.client === undefined ? {} : { party: input.client }),
      ...(input.mine === true ? { person: holder.personId } : {}),
    }).pipe(
      Effect.map((found) => ({ rows: found.projects, more: found.nextCursor !== null })),
      Effect.catchIf(
        (error) => error.reason === "not_allowed" && input.client === undefined,
        () => onMyTasks(holder, people, input.text),
      ),
      noneFor({ rows: [], more: false }),
      Effect.flatMap((page) =>
        shown(holder, page.rows).pipe(
          Effect.flatMap((rows) => projectRows(connection, rows, page.more)),
        ),
      ),
    ),
  );
});

const onMyTasks = Effect.fn("KinTasksKeyReads.onMyTasks")(function* (
  holder: TasksKeyHolder,
  people: ReadonlyArray<PersonIdentity>,
  text: string | undefined,
) {
  const keys = new Set(
    (yield* myOpenTasks(holder, people)).flatMap((task) =>
      task.project === undefined ? [] : [task.project.key],
    ),
  );
  const words = text?.trim().toLowerCase() ?? "";
  const rows = yield* Effect.forEach([...keys], (key) =>
    Clients.project(people, { orgId: holder.orgId, key }).pipe(
      Effect.map((page) => [page.project]),
      Effect.catchIf(
        (error) => error.reason === "not_found" || error.reason === "not_allowed",
        () => Effect.succeed([]),
      ),
    ),
  );
  return {
    rows: rows.flat().filter((one) => one.name.toLowerCase().includes(words)),
    more: false,
  };
});

/** One project as its page opens to the person, their own open tasks on it, and its docs. */
export const openProject = Effect.fn("KinTasksKeyReads.openProject")(function* (
  holder: TasksKeyHolder,
  key: KinRecordKey,
) {
  const { connection } = asPerson(holder);
  return yield* readAs(holder, (people) =>
    Effect.gen(function* () {
      const page = yield* Clients.project(people, { orgId: holder.orgId, key }).pipe(
        Effect.mapError(hidden),
      );
      yield* reachable(holder, page.project.recordId);
      const tasks = (yield* myOpenTasks(holder, people)).filter(
        (task) => task.project?.recordId === page.project.recordId,
      );
      // Their Docs answers for the project only where they reach Docs at all.
      const docs = yield* Docs.list(people, {
        orgId: holder.orgId,
        project: key,
        acceptSlimLatest: true,
        limit: ROWS,
      }).pipe(
        Effect.flatMap((found) => shown(holder, found.docs)),
        Effect.catchIf(
          (error) => error.reason === "not_allowed",
          () => Effect.succeed(null),
        ),
      );
      return yield* projectSheet(connection, page, tasks, docs);
    }),
  );
});

/** The person's Clients list. */
export const listClients = Effect.fn("KinTasksKeyReads.listClients")(function* (
  holder: TasksKeyHolder,
  input: { readonly text?: string | undefined },
) {
  return yield* readAs(holder, (people) =>
    Clients.parties(people, {
      orgId: holder.orgId,
      limit: ROWS,
      ...(input.text === undefined ? {} : { text: input.text }),
    }).pipe(
      Effect.flatMap((found) =>
        shown(holder, found.parties).pipe(
          Effect.map((rows) => clientRows(rows, found.nextCursor !== null)),
        ),
      ),
    ),
  );
});

/** One client as its page opens to the person; deals only through the deals read, if it admits them. */
export const openClient = Effect.fn("KinTasksKeyReads.openClient")(function* (
  holder: TasksKeyHolder,
  key: KinRecordKey,
) {
  const { connection } = asPerson(holder);
  return yield* readAs(holder, (people) =>
    Effect.gen(function* () {
      const page = yield* Clients.party(people, { orgId: holder.orgId, key }).pipe(
        Effect.mapError(hidden),
      );
      yield* reachable(holder, page.party.recordId);
      const contacts = yield* shown(holder, page.contacts);
      const projects = yield* shown(holder, page.projects);
      const deals = yield* Deals.deals(people, { orgId: holder.orgId, party: key }).pipe(
        Effect.flatMap((found) => shown(holder, found.deals)),
        Effect.catchIf(
          (error) => error.reason === "not_allowed" || error.reason === "not_found",
          () => Effect.succeed(null),
        ),
      );
      return yield* clientSheet(connection, { ...page, contacts, projects }, deals);
    }),
  );
});

/** The docs the person's Docs list shows, by words, client or project. */
export const findDocs = Effect.fn("KinTasksKeyReads.findDocs")(function* (
  holder: TasksKeyHolder,
  input: {
    readonly text?: string | undefined;
    readonly client?: KinRecordKey | undefined;
    readonly project?: KinRecordKey | undefined;
  },
) {
  const page = yield* readAs(holder, (people) =>
    Docs.list(people, {
      orgId: holder.orgId,
      acceptSlimLatest: true,
      limit: ROWS,
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.client === undefined ? {} : { party: input.client }),
      ...(input.project === undefined ? {} : { project: input.project }),
    }).pipe(
      Effect.map((found) => ({ docs: found.docs, more: found.nextCursor !== null })),
      noneFor({ docs: [], more: false }),
      Effect.flatMap((found) =>
        shown(holder, found.docs).pipe(Effect.map((docs) => docRows(docs, found.more))),
      ),
    ),
  );
  return page;
});

/** One page of a doc's latest text, as the person's Docs reader opens it. */
export const readDoc = Effect.fn("KinTasksKeyReads.readDoc")(function* (
  holder: TasksKeyHolder,
  input: { readonly key: KinRecordKey; readonly page?: number | undefined },
) {
  const doc = yield* readAs(holder, (people) =>
    Docs.get(people, { orgId: holder.orgId, key: input.key }).pipe(
      Effect.mapError(hidden),
      Effect.tap((found) => reachable(holder, found.recordId)),
    ),
  );
  const page = input.page ?? 1;
  const { pages } = pageOf(doc.body, 1);
  if (page > pages)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: `${doc.key} has ${pages} ${pages === 1 ? "page" : "pages"}.`,
    });
  return docPage(doc, page);
});

/** Whether the person's Money screen opens for them now: the same reader it uses. */
export const readsMoney = Effect.fn("KinTasksKeyReads.readsMoney")(function* (
  holder: TasksKeyHolder,
) {
  return yield* moneyViewer(holder.orgId, holder.personId).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => error.reason === "not_allowed",
      () => Effect.succeed(false),
    ),
  );
});

/**
 * What the person's Money screen shows, every figure and row without what no key reaches, and
 * how many such entries were left out; refused as the screen refuses them.
 */
export const moneySummary = Effect.fn("KinTasksKeyReads.money")(function* (holder: TasksKeyHolder) {
  return moneySheet(
    yield* readAs(holder, (people) =>
      money(people, { orgId: holder.orgId, allClients: true }, { keyed: true }),
    ),
  );
});

/** Whether the person has a Memory page: the owner level, as that page checks. */
export const readsMemory = Effect.fn("KinTasksKeyReads.readsMemory")(function* (
  holder: TasksKeyHolder,
) {
  return yield* ownerLevel(holder.orgId, holder.personId).pipe(workFailure);
});

/**
 * What Kin remembers that holds every word, through the search the person's screens use, which
 * only the owner level reaches; for every key, the owner's too, only what the team may know.
 */
export const searchMemory = Effect.fn("KinTasksKeyReads.memory")(function* (
  holder: TasksKeyHolder,
  text: string,
) {
  const changes = yield* Effect.serviceOption(KinMemoryChanges);
  const hits = yield* readAs(holder, (people) =>
    Effect.gen(function* () {
      if (!(yield* readsMemory(holder))) return yield* noMemory;
      if (Option.isNone(changes)) return [];
      return yield* changes.value.search(people, {
        orgId: holder.orgId,
        text,
        limit: MEMORY_LINES,
        teamOnly: true,
      });
    }),
  );
  return memoryLines(hits);
});
