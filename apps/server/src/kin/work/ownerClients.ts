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
  type KinWorkHistoryItem,
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
import { dealSeesField } from "./deals.ts";
import { KinRecords, requestHashOf, type Patch, type Writer } from "./KinRecords.ts";
import { fieldList, parseFields, type FieldValue, type ListName } from "./lists.ts";
import {
  asViewer,
  dueMillis,
  found,
  inList,
  ownerOnly,
  ownerWriter,
  tellMoved,
  theOwner,
  type Viewer,
  viewerOf,
  writerOf,
} from "./ownerWork.ts";
import { principalOfText, principalText } from "./projectSpine.ts";
import { projectNoteOf } from "./recordComments.ts";
import {
  iso,
  notFound,
  principal,
  type RecordRow,
  samePrincipal,
  unavailable,
  workFailure,
} from "./recordRows.ts";
import {
  KIN_OWNER_LEVEL,
  crmSeenBy,
  crmVisible,
  inProject,
  placesOf,
  teamClients,
  teamRecordIn,
  teamSeesField,
  teamSeq,
  teamVisible,
  viewerOfPeople,
  type KinViewer,
} from "./teamView.ts";
import * as Touches from "./touches.ts";

/**
 * The light CRM's pages and edits. The owner level does everything; anyone else reads what
 * `personSees` shows. A member with the Clients switch on also adds prospects, changes the ones
 * they look after and logs contact (`memberParty`), checked inside the write's transaction; terms,
 * tax, labels, who looks after a client and closing it stay the owner level's.
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
/** Whether this member's Clients switch is on: a project they lead alone reaches names. */
const switchedOn = Effect.fn("KinWork.crm.switchedOn")(function* (
  orgId: KinOrgId,
  viewer: KinViewer,
) {
  const [person] = viewer._tag === "people" ? viewer.people : [];
  if (person === undefined) return viewer._tag === "ownerLevel";
  return (yield* read(placesOf(orgId, person))).clients;
});
/**
 * A client row as anyone without the Clients switch reads it: who they are, not what is owed or
 * how it is sold. The contact log isn't theirs, so the row carries no word on it at all.
 */
const nameOnly = (row: KinPartyRow): KinPartyRow => ({
  recordId: row.recordId,
  key: row.key,
  name: row.name,
  kind: row.kind,
  owner: row.owner,
  active: row.active,
  sensitive: row.sensitive,
  weOwe: 0,
  theyOwe: 0,
  late: 0,
  overdue: 0,
  next: null,
  rev: row.rev,
});
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
  const works = yield* switchedOn(input.orgId, viewer);
  const { now, seq } = yield* asOf(input.orgId, viewer);
  // Kinds and who looks after a client are Clients' own; a lead without it filters by neither.
  const { kind: _kind, prospect: _prospect, owner: _owner, ...plain } = input;
  const page = yield* read(Crm.parties(input.orgId, now, works ? input : plain, viewer));
  return {
    parties: works ? page.rows : page.rows.map(nameOnly),
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
  const readers = people.filter((one) => one.orgId === input.orgId).map((one) => one.personId);
  const page = yield* read(Crm.partyPage(row, now, seq, viewer, readers));
  if (viewer._tag === "ownerLevel")
    return { ...page, can: { edit: true, log: true, owner: true } } satisfies KinPartyPage;
  const [team] = viewer.people;
  if (team === undefined) return yield* noClients;
  if (yield* switchedOn(input.orgId, viewer)) return yield* read(memberPage(page, team, row));
  // Built from what it may carry, so nothing added to the page later reaches a name-only reader.
  const shown = yield* read(
    teamVisible(input.orgId, team, [
      ...page.contacts.map((one) => one.recordId),
      ...page.projects.map((one) => one.recordId),
    ]),
  );
  const none = { records: [], total: 0 };
  return {
    party: {
      ...nameOnly(page.party),
      notes: "",
      terms: null,
      address: null,
      gstin: null,
      placeOfSupply: null,
      sensitiveFields: page.party.sensitiveFields,
      createdAt: page.party.createdAt,
      updatedAt: page.party.updatedAt,
      closedAt: page.party.closedAt,
      seq: page.party.seq,
    },
    // Leading a project alone gives its people's names, never how to reach them.
    contacts: page.contacts
      .filter((one) => shown.has(one.recordId))
      .map((one) => ({ ...one, email: null, phone: null, emails: [], phones: [] })),
    projects: page.projects.filter((one) => shown.has(one.recordId)),
    weOwe: none,
    theyOwe: none,
    ...(page.touches === undefined ? {} : { touches: [] }),
    can: { edit: false, log: false, owner: false },
    seq: page.seq,
    asOf: page.asOf,
  } satisfies KinPartyPage;
});

/**
 * The client page for a member with the Clients switch on: everything but its terms and tax
 * details, its work and Kin's own contact lines only as far as they see them.
 */
const memberPage = Effect.fn("KinWork.crm.memberPage")(function* (
  page: KinPartyPage,
  personId: KinPersonId,
  row: RecordRow,
) {
  const orgId = row.orgId as KinOrgId;
  const records = [...page.weOwe.records, ...page.theyOwe.records];
  const shown = yield* crmVisible(orgId, personId, [
    ...page.contacts.map((one) => one.recordId),
    ...page.projects.map((one) => one.recordId),
    ...records.flatMap((one) => (one.project === undefined ? [] : [one.project.recordId])),
    ...(page.touches ?? []).flatMap((one) => (one.record === null ? [] : [one.record.recordId])),
  ]);
  const clients = new Set([row.recordId]);
  const owed = (side: KinPartyPage["weOwe"]) => ({
    ...side,
    records: side.records.map((one) => teamRecordIn(one, shown, clients)),
  });
  return {
    ...page,
    party: { ...page.party, terms: null, gstin: null, placeOfSupply: null },
    contacts: page.contacts.filter((one) => shown.has(one.recordId)),
    projects: page.projects.filter((one) => shown.has(one.recordId)),
    weOwe: owed(page.weOwe),
    theyOwe: owed(page.theyOwe),
    ...(page.touches === undefined
      ? {}
      : {
          touches: page.touches.filter(
            (one) => one.record === null || shown.has(one.record.recordId),
          ),
        }),
    can: { edit: looksAfter(row, personId), log: true, owner: false },
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
  const viewer = yield* viewerOf(people, input.orgId);
  if (viewer.teammate) return yield* memberHistory(viewer.person, input);
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

/** What a member reads of a client's history besides what a task says (`teamSeesField`). */
const CLIENT_LINES = new Set([
  "address",
  "source",
  "tags",
  "role",
  "email",
  "phone",
  "emails",
  "phones",
]);

/**
 * A client's history for a member with the Clients switch on: what they see of it, without terms,
 * tax, labels or money. Projects' histories stay the owner level's.
 */
const memberHistory = Effect.fn("KinWork.crm.memberHistory")(function* (
  person: PersonIdentity,
  input: KinWorkHistoryInput,
) {
  const viewer = viewerOfPeople([person.personId]);
  if (!(yield* switchedOn(input.orgId, viewer))) return yield* ownerOnly;
  const row = yield* found(input.orgId, input).pipe(
    Effect.mapError(() => notFound("key" in input ? input.key : "with that id")),
  );
  const reached = yield* read(teamClients(input.orgId, person.personId, [row.recordId]));
  if (!reached.has(row.recordId))
    return yield* notFound("key" in input ? input.key : "with that id");
  const limit = input.limit ?? 50;
  // Lines are kept before a page is cut, so a page with a cursor is never empty.
  const kept: Array<KinWorkHistoryItem> = [];
  let before = yield* beforeOf(input.cursor);
  let more = true;
  while (more && kept.length <= limit) {
    const { items } = yield* read(
      Crm.history(
        row,
        { ...(before === null ? {} : { beforeSeq: before }), limit: limit + 1 },
        viewer,
        crmSeenBy,
      ),
    );
    for (const item of items) {
      if (item.kind === "linked") continue;
      const fields = item.fields.filter((field) =>
        item.record.listName === "deals"
          ? dealSeesField(field.field)
          : teamSeesField(field.field) || CLIENT_LINES.has(field.field),
      );
      if (item.kind !== "updated" || fields.length > 0) kept.push({ ...item, fields });
    }
    more = items.length > limit;
    before = items.at(-1)?.seq ?? before;
  }
  const page = kept.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page,
    nextCursor: kept.length > limit && last !== undefined ? `s:${last.seq}` : null,
    seq: (yield* asOf(input.orgId, viewer)).seq,
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
const detailsOf = (input: KinContactCreateInput | KinContactUpdateInput) => ({
  role: input.role,
  email: input.email,
  phone: input.phone,
  emails: input.emails,
  phones: input.phones,
});
const activeState = (active: boolean | undefined) =>
  active === undefined ? {} : { state: active ? ("open" as const) : ("dropped" as const) };

/**
 * Who a CRM write is by. A member's names clash only with the clients and contacts they see there
 * (`crmSees`): one hidden from them is never named, and the owner sorts out the two.
 */
const crmWriter = (person: PersonIdentity, member: boolean): Writer =>
  member ? { ...ownerWriter(person), namesSeenBy: person.personId } : ownerWriter(person);

const saved = Effect.fn("KinWork.crm.saved")(function* (
  person: PersonIdentity,
  orgId: KinOrgId,
  key: string,
  list: ListName,
  patch: Patch,
  rev: number,
  member = false,
) {
  yield* inList(orgId, key, list);
  const records = yield* KinRecords;
  return yield* records.update(orgId, crmWriter(person, member), key, patch, rev);
});
const createIn = Effect.fn("KinWork.crm.create")(function* (
  person: PersonIdentity,
  orgId: KinOrgId,
  list: ListName,
  request: { readonly clientRequestId: string },
  input: Omit<Parameters<KinRecords["Service"]["create"]>[2], "originKey" | "list">,
  member = false,
) {
  const records = yield* KinRecords;
  const { row } = yield* records.create(orgId, crmWriter(person, member), {
    ...input,
    list,
    originKey: `owner:${list}:${request.clientRequestId}`,
    requestHash: requestHashOf(request),
  });
  return row;
});
/**
 * A member's create answered: a retry finds what the first one stored, which they get back only as
 * they may see it now. One hidden from them since answers as one never there.
 */
const stillSeen = Effect.fn("KinWork.crm.stillSeen")(function* (
  person: PersonIdentity,
  row: RecordRow,
  name: string,
) {
  const seen = yield* read(crmVisible(row.orgId as KinOrgId, person.personId, [row.recordId]));
  if (!seen.has(row.recordId)) return yield* notFound(name);
  return row;
});
const partyOut = (row: RecordRow, viewer: KinViewer = KIN_OWNER_LEVEL) =>
  read(Effect.flatMap(Clock.currentTimeMillis, (now) => Crm.partyDetail(row, now, viewer)));

/** A member's own view of a client they just wrote: never its terms or tax details. */
const memberOut = (row: RecordRow, person: PersonIdentity) =>
  partyOut(row, viewerOfPeople([person.personId])).pipe(
    Effect.map((detail) => ({ ...detail, terms: null, gstin: null, placeOfSupply: null })),
  );

const looksAfter = (row: RecordRow, personId: KinPersonId) =>
  row.category !== "vendor" &&
  samePrincipal(principal(row.ownerKind, row.ownerId), { _tag: "person", personId });
const MEMBER_FIELDS = new KinChatError({
  reason: "not_allowed",
  message:
    "Only the owner or a co-owner sets a client's terms, tax details, address, Keep private or who looks after it, closes it, or makes it a vendor.",
});
const PROSPECTS_ONLY = new KinChatError({
  reason: "not_allowed",
  message: "You can add a prospect; the owner or a co-owner adds clients and vendors.",
});
const notTheirs = (key: string) =>
  new KinChatError({
    reason: "not_allowed",
    message: `Only whoever looks after ${key}, the owner or a co-owner changes it.`,
  });

/**
 * The member's Clients switch and the client they name, read inside the write's transaction: one
 * they see answers; one they don't is no client at all. `theirs` also needs them to look after it.
 */
const memberParty = Effect.fn("KinWork.crm.memberParty")(function* (
  personId: KinPersonId,
  orgId: KinOrgId,
  ref: { readonly key: string } | { readonly recordId: string },
  theirs: boolean,
) {
  if (!(yield* switchedOn(orgId, viewerOfPeople([personId])))) return yield* ownerOnly;
  const name = "key" in ref ? ref.key : "with that id";
  const row = yield* found(orgId, ref).pipe(Effect.mapError(() => notFound(name)));
  const reached = yield* read(teamClients(orgId, personId, [row.recordId]));
  if (!reached.has(row.recordId)) return yield* notFound(name);
  if (theirs && !looksAfter(row, personId)) return yield* notTheirs(row.key);
  return row;
});
const defines = (input: object, keys: ReadonlyArray<string>) =>
  keys.some((key) => (input as Record<string, unknown>)[key] !== undefined);
const projectOut = (row: RecordRow) =>
  read(
    Effect.flatMap(Clock.currentTimeMillis, (now) => Crm.projectDetail(row, now, KIN_OWNER_LEVEL)),
  );

/**
 * What a member adds in Clients, on their own screen or through their agent: a prospect they look
 * after, with its name, where it came from, tags and notes. Read inside the write's transaction.
 */
export const memberAdds = Effect.fn("KinWork.crm.memberAdds")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  input: {
    readonly prospect: boolean;
    readonly owner: KinWorkPrincipal | undefined;
    /** Terms, tax details, address, Keep private or closing it. */
    readonly ownersFields: boolean;
  },
) {
  if (!(yield* switchedOn(orgId, viewerOfPeople([personId])))) return yield* ownerOnly;
  if (!input.prospect) return yield* PROSPECTS_ONLY;
  if (
    input.ownersFields ||
    (input.owner !== undefined && !samePrincipal(input.owner, { _tag: "person", personId }))
  )
    return yield* MEMBER_FIELDS;
});
/**
 * A contact a member adds, on their own screen, with a prospect they add, or through their agent:
 * on a client they look after, held by them, never Keep private. The client it goes on.
 */
export const memberAddsContact = Effect.fn("KinWork.crm.memberAddsContact")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  input: {
    readonly party: { readonly key: string } | { readonly recordId: string };
    readonly owner: KinWorkPrincipal | undefined;
    /** Keep private, or made already gone. */
    readonly ownersFields: boolean;
  },
) {
  const party = yield* memberParty(personId, orgId, input.party, true);
  if (
    input.ownersFields ||
    (input.owner !== undefined && !samePrincipal(input.owner, { _tag: "person", personId }))
  )
    return yield* MEMBER_FIELDS;
  return party;
});
/**
 * A contact a member changes, on their own screen or through their agent: one they see, on a
 * client they look after; never its label or its client.
 */
export const memberChangesContact = Effect.fn("KinWork.crm.memberChangesContact")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  key: string,
  input: { readonly ownersFields: boolean },
) {
  if (!(yield* switchedOn(orgId, viewerOfPeople([personId])))) return yield* ownerOnly;
  const contact = yield* inList(orgId, key, "contacts").pipe(Effect.mapError(() => notFound(key)));
  // A contact labelled itself or through its client is one they never saw.
  const seen = yield* read(crmVisible(orgId, personId, [contact.recordId]));
  if (contact.partyId === null || !seen.has(contact.recordId)) return yield* notFound(key);
  yield* memberParty(personId, orgId, { recordId: contact.partyId }, true).pipe(
    Effect.mapError((error) => (error.reason === "not_found" ? notFound(key) : error)),
  );
  if (input.ownersFields) return yield* MEMBER_FIELDS;
});

/** With `contact`, the client and its first contact are saved in one transaction, or neither. */
export const createParty = Effect.fn("KinWork.createParty")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinPartyCreateInput,
) {
  const viewer = yield* viewerOf(people, input.orgId);
  const { person } = viewer;
  const create = createIn(
    person,
    input.orgId,
    "clients",
    input,
    {
      title: input.name,
      owner: input.owner ?? me(person),
      category:
        input.prospect === true && input.kind !== "vendor" ? "prospect" : (input.kind ?? "client"),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
      ...(input.sensitive === undefined ? {} : { sensitive: input.sensitive }),
      fields: fieldsOf({ ...partyFields(input), ...tagged(input) }),
    },
    viewer.teammate,
  );
  const made = !viewer.teammate
    ? create
    : Effect.gen(function* () {
        yield* memberAdds(input.orgId, person.personId, {
          prospect: input.prospect === true && input.kind !== "vendor",
          owner: input.owner,
          ownersFields: defines(input, ["terms", "address", "gstin", "placeOfSupply", "sensitive"]),
        });
        return yield* stillSeen(person, yield* create, input.name);
      });
  const { contact } = input;
  const row =
    contact === undefined
      ? yield* asViewer(viewer, made)
      : yield* (yield* SqlClient.SqlClient)
          .withTransaction(
            Effect.gen(function* () {
              const party = yield* made;
              yield* contactIn(viewer, {
                orgId: input.orgId,
                party: party.key,
                ...contact,
                clientRequestId: input.clientRequestId,
              });
              return party;
            }),
          )
          .pipe(workFailure);
  return viewer.teammate ? yield* memberOut(row, person) : yield* partyOut(row);
});

export const updateParty = Effect.fn("KinWork.updateParty")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinPartyUpdateInput,
) {
  const viewer = yield* viewerOf(people, input.orgId);
  const { person } = viewer;
  const fields = { ...defined(partyFields(input)), ...defined(tagged(input)) };
  const write = Effect.gen(function* () {
    const before = yield* inList(input.orgId, input.key, "clients");
    return yield* saved(
      person,
      input.orgId,
      input.key,
      "clients",
      {
        ...defined({
          title: input.name,
          category: categoryOf(before, input),
          owner: input.owner,
          notes: input.notes,
          sensitive: input.sensitive,
        }),
        ...activeState(input.active),
        ...(Object.keys(fields).length === 0 ? {} : { fields: fieldsOf(fields) }),
      },
      input.rev,
      viewer.teammate,
    );
  });
  if (!viewer.teammate) return yield* partyOut(yield* write);
  const row = yield* asViewer(
    viewer,
    Effect.gen(function* () {
      yield* memberParty(person.personId, input.orgId, { key: input.key }, true);
      if (
        defines(input, [
          "terms",
          "address",
          "gstin",
          "placeOfSupply",
          "sensitive",
          "active",
          "owner",
        ]) ||
        input.kind === "vendor"
      )
        return yield* MEMBER_FIELDS;
      return yield* write;
    }),
  );
  return yield* memberOut(row, person);
});

/** The stored category a change asks for: `kind` first, and `prospect` within a client. */
const categoryOf = (
  row: RecordRow,
  input: Pick<KinPartyUpdateInput, "kind" | "prospect">,
): string | undefined => {
  const kind = input.kind ?? (row.category === "vendor" ? "vendor" : "client");
  if (kind === "vendor") return input.kind;
  if (input.prospect !== undefined) return input.prospect ? "prospect" : "client";
  // A client's kind given again leaves a prospect a prospect.
  return input.kind === undefined || row.category === "prospect" ? undefined : input.kind;
};
const tagged = (
  input:
    | Pick<KinPartyCreateInput, "source" | "tags">
    | Pick<KinPartyUpdateInput, "source" | "tags">,
) => ({
  source: input.source,
  tags:
    input.tags === undefined
      ? undefined
      : input.tags.length === 0
        ? null
        : [...new Set(input.tags)],
});

/** A contact made, for a member only on a client `memberAddsContact` allows, in the caller's transaction. */
const contactIn = Effect.fn("KinWork.crm.contactIn")(function* (
  viewer: Viewer,
  input: KinContactCreateInput,
) {
  const { person } = viewer;
  const write = Effect.gen(function* () {
    const party = yield* inList(input.orgId, input.party, "clients");
    return yield* createIn(
      person,
      input.orgId,
      "contacts",
      input,
      {
        title: input.name,
        owner: me(person),
        partyId: party.recordId,
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        ...(input.sensitive === undefined ? {} : { sensitive: input.sensitive }),
        fields: fieldsOf(detailsOf(input)),
      },
      viewer.teammate,
    );
  });
  if (!viewer.teammate) return yield* write;
  yield* memberAddsContact(input.orgId, person.personId, {
    party: { key: input.party },
    owner: undefined,
    ownersFields: input.sensitive !== undefined,
  });
  return yield* stillSeen(person, yield* write, input.name);
});

export const createContact = Effect.fn("KinWork.createContact")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinContactCreateInput,
) {
  const viewer = yield* viewerOf(people, input.orgId);
  return Crm.toContact(yield* asViewer(viewer, contactIn(viewer, input)));
});

export const updateContact = Effect.fn("KinWork.updateContact")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinContactUpdateInput,
) {
  const viewer = yield* viewerOf(people, input.orgId);
  const { person } = viewer;
  const fields = fieldsOf(detailsOf(input));
  const write = Effect.gen(function* () {
    const partyId =
      input.party === undefined
        ? undefined
        : (yield* inList(input.orgId, input.party, "clients")).recordId;
    return yield* saved(
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
      viewer.teammate,
    );
  });
  if (!viewer.teammate) return Crm.toContact(yield* write);
  const row = yield* asViewer(
    viewer,
    Effect.gen(function* () {
      yield* memberChangesContact(input.orgId, person.personId, input.key, {
        ownersFields: input.sensitive !== undefined || input.party !== undefined,
      });
      return yield* write;
    }),
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
  noticeDays:
    input.noticeDays === undefined || input.noticeDays === null
      ? input.noticeDays
      : String(input.noticeDays),
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

/**
 * Someone logs contact by hand, and with `next` the follow-up it leaves, theirs to do, in the same
 * transaction: both land or neither. A member logs on any client they see. Open client pages read
 * again when it commits.
 */
export const logTouch = Effect.fn("KinWork.logTouch")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinTouchLogInput,
) {
  const viewer = yield* viewerOf(people, input.orgId);
  const { person } = viewer;
  const records = yield* KinRecords;
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const at = input.at === undefined ? now : Date.parse(input.at);
  // A member's requests have their own keys, so a retry never finds someone else's.
  const origin = viewer.teammate ? `member:${person.personId}:touch` : "owner:touch";
  const touch = yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const party = viewer.teammate
          ? yield* memberParty(person.personId, input.orgId, { key: input.party }, false)
          : yield* inList(input.orgId, input.party, "clients");
        const logged = yield* Touches.logTouch(input.orgId, {
          partyId: party.recordId,
          kind: input.kind,
          at,
          note: input.note ?? "",
          personId: person.personId,
          by: { kind: "person", id: person.personId },
          originKey: `${origin}:${input.clientRequestId}`,
          now,
        });
        const { next } = input;
        if (next !== undefined)
          yield* records.create(input.orgId, writerOf(viewer), {
            originKey: `${origin}-next:${input.clientRequestId}`,
            requestHash: requestHashOf({ clientRequestId: input.clientRequestId, ...next }),
            title: next.title,
            owner: me(person),
            category: "task",
            side: "ours",
            partyId: party.recordId,
            dueAt:
              next.dueAt === undefined
                ? null
                : yield* dueMillis(input.orgId, next.dueAt, next.dueAllDay),
            dueAllDay: next.dueAt !== undefined && next.dueAllDay === true,
          });
        return logged;
      }),
    )
    .pipe(workFailure);
  yield* records.announce(input.orgId);
  return touch;
});

/** Takes a logged contact back: the owner level any, a member one they logged on a client they see. */
export const removeTouch = Effect.fn("KinWork.removeTouch")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinTouchRemoveInput,
) {
  const viewer = yield* viewerOf(people, input.orgId);
  const now = yield* Clock.currentTimeMillis;
  const remove = read(Touches.removeTouch(input.orgId, input.touchId, now));
  const removed = viewer.teammate
    ? yield* asViewer(
        viewer,
        Effect.gen(function* () {
          const { personId } = viewer.person;
          if (!(yield* switchedOn(input.orgId, viewerOfPeople([personId]))))
            return yield* ownerOnly;
          const logged = yield* read(Touches.loggedBy(input.orgId, input.touchId));
          if (logged === undefined) return false;
          // One on a client they don't see answers as one already gone.
          const reached = yield* read(teamClients(input.orgId, personId, [logged.partyId]));
          if (!reached.has(logged.partyId)) return false;
          if (logged.byKind !== "person" || logged.byId !== viewer.person.personId)
            return yield* new KinChatError({
              reason: "not_allowed",
              message: "Only whoever logged it, the owner or a co-owner removes a contact.",
            });
          return yield* remove;
        }),
      )
    : yield* remove;
  if (removed) yield* (yield* KinRecords).announce(input.orgId);
  return { removed };
});
