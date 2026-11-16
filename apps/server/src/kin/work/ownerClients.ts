import {
  type KinContactCreateInput,
  type KinContactUpdateInput,
  type KinOrgId,
  type KinPartiesInput,
  type KinPartyCreateInput,
  type KinPartyPageInput,
  type KinPartyUpdateInput,
  type KinProjectCreateInput,
  type KinProjectPageInput,
  type KinProjectsInput,
  type KinProjectUpdateInput,
  type KinTouchLogInput,
  type KinTouchRemoveInput,
  type KinWorkHistoryInput,
  type KinWorkPrincipal,
  type KinPartyPage,
  type KinPartyRow,
  type KinPersonId,
  KinChatError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError, type SqlError } from "effect/sql/SqlError";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import * as Crm from "./crm.ts";
import { KinRecords, requestHashOf, type Patch } from "./KinRecords.ts";
import { type FieldValue, type ListName } from "./lists.ts";
import { dueMillis, found, inList, ownerWriter, theOwner, viewerOf } from "./ownerWork.ts";
import { principalText } from "./projectSpine.ts";
import { iso, notFound, type RecordRow, unavailable } from "./recordRows.ts";
import { inProject, personSeesAs, placesOf, teamSeq, teamVisible } from "./teamView.ts";
import * as Touches from "./touches.ts";

/**
 * The light CRM's pages and edits. The owner and co-owners read and edit everything; anyone else
 * reads, by `personSees`, the clients their Clients place shows and the projects they lead, and
 * edits none of it here. Every write goes through `KinRecords`, revision-checked and logged.
 */

/** The read model's SQL failures reach a client as Work being unavailable, logged here. */
const read = <A, E, R>(effect: Effect.Effect<A, E | SqlError, R>) =>
  effect.pipe(
    Effect.catchIf(isSqlError, (cause) =>
      Effect.logWarning("Kin Work read failed", { message: cause.message }).pipe(
        Effect.andThen(Effect.fail(unavailable)),
      ),
    ),
  );

const asOf = Effect.fn("KinWork.crm.asOf")(function* (
  orgId: KinOrgId,
  team?: KinPersonId | undefined,
) {
  const records = yield* KinRecords;
  return {
    now: yield* Clock.currentTimeMillis,
    seq: team === undefined ? yield* records.seq(orgId) : yield* read(teamSeq(orgId, team)),
  };
});

const noClients = new KinChatError({
  reason: "not_allowed",
  message: "Only the owner or a co-owner can open Clients for you.",
});
/** The caller; for anyone besides the owner, only with a Clients place or a project they lead. */
const reader = Effect.fn("KinWork.crm.reader")(function* (
  people: ReadonlyArray<PersonIdentity>,
  orgId: KinOrgId,
) {
  const viewer = yield* viewerOf(people, orgId);
  if (!viewer.teammate) return undefined;
  const places = yield* read(placesOf(orgId, viewer.person.personId));
  if (!places.reaches.clients) return yield* noClients;
  return viewer.person.personId;
});
/**
 * A client row as anyone besides the owner reads it: who they are, not what is owed. The contact
 * log is the owner's, so the row carries no word on it rather than "none logged".
 */
const nameOnly = <A extends KinPartyRow>({ lastContactAt: _, ...row }: A): A =>
  ({ ...row, weOwe: 0, theyOwe: 0, late: 0, overdue: 0, next: null }) as A;
const unseen = Effect.fn("KinWork.crm.unseen")(function* (
  team: KinPersonId | undefined,
  row: RecordRow,
  input: { readonly key: string } | { readonly recordId: string },
) {
  if (team === undefined) return;
  const seen = yield* read(teamVisible(row.orgId as KinOrgId, team, [row.recordId]));
  if (!seen.has(row.recordId)) return yield* notFound("key" in input ? input.key : "with that id");
});

const opened = Effect.fn("KinWork.crm.opened")(function* (
  input: { readonly orgId: KinOrgId } & ({ readonly key: string } | { readonly recordId: string }),
  list: ListName,
) {
  return yield* inList(input.orgId, (yield* found(input.orgId, input)).key, list);
});

export const parties = Effect.fn("KinWork.parties")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinPartiesInput,
) {
  const team = yield* reader(people, input.orgId);
  const { now, seq } = yield* asOf(input.orgId, team);
  const sql = yield* SqlClient.SqlClient;
  const sees = team === undefined ? undefined : personSeesAs(sql, team, "c");
  const page = yield* read(Crm.parties(input.orgId, now, input, sees));
  return {
    parties: team === undefined ? page.rows : page.rows.map(nameOnly),
    total: page.total,
    nextCursor: page.nextCursor,
    seq,
    asOf: iso(now),
  };
});

export const projects = Effect.fn("KinWork.projects")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinProjectsInput,
) {
  const team = yield* reader(people, input.orgId);
  const { now, seq } = yield* asOf(input.orgId, team);
  const party =
    input.party === undefined
      ? undefined
      : yield* inList(input.orgId, input.party, "clients").pipe(
          Effect.tap((row) => unseen(team, row, { key: row.key })),
          // A client they can't see answers as one never there, whatever it is.
          Effect.mapError((error) =>
            team === undefined || input.party === undefined ? error : notFound(input.party),
          ),
        );
  const sql = yield* SqlClient.SqlClient;
  const sees =
    team === undefined
      ? undefined
      : { projects: personSeesAs(sql, team, "p"), viewers: [team] as const };
  const page = yield* read(
    Crm.projects(input.orgId, now, { ...input, partyId: party?.recordId }, sees),
  );
  return {
    projects: page.rows,
    total: page.total,
    nextCursor: page.nextCursor,
    seq,
    asOf: iso(now),
  };
});

export const party = Effect.fn("KinWork.party")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinPartyPageInput,
) {
  const team = yield* reader(people, input.orgId);
  const row = yield* opened(input, "clients");
  yield* unseen(team, row, input);
  const { now, seq } = yield* asOf(input.orgId, team);
  const page = yield* read(Crm.partyPage(row, now, seq, team === undefined ? undefined : [team]));
  if (team === undefined) return page;
  // Its name, contacts and the projects they lead; never terms, tax, notes, contact log or what's owed.
  const shown = yield* read(
    teamVisible(input.orgId, team, [
      ...page.contacts.map((one) => one.recordId),
      ...page.projects.map((one) => one.recordId),
    ]),
  );
  const none = { records: [], total: 0 };
  // With the Clients place they reach the people there; leading a project alone gives their names.
  const reached = (yield* read(placesOf(input.orgId, team))).clients;
  return {
    ...page,
    party: {
      ...nameOnly(page.party),
      notes: "",
      terms: null,
      address: null,
      gstin: null,
      placeOfSupply: null,
    },
    contacts: page.contacts
      .filter((one) => shown.has(one.recordId))
      .map((one) => (reached ? one : { ...one, email: null, phone: null })),
    projects: page.projects.filter((one) => shown.has(one.recordId)),
    weOwe: none,
    theyOwe: none,
    // The contact log carries the owner's notes on the relationship.
    ...(page.touches === undefined ? {} : { touches: [] }),
  } satisfies KinPartyPage;
});

export const project = Effect.fn("KinWork.project")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinProjectPageInput,
) {
  const viewer = yield* viewerOf(people, input.orgId);
  const team = viewer.teammate ? viewer.person.personId : undefined;
  const row = yield* opened(input, "projects");
  // Anyone in it opens it, Clients place or not, and in it sees only what `personSees` shows them.
  if (team !== undefined && !(yield* read(inProject(input.orgId, team, row.recordId)))) {
    yield* reader(people, input.orgId);
    yield* unseen(team, row, input);
  }
  const { now, seq } = yield* asOf(input.orgId, team);
  return yield* read(Crm.projectPage(row, now, seq, team === undefined ? undefined : [team]));
});

/** `s:<seq>`: the next page is everything older than the last line shown. */
const beforeOf = (cursor: string | undefined) => {
  if (cursor === undefined) return Effect.succeed(null);
  const found = /^s:(\d{1,15})$/.exec(cursor);
  return found === null
    ? Effect.fail(
        new KinChatError({ reason: "invalid_state", message: "That page cursor is stale." }),
      )
    : Effect.succeed(Number.parseInt(found[1]!, 10));
};

export const history = Effect.fn("KinWork.history")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkHistoryInput,
) {
  yield* theOwner(people, input.orgId);
  const row = yield* found(input.orgId, input);
  if (row.registerId !== "clients" && row.registerId !== "projects")
    return yield* new KinChatError({
      reason: "invalid_state",
      message: `${row.key} is not a client or a project; its own changes are on the entry.`,
    });
  const before = yield* beforeOf(input.cursor);
  const limit = input.limit ?? 50;
  const { items } = yield* read(
    Crm.history(row, {
      ...(before === null ? {} : { beforeSeq: before }),
      limit: limit + 1,
    }),
  );
  const page = items.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page,
    nextCursor: items.length > limit && last !== undefined ? `s:${last.seq}` : null,
    seq: (yield* asOf(input.orgId)).seq,
  };
});

const me = (person: PersonIdentity): KinWorkPrincipal => ({
  _tag: "person",
  personId: person.personId,
});
const defined = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
const fieldsOf = (value: Readonly<Record<string, FieldValue | null | undefined>>) =>
  defined(value) as Readonly<Record<string, FieldValue | null>>;
/** The client fields an invoice reads, under the keys the documents read them by. */
const partyFields = (input: KinPartyCreateInput | KinPartyUpdateInput) => ({
  terms: input.terms,
  address: input.address,
  gstin: input.gstin,
  placeOfSupply: input.placeOfSupply,
});
const activeState = (active: boolean | undefined) =>
  active === undefined ? {} : { state: active ? ("open" as const) : ("dropped" as const) };

const saved = Effect.fn("KinWork.crm.saved")(function* (
  person: PersonIdentity,
  orgId: KinOrgId,
  key: string,
  list: ListName,
  patch: Patch,
  rev: number,
) {
  yield* inList(orgId, key, list);
  const records = yield* KinRecords;
  return yield* records.update(orgId, ownerWriter(person), key, patch, rev);
});
const createIn = Effect.fn("KinWork.crm.create")(function* (
  person: PersonIdentity,
  orgId: KinOrgId,
  list: ListName,
  request: { readonly clientRequestId: string },
  input: Omit<Parameters<KinRecords["Service"]["create"]>[2], "originKey" | "list">,
) {
  const records = yield* KinRecords;
  const { row } = yield* records.create(orgId, ownerWriter(person), {
    ...input,
    list,
    originKey: `owner:${list}:${request.clientRequestId}`,
    requestHash: requestHashOf(request),
  });
  return row;
});
const partyOut = (row: RecordRow) =>
  read(Effect.flatMap(Clock.currentTimeMillis, (now) => Crm.partyDetail(row, now)));
const projectOut = (row: RecordRow) =>
  read(Effect.flatMap(Clock.currentTimeMillis, (now) => Crm.projectDetail(row, now)));

export const createParty = Effect.fn("KinWork.createParty")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinPartyCreateInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const row = yield* createIn(person, input.orgId, "clients", input, {
    title: input.name,
    owner: input.owner ?? me(person),
    category: input.kind ?? "client",
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(input.sensitive === undefined ? {} : { sensitive: input.sensitive }),
    fields: fieldsOf(partyFields(input)),
  });
  return yield* partyOut(row);
});

export const updateParty = Effect.fn("KinWork.updateParty")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinPartyUpdateInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const row = yield* saved(
    person,
    input.orgId,
    input.key,
    "clients",
    {
      ...defined({
        title: input.name,
        category: input.kind,
        owner: input.owner,
        notes: input.notes,
        sensitive: input.sensitive,
      }),
      ...activeState(input.active),
      ...(Object.keys(defined(partyFields(input))).length === 0
        ? {}
        : { fields: fieldsOf(partyFields(input)) }),
    },
    input.rev,
  );
  return yield* partyOut(row);
});

export const createContact = Effect.fn("KinWork.createContact")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinContactCreateInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const party = yield* inList(input.orgId, input.party, "clients");
  const row = yield* createIn(person, input.orgId, "contacts", input, {
    title: input.name,
    owner: me(person),
    partyId: party.recordId,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(input.sensitive === undefined ? {} : { sensitive: input.sensitive }),
    fields: fieldsOf({ role: input.role, email: input.email, phone: input.phone }),
  });
  return Crm.toContact(row);
});

export const updateContact = Effect.fn("KinWork.updateContact")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinContactUpdateInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const partyId =
    input.party === undefined
      ? undefined
      : (yield* inList(input.orgId, input.party, "clients")).recordId;
  const fields = fieldsOf({ role: input.role, email: input.email, phone: input.phone });
  const row = yield* saved(
    person,
    input.orgId,
    input.key,
    "contacts",
    {
      ...defined({ title: input.name, notes: input.notes, sensitive: input.sensitive, partyId }),
      ...activeState(input.active),
      ...(Object.keys(fields).length === 0 ? {} : { fields }),
    },
    input.rev,
  );
  return Crm.toContact(row);
});

const targetOf = Effect.fn("KinWork.crm.target")(function* (
  orgId: KinOrgId,
  targetAt: string | null | undefined,
  allDay: boolean | undefined,
) {
  if (targetAt === undefined) return allDay === undefined ? {} : { dueAllDay: allDay };
  if (targetAt === null) return { dueAt: null, dueAllDay: false };
  return { dueAt: yield* dueMillis(orgId, targetAt, allDay), dueAllDay: allDay === true };
});

/** Billing, value, days and members, as the projects list stores them; `null` clears one. */
const spineFields = (input: KinProjectCreateInput | KinProjectUpdateInput) => ({
  billing: input.billing,
  value: input.value,
  startsOn: input.startsOn,
  renewsOn: input.renewsOn,
  members: input.members?.map(principalText),
});

export const createProject = Effect.fn("KinWork.createProject")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinProjectCreateInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const partyId =
    input.party === undefined
      ? undefined
      : (yield* inList(input.orgId, input.party, "clients")).recordId;
  const row = yield* createIn(person, input.orgId, "projects", input, {
    title: input.name,
    owner: input.owner ?? me(person),
    ...(partyId === undefined ? {} : { partyId }),
    ...(yield* targetOf(input.orgId, input.targetAt, input.targetAllDay)),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(input.sensitive === undefined ? {} : { sensitive: input.sensitive }),
    fields: fieldsOf({ repos: input.repos, ...spineFields(input) }),
  });
  return yield* projectOut(row);
});

export const updateProject = Effect.fn("KinWork.updateProject")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinProjectUpdateInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const partyId =
    input.party === undefined
      ? undefined
      : input.party === null
        ? null
        : (yield* inList(input.orgId, input.party, "clients")).recordId;
  const row = yield* saved(
    person,
    input.orgId,
    input.key,
    "projects",
    {
      ...defined({
        title: input.name,
        owner: input.owner,
        notes: input.notes,
        sensitive: input.sensitive,
        state: input.state,
        partyId,
      }),
      ...(yield* targetOf(input.orgId, input.targetAt, input.targetAllDay)),
      fields: fieldsOf({ repos: input.repos, ...spineFields(input) }),
    },
    input.rev,
  );
  return yield* projectOut(row);
});

/** The owner logs contact by hand; open client pages read again when it commits. */
export const logTouch = Effect.fn("KinWork.logTouch")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinTouchLogInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const party = yield* inList(input.orgId, input.party, "clients");
  const now = yield* Clock.currentTimeMillis;
  const at = input.at === undefined ? now : Date.parse(input.at);
  const touch = yield* read(
    Touches.logTouch(input.orgId, {
      partyId: party.recordId,
      kind: input.kind,
      at,
      note: input.note ?? "",
      personId: person.personId,
      by: { kind: "person", id: person.personId },
      originKey: `owner:touch:${input.clientRequestId}`,
      now,
    }),
  );
  yield* (yield* KinRecords).announce(input.orgId);
  return touch;
});

export const removeTouch = Effect.fn("KinWork.removeTouch")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinTouchRemoveInput,
) {
  yield* theOwner(people, input.orgId);
  const now = yield* Clock.currentTimeMillis;
  const removed = yield* read(Touches.removeTouch(input.orgId, input.touchId, now));
  if (removed) yield* (yield* KinRecords).announce(input.orgId);
  return { removed };
});
