import {
  KinChatError,
  type KinDocumentLine,
  type KinDocRestoreInput,
  type KinGoalSaveInput,
  type KinFieldValue,
  type KinOpenRow,
  type KinProjectNoteInput,
  type KinWorkLinkAddInput,
  type KinRecord,
  type KinRecordKey,
  type KinRecordState,
  type KinTouchKind,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { KinNumbers, normalizeDecimal } from "../numbers/KinNumbers.ts";
import { numberFields } from "../numbers/numberRows.ts";
import { parseFields } from "../work/lists.ts";
import * as Open from "../open/people.ts";
import { keyHidden } from "../work/codingAgent.ts";
import { outlineOf } from "../work/docBody.ts";
import { docNotFound } from "../work/docs.ts";
import * as Deals from "../work/deals.ts";
import * as Clients from "../work/ownerClients.ts";
import * as Docs from "../work/ownerDocs.ts";
import * as Money from "../work/ownerMoney.ts";
import * as MoneyAnswers from "../work/ownerMoneyAnswers.ts";
import * as Goals from "../work/goals.ts";
import * as Watches from "../watches/KinWatches.ts";
import { watchReader } from "../watches/readRpcs.ts";
import * as Work from "../work/ownerWork.ts";
import * as Comments from "../work/workComments.ts";
import { notFound, workFailure } from "../work/recordRows.ts";
import { companyList, moneyOf } from "../work/keyGuard.ts";
import { listDef } from "../work/registers.ts";
import { MATERIAL, taskSheet } from "../you/projection.ts";
import { whoNamed } from "./people.ts";
import { unknownKey } from "./reads.ts";
import { asPerson, getMine, keyed, reachable, reachKey, requestIdOf } from "./tasks.ts";
import type { TasksKeyHolder } from "./TasksKeys.ts";

/**
 * What a person does by hand beyond their tasks, through their coding agent's key: each through
 * the method their own screen calls, as them (`keyed`), refused as their screen refuses them.
 */

const ROWS = 50;
const keyedRead = { keyed: true } as const;
const ref = (one: { readonly key: string; readonly title: string } | null | undefined) =>
  one === null || one === undefined ? null : { key: one.key, title: one.title };
const isString = (value: unknown): value is string => typeof value === "string";
const day = (value: string) => ({ dueAt: value, dueAllDay: true });
const nothingAsked = new KinChatError({
  reason: "invalid_state",
  message: "Nothing to change: give a field to change.",
});
const personOf = (holder: TasksKeyHolder): PersonIdentity => ({
  _tag: "person",
  orgId: holder.orgId,
  personId: holder.personId,
});
const named = (holder: TasksKeyHolder, name: string | undefined) =>
  name === undefined ? Effect.undefined : whoNamed(holder, name);

// ── Clients ──────────────────────────────────────────────────────────────────────────────────

export const createClient = Effect.fn("KinTasksKeyActs.createClient")(function* (
  holder: TasksKeyHolder,
  input: {
    readonly name: string;
    readonly prospect?: boolean | undefined;
    readonly vendor?: boolean | undefined;
    readonly notes?: string | undefined;
    readonly contact?:
      | {
          readonly name: string;
          readonly role?: string | undefined;
          readonly email?: string | undefined;
          readonly phone?: string | undefined;
        }
      | undefined;
  },
) {
  const request = {
    name: input.name,
    ...(input.vendor === true ? { kind: "vendor" as const } : {}),
    ...(input.prospect === undefined ? {} : { prospect: input.prospect }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(input.contact === undefined ? {} : { contact: input.contact }),
  };
  const made = yield* keyed(holder, (people) =>
    Clients.createParty(people, {
      orgId: holder.orgId,
      clientRequestId: requestIdOf(holder, "client", request),
      ...request,
    }),
  );
  return made.key;
});

export const updateClient = Effect.fn("KinTasksKeyActs.updateClient")(function* (
  holder: TasksKeyHolder,
  input: {
    readonly key: KinRecordKey;
    readonly name?: string | undefined;
    readonly notes?: string | undefined;
    readonly prospect?: boolean | undefined;
    readonly lookedAfterBy?: string | undefined;
    readonly newContact?:
      | {
          readonly name: string;
          readonly role?: string | undefined;
          readonly email?: string | undefined;
          readonly phone?: string | undefined;
          readonly notes?: string | undefined;
        }
      | undefined;
    readonly contact?:
      | {
          readonly key: KinRecordKey;
          readonly name?: string | undefined;
          readonly role?: string | null | undefined;
          readonly email?: string | null | undefined;
          readonly phone?: string | null | undefined;
          readonly notes?: string | undefined;
        }
      | undefined;
  },
) {
  yield* reachKey(holder, input.key);
  if (input.contact !== undefined) yield* reachKey(holder, input.contact.key);
  const owner = yield* named(holder, input.lookedAfterBy);
  const party = {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(input.prospect === undefined ? {} : { prospect: input.prospect }),
    ...(owner === undefined ? {} : { owner }),
  };
  if (
    Object.keys(party).length === 0 &&
    input.newContact === undefined &&
    input.contact === undefined
  )
    return yield* nothingAsked;
  yield* keyed(holder, (people) =>
    Effect.gen(function* () {
      const page = yield* Clients.party(people, { orgId: holder.orgId, key: input.key });
      if (Object.keys(party).length > 0)
        yield* Clients.updateParty(people, {
          orgId: holder.orgId,
          key: input.key,
          rev: page.party.rev,
          ...party,
        });
      if (input.newContact !== undefined)
        yield* Clients.createContact(people, {
          orgId: holder.orgId,
          party: input.key,
          clientRequestId: requestIdOf(holder, "contact", {
            party: input.key,
            ...input.newContact,
          }),
          ...input.newContact,
        });
      const { contact } = input;
      if (contact !== undefined) {
        const now = page.contacts.find((one) => one.key === contact.key);
        if (now === undefined) return yield* unknownKey;
        yield* Clients.updateContact(people, { orgId: holder.orgId, rev: now.rev, ...contact });
      }
    }),
  );
  return input.key;
});

export const logContact = Effect.fn("KinTasksKeyActs.logContact")(function* (
  holder: TasksKeyHolder,
  input: {
    readonly client: KinRecordKey;
    readonly kind: KinTouchKind;
    readonly note?: string | undefined;
    readonly day?: string | undefined;
    readonly next?: { readonly title: string; readonly due?: string | undefined } | undefined;
  },
) {
  yield* reachKey(holder, input.client);
  const request = {
    party: input.client,
    kind: input.kind,
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.day === undefined ? {} : { at: input.day }),
    ...(input.next === undefined
      ? {}
      : {
          next: {
            title: input.next.title,
            ...(input.next.due === undefined ? {} : day(input.next.due)),
          },
        }),
  };
  yield* keyed(holder, (people) =>
    Clients.logTouch(people, {
      orgId: holder.orgId,
      clientRequestId: requestIdOf(holder, "touch", request),
      ...request,
    }),
  );
  return input.client;
});

// ── Deals ────────────────────────────────────────────────────────────────────────────────────

type DealRow = Effect.Success<ReturnType<typeof Deals.deals>>["deals"][number];
const dealRow = (name: (who: KinWorkPrincipal) => string) => (one: DealRow) => ({
  key: one.key,
  title: one.title,
  client: ref(one.party),
  state: one.state,
  stage: one.stage,
  value: one.value ?? null,
  expected: one.expectedAt,
  holder: name(one.owner),
});

export const listDeals = Effect.fn("KinTasksKeyActs.listDeals")(function* (
  holder: TasksKeyHolder,
  input: {
    readonly client?: KinRecordKey | undefined;
    readonly holder?: string | undefined;
    readonly state?: "open" | "won" | "lost" | undefined;
  },
  name: (who: KinWorkPrincipal) => string,
) {
  const client = yield* reachable(holder, input.client);
  const owner = yield* named(holder, input.holder);
  const found = yield* keyed(holder, (people) =>
    Deals.deals(
      people,
      {
        orgId: holder.orgId,
        ...(client === undefined ? {} : { party: client }),
        ...(owner === undefined ? {} : { owner }),
        ...(input.state === undefined ? {} : { state: input.state }),
      },
      keyedRead,
    ),
  );
  return { deals: found.deals.map(dealRow(name)), more: found.more > 0, material: MATERIAL };
});

const oneDeal = Effect.fn("KinTasksKeyActs.oneDeal")(function* (
  holder: TasksKeyHolder,
  key: KinRecordKey,
  name: (who: KinWorkPrincipal) => string,
) {
  yield* reachKey(holder, key);
  const page = yield* keyed(holder, (people) => Deals.page(people, { orgId: holder.orgId, key }));
  return { ...dealRow(name)(page.deal), material: MATERIAL };
});

export const createDeal = Effect.fn("KinTasksKeyActs.createDeal")(function* (
  holder: TasksKeyHolder,
  input: {
    readonly client: KinRecordKey;
    readonly title: string;
    readonly stage?: string | undefined;
    readonly value?: { readonly minor: number; readonly currency: string } | undefined;
    readonly expected?: string | undefined;
    readonly notes?: string | undefined;
    readonly nextStep?: { readonly title: string; readonly due?: string | undefined } | undefined;
  },
  name: (who: KinWorkPrincipal) => string,
) {
  yield* reachKey(holder, input.client);
  const request = {
    party: input.client,
    title: input.title,
    ...(input.stage === undefined ? {} : { stage: input.stage }),
    ...(input.value === undefined ? {} : { value: input.value }),
    ...(input.expected === undefined ? {} : { expectedOn: input.expected }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(input.nextStep === undefined
      ? {}
      : {
          next: {
            title: input.nextStep.title,
            ...(input.nextStep.due === undefined ? {} : day(input.nextStep.due)),
          },
        }),
  };
  const made = yield* keyed(holder, (people) =>
    Deals.create(people, {
      orgId: holder.orgId,
      clientRequestId: requestIdOf(holder, "deal", request),
      ...request,
    }),
  );
  return yield* oneDeal(holder, made.deal.key, name);
});

export const updateDeal = Effect.fn("KinTasksKeyActs.updateDeal")(function* (
  holder: TasksKeyHolder,
  input: {
    readonly key: KinRecordKey;
    readonly title?: string | undefined;
    readonly notes?: string | undefined;
    readonly value?: { readonly minor: number; readonly currency: string } | null | undefined;
    readonly expected?: string | null | undefined;
    readonly stage?: string | undefined;
    readonly outcome?: "won" | "reopen" | undefined;
    readonly nextStep?: { readonly title: string; readonly due?: string | undefined } | undefined;
  },
  name: (who: KinWorkPrincipal) => string,
) {
  yield* reachKey(holder, input.key);
  const fields = {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(input.value === undefined ? {} : { value: input.value }),
    ...(input.expected === undefined ? {} : { expectedOn: input.expected }),
  };
  const move =
    input.outcome === "won"
      ? { _tag: "won" as const }
      : input.outcome === "reopen"
        ? { _tag: "reopen" as const }
        : input.stage === undefined
          ? undefined
          : { _tag: "stage" as const, stage: input.stage };
  if (Object.keys(fields).length === 0 && move === undefined && input.nextStep === undefined)
    return yield* nothingAsked;
  const rev = Effect.fn("KinTasksKeyActs.dealRev")(function* (
    people: ReadonlyArray<PersonIdentity>,
  ) {
    return (yield* Deals.page(people, { orgId: holder.orgId, key: input.key })).deal.rev;
  });
  yield* keyed(holder, (people) =>
    Effect.gen(function* () {
      if (Object.keys(fields).length > 0)
        yield* Deals.update(people, {
          orgId: holder.orgId,
          key: input.key,
          rev: yield* rev(people),
          ...fields,
        });
      if (move !== undefined)
        yield* Deals.move(people, {
          orgId: holder.orgId,
          key: input.key,
          rev: yield* rev(people),
          to: move,
        });
      if (input.nextStep !== undefined)
        yield* Deals.step(people, {
          orgId: holder.orgId,
          key: input.key,
          step: {
            title: input.nextStep.title,
            ...(input.nextStep.due === undefined ? {} : day(input.nextStep.due)),
          },
          clientRequestId: requestIdOf(holder, "step", { key: input.key, ...input.nextStep }),
        });
    }),
  );
  return yield* oneDeal(holder, input.key, name);
});

// ── Promises ─────────────────────────────────────────────────────────────────────────────────

/** A promise is a task on a client, ours to keep or theirs, as the client page adds one. */
export const addPromise = Effect.fn("KinTasksKeyActs.addPromise")(function* (
  holder: TasksKeyHolder,
  input: {
    readonly client: KinRecordKey;
    readonly what: string;
    readonly due?: string | undefined;
    readonly theyOwe?: boolean | undefined;
    readonly deal?: KinRecordKey | undefined;
    readonly where?: string | undefined;
  },
) {
  const { connection, people } = asPerson(holder);
  yield* reachKey(holder, input.client);
  const deal = yield* reachable(holder, input.deal);
  const request = {
    title: input.what,
    party: input.client,
    category: "obligation" as const,
    side: input.theyOwe === true ? ("theirs" as const) : ("ours" as const),
    ...(input.due === undefined ? {} : day(input.due)),
    ...(deal === undefined ? {} : { deal }),
    ...(input.where === undefined ? {} : { from: input.where }),
  };
  const made = yield* Work.create(
    people,
    { orgId: holder.orgId, clientRequestId: requestIdOf(holder, "promise", request), ...request },
    connection,
  ).pipe(workFailure);
  return yield* getMine(holder, made.key);
});

/** Only a promise: any other entry's key is not found. */
export const closePromise = Effect.fn("KinTasksKeyActs.closePromise")(function* (
  holder: TasksKeyHolder,
  key: KinRecordKey,
) {
  const sql = yield* SqlClient.SqlClient;
  const { connection, people } = asPerson(holder, "promise");
  return yield* Work.update(people, { orgId: holder.orgId, key, state: "done" }, connection).pipe(
    Effect.flatMap((sheet) => taskSheet(connection, sheet)),
    sql.withTransaction,
    workFailure,
  );
});

/** A list a key's entry tools don't reach reads as one that isn't there. */
const noSuchList = (list: string) =>
  new KinChatError({
    reason: "not_found",
    message: `There is no list ${list.slice(0, 40)} here. list_lists names the lists entries go on.`,
  });
const ownList = Effect.fn("KinTasksKeyActs.ownList")(function* (
  holder: TasksKeyHolder,
  list: string,
) {
  const def = yield* listDef(holder.orgId, list).pipe(workFailure);
  if (def === undefined || !companyList(def.id, moneyOf(def))) return yield* noSuchList(list);
});

/**
 * The record ids a key can't reach among an entry's field values (link fields name client,
 * project or entry ids): left out of what it reads, refused in what it writes.
 */
const hiddenLinks = Effect.fn("KinTasksKeyActs.hiddenLinks")(function* (
  holder: TasksKeyHolder,
  fields: Readonly<Record<string, unknown>>,
) {
  const values = Object.values(fields).flatMap((value) =>
    typeof value === "string" ? [value] : Array.isArray(value) ? value.filter(isString) : [],
  );
  return yield* keyHidden(holder.orgId, values).pipe(workFailure);
});
const withoutHidden = (
  fields: Readonly<Record<string, KinFieldValue | null>>,
  hidden: ReadonlySet<string>,
) =>
  Object.fromEntries(
    Object.entries(fields).flatMap(
      ([name, value]): ReadonlyArray<[string, KinFieldValue | null]> =>
        typeof value === "string"
          ? hidden.has(value)
            ? []
            : [[name, value]]
          : Array.isArray(value)
            ? [[name, value.filter((one) => !hidden.has(one))]]
            : [[name, value]],
    ),
  );
const refuseHiddenLinks = Effect.fn("KinTasksKeyActs.refuseHiddenLinks")(function* (
  holder: TasksKeyHolder,
  fields: Readonly<Record<string, unknown>> | undefined,
) {
  if (fields !== undefined && (yield* hiddenLinks(holder, fields)).size > 0)
    return yield* unknownKey;
});
/** A replayed create answers with the stored entry only while the key still reaches it. */
const stillReached = Effect.fn("KinTasksKeyActs.stillReached")(function* (
  holder: TasksKeyHolder,
  recordId: string,
) {
  if ((yield* keyHidden(holder.orgId, [recordId]).pipe(workFailure)).size > 0)
    return yield* unknownKey;
});

export const addLink = Effect.fn("KinTasksKeyActs.addLink")(function* (
  holder: TasksKeyHolder,
  input: Omit<KinWorkLinkAddInput, "orgId">,
) {
  return yield* keyed(holder, (people) =>
    Effect.gen(function* () {
      yield* reachKey(holder, input.key, notFound);
      const entry = yield* Work.addLink(people, { orgId: holder.orgId, ...input });
      return { key: entry.key };
    }),
  );
});

export const setProjectNote = Effect.fn("KinTasksKeyActs.setProjectNote")(function* (
  holder: TasksKeyHolder,
  input: Omit<KinProjectNoteInput, "orgId" | "clientRequestId">,
) {
  return yield* keyed(holder, (people) =>
    Effect.gen(function* () {
      yield* reachKey(holder, input.key, notFound);
      const { note } = yield* Comments.projectNote(people, {
        orgId: holder.orgId,
        ...input,
        clientRequestId: requestIdOf(holder, "project-note", input),
      });
      return { key: input.key, note: note?.body ?? null, material: MATERIAL };
    }),
  );
});

// ── Docs ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A new version of one section of a doc, as the person's Docs editor saves one: the version read
 * must still be the latest, so nobody's words are written over, and every version stays in history.
 */
export const writeDoc = Effect.fn("KinTasksKeyActs.writeDoc")(function* (
  holder: TasksKeyHolder,
  input: {
    readonly key: KinRecordKey;
    readonly version: number;
    readonly section: string;
    readonly text: string;
  },
) {
  yield* reachKey(holder, input.key);
  return yield* keyed(holder, (people) =>
    Effect.gen(function* () {
      const doc = yield* Docs.get(people, { orgId: holder.orgId, key: input.key }, keyedRead);
      if (doc.bodyKind === "file")
        return yield* new KinChatError({
          reason: "invalid_state",
          message: `${doc.key} is a file, not text, so it can't be written here. Change it in Kin.`,
        });
      if (doc.version.version !== input.version)
        return yield* new KinChatError({
          reason: "conflict",
          message: `${doc.key} changed since version ${input.version}: read it again with read_doc and write on version ${doc.version.version}.`,
        });
      const wanted = input.section
        .trim()
        .replace(/^#+\s*/, "")
        .toLowerCase();
      const outline = outlineOf(doc.body);
      const section = outline.find((one) =>
        wanted === "" ? one.id === "top" : one.title.trim().toLowerCase() === wanted,
      );
      if (section === undefined)
        return yield* new KinChatError({
          reason: "not_found",
          message: `${doc.key} has no section called ${input.section.slice(0, 80)}. Its sections: ${outline
            .map((one) => (one.id === "top" ? '"" (the text before the first heading)' : one.title))
            .join(", ")
            .slice(0, 600)}.`,
        });
      const written = yield* Docs.editSection(people, {
        orgId: holder.orgId,
        key: input.key,
        section: section.id,
        hash: section.hash,
        text: input.text,
        clientRequestId: requestIdOf(holder, "doc", input),
      });
      return { key: written.key, title: written.title, version: written.version.version };
    }),
  );
});

export const restoreDocVersion = Effect.fn("KinTasksKeyActs.restoreDocVersion")(function* (
  holder: TasksKeyHolder,
  input: Omit<KinDocRestoreInput, "orgId">,
) {
  return yield* keyed(holder, (people) =>
    Effect.gen(function* () {
      yield* reachKey(holder, input.key, docNotFound);
      const doc = yield* Docs.restore(
        people,
        { orgId: holder.orgId, ...input },
        requestIdOf(holder, "restore-doc", input),
      );
      return { key: doc.key, version: doc.version.version };
    }),
  );
});

export const restartWatch = Effect.fn("KinTasksKeyActs.restartWatch")(function* (
  holder: TasksKeyHolder,
  watchId: string,
) {
  return yield* keyed(holder, (people) =>
    Effect.gen(function* () {
      const reader = yield* watchReader(people, holder.orgId);
      const { watch } = yield* Watches.again(holder.orgId, reader, watchId);
      return { watchId: watch.watchId, state: watch.state };
    }),
  );
});

export const saveGoal = Effect.fn("KinTasksKeyActs.saveGoal")(function* (
  holder: TasksKeyHolder,
  input: Omit<KinGoalSaveInput, "orgId" | "clientRequestId" | "state"> & {
    readonly state?: "open" | "done" | undefined;
  },
) {
  return yield* keyed(holder, (people) =>
    Effect.gen(function* () {
      yield* reachable(holder, input.key);
      const goal = yield* Goals.save(people, {
        orgId: holder.orgId,
        clientRequestId: requestIdOf(holder, "save-goal", input),
        ...input,
      });
      const hidden = yield* keyHidden(holder.orgId, [goal.recordId]).pipe(workFailure);
      return { key: hidden.size > 0 ? null : goal.key, rev: hidden.size > 0 ? null : goal.rev };
    }),
  );
});

// ── Money ────────────────────────────────────────────────────────────────────────────────────

const moneyRow = (one: KinRecord) => ({
  key: one.key,
  title: one.title,
  state: one.state,
  client: ref(one.party),
  amount: one.amount ?? null,
  due: one.dueAt,
});

/** A page of one of the person's lists, as their screen lists it, without what no key carries. */
const listPage = Effect.fn("KinTasksKeyActs.listPage")(function* (
  holder: TasksKeyHolder,
  input: {
    readonly list: string;
    readonly party?: KinRecordKey | undefined;
    readonly state?: KinRecordState | undefined;
    readonly cursor?: string | undefined;
  },
) {
  const { connection, people } = asPerson(holder);
  const party = yield* reachable(holder, input.party);
  const page = yield* Work.listSeen(
    people,
    {
      orgId: holder.orgId,
      list: input.list,
      limit: ROWS,
      ...(party === undefined ? {} : { party }),
      ...(input.state === undefined ? {} : { states: [input.state] }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    },
    connection,
  ).pipe(workFailure);
  if (!("records" in page)) return yield* Effect.die("Work answered a key's list in compact rows");
  return { records: page.records, next: page.nextCursor };
});

export const listInvoices = Effect.fn("KinTasksKeyActs.listInvoices")(function* (
  holder: TasksKeyHolder,
  input: {
    readonly client?: KinRecordKey | undefined;
    readonly state?: KinRecordState | undefined;
    readonly cursor?: string | undefined;
  },
) {
  const page = yield* listPage(holder, {
    list: "invoices",
    ...(input.client === undefined ? {} : { party: input.client }),
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  });
  return {
    invoices: page.records.map(moneyRow),
    more: page.next !== null,
    next: page.next,
    material: MATERIAL,
  };
});

/**
 * Whether the key reaches the document an entry's lines are read from (`quotes.quotedInputs`):
 * its latest made document, by the docs filed under that job's origin. A labelled job or doc is
 * out of reach, and so are its lines.
 */
const documentReached = Effect.fn("KinTasksKeyActs.documentReached")(function* (
  holder: TasksKeyHolder,
  recordId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [job] = yield* sql<{ origin: string; sensitive: number }>`SELECT doc_origin AS origin,
      sensitive FROM kin_doc_jobs
    WHERE org_id = ${holder.orgId} AND entry_record_id = ${recordId} AND recipe IS NOT NULL
      AND given_json IS NOT NULL AND outcome_json IS NOT NULL
    ORDER BY created_at DESC, worker_id DESC LIMIT 1`.pipe(workFailure);
  if (job === undefined) return true;
  if (job.sensitive === 1) return false;
  const docs = yield* sql<{ id: string }>`SELECT record_id AS id FROM kin_records
    WHERE org_id = ${holder.orgId} AND register_id = 'docs'
      AND substr(origin_key, 1, ${job.origin.length + 1}) = ${`${job.origin}:`}
    ORDER BY record_id`.pipe(workFailure);
  return (
    (yield* keyHidden(
      holder.orgId,
      docs.map((doc) => doc.id),
    ).pipe(workFailure)).size === 0
  );
});

export const openInvoice = Effect.fn("KinTasksKeyActs.openInvoice")(function* (
  holder: TasksKeyHolder,
  key: KinRecordKey,
) {
  yield* reachKey(holder, key);
  return yield* keyed(holder, (people) =>
    Effect.gen(function* () {
      const entry = yield* Work.get(people, { orgId: holder.orgId, key });
      if (entry.list !== "invoices") return yield* unknownKey;
      // Its lines come from its latest document: shown only when the key reaches that doc.
      const lines = (yield* documentReached(holder, entry.recordId))
        ? (yield* MoneyAnswers.entryLines(people, { orgId: holder.orgId, key })).lines
        : null;
      return { ...moneyRow(entry), notes: entry.notes, lines, material: MATERIAL };
    }),
  );
});

export const draftInvoice = Effect.fn("KinTasksKeyActs.draftInvoice")(function* (
  holder: TasksKeyHolder,
  input: {
    readonly client: KinRecordKey;
    readonly title: string;
    readonly lines: ReadonlyArray<KinDocumentLine>;
    readonly due?: string | undefined;
    readonly notes?: string | undefined;
    readonly project?: KinRecordKey | undefined;
  },
) {
  yield* reachKey(holder, input.client);
  const project = yield* reachable(holder, input.project);
  const request = {
    client: input.client,
    title: input.title,
    lines: input.lines,
    ...(input.due === undefined ? {} : { dueOn: input.due }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(project === undefined ? {} : { project }),
  };
  const made = yield* keyed(holder, (people) =>
    MoneyAnswers.newInvoice(people, {
      orgId: holder.orgId,
      clientRequestId: requestIdOf(holder, "invoice", request),
      ...request,
    }),
  );
  const [stored] = yield* SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) => sql<{ id: string }>`SELECT record_id AS id FROM kin_records
      WHERE org_id = ${holder.orgId} AND key = ${made.invoice}`,
    ),
    workFailure,
  );
  if (stored !== undefined) yield* stillReached(holder, stored.id);
  return { key: made.invoice, problems: made.problems };
});

// ── The company's own lists ──────────────────────────────────────────────────────────────────

export const listLists = Effect.fn("KinTasksKeyActs.listLists")(function* (holder: TasksKeyHolder) {
  const found = yield* keyed(holder, (people) => Money.lists(people, { orgId: holder.orgId }));
  return {
    lists: found.lists
      .filter((one) =>
        companyList(one.list, { paidOverTime: one.payments === true, carriesAmount: one.amount }),
      )
      .map((one) => ({
        list: one.list,
        name: one.name,
        states: one.states.filter((state) => state !== "dropped"),
        categories: one.categories,
        fields: one.fields
          .filter((field) => field.retired !== true)
          .map((field) => ({
            key: field.key,
            label: field.label,
            type: field.type,
            ...(field.choices === undefined ? {} : { choices: field.choices }),
          })),
      })),
  };
});

export const listEntries = Effect.fn("KinTasksKeyActs.listEntries")(function* (
  holder: TasksKeyHolder,
  input: {
    readonly list: string;
    readonly state?: KinRecordState | undefined;
    readonly cursor?: string | undefined;
  },
) {
  yield* ownList(holder, input.list);
  const page = yield* listPage(holder, input);
  const hidden = yield* hiddenLinks(
    holder,
    Object.assign({}, ...page.records.map((one) => one.fields ?? {})),
  );
  return {
    entries: page.records.map((one) => ({
      ...moneyRow(one),
      fields: withoutHidden(one.fields ?? {}, hidden),
    })),
    more: page.next !== null,
    next: page.next,
    material: MATERIAL,
  };
});

type FieldValues = Readonly<Record<string, KinFieldValue | null>>;
export const addEntry = Effect.fn("KinTasksKeyActs.addEntry")(function* (
  holder: TasksKeyHolder,
  input: {
    readonly list: string;
    readonly title: string;
    readonly fields?: FieldValues | undefined;
  },
) {
  yield* ownList(holder, input.list);
  yield* refuseHiddenLinks(holder, input.fields);
  const { connection, people } = asPerson(holder, "entry");
  const request = {
    list: input.list,
    title: input.title,
    ...(input.fields === undefined ? {} : { fields: input.fields }),
  };
  const made = yield* Work.create(
    people,
    { orgId: holder.orgId, clientRequestId: requestIdOf(holder, "entry", request), ...request },
    connection,
  ).pipe(
    workFailure,
    // The app's own check, worded for a list that takes no entries by hand.
    Effect.mapError((error) =>
      error.reason === "invalid_state" && error.message.startsWith('Expected "milestones"')
        ? new KinChatError({
            reason: "not_allowed",
            message: `Entries are added by hand only to a list shared with the team, and ${input.list.slice(0, 60)} isn't. Ask an agent with ask_agent, or the person adds it in Kin.`,
          })
        : error,
    ),
  );
  yield* stillReached(holder, made.recordId);
  return { key: made.key, title: made.title, state: made.state, fields: made.fields ?? {} };
});

export const updateEntry = Effect.fn("KinTasksKeyActs.updateEntry")(function* (
  holder: TasksKeyHolder,
  input: {
    readonly key: KinRecordKey;
    readonly title?: string | undefined;
    readonly state?: Exclude<KinRecordState, "dropped"> | undefined;
    readonly fields?: FieldValues | undefined;
  },
) {
  const { connection, people } = asPerson(holder, "entry");
  const { key, ...patch } = input;
  if (Object.values(patch).every((value) => value === undefined)) return yield* nothingAsked;
  yield* refuseHiddenLinks(holder, input.fields);
  const changed = yield* Work.update(
    people,
    { orgId: holder.orgId, key, ...patch },
    connection,
  ).pipe(workFailure);
  return {
    key: changed.key,
    title: changed.title,
    state: changed.state,
    fields: withoutHidden(changed.fields ?? {}, yield* hiddenLinks(holder, changed.fields ?? {})),
  };
});

// ── Numbers ──────────────────────────────────────────────────────────────────────────────────

/**
 * The numbers Kin works out from its own records (`kind` computed): figures over entries a key may
 * not reach, so a key reads their names only.
 */
const computedNumbers = Effect.fn("KinTasksKeyActs.computedNumbers")(function* (
  holder: TasksKeyHolder,
  keys: ReadonlyArray<string>,
) {
  if (keys.length === 0) return new Set<string>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ key: string; fields: string }>`SELECT key, fields_json AS fields
    FROM kin_records WHERE org_id = ${holder.orgId} AND register_id = 'goals'
      AND key IN ${sql.in(keys)}
    ORDER BY key`.pipe(workFailure);
  return new Set(
    rows
      .filter((row) => numberFields(parseFields(row.fields))?.kind === "computed")
      .map((row) => row.key),
  );
});

export const readNumbers = Effect.fn("KinTasksKeyActs.readNumbers")(function* (
  holder: TasksKeyHolder,
  input: {
    readonly number?: KinRecordKey | undefined;
    readonly from?: string | undefined;
    readonly to?: string | undefined;
  },
) {
  const numbers = yield* KinNumbers;
  const me = personOf(holder);
  if (input.number === undefined) {
    const listed = yield* keyed(holder, () => numbers.list(me));
    const computed = yield* computedNumbers(
      holder,
      listed.numbers.map((one) => one.key),
    );
    return {
      numbers: listed.numbers.map((one) =>
        computed.has(one.key)
          ? {
              key: one.key,
              name: one.name,
              unit: one.unit ?? null,
              computed: true,
              value: null,
              asOf: null,
              late: false,
              canRecord: false,
            }
          : {
              key: one.key,
              name: one.name,
              unit: one.unit ?? null,
              computed: false,
              value: one.value,
              asOf: one.asOf,
              late: one.stale,
              canRecord: one.canType,
            },
      ),
      values: null,
    };
  }
  const number = input.number;
  if ((yield* computedNumbers(holder, [number])).size > 0)
    return yield* new KinChatError({
      reason: "not_allowed",
      message: `${number} is a number Kin works out from its own records: read it in Kin.`,
    });
  const read = yield* keyed(holder, () =>
    numbers.values(me, number, input.from ?? "0001-01-01", input.to ?? "9999-12-31"),
  );
  return {
    numbers: null,
    values: read.values.map((one) => ({ value: one.value, asOf: one.asOf, by: one.by.name })),
  };
});

export const recordNumber = Effect.fn("KinTasksKeyActs.recordNumber")(function* (
  holder: TasksKeyHolder,
  input: { readonly number: KinRecordKey; readonly value: string; readonly day: string },
) {
  const numbers = yield* KinNumbers;
  // The same value however it is spelt ("9", "9.0") is the same request.
  const value = { number: input.number, value: normalizeDecimal(input.value), asOf: input.day };
  const done = yield* keyed(holder, () =>
    numbers.record(personOf(holder), [value], requestIdOf(holder, "number", value)),
  );
  return { number: input.number, recorded: done.recorded > 0 };
});

// ── What waits on the person ─────────────────────────────────────────────────────────────────

/** A record key as text names one (INV-4, W-12). */
const KEY_WORDS = /\b[A-Z][A-Z0-9]{0,7}-[1-9]\d{0,8}\b/g;
type WaitingRow = {
  readonly what: "task" | "card" | "news";
  readonly key: string | null;
  readonly text: string;
  readonly late: boolean;
  readonly answer: string | null;
};
const IN_KIN = "The person answers it in Kin; no tool here answers a card.";
const ON_A_TASK = "A task: get_task, update_task and set_task_state work on it by its key.";
/**
 * Needs you's rows as a key reads them: none about an entry it can't reach (`withheld`, and each
 * card's subject in `about`), and no money aggregate, which is money_summary's.
 */
export const waitingRows = (
  rows: ReadonlyArray<KinOpenRow>,
  withheld: ReadonlySet<string>,
  about: ReadonlyMap<string, ReadonlyArray<string>>,
) =>
  rows.flatMap((row): ReadonlyArray<WaitingRow> => {
    const { item } = row;
    const key =
      item._tag === "task"
        ? item.key
        : item._tag === "fact" && item.fact.subject.kind === "record"
          ? item.fact.subject.key
          : null;
    if (key !== null && withheld.has(key)) return [];
    if (item._tag === "task")
      return [{ what: "task", key, text: item.title, late: row.late, answer: ON_A_TASK }];
    if (item._tag === "waiting")
      return (about.get(item.waiting.waitingId) ?? []).some((one) => withheld.has(one))
        ? []
        : [
            {
              what: "card",
              key: null,
              text: item.waiting.question ?? "A card waits for the person's answer.",
              late: row.late,
              answer: IN_KIN,
            },
          ];
    // Overdue money is money_summary's, which leaves out what a key never carries.
    if (item._tag === "money") return [];
    return [
      {
        what: "news",
        key,
        text: item.fact.subject.title,
        late: row.late,
        answer: null,
      },
    ];
  });

export const listWaiting = Effect.fn("KinTasksKeyActs.listWaiting")(function* (
  holder: TasksKeyHolder,
) {
  const sql = yield* SqlClient.SqlClient;
  const open = yield* keyed(holder, (people) =>
    Open.read(people, { orgId: holder.orgId, acceptSenses: undefined }),
  );
  // A card's subject: the entries its question is about, and any key its words name.
  const cards = open.rows.flatMap((row) => (row.item._tag === "waiting" ? [row.item.waiting] : []));
  const about = new Map<string, ReadonlyArray<string>>();
  for (const card of cards) {
    const [asked] =
      card.widgetId === null
        ? []
        : yield* sql<{ about: string }>`SELECT about FROM kin_questions
            WHERE org_id = ${holder.orgId}
              AND (widget_id = ${card.widgetId} OR raise_widget_id = ${card.widgetId})
            ORDER BY question_id LIMIT 1`.pipe(workFailure);
    about.set(card.waitingId, [
      ...(asked === undefined || asked.about === "" ? [] : asked.about.split(" ")),
      ...((card.question ?? "").match(KEY_WORDS) ?? []),
    ]);
  }
  const keys = [
    ...open.rows.flatMap((row) =>
      row.item._tag === "task"
        ? [row.item.key]
        : row.item._tag === "fact" && row.item.fact.subject.kind === "record"
          ? [row.item.fact.subject.key]
          : [],
    ),
    ...[...about.values()].flat(),
  ];
  const found =
    keys.length === 0
      ? []
      : yield* sql<{ key: string; id: string }>`SELECT key, record_id AS id FROM kin_records
          WHERE org_id = ${holder.orgId} AND key IN ${sql.in(keys)} ORDER BY key`.pipe(workFailure);
  const hidden = yield* keyHidden(
    holder.orgId,
    found.map((row) => row.id),
  ).pipe(workFailure);
  const withheld = new Set(found.filter((row) => hidden.has(row.id)).map((row) => row.key));
  return { waiting: waitingRows(open.rows, withheld, about), material: MATERIAL };
});
