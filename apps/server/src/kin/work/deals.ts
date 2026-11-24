import {
  KIN_CAMPAIGN_SOURCE,
  KinChatError,
  type KinDealAddStepInput,
  type KinDealCan,
  type KinDealConcern,
  type KinDealConcernCount,
  type KinDealCreateInput,
  type KinDealMove,
  type KinDealMoveInput,
  type KinDealNext,
  type KinDealNumbers,
  type KinDealPersonNumbers,
  type KinDealWeekRow,
  type KinDealPage,
  type KinDealPageInput,
  type KinDealQuote,
  type KinDealRow,
  type KinRecordRef,
  type KinDealsInput,
  type KinDealsResult,
  type KinDealStage,
  KinDealStage as KinDealStageSchema,
  type KinDealStagesResult,
  type KinDealStagesSetInput,
  type KinDealQuietDaysSetInput,
  type KinDealStepInput,
  type KinDealUpdateInput,
  type KinMoney,
  KinAgentId,
  type KinOrgId,
  type KinPersonId,
  KinRecordId,
  type KinRecordChange,
  type KinWorkPrincipal,
  KIN_DEALS_CAP,
  KIN_DEAL_STEP_FIELD,
  KIN_LEFT_FIELD,
  KIN_RECORD_CHANGES_CAP,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import * as KinWatches from "../watches/KinWatches.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import { type AssignNotice, movedNotices } from "./assignNotices.ts";
import { mayActAsOwner } from "../people/KinAccess.ts";
import { sectionOnFor as sectionOn } from "../shell/KinShell.ts";
import { DEALS_OFF } from "../shell/sections.ts";
import { campaignsNamed, dealsFromCampaign, sourceShown } from "./crm.ts";
import { DEFAULT_STAGES, stageLine, stageMove, stagesOf } from "./dealStages.ts";
import * as Docs from "./docs.ts";
import { WINNING_CUSTOMERS_ORIGIN } from "./playbookSeeds.ts";
import { playbookThreshold } from "./playbooks.ts";
import { fromsOf } from "./promises.ts";
import { KinRecords, requestHashOf, type Patch, type Writer } from "./KinRecords.ts";
import { fieldList, fieldText, isMoney, parseFields, type FieldValue } from "./lists.ts";
import { dayIn, monthOf, shiftMonth } from "./money.ts";
import { dueMillis, ownerWriter, tellOnScreen, viewerOf } from "./ownerWork.ts";
import {
  byId,
  byKey,
  endOfDay,
  iso,
  isSuggestion,
  notBouncedBack,
  ownerZone,
  parseChanges,
  principal,
  type RecordRow,
  samePrincipal,
  selectRecords,
  startOfDay,
  type StoredChange,
  toRecord,
  workFailure,
} from "./recordRows.ts";
import {
  crmSeenBy,
  crmVisible,
  KIN_OWNER_LEVEL,
  keyedViewer,
  placesOf,
  teamClients,
  teamSeesField,
  teamRecordIn,
  teamSeq,
  viewerOfPeople,
  type KinViewer,
} from "./teamView.ts";
import { DAY_MS } from "../durations.ts";

/**
 * KinDeals. Every rule is decided here, in the write's transaction, from stored rows; `KinRecords`
 * refuses a deal written any other way (`Writer.deal`). A member with Clients on adds deals on
 * clients they see and changes the ones they look after; Keep private stays the owner level's.
 */

/** Who a deal write is for: whose rules it follows, and who it is written as. */
export type DealActor = {
  readonly orgId: KinOrgId;
  readonly writer: Writer;
  /** Each person the checks run for; empty for the owner level. */
  readonly members: ReadonlyArray<KinPersonId>;
  /** Whoever a new deal and its follow-ups default to; null for an agent's own. */
  readonly person: KinPersonId | null;
};

const refused = (message: string) => new KinChatError({ reason: "not_allowed", message });
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const NO_CLIENTS = refused("Deals are for the owner, co-owners and teammates with Clients on.");
const NOT_YOURS_TO_GIVE = refused(
  "You add a deal you look after; the owner or a co-owner gives one to someone else.",
);
const OWNERS_LABEL = refused("Only the owner or a co-owner keeps a deal private.");
const notTheirs = (key: string) =>
  refused(`Only whoever looks after ${key}, the owner or a co-owner changes it.`);
const VENDOR = invalid("A deal is with a client or prospect, never a vendor.");
const closedParty = (key: string) =>
  invalid(`${key} is closed. Reopen it before adding a deal to it.`);
const unknownStage = (id: string, stages: ReadonlyArray<KinDealStage>) =>
  invalid(
    `No stage ${id.slice(0, 40)}. The stages are ${stages.map((s) => `${s.name} (${s.id})`).join(", ")}.`,
  );
const notADeal = (key: string) =>
  new KinChatError({ reason: "not_found", message: `No deal ${key.slice(0, 40)}.` });

const me = (personId: KinPersonId): KinWorkPrincipal => ({ _tag: "person", personId });
const ownerOf = (row: RecordRow): KinWorkPrincipal =>
  principal(row.ownerKind, row.ownerId) ?? { _tag: "agent", agentId: KinAgentId.make(row.ownerId) };
const looksAfter = (row: RecordRow, personId: KinPersonId) =>
  samePrincipal(principal(row.ownerKind, row.ownerId), me(personId));

/** A person calling from their own app. */
const personActor = Effect.fn("KinDeals.personActor")(function* (
  people: ReadonlyArray<PersonIdentity>,
  orgId: KinOrgId,
) {
  const viewer = yield* viewerOf(people, orgId);
  return {
    actor: {
      orgId,
      writer: { ...ownerWriter(viewer.person), deal: true },
      members: viewer.teammate ? [viewer.person.personId] : [],
      person: viewer.person.personId,
    } satisfies DealActor,
    viewer: viewer.teammate ? viewerOfPeople([viewer.person.personId]) : KIN_OWNER_LEVEL,
    person: viewer.person,
  };
});

/** An agent's write: as each person its turn is read by, or the owner level in his own turns. */
export const agentActor = Effect.fn("KinDeals.agentActor")(function* (
  orgId: KinOrgId,
  writer: Writer,
) {
  const { owner } = yield* KinIdentity;
  const members: Array<KinPersonId> = [];
  for (const person of writer.view?.people ?? [])
    if (!(yield* mayActAsOwner(orgId, person, owner).pipe(workFailure))) members.push(person);
  const { view: _view, teammate: _teammate, ...plain } = writer;
  return {
    orgId,
    writer: { ...plain, deal: true },
    members,
    person: writer.askedBy ?? null,
  } satisfies DealActor;
});

/** The Clients switch, for each member: off is no deals at all. */
export const switchedOn = Effect.fn("KinDeals.switchedOn")(function* (
  orgId: KinOrgId,
  members: ReadonlyArray<KinPersonId>,
) {
  for (const personId of members)
    if (!(yield* placesOf(orgId, personId)).clients) return yield* NO_CLIENTS;
});

/** A deal by key, as every member here sees it; one they don't is no deal at all. */
const dealIn = Effect.fn("KinDeals.dealIn")(function* (actor: DealActor, key: string) {
  yield* switchedOn(actor.orgId, actor.members);
  const row = yield* byKey(actor.orgId, key);
  if (row === undefined || row.registerId !== "deals") return yield* notADeal(key);
  for (const personId of actor.members)
    if (!(yield* crmVisible(actor.orgId, personId, [row.recordId])).has(row.recordId))
      return yield* notADeal(key);
  return row;
});
/** `dealIn`, and each member looks after it. */
const theirDeal = Effect.fn("KinDeals.theirDeal")(function* (actor: DealActor, key: string) {
  const row = yield* dealIn(actor, key);
  for (const personId of actor.members)
    if (!looksAfter(row, personId)) return yield* notTheirs(row.key);
  return row;
});

/** A client by key, as every member here sees it through their Clients switch. */
const seenParty = Effect.fn("KinDeals.seenParty")(function* (actor: DealActor, key: string) {
  yield* switchedOn(actor.orgId, actor.members);
  const missing = new KinChatError({
    reason: "not_found",
    message: `No client or prospect ${key.slice(0, 40)}.`,
  });
  const row = yield* byKey(actor.orgId, key);
  if (row === undefined || row.registerId !== "clients") return yield* missing;
  for (const personId of actor.members)
    if (!(yield* teamClients(actor.orgId, personId, [row.recordId])).has(row.recordId))
      return yield* missing;
  return row;
});
/** One a deal may be added to: open, and a client or prospect, never a vendor. */
const partyFor = Effect.fn("KinDeals.partyFor")(function* (actor: DealActor, key: string) {
  const row = yield* seenParty(actor, key);
  if (row.category === "vendor") return yield* VENDOR;
  if (row.state === "dropped") return yield* closedParty(row.key);
  return row;
});

/** A quote to link: in the quotes list, the deal's client's (or no one's), seen by each member. */
const quoteFor = Effect.fn("KinDeals.quoteFor")(function* (
  actor: DealActor,
  key: string,
  partyId: string,
) {
  const row = yield* byKey(actor.orgId, key);
  const missing = new KinChatError({
    reason: "not_found",
    message: `No quote ${key.slice(0, 40)}.`,
  });
  if (row === undefined || row.registerId !== "quotes") return yield* missing;
  for (const personId of actor.members)
    if (!(yield* crmVisible(actor.orgId, personId, [row.recordId])).has(row.recordId))
      return yield* missing;
  if (row.partyId !== null && row.partyId !== partyId)
    return yield* invalid(`${row.key} is another client's quote.`);
  return row;
});

/** A concern as stored: its label, or its label, ": " and what was heard. */
const concernOf = (item: string): KinDealConcern => {
  const at = item.indexOf(": ");
  const label = (at < 0 ? item : item.slice(0, at)).replace(/\s+/g, " ").trim();
  const heard =
    at < 0
      ? ""
      : item
          .slice(at + 2)
          .replace(/\s+/g, " ")
          .trim();
  return heard === "" ? { label } : { label, heard };
};
/** Two labels that read the same are one concern. */
const foldConcern = (label: string) =>
  label.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const CONCERN_LABEL_MAX = 80;
const CONCERN_HEARD_MAX = 200;
const CONCERNS_MAX = 10;
/** The concerns a write gives, as stored; empty or null clears them. */
const concernsFor = Effect.fn("KinDeals.concernsFor")(function* (
  items: ReadonlyArray<string> | null,
) {
  if (items === null || items.length === 0) return null;
  if (items.length > CONCERNS_MAX)
    return yield* invalid(`A deal holds at most ${CONCERNS_MAX} concerns.`);
  const seen = new Set<string>();
  const stored: Array<string> = [];
  for (const item of items) {
    const concern = concernOf(item);
    if (concern.label === "" || concern.label.length > CONCERN_LABEL_MAX)
      return yield* invalid(
        `A concern is a short label of at most ${CONCERN_LABEL_MAX} characters.`,
      );
    if ((concern.heard?.length ?? 0) > CONCERN_HEARD_MAX)
      return yield* invalid(`What was heard is at most ${CONCERN_HEARD_MAX} characters a concern.`);
    const folded = foldConcern(concern.label);
    if (seen.has(folded)) return yield* invalid(`${concern.label} is given twice.`);
    seen.add(folded);
    stored.push(concern.heard === undefined ? concern.label : `${concern.label}: ${concern.heard}`);
  }
  return stored;
});

/** A concerns change's labels before and after, one a line, kept on its history line. */
const concernNames = (row: RecordRow, after: ReadonlyArray<string> | null) => {
  const labels = (items: ReadonlyArray<string>) =>
    items.length === 0 ? null : items.map((item) => concernOf(item).label).join("\n");
  return {
    from: labels(fieldList(parseFields(row.fieldsJson), "concerns")),
    to: labels(after ?? []),
  };
};

const liveStage = (stages: ReadonlyArray<KinDealStage>, id: string) =>
  stages.some((stage) => stage.id === id) ? Effect.void : Effect.fail(unknownStage(id, stages));

const expectedAt = Effect.fn("KinDeals.expectedAt")(function* (
  orgId: KinOrgId,
  day: string | null | undefined,
) {
  if (day === undefined) return {};
  if (day === null) return { dueAt: null, dueAllDay: false };
  return { dueAt: endOfDay(day, yield* ownerZone(orgId)), dueAllDay: true };
});

const stepDue = Effect.fn("KinDeals.stepDue")(function* (orgId: KinOrgId, step: KinDealStepInput) {
  return {
    dueAt: step.dueAt === undefined ? null : yield* dueMillis(orgId, step.dueAt, step.dueAllDay),
    dueAllDay: step.dueAt !== undefined && step.dueAllDay === true,
  };
});

/** A follow-up of ours on the deal's client, linked to the deal, in the caller's transaction. */
const addStep = Effect.fn("KinDeals.addStep")(function* (
  actor: DealActor,
  deal: RecordRow,
  step: KinDealStepInput,
  originKey: string,
  holder: KinWorkPrincipal = actor.person === null ? ownerOf(deal) : me(actor.person),
) {
  const records = yield* KinRecords;
  return yield* records.create(actor.orgId, actor.writer, {
    originKey,
    requestHash: requestHashOf({ clientRequestId: originKey, ...step }),
    title: step.title,
    owner: holder,
    category: "task",
    side: "ours",
    partyId: deal.partyId,
    ...(yield* stepDue(actor.orgId, step)),
    links: [{ kind: "record", target: deal.recordId, relation: "relates" }],
  });
});

/** What a new deal is, from its caller: refs already resolved to rows here. */
export type DealDraft = {
  readonly partyKey: string;
  readonly title: string;
  readonly stage?: string | undefined;
  readonly value?: KinMoney | undefined;
  readonly dueAt?: number | null | undefined;
  readonly dueAllDay?: boolean | undefined;
  readonly source?: string | undefined;
  readonly owner?: KinWorkPrincipal | undefined;
  readonly sensitive?: boolean | undefined;
  readonly notes?: string | undefined;
  readonly quoteKey?: string | undefined;
  readonly next?: KinDealStepInput | undefined;
  readonly concerns?: ReadonlyArray<string> | undefined;
  readonly originKey: string;
  readonly requestHash?: string | undefined;
};

/**
 * Makes a deal, and its first next step when given, in one transaction. A retry makes one. The
 * step written with the deal is its keeper's, whoever wrote it; `notices` tells them it is theirs.
 */
export const createAs = Effect.fn("KinDeals.create")(function* (
  actor: DealActor,
  draft: DealDraft,
) {
  const records = yield* KinRecords;
  const party = yield* partyFor(actor, draft.partyKey);
  const owner = draft.owner ?? (actor.person === null ? null : me(actor.person));
  if (owner === null) return yield* invalid("Say who looks after the deal.");
  for (const personId of actor.members)
    if (!samePrincipal(owner, me(personId))) return yield* NOT_YOURS_TO_GIVE;
  if (draft.sensitive !== undefined && actor.members.length > 0) return yield* OWNERS_LABEL;
  const { stages } = yield* stagesOf(actor.orgId);
  const stage = draft.stage ?? stages[0]?.id ?? DEFAULT_STAGES[0]!.id;
  yield* liveStage(stages, stage);
  const quote =
    draft.quoteKey === undefined
      ? undefined
      : yield* quoteFor(actor, draft.quoteKey, party.recordId);
  const source = draft.source ?? fieldText(parseFields(party.fieldsJson), "source") ?? undefined;
  const concerns = draft.concerns === undefined ? null : yield* concernsFor(draft.concerns);
  const fields: Record<string, FieldValue> = {
    stage,
    ...(draft.value === undefined ? {} : { value: draft.value }),
    ...(source === undefined ? {} : { source }),
    ...(concerns === null ? {} : { concerns }),
  };
  const { row, created } = yield* records.create(actor.orgId, actor.writer, {
    list: "deals",
    originKey: draft.originKey,
    ...(draft.requestHash === undefined ? {} : { requestHash: draft.requestHash }),
    title: draft.title,
    owner,
    partyId: party.recordId,
    ...(draft.dueAt === undefined || draft.dueAt === null
      ? {}
      : { dueAt: draft.dueAt, dueAllDay: draft.dueAllDay === true }),
    ...(draft.notes === undefined ? {} : { notes: draft.notes }),
    ...(draft.sensitive === undefined ? {} : { sensitive: draft.sensitive }),
    fields,
    ...(quote === undefined
      ? {}
      : {
          links: [
            { kind: "record", target: quote.recordId, relation: "relates", label: quote.key },
          ],
        }),
  });
  // Decided on the stored row, so the one rule is a hand-over's; a refusal rolls the write back.
  yield* seesItAfter(actor.orgId, row, owner, "the new deal");
  const step =
    draft.next === undefined
      ? undefined
      : yield* addStep(actor, row, draft.next, `${draft.originKey}-next`, owner);
  return {
    row,
    created,
    notices: step?.created === true ? movedNotices(undefined, step.row) : [],
  };
});

/** The change a caller asks for, refs resolved; `undefined` leaves a field as it is. */
export type DealChange = {
  readonly title?: string | undefined;
  readonly notes?: string | undefined;
  readonly value?: KinMoney | null | undefined;
  readonly dueAt?: number | null | undefined;
  readonly dueAllDay?: boolean | undefined;
  readonly source?: string | null | undefined;
  readonly owner?: KinWorkPrincipal | undefined;
  readonly sensitive?: boolean | undefined;
  readonly quoteKey?: string | null | undefined;
  /** The whole list as it should stand; null or empty clears it. */
  readonly concerns?: ReadonlyArray<string> | null | undefined;
};

/** Changes what a deal says, hands it over or links its quote; never its stage or state. */
export const updateAs = Effect.fn("KinDeals.update")(function* (
  actor: DealActor,
  key: string,
  change: DealChange,
  rev?: number,
) {
  const records = yield* KinRecords;
  const row = yield* theirDeal(actor, key);
  if (change.sensitive !== undefined && actor.members.length > 0) return yield* OWNERS_LABEL;
  const concerns = change.concerns === undefined ? undefined : yield* concernsFor(change.concerns);
  const fields: Record<string, FieldValue | null> = {
    ...(change.value === undefined ? {} : { value: change.value }),
    ...(change.source === undefined ? {} : { source: change.source }),
    ...(concerns === undefined ? {} : { concerns }),
  };
  const patch: Patch = {
    ...(concerns === undefined ? {} : { names: { concerns: concernNames(row, concerns) } }),
    ...(change.title === undefined ? {} : { title: change.title }),
    ...(change.notes === undefined ? {} : { notes: change.notes }),
    ...(change.dueAt === undefined
      ? {}
      : { dueAt: change.dueAt, dueAllDay: change.dueAt !== null && change.dueAllDay === true }),
    ...(change.owner === undefined ? {} : { owner: change.owner }),
    ...(change.sensitive === undefined ? {} : { sensitive: change.sensitive }),
    ...(Object.keys(fields).length === 0 ? {} : { fields }),
  };
  const steps = change.owner === undefined ? [] : yield* keepersSteps(actor, row, change.owner);
  const after =
    Object.keys(patch).length === 0
      ? row
      : yield* records.update(
          actor.orgId,
          actor.writer,
          row.key,
          patch,
          rev,
          steps.map((step) => ({
            field: KIN_DEAL_STEP_FIELD,
            from: null,
            to: step.key,
            names: { from: null, to: `${step.key} ${step.title}` },
          })),
        );
  if (change.owner !== undefined) yield* seesItAfter(actor.orgId, after, change.owner);
  if (change.quoteKey !== undefined) yield* relinkQuote(actor, after, change.quoteKey);
  const notices: Array<AssignNotice> = [];
  for (const step of steps) {
    const moved = yield* records.update(actor.orgId, actor.writer, step.key, {
      owner: change.owner!,
    });
    notices.push(...movedNotices(step, moved));
  }
  return { row: after, notices };
});

const keepersSteps = Effect.fn("KinDeals.keepersSteps")(function* (
  actor: DealActor,
  deal: RecordRow,
  to: KinWorkPrincipal,
) {
  if (samePrincipal(to, ownerOf(deal))) return [];
  const { orgId, writer } = actor;
  const byOwner =
    actor.members.length === 0 &&
    writer.actor._tag === "person" &&
    writer.via === "owner" &&
    writer.codingAgentKey === undefined &&
    writer.wakeupId === undefined;
  const turn =
    writer.actor._tag === "agent" && writer.wakeupId !== undefined
      ? { agentId: writer.actor.agentId, wakeupId: writer.wakeupId }
      : undefined;
  const sql = yield* SqlClient.SqlClient;
  const keys = yield* sql<{ key: string }>`SELECT r.key FROM kin_record_links l
      JOIN kin_records r ON r.org_id = l.org_id AND r.record_id = l.record_id
    WHERE l.org_id = ${orgId} AND l.kind = 'record' AND l.target = ${deal.recordId}
      AND r.register_id = 'work' AND r.state IN ('open', 'doing', 'waiting') AND r.side = 'ours'
      AND r.sensitive = 0 AND r.owner_kind = ${deal.ownerKind} AND r.owner_id = ${deal.ownerId}
    GROUP BY r.key ORDER BY r.key`.pipe(workFailure);
  const steps: Array<RecordRow> = [];
  for (const { key } of keys) {
    const step = yield* byKey(orgId, key).pipe(workFailure);
    if (
      step !== undefined &&
      (byOwner || (yield* notBouncedBack(orgId, step, to, turn)) === undefined)
    )
      steps.push(step);
  }
  return steps;
});

/** Whoever looks after a deal must see it: owner level, or Clients on and in their Clients. */
const seesItAfter = Effect.fn("KinDeals.seesItAfter")(function* (
  orgId: KinOrgId,
  deal: RecordRow,
  to: KinWorkPrincipal,
  named: string = deal.key,
) {
  if (to._tag !== "person") return;
  const { owner } = yield* KinIdentity;
  if (yield* mayActAsOwner(orgId, to.personId, owner).pipe(workFailure)) return;
  const sees =
    (yield* placesOf(orgId, to.personId)).clients &&
    (yield* crmVisible(orgId, to.personId, [deal.recordId])).has(deal.recordId);
  if (sees) return;
  const sql = yield* SqlClient.SqlClient;
  const [person] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
    WHERE org_id = ${orgId} AND person_id = ${to.personId}`;
  return yield* invalid(
    `${person?.name ?? "They"} can't see ${named}: give it to the owner, a co-owner or someone with Clients on who sees its client.`,
  );
});

const relinkQuote = Effect.fn("KinDeals.relinkQuote")(function* (
  actor: DealActor,
  deal: RecordRow,
  quoteKey: string | null,
) {
  const records = yield* KinRecords;
  const sql = yield* SqlClient.SqlClient;
  const quote =
    quoteKey === null ? undefined : yield* quoteFor(actor, quoteKey, deal.partyId ?? "");
  const linked = yield* sql<{ target: string; shown: string; at: number }>`SELECT l.target,
      COALESCE(l.label, l.target) AS shown, l.created_at AS at
    FROM kin_record_links l JOIN kin_records q ON q.org_id = l.org_id AND q.record_id = l.target
    WHERE l.org_id = ${actor.orgId} AND l.record_id = ${deal.recordId} AND l.kind = 'record'
      AND q.register_id = 'quotes'
    ORDER BY l.created_at, l.target`;
  for (const link of linked)
    if (link.target !== quote?.recordId)
      yield* records.unlink(actor.orgId, actor.writer, deal.recordId, {
        kind: "record",
        shown: link.shown,
        at: link.at,
      });
  if (quote !== undefined && !linked.some((link) => link.target === quote.recordId))
    yield* records.link(actor.orgId, actor.writer, deal.recordId, {
      kind: "record",
      target: quote.recordId,
      relation: "relates",
      label: quote.key,
    });
});

/**
 * Moves a deal: to a live stage while open, to won or lost (lost keeps its one line of reason),
 * or back to open in its last stage. Winning makes its prospect a client in the same step,
 * logged on the client; reopening leaves the client a client. The same move again changes nothing.
 */
export const moveAs = Effect.fn("KinDeals.move")(function* (
  actor: DealActor,
  key: string,
  to: KinDealMove,
  rev?: number,
) {
  const records = yield* KinRecords;
  const row = yield* theirDeal(actor, key);
  const { stages } = yield* stagesOf(actor.orgId);
  const stage = fieldText(parseFields(row.fieldsJson), "stage");
  const update = (patch: Patch) => records.update(actor.orgId, actor.writer, row.key, patch, rev);
  switch (to._tag) {
    case "stage": {
      yield* liveStage(stages, to.stage);
      if (row.state !== "open")
        return yield* invalid(
          `${row.key} is ${row.state === "done" ? "won" : "lost"}. Reopen it to move it.`,
        );
      if (stage === to.stage) return { row, becameClient: false };
      return { row: yield* update(stageMove(stages, stage, to.stage)), becameClient: false };
    }
    case "won": {
      if (row.state === "done") return { row, becameClient: false };
      if (row.state !== "open") return yield* invalid(`${row.key} is lost. Reopen it first.`);
      const won = yield* update({ state: "done" });
      const party = row.partyId === null ? undefined : yield* byId(actor.orgId, row.partyId);
      if (party === undefined || party.category !== "prospect")
        return { row: won, becameClient: false };
      yield* records.update(actor.orgId, actor.writer, party.key, { category: "client" });
      return { row: won, becameClient: true };
    }
    case "lost": {
      const reason = to.reason.trim();
      if (reason === "") return yield* invalid("Say in a line why it was lost.");
      if (
        row.state === "dropped" &&
        fieldText(parseFields(row.fieldsJson), "lostReason") === reason
      )
        return { row, becameClient: false };
      if (row.state !== "open") return yield* invalid(`${row.key} is won. Reopen it first.`);
      return {
        row: yield* update({ state: "dropped", fields: { lostReason: reason } }),
        becameClient: false,
      };
    }
    case "reopen": {
      if (row.state === "open") return { row, becameClient: false };
      const back =
        stage !== null && stages.some((one) => one.id === stage)
          ? stage
          : (stages[0]?.id ?? DEFAULT_STAGES[0]!.id);
      return {
        row: yield* update({
          state: "open",
          fields: { stage: back, ...(row.state === "dropped" ? { lostReason: null } : {}) },
          names: stageMove(stages, stage, back).names,
        }),
        becameClient: false,
      };
    }
  }
});

/** A follow-up on a deal, by whoever may change it. A retry makes one. */
export const stepAs = Effect.fn("KinDeals.step")(function* (
  actor: DealActor,
  key: string,
  step: KinDealStepInput,
  originKey: string,
) {
  const row = yield* theirDeal(actor, key);
  yield* addStep(actor, row, step, originKey);
  return row;
});

// Reads.

const dealState = (state: RecordRow["state"]) =>
  state === "done" ? ("won" as const) : state === "dropped" ? ("lost" as const) : ("open" as const);

const NOTHING_CAN: KinDealCan = { edit: false, move: false, give: false, mark: false };
const ALL_CAN: KinDealCan = { edit: true, move: true, give: true, mark: true };
const canFor = (viewer: KinViewer, row: RecordRow): KinDealCan => {
  if (viewer._tag === "ownerLevel") return ALL_CAN;
  return viewer.people.every((personId) => looksAfter(row, personId))
    ? { edit: true, move: true, give: true, mark: false }
    : NOTHING_CAN;
};

/**
 * Open follow-ups linked to these deals that this viewer reads in Clients (`crmSeenBy`), soonest
 * first, the deal's own steps before its promises at the head (its `next`), and the deals that
 * have such a step this viewer doesn't read (`hidden`): only that.
 */
const stepsFor = Effect.fn("KinDeals.steps")(function* (
  orgId: KinOrgId,
  viewer: KinViewer,
  dealIds: ReadonlyArray<string>,
  now: number,
) {
  const out = new Map<string, Array<KinDealNext>>();
  const hidden = new Set<string>();
  if (dealIds.length === 0) return { steps: out, hidden };
  const promises = new Set<string>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    dealId: string;
    key: string;
    title: string;
    dueAt: number | null;
    dueAllDay: number;
    seen: number;
    promise: number;
  }>`SELECT l.target AS "dealId", r.key, r.title, r.due_at AS "dueAt",
      r.due_all_day AS "dueAllDay", CASE WHEN ${crmSeenBy(sql, viewer)} THEN 1 ELSE 0 END AS seen,
      COALESCE(r.category = 'obligation', 0) AS promise
    FROM kin_record_links l JOIN kin_records r ON r.org_id = l.org_id AND r.record_id = l.record_id
    WHERE l.org_id = ${orgId} AND l.kind = 'record' AND l.target IN ${sql.in([...dealIds])}
      AND r.register_id = 'work' AND r.state NOT IN ('done', 'dropped') AND r.side = 'ours'
    ORDER BY r.due_at IS NULL, r.due_at, r.created_at, r.key`;
  for (const row of rows) {
    if (row.seen !== 1) {
      hidden.add(row.dealId);
      continue;
    }
    const steps = out.get(row.dealId) ?? [];
    if (steps.some((step) => step.key === row.key)) continue;
    const step: KinDealNext = {
      key: row.key,
      title: row.title as KinDealNext["title"],
      dueAt: row.dueAt === null ? null : iso(row.dueAt),
      dueAllDay: row.dueAllDay === 1,
      late: row.dueAt !== null && row.dueAt < now,
    };
    steps.push(step);
    if (row.promise === 1) promises.add(row.key);
    out.set(row.dealId, steps);
  }
  for (const steps of out.values()) {
    const own = steps.findIndex((step) => !promises.has(step.key));
    if (own > 0) steps.unshift(...steps.splice(own, 1));
  }
  return { steps: out, hidden };
});

/** The newest linked quote of each deal that this viewer may see. */
const quotesFor = Effect.fn("KinDeals.quotes")(function* (
  orgId: KinOrgId,
  viewer: KinViewer,
  dealIds: ReadonlyArray<string>,
) {
  const out = new Map<string, KinDealQuote>();
  if (dealIds.length === 0) return out;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    dealId: string;
    recordId: string;
    key: string;
    title: string;
    state: string;
  }>`SELECT l.record_id AS "dealId", r.record_id AS "recordId", r.key, r.title, r.state
    FROM kin_record_links l JOIN kin_records r ON r.org_id = l.org_id AND r.record_id = l.target
    WHERE l.org_id = ${orgId} AND l.kind = 'record' AND l.record_id IN ${sql.in([...dealIds])}
      AND r.register_id = 'quotes' AND ${crmSeenBy(sql, viewer)}
    ORDER BY l.created_at DESC, r.key`;
  for (const row of rows)
    if (!out.has(row.dealId))
      out.set(row.dealId, {
        recordId: KinRecordId.make(row.recordId),
        key: row.key,
        title: row.title as KinDealQuote["title"],
        accepted: row.state === "done",
      });
  return out;
});

/** The deal's client's quotes this viewer may see, newest first: what Edit offers to link. */
const quoteChoices = Effect.fn("KinDeals.quoteChoices")(function* (
  orgId: KinOrgId,
  viewer: KinViewer,
  deal: RecordRow,
) {
  if (deal.partyId === null) return [];
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ recordId: string; key: string; title: string; state: string }>`SELECT
      r.record_id AS "recordId", r.key, r.title, r.state FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'quotes' AND r.party_id = ${deal.partyId}
      AND ${crmSeenBy(sql, viewer)}
    ORDER BY r.created_at DESC, r.key LIMIT ${KIN_DEAL_QUOTES_CAP}`;
  return rows.map((row): KinDealQuote => ({
    recordId: KinRecordId.make(row.recordId),
    key: row.key,
    title: row.title as KinDealQuote["title"],
    accepted: row.state === "done",
  }));
});
const KIN_DEAL_QUOTES_CAP = 50;

/** Quotes are Money's: the owner level, and members whose Money place it is, read them. */
const readsQuotes = Effect.fn("KinDeals.readsQuotes")(function* (
  orgId: KinOrgId,
  actor: DealActor,
) {
  for (const personId of actor.members)
    if (!(yield* placesOf(orgId, personId).pipe(workFailure)).reaches.money) return false;
  return true;
});

const dealOf = (
  row: RecordRow,
  viewer: KinViewer,
  steps: ReadonlyArray<KinDealNext> | undefined,
  nextHidden: boolean,
  quote: KinDealQuote | undefined,
  campaigns: ReadonlyMap<string, KinRecordRef> = new Map(),
): KinDealRow => {
  const fields = parseFields(row.fieldsJson);
  const value = fields.value;
  const source = fieldText(fields, "source");
  const lostReason = fieldText(fields, "lostReason");
  const concerns = fieldList(fields, "concerns").map(concernOf);
  return {
    recordId: KinRecordId.make(row.recordId),
    key: row.key,
    title: row.title as KinDealRow["title"],
    state: dealState(row.state),
    stage: fieldText(fields, "stage"),
    ...(value !== undefined && isMoney(value) ? { value } : {}),
    expectedAt: row.dueAt === null ? null : iso(row.dueAt),
    expectedAllDay: row.dueAllDay === 1,
    party: {
      recordId: KinRecordId.make(row.partyId ?? ""),
      key: row.partyKey ?? "",
      title: (row.partyTitle ?? "") as KinDealRow["party"]["title"],
      ...(row.partyCategory === "prospect" ? { prospect: true as const } : {}),
    },
    owner: ownerOf(row),
    ...(source === null ? {} : { source: sourceShown(source, campaigns).source! }),
    ...(lostReason === null || row.state !== "dropped"
      ? {}
      : { lostReason: lostReason as KinDealRow["title"] }),
    sensitive: row.sensitive === 1 || row.inheritedSensitive === 1,
    next: steps?.[0] ?? null,
    ...(steps === undefined && nextHidden ? { nextHidden: true } : {}),
    ...(quote === undefined ? {} : { quote }),
    ...(concerns.length === 0 ? {} : { concerns }),
    can: canFor(viewer, row),
    rev: row.rev,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    closedAt: row.closedAt === null ? null : iso(row.closedAt),
  };
};

/** These rows as deals for this viewer, with their next steps and quotes. */
const dealsOut = Effect.fn("KinDeals.out")(function* (
  orgId: KinOrgId,
  viewer: KinViewer,
  rows: ReadonlyArray<RecordRow>,
) {
  const now = yield* Clock.currentTimeMillis;
  const ids = rows.map((row) => row.recordId);
  const { steps, hidden } = yield* stepsFor(orgId, viewer, ids, now);
  const quotes = yield* quotesFor(orgId, viewer, ids);
  const campaigns = yield* campaignsNamed(
    orgId,
    rows.map((row) => fieldText(parseFields(row.fieldsJson), "source")),
    viewer,
  );
  return rows.map((row) =>
    dealOf(
      row,
      viewer,
      steps.get(row.recordId),
      hidden.has(row.recordId),
      quotes.get(row.recordId),
      campaigns,
    ),
  );
});

/**
 * These rows' deals as their pages show this viewer, by key, each with its stage's name: what an
 * agent reads of a deal, by the screen's own function and reader.
 */
export const asShown = Effect.fn("KinDeals.asShown")(function* (
  orgId: KinOrgId,
  viewer: KinViewer,
  rows: ReadonlyArray<RecordRow>,
) {
  const deals = rows.filter((row) => row.registerId === "deals");
  if (deals.length === 0) return new Map<string, KinDealRow & { readonly stageName: string }>();
  const { stages } = yield* stagesOf(orgId).pipe(workFailure);
  const shown = yield* dealsOut(orgId, viewer, deals).pipe(workFailure);
  return new Map(
    shown.map((deal) => [
      deal.key,
      {
        ...deal,
        stageName: stages.find((stage) => stage.id === deal.stage)?.name ?? deal.stage ?? "",
      },
    ]),
  );
});

const KIN_DEAL_CONCERNS_CAP = 50;
const decodeConcerns = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
/**
 * The concerns raised on the deals `where` selects, by folded label: how many deals raised each
 * and how many of those are open, won and lost, most deals first. Every deal counts once a label.
 */
const concernCounts = Effect.fn("KinDeals.concerns")(function* (
  where: ReadonlyArray<Statement.Fragment>,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ state: string; concerns: string }>`SELECT r.state,
      json_extract(r.fields_json, '$.concerns') AS concerns FROM kin_records r
    WHERE ${sql.and([...where, sql`json_type(r.fields_json, '$.concerns') = 'array'`])}
    ORDER BY r.created_at, r.key`;
  const counts = new Map<
    string,
    { label: string; deals: number; open: number; won: number; lost: number }
  >();
  for (const row of rows) {
    const labels = new Map<string, string>();
    for (const item of Option.getOrElse(decodeConcerns(row.concerns), () => [])) {
      const { label } = concernOf(item);
      if (label !== "" && !labels.has(foldConcern(label))) labels.set(foldConcern(label), label);
    }
    for (const [folded, label] of labels) {
      const count = counts.get(folded) ?? { label, deals: 0, open: 0, won: 0, lost: 0 };
      count.deals += 1;
      if (row.state === "done") count.won += 1;
      else if (row.state === "dropped") count.lost += 1;
      else count.open += 1;
      counts.set(folded, count);
    }
  }
  const all = [...counts.values()].toSorted(
    (a, b) => b.deals - a.deals || a.label.localeCompare(b.label),
  ) satisfies ReadonlyArray<KinDealConcernCount>;
  return {
    concerns: all.slice(0, KIN_DEAL_CONCERNS_CAP),
    more: all.length > KIN_DEAL_CONCERNS_CAP,
  };
});

const encodeIdList = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeIds = (ids: ReadonlyArray<string>) => encodeIdList(ids).pipe(Effect.orDie);
/** The deals `where` selects that raised this concern, by folded label as `concernCounts` counts. */
const raisedIn = Effect.fn("KinDeals.raisedIn")(function* (
  where: ReadonlyArray<Statement.Fragment>,
  label: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const folded = foldConcern(label);
  const rows = yield* sql<{ recordId: string; concerns: string }>`SELECT r.record_id AS "recordId",
      json_extract(r.fields_json, '$.concerns') AS concerns FROM kin_records r
    WHERE ${sql.and([...where, sql`json_type(r.fields_json, '$.concerns') = 'array'`])}
    ORDER BY r.created_at, r.key`;
  return rows.flatMap((row) =>
    Option.getOrElse(decodeConcerns(row.concerns), () => []).some(
      (item) => foldConcern(concernOf(item).label) === folded,
    )
      ? [row.recordId]
      : [],
  );
});

/** What `viewer` sees of the company's deals, in one fragment list for the reads below. */
const pipelineWhere = (sql: SqlClient.SqlClient, orgId: KinOrgId, viewer: KinViewer) => [
  sql`r.org_id = ${orgId}`,
  sql`r.register_id = 'deals'`,
  crmSeenBy(sql, viewer),
];
type Summed = {
  readonly currency: string | null;
  readonly minor: number | null;
  readonly count: number;
};
/** Rows' counts added, and their values per currency, in currency order. */
const totalsOf = (rows: ReadonlyArray<Summed>) => {
  const values = new Map<string, number>();
  for (const row of rows)
    if (row.currency !== null && row.minor !== null)
      values.set(row.currency, (values.get(row.currency) ?? 0) + row.minor);
  return {
    count: rows.reduce((sum, row) => sum + row.count, 0),
    values: [...values]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([currency, minor]) => ({ minor, currency: currency as KinMoney["currency"] })),
  };
};

const openPipelineRows = Effect.fn("KinDeals.openPipelineRows")(function* (
  orgId: KinOrgId,
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  const where = pipelineWhere(sql, orgId, viewer);
  return yield* sql<Summed & { stage: string | null }>`SELECT
      json_extract(r.fields_json, '$.stage') AS stage,
      json_extract(r.fields_json, '$.value.currency') AS currency,
      SUM(json_extract(r.fields_json, '$.value.minor')) AS minor, COUNT(*) AS count
    FROM kin_records r WHERE ${sql.and([...where, sql`r.state = 'open'`])}
    GROUP BY stage, json_extract(r.fields_json, '$.value.currency')
    ORDER BY stage, json_extract(r.fields_json, '$.value.currency')`;
});

export const openPipelineValue = Effect.fn("KinDeals.openPipelineValue")(function* (
  orgId: KinOrgId,
) {
  return totalsOf(yield* openPipelineRows(orgId, KIN_OWNER_LEVEL)).values;
});

/**
 * The pipeline as `viewer` sees it, counted here: open deals by stage, in the company's order,
 * and won and lost, each per currency; a deal with no value counts only in its count.
 */
export const pipelineTotals = Effect.fn("KinDeals.pipelineTotals")(function* (
  orgId: KinOrgId,
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  const where = pipelineWhere(sql, orgId, viewer);
  const open = yield* openPipelineRows(orgId, viewer);
  const closed = yield* sql<Summed & { state: string }>`SELECT r.state,
      json_extract(r.fields_json, '$.value.currency') AS currency,
      SUM(json_extract(r.fields_json, '$.value.minor')) AS minor, COUNT(*) AS count
    FROM kin_records r WHERE ${sql.and([...where, sql`r.state IN ('done', 'dropped')`])}
    GROUP BY r.state, json_extract(r.fields_json, '$.value.currency')
    ORDER BY r.state, json_extract(r.fields_json, '$.value.currency')`;
  const { stages } = yield* stagesOf(orgId);
  const known = new Set(stages.map((stage) => stage.id));
  const byStage = [
    ...stages.map((stage) => ({ id: stage.id as string | null, name: stage.name as string })),
    // An open deal whose stage was removed without a move still counts, under its own id.
    ...[...new Set(open.map((row) => row.stage))]
      .filter((id) => id === null || !known.has(id))
      .map((id) => ({ id, name: id ?? "No stage" })),
  ].map((stage) => ({
    name: stage.name,
    ...totalsOf(open.filter((row) => row.stage === stage.id)),
  }));
  return {
    stages: byStage,
    open: totalsOf(open),
    won: totalsOf(closed.filter((row) => row.state === "done")),
    lost: totalsOf(closed.filter((row) => row.state === "dropped")),
  };
});

const PIPELINE_MINE_CAP = 50;
/** Open deals `person` looks after, as `viewer` sees them, soonest expected first, past the cap counted. */
export const pipelineMine = Effect.fn("KinDeals.pipelineMine")(function* (
  orgId: KinOrgId,
  viewer: KinViewer,
  person: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  const where = [
    ...pipelineWhere(sql, orgId, viewer),
    sql`r.state = 'open'`,
    sql`r.owner_kind = 'person' AND r.owner_id = ${person}`,
  ];
  const rows = yield* sql<RecordRow>`${selectRecords(sql)} WHERE ${sql.and(where)}
    ORDER BY r.due_at IS NULL, r.due_at, r.created_at, r.key LIMIT ${PIPELINE_MINE_CAP + 1}`;
  const shown = rows.slice(0, PIPELINE_MINE_CAP);
  const deals = yield* asShown(orgId, viewer, shown);
  return {
    deals: shown.flatMap((row) => {
      const deal = deals.get(row.key);
      return deal === undefined ? [] : [deal];
    }),
    more: rows.length > PIPELINE_MINE_CAP,
  };
});

/** `concernCounts` over every deal `viewer` sees, whatever its state: the 50 most heard, and whether there are more. */
export const pipelineConcerns = Effect.fn("KinDeals.pipelineConcerns")(function* (
  orgId: KinOrgId,
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* concernCounts(pipelineWhere(sql, orgId, viewer));
});

// Numbers: every figure counted here, in SQL, over the deals the viewer sees (`crmSeenBy`).

const WIN_RATE_DAYS = 90;
const WEEK_ROWS_CAP = 50;

/** The calendar day `count` days after `day`. */
const dayAfter = (day: string, count: number) =>
  DateTime.formatIsoDate(DateTime.add(DateTime.makeUnsafe(`${day}T00:00:00Z`), { days: count }));

/** The company's today, its week from Monday and its month and the one before, as instants in `zone`. */
const dealCalendar = (now: number, zone: string) => {
  const today = dayIn(now, zone);
  const weekDay = DateTime.toParts(DateTime.makeZonedUnsafe(now, { timeZone: zone })).weekDay;
  const weekStart = dayAfter(today, -((weekDay + 6) % 7));
  const month = monthOf(today);
  const lastMonth = shiftMonth(month, -1);
  return {
    today,
    weekStart,
    month,
    lastMonth,
    todayAt: startOfDay(today, zone),
    weekAt: startOfDay(weekStart, zone),
    monthAt: startOfDay(`${month}-01`, zone),
    lastMonthAt: startOfDay(`${lastMonth}-01`, zone),
  };
};

const byOwner = (sql: SqlClient.SqlClient, owner: KinWorkPrincipal) =>
  sql`r.owner_kind = ${owner._tag} AND r.owner_id = ${owner._tag === "person" ? owner.personId : owner.agentId}`;
const closedIn = (sql: SqlClient.SqlClient, state: "done" | "dropped", from: number, to: number) =>
  sql`r.state = ${state} AND r.closed_at >= ${from} AND r.closed_at < ${to}`;

type OwnedSum = Summed & { readonly kind: string | null; readonly id: string | null };
/** Deals' values per currency and owner, for `where`. */
const sumsOf = Effect.fnUntraced(function* (where: ReadonlyArray<Statement.Fragment>) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<OwnedSum>`SELECT r.owner_kind AS kind, r.owner_id AS id,
      json_extract(r.fields_json, '$.value.currency') AS currency,
      SUM(json_extract(r.fields_json, '$.value.minor')) AS minor, COUNT(*) AS count
    FROM kin_records r WHERE ${sql.and([...where])}
    GROUP BY r.owner_kind, r.owner_id, json_extract(r.fields_json, '$.value.currency')
    ORDER BY r.owner_kind, r.owner_id, currency`;
});

/**
 * Open deals in `where` whose next step's day is behind `todayAt`: an open follow-up of ours linked
 * to the deal, that the viewer reads, due before today began. Each deal counts once.
 */
const lateOf = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  where: ReadonlyArray<Statement.Fragment>,
  viewer: KinViewer,
  todayAt: number,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    kind: string | null;
    id: string | null;
    count: number;
  }>`SELECT r.owner_kind AS kind,
      r.owner_id AS id, COUNT(*) AS count FROM kin_records r
    WHERE ${sql.and([...where, sql`r.state = 'open'`])} AND r.record_id IN (
      SELECT l.target FROM kin_record_links l
        JOIN kin_records r ON r.org_id = l.org_id AND r.record_id = l.record_id
      WHERE l.org_id = ${orgId} AND l.kind = 'record'
        AND r.register_id = 'work' AND r.state NOT IN ('done', 'dropped') AND r.side = 'ours'
        AND r.due_at < ${todayAt} AND ${crmSeenBy(sql, viewer)})
    GROUP BY r.owner_kind, r.owner_id ORDER BY r.owner_kind, r.owner_id`;
});

/**
 * What changed among the deals `where` selects in [from, to): won, lost, new, and moved between
 * stages (a deal moved twice counts once, from its first stage to its last). Each list holds the
 * 50 latest; `counts` has them all.
 */
const week = Effect.fn("KinDeals.week")(function* (
  orgId: KinOrgId,
  where: ReadonlyArray<Statement.Fragment>,
  from: number,
  to: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const { stages } = yield* stagesOf(orgId);
  const rowsOf = (extra: Statement.Fragment, order: Statement.Fragment) =>
    sql<RecordRow>`${selectRecords(sql)} WHERE ${sql.and([...where, extra])} ORDER BY ${order}`;
  const won = yield* rowsOf(closedIn(sql, "done", from, to), sql`r.closed_at DESC, r.key`);
  const lost = yield* rowsOf(closedIn(sql, "dropped", from, to), sql`r.closed_at DESC, r.key`);
  const added = yield* rowsOf(
    sql`r.created_at >= ${from} AND r.created_at < ${to}`,
    sql`r.created_at DESC, r.key`,
  );
  const changes = yield* sql<{ recordId: string; fieldsJson: string }>`SELECT
      ch.record_id AS "recordId", ch.fields_json AS "fieldsJson"
    FROM kin_record_changes ch JOIN kin_records r ON r.org_id = ch.org_id AND r.record_id = ch.record_id
    WHERE ${sql.and([...where])} AND ch.kind = 'updated' AND ch.at >= ${from} AND ch.at < ${to}
      AND EXISTS (SELECT 1 FROM json_each(ch.fields_json) f
        WHERE json_extract(f.value, '$.field') = 'stage'
          AND json_extract(f.value, '$.from') IS NOT NULL AND json_extract(f.value, '$.to') IS NOT NULL)
    ORDER BY ch.seq`;
  const moves = new Map<string, { from: string; to: string }>();
  for (const change of changes)
    for (const field of parseChanges(change.fieldsJson)) {
      if (field.field !== "stage" || field.from === null || field.to === null) continue;
      const line = stageLine(stages, field);
      const was = moves.get(change.recordId);
      moves.set(change.recordId, { from: was?.from ?? line.from ?? "", to: line.to ?? "" });
    }
  const movedRows =
    moves.size === 0
      ? []
      : yield* rowsOf(
          sql`r.record_id IN ${sql.in([...moves.keys()])}`,
          sql`r.updated_at DESC, r.key`,
        );
  const row = (one: RecordRow): KinDealWeekRow => {
    const value = parseFields(one.fieldsJson).value;
    const move = moves.get(one.recordId);
    return {
      key: one.key as KinDealWeekRow["key"],
      title: one.title as KinDealWeekRow["title"],
      party: (one.partyTitle ?? "") as KinDealWeekRow["party"],
      owner: ownerOf(one),
      ...(value !== undefined && isMoney(value) ? { value } : {}),
      ...(move === undefined ? {} : move),
    };
  };
  const listed = (rows: ReadonlyArray<RecordRow>) => rows.slice(0, WEEK_ROWS_CAP).map(row);
  return {
    won: listed(won),
    lost: listed(lost),
    new: listed(added),
    moved: listed(movedRows),
    counts: {
      won: won.length,
      lost: lost.length,
      new: added.length,
      moved: movedRows.length,
    },
  };
});

/** Each source by what it reads as, a campaign by its name: two that read the same are one row. */
const sourcesShown = (
  rows: ReadonlyArray<{ source: string | null; count: number }>,
  campaigns: ReadonlyMap<string, KinRecordRef>,
) => {
  const out: Array<{ source: string | null; count: number }> = [];
  for (const row of rows) {
    const source =
      row.source?.startsWith(KIN_CAMPAIGN_SOURCE) === true
        ? (campaigns.get(row.source.slice(KIN_CAMPAIGN_SOURCE.length))?.title ??
          "A campaign that was removed")
        : row.source;
    const same = out.find((one) => one.source === source);
    if (same === undefined) out.push({ source, count: row.count });
    else same.count += row.count;
  }
  return out.toSorted((a, b) => b.count - a.count);
};

const ownerKey = (kind: string, id: string) => `${kind}\0${id}`;

/**
 * The Deals tab's figures for `viewer`, or undefined when it sees no deal at all. The owner level
 * gets every figure; a single member their own row and week with the team's open and won this
 * month (all they see); several people together, only what each of them may: no one's own row.
 */
export const summary = Effect.fn("KinDeals.summary")(function* (
  orgId: KinOrgId,
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const zone = yield* ownerZone(orgId);
  const days = dealCalendar(now, zone);
  const where = pipelineWhere(sql, orgId, viewer);
  const [{ any } = { any: 0 }] = yield* sql<{ any: number }>`SELECT COUNT(*) AS any FROM
    (SELECT 1 FROM kin_records r WHERE ${sql.and(where)} LIMIT 1)`;
  if (any === 0) return undefined;
  const totals = yield* pipelineTotals(orgId, viewer);
  const owner = viewer._tag === "ownerLevel";
  const one = viewer._tag === "people" && viewer.people.length === 1 ? viewer.people[0] : undefined;
  const nextMonthAt = startOfDay(`${shiftMonth(days.month, 1)}-01`, zone);
  const wonThisMonth = yield* sumsOf([...where, closedIn(sql, "done", days.monthAt, nextMonthAt)]);
  const openSums = yield* sumsOf([...where, sql`r.state = 'open'`]);
  const late = yield* lateOf(orgId, where, viewer, days.todayAt);
  const lostThisMonth = yield* sumsOf([
    ...where,
    closedIn(sql, "dropped", days.monthAt, nextMonthAt),
  ]);
  // A person whose only deal was lost this month keeps their row, at zero.
  const people = new Map<string, { kind: string; id: string }>();
  for (const row of [...openSums, ...wonThisMonth, ...lostThisMonth, ...late])
    if (row.kind !== null && row.id !== null)
      people.set(ownerKey(row.kind, row.id), { kind: row.kind, id: row.id });
  if (one !== undefined) people.set(ownerKey("person", one), { kind: "person", id: one });
  const personRows = [...people.values()]
    .filter((who) => owner || (who.kind === "person" && who.id === one))
    .toSorted((a, b) => ownerKey(a.kind, a.id).localeCompare(ownerKey(b.kind, b.id)))
    .map((who): KinDealPersonNumbers => {
      const mine = (rows: ReadonlyArray<OwnedSum>) =>
        totalsOf(rows.filter((row) => row.kind === who.kind && row.id === who.id));
      return {
        owner: principal(who.kind, who.id) ?? { _tag: "agent", agentId: KinAgentId.make(who.id) },
        open: mine(openSums),
        wonThisMonth: mine(wonThisMonth),
        late: late.find((row) => row.kind === who.kind && row.id === who.id)?.count ?? 0,
      };
    })
    .toSorted((a, b) => b.open.count - a.open.count);
  const base = {
    month: days.month,
    lastMonth: days.lastMonth,
    weekStart: days.weekStart as KinDealNumbers["weekStart"],
    open: totals.open,
    stages: totals.stages,
    wonThisMonth: totalsOf(wonThisMonth),
    people: personRows,
  };
  if (!owner)
    return {
      ...base,
      ...(one === undefined
        ? {}
        : {
            week: yield* week(
              orgId,
              [...where, byOwner(sql, { _tag: "person", personId: one })],
              days.weekAt,
              now + 1,
            ),
          }),
    } satisfies KinDealNumbers;
  const decided = yield* sql<{ state: string; count: number }>`SELECT r.state, COUNT(*) AS count
    FROM kin_records r WHERE ${sql.and([...where, sql`r.state IN ('done', 'dropped')`, sql`r.closed_at >= ${now - WIN_RATE_DAYS * DAY_MS}`])}
    GROUP BY r.state ORDER BY r.state`;
  const sources = yield* sql<{ source: string | null; count: number }>`SELECT
      json_extract(r.fields_json, '$.source') AS source, COUNT(*) AS count
    FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id = 'clients'
      AND r.created_at >= ${days.monthAt} AND r.created_at < ${nextMonthAt}
      AND ${crmSeenBy(sql, viewer)} AND (r.category = 'prospect' OR EXISTS (SELECT 1 FROM kin_records d
        WHERE d.org_id = r.org_id AND d.register_id = 'deals' AND d.party_id = r.record_id))
    GROUP BY json_extract(r.fields_json, '$.source')
    ORDER BY COUNT(*) DESC, source`;
  const count = (state: string) => decided.find((row) => row.state === state)?.count ?? 0;
  const campaigns = yield* campaignsNamed(
    orgId,
    sources.map((row) => row.source),
    viewer,
  );
  return {
    ...base,
    wonLastMonth: totalsOf(
      yield* sumsOf([...where, closedIn(sql, "done", days.lastMonthAt, days.monthAt)]),
    ),
    lostThisMonth: totalsOf(lostThisMonth),
    lostLastMonth: totalsOf(
      yield* sumsOf([...where, closedIn(sql, "dropped", days.lastMonthAt, days.monthAt)]),
    ),
    winRate: { won: count("done"), decided: count("done") + count("dropped") },
    sources: sourcesShown(sources, campaigns),
    late: late.reduce((sum, row) => sum + row.count, 0),
    week: yield* week(orgId, where, days.weekAt, now + 1),
  } satisfies KinDealNumbers;
});

/**
 * Monday's three pipeline lines' counts, at the owner level: open per currency with its count,
 * won and lost in [from, now) per currency, new deals then, and late deals by who looks after them.
 */
export const mondayCounts = Effect.fn("KinDeals.mondayCounts")(function* (
  orgId: KinOrgId,
  from: number,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const days = dealCalendar(now, yield* ownerZone(orgId));
  const where = pipelineWhere(sql, orgId, KIN_OWNER_LEVEL);
  const perCurrency = (extra: Statement.Fragment) =>
    sql<Summed>`SELECT json_extract(r.fields_json, '$.value.currency') AS currency,
        SUM(json_extract(r.fields_json, '$.value.minor')) AS minor, COUNT(*) AS count
      FROM kin_records r WHERE ${sql.and([...where, extra])}
      GROUP BY json_extract(r.fields_json, '$.value.currency') ORDER BY currency`;
  const [{ added } = { added: 0 }] = yield* sql<{ added: number }>`SELECT COUNT(*) AS added
    FROM kin_records r WHERE ${sql.and([...where, sql`r.created_at >= ${from} AND r.created_at < ${now}`])}`;
  const late = yield* lateOf(orgId, where, KIN_OWNER_LEVEL, days.todayAt);
  const names = yield* sql<{ kind: string; id: string; name: string }>`SELECT 'person' AS kind,
      person_id AS id, display_name AS name FROM kin_people WHERE org_id = ${orgId}
    UNION ALL SELECT 'agent' AS kind, agent_id AS id, display_name AS name FROM kin_agents
      WHERE org_id = ${orgId}
    ORDER BY kind, id`;
  return {
    open: yield* perCurrency(sql`r.state = 'open'`),
    won: yield* perCurrency(closedIn(sql, "done", from, now)),
    lost: yield* perCurrency(closedIn(sql, "dropped", from, now)),
    added,
    late: late
      .map((row) => ({
        name: names.find((one) => one.kind === row.kind && one.id === row.id)?.name ?? "someone",
        count: row.count,
      }))
      .toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
});

/** A reader: the owner level, or a member with the Clients switch on. */
const dealReader = Effect.fn("KinDeals.reader")(function* (
  people: ReadonlyArray<PersonIdentity>,
  orgId: KinOrgId,
) {
  const { actor, viewer } = yield* personActor(people, orgId);
  yield* switchedOn(orgId, actor.members).pipe(workFailure);
  return { actor, viewer };
});

const seqFor = Effect.fn("KinDeals.seq")(function* (orgId: KinOrgId, viewer: KinViewer) {
  const records = yield* KinRecords;
  const [team] = viewer._tag === "people" ? viewer.people : [];
  return team === undefined
    ? yield* records.seq(orgId)
    : yield* teamSeq(orgId, team).pipe(workFailure);
});

/** The pipeline as this person may see it: open by stage by default, or one client's deals. */
export const deals = Effect.fn("KinDeals.list")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinDealsInput,
  /** A coding agent's key reads it: nothing a key never carries (`keyedViewer`). */
  options: { readonly keyed?: boolean } = {},
) {
  const reading = yield* dealReader(people, input.orgId);
  const { actor } = reading;
  const viewer = options.keyed === true ? keyedViewer(reading.viewer) : reading.viewer;
  const sql = yield* SqlClient.SqlClient;
  const party =
    input.party === undefined ? undefined : yield* seenParty(actor, input.party).pipe(workFailure);
  // A campaign they can't see in Clients answers as one never there.
  if (
    input.campaign !== undefined &&
    !(yield* campaignsNamed(input.orgId, [`${KIN_CAMPAIGN_SOURCE}${input.campaign}`], viewer).pipe(
      workFailure,
    )).has(input.campaign)
  )
    return yield* new KinChatError({
      reason: "not_found",
      message: `No campaign ${input.campaign.slice(0, 40)}.`,
    });
  const state =
    input.state ?? (party === undefined && input.concern === undefined ? "open" : undefined);
  const stored =
    state === undefined
      ? undefined
      : state === "won"
        ? "done"
        : state === "lost"
          ? "dropped"
          : "open";
  const where: Array<Statement.Fragment> = [
    sql`r.org_id = ${input.orgId}`,
    sql`r.register_id = 'deals'`,
    crmSeenBy(sql, viewer),
    ...(party === undefined ? [] : [sql`r.party_id = ${party.recordId}`]),
    ...(input.campaign === undefined
      ? []
      : [dealsFromCampaign(sql, input.orgId, input.campaign, viewer)]),
    ...(input.owner === undefined
      ? []
      : [
          sql`r.owner_kind = ${input.owner._tag} AND r.owner_id = ${
            input.owner._tag === "person" ? input.owner.personId : input.owner.agentId
          }`,
        ]),
  ];
  if (input.concern !== undefined) {
    const raised = yield* raisedIn(where, input.concern).pipe(workFailure);
    where.push(sql`r.record_id IN (SELECT value FROM json_each(${yield* encodeIds(raised)}))`);
  }
  const filtered = stored === undefined ? where : [...where, sql`r.state = ${stored}`];
  const order =
    stored === "open"
      ? sql`r.due_at IS NULL, r.due_at, r.created_at, r.key`
      : sql`r.state = 'open' DESC, r.due_at IS NULL, r.due_at, r.closed_at DESC, r.key`;
  const result = yield* Effect.gen(function* () {
    const rows = yield* sql<RecordRow>`${selectRecords(sql)} WHERE ${sql.and(filtered)}
      ORDER BY ${order} LIMIT ${KIN_DEALS_CAP + 1}`;
    const [{ total } = { total: 0 }] = yield* sql<{
      total: number;
    }>`SELECT COUNT(*) AS total FROM kin_records r WHERE ${sql.and(filtered)}`;
    const sums = yield* sql<{ currency: string | null; minor: number | null; count: number }>`
      SELECT json_extract(r.fields_json, '$.value.currency') AS currency,
        SUM(json_extract(r.fields_json, '$.value.minor')) AS minor, COUNT(*) AS count
      FROM kin_records r WHERE ${sql.and([...where, sql`r.state = 'open'`])}
      GROUP BY json_extract(r.fields_json, '$.value.currency') ORDER BY currency`;
    const { stages } = yield* stagesOf(input.orgId);
    const shown = rows.slice(0, KIN_DEALS_CAP);
    const numbers = party === undefined ? yield* summary(input.orgId, viewer) : undefined;
    return {
      stages,
      deals: yield* dealsOut(input.orgId, viewer, shown),
      more: Math.max(0, total - shown.length),
      open: {
        count: sums.reduce((sum, row) => sum + row.count, 0),
        values: sums.flatMap((row) =>
          row.currency === null || row.minor === null
            ? []
            : [{ minor: row.minor, currency: row.currency as KinMoney["currency"] }],
        ),
      },
      canCreate: party === undefined ? true : party.category !== "vendor" && party.state === "open",
      concerns: (yield* concernCounts(where)).concerns,
      ...(numbers === undefined ? {} : { numbers }),
    };
  }).pipe(workFailure);
  const now = yield* Clock.currentTimeMillis;
  return {
    ...result,
    seq: yield* seqFor(input.orgId, viewer),
    asOf: iso(now),
  } satisfies KinDealsResult;
});

/** The history lines a member reads of a deal: what it says and who has it, never its labels. */
const MEMBER_FIELDS = new Set([
  "stage",
  "value",
  "source",
  "lostReason",
  "concerns",
  KIN_DEAL_STEP_FIELD,
]);
export const dealSeesField = (field: string) =>
  (teamSeesField(field) && field !== "confirmed") || MEMBER_FIELDS.has(field);
/** A concerns change by its labels, one a line, where the change kept them. */
const concernLine = ({ names, ...change }: StoredChange["fields"][number]) =>
  names === undefined ? change : { ...change, from: names.from, to: names.to };
/** A step that went with the deal, by key and title; a member, who may not see it, reads its key. */
const stepLine = ({ names, ...field }: StoredChange["fields"][number], viewer: KinViewer) =>
  viewer._tag === "ownerLevel" && names !== undefined ? { ...field, to: names.to } : field;
/** A deal's own changes, its stages by the names they had then, as far as this viewer reads them. */
const dealChanges = (
  changes: ReadonlyArray<StoredChange>,
  stages: ReadonlyArray<KinDealStage>,
  viewer: KinViewer,
) =>
  changes.flatMap((change): ReadonlyArray<KinRecordChange> => {
    if (viewer._tag !== "ownerLevel" && change.kind === "linked") return [];
    const fields = change.fields
      .filter((field) => viewer._tag === "ownerLevel" || dealSeesField(field.field))
      .map((field) =>
        field.field === "stage"
          ? stageLine(stages, field)
          : field.field === "concerns"
            ? concernLine(field)
            : field.field === KIN_DEAL_STEP_FIELD
              ? stepLine(field, viewer)
              : field,
      );
    return change.kind === "updated" && fields.length === 0 ? [] : [{ ...change, fields }];
  });

export const page = Effect.fn("KinDeals.page")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinDealPageInput,
) {
  const { actor, viewer } = yield* dealReader(people, input.orgId);
  const records = yield* KinRecords;
  const row = yield* dealIn(actor, input.key).pipe(workFailure);
  const now = yield* Clock.currentTimeMillis;
  const [deal] = yield* dealsOut(input.orgId, viewer, [row]).pipe(workFailure);
  const { steps } = yield* stepsFor(input.orgId, viewer, [row.recordId], now).pipe(workFailure);
  const { stages } = yield* stagesOf(input.orgId).pipe(workFailure);
  const detail = yield* records.detail(row, KIN_RECORD_CHANGES_CAP);
  const quotes =
    deal!.can.edit && (yield* readsQuotes(input.orgId, actor))
      ? yield* quoteChoices(input.orgId, viewer, row).pipe(workFailure)
      : undefined;
  const readers = people.filter((one) => one.orgId === input.orgId).map((one) => one.personId);
  return {
    deal: deal!,
    stages,
    notes: row.notes as KinDealPage["notes"],
    changes: dealChanges(detail.changes, stages, viewer),
    steps: steps.get(row.recordId) ?? [],
    ...(quotes === undefined ? {} : { quotes }),
    promises: yield* promisesOf(input.orgId, viewer, row, now, readers).pipe(workFailure),
    seq: yield* seqFor(input.orgId, viewer),
  } satisfies KinDealPage;
});

/**
 * The promises on a deal this viewer reads in Clients, open or done, never dropped: ours, then
 * theirs, each by its day; each with where it was made, as `readers` may follow it.
 */
export const promisesOf = Effect.fn("KinDeals.promises")(function* (
  orgId: KinOrgId,
  viewer: KinViewer,
  deal: RecordRow,
  now: number,
  readers: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<RecordRow>`${selectRecords(sql)}
    WHERE r.org_id = ${orgId} AND r.register_id = 'work' AND r.category = 'obligation'
      AND r.state <> 'dropped' AND ${crmSeenBy(sql, viewer)}
      AND EXISTS (SELECT 1 FROM kin_record_links dl WHERE dl.org_id = r.org_id
        AND dl.record_id = r.record_id AND dl.kind = 'record' AND dl.target = ${deal.recordId})
    ORDER BY r.side = 'theirs', r.state = 'done', r.due_at IS NULL, r.due_at, r.key
    LIMIT ${KIN_DEAL_PROMISES_CAP}`;
  const froms = yield* fromsOf(
    orgId,
    rows.map((one) => one.recordId),
    readers,
  );
  const clients = new Set(deal.partyId === null ? [] : [deal.partyId]);
  return rows.map((one) => {
    const record = toRecord(one, now);
    const shown = viewer._tag === "ownerLevel" ? record : teamRecordIn(record, new Set(), clients);
    const from = froms.get(one.recordId);
    return from === undefined ? shown : { ...shown, from };
  });
});
const KIN_DEAL_PROMISES_CAP = 50;

// Writes from a person's own app: decode, decide inside one transaction, answer as they read it.

const written = Effect.fn("KinDeals.written")(function* <A, E extends { readonly _tag: string }, R>(
  orgId: KinOrgId,
  write: Effect.Effect<A, E, R>,
  moved?: (result: A) => RecordRow,
) {
  const sql = yield* SqlClient.SqlClient;
  const result = yield* sql
    .withTransaction(
      Effect.gen(function* () {
        if (!(yield* sectionOn(orgId, "deals"))) return yield* refused(DEALS_OFF);
        return yield* write;
      }),
    )
    .pipe(workFailure);
  yield* (yield* KinRecords).announce(
    orgId,
    moved === undefined ? undefined : [moved(result).recordId],
  );
  return result;
});
const answer = Effect.fn("KinDeals.answer")(function* (
  orgId: KinOrgId,
  viewer: KinViewer,
  row: RecordRow,
  becameClient: boolean,
) {
  const fresh = (yield* byId(orgId, row.recordId).pipe(workFailure)) ?? row;
  const [deal] = yield* dealsOut(orgId, viewer, [fresh]).pipe(workFailure);
  return { deal: deal!, ...(becameClient ? { becameClient: true as const } : {}) };
});
const originOf = (actor: DealActor) =>
  actor.members.length === 0 ? "owner:deal" : `member:${actor.person}:deal`;

/** A person's new deal, written in the caller's transaction; `told` and `answer` follow its commit. */
export const createIn = Effect.fn("KinDeals.createIn")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinDealCreateInput,
) {
  const { actor, viewer, person } = yield* personActor(people, input.orgId);
  const { clientRequestId, orgId: _orgId, ...asked } = input;
  const due = yield* expectedAt(input.orgId, input.expectedOn);
  const made = yield* createAs(actor, {
    partyKey: input.party,
    title: input.title,
    stage: input.stage,
    value: input.value,
    ...due,
    source: input.source,
    owner: input.owner,
    sensitive: input.sensitive,
    notes: input.notes,
    quoteKey: input.quote,
    next: input.next,
    originKey: `${originOf(actor)}:${clientRequestId}`,
    requestHash: requestHashOf({ clientRequestId, ...asked }),
  });
  return { ...made, viewer, person };
});

/** After `createIn` commits: its keeper hears of the step, and the deal as its writer reads it. */
export const createdOut = Effect.fn("KinDeals.createdOut")(function* (
  orgId: KinOrgId,
  made: Effect.Success<ReturnType<typeof createIn>>,
) {
  for (const notice of made.notices)
    yield* tellOnScreen(made.person, `${notice.row.recordId}:${notice.row.rev}`, [notice]);
  return yield* answer(orgId, made.viewer, made.row, false);
});

export const create = Effect.fn("KinDeals.rpc.create")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinDealCreateInput,
) {
  const made = yield* written(input.orgId, createIn(people, input), (done) => done.row);
  return yield* createdOut(input.orgId, made);
});

export const update = Effect.fn("KinDeals.rpc.update")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinDealUpdateInput,
) {
  const { actor, viewer, person } = yield* personActor(people, input.orgId);
  const { row, notices } = yield* written(
    input.orgId,
    Effect.gen(function* () {
      const due = yield* expectedAt(input.orgId, input.expectedOn);
      return yield* updateAs(
        actor,
        input.key,
        {
          title: input.title,
          notes: input.notes,
          value: input.value,
          ...due,
          source: input.source,
          owner: input.owner,
          sensitive: input.sensitive,
          quoteKey: input.quote,
          concerns:
            input.concerns === undefined || input.concerns === null
              ? input.concerns
              : input.concerns.map((concern) =>
                  concern.heard === undefined
                    ? concern.label
                    : `${concern.label}: ${concern.heard}`,
                ),
        },
        input.rev,
      );
    }),
    (made) => made.row,
  );
  yield* tellOnScreen(person, `${row.recordId}:${row.rev}`, notices);
  return yield* answer(input.orgId, viewer, row, false);
});

export const move = Effect.fn("KinDeals.rpc.move")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinDealMoveInput,
) {
  const { actor, viewer } = yield* personActor(people, input.orgId);
  const moved = yield* written(
    input.orgId,
    moveAs(actor, input.key, input.to, input.rev),
    (made) => made.row,
  );
  return yield* answer(input.orgId, viewer, moved.row, moved.becameClient);
});

export const step = Effect.fn("KinDeals.rpc.step")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinDealAddStepInput,
) {
  const { actor, viewer } = yield* personActor(people, input.orgId);
  const row = yield* written(
    input.orgId,
    stepAs(actor, input.key, input.step, `${originOf(actor)}-step:${input.clientRequestId}`),
    (row) => row,
  );
  return yield* answer(input.orgId, viewer, row, false);
});

// Stages.

const openByStage = Effect.fn("KinDeals.openByStage")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ stage: string | null; count: number }>`SELECT
      json_extract(fields_json, '$.stage') AS stage, COUNT(*) AS count FROM kin_records
    WHERE org_id = ${orgId} AND register_id = 'deals' AND state = 'open'
    GROUP BY json_extract(fields_json, '$.stage') ORDER BY stage`;
  return Object.fromEntries(
    rows.flatMap((row) => (row.stage === null ? [] : [[row.stage, row.count] as const])),
  );
});

/** Everyone in the company reads the stages; the owner level changes them. */
export const stages = Effect.fn("KinDeals.rpc.stages")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: { readonly orgId: KinOrgId },
) {
  const viewer = yield* viewerOf(people, input.orgId);
  const { stages: list, rev } = yield* stagesOf(input.orgId).pipe(workFailure);
  return {
    stages: list,
    rev,
    can: !viewer.teammate,
    // Counts of other people's deals are the owner level's; a teammate needs none to read.
    open: viewer.teammate ? {} : yield* openByStage(input.orgId).pipe(workFailure),
    quietDays: (yield* playbookThreshold(input.orgId, "deal_quiet_days").pipe(workFailure)).value,
  } satisfies KinDealStagesResult;
});

const QUIET_LINE = /^(\s*)deal_quiet_days\s*:\s*\d+(?:\s+[a-z]+)?\s*$/;
const KIN_FENCE = /^\s*(`{3,}|~{3,})\s*kin\s*$/;
/** The playbook's text with `deal_quiet_days` set to `days`: its line changed, else one added. */
export const withQuietDays = (body: string, days: number) => {
  const lines = body.split("\n");
  const at = lines.findIndex((line) => QUIET_LINE.test(line));
  if (at !== -1) {
    lines[at] = lines[at]!.replace(QUIET_LINE, `$1deal_quiet_days: ${days}`);
    return lines.join("\n");
  }
  const fence = lines.findIndex((line) => KIN_FENCE.test(line));
  if (fence !== -1) {
    lines.splice(fence + 1, 0, `deal_quiet_days: ${days}`);
    return lines.join("\n");
  }
  return `${body.trimEnd()}\n\n## Thresholds\n\`\`\`kin\ndeal_quiet_days: ${days}\n\`\`\`\n`;
};

/**
 * Settings, Deals: "A deal goes quiet after N days", written into the playbook that sets it, else
 * into Winning customers, as a new version its history keeps. The owner level only.
 */
export const setQuietDays = Effect.fn("KinDeals.setQuietDays")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinDealQuietDaysSetInput,
) {
  const viewer = yield* viewerOf(people, input.orgId);
  if (viewer.teammate)
    return yield* refused("Only the owner or a co-owner sets when a deal goes quiet.");
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const found = yield* playbookThreshold(input.orgId, "deal_quiet_days").pipe(workFailure);
  const [doc] =
    found.from._tag === "playbook"
      ? [{ key: found.from.key }]
      : // oxlint-disable-next-line t3code/kin-viewer-scoped-reads -- owner level only, checked above.
        yield* sql<{ key: string }>`SELECT key FROM kin_records WHERE org_id = ${input.orgId}
          AND register_id = 'docs' AND origin_key = ${WINNING_CUSTOMERS_ORIGIN}
          AND state <> 'dropped' ORDER BY key LIMIT 1`.pipe(workFailure);
  if (doc === undefined)
    return yield* invalid(
      "No playbook sets this: bring Winning customers back in Docs, or add deal_quiet_days to a company playbook.",
    );
  // oxlint-disable-next-line t3code/kin-viewer-scoped-reads -- owner level only, checked above.
  const [latest] = yield* sql<{ body: string }>`SELECT v.body FROM kin_doc_versions v
    JOIN kin_records r ON r.org_id = v.org_id AND r.record_id = v.record_id
    WHERE r.org_id = ${input.orgId} AND r.key = ${doc.key} AND v.body_kind = 'markdown'
    ORDER BY v.version DESC LIMIT 1`.pipe(workFailure);
  if (latest === undefined) return yield* invalid(`${doc.key} has no text to set it in.`);
  yield* Docs.replaceBody(
    input.orgId,
    { actor: { _tag: "person", personId: viewer.person.personId }, via: "owner" },
    {},
    { key: doc.key },
    {
      body: withQuietDays(latest.body, input.days),
      summary: `A deal goes quiet after ${input.days} ${input.days === 1 ? "day" : "days"}`,
      originKey: `kin-deal-quiet-days:${input.orgId}:${now}`,
    },
  );
  return yield* stages(people, { orgId: input.orgId });
});

const encodeStages = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(KinDealStageSchema)));
const fold = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");
const slug = (name: string) =>
  fold(name)
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "stage";

/**
 * The owner level sets the stages: rename, reorder, add and remove. A removed stage's open deals
 * move to the stage `moveTo` names, each with its own history line, in the same transaction.
 */
export const setStages = Effect.fn("KinDeals.setStages")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinDealStagesSetInput,
) {
  const viewer = yield* viewerOf(people, input.orgId);
  if (viewer.teammate) return yield* refused("Only the owner or a co-owner changes the stages.");
  const writer: Writer = { ...ownerWriter(viewer.person), deal: true };
  const records = yield* KinRecords;
  const sql = yield* SqlClient.SqlClient;
  yield* written(
    input.orgId,
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const current = yield* stagesOf(input.orgId);
      if (input.rev !== current.rev)
        return yield* new KinChatError({
          reason: "conflict",
          message: "Someone changed the stages since you opened them. Look again.",
        });
      const names = new Set<string>();
      for (const stage of input.stages) {
        if (names.has(fold(stage.name)))
          return yield* invalid(`Two stages are called ${stage.name.trim()}.`);
        names.add(fold(stage.name));
      }
      const taken = new Set(current.stages.map((stage) => stage.id));
      const next: Array<KinDealStage> = [];
      for (const stage of input.stages) {
        if (stage.id !== undefined) {
          if (!taken.has(stage.id)) return yield* unknownStage(stage.id, current.stages);
          if (next.some((one) => one.id === stage.id))
            return yield* invalid(`Stage ${stage.id} is listed twice.`);
          next.push({ id: stage.id, name: stage.name.trim() as KinDealStage["name"] });
          continue;
        }
        const base = slug(stage.name);
        let id = base;
        for (let n = 2; taken.has(id) || next.some((one) => one.id === id); n += 1)
          id = `${base}-${n}`;
        taken.add(id);
        next.push({ id, name: stage.name.trim() as KinDealStage["name"] });
      }
      const kept = new Set(next.map((stage) => stage.id));
      const open = yield* openByStage(input.orgId);
      for (const gone of current.stages.filter((stage) => !kept.has(stage.id))) {
        const count = open[gone.id] ?? 0;
        if (count === 0) continue;
        const to = input.moveTo?.[gone.id];
        if (to === undefined || !kept.has(to))
          return yield* invalid(
            `${gone.name} has ${count} open ${count === 1 ? "deal" : "deals"}: say which stage ${count === 1 ? "it moves" : "they move"} to.`,
          );
        // oxlint-disable-next-line t3code/kin-viewer-scoped-reads -- owner level only: every open deal in it moves.
        const keys = yield* sql<{ key: string }>`SELECT key FROM kin_records
          WHERE org_id = ${input.orgId} AND register_id = 'deals' AND state = 'open'
            AND json_extract(fields_json, '$.stage') = ${gone.id}
          ORDER BY key`;
        const names = { from: gone.name, to: next.find((stage) => stage.id === to)?.name ?? to };
        for (const { key } of keys)
          yield* records.update(input.orgId, writer, key, {
            fields: { stage: to },
            names: { stage: names },
          });
      }
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
        VALUES (${input.orgId}, 'deals', 'Deals', 'DL', 1, ${now})
        ON CONFLICT DO NOTHING`;
      yield* sql`UPDATE kin_registers SET definition_json = json_set(
          COALESCE(NULLIF(definition_json, ''), '{}'),
          '$.stages', json(${yield* encodeStages(next)}), '$.stagesRev', ${current.rev + 1})
        WHERE org_id = ${input.orgId} AND register_id = 'deals' AND built_in = 1`;
    }),
  );
  return yield* stages(people, { orgId: input.orgId });
});

export const LEAVER_OWNERS_ONLY = refused(
  "Only the owner or a co-owner gives away what someone who left looked after.",
);

/** What someone who left looked after, by kind, as one hand-over moves it. */
export type LeaverHeld = {
  readonly deals: number;
  readonly prospects: number;
  readonly clients: number;
  readonly followUps: number;
  readonly promises: number;
  readonly watches: number;
};

/**
 * Open deals, prospects and clients `personId` looks after, and their open follow-ups (tasks with
 * a client) and promises: clients first, so a deal moves only once its client has.
 */
const leaverRows = Effect.fn("KinDeals.leaverRows")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    key: string;
    registerId: string;
    category: string | null;
    confirmed: number;
  }>`SELECT key,
      register_id AS "registerId", category, confirmed FROM kin_records
    WHERE org_id = ${orgId} AND owner_kind = 'person' AND owner_id = ${personId}
      AND ((register_id = 'clients' AND category IN ('client', 'prospect') AND state = 'open')
        OR (register_id = 'deals' AND state = 'open')
        OR (register_id = 'work' AND state IN ('open', 'doing', 'waiting')
          AND (party_id IS NOT NULL OR category = 'obligation')))
    ORDER BY CASE register_id WHEN 'clients' THEN 0 WHEN 'deals' THEN 1 ELSE 2 END, key`;
});

const heldOf = (rows: ReadonlyArray<{ registerId: string; category: string | null }>) => ({
  deals: rows.filter((row) => row.registerId === "deals").length,
  prospects: rows.filter((row) => row.registerId === "clients" && row.category === "prospect")
    .length,
  clients: rows.filter((row) => row.registerId === "clients" && row.category === "client").length,
  followUps: rows.filter((row) => row.registerId === "work" && row.category !== "obligation")
    .length,
  promises: rows.filter((row) => row.registerId === "work" && row.category === "obligation").length,
});

export const leaverHeld = Effect.fn("KinDeals.leaverHeld")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  return {
    ...heldOf(yield* leaverRows(orgId, personId).pipe(workFailure)),
    watches: yield* KinWatches.countForPerson(orgId, personId).pipe(workFailure),
  } satisfies LeaverHeld;
});

/** Whether `personId` may take a leaver's clients and deals: on the team, owner level or Clients on. */
const leaverReceiver = Effect.fn("KinDeals.leaverReceiver")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  const { owner } = yield* KinIdentity;
  const [row] = yield* sql<{ name: string; removed: number; clients: number }>`SELECT
      display_name AS name, removed_at IS NOT NULL AS removed, sees_clients AS clients
    FROM kin_people WHERE org_id = ${orgId} AND person_id = ${personId}`.pipe(workFailure);
  if (row === undefined) return yield* refused("Kin can't find who should take them.");
  if (row.removed === 1)
    return yield* refused(`${row.name} is no longer on the team. Choose someone else.`);
  if (!(yield* mayActAsOwner(orgId, personId, owner).pipe(workFailure)) && row.clients !== 1)
    return yield* refused(
      `${row.name} can't take them: Clients is off for ${row.name}. Give them to the owner, a co-owner or someone with Clients on.`,
    );
  return row.name;
});

/**
 * Gives every open deal, prospect, client, follow-up, promise and watch `from` looked after to `to`, in
 * the caller's transaction: records log who gave them and that `from` left, and one refusal moves
 * none. The owner level only, for someone removed from the team.
 */
export const handOverLeaver = Effect.fn("KinDeals.handOverLeaver")(function* (input: {
  readonly orgId: KinOrgId;
  readonly by: KinPersonId;
  readonly from: KinPersonId;
  readonly to: KinPersonId;
}) {
  const { orgId } = input;
  const { owner } = yield* KinIdentity;
  if (!(yield* mayActAsOwner(orgId, input.by, owner).pipe(workFailure)))
    return yield* LEAVER_OWNERS_ONLY;
  const sql = yield* SqlClient.SqlClient;
  const [gone] = yield* sql<{ removed: number }>`SELECT removed_at IS NOT NULL AS removed
    FROM kin_people WHERE org_id = ${orgId} AND person_id = ${input.from}`.pipe(workFailure);
  if (gone?.removed !== 1)
    return yield* invalid("They are on the team: change who looks after each one on its own page.");
  if (input.to === input.from) return yield* invalid("Choose someone else to give them to.");
  yield* leaverReceiver(orgId, input.to);
  const records = yield* KinRecords;
  const writer: Writer = {
    actor: { _tag: "person", personId: input.by },
    via: "owner",
    askedBy: input.by,
  };
  const to = me(input.to);
  const left = [{ field: KIN_LEFT_FIELD, from: `person:${input.from}`, to: null }];
  const rows = yield* leaverRows(orgId, input.from).pipe(workFailure);
  for (const row of rows) {
    if (row.registerId !== "deals") {
      yield* records.update(orgId, writer, row.key, { owner: to }, undefined, left);
      continue;
    }
    const after = yield* records.update(
      orgId,
      { ...writer, deal: true },
      row.key,
      { owner: to },
      undefined,
      left,
    );
    yield* seesItAfter(orgId, after, to);
  }
  const watches = yield* KinWatches.handOver(orgId, input.from, input.to).pipe(workFailure);
  return {
    moved: { ...heldOf(rows), watches },
    given: {
      ...heldOf(rows.filter((row) => row.registerId !== "work" || !isSuggestion(row))),
      watches,
    },
  };
});
