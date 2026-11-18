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
  type KinProjectPeopleInput,
  type KinProjectsInput,
  type KinProjectUpdateInput,
  type KinTouchLogInput,
  type KinTouchRemoveInput,
  type KinWorkHistoryInput,
  type KinWorkPrincipal,
  type KinPartyPage,
  type KinPartyRow,
  KinChatError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError, type SqlError } from "effect/sql/SqlError";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import * as Crm from "./crm.ts";
import { KinRecords, requestHashOf, type Patch } from "./KinRecords.ts";
import { fieldList, parseFields, type FieldValue, type ListName } from "./lists.ts";
import {
  asViewer,
  dueMillis,
  found,
  inList,
  ownerWriter,
  tellMoved,
  theOwner,
  viewerOf,
  writerOf,
} from "./ownerWork.ts";
import { principalOfText, principalText } from "./projectSpine.ts";
import { projectNoteOf } from "./recordComments.ts";
import { iso, notFound, type RecordRow, unavailable } from "./recordRows.ts";
import {
  KIN_OWNER_LEVEL,
  inProject,
  placesOf,
  teamSeq,
  teamVisible,
  viewerOfPeople,
  type KinViewer,
} from "./teamView.ts";
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

const asOf = Effect.fn("KinWork.crm.asOf")(function* (orgId: KinOrgId, viewer: KinViewer) {
  const records = yield* KinRecords;
  const [team] = viewer._tag === "people" ? viewer.people : [];
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
  if (!viewer.teammate) return KIN_OWNER_LEVEL;
  const places = yield* read(placesOf(orgId, viewer.person.personId));
  if (!places.reaches.clients) return yield* noClients;
  return viewerOfPeople([viewer.person.personId]);
});
/**
 * A client row as anyone besides the owner reads it: who they are, not what is owed. The contact
 * log is the owner's, so the row carries no word on it rather than "none logged".
 */
const nameOnly = <A extends KinPartyRow>({ lastContactAt: _, ...row }: A): A =>
  ({ ...row, weOwe: 0, theyOwe: 0, late: 0, overdue: 0, next: null }) as A;
const unseen = Effect.fn("KinWork.crm.unseen")(function* (
  viewer: KinViewer,
  row: RecordRow,
  input: { readonly key: string } | { readonly recordId: string },
) {
  if (viewer._tag === "ownerLevel") return;
  for (const team of viewer.people) {
    const seen = yield* read(teamVisible(row.orgId as KinOrgId, team, [row.recordId]));
    if (!seen.has(row.recordId))
      return yield* notFound("key" in input ? input.key : "with that id");
  }
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
  const viewer = yield* reader(people, input.orgId);
  const { now, seq } = yield* asOf(input.orgId, viewer);
  const page = yield* read(Crm.parties(input.orgId, now, input, viewer));
  return {
    parties: viewer._tag === "ownerLevel" ? page.rows : page.rows.map(nameOnly),
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
  const viewer = yield* reader(people, input.orgId);
  const { now, seq } = yield* asOf(input.orgId, viewer);
  const party =
    input.party === undefined
      ? undefined
      : yield* inList(input.orgId, input.party, "clients").pipe(
          Effect.tap((row) => unseen(viewer, row, { key: row.key })),
          // A client they can't see answers as one never there, whatever it is.
          Effect.mapError((error) =>
            viewer._tag === "ownerLevel" || input.party === undefined
              ? error
              : notFound(input.party),
          ),
        );
  const page = yield* read(
    Crm.projects(input.orgId, now, { ...input, partyId: party?.recordId }, viewer),
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
  const viewer = yield* reader(people, input.orgId);
  const row = yield* opened(input, "clients");
  yield* unseen(viewer, row, input);
  const { now, seq } = yield* asOf(input.orgId, viewer);
  const page = yield* read(Crm.partyPage(row, now, seq, viewer));
  if (viewer._tag === "ownerLevel") return page;
  const [team] = viewer.people;
  if (team === undefined) return yield* noClients;
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
  const person = yield* viewerOf(people, input.orgId);
  const viewer = person.teammate ? viewerOfPeople([person.person.personId]) : KIN_OWNER_LEVEL;
  const row = yield* opened(input, "projects");
  // Anyone in it opens it, Clients place or not, and in it sees only what `personSees` shows them.
  if (
    person.teammate &&
    !(yield* read(inProject(input.orgId, person.person.personId, row.recordId)))
  ) {
    yield* reader(people, input.orgId);
    yield* unseen(viewer, row, input);
  }
  const { now, seq } = yield* asOf(input.orgId, viewer);
  const page = yield* read(Crm.projectPage(row, now, seq, viewer));
  // Its people are the owner's, a co-owner's and its lead's to change (`teamGuard`).
  const leads =
    row.ownerKind === "person" && row.ownerId === person.person.personId && row.sensitive === 0;
  const note = yield* read(projectNoteOf(input.orgId, row.recordId));
  return {
    ...page,
    ...(note === undefined ? {} : { note }),
    can: { people: !person.teammate || leads, note: !person.teammate },
  };
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
    Crm.history(
      row,
      {
        ...(before === null ? {} : { beforeSeq: before }),
        limit: limit + 1,
      },
      KIN_OWNER_LEVEL,
    ),
  );
  const page = items.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page,
    nextCursor: items.length > limit && last !== undefined ? `s:${last.seq}` : null,
    seq: (yield* asOf(input.orgId, KIN_OWNER_LEVEL)).seq,
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
  read(
    Effect.flatMap(Clock.currentTimeMillis, (now) => Crm.projectDetail(row, now, KIN_OWNER_LEVEL)),
  );

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

const PEOPLE_REFUSED = new KinChatError({
  reason: "not_allowed",
  message: "Only the owner, a co-owner or the project's lead changes who is on it.",
});

/**
 * Puts people and agents on a project or takes them off: the owner, a co-owner, or the project's
 * lead (`teamGuard` decides inside the write). Whoever is added is told once in their chat.
 */
export const projectPeople = Effect.fn("KinWork.projectPeople")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinProjectPeopleInput,
) {
  const viewer = yield* viewerOf(people, input.orgId);
  const records = yield* KinRecords;
  const sql = yield* SqlClient.SqlClient;
  const add = input.add ?? [];
  const known = yield* read(
    Effect.forEach(add, (who) =>
      who._tag === "person"
        ? sql`SELECT 1 FROM kin_people WHERE org_id = ${input.orgId}
            AND person_id = ${who.personId}`
        : sql`SELECT 1 FROM kin_agents WHERE org_id = ${input.orgId}
            AND agent_id = ${who.agentId} AND retired_at IS NULL`,
    ),
  );
  if (known.some((rows) => rows.length === 0))
    return yield* new KinChatError({
      reason: "invalid_state",
      message: "Someone you picked isn't on the team any more.",
    });
  const { before, after } = yield* asViewer(
    viewer,
    Effect.gen(function* () {
      const before = yield* inList(input.orgId, input.key, "projects");
      const gone = new Set((input.remove ?? []).map(principalText));
      const now = fieldList(parseFields(before.fieldsJson), "members");
      const next = [...now, ...add.map(principalText)].filter(
        (text, at, all) => !gone.has(text) && all.indexOf(text) === at,
      );
      if (next.length === now.length && next.every((text, at) => text === now[at]))
        return { before, after: before };
      const after = yield* records
        .update(input.orgId, writerOf(viewer), input.key, { fields: { members: next } }, before.rev)
        .pipe(
          Effect.mapError((error) =>
            viewer.teammate && error.reason === "not_allowed" ? PEOPLE_REFUSED : error,
          ),
        );
      return { before, after };
    }),
  ).pipe(
    // A project they can't see answers as one that isn't there, in the same words.
    Effect.mapError((error) =>
      viewer.teammate && error.reason === "not_found" ? notFound(input.key) : error,
    ),
  );
  yield* tellMoved(viewer.person, before, after);
  return {
    key: after.key,
    rev: after.rev,
    members: fieldList(parseFields(after.fieldsJson), "members").flatMap((text) => {
      const who = principalOfText(text);
      return who === null ? [] : [who];
    }),
  };
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
  yield* tellMoved(person, undefined, row);
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
  const before = yield* inList(input.orgId, input.key, "projects");
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
  yield* tellMoved(person, before, row);
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
