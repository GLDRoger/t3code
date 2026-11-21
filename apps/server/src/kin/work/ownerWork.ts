import {
  KIN_SENSITIVE_FIELDS,
  KIN_RECORD_CHANGES_CAP,
  KinChatError,
  type KinOrgId,
  type KinRecord,
  type KinRecordCan,
  type KinRecordDetail,
  type KinPersonId,
  type KinWorkAssignInput,
  type KinWorkConfirmInput,
  type KinWorkCreateInput,
  type KinWorkGetInput,
  type KinWorkHandBackInput,
  type KinWorkHandOverInput,
  type KinWorkLinkAddInput,
  type KinWorkLinkRemoveInput,
  type KinWorkListInput,
  type KinWorkNudgeInput,
  type KinWorkPrincipal,
  type KinWorkShareInput,
  type KinWorkSummary,
  type KinWorkTickStepInput,
  type KinWorkUpdateInput,
  calendarTimeMillis,
  isCalendarDay,
  kinCompactWorkList,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { mayActAsOwner } from "../people/KinAccess.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { readableFrom } from "../chat/sharing.ts";
import {
  type CodingAgentConnection,
  connectionEnded,
  connectionLive,
  connectionReaches,
} from "./codingAgent.ts";
import { summaryGroups } from "./crm.ts";
import {
  KinRecords,
  requestHashOf,
  type Patch,
  type QueryInput,
  type Totals,
  type Writer,
} from "./KinRecords.ts";
import { fieldList, LISTS, type ListName, parseFields } from "./lists.ts";
import { milestoneLinks } from "./projectSpine.ts";
import { keyNamedFor, personSeesRecord, sheetExtras } from "./recordComments.ts";
import { movePage, nudge as nudgeHolder } from "./workMoves.ts";
import { isBuiltIn, listDef, unknownList } from "./registers.ts";
import { type AssignNotice, movedNotices, tellOnTasks, toldWhenBack } from "./assignNotices.ts";
import { teamAgent as theTeamAgent } from "../lead/LeadAccess.ts";
import {
  chatLinksFor,
  endOfDay,
  isClosed,
  iso,
  notFound,
  ownerZone,
  principal,
  principalId,
  type RecordRow,
  samePrincipal,
  toRecord,
  unavailable,
  workFailure,
} from "./recordRows.ts";
import {
  KIN_OWNER_LEVEL,
  TEAM_REFUSED,
  viewerOfPeople,
  inProject,
  ledProjects,
  teamCan,
  taskClients,
  teamClients,
  teamDetail,
  teamRecord,
  teamRecordIn,
  linkedFromOf,
  personSees,
  placesOf,
  teamSeq,
  teamVisible,
} from "./teamView.ts";
import { DAY_MS, WEEK_MS } from "../durations.ts";

/**
 * What people's clients read and do in Work. The owner reads and does everything; a teammate
 * reads the tasks `teamView.ts` gives them and changes their own, and nothing else here.
 */

export const ownerOnly = new KinChatError({
  reason: "not_allowed",
  message: "Only the owner or a co-owner can do that in Work.",
});

const notTheirProject = new KinChatError({
  reason: "not_allowed",
  message: "Only the owner, a co-owner or that project's lead can put a task in it.",
});

export const theOwner = Effect.fn("KinWork.owner")(function* (
  people: ReadonlyArray<PersonIdentity>,
  orgId: KinOrgId,
) {
  const viewer = yield* viewerOf(people, orgId);
  if (viewer.teammate) return yield* ownerOnly;
  return viewer.person;
});

/** The caller in this org, and whether they are a teammate rather than owner-level. */
export const viewerOf = Effect.fn("KinWork.viewer")(function* (
  people: ReadonlyArray<PersonIdentity>,
  orgId: KinOrgId,
) {
  const { owner } = yield* KinIdentity;
  const person = people.find((candidate) => candidate.orgId === orgId);
  if (person === undefined) return yield* ownerOnly;
  return {
    person,
    teammate:
      person.orgId !== owner.orgId ||
      !(yield* mayActAsOwner(orgId, person.personId, owner).pipe(Effect.mapError(() => ownerOnly))),
  };
});
export type Viewer = Effect.Success<ReturnType<typeof viewerOf>>;

/**
 * The places the host refuses the caller: none for the owner level, else each one `placesOf` says
 * they don't reach. Money's and Docs' gates and `kin.access.me` all answer from this.
 */
export const placeRefusals = Effect.fn("KinWork.placeRefusals")(function* (
  people: ReadonlyArray<PersonIdentity>,
  orgId: KinOrgId,
) {
  const viewer = yield* viewerOf(people, orgId);
  if (!viewer.teammate) return { viewer, refused: { money: false, docs: false } };
  const { reaches } = yield* placesOf(orgId, viewer.person.personId).pipe(workFailure);
  return { viewer, refused: { money: !reaches.money, docs: !reaches.docs } };
});
export const writerOf = (viewer: Viewer): Writer =>
  viewer.teammate ? { ...ownerWriter(viewer.person), teammate: true } : ownerWriter(viewer.person);
/** A teammate's write and its answer run in one transaction: what it checks holds as it commits. */
export const asViewer = Effect.fn("KinWork.asViewer")(function* <A, R>(
  viewer: Viewer,
  write: Effect.Effect<A, KinChatError, R>,
) {
  if (!viewer.teammate) return yield* write;
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(write).pipe(workFailure);
});

/**
 * In the caller's transaction: the caller as their own screen reads them, and the coding agent's
 * key still theirs and live. Anything else is the key ended.
 */
export const connectionViewer = Effect.fn("KinWork.connectionViewer")(function* (
  people: ReadonlyArray<PersonIdentity>,
  connection: CodingAgentConnection,
  orgId: KinOrgId,
) {
  const viewer = yield* viewerOf(people, orgId);
  if (
    orgId !== connection.orgId ||
    viewer.person.personId !== connection.personId ||
    !(yield* connectionLive(connection).pipe(workFailure))
  )
    return yield* connectionEnded;
  return viewer;
});
/** A coding agent's call: its checks and its work in one transaction. */
const throughConnection = Effect.fn("KinWork.throughConnection")(function* <A, R>(
  people: ReadonlyArray<PersonIdentity>,
  connection: CodingAgentConnection,
  orgId: KinOrgId,
  run: (viewer: Viewer) => Effect.Effect<A, KinChatError, R>,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* connectionViewer(people, connection, orgId).pipe(
    Effect.flatMap(run),
    sql.withTransaction,
    workFailure,
  );
});

const millis = (value: string, field: string) => {
  const ms = calendarTimeMillis(value);
  return Number.isFinite(ms)
    ? Effect.succeed(ms)
    : Effect.fail(
        new KinChatError({ reason: "invalid_state", message: `${field} is not a time.` }),
      );
};

/** `o:<offset>` or `o:<offset>:<ms>`: the time the first page judged `late` at, so pages hold. */
const parseCursor = (cursor: string | undefined) => {
  if (cursor === undefined) return Effect.succeed({ offset: 0, at: undefined });
  const found = /^o:(\d{1,9})(?::(\d{1,15}))?$/.exec(cursor);
  return found === null
    ? Effect.fail(
        new KinChatError({ reason: "invalid_state", message: "That page cursor is stale." }),
      )
    : Effect.succeed({
        offset: Number.parseInt(found[1]!, 10),
        at: found[2] === undefined ? undefined : Number.parseInt(found[2], 10),
      });
};

const missing = (key: string, list: ListName) =>
  new KinChatError({
    reason: "not_found",
    message: `No ${LISTS[list].noun} ${key.slice(0, 40)} in Work.`,
  });

/** A key the owner named, in the list it must be in. */
export const inList = Effect.fn("KinWork.inList")(function* (
  orgId: KinOrgId,
  key: string,
  list: ListName,
) {
  const records = yield* KinRecords;
  const row = yield* records.get(orgId, key);
  // Work's edits also reach the lists defined in chat, whose own fields are typed there.
  const inIt =
    row !== undefined && (row.registerId === list || (list === "work" && workEdits(row)));
  if (row === undefined || !inIt) return yield* missing(key, list);
  return row;
});
/** Work's own edits reach this entry: a task, a milestone, or a list defined in chat. */
const workEdits = (row: Pick<RecordRow, "registerId">) =>
  row.registerId === "work" || row.registerId === "milestones" || !isBuiltIn(row.registerId);

const NOTHING: KinRecordCan = {
  states: [],
  edit: false,
  party: false,
  project: false,
  clearProject: false,
  give: false,
  takeBack: false,
  mark: false,
  unmark: false,
  share: false,
  confirm: false,
  repeat: false,
  links: false,
};

type CanEntry = Pick<KinRecord, "recordId" | "key" | "state" | "owner" | "confirmed"> &
  Pick<RecordRow, "registerId">;

/**
 * What this viewer may do to each entry: for a teammate `teamCan` asks the rule their write runs;
 * owner-level, the same checks `update`, `assign` and `share` make. Nothing on an entry whose
 * list can't be read.
 */
const cansOf = Effect.fn("KinWork.cansOf")(function* (
  viewer: Viewer,
  orgId: KinOrgId,
  entries: ReadonlyArray<CanEntry>,
) {
  const defs = new Map<string, Effect.Success<ReturnType<typeof listDef>>>();
  for (const registerId of new Set(entries.map((entry) => entry.registerId)))
    defs.set(registerId, yield* listDef(orgId, registerId).pipe(workFailure));
  const known = entries.flatMap((entry) => {
    const def = defs.get(entry.registerId);
    return def === undefined ? [] : [{ ...entry, states: def.states }];
  });
  if (viewer.teammate) {
    const cans = yield* teamCan(orgId, viewer.person.personId, known).pipe(workFailure);
    return (recordId: string): KinRecordCan => {
      const can = cans.get(recordId);
      return can === undefined ? NOTHING : { ...can, links: can.edit };
    };
  }
  const cans = new Map<string, KinRecordCan>(
    known.map((entry) => {
      const edits = workEdits(entry);
      const open = !isClosed(entry.state);
      const can: KinRecordCan = {
        states: edits ? entry.states.filter((state) => state !== entry.state) : [],
        edit: edits,
        party: edits,
        project: edits,
        clearProject: edits,
        give: edits && open,
        takeBack:
          edits &&
          open &&
          !samePrincipal(entry.owner, { _tag: "person", personId: viewer.person.personId }),
        mark: edits,
        unmark: edits,
        share: !UNSHARED.has(entry.registerId),
        confirm: edits && !entry.confirmed && entry.state !== "dropped",
        repeat: entry.registerId === "work",
        links: edits,
      };
      return [entry.recordId, can] as const;
    }),
  );
  return (recordId: string) => cans.get(recordId) ?? NOTHING;
});

/**
 * A client or project named in Work. To a teammate there is none, save a project they lead (to
 * file under), a client their Clients switch reaches (`teamClients`; the write's `teamGuard`
 * decides again), or, to `read`, one they are on: any other key is answered as one never there.
 */
const refId = Effect.fn("KinWork.refId")(function* (
  viewer: Viewer,
  orgId: KinOrgId,
  key: string | null | undefined,
  list: "clients" | "projects",
) {
  if (key === undefined) return undefined;
  if (viewer.teammate) {
    if (key === null) return list === "clients" ? null : yield* ownerOnly;
    const row = yield* (yield* KinRecords).get(orgId, key);
    if (list === "clients") {
      const reached =
        row !== undefined &&
        (yield* teamClients(orgId, viewer.person.personId, [row.recordId]).pipe(workFailure)).has(
          row.recordId,
        );
      return reached ? row.recordId : yield* missing(key, list);
    }
    if (row === undefined || row.registerId !== "projects") return yield* missing(key, list);
    if ((yield* ledIds(viewer)).has(row.recordId)) return row.recordId;
    // One they are on is no secret to them: say who files tasks there, not that it is gone.
    const on = yield* inProject(orgId, viewer.person.personId, row.recordId).pipe(workFailure);
    return yield* on ? notTheirProject : missing(key, list);
  }
  if (key === null) return null;
  return (yield* inList(orgId, key, list)).recordId;
});

/**
 * A client or project a list is filtered by. A teammate filters by any client they see and any
 * project they are on; anything else matches nothing, the answer for one never there.
 */
const filterRef = Effect.fn("KinWork.filterRef")(function* (
  viewer: Viewer,
  orgId: KinOrgId,
  key: string | null | undefined,
  list: "clients" | "projects",
) {
  if (!viewer.teammate || key === undefined || key === null)
    return { id: yield* refId({ ...viewer, teammate: false }, orgId, key, list), none: false };
  const row = yield* (yield* KinRecords).get(orgId, key);
  const { personId } = viewer.person;
  const on =
    row === undefined || row.registerId !== list
      ? false
      : list === "projects"
        ? yield* inProject(orgId, personId, row.recordId).pipe(workFailure)
        : (yield* teamVisible(orgId, personId, [row.recordId]).pipe(workFailure)).has(row.recordId);
  return on && row !== undefined
    ? { id: row.recordId, none: false }
    : { id: undefined, none: true };
});

/** The projects a teammate leads, read per request. */
const ledIds = Effect.fn("KinWork.ledIds")(function* (viewer: Viewer) {
  if (!viewer.teammate) return new Set<string>();
  const led = yield* ledProjects(viewer.person.orgId, viewer.person.personId).pipe(workFailure);
  return new Set<string>(led.map((project) => project.recordId));
});

/**
 * A row a teammate may see, as they read it: a task outside the projects they lead keeps only
 * what the task says (`teamRecord`); a client loses its terms; anything else reads whole.
 */
const plainTask = (row: Pick<RecordRow, "registerId" | "projectId">, led: Set<string>) =>
  row.registerId === "work" && (row.projectId === null || !led.has(row.projectId));

/**
 * An agent a teammate gives a task to: one whose owner lets them message it, and their direct
 * chat with it, where it reports. Any other looks like no agent at all.
 */
const teamAgent = Effect.fn("KinWork.teamAgent")(function* (
  person: PersonIdentity,
  to: KinWorkPrincipal,
) {
  if (to._tag !== "agent") return;
  // Without the chat service (a bare test layer) the wake still refuses an agent with no chat.
  const chats = yield* Effect.serviceOption(KinChatService);
  if (Option.isNone(chats)) return;
  yield* chats.value.createDirect(person, { orgId: person.orgId, agentId: to.agentId }).pipe(
    Effect.mapError((error) =>
      error._tag === "KinChatError" &&
      (error.reason === "not_found" || error.reason === "not_allowed")
        ? new KinChatError({
            reason: "not_found",
            message: `No agent ${to.agentId.slice(0, 60)} here to own it.`,
          })
        : unavailable,
    ),
  );
});

/**
 * With a coding agent's connection, only what its key reaches: open tasks the person holds and
 * nothing labelled sensitive, soonest due first, filtered before the page is cut.
 */
export const list = Effect.fn("KinWork.list")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkListInput,
  connection?: CodingAgentConnection,
) {
  if (connection === undefined) return yield* listAs(yield* viewerOf(people, input.orgId), input);
  const held: KinWorkListInput = {
    orgId: input.orgId,
    owner: { _tag: "person", personId: connection.personId },
    open: true,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  };
  return yield* throughConnection(people, connection, input.orgId, (viewer) =>
    listAs(viewer, held, { order: "dueFirst", withoutSensitive: true }),
  );
});

const listAs = Effect.fn("KinWork.listAs")(function* (
  viewer: Viewer,
  input: KinWorkListInput,
  internal: Pick<QueryInput, "order" | "withoutSensitive"> = {},
) {
  // A task's amount is the owner's, so sums and money filters over tasks are too; a list's
  // entries a teammate sees whole (`personSees`), figures included.
  if (
    viewer.teammate &&
    (input.list === undefined || input.list === "work") &&
    (input.totalsBy !== undefined ||
      input.listCategory !== undefined ||
      input.dateFrom !== undefined ||
      input.dateTo !== undefined ||
      input.paidFrom !== undefined ||
      input.paidTo !== undefined)
  )
    return yield* ownerOnly;
  const records = yield* KinRecords;
  const cursor = yield* parseCursor(input.cursor);
  const party = yield* filterRef(viewer, input.orgId, input.party, "clients");
  const project = yield* filterRef(viewer, input.orgId, input.project, "projects");
  const partyId = party.id;
  const projectId = project.id;
  // A client's money reaches a teammate only with the Money switch, whichever project they lead.
  const moneyOff =
    viewer.teammate &&
    typeof partyId === "string" &&
    input.list !== undefined &&
    !isBuiltIn(input.list) &&
    !(yield* placesOf(input.orgId, viewer.person.personId).pipe(workFailure)).money;
  const at = cursor.at ?? (yield* Clock.currentTimeMillis);
  const limit = input.limit ?? 50;
  if (
    input.list !== undefined &&
    (yield* listDef(input.orgId, input.list).pipe(workFailure)) === undefined
  )
    return yield* unknownList(input.list);
  const zone =
    input.dateFrom === undefined && input.dateTo === undefined
      ? "UTC"
      : yield* ownerZone(input.orgId).pipe(workFailure);
  const filter = {
    ...(input.list === undefined ? {} : { list: input.list }),
    ...(input.owner === undefined ? {} : { owner: input.owner }),
    ...(input.states === undefined ? {} : { states: input.states }),
    ...(input.open === undefined ? {} : { open: input.open }),
    ...(input.late === undefined ? {} : { late: input.late }),
    ...(input.dueBy === undefined ? {} : { dueBy: yield* millis(input.dueBy, "dueBy") }),
    ...(input.dueAfter === undefined
      ? {}
      : { dueAfter: yield* millis(input.dueAfter, "dueAfter") }),
    ...(input.category === undefined ? {} : { category: input.category }),
    ...(input.list === undefined || input.listCategory === undefined
      ? {}
      : { category: input.listCategory }),
    ...(input.party === null ? { partyId: null } : {}),
    ...(input.dateFrom === undefined
      ? {}
      : { dateFrom: endOfDay(input.dateFrom, zone) - DAY_MS + 1 }),
    ...(input.dateTo === undefined ? {} : { dateTo: endOfDay(input.dateTo, zone) + 1 }),
    ...(input.paidFrom === undefined ? {} : { paidFrom: input.paidFrom }),
    ...(input.paidTo === undefined ? {} : { paidTo: input.paidTo }),
    ...(input.kept === undefined ? {} : { kept: input.kept }),
    ...(input.side === undefined ? {} : { side: input.side }),
    ...(partyId === undefined || partyId === null ? {} : { partyId }),
    ...(projectId === undefined || projectId === null ? {} : { projectId }),
    ...(input.repo === undefined ? {} : { repo: input.repo }),
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(viewer.teammate ? { team: viewer.person.personId } : {}),
    at,
  };
  const byMove = input.byMove === true && (input.list === undefined || input.list === "work");
  const nothing = party.none || project.none || moneyOff;
  const page = nothing
    ? {
        rows: [],
        total: 0,
        seq: yield* teamSeq(input.orgId, viewer.person.personId).pipe(workFailure),
        moves: byMove ? [] : undefined,
        counts: byMove ? { needsYou: 0, waiting: 0, rest: 0, doneRecently: 0 } : undefined,
      }
    : byMove
      ? yield* movePage({
          orgId: input.orgId,
          personId: viewer.person.personId,
          ownerLevel: !viewer.teammate,
          filter,
          offset: cursor.offset,
          limit,
          at,
        })
      : yield* records.query(input.orgId, {
          ...filter,
          // "Due this week" and the like read by when, so tomorrow's comes before Tuesday's.
          ...(input.dueBy === undefined ? {} : { order: "dueFirst" as const }),
          ...internal,
          offset: cursor.offset,
          limit,
        });
  // The sums are of every match and the same on each page, so only the first page pays for them.
  const totals =
    nothing || input.totalsBy === undefined || input.cursor !== undefined
      ? undefined
      : yield* records.totals(
          input.orgId,
          filter,
          input.totalsBy === "none" ? undefined : input.totalsBy,
          true,
        );
  const next = cursor.offset + page.rows.length;
  const answer = {
    records: yield* shownRecords(viewer, input.orgId, page.rows, at),
    total: page.total,
    nextCursor: next < page.total ? `o:${next}:${at}` : null,
    seq: page.seq,
    asOf: iso(at),
    ...(totals === undefined ? {} : { totals: listTotals(totals) }),
    ...("moves" in page && page.moves !== undefined ? { moves: page.moves } : {}),
    ...("counts" in page && page.counts !== undefined ? { counts: page.counts } : {}),
  };
  return input.acceptCompactRows === true ? kinCompactWorkList(answer) : answer;
});

/**
 * Entries as `list` shows them to this viewer, `late` judged at `at`: what they may do to each,
 * and for a teammate only what `teamRecordIn` keeps. The live stream sends rows built here too.
 */
export const shownRecords = Effect.fn("KinWork.shownRecords")(function* (
  viewer: Viewer,
  orgId: KinOrgId,
  rows: ReadonlyArray<RecordRow>,
  at: number,
) {
  const led = yield* ledIds(viewer);
  const shown = rows.map((row) => ({ row, record: toRecord(row, at) }));
  const can = yield* cansOf(
    viewer,
    orgId,
    shown.map(({ row, record }) => ({ ...record, registerId: row.registerId })),
  );
  const projects = viewer.teammate
    ? yield* teamVisible(orgId, viewer.person.personId, [
        ...new Set(
          shown.flatMap(({ record }) => (record.project ? [record.project.recordId] : [])),
        ),
      ]).pipe(workFailure)
    : new Set<string>();
  const parties = [
    ...new Set(shown.flatMap(({ record }) => (record.party ? [record.party.recordId] : []))),
  ];
  const clients = viewer.teammate
    ? yield* teamClients(orgId, viewer.person.personId, parties).pipe(workFailure)
    : new Set<string>();
  const named = viewer.teammate
    ? yield* taskClients(orgId, viewer.person.personId, parties).pipe(workFailure)
    : new Set<string>();
  return shown.map(({ row, record: whole }): KinRecord => {
    // Only the task's own sheet sets a repeat or links, so its rows don't carry the answers.
    const { repeat: _repeat, links: _links, ...rowCan } = can(whole.recordId);
    const record = { ...whole, can: rowCan };
    if (viewer.teammate && plainTask(row, led)) return teamRecordIn(record, projects, clients);
    if (viewer.teammate && row.registerId === "work") return withClient(record, named);
    const fields = isBuiltIn(row.registerId) ? {} : parseFields(row.fieldsJson);
    return Object.keys(fields).length === 0 ? record : { ...record, fields };
  });
});

/** A client's terms and tax details: the owner level's, now and in its changes. */
const CONTACT_DETAILS: ReadonlySet<string> = new Set(KIN_SENSITIVE_FIELDS.contacts);
const OWNERS_CLIENT_FIELDS: ReadonlySet<string> = new Set(["terms", "gstin", "placeOfSupply"]);

/** A task read whole, naming its client only while this person may see it (`taskClients`). */
const withClient = <A extends { readonly party?: { readonly recordId: string } | undefined }>(
  record: A,
  named: ReadonlySet<string>,
) => {
  if (record.party === undefined || named.has(record.party.recordId)) return record;
  const { party: _party, ...rest } = record;
  return rest;
};

/** A task's sheet read whole: its client, now and in its changes, only where `taskClients` names it. */
const clientShown = Effect.fn("KinWork.clientShown")(function* (
  detail: KinRecordDetail,
  personId: KinPersonId,
) {
  const keys = detail.changes.flatMap((change) =>
    change.fields.flatMap((field) =>
      field.field === "party" ? [field.from, field.to].filter((one) => one !== null) : [],
    ),
  );
  const named = yield* taskClients(detail.orgId, personId, [
    ...(detail.party === undefined ? [] : [detail.party.recordId]),
    ...keys,
  ]).pipe(workFailure);
  const shown = (value: string | null) => value === null || named.has(value);
  return {
    ...withClient(detail, named),
    changes: detail.changes.flatMap((change) => {
      const fields = change.fields.filter(
        (field) => field.field !== "party" || (shown(field.from) && shown(field.to)),
      );
      return change.kind === "updated" && fields.length === 0 ? [] : [{ ...change, fields }];
    }),
  };
});

const listTotals = ({ counted: _counted, groups, ...sums }: Totals) => ({
  ...sums,
  groups: groups ?? [],
});

const found = Effect.fn("KinWork.found")(function* (
  orgId: KinOrgId,
  ref: { readonly key: string } | { readonly recordId: string },
) {
  const records = yield* KinRecords;
  const row =
    "key" in ref ? yield* records.get(orgId, ref.key) : yield* records.getById(orgId, ref.recordId);
  if (row === undefined) return yield* notFound("key" in ref ? ref.key : "with that id");
  return row;
});

export { found };
/** With a coding agent's connection, also only an entry its key reaches; any other is unknown. */
export const get = Effect.fn("KinWork.get")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkGetInput,
  connection?: CodingAgentConnection,
) {
  if (connection === undefined) return yield* getAs(yield* viewerOf(people, input.orgId), input);
  return yield* throughConnection(people, connection, input.orgId, (viewer) =>
    getAs(viewer, input, connection),
  );
});

const getAs = Effect.fn("KinWork.getAs")(function* (
  viewer: Viewer,
  input: KinWorkGetInput,
  connection?: CodingAgentConnection,
) {
  const records = yield* KinRecords;
  const seq = viewer.teammate
    ? yield* teamSeq(input.orgId, viewer.person.personId).pipe(workFailure)
    : undefined;
  const row = yield* found(input.orgId, input);
  if (
    connection !== undefined &&
    !(yield* connectionReaches(connection, row.recordId).pipe(workFailure))
  )
    return yield* notFound("key" in input ? input.key : "with that id");
  const shown = yield* shownTo(
    viewer,
    yield* records.detail(row, KIN_RECORD_CHANGES_CAP),
    row,
    input,
    seq,
  );
  const { milestone, tasks } = yield* milestoneLinks(
    row,
    viewer.teammate ? viewerOfPeople([viewer.person.personId]) : KIN_OWNER_LEVEL,
  ).pipe(workFailure);
  const linked = [
    ...(milestone === undefined ? [] : [milestone.recordId]),
    ...(tasks ?? []).map((task) => task.recordId),
  ];
  const now = yield* Clock.currentTimeMillis;
  // A teammate reads a task's milestone where they read its project, and only tasks they see.
  const team = viewer.teammate && linked.length > 0;
  const led = team ? yield* ledIds(viewer) : new Set<string>();
  const seen = team
    ? yield* teamVisible(input.orgId, viewer.person.personId, linked).pipe(workFailure)
    : undefined;
  const sees = (recordId: string) => seen === undefined || seen.has(recordId);
  return {
    ...shown,
    ...(milestone === undefined ||
    !sees(milestone.recordId) ||
    (viewer.teammate && plainTask(row, led))
      ? {}
      : { milestone }),
    ...(tasks === undefined
      ? {}
      : {
          tasks: tasks
            .filter((task) => sees(task.recordId))
            .map((task) =>
              viewer.teammate && plainTask(task, led)
                ? teamRecord(toRecord(task, now))
                : toRecord(task, now),
            ),
        }),
  };
});

/**
 * An entry's sheet for this viewer; one a teammate may not see fails as an unknown one does. A
 * teammate's sheet carries their own change number, read no later than the sheet (`seq`) or now.
 */
const shownTo = Effect.fn("KinWork.shownTo")(function* (
  viewer: Viewer,
  read: Effect.Success<ReturnType<KinRecords["Service"]["detail"]>>,
  row: Pick<RecordRow, "registerId" | "projectId">,
  ref: { readonly key: string } | { readonly recordId: string },
  seq?: number,
  /** Their own write just made it private: they saw it until then, so the answer still reads. */
  justHidden = false,
) {
  const detail = yield* chatLinksFor(read.orgId, viewer.person.personId, read).pipe(workFailure);
  const can = (yield* cansOf(viewer, detail.orgId, [{ ...detail, registerId: row.registerId }]))(
    detail.recordId,
  );
  const back =
    row.registerId === "work"
      ? yield* toldWhenBack(detail.orgId, detail.recordId, detail.owner).pipe(workFailure)
      : undefined;
  const extras = {
    ...(back === undefined ? {} : { toldWhenBack: back }),
    ...(yield* sheetExtras(detail.orgId, viewer, detail).pipe(workFailure)),
    ...(yield* linkedFromOf(
      detail.orgId,
      detail.recordId,
      viewer.teammate ? viewerOfPeople([viewer.person.personId]) : KIN_OWNER_LEVEL,
    ).pipe(workFailure)),
  };
  if (!viewer.teammate) return { ...detail, ...extras, can };
  const { personId } = viewer.person;
  const seen = yield* teamVisible(detail.orgId, personId, [detail.recordId]).pipe(workFailure);
  if (!seen.has(detail.recordId) && !justHidden)
    return yield* notFound("key" in ref ? ref.key : "with that id");
  const number = seq ?? (yield* teamSeq(detail.orgId, personId).pipe(workFailure));
  const whole = !plainTask(row, yield* ledIds(viewer));
  // A client's terms and tax details are the owner's, whoever else sees its name; a contact's email
  // and phone reach those with the Clients place, not a project's lead alone.
  const { fields: _fields, ...unfielded } = detail;
  const named = () => {
    const {
      email: _email,
      phone: _phone,
      emails: _emails,
      phones: _phones,
      ...rest
    } = detail.fields ?? {};
    return {
      ...detail,
      fields: rest,
      changes: detail.changes.map((change) => ({
        ...change,
        fields: change.fields.filter((one) => !CONTACT_DETAILS.has(one.field)),
      })),
    };
  };
  const shown =
    whole && row.registerId === "clients"
      ? {
          ...unfielded,
          changes: detail.changes.flatMap((change) => {
            const fields = change.fields.filter((one) => !OWNERS_CLIENT_FIELDS.has(one.field));
            return change.kind === "updated" && fields.length === 0 ? [] : [{ ...change, fields }];
          }),
        }
      : whole &&
          row.registerId === "contacts" &&
          !(yield* placesOf(detail.orgId, personId).pipe(workFailure)).clients
        ? named()
        : detail;
  const sheet = yield* teamDetail(
    whole && row.registerId === "work" ? yield* clientShown(shown, personId) : shown,
    personId,
    number,
    whole,
  ).pipe(workFailure);
  return {
    ...sheet,
    changes: sheet.changes.map((change) => keyNamedFor(viewer, change)),
    ...extras,
    can,
  };
});

type Counts = { open: number; doing: number; waiting: number; late: number; dueThisWeek: number };
export const summary = Effect.fn("KinWork.summary")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: { readonly orgId: KinOrgId },
) {
  return yield* summaryOf(yield* viewerOf(people, input.orgId), input);
});

/** `summary` for a viewer already read; an owner-level one counts the same for every such person. */
// oxlint-disable-next-line t3code/kin-viewer-scoped-reads -- `viewer` is `viewerOf`'s, applied as `team`
export const summaryOf = Effect.fn("KinWork.summaryOf")(function* (
  viewer: Viewer,
  input: { readonly orgId: KinOrgId },
) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  const now = yield* Clock.currentTimeMillis;
  // Read before the counts, so a change landing meanwhile reads as newer than them.
  const seq = viewer.teammate
    ? yield* teamSeq(input.orgId, viewer.person.personId).pipe(workFailure)
    : yield* records.seq(input.orgId);
  const team = viewer.teammate ? personSees(sql, viewer.person.personId) : sql`1 = 1`;
  const [closed] = yield* sql<{ closed: number }>`SELECT COUNT(*) AS closed FROM kin_records r
    WHERE r.org_id = ${input.orgId} AND r.register_id = 'work' AND r.state IN ('done', 'dropped')
      AND ${team}`.pipe(Effect.mapError(() => unavailable));
  const rows = yield* sql<{ ownerKind: string; ownerId: string } & Counts>`
    SELECT r.owner_kind AS "ownerKind", r.owner_id AS "ownerId", COUNT(*) AS open,
      SUM(r.state = 'doing') AS doing, SUM(r.state = 'waiting') AS waiting,
      SUM(r.due_at IS NOT NULL AND r.due_at < ${now}) AS late,
      SUM(r.due_at IS NOT NULL AND r.due_at >= ${now} AND r.due_at < ${now + WEEK_MS}) AS "dueThisWeek"
    FROM kin_records r WHERE r.org_id = ${input.orgId} AND r.register_id = 'work'
      AND r.state NOT IN ('done', 'dropped') AND ${team}
    GROUP BY r.owner_kind, r.owner_id ORDER BY COUNT(*) DESC, r.owner_kind, r.owner_id`.pipe(
    Effect.mapError(() => unavailable),
  );
  const zero: Counts = { open: 0, doing: 0, waiting: 0, late: 0, dueThisWeek: 0 };
  const owners = rows.flatMap((row) => {
    const owner = principal(row.ownerKind, row.ownerId);
    return owner === null
      ? []
      : [
          {
            owner,
            open: row.open,
            doing: row.doing,
            waiting: row.waiting,
            late: row.late,
            dueThisWeek: row.dueThisWeek,
          },
        ];
  });
  const total = owners.reduce(
    (sum, row) => ({
      open: sum.open + row.open,
      doing: sum.doing + row.doing,
      waiting: sum.waiting + row.waiting,
      late: sum.late + row.late,
      dueThisWeek: sum.dueThisWeek + row.dueThisWeek,
    }),
    zero,
  );
  // Clients' and projects' counts are the owner's: they add up work a teammate can't see.
  const groups = viewer.teammate
    ? { parties: [], projects: [] }
    : yield* summaryGroups(input.orgId, now).pipe(Effect.mapError(() => unavailable));
  return {
    ...total,
    closed: closed?.closed ?? 0,
    owners,
    parties: groups.parties,
    projects: groups.projects,
    seq,
    asOf: iso(now),
  } satisfies KinWorkSummary;
});

/** The owner's own words, so it is confirmed; given to a lead, it is an instruction to do it. */
export const create = Effect.fn("KinWork.create")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkCreateInput,
) {
  const viewer = yield* viewerOf(people, input.orgId);
  const { person } = viewer;
  const records = yield* KinRecords;
  const dueAt =
    input.dueAt === undefined ? null : yield* dueMillis(input.orgId, input.dueAt, input.dueAllDay);
  const owner: KinWorkPrincipal = input.owner ?? { _tag: "person", personId: person.personId };
  const partyId = yield* refId(viewer, input.orgId, input.party, "clients");
  const projectId = yield* refId(viewer, input.orgId, input.project, "projects");
  const milestone = input.list === "milestones";
  if (milestone && (projectId === undefined || projectId === null))
    return yield* new KinChatError({
      reason: "invalid_state",
      message: "A milestone belongs to a project, and only the owner or its lead adds one.",
    });
  // Before anything about the task is read, so its outcome turns on the agent alone.
  if (viewer.teammate) yield* teamAgent(person, owner);
  const write = Effect.gen(function* () {
    const { row } = yield* records.create(input.orgId, writerOf(viewer), {
      // A teammate's requests have their own keys, so a retry never finds someone else's entry.
      originKey: viewer.teammate
        ? `member:${person.personId}:${input.clientRequestId}`
        : `owner:${input.clientRequestId}`,
      requestHash: requestHashOf(input),
      ...(milestone ? { list: "milestones" } : {}),
      title: input.title,
      owner,
      dueAt,
      dueAllDay: input.dueAllDay === true,
      ...(input.notes === undefined ? {} : { notes: input.notes }),
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(partyId === undefined ? {} : { partyId }),
      ...(projectId === undefined ? {} : { projectId }),
      ...(input.side === undefined ? {} : { side: input.side }),
      ...(input.repo === undefined ? {} : { repo: input.repo }),
      ...(input.repeat === undefined || milestone ? {} : { repeat: input.repeat }),
      ...(input.steps === undefined
        ? {}
        : { steps: input.steps.map((title) => ({ title, done: false })) }),
      ...(input.urgent === undefined ? {} : { urgent: input.urgent }),
    });
    return {
      row,
      shown: yield* shownTo(viewer, yield* records.detail(row, KIN_RECORD_CHANGES_CAP), row, row),
    };
  });
  const { row, shown } = yield* asViewer(viewer, write);
  yield* tellMoved(person, undefined, row);
  return shown;
});

/** A closed entry is refused: reopen it first. Taking it back (`to: null`) returns it to the owner. */
export const assign = Effect.fn("KinWork.assign")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkAssignInput,
) {
  const viewer = yield* viewerOf(people, input.orgId);
  const { person } = viewer;
  const to: KinWorkPrincipal = input.to ?? { _tag: "person", personId: person.personId };
  // A teammate's task is read only inside the write (`teamGuard`), after the agent's chat is open.
  if (viewer.teammate) yield* teamAgent(person, to);
  else yield* inList(input.orgId, input.key, "work");
  const records = yield* KinRecords;
  // Read only to word the notices once the write is through; it decides nothing.
  const before = yield* records.get(input.orgId, input.key);
  const shown = yield* change(viewer, input.orgId, input.key, { owner: to }, input.rev);
  yield* tellMoved(person, before, yield* records.get(input.orgId, input.key));
  return shown;
});

/**
 * Someone gives or takes a task on their own screen: its holders see it on Tasks and hear it in
 * one banner (`tellOnTasks`), in no chat. The write already committed, so a failure fails nothing.
 */
export const tellMoved = (
  person: PersonIdentity,
  before: RecordRow | undefined,
  after: RecordRow | undefined,
) =>
  after === undefined
    ? Effect.void
    : tellOnScreen(person, `${after.recordId}:${after.rev}`, movedNotices(before, after));
export const tellOnScreen = Effect.fn("KinWork.tellOnScreen")(
  function* (person: PersonIdentity, change: string, all: ReadonlyArray<AssignNotice>) {
    const notices = all.filter((notice) => notice.personId !== person.personId);
    if (notices.length === 0) return;
    yield* tellOnTasks(
      {
        orgId: person.orgId,
        personId: person.personId,
        agentId: yield* theTeamAgent(person.orgId),
        change: `screen:${change}`,
      },
      notices,
    );
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin couldn't tell people about their tasks", cause),
  ),
);

/** Asks a person holding a task where it stands, once a day per task (`workMoves.nudge`). */
export const nudge = Effect.fn("KinWork.nudge")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkNudgeInput,
) {
  return yield* nudgeHolder(yield* viewerOf(people, input.orgId), input);
});

/** The holder gives the task back to whoever gave it to them; it may then be out of their view. */
export const handBack = Effect.fn("KinWork.handBack")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkHandBackInput,
) {
  const viewer = yield* viewerOf(people, input.orgId);
  const records = yield* KinRecords;
  const holder: KinWorkPrincipal = { _tag: "person", personId: viewer.person.personId };
  const row = yield* asViewer(
    viewer,
    records.handBack(input.orgId, writerOf(viewer), input.key, holder, input.note ?? null),
  );
  const to = toRecord(row, yield* Clock.currentTimeMillis).owner;
  // An agent it goes back to is woken by the write; a person sees it on Tasks.
  if (to._tag === "person")
    yield* tellOnScreen(viewer.person, `${row.recordId}:${row.rev}`, [
      { personId: to.personId, kind: "returned", row, why: input.note ?? null },
    ]);
  return { key: row.key, to };
});

const OPEN_STATES = ["open", "doing", "waiting"];

/**
 * Gives every open task `from` holds to `to`, each as one reassignment (`assign`), and tells each
 * person once for all of them. A task the write refuses this caller stays and is counted.
 */
export const handOver = Effect.fn("KinWork.handOver")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkHandOverInput,
) {
  const viewer = yield* viewerOf(people, input.orgId);
  const { person } = viewer;
  const fromId = principalId(input.from);
  if (viewer.teammate && !(input.from._tag === "person" && fromId === person.personId))
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Only the owner or a co-owner gives someone else's tasks away.",
    });
  const sql = yield* SqlClient.SqlClient;
  // Whoever holds a task sees it, and the owner level sees all: nothing listed here is hidden.
  // oxlint-disable-next-line t3code/kin-viewer-scoped-reads -- the holder's own tasks, or an owner-level caller's
  const held = yield* sql<{ key: string }>`SELECT key FROM kin_records
    WHERE org_id = ${input.orgId} AND register_id = 'work' AND owner_kind = ${input.from._tag}
      AND owner_id = ${fromId} AND state IN ${sql.in(OPEN_STATES)}
      ${input.keys === undefined ? sql`` : sql`AND key IN ${sql.in(input.keys.length === 0 ? [""] : input.keys)}`}
    ORDER BY key`.pipe(workFailure);
  // The count comes before anyone is chosen, so it names no receiver to check.
  if (input.dryRun === true) return { keys: held.map((row) => row.key), kept: 0 };
  if (samePrincipal(input.to, input.from))
    return yield* new KinChatError({
      reason: "invalid_state",
      message: "Choose someone else to give them to.",
    });
  if (viewer.teammate) yield* teamAgent(person, input.to);
  const records = yield* KinRecords;
  const moved: Array<string> = [];
  const notices: Array<AssignNotice> = [];
  let kept = 0;
  for (const { key } of held) {
    const before = yield* records.get(input.orgId, key);
    const outcome = yield* Effect.result(
      change(viewer, input.orgId, key, { owner: input.to }, undefined),
    );
    if (outcome._tag === "Failure") {
      if (outcome.failure.reason !== "not_allowed" && outcome.failure.reason !== "invalid_state")
        return yield* outcome.failure;
      kept += 1;
      continue;
    }
    moved.push(key);
    const after = yield* records.get(input.orgId, key);
    if (after !== undefined) notices.push(...movedNotices(before, after));
  }
  if (moved.length > 0)
    yield* tellOnScreen(
      person,
      `handover:${input.from._tag}:${fromId}:${moved.join(",")}`,
      notices,
    );
  return { keys: moved, kept };
});

/**
 * With a coding agent's connection, only a task its key reaches, and only its state (with who it
 * waits on); the change is marked with the key.
 */
export const update = Effect.fn("KinWork.update")(function* (
  people: ReadonlyArray<PersonIdentity>,
  // A coding agent sets a state without a revision, as its key always has.
  input: Omit<KinWorkUpdateInput, "rev"> & { readonly rev?: number },
  connection?: CodingAgentConnection,
) {
  if (connection !== undefined) {
    const { orgId, key, rev, state, waitingOn, ...rest } = input;
    if (Object.values(rest).some((value) => value !== undefined)) return yield* TEAM_REFUSED;
    const patch: Patch = {
      ...(state === undefined ? {} : { state }),
      ...(waitingOn === undefined ? {} : { waitingOn }),
    };
    return yield* throughConnection(people, connection, orgId, (viewer) =>
      change(viewer, orgId, key, patch, rev, connection),
    );
  }
  const viewer = yield* viewerOf(people, input.orgId);
  const { person } = viewer;
  // The rest of a teammate's patch is `teamGuard`'s: a project's lead may set more inside it.
  if (viewer.teammate && input.listCategory !== undefined) return yield* TEAM_REFUSED;
  const due: Patch =
    input.dueAt === undefined
      ? input.dueAllDay === undefined
        ? {}
        : { dueAllDay: input.dueAllDay }
      : input.dueAt === null
        ? { dueAt: null, dueAllDay: false }
        : {
            dueAt: yield* dueMillis(input.orgId, input.dueAt, input.dueAllDay),
            dueAllDay: input.dueAllDay === true,
          };
  const partyId = yield* refId(viewer, input.orgId, input.party, "clients");
  const projectId = yield* refId(viewer, input.orgId, input.project, "projects");
  // A teammate's task is read only inside the write, so an earlier read decides nothing.
  const row = viewer.teammate ? undefined : yield* inList(input.orgId, input.key, "work");
  const defined = row !== undefined && !isBuiltIn(row.registerId);
  if (
    row !== undefined &&
    !defined &&
    (input.fields !== undefined || input.listCategory !== undefined)
  )
    return yield* new KinChatError({
      reason: "invalid_state",
      message: `${row.key} is a Work entry; it has no list details or list category.`,
    });
  const sql = yield* SqlClient.SqlClient;
  const save = change(
    viewer,
    input.orgId,
    input.key,
    {
      ...(input.listCategory === undefined ? {} : { category: input.listCategory }),
      ...(input.fields === undefined ? {} : { fields: input.fields }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.waitingOn === undefined ? {} : { waitingOn: input.waitingOn }),
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(partyId === undefined ? {} : { partyId }),
      ...(projectId === undefined ? {} : { projectId }),
      ...(input.side === undefined ? {} : { side: input.side }),
      ...(input.repo === undefined ? {} : { repo: input.repo }),
      ...(input.sensitive === undefined ? {} : { sensitive: input.sensitive }),
      ...(input.amount === undefined ? {} : { amount: input.amount }),
      ...(input.amountConfirmed === false ? { askSlip: true } : {}),
      ...(input.repeat === undefined ? {} : { repeat: input.repeat }),
      ...(input.steps === undefined ? {} : { steps: input.steps }),
      ...(input.urgent === undefined ? {} : { urgent: input.urgent }),
      ...due,
      ...(input.dateAt === undefined
        ? input.dateAllDay === undefined
          ? {}
          : { dateAllDay: input.dateAllDay }
        : input.dateAt === null
          ? { dateAt: null, dateAllDay: false }
          : {
              dateAt: yield* dueMillis(input.orgId, input.dateAt, input.dateAllDay),
              dateAllDay: input.dateAllDay === true,
            }),
    },
    input.rev,
  );
  if (input.fields === undefined || row === undefined) return yield* save;
  // The files are checked and kept in one transaction, so none slips in between the two.
  return yield* sql
    .withTransaction(ownFiles(person, row.fieldsJson, input.fields).pipe(Effect.andThen(save)))
    .pipe(workFailure);
});

/** Ticks one of a task's steps, by whoever may change the task, through the same write. */
export const tickStep = Effect.fn("KinWork.tickStep")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkTickStepInput,
) {
  const viewer = yield* viewerOf(people, input.orgId);
  // A teammate's task is read only inside the write, so an earlier read decides nothing.
  if (!viewer.teammate) yield* inList(input.orgId, input.key, "work");
  const { index, title, done } = input;
  return yield* change(viewer, input.orgId, input.key, { tick: { index, title, done } }, undefined);
});

/** A web page's address as it is kept, or undefined for anything that isn't one. */
const webAddress = (text: string) => {
  try {
    const url = new URL(text.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Who a write is for and whose it is: each person it is done for passes the check their own screen
 * makes, and the change is recorded as the writer's. A person on their own screen is both.
 */
export type ActingBy = { readonly viewers: ReadonlyArray<Viewer>; readonly writer: Writer };
export const actingAs = Effect.fn("KinWork.actingAs")(function* (
  people: ReadonlyArray<PersonIdentity>,
  orgId: KinOrgId,
) {
  const viewer = yield* viewerOf(people, orgId);
  return { viewers: [viewer], writer: writerOf(viewer) } satisfies ActingBy;
});

/**
 * Changes an entry's `url` links in one transaction with the check that each viewer may edit it,
 * then answers with its sheet as the first sees it. One they can't see is unknown.
 */
const linkWrite = Effect.fn("KinWork.linkWrite")(function* (
  by: ActingBy,
  orgId: KinOrgId,
  key: string,
  write: (recordId: string) => Effect.Effect<boolean, KinChatError, KinRecords>,
) {
  const records = yield* KinRecords;
  const sql = yield* SqlClient.SqlClient;
  const [first] = by.viewers;
  if (first === undefined) return yield* ownerOnly;
  return yield* Effect.gen(function* () {
    const row = yield* found(orgId, { key });
    const now = yield* Clock.currentTimeMillis;
    for (const viewer of by.viewers) {
      if (!(yield* personSeesRecord(orgId, viewer.person.personId, row.recordId)))
        return yield* notFound(key);
      const can = (yield* cansOf(viewer, orgId, [
        { ...toRecord(row, now), registerId: row.registerId },
      ]))(row.recordId);
      if (can.links !== true)
        return yield* new KinChatError({
          reason: "not_allowed",
          message: "Only someone who may edit this can change its links.",
        });
    }
    yield* write(row.recordId);
    const after = yield* found(orgId, { key });
    return yield* shownTo(
      first,
      yield* records.detail(after, KIN_RECORD_CHANGES_CAP),
      after,
      after,
    );
  }).pipe(sql.withTransaction, workFailure);
});

/** "Add a link": a web page that relates to the entry, by whoever may edit it. */
export const addLinkBy = Effect.fn("KinWork.addLink")(function* (
  by: ActingBy,
  input: KinWorkLinkAddInput,
) {
  const target = webAddress(input.url);
  if (target === undefined)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: "A link needs a web address that starts with https:// or http://.",
    });
  const name = input.name?.trim() ?? "";
  const records = yield* KinRecords;
  return yield* linkWrite(by, input.orgId, input.key, (recordId) =>
    records.link(input.orgId, by.writer, recordId, {
      kind: "url",
      relation: "relates",
      target,
      label: name === "" ? null : name,
    }),
  );
});
export const addLink = (people: ReadonlyArray<PersonIdentity>, input: KinWorkLinkAddInput) =>
  actingAs(people, input.orgId).pipe(Effect.flatMap((by) => addLinkBy(by, input)));

/** Takes a web page's link off an entry, by whoever may edit it; one already gone is fine. */
export const removeLinkBy = Effect.fn("KinWork.removeLink")(function* (
  by: ActingBy,
  input: KinWorkLinkRemoveInput,
) {
  const records = yield* KinRecords;
  const sql = yield* SqlClient.SqlClient;
  return yield* linkWrite(by, input.orgId, input.key, (recordId) =>
    Effect.gen(function* () {
      const [made] = yield* sql<{ shown: string; at: number }>`SELECT
          COALESCE(label, target) AS shown, created_at AS at FROM kin_record_links
        WHERE org_id = ${input.orgId} AND record_id = ${recordId} AND kind = 'url'
          AND target IN (${input.url}, ${webAddress(input.url) ?? input.url})
        ORDER BY created_at LIMIT 1`.pipe(workFailure);
      if (made === undefined) return false;
      return yield* records.unlink(input.orgId, by.writer, recordId, {
        kind: "url",
        shown: made.shown,
        at: made.at,
      });
    }),
  );
});
export const removeLink = (people: ReadonlyArray<PersonIdentity>, input: KinWorkLinkRemoveInput) =>
  actingAs(people, input.orgId).pipe(Effect.flatMap((by) => removeLinkBy(by, input)));

/**
 * The files an owner's edit adds are ones the owner can read: each on a message, not deleted, in
 * a chat the owner is in. Anything else looks like no file at all.
 */
export const ownFiles = Effect.fn("KinWork.ownFiles")(function* (
  person: PersonIdentity,
  storedJson: string,
  fields: Readonly<Record<string, unknown>>,
) {
  const stored = parseFields(storedJson);
  const added = [
    ...new Set(
      Object.entries(fields).flatMap(([key, value]) =>
        Array.isArray(value)
          ? value.filter(
              (id): id is string => typeof id === "string" && !fieldList(stored, key).includes(id),
            )
          : [],
      ),
    ),
  ];
  if (added.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  const mine = yield* sql`SELECT a.attachment_id FROM kin_message_attachments a
    JOIN kin_messages ON kin_messages.org_id = a.org_id
      AND kin_messages.message_id = a.message_id
    JOIN kin_chat_members c ON c.org_id = a.org_id AND c.chat_id = a.chat_id
      AND c.principal_kind = 'person' AND c.person_id = ${person.personId} AND c.left_at IS NULL
    WHERE a.org_id = ${person.orgId} AND a.attachment_id IN ${sql.in(added)}
      AND kin_messages.status <> 'deleted'
      AND ${readableFrom(sql, person.orgId, sql`COALESCE(c.joined_seq, 0)`)}`;
  if (mine.length !== added.length)
    return yield* new KinChatError({ reason: "not_found", message: "No such file in your chats." });
});

/** Keeps a lead's suggestion: it counts as the owner's from now on. */
export const confirm = Effect.fn("KinWork.confirm")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkConfirmInput,
) {
  const person = yield* theOwner(people, input.orgId);
  return yield* change(
    { person, teammate: false },
    input.orgId,
    input.key,
    { confirmed: true },
    input.rev,
  );
});

/** Declines a lead's suggestion by dropping it; an entry the owner already kept is refused. */
export const decline = Effect.fn("KinWork.decline")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkConfirmInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const row = yield* found(input.orgId, input);
  if (row.confirmed === 1)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: `${row.key} is not a suggestion${isClosed(row.state) ? "" : "; drop it instead"}.`,
    });
  return yield* change(
    { person, teammate: false },
    input.orgId,
    input.key,
    { state: "dropped" },
    input.rev,
  );
});

const change = Effect.fn("KinWork.change")(function* (
  viewer: Viewer,
  orgId: KinOrgId,
  key: string,
  patch: Patch,
  rev: number | undefined,
  connection?: CodingAgentConnection,
) {
  const records = yield* KinRecords;
  return yield* asViewer(
    viewer,
    Effect.gen(function* () {
      if (connection !== undefined) {
        const held = yield* records.get(orgId, key);
        if (
          held === undefined ||
          !(yield* connectionReaches(connection, held.recordId).pipe(workFailure))
        )
          return yield* notFound(key);
      }
      const writer = writerOf(viewer);
      const row = yield* records.update(
        orgId,
        connection === undefined ? writer : { ...writer, codingAgentKey: connection.sessionId },
        key,
        patch,
        rev,
      );
      const detail = yield* records.detail(row, KIN_RECORD_CHANGES_CAP);
      // A lead may make something of their project private (`teamGuard`), even out of their view.
      return yield* shownTo(viewer, detail, row, row, undefined, patch.sensitive === true);
    }),
  );
});

/** Clients, contacts and projects are seen by place and by lead; a milestone by its project. */
const UNSHARED = new Set(["clients", "contacts", "projects", "milestones", "bank_transactions"]);

/**
 * The owner shares tasks with the team or takes them back; taken back, a task stays visible only
 * to the teammate who holds it, made it or gave it away. Labelling one sensitive hides it from all.
 */
export const share = Effect.fn("KinWork.share")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkShareInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const records = yield* KinRecords;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql
    .withTransaction(
      Effect.forEach([...new Set(input.keys)], (key) =>
        found(input.orgId, { key }).pipe(
          Effect.flatMap((row) =>
            UNSHARED.has(row.registerId)
              ? Effect.fail(
                  new KinChatError({
                    reason: "invalid_state",
                    message: `${key.slice(0, 40)} isn't shared on its own: tasks, docs and list entries are.`,
                  }),
                )
              : records.update(input.orgId, ownerWriter(person), key, { team: input.shared }),
          ),
        ),
      ),
    )
    .pipe(workFailure);
  const now = yield* Clock.currentTimeMillis;
  return { records: rows.map((row) => toRecord(row, now)) };
});

export const dueMillis = Effect.fn("KinWork.dueMillis")(function* (
  orgId: KinOrgId,
  dueAt: string,
  allDay: boolean | undefined,
) {
  return allDay === true && isCalendarDay(dueAt)
    ? endOfDay(dueAt, yield* ownerZone(orgId))
    : yield* millis(dueAt, "dueAt");
});

export const ownerWriter = (person: PersonIdentity): Writer => ({
  actor: { _tag: "person", personId: person.personId },
  via: "owner",
  askedBy: person.personId,
});
