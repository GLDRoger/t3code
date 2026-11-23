import {
  KinChatError,
  type KinDocumentLine,
  type KinFieldValue,
  type KinRecord,
  type KinRecordKey,
  type KinRecordState,
  type KinSignedMoney,
  type KinTouchKind,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { KinNumbers } from "../numbers/KinNumbers.ts";
import * as Open from "../open/people.ts";
import { keyHidden } from "../work/codingAgent.ts";
import { outlineOf } from "../work/docBody.ts";
import * as Deals from "../work/deals.ts";
import * as Clients from "../work/ownerClients.ts";
import * as Docs from "../work/ownerDocs.ts";
import * as Money from "../work/ownerMoney.ts";
import * as MoneyAnswers from "../work/ownerMoneyAnswers.ts";
import * as Work from "../work/ownerWork.ts";
import { workFailure } from "../work/recordRows.ts";
import { MATERIAL } from "../you/projection.ts";
import { whoNamed } from "./people.ts";
import { unknownKey } from "./reads.ts";
import {
  asPerson,
  getMine,
  keyed,
  reachable,
  reachKey,
  requestIdOf,
  setStateMine,
} from "./tasks.ts";
import type { TasksKeyHolder } from "./TasksKeys.ts";

/**
 * What a person does by hand beyond their tasks, through their coding agent's key: each through
 * the method their own screen calls, as them (`keyed`), refused as their screen refuses them.
 */

const ROWS = 50;
const keyedRead = { keyed: true } as const;
const ref = (one: { readonly key: string; readonly title: string } | null | undefined) =>
  one === null || one === undefined ? null : { key: one.key, title: one.title };
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
    readonly outcome?: "won" | "lost" | "reopen" | undefined;
    readonly lostReason?: string | undefined;
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
    input.outcome === "lost"
      ? { _tag: "lost" as const, reason: input.lostReason ?? "" }
      : input.outcome === "won"
        ? { _tag: "won" as const }
        : input.outcome === "reopen"
          ? { _tag: "reopen" as const }
          : input.stage === undefined
            ? undefined
            : { _tag: "stage" as const, stage: input.stage };
  if (move?._tag === "lost" && move.reason.trim() === "")
    return yield* new KinChatError({
      reason: "invalid_state",
      message: "A lost deal needs lostReason: one line on why.",
    });
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

export const closePromise = (holder: TasksKeyHolder, key: KinRecordKey) =>
  setStateMine(holder, { key, state: "done" });

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

export const openInvoice = Effect.fn("KinTasksKeyActs.openInvoice")(function* (
  holder: TasksKeyHolder,
  key: KinRecordKey,
) {
  yield* reachKey(holder, key);
  return yield* keyed(holder, (people) =>
    Effect.gen(function* () {
      const entry = yield* Work.get(people, { orgId: holder.orgId, key });
      if (entry.list !== "invoices") return yield* unknownKey;
      const { lines } = yield* MoneyAnswers.entryLines(people, { orgId: holder.orgId, key });
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
  return { key: made.invoice, problems: made.problems };
});

export const recordExpense = Effect.fn("KinTasksKeyActs.recordExpense")(function* (
  holder: TasksKeyHolder,
  input: {
    readonly title: string;
    readonly amount: KinSignedMoney;
    readonly day: string;
    readonly vendor?: string | undefined;
    readonly category?: string | undefined;
  },
) {
  const request = {
    title: input.title,
    amount: input.amount,
    paidOn: input.day,
    ...(input.vendor === undefined ? {} : { vendor: input.vendor }),
    ...(input.category === undefined ? {} : { category: input.category }),
  };
  const made = yield* keyed(holder, (people) =>
    MoneyAnswers.newExpense(people, {
      orgId: holder.orgId,
      clientRequestId: requestIdOf(holder, "expense", request),
      ...request,
    }),
  );
  return { key: made.expense };
});

// ── The company's own lists ──────────────────────────────────────────────────────────────────

export const listLists = Effect.fn("KinTasksKeyActs.listLists")(function* (holder: TasksKeyHolder) {
  const found = yield* keyed(holder, (people) => Money.lists(people, { orgId: holder.orgId }));
  return {
    lists: found.lists
      .filter((one) => !one.builtIn)
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
  const page = yield* listPage(holder, input);
  return {
    entries: page.records.map((one) => ({
      ...moneyRow(one),
      fields: one.fields ?? {},
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
  const { connection, people } = asPerson(holder);
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
  const { connection, people } = asPerson(holder);
  const { key, ...patch } = input;
  if (Object.values(patch).every((value) => value === undefined)) return yield* nothingAsked;
  const changed = yield* Work.update(
    people,
    { orgId: holder.orgId, key, ...patch },
    connection,
  ).pipe(workFailure);
  return {
    key: changed.key,
    title: changed.title,
    state: changed.state,
    fields: changed.fields ?? {},
  };
});

// ── Numbers ──────────────────────────────────────────────────────────────────────────────────

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
    return {
      numbers: listed.numbers.map((one) => ({
        key: one.key,
        name: one.name,
        unit: one.unit ?? null,
        value: one.value,
        asOf: one.asOf,
        late: one.stale,
        canRecord: one.canType,
      })),
      values: null,
    };
  }
  const number = input.number;
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
  const value = { number: input.number, value: input.value, asOf: input.day };
  const done = yield* keyed(holder, () =>
    numbers.record(personOf(holder), [value], requestIdOf(holder, "number", value)),
  );
  return { number: input.number, recorded: done.recorded > 0 };
});

// ── What waits on the person ─────────────────────────────────────────────────────────────────

type WaitingRow = {
  readonly what: "task" | "card" | "money" | "news";
  readonly key: string | null;
  readonly text: string;
  readonly late: boolean;
  readonly answer: string | null;
};
const IN_KIN = "The person answers it in Kin; no tool here answers a card.";
const ON_A_TASK = "A task: get_task, update_task and set_task_state work on it by its key.";
export const listWaiting = Effect.fn("KinTasksKeyActs.listWaiting")(function* (
  holder: TasksKeyHolder,
) {
  const sql = yield* SqlClient.SqlClient;
  const open = yield* keyed(holder, (people) =>
    Open.read(people, { orgId: holder.orgId, acceptSenses: undefined }),
  );
  const keys = open.rows.flatMap((row) =>
    row.item._tag === "task"
      ? [row.item.key]
      : row.item._tag === "fact" && row.item.fact.subject.kind === "record"
        ? [row.item.fact.subject.key]
        : [],
  );
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
  return {
    waiting: open.rows.flatMap((row): ReadonlyArray<WaitingRow> => {
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
        return [
          {
            what: "card",
            key: null,
            text: item.waiting.question ?? "A card waits for the person's answer.",
            late: row.late,
            answer: IN_KIN,
          },
        ];
      if (item._tag === "money")
        return [
          {
            what: "money",
            key: null,
            text: `${item.invoices} overdue ${item.invoices === 1 ? "invoice" : "invoices"}`,
            late: row.late,
            answer: null,
          },
        ];
      return [
        {
          what: "news",
          key,
          text: item.fact.subject.title,
          late: row.late,
          answer: null,
        },
      ];
    }),
    material: MATERIAL,
  };
});
