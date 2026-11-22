import { KIN_RECORDS_PAGE_CAP, KinChatError, type KinRecordKey } from "@t3tools/contracts";
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
 * makes, as them, in one transaction with the key's own check (`connectionViewer`). Each read's
 * viewer is keyed (`keyedViewer`), so what a key never carries (`keyWithheld`) is left out inside
 * the screen's own query, before any match, sort, count or limit.
 */

const ROWS = 50;
const MEMORY_LINES = 20;
/** Pages of the person's own open tasks read for the projects they are on, at most. */
const TASK_PAGES = 20;
const keyed = { keyed: true } as const;

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
const docChanged = (key: string) =>
  new KinChatError({
    reason: "conflict",
    message: `${key} changed since you read its first page: start again from page 1.`,
  });

/** An opened entry no key carries answers as one never there, whatever the screen admits. */
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

/** A page of the person's own open tasks, as `list_my_tasks` reads them, in one project or all. */
const myOpenTasks = (
  holder: TasksKeyHolder,
  people: ReadonlyArray<PersonIdentity>,
  input: { readonly project?: KinRecordKey; readonly cursor?: string },
) =>
  list(
    people,
    { orgId: holder.orgId, limit: KIN_RECORDS_PAGE_CAP, ...input },
    asPerson(holder).connection,
  ).pipe(
    Effect.flatMap((page) =>
      "records" in page
        ? Effect.succeed({ tasks: page.records, next: page.nextCursor })
        : Effect.die("Work answered a coding agent's list in compact rows"),
    ),
  );

type Paging = { readonly cursor?: string | undefined; readonly limit?: number | undefined };
const paging = (input: Paging) => ({
  limit: Math.min(input.limit ?? ROWS, ROWS),
  ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
});

/**
 * The person's Projects list. Without Clients a member has no such list, so it is the projects
 * of their own open tasks, each as its project page opens to them, a page at a time.
 */
export const listProjects = Effect.fn("KinTasksKeyReads.listProjects")(function* (
  holder: TasksKeyHolder,
  input: Paging & {
    readonly text?: string | undefined;
    readonly client?: KinRecordKey | undefined;
    readonly mine?: boolean | undefined;
  },
) {
  const { connection } = asPerson(holder);
  return yield* readAs(holder, (people) =>
    Clients.projects(
      people,
      {
        orgId: holder.orgId,
        ...paging(input),
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.client === undefined ? {} : { party: input.client }),
        ...(input.mine === true ? { person: holder.personId } : {}),
      },
      keyed,
    ).pipe(
      Effect.map((found) => ({ rows: found.projects, next: found.nextCursor })),
      Effect.catchIf(
        (error) => error.reason === "not_allowed" && input.client === undefined,
        () => onMyTasks(holder, people, input).pipe(workFailure),
      ),
      noneFor({ rows: [], next: null }),
      Effect.flatMap((page) => projectRows(connection, page.rows, page.next)),
    ),
  );
});

const onMyTasks = Effect.fn("KinTasksKeyReads.onMyTasks")(function* (
  holder: TasksKeyHolder,
  people: ReadonlyArray<PersonIdentity>,
  input: Paging & { readonly text?: string | undefined },
) {
  const keys = new Set<KinRecordKey>();
  let cursor: string | undefined;
  for (let read = 0; read < TASK_PAGES; read++) {
    const page = yield* myOpenTasks(holder, people, cursor === undefined ? {} : { cursor });
    for (const task of page.tasks) if (task.project !== undefined) keys.add(task.project.key);
    if (page.next === null) break;
    cursor = page.next;
  }
  const words = input.text?.trim().toLowerCase() ?? "";
  const opened = yield* Effect.forEach([...keys], (key) =>
    Clients.project(people, { orgId: holder.orgId, key }, keyed).pipe(
      Effect.flatMap((page) =>
        keyHidden(holder.orgId, [page.project.recordId]).pipe(
          Effect.map((out) => (out.size > 0 ? [] : [page.project])),
        ),
      ),
      Effect.catchIf(
        (error) => error.reason === "not_found" || error.reason === "not_allowed",
        () => Effect.succeed([]),
      ),
    ),
  );
  const rows = opened
    .flat()
    .filter((one) => one.name.toLowerCase().includes(words))
    .toSorted((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  const { limit } = paging(input);
  const at = Number.parseInt(/^m:(\d{1,6})$/.exec(input.cursor ?? "")?.[1] ?? "0", 10);
  return {
    rows: rows.slice(at, at + limit),
    next: at + limit < rows.length ? `m:${at + limit}` : null,
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
      const page = yield* Clients.project(people, { orgId: holder.orgId, key }, keyed).pipe(
        Effect.mapError(hidden),
      );
      yield* reachable(holder, page.project.recordId);
      const tasks = yield* myOpenTasks(holder, people, { project: key });
      // Their Docs answers for the project only where they reach Docs at all.
      const docs = yield* Docs.list(
        people,
        { orgId: holder.orgId, project: key, acceptSlimLatest: true, limit: ROWS },
        keyed,
      ).pipe(
        Effect.map((found) => ({ rows: found.docs, more: found.nextCursor !== null })),
        Effect.catchIf(
          (error) => error.reason === "not_allowed",
          () => Effect.succeed(null),
        ),
      );
      return yield* projectSheet(connection, page, { ...tasks, more: tasks.next !== null }, docs);
    }),
  );
});

/** The person's Clients list. */
export const listClients = Effect.fn("KinTasksKeyReads.listClients")(function* (
  holder: TasksKeyHolder,
  input: Paging & { readonly text?: string | undefined },
) {
  return yield* readAs(holder, (people) =>
    Clients.parties(
      people,
      {
        orgId: holder.orgId,
        ...paging(input),
        ...(input.text === undefined ? {} : { text: input.text }),
      },
      keyed,
    ).pipe(Effect.map((found) => clientRows(found.parties, found.nextCursor))),
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
      const page = yield* Clients.party(people, { orgId: holder.orgId, key }, keyed).pipe(
        Effect.mapError(hidden),
      );
      yield* reachable(holder, page.party.recordId);
      const deals = yield* Deals.deals(people, { orgId: holder.orgId, party: key }, keyed).pipe(
        Effect.map((found) => ({ rows: found.deals, more: found.more > 0 })),
        Effect.catchIf(
          (error) => error.reason === "not_allowed" || error.reason === "not_found",
          () => Effect.succeed(null),
        ),
      );
      return yield* clientSheet(connection, page, deals);
    }),
  );
});

/** The docs the person's Docs list shows, by words in a title or text, client or project. */
export const findDocs = Effect.fn("KinTasksKeyReads.findDocs")(function* (
  holder: TasksKeyHolder,
  input: Paging & {
    readonly text?: string | undefined;
    readonly client?: KinRecordKey | undefined;
    readonly project?: KinRecordKey | undefined;
  },
) {
  return yield* readAs(holder, (people) =>
    Docs.list(
      people,
      {
        orgId: holder.orgId,
        acceptSlimLatest: true,
        ...paging(input),
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.client === undefined ? {} : { party: input.client }),
        ...(input.project === undefined ? {} : { project: input.project }),
      },
      keyed,
    ).pipe(
      Effect.map((found) => ({ docs: found.docs, next: found.nextCursor })),
      noneFor({ docs: [], next: null }),
      Effect.map((found) => docRows(found.docs, found.next)),
    ),
  );
});

/**
 * One page of a doc's text, as the person's Docs reader opens it. A later page names the version
 * page 1 gave, so pages of two versions never mix; a file has no text here.
 */
export const readDoc = Effect.fn("KinTasksKeyReads.readDoc")(function* (
  holder: TasksKeyHolder,
  input: {
    readonly key: KinRecordKey;
    readonly page?: number | undefined;
    readonly version?: number | undefined;
  },
) {
  const doc = yield* readAs(holder, (people) =>
    Docs.get(people, { orgId: holder.orgId, key: input.key }, keyed).pipe(
      Effect.mapError(hidden),
      Effect.tap((found) => reachable(holder, found.recordId)),
    ),
  );
  if (doc.bodyKind === "file")
    return yield* new KinChatError({
      reason: "invalid_state",
      message: `${doc.key} is a file, not text, so it has nothing to read here. Open it in Kin.`,
    });
  const page = input.page ?? 1;
  if (page > 1 && input.version !== doc.version.version) return yield* docChanged(doc.key);
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
 * What the person's Money screen shows, every figure and row without what a key never carries;
 * refused as the screen refuses them. `privateLeftOut` says whether leaving those out changed this
 * answer at all: the same read without the key's rule is taken only to compare, never returned.
 */
export const moneySummary = Effect.fn("KinTasksKeyReads.money")(function* (holder: TasksKeyHolder) {
  return yield* readAs(holder, (people) =>
    Effect.gen(function* () {
      const shown = moneySheet(yield* money(people, { orgId: holder.orgId }, keyed));
      const whole = moneySheet(yield* money(people, { orgId: holder.orgId }));
      const { asOf: _shownAt, ...figures } = shown;
      const { asOf: _wholeAt, ...all } = whole;
      return { ...shown, privateLeftOut: !same(figures, all) };
    }),
  );
});

/** Plain data compared by value: answers built from the same read model. */
const same = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((one, at) => same(one, b[at]));
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => same(Reflect.get(a, key), Reflect.get(b, key)))
    );
  }
  return a === b;
};

/** Whether the person has a Memory page: the owner level, as that page checks. */
export const readsMemory = Effect.fn("KinTasksKeyReads.readsMemory")(function* (
  holder: TasksKeyHolder,
) {
  return yield* ownerLevel(holder.orgId, holder.personId).pipe(workFailure);
});

/**
 * What Kin remembers that holds every word, through the search the person's screens use, which
 * only the owner level reaches; for every key, the owner's too, only what the team may know. It
 * reads memory as last loaded (no lock, sync or repair) and checks the key, the person's level and
 * each line's sharing label as stored now, in one transaction.
 */
export const searchMemory = Effect.fn("KinTasksKeyReads.memory")(function* (
  holder: TasksKeyHolder,
  text: string,
) {
  const { connection } = asPerson(holder);
  const changes = yield* Effect.serviceOption(KinMemoryChanges);
  return yield* readAs(holder, (people) =>
    Effect.gen(function* () {
      if (!(yield* readsMemory(holder))) return yield* noMemory;
      const hits = Option.isNone(changes)
        ? []
        : yield* changes.value.search(people, {
            orgId: holder.orgId,
            text,
            limit: MEMORY_LINES + 1,
            teamOnly: true,
            snapshot: true,
          });
      return yield* memoryLines(
        connection,
        hits.slice(0, MEMORY_LINES),
        hits.length > MEMORY_LINES,
      );
    }),
  );
});
