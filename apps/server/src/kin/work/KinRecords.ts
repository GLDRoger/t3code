// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@t3tools/shared/relaySigning";
import {
  KIN_RECORDS_PAGE_CAP,
  KIN_TEXT_LOCALE,
  KIN_WORK_ALSO_ON_MAX,
  KinChatError,
  KinAgentId,
  KinChatId,
  type KinMessageId,
  type KinMoney,
  type KinRepeatRule,
  type KinOrgId,
  KinPersonId,
  type KinRecordChangeVia,
  type KinRecordDetail,
  type KinRecordLinkKind,
  type KinRecordRelation,
  type KinRecordSide,
  type KinRecordState,
  type KinWorkPrincipal,
  KinRecordId,
  formatKinWhen,
  mentionsKinMoney,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Statement from "effect/sql/Statement";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";

import { KinRefreshObserver, KinWorkRefresh } from "../chat/KinRefreshHub.ts";
import type { ClosedSubject } from "../open/closeSubject.ts";
import { hashedEventId } from "../lead/eventIds.ts";
import { KinEventQueue } from "../lead/KinEventQueue.ts";
import { teammatesLimited } from "../lead/KinBudget.ts";
import * as LeadAccess from "../lead/LeadAccess.ts";
import * as Reach from "../lead/Reach.ts";
import {
  KIN_OWN_REFUSAL,
  kinOwnTurn,
  ownerLevel,
  ownerLevelAsked,
  ownsAgent,
  refuseKinOwn,
} from "../people/KinAccess.ts";
import { approvedClient, approvedFor, DRAFT_LIST, recordMade } from "../questions/approval.ts";
import {
  changeStampKey,
  codingAgentSource,
  followsOutsideRead,
  outsideRead,
  outsideStamp,
  stampEvent,
} from "../lead/OutsideContent.ts";
import { companyMoney, countryFirst, homeCurrency } from "./companyProfile.ts";
import {
  commentIdFor,
  commentsPage,
  insertComment,
  requestHashOf as commentHashOf,
} from "./recordComments.ts";
import { indexRecord, indexRecords } from "./searchIndex.ts";
import { SensitiveRefusal } from "./sensitiveReads.ts";
import {
  fieldList,
  checkFor,
  encodeFieldValues,
  type FieldValue,
  isMoney,
  LISTS,
  type ListName,
  parseFields,
  shownField,
  TEAM_LIST_RESERVED,
} from "./lists.ts";
import {
  BILL_TO_FIELDS,
  billToNameOf,
  clearedBillTo,
  clearsBillTo,
  hasBillTo,
  validateBillTo,
} from "./billTo.ts";
import {
  addUp,
  askSlip,
  dayIn,
  financialYearOf,
  formatMoney,
  isCurrency,
  monthOf,
} from "./money.ts";
import {
  amountOf,
  byId,
  byKey,
  CODING_AGENT_NAME,
  countedEntry,
  effectivelySensitive,
  OWN_LABEL_LISTS,
  encodeRepeat,
  type FieldChange,
  type Principal,
  invoiceDue,
  isClosed,
  isSuggestion,
  keptEntry,
  stillSuggestion,
  latestSeq,
  moneyDay,
  notFound,
  owedInvoices,
  ownerZone,
  parseChanges,
  principal,
  principalId,
  type RecordRow,
  repeatOf,
  samePrincipal,
  selectRecords,
  storedPrincipal,
  encodeSteps,
  shownSteps,
  stepsOf,
  keyWithheld,
  sensitiveNow,
  type StoredRepeat,
  toDetail,
  toRecord,
  unavailable,
  wordsOf,
} from "./recordRows.ts";
import {
  checkFields,
  isBuiltIn,
  numberingOf,
  type ListDef,
  listDef,
  owedState,
  owesIn,
  startState,
  stateLabel,
  unknownList,
  verifyRefs,
} from "./registers.ts";
import { contactFields } from "./contactDetails.ts";
import {
  BANK_CREDIT_ORIGIN,
  bankStates,
  directionOf,
  findBankList,
} from "./statements/bankList.ts";
import { markedKey } from "./keyCall.ts";
import { keyRefusal, moneyOf } from "./keyGuard.ts";
import { cleanTags } from "./tags.ts";
import { notAVendor } from "./vendorName.ts";
import {
  companyCashOut,
  FUNDED_BY,
  fundingOf,
  partnerRepaidDay,
  REIMBURSEMENT,
  REPAID_ON,
} from "./reimbursement.ts";
import { withArticle } from "../article.ts";
import { anchorOf, nextDates } from "./repeat.ts";
import {
  dismissedHold,
  dismissedHoldText,
  personInTurn,
  personSpokeInTurn,
} from "./dismissedHold.ts";
import {
  alsoOnIt,
  bumpTeamSeqs,
  dependentRows,
  teamGuard,
  crmSees,
  teamPairs,
  personSees,
  legacySeenBy,
  listMoneySeenBy,
  viewerOfPeople,
  ROOM_LISTS,
  teamSeesField,
  teamSeq,
  teamVisible,
  viewGuard,
  viewReadsWhole,
  viewSees,
} from "./teamView.ts";
import { holderFor, theirsHeldBy, theirsHolder } from "./promises.ts";

/** A follow-up's title: the leftover's first line, this long at most; the rest goes in its notes. */
const LEFTOVER_TITLE = 160;
/** Who is writing and how: a lead in its turn, the owner from a client, or Kin from an event. */
export type Writer = {
  readonly actor:
    | { readonly _tag: "agent"; readonly agentId: KinAgentId }
    | { readonly _tag: "person"; readonly personId: KinPersonId }
    | { readonly _tag: "system" };
  readonly via: KinRecordChangeVia;
  /** An agent's own turn; on a person's write, the turn whose confirmed ask Kin carries out. */
  readonly wakeupId?: string;
  readonly chatId?: KinChatId;
  /** The human who asked for this, from stored rows: becomes the assigner of work given away. */
  readonly askedBy?: KinPersonId | null;
  /** A teammate from their own app: `teamGuard` decides the write inside its transaction. */
  readonly teammate?: boolean;
  /** `deals.ts`, which decided the write's rules: no other path writes a deal. */
  readonly deal?: true;
  /** A member's write in Clients: a name clashes only with what this person sees there (`crmSees`). */
  readonly namesSeenBy?: KinPersonId;
  /** The person's own coding agent, with this key: the change's history names the key. */
  readonly codingAgentKey?: string;
  /** Shared with the team when made; a turn others read shares its tasks too (`ROOM_LISTS`). */
  readonly teamShared?: boolean;
  /** The holder whose doc head start this turn is (`docHeadStart`): its one new doc is theirs. */
  readonly headStartFor?: KinPersonId;
  /** A lead's turn others read: `viewGuard` decides the write inside its transaction. */
  // oxlint-disable-next-line t3code/kin-viewer-scoped-reads -- a write's guard, not a read; absent is an owner-level writer.
  readonly view?: {
    readonly people: ReadonlyArray<KinPersonId>;
    readonly askers: ReadonlyArray<KinPersonId>;
  };
  /** The cards a person's tap settles itself: closing the entry leaves them to the tap. */
  readonly answering?: ReadonlyArray<string>;
  /** An agent's write with no turn of its own, made from what one read: that turn's stamp. */
  readonly outside?: string;
  /**
   * Putting back a default `asker` took (`defaultTaken.ts`): reopened, a task is given to nobody
   * anew, and an agent holding it other than `asker` hears it is open again.
   */
  readonly undoing?: { readonly asker: string };
  /**
   * An agent's write: the last moment a person addressed its turn (`addressedAt`). It changes no
   * field a person changed at or after then, bar the trigger's own changes (`woke`, by seq) and,
   * when a tap set it, what that tap wrote as `tappedBy` in its own moment.
   */
  readonly since?: {
    readonly at: number;
    readonly woke: ReadonlyArray<number>;
    readonly tappedBy?: KinPersonId;
  };
};
/** What an agent on a task hears when it tries what only its holder, or a person's word, may do. */
export const ALSO_ON_UNASKED =
  "Who is on a task changes only when a person asks for it in this turn. Nothing was saved: ask them.";
/** The helper guard's refusal: a timed default it stops falls back to asking the person. */
export class KinHelperRefusal extends KinChatError {}
// @effect-diagnostics-next-line instanceOfSchema:off -- the subclass, not the schema, marks it.
export const isHelperRefusal = (error: unknown) => error instanceof KinHelperRefusal;
export const helperRefusal = (holder: string, key: string) =>
  `${holder} holds ${key}: put it to them as a comment or a card.`;

/** What closes the open things about an entry that closed, in its move's transaction. */
export type Closing = (subject: ClosedSubject) => Effect.Effect<void, { readonly _tag: string }>;
/** Whose words a write's text is: the person writing, else the human a lead wrote it for. */
const textBy = (writer: Writer) =>
  writer.actor._tag === "person" ? writer.actor.personId : (writer.askedBy ?? null);

export type Fields = {
  readonly title: string;
  readonly state?: KinRecordState;
  readonly waitingOn?: KinWorkPrincipal | null;
  readonly owner: KinWorkPrincipal;
  /** A Work category, or a client's kind (`client`, `vendor`). */
  readonly category?: string | null;
  readonly side?: KinRecordSide;
  readonly dueAt?: number | null;
  readonly dueAllDay?: boolean;
  readonly notes?: string;
  /**
   * `false` makes a new entry a suggestion; `true` keeps one, which only `mayKeep` writers do. Who
   * writes decides the rest (`startsKept`), never this.
   */
  readonly confirmed?: boolean;
  /** Raised by anyone; lowered only by a person, which the owner-only callers make the owner. */
  readonly sensitive?: boolean;
  /** Shared with the team (`teamView.ts`); only the owner's `share` and a teammate's own create set it. */
  readonly team?: boolean;
  /** Record ids of a client and a project in this org. */
  readonly partyId?: string | null;
  readonly projectId?: string | null;
  readonly repo?: string | null;
  /** The list's own fields; `null` removes one. */
  readonly fields?: Readonly<Record<string, FieldValue | null>>;
  /** Integer minor units in an ISO currency; only lists with an amount, and Work. */
  readonly amount?: KinMoney | null;
  /** A person's form that asks: a new amount far above its list is refused (`askSlip`). */
  readonly askSlip?: boolean;
  /** When it happened, was issued or starts; only defined lists. */
  readonly dateAt?: number | null;
  readonly dateAllDay?: boolean;
  /** Needs a due date or a date to repeat from; not on clients, contacts or projects. */
  readonly repeat?: KinRepeatRule | null;
  /** A task's whole checklist, in order; only Work. */
  readonly steps?: ReadonlyArray<Step>;
  readonly urgent?: boolean;
};
type Step = { readonly title: string; readonly done: boolean };
export type CreateInput = Fields & {
  /** Default `work`; a built-in list or one defined in this org. */
  readonly list?: string;
  /** A create with a key already stored returns that entry and changes nothing. */
  readonly originKey: string;
  /** A person's request (`requestHashOf`): the same key asking for something else is refused. */
  readonly requestHash?: string;
  readonly source?: { readonly chatId: KinChatId; readonly messageId: KinMessageId };
  readonly links?: ReadonlyArray<LinkInput>;
  /** The entry this one is made from, such as a quote's invoice: made from a suggestion, it is one. */
  readonly from?: string;
  /** When an import says it was made, and closed if it is; otherwise now. */
  readonly createdAt?: number;
  readonly closedAt?: number;
};
export type PlainImportInput = Pick<
  CreateInput,
  | "originKey"
  | "title"
  | "category"
  | "dueAt"
  | "dueAllDay"
  | "notes"
  | "sensitive"
  | "amount"
  | "dateAt"
  | "dateAllDay"
  | "createdAt"
  | "closedAt"
  | "steps"
  | "urgent"
> & { readonly state: KinRecordState };

export type Patch = Partial<Omit<Fields, "owner">> & {
  readonly owner?: KinWorkPrincipal;
  /** The holder gives it back to `owner`, whoever gave it to them, in their own words. */
  readonly handedBack?: { readonly note: string | null };
  /**
   * What is left of a task this change closes done: Kin files it as a follow-up for the same
   * holder, client and project, linked to this one, in the same write.
   */
  readonly leftover?: string;
  /** What a field's old and new ids read as now, kept on its history line (`FieldChange.names`). */
  readonly names?: Readonly<Record<string, NonNullable<FieldChange["names"]>>>;
  /**
   * Ticks or unticks one step against the checklist as stored now; a step at `index` with other
   * words means the steps changed since the screen read them.
   */
  readonly tick?: { readonly index: number; readonly title: string; readonly done: boolean };
};
const selfLeave = (
  writer: Writer,
  row: RecordRow,
  patch: Patch,
  also: ReadonlyArray<FieldChange>,
): KinPersonId | undefined => {
  const person =
    writer.actor._tag === "person"
      ? writer.actor.personId
      : writer.actor._tag === "agent" &&
          writer.askedBy != null &&
          writer.view?.askers.length === 1 &&
          writer.view.askers[0] === writer.askedBy
        ? writer.askedBy
        : undefined;
  const { fields, ...rest } = patch;
  if (
    person === undefined ||
    row.registerId !== "work" ||
    also.length !== 0 ||
    fields === undefined ||
    Object.keys(fields).length !== 1 ||
    fields.alsoOn === undefined ||
    Object.values(rest).some((value) => value !== undefined)
  )
    return undefined;
  const stored = fieldList(parseFields(row.fieldsJson), "alsoOn");
  const me = `person:${person}`;
  if (!stored.includes(me)) return undefined;
  const remaining = stored.filter((one) => one !== me);
  const asked = fields.alsoOn ?? [];
  return Array.isArray(asked) &&
    asked.length === remaining.length &&
    remaining.every((entry, index) => entry === asked[index])
    ? person
    : undefined;
};

export type LinkInput = {
  readonly kind: KinRecordLinkKind;
  readonly target: string;
  readonly relation: KinRecordRelation;
  readonly chatId?: KinChatId | null;
  readonly label?: string | null;
};
/** What `kinWorkMove` and its order read of a record, for every match at once. */
export type MoveRow = {
  readonly recordId: string;
  readonly key: string;
  readonly state: KinRecordState;
  readonly ownerKind: "person" | "agent";
  readonly ownerId: string;
  readonly waitingOnKind: "person" | "agent" | null;
  readonly waitingOnId: string | null;
  readonly dueAt: number | null;
  readonly confirmed: number;
  /** Who asked for it: stored, else the person who made it, else the person who gave it. */
  readonly askedBy: string | null;
  readonly assignedBy: string | null;
  readonly assignedByAgent: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Handed back to its holder, when (`kinWorkHandedBackOpen`). */
  readonly handedBackAt: number | null;
  readonly urgent: number | null;
  /** Who is on it besides its holder, as stored (`fields.alsoOn`); null with none. */
  readonly alsoOn: string | null;
};
const MOVE_ROWS_CAP = 5_000;

export type QueryInput = {
  /** Default `work`. */
  readonly list?: string;
  /** `null`: entries with no client. */
  readonly partyId?: string | null;
  readonly projectId?: string;
  readonly repo?: string;
  readonly owner?: KinWorkPrincipal;
  /** With `owner` a person: also the tasks they are on besides its holder, as Tasks' Mine reads. */
  readonly orAlsoOn?: boolean;
  readonly states?: ReadonlyArray<KinRecordState>;
  readonly open?: boolean;
  readonly late?: boolean;
  readonly dueBy?: number;
  readonly dueAfter?: number;
  /**
   * Paid expenses Money's "spent" counts in these days: the company's own by their date in
   * `[fromAt, toAt)`, a partner's by the day it was paid back, `from` to `to`.
   */
  readonly spent?: {
    readonly from: string;
    readonly to: string;
    readonly fromAt: number;
    readonly toAt: number;
  };
  /** Its own date, or the time it was added when it has none, in `[dateFrom, dateTo)`. */
  readonly dateFrom?: number;
  readonly dateTo?: number;
  /** A payment that still counts was received on a day in `[paidFrom, paidTo]`. */
  readonly paidFrom?: string;
  readonly paidTo?: string;
  /** `true`: only what a figure counts (`keptEntry`); `false`: suggestions not dropped. */
  readonly kept?: boolean;
  readonly text?: string;
  readonly keys?: ReadonlyArray<string>;
  /** Closed at or after this time. */
  readonly closedAfter?: number;
  /** `null`: entries with no category. */
  readonly category?: string | null;
  readonly side?: KinRecordSide;
  readonly offset?: number;
  readonly limit?: number;
  /** The time `late` is judged at; a later page passes the first page's so offsets hold. */
  readonly at?: number;
  /** Only what this teammate may see (`teamView.ts`), and the change number of only that. */
  // oxlint-disable-next-line t3code/kin-viewer-scoped-reads -- the owner-level primitive; person reads reach it only through ownerWork/leadWork, which set it.
  readonly team?: KinPersonId;
  /** Only what every one of these people may see (`viewSees`). */
  // oxlint-disable-next-line t3code/kin-viewer-scoped-reads -- the owner-level primitive; person reads and writes reach it through ownerWork/leadWork, which set it.
  readonly view?: ReadonlyArray<KinPersonId>;
  /** Server-only, never from a client: soonest due first, whatever the state. */
  readonly order?: "dueFirst";
  /** Server-only, never from a client: nothing a coding-agent key may not reach, before the limit. */
  readonly withoutSensitive?: boolean;
};

const isChatError = Schema.is(KinChatError);
const encodeFields = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        field: Schema.String,
        from: Schema.NullOr(Schema.String),
        to: Schema.NullOr(Schema.String),
        names: Schema.optional(
          Schema.Struct({ from: Schema.NullOr(Schema.String), to: Schema.NullOr(Schema.String) }),
        ),
      }),
    ),
  ),
);
export type Tick = {
  readonly seq: number;
  readonly key?: string;
  readonly registerId?: string;
  /** The change made the entry. */
  readonly created?: true;
  /** Each person who could see what changed, before or after it, and their own number now. */
  readonly team?: ReadonlyMap<string, number>;
  /** Rows to read again for a teammate because this write can change their visibility. */
  readonly dependents?: ReadonlyArray<{ readonly key: string; readonly registerId: string }>;
  /** People whose level or places changed, so what they may see may have (`peopleMoved`). */
  readonly people?: ReadonlyArray<string>;
  /**
   * Projects whose holders changed: the entry was made in, moved between, or given to someone in
   * them. Holding a task there shows a project's docs (`personSees`), so their people look again.
   */
  readonly projects?: ReadonlyArray<string>;
};
/** Whose view of Work a change can move: the entries it may show or hide, and who saw them before. */
type TeamScope = {
  readonly scope: ReadonlyArray<string>;
  readonly before: ReadonlyArray<{ readonly personId: string; readonly recordId: string }>;
  readonly dependents?: Tick["dependents"];
  /** People joined to or taken off a project: their tasks there read differently, seen or not. */
  readonly joined?: ReadonlyArray<string>;
};
export type GroupBy = "party" | "project" | "side" | "owner" | "state" | "category";
export type TotalsBy = GroupBy | "month" | "financialYear";
/** Past this many entries with an amount, totals ask for a narrower filter instead of guessing. */
const TOTALS_CAP = 20_000;
type Sums = {
  readonly total: ReadonlyArray<KinMoney>;
  /** In a list paid over time: what its open entries still have unpaid. */
  readonly owed?: ReadonlyArray<KinMoney>;
  /** With a paid window: the payments made in it. */
  readonly received?: ReadonlyArray<KinMoney>;
  /** Quotes sent and waiting, and accepted. */
  readonly sent?: ReadonlyArray<KinMoney>;
  readonly accepted?: ReadonlyArray<KinMoney>;
  /** The bank list's money in, money out, and in less out; `total` stays the plain sum. */
  readonly moneyIn?: ReadonlyArray<KinMoney>;
  readonly moneyOut?: ReadonlyArray<KinMoney>;
  readonly net?: ReadonlyArray<KinMoney>;
};
export type Totals = Sums & {
  readonly withheld?: true;
  readonly counted: number;
  readonly groups?: ReadonlyArray<Sums & { readonly group: string | null; readonly count: number }>;
};
export type PaymentInput = {
  readonly amount: KinMoney;
  /** A day in the owner's zone. */
  readonly paidOn: string;
  readonly note?: string;
  /** Tax the payer withheld at source: it settles the invoice but is no money received. */
  readonly withheld?: boolean;
  /** A retry with the same key records nothing more; one whose payment was voided is refused. */
  readonly originKey: string;
};
const CLOSED = ["done", "dropped"] as const;
/** Quotes and invoices: real only on an owner-level person's word (`startsKept`). */
const ISSUED_LISTS: ReadonlySet<string> = new Set(["quotes", "invoices"]);
/** Lists whose entries are issued, sent or paid: a suggestion there is none of those. */
const MONEY_LISTS: ReadonlySet<string> = new Set(["quotes", "invoices", "expenses", "receipts"]);
/** A client and a prospect share names: one company is either, never both at once. */
export const clientFamily = (sql: SqlClient.SqlClient, category: Statement.Fragment) =>
  sql`(CASE COALESCE(${category}, 'client') WHEN 'prospect' THEN 'client'
    ELSE COALESCE(${category}, 'client') END)`;
const OPEN_KEYS_NAMED = 20;
/** A retry whose first result was taken back since: answering it with that result would lie. */
const undoneRetry = (what: string) =>
  new KinChatError({
    reason: "conflict",
    message: `That retry key's ${what} was taken back since, so a retry can't stand for it. Record it again as a new one.`,
  });
const conflict = (key: string, rev: number) =>
  new KinChatError({
    reason: "conflict",
    message: `${key} changed since you read it; it is at revision ${rev} now. Read it again.`,
  });
/** What a person's create asked for, without the id it was sent under. */
export const requestHashOf = ({ clientRequestId: _, ...request }: { clientRequestId: string }) =>
  NodeCrypto.createHash("sha256").update(stableStringify(request)).digest("hex");
const recordIdFor = (orgId: string, originKey: string) =>
  KinRecordId.make(
    `rec_${NodeCrypto.createHash("sha256").update(`${orgId.length}:${orgId}${originKey}`).digest("hex").slice(0, 24)}`,
  );
const shown = (value: string | number | boolean | null | undefined) =>
  value === null || value === undefined ? null : String(value);
const shownPrincipal = (who: KinWorkPrincipal | null | undefined) =>
  who === null || who === undefined ? null : `${who._tag}:${principalId(who)}`;
const shownDue = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(ms));
const shownAmount = (money: KinMoney | null | undefined) =>
  money === null || money === undefined ? null : formatMoney(money);
const shownRepeat = (rule: KinRepeatRule | null | undefined) =>
  rule === null || rule === undefined
    ? null
    : rule.every === "days"
      ? `every ${rule.days} days`
      : `every ${rule.every}`;
/** A History field as the one thing a person set: a date with its all-day flag, a holder with its marks. */
const asSet = (field: string) =>
  field === "dueAllDay"
    ? "due"
    : field === "dateAllDay"
      ? "date"
      : field === "untold" || field === "handedBack"
        ? "owner"
        : field;
const FIELD_NAMES: Readonly<Record<string, string>> = {
  owner: "its holder",
  waitingOn: "who it waits on",
  steps: "its steps",
  urgent: "its urgent mark",
  due: "its due date",
  party: "its client",
};
/** What a refusal may quote of an entry that isn't sensitive; money, notes and a list's own fields it doesn't. */
const QUOTED = new Set(["title", "state", "owner", "waitingOn", "due", "date", "category", "side"]);
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const notAllowed = (message: string) => new KinChatError({ reason: "not_allowed", message });
/** A person named as an expense's funder, on a list that keeps a reimbursement for it. */
const funds = (def: ListDef, funder: unknown) =>
  def.id === "expenses" &&
  typeof funder === "string" &&
  funder.startsWith("person:") &&
  def.fields.some((one) => one.key === REIMBURSEMENT);
/** A repaid day after today in the owner's zone: nothing is paid back before it happens. */
const repaidAhead = (fields: Readonly<Record<string, unknown>>, today: string) => {
  const day = fields[REPAID_ON];
  return typeof day === "string" && day.slice(0, 10) > today
    ? invalid(`Repaid on can't be after today, ${today}.`)
    : undefined;
};
/** Who funded an expense and whether it was paid back: a person's word, or one they gave in person. */
const FUNDING = [FUNDED_BY, REIMBURSEMENT, REPAID_ON] as const;
export const FUNDING_IS_THE_OWNERS =
  "Only the owner or a co-owner says who funded an expense or that it was paid back, in their own message or tap before anything outside is read. Nothing changed. Put it to them as a card or a question.";
export const FUNDING_A_PERSON_SET =
  "A person said who funded this expense or whether it was paid back, and an agent doesn't change that. Nothing changed. Put it to the owner as a card or a question.";

/**
 * Whether an agent may say who funded an expense or that it was paid back: an owner-level person
 * started the turn with their own message or tap, and it has read nothing from outside.
 */
export const agentMayFund = Effect.fn("KinRecords.agentMayFund")(function* (
  orgId: KinOrgId,
  writer: Writer,
) {
  if (writer.actor._tag !== "agent") return true;
  const wakeupId = writer.wakeupId;
  if (wakeupId === undefined) return false;
  return (
    (yield* personSpokeInTurn(orgId, writer.actor.agentId, wakeupId)) &&
    (yield* ownerLevelAsked(orgId, writer.actor.agentId, wakeupId)) &&
    !(yield* outsideRead({ orgId, wakeupId })) &&
    !(yield* followsOutsideRead(orgId, wakeupId))
  );
});

/** Whether an amount or fields put money on an entry. */
const recordsMoney = (
  amount: KinMoney | null | undefined,
  fields: Readonly<Record<string, FieldValue | null>> | undefined,
) =>
  (amount !== undefined && amount !== null) ||
  Object.values(fields ?? {}).some((value) => value !== null && isMoney(value));
const NUMBERS_ARE_ISSUED =
  "Kin gives this list's entries their numbers when they are issued, so nothing else sets one. Issue the entry instead; an invoice numbered elsewhere keeps that number in its notes.";
/** A receipt's payment, invoice and number are Kin's own (`gendocs/receipts.ts` writes them). */
const RECEIPT_TIES = ["payment", "invoice", "number"];
const RECEIPT_TIES_ARE_KINS =
  "Kin writes a receipt's payment, invoice and number itself: make the receipt from its payment, or set an advance against an invoice, instead. Nothing changed.";
const actorIdOf = (writer: Writer) =>
  writer.actor._tag === "agent"
    ? writer.actor.agentId
    : writer.actor._tag === "person"
      ? writer.actor.personId
      : null;
export const paymentIdFor = (orgId: string, originKey: string) =>
  `pay_${NodeCrypto.createHash("sha256").update(`${orgId.length}:${orgId}${originKey}`).digest("hex").slice(0, 20)}`;

/** What a write may set on a list: its states, kinds, fields, and an amount, date or repeat. */
const dealsOnly = new KinChatError({
  reason: "invalid_state",
  message: "A deal changes in Deals: move it, win or lose it there.",
});

const checkInput = (
  def: ListDef,
  input: {
    readonly title?: string | undefined;
    readonly state?: KinRecordState | undefined;
    readonly category?: string | null | undefined;
    readonly fields?: Readonly<Record<string, FieldValue | null>> | undefined;
    readonly amount?: KinMoney | null | undefined;
    readonly dateAt?: number | null | undefined;
    readonly repeat?: KinRepeatRule | null | undefined;
    readonly steps?: boolean;
  },
): KinChatError | undefined => {
  if (input.steps === true && def.id !== "work")
    return invalid(
      `Only a task has steps or an urgent mark; ${withArticle(def.noun)} has neither.`,
    );
  if (input.title !== undefined && mentionsKinMoney(input.title))
    return invalid(
      "A title never holds an amount: give the amount on its own and keep the title to what it was for.",
    );
  if (input.amount !== undefined && input.amount !== null) {
    if (!def.amount && def.builtIn !== "work")
      return invalid(`${withArticle(def.noun, "A")} has no amount.`);
    if (!isCurrency(input.amount.currency))
      return invalid(`${input.amount.currency} is not a currency code.`);
    if (input.amount.minor < 0 && def.id !== "expenses")
      return invalid("Only an expense's amount goes below zero, as a refund or credit.");
  }
  // A Work meeting's start is its date; due stays what someone owes by when.
  if (
    input.dateAt !== undefined &&
    input.dateAt !== null &&
    def.builtIn !== null &&
    def.builtIn !== "work"
  )
    return invalid(`${withArticle(def.noun, "A")} has no date of its own; use due.`);
  if (
    input.repeat !== undefined &&
    input.repeat !== null &&
    def.builtIn !== null &&
    def.builtIn !== "work"
  )
    return invalid(`${withArticle(def.noun, "A")} doesn't repeat.`);
  if (def.builtIn !== null) return checkFor(def.builtIn, input);
  if (input.state !== undefined && !def.states.includes(input.state))
    return invalid(
      `${def.name} entries are ${def.states.join(", ")}; ${input.state} is not one of them.`,
    );
  if (
    input.category !== undefined &&
    input.category !== null &&
    !def.categories.includes(input.category)
  )
    return invalid(
      def.categories.length === 0
        ? `${def.name} has no categories.`
        : `${def.name}'s categories are ${def.categories.join(", ")}.`,
    );
  const vendor = input.fields?.vendor;
  if (def.id === "expenses" && typeof vendor === "string" && notAVendor(vendor))
    return invalid(
      `"${vendor.slice(0, 60)}" is not a vendor: give who was paid, as the receipt or bill names them, or leave vendor off.`,
    );
  return input.fields === undefined ? undefined : checkFields(def, input.fields);
};

/**
 * An invoice, or a renewal on Dates, for nothing: it isn't owed, so it isn't kept as owed. An
 * agent's expense for nothing is a free plan's bill or a misread one; only the owner keeps those.
 */
const zeroOwed = (
  def: ListDef,
  amount: KinMoney | null | undefined,
  category: string | null | undefined,
  writer: Writer,
) =>
  amount?.minor !== 0
    ? undefined
    : def.id === "invoices" || (def.id === "dates" && category === "renewal")
      ? invalid(
          `${def.id === "invoices" ? "An invoice" : "A renewal"} for 0 isn't owed; leave the amount off or drop it.`,
        )
      : def.id === "expenses" && writer.actor._tag !== "person"
        ? invalid(
            "An expense for 0 cost nothing, so it isn't recorded: skip a receipt or bill for 0, such as a free plan's, and say so. If you couldn't read the amount, leave it off and set suggested true.",
          )
        : undefined;

export class KinRecords extends Context.Service<
  KinRecords,
  {
    /** Creates an independent import chunk, or returns false with nothing written. */
    readonly createImportChunk: (
      orgId: KinOrgId,
      personId: KinPersonId,
      list: "work" | "expenses",
      entries: ReadonlyArray<PlainImportInput>,
    ) => Effect.Effect<boolean>;
    readonly create: (
      orgId: KinOrgId,
      writer: Writer,
      input: CreateInput,
    ) => Effect.Effect<{ readonly row: RecordRow; readonly created: boolean }, KinChatError>;
    readonly update: (
      orgId: KinOrgId,
      writer: Writer,
      key: string,
      patch: Patch,
      expectedRev?: number,
      /** Logged with the change even when no column changes: a doc's new version. */
      also?: ReadonlyArray<FieldChange>,
    ) => Effect.Effect<RecordRow, KinChatError>;
    /** Fails as `update` does when `who` can't hold an entry or be waited on: unknown, or retired. */
    readonly principalExists: (
      orgId: KinOrgId,
      who: KinWorkPrincipal,
      role?: string,
    ) => Effect.Effect<void, KinChatError>;
    /**
     * The holder gives an open task back to whoever gave it to them: the agent that did, else the
     * person, else the owner. It reopens, and an agent it goes back to is woken with their words.
     */
    readonly handBack: (
      orgId: KinOrgId,
      writer: Writer,
      key: string,
      holder: KinWorkPrincipal,
      note: string | null,
    ) => Effect.Effect<RecordRow, KinChatError>;
    readonly link: (
      orgId: KinOrgId,
      writer: Writer,
      recordId: string,
      link: LinkInput,
    ) => Effect.Effect<boolean, KinChatError>;
    /**
     * Takes off the link a "linked" change made (its kind, what it showed, when), and for an entry
     * the link back made with it, each recorded on its entry. False when it is already gone.
     */
    readonly unlink: (
      orgId: KinOrgId,
      writer: Writer,
      recordId: string,
      link: { readonly kind: string; readonly shown: string; readonly at: number },
    ) => Effect.Effect<boolean, KinChatError>;
    /** Money paid against an entry paid over time; in full, it is marked paid. Never more than owed. */
    readonly pay: (
      orgId: KinOrgId,
      writer: Writer,
      key: string,
      payment: PaymentInput,
    ) => Effect.Effect<{ readonly row: RecordRow; readonly paymentId: string }, KinChatError>;
    /** Takes a payment back; an entry it leaves short is owed again. */
    readonly voidPayment: (
      orgId: KinOrgId,
      writer: Writer,
      key: string,
      paymentId: string,
    ) => Effect.Effect<RecordRow, KinChatError>;
    /** Exact sums of the amounts `query`'s filter matches, per currency, and per group if asked. */
    readonly totals: (
      orgId: KinOrgId,
      input: QueryInput,
      by?: TotalsBy,
      /** Count entries with no amount too, as a list without amounts needs. */
      everyEntry?: boolean,
    ) => Effect.Effect<Totals, KinChatError>;
    readonly query: (
      orgId: KinOrgId,
      input: QueryInput,
    ) => Effect.Effect<
      { readonly rows: ReadonlyArray<RecordRow>; readonly total: number; readonly seq: number },
      KinChatError
    >;
    /** Every match of `query`'s filter, unpaged, as `kinWorkMove` reads it; at most `MOVE_ROWS_CAP`. */
    readonly moveRows: (
      orgId: KinOrgId,
      input: QueryInput,
    ) => Effect.Effect<ReadonlyArray<MoveRow>, KinChatError>;
    /** Counts per group over the same filter as `query`, most first, at most 50 groups. */
    readonly groups: (
      orgId: KinOrgId,
      input: QueryInput,
      by: GroupBy,
    ) => Effect.Effect<
      ReadonlyArray<{
        readonly group: string | null;
        readonly count: number;
        readonly late: number;
      }>,
      KinChatError
    >;
    readonly get: (
      orgId: KinOrgId,
      key: string,
    ) => Effect.Effect<RecordRow | undefined, KinChatError>;
    readonly getById: (
      orgId: KinOrgId,
      recordId: string,
    ) => Effect.Effect<RecordRow | undefined, KinChatError>;
    readonly detail: (
      row: RecordRow,
      changeLimit?: number,
    ) => Effect.Effect<
      Effect.Success<ReturnType<typeof toDetail>> &
        Pick<KinRecordDetail, "askedBy" | "comments" | "olderComments">,
      KinChatError
    >;
    readonly seq: (orgId: KinOrgId) => Effect.Effect<number, KinChatError>;
    /**
     * In the caller's transaction: a person's comment on a task an agent holds wakes that agent
     * once per comment, on that person's authority, as their message to it would. False when
     * nobody is woken, as when the agent is theirs to message no longer.
     */
    readonly commented: (
      orgId: KinOrgId,
      personId: KinPersonId,
      row: RecordRow,
      commentSeq: number,
      note: string,
    ) => Effect.Effect<boolean, KinChatError>;
    /**
     * The latest change number now, then again with the entry after every committed change, its
     * list, and the people besides the owner who may see it after that change (`teamView.ts`).
     */
    readonly changes: (orgId: KinOrgId) => Stream.Stream<Tick, KinChatError>;
    /**
     * Tells `changes` an org's entries moved with no change logged here: an undo, another process.
     * Given the entries that moved, as a contact logged on a client, only those are read again.
     */
    readonly announce: (
      orgId: KinOrgId,
      recordIds?: ReadonlyArray<string>,
    ) => Effect.Effect<void, KinChatError>;
    /** Kin's layer attaches `closeSubject`, which sits above chat, for as long as its scope. */
    readonly attachClosing: (closing: Closing) => Effect.Effect<void, never, Scope.Scope>;
    /**
     * In the caller's transaction: these people's level or places changed, so what they may see
     * may have. Moves their own change numbers and tells `changes` once it commits.
     */
    readonly peopleMoved: (
      orgId: KinOrgId,
      personIds: ReadonlyArray<string>,
    ) => Effect.Effect<void, KinChatError>;
  }
>()("t3/kin/work/KinRecords") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const queue = yield* KinEventQueue;
  const dailyTurns = yield* LeadAccess.dailyTurns;
  const ticks = yield* PubSub.unbounded<Tick & { readonly orgId: KinOrgId }>();
  const refreshes = yield* KinRefreshObserver;
  let closing: Closing | undefined;
  /** The clients and projects a task or project can be put under (`workChoices`) changed. */
  const choicesMoved = (orgId: KinOrgId, list: string) =>
    list === "clients" || list === "projects" ? refreshes.touch(orgId, "workChoices") : Effect.void;
  const provideSql = Effect.provideService(SqlClient.SqlClient, sql);
  const gstCompany = (orgId: KinOrgId) =>
    companyMoney(orgId).pipe(
      provideSql,
      Effect.map((money) => money.country === "IN"),
    );

  const failed = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapError((error) =>
        isChatError(error)
          ? Effect.void
          : Effect.logWarning("Kin Work failed", {
              errorTag: error._tag,
              ...(isSqlError(error) ? { message: error.message } : {}),
            }),
      ),
      Effect.mapError((error) => (isChatError(error) ? error : unavailable)),
    );
  const transaction = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
    failed(sql.withTransaction(effect));

  const reserveKeys = Effect.fn("KinRecords.reserveKeys")(function* (
    orgId: KinOrgId,
    def: ListDef,
    now: number,
    count: number,
  ) {
    const take = sql<{ next: number; prefix: string }>`
      UPDATE kin_registers SET next_number = next_number + ${count}
      WHERE org_id = ${orgId} AND register_id = ${def.id}
      RETURNING next_number - ${count} AS next, key_prefix AS prefix`;
    let [register] = yield* take;
    // A defined list's register is written when it is defined; a built-in one on first use.
    if (register === undefined && def.builtIn !== null) {
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
        VALUES (${orgId}, ${def.id}, ${def.name}, ${def.prefix}, 1, ${now})
        ON CONFLICT DO NOTHING`;
      [register] = yield* take;
    }
    if (register === undefined) return yield* unavailable;
    return register;
  });

  // Each created row uses the same audit shape, including rows inserted in a chunk.
  const changeValues = Effect.fnUntraced(function* (
    orgId: KinOrgId,
    writer: Writer,
    row: { readonly recordId: string; readonly rev: number },
    kind: "created" | "updated" | "linked",
    fields: ReadonlyArray<FieldChange>,
    now: number,
  ) {
    return {
      org_id: orgId,
      record_id: row.recordId,
      rev: row.rev,
      at: now,
      actor_kind: writer.actor._tag,
      actor_id: actorIdOf(writer),
      via: writer.via,
      kind,
      fields_json: yield* encodeFields(fields),
      wakeup_id: writer.wakeupId ?? null,
      chat_id: writer.chatId ?? null,
      asked_by_person_id: writer.actor._tag === "agent" ? (writer.askedBy ?? null) : null,
      coding_agent_key: (yield* markedKey(writer)) ?? null,
    };
  });

  const logChange = Effect.fn("KinRecords.logChange")(function* (
    orgId: KinOrgId,
    writer: Writer,
    row: { readonly recordId: string; readonly key: string; readonly rev: number },
    kind: "created" | "updated" | "linked",
    fields: ReadonlyArray<FieldChange>,
    now: number,
    team?: TeamScope,
  ) {
    const values = yield* changeValues(orgId, writer, row, kind, fields, now);
    const [change] = yield* sql<{ seq: number }>`INSERT INTO kin_record_changes
      ${sql.insert(values)} RETURNING seq`;
    const seq = change?.seq ?? 0;
    // What the agent's turn had read from outside when it wrote this, for the entry's sheet.
    if (writer.actor._tag === "agent" && writer.outside !== undefined)
      yield* stampEvent(orgId, changeStampKey(row.recordId, seq), writer.outside).pipe(provideSql);
    else if (writer.actor._tag === "agent" && writer.wakeupId !== undefined)
      yield* outsideStamp({ orgId, wakeupId: writer.wakeupId }).pipe(
        Effect.flatMap((source) => stampEvent(orgId, changeStampKey(row.recordId, seq), source)),
        provideSql,
      );
    // Who sees it as this change leaves it, and what else of theirs it showed or hid (`personSees`).
    const [stored] = yield* sql<{ registerId: string; projectKey: string | null }>`SELECT
        r.register_id AS "registerId", p.key AS "projectKey"
      FROM kin_records r LEFT JOIN kin_records p ON p.org_id = r.org_id
        AND p.record_id = r.project_id
      WHERE r.org_id = ${orgId} AND r.record_id = ${row.recordId}`;
    // Every move into a closed state passes here: what was open about the entry closes with it.
    const closed = fields.find((one) => one.field === "state");
    if (
      closing !== undefined &&
      stored !== undefined &&
      kind === "updated" &&
      closed?.to != null &&
      closed.to !== closed.from &&
      (CLOSED as ReadonlyArray<string>).includes(closed.to)
    )
      yield* closing({
        orgId,
        recordId: row.recordId,
        key: row.key,
        registerId: stored.registerId,
        state: closed.to,
        sparing: writer.answering ?? [],
        now,
      });
    const holders =
      kind === "created" || fields.some((one) => one.field === "owner" || one.field === "project");
    const shifted = fields.find((one) => one.field === "project");
    const projects = holders
      ? [...new Set([shifted?.from, shifted?.to, stored?.projectKey])].filter(
          (key): key is string => typeof key === "string",
        )
      : [];
    const before = team?.before ?? [];
    const after = yield* teamPairs(orgId, [
      ...new Set([row.recordId, ...(team?.scope ?? [])]),
    ]).pipe(provideSql);
    const seen = (pairs: typeof after, personId: string) =>
      pairs
        .filter((pair) => pair.personId === personId)
        .map((pair) => pair.recordId)
        .join(" ");
    // Its own number moves for anyone who saw it before or sees it after, and for anyone whose
    // view of the rest it moved, as a client's label or a project's lead does.
    const moved = [
      ...new Set([
        ...[...before, ...after]
          .map((pair) => pair.personId)
          .filter(
            (personId) =>
              [...before, ...after].some(
                (pair) => pair.personId === personId && pair.recordId === row.recordId,
              ) || seen(before, personId) !== seen(after, personId),
          ),
        ...(team?.joined ?? []),
      ]),
    ];
    const numbers = yield* bumpTeamSeqs(orgId, moved).pipe(provideSql);
    yield* sql.afterCommit(
      PubSub.publish(ticks, {
        orgId,
        seq,
        key: row.key,
        ...(stored === undefined ? {} : { registerId: stored.registerId }),
        ...(kind === "created" ? { created: true as const } : {}),
        team: numbers,
        ...(team?.dependents === undefined ? {} : { dependents: team.dependents }),
        ...(projects.length === 0 ? {} : { projects }),
      }),
    );
    return seq;
  });

  /**
   * Where a teammate's assignment wakes a lead: their direct chat with it, while they may message
   * it (`Reach`) and they have turns left today, as `ChatWake` admits their messages. Asked
   * from their own app, a refusal fails the write, so nothing is given away that won't be done.
   */
  const teammateWake = Effect.fn("KinRecords.teammateWake")(function* (
    orgId: KinOrgId,
    writer: Writer,
    agentId: KinAgentId,
    personId: KinPersonId,
    now: number,
    /** Putting it on is refused whoever writes: saved with no way to wake it would be a lie. */
    always: boolean,
  ) {
    const own = always || (writer.actor._tag === "person" && writer.actor.personId === personId);
    const refuse = (error: KinChatError) => (own ? Effect.fail(error) : Effect.void);
    // A co-owner has no daily cap, as the owner does.
    const level = yield* ownerLevel(orgId, personId).pipe(provideSql);
    if (
      !(yield* Reach.reaches(orgId, Reach.person(personId), Reach.agent(agentId)).pipe(provideSql))
    )
      return yield* refuse(
        new KinChatError({
          reason: "not_found",
          message: `No agent ${agentId.slice(0, 60)} here to own it.`,
        }),
      );
    const [agent] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_agents
      WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
    const name = agent?.name ?? "That agent";
    const [chat] = yield* sql<{ chatId: string; memberId: string }>`
      SELECT c.chat_id AS "chatId", m.member_id AS "memberId" FROM kin_chats c
      JOIN kin_chat_members m ON m.org_id = c.org_id AND m.chat_id = c.chat_id
        AND m.principal_kind = 'person' AND m.person_id = ${personId} AND m.left_at IS NULL
      JOIN kin_chat_members l ON l.org_id = c.org_id AND l.chat_id = c.chat_id
        AND l.principal_kind = 'agent' AND l.agent_id = ${agentId} AND l.left_at IS NULL
      WHERE c.org_id = ${orgId} AND c.kind = 'direct'
        AND c.direct_key = ${LeadAccess.directKey(personId, agentId)}
      ORDER BY c.chat_id LIMIT 1`;
    if (chat === undefined)
      return yield* refuse(
        new KinChatError({
          reason: "not_allowed",
          message: `Open your chat with ${name} once, then give it this again.`,
        }),
      );
    const used = level
      ? { turns: 0 }
      : yield* LeadAccess.recentTurns({ orgId, personId, now }).pipe(provideSql);
    if (used.turns >= dailyTurns && (yield* teammatesLimited(orgId).pipe(provideSql)))
      return yield* refuse(
        new KinChatError({
          reason: "not_allowed",
          message: `${name} has done as much as it can for you today. Give it this again later.`,
        }),
      );
    return { chatId: KinChatId.make(chat.chatId), memberId: chat.memberId };
  });

  /**
   * Wakes a lead about an entry someone else changed, with that human as the turn's provenance:
   * given to it (`assigned`), closed or taken back while it held it or was on it (`withdrawn`; only
   * its owner is told), or put on one someone else holds (`joined`). A teammate's act wakes it in
   * their own direct chat with it, as a message from them would (`teammateWake`).
   */
  const wakeLead = Effect.fn("KinRecords.wakeLead")(function* (
    orgId: KinOrgId,
    writer: Writer,
    row: { readonly recordId: string; readonly key: string; readonly registerId: string },
    to: KinWorkPrincipal,
    assignedBy: KinPersonId | null,
    seq: number,
    now: number,
    reason: "assigned" | "withdrawn" | "handed_back" | "commented" | "joined" = "assigned",
    note?: string | null,
  ) {
    // Looking after a client or leading a project is not an instruction to do anything.
    if (row.registerId !== "work") return false;
    if (to._tag !== "agent") return false;
    // Handed back in its own turn others read, it is still woken to replan where the owner reads.
    if (
      reason !== "handed_back" &&
      writer.actor._tag === "agent" &&
      writer.actor.agentId === to.agentId
    )
      return false;
    if (assignedBy === null) return false;
    const codingAgentKey = yield* markedKey(writer);
    const [lead] = yield* sql<{ memberId: string; ownerPersonId: string }>`
      SELECT m.member_id AS "memberId", a.owner_person_id AS "ownerPersonId"
      FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      JOIN kin_chat_members m ON m.org_id = l.org_id AND m.chat_id = l.owner_chat_id
        AND m.principal_kind = 'person' AND m.person_id = a.owner_person_id AND m.left_at IS NULL
      WHERE l.org_id = ${orgId} AND l.agent_id = ${to.agentId} AND a.retired_at IS NULL
      ORDER BY m.member_id LIMIT 1`;
    if (lead === undefined) return false;
    const teammate = ownsAgent(lead, assignedBy)
      ? undefined
      : reason !== "withdrawn"
        ? yield* teammateWake(orgId, writer, to.agentId, assignedBy, now, reason === "joined")
        : undefined;
    if (!ownsAgent(lead, assignedBy) && teammate === undefined) return false;
    // One change may put several agents on a task, or take several off it.
    const key = `record-${reason}:${row.recordId}:${seq}${reason === "joined" || reason === "withdrawn" ? `:${to.agentId}` : ""}`;
    return yield* queue
      .enqueue({
        _tag: "record.changed",
        orgId,
        agentId: to.agentId,
        eventId: hashedEventId("record", `${orgId.length}:${orgId}${key}`),
        receivedAt: DateTime.makeUnsafe(now),
        dedupeKey: key,
        provenance: {
          _tag: "human",
          personId: assignedBy as KinPersonId,
          memberId: (teammate?.memberId ?? lead.memberId) as never,
        },
        recordId: KinRecordId.make(row.recordId),
        key: row.key,
        seq,
        reason,
        ...(note === undefined || note === null ? {} : { note }),
        ...(teammate === undefined
          ? {}
          : {
              chatId: teammate.chatId,
              origin: { agentId: to.agentId, chatId: teammate.chatId, personId: assignedBy },
            }),
      })
      .pipe(
        // Given out after an outside read, or by a coding agent: the receiving turn starts marked.
        Effect.tap(({ event }) =>
          codingAgentKey !== undefined
            ? sql<{ label: string }>`SELECT label FROM kin_tasks_keys
                WHERE org_id = ${orgId} AND session_id = ${codingAgentKey}`.pipe(
                Effect.flatMap(([key]) =>
                  stampEvent(orgId, event.eventId, codingAgentSource(key?.label ?? "Coding agent")),
                ),
                Effect.provideService(SqlClient.SqlClient, sql),
              )
            : writer.wakeupId === undefined
              ? Effect.void
              : outsideStamp({ orgId, wakeupId: writer.wakeupId }).pipe(
                  Effect.flatMap((source) => stampEvent(orgId, event.eventId, source)),
                  Effect.provideService(SqlClient.SqlClient, sql),
                ),
        ),
        Effect.as(true),
        Effect.catchTags({
          KinEventQueueRetiredAgent: () => Effect.succeed(false),
          KinEventQueueUnknownAgent: () => Effect.succeed(false),
        }),
      );
  });

  /**
   * Whether this agent was given this entry before, or has worked on it: then keeping it starts
   * nothing new (a hand-off or an earlier build already did).
   */
  const alreadyGiven = Effect.fn("KinRecords.alreadyGiven")(function* (
    orgId: KinOrgId,
    recordId: string,
    agentId: KinAgentId,
  ) {
    const [woken] = yield* sql<{ one: number }>`SELECT 1 AS one FROM kin_events
      WHERE org_id = ${orgId} AND agent_id = ${agentId} AND tag = 'record.changed'
        AND json_extract(json, '$.recordId') = ${recordId}
        AND json_extract(json, '$.reason') = 'assigned'
      LIMIT 1`;
    if (woken !== undefined) return true;
    const [worked] = yield* sql<{ one: number }>`SELECT 1 AS one FROM kin_record_changes
      WHERE org_id = ${orgId} AND record_id = ${recordId} AND actor_kind = 'agent'
        AND actor_id = ${agentId} AND kind <> 'created'
      LIMIT 1`;
    return worked !== undefined;
  });

  const alreadyJoined = Effect.fn("KinRecords.alreadyJoined")(function* (
    orgId: KinOrgId,
    recordId: string,
    agentId: KinAgentId,
  ) {
    const [woken] = yield* sql<{ one: number }>`SELECT 1 AS one FROM kin_events
      WHERE org_id = ${orgId} AND agent_id = ${agentId} AND tag = 'record.changed'
        AND json_extract(json, '$.recordId') = ${recordId}
        AND json_extract(json, '$.reason') = 'joined'
      LIMIT 1`;
    return woken !== undefined;
  });

  /**
   * Joined wakes. An agent newly put on an open, kept Work task gets one; on a done or dropped
   * one it is saved and never woken, even on reopen; putting itself on wakes nothing; keeping a
   * suggestion wakes each agent on it never woken for it; an adder who can't reach it is refused.
   */
  const joinedWakes = Effect.fn("KinRecords.joinedWakes")(function* (
    orgId: KinOrgId,
    writer: Writer,
    row: { readonly recordId: string; readonly key: string; readonly registerId: string },
    state: KinRecordState,
    added: ReadonlyArray<string>,
    seq: number,
    now: number,
    keeping: boolean,
  ) {
    if (isClosed(state)) return;
    for (const text of added) {
      const on = storedPrincipal(text);
      if (on?._tag !== "agent") continue;
      if (keeping && (yield* alreadyJoined(orgId, row.recordId, on.agentId))) continue;
      yield* wakeLead(orgId, writer, row, on, textBy(writer), seq, now, "joined");
    }
  });

  /**
   * An agent on a Work task it doesn't hold helps its holder: it may not close the task, give it,
   * move its due, change who is on it or tick its steps unless a person's own word woke the turn.
   */
  const helperGuard = Effect.fn("KinRecords.helperGuard")(function* (
    orgId: KinOrgId,
    writer: Writer,
    row: RecordRow,
    holder: KinWorkPrincipal,
    asked: Pick<Patch, "state" | "owner" | "dueAt" | "dueAllDay" | "tick" | "steps">,
    alsoOn: ReadonlyArray<string>,
  ) {
    if (writer.actor._tag !== "agent" || row.registerId !== "work") return;
    const { agentId } = writer.actor;
    if (samePrincipal(writer.actor, holder)) return;
    const stored = fieldList(parseFields(row.fieldsJson), "alsoOn");
    if (!stored.includes(`agent:${agentId}`)) return;
    const ticked = (steps: ReadonlyArray<{ readonly title: string; readonly done?: boolean }>) =>
      steps
        .filter((step) => step.done === true)
        .map((step) => step.title)
        .toSorted()
        .join("\n");
    const storedSteps = stepsOf(row);
    const reserved =
      (asked.state !== undefined && isClosed(asked.state) && asked.state !== row.state) ||
      (asked.owner !== undefined && !samePrincipal(asked.owner, holder)) ||
      (asked.dueAt !== undefined && asked.dueAt !== row.dueAt) ||
      (asked.dueAllDay !== undefined && (asked.dueAllDay ? 1 : 0) !== row.dueAllDay) ||
      alsoOn.join(",") !== stored.join(",") ||
      (asked.tick !== undefined &&
        asked.tick.done !== (storedSteps[asked.tick.index]?.done ?? false)) ||
      (asked.steps !== undefined && ticked(asked.steps) !== ticked(storedSteps));
    if (!reserved) return;
    if (
      writer.wakeupId !== undefined &&
      (yield* personSpokeInTurn(orgId, agentId, writer.wakeupId).pipe(provideSql))
    )
      return;
    const [named] =
      holder._tag === "agent"
        ? yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_agents
            WHERE org_id = ${orgId} AND agent_id = ${holder.agentId}`
        : yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
            WHERE org_id = ${orgId} AND person_id = ${holder.personId}`;
    return yield* new KinHelperRefusal({
      reason: "not_allowed",
      message: helperRefusal(named?.name ?? "Someone else", row.key),
    });
  });

  /**
   * In the write's own transaction: an agent's write that would change a field a person changed
   * since a person last addressed its turn is refused, whatever revision it passes.
   */
  const keptForPerson = Effect.fn("KinRecords.keptForPerson")(function* (
    orgId: KinOrgId,
    since: NonNullable<Writer["since"]>,
    row: RecordRow,
    def: ListDef,
    writes: ReadonlySet<string>,
    view: Writer["view"],
  ) {
    // A person's row with a turn is Kin carrying out that turn's confirmed ask (`markQuotesSent`).
    const rows = yield* sql<{ seq: number; at: number; actorId: string; fieldsJson: string }>`
      SELECT seq, at, actor_id AS "actorId", fields_json AS "fieldsJson" FROM kin_record_changes
      WHERE org_id = ${orgId} AND record_id = ${row.recordId} AND actor_kind = 'person'
        AND actor_id IS NOT NULL AND kind = 'updated' AND at >= ${since.at}
        AND wakeup_id IS NULL
      ORDER BY seq DESC`;
    const newest = new Map<
      string,
      {
        seq: number;
        at: number;
        actorId: string;
        field: string;
        to: string | null;
        exact: boolean;
      }
    >();
    for (const change of rows) {
      if (since.woke.includes(change.seq)) continue;
      // A tap's own writes land as the tapper no later than the tap's message (`KinChatService.act`).
      if (change.actorId === since.tappedBy && change.at <= since.at) continue;
      for (const field of parseChanges(change.fieldsJson)) {
        const name = asSet(field.field);
        const had = newest.get(name);
        if (!writes.has(name) || (had !== undefined && (had.seq !== change.seq || had.exact)))
          continue;
        newest.set(name, {
          ...change,
          field: field.field,
          to: field.to,
          exact: field.field === name,
        });
      }
    }
    if (newest.size === 0) return;
    // A shared turn reads this history as its people's own record_get does (`teamChanges`).
    if (
      view !== undefined &&
      [...newest.values()].some((change) => !teamSeesField(change.field)) &&
      !(yield* viewReadsWhole(orgId, view.people, row).pipe(provideSql))
    )
      return yield* new KinChatError({
        reason: "conflict",
        message: `Nothing changed on ${row.key}: someone changed it since you were asked. Tell whoever asked, and change it only if they say so.`,
      });
    const zone = yield* ownerZone(orgId).pipe(provideSql);
    const nameOf = Effect.fn("KinRecords.nameOf")(function* (who: Principal | null) {
      const [named] =
        who === null
          ? []
          : who._tag === "agent"
            ? yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_agents
                WHERE org_id = ${orgId} AND agent_id = ${who.agentId}`
            : yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
                WHERE org_id = ${orgId} AND person_id = ${who.personId}`;
      return named?.name ?? "someone";
    });
    const sensitive = row.sensitive === 1 || row.inheritedSensitive === 1;
    const clauses: Array<string> = [];
    for (const [name, change] of newest) {
      const label = FIELD_NAMES[name] ?? `its ${name}`;
      const to = change.to;
      const value =
        !change.exact || sensitive || !QUOTED.has(name)
          ? undefined
          : to === null
            ? null
            : name === "state"
              ? stateLabel(def, to)
              : name === "owner" || name === "waitingOn"
                ? yield* nameOf(principal(to.split(":")[0] ?? "", to.slice(to.indexOf(":") + 1)))
                : name === "due" || name === "date"
                  ? formatKinWhen(
                      Date.parse(to),
                      (name === "due" ? row.dueAllDay : row.dateAllDay) === 1 ? "date" : "dateTime",
                      { zone, locale: KIN_TEXT_LOCALE },
                    )
                  : `"${to.length > 120 ? `${to.slice(0, 119)}…` : to}"`;
      const did =
        value === undefined
          ? `changed ${label} (value not shown)`
          : value === null
            ? `cleared ${label}`
            : `changed ${label} to ${value}`;
      const when = formatKinWhen(change.at, "dayTime", { zone, locale: KIN_TEXT_LOCALE });
      clauses.push(`${yield* nameOf(principal("person", change.actorId))} ${did} on ${when}`);
    }
    return yield* new KinChatError({
      reason: "conflict",
      message: `Nothing changed on ${row.key}: ${clauses.join("; ")}. Tell whoever asked, and change it only if they say so.`,
    });
  });

  /** Whose agent this is: the authority a hand back wakes it with when none was stored. */
  const agentOwner = Effect.fn("KinRecords.agentOwner")(function* (
    orgId: KinOrgId,
    who: KinWorkPrincipal,
  ) {
    if (who._tag !== "agent") return null;
    const [row] = yield* sql<{ owner: string }>`SELECT owner_person_id AS owner FROM kin_agents
      WHERE org_id = ${orgId} AND agent_id = ${who.agentId}`;
    return row === undefined ? null : KinPersonId.make(row.owner);
  });

  const ownerExists = Effect.fn("KinRecords.ownerExists")(function* (
    orgId: KinOrgId,
    who: KinWorkPrincipal,
    role = "to own it",
    options?: { readonly joiningTask: true },
  ) {
    if (who._tag === "person") {
      const [person] = yield* sql<{ name: string; removedAt: number | null }>`SELECT
        display_name AS name, removed_at AS "removedAt" FROM kin_people
        WHERE org_id = ${orgId} AND person_id = ${who.personId}`;
      if (person !== undefined) {
        if (options?.joiningTask === true && person.removedAt !== null)
          return yield* new KinChatError({
            reason: "not_allowed",
            message: `${person.name} has left the company and can't be added to the task.`,
          });
        return;
      }
    } else {
      const [agent] = yield* sql`SELECT 1 FROM kin_leads l JOIN kin_agents a
        ON a.org_id = l.org_id AND a.agent_id = l.agent_id
        WHERE l.org_id = ${orgId} AND l.agent_id = ${who.agentId} AND a.retired_at IS NULL`;
      if (agent !== undefined) return;
    }
    return yield* new KinChatError({
      reason: "not_found",
      message: `No ${who._tag === "agent" ? "agent" : "person"} ${principalId(who).slice(0, 60)} here ${role}.`,
    });
  });

  /**
   * Who a write leaves on a task besides its holder (`fields.alsoOn`): someone here, each once, at
   * most `KIN_WORK_ALSO_ON_MAX`, never the holder. Given to someone on it, they come off it. An
   * agent with no person asking in its turn may not change it: being put on one is no one's ask.
   */
  const alsoOnFor = Effect.fn("KinRecords.alsoOnFor")(function* (
    orgId: KinOrgId,
    writer: Writer,
    asked: FieldValue | null | undefined,
    stored: ReadonlyArray<string>,
    holder: KinWorkPrincipal,
  ) {
    const held = shownPrincipal(holder);
    const kept = stored.filter((text) => text !== held);
    if (asked === undefined) return kept;
    const list = asked ?? [];
    if (writer.actor._tag === "agent" && writer.askedBy == null) {
      if (Array.isArray(list) && list.join(",") === kept.join(",")) return kept;
      return yield* new KinChatError({ reason: "not_allowed", message: ALSO_ON_UNASKED });
    }
    if (typeof list === "string" || isMoney(list) || list.some((text) => !storedPrincipal(text)))
      return yield* invalid("Who is on a task is a list of person:<id> and agent:<id>.");
    if (new Set(list).size !== list.length)
      return yield* invalid("Name each person on a task once.");
    if (list.length > KIN_WORK_ALSO_ON_MAX)
      return yield* invalid(
        `A task has at most ${KIN_WORK_ALSO_ON_MAX} people on it besides whoever holds it.`,
      );
    if (list.some((text) => text === held))
      return yield* invalid("Whoever holds a task isn't also on it: leave them off the list.");
    for (const text of list)
      if (!stored.includes(text))
        yield* ownerExists(orgId, storedPrincipal(text)!, "to be on it", { joiningTask: true });
    return list;
  });

  const insertLink = Effect.fn("KinRecords.insertLink")(function* (
    orgId: KinOrgId,
    recordId: string,
    link: LinkInput,
    now: number,
  ) {
    const inserted = yield* sql`INSERT INTO kin_record_links (org_id, record_id, kind, target,
        relation, chat_id, label, created_at)
      VALUES (${orgId}, ${recordId}, ${link.kind}, ${link.target}, ${link.relation},
        ${link.chatId ?? null}, ${link.label ?? null}, ${now})
      ON CONFLICT DO NOTHING RETURNING target`;
    return inserted.length > 0;
  });

  /** A client or project this entry may point at: in this org, in that list. */
  const target = Effect.fn("KinRecords.target")(function* (
    orgId: KinOrgId,
    recordId: string,
    list: "clients" | "projects",
  ) {
    const [row] = yield* sql<{
      key: string;
      title: string;
      partyId: string | null;
      state: KinRecordState;
    }>`
      SELECT key, title, party_id AS "partyId", state FROM kin_records
      WHERE org_id = ${orgId} AND record_id = ${recordId} AND register_id = ${list}`;
    if (row === undefined)
      return yield* new KinChatError({
        reason: "not_found",
        message: `No ${LISTS[list].noun} ${recordId.slice(0, 40)} here.`,
      });
    return row;
  });

  /** Which of client and project a list may carry, and that a contact has its client. */
  const checkRefs = (
    def: ListDef,
    partyId: string | null,
    projectId: string | null,
  ): KinChatError | undefined =>
    def.builtIn === null ? undefined : builtInRefs(def.builtIn, partyId, projectId);
  const builtInRefs = (
    list: ListName,
    partyId: string | null,
    projectId: string | null,
  ): KinChatError | undefined =>
    list === "clients" && (partyId !== null || projectId !== null)
      ? new KinChatError({ reason: "invalid_state", message: "A client has no client or project." })
      : list === "contacts" && partyId === null
        ? new KinChatError({ reason: "invalid_state", message: "A contact needs its client." })
        : list === "deals" && partyId === null
          ? new KinChatError({
              reason: "invalid_state",
              message: "A deal needs its client or prospect.",
            })
          : list !== "work" && list !== "docs" && list !== "milestones" && projectId !== null
            ? new KinChatError({
                reason: "invalid_state",
                message: `${withArticle(LISTS[list].noun, "A")} has no project.`,
              })
            : undefined;

  /**
   * One active client, project, or contact of a client, per name: a second is a mistake. A vendor
   * and a client may share one.
   */
  const sameName = Effect.fn("KinRecords.sameName")(function* (
    orgId: KinOrgId,
    list: string,
    title: string,
    partyId: string | null,
    except: string | null,
    category: string | null | undefined,
    seenBy: KinPersonId | undefined,
  ) {
    if (list === "work" || list === "docs" || list === "milestones" || !isBuiltIn(list)) return;
    // `+key` keeps SQLite off the key index, which walks every key in the company for each name;
    // it reads the title index instead.
    const [row] = yield* sql<{ key: string; sensitive: number }>`SELECT r.key,
        ${sensitiveNow(sql)} AS sensitive FROM kin_records r
      WHERE r.org_id = ${orgId} AND r.register_id = ${list}
        AND ${list === "contacts" ? sql`r.party_id IS ${partyId}` : sql`1 = 1`}
        AND r.state NOT IN ${sql.in(CLOSED)}
        AND lower(r.title) = lower(${title}) AND r.record_id IS NOT ${except}
        AND (${list} != 'clients' OR ${clientFamily(sql, sql`r.category`)} = ${clientFamily(sql, sql`${category ?? "client"}`)})
        AND ${seenBy === undefined ? sql`1 = 1` : crmSees(sql, seenBy)}
      ORDER BY +r.key LIMIT 1`;
    if (row !== undefined) {
      // Through a coding agent's key, one it can't reach is named by nothing.
      if (row.sensitive === 1 && (yield* markedKey({})) !== undefined)
        return yield* new KinChatError({
          reason: "conflict",
          message: "Another entry already has that name.",
        });
      const error = {
        reason: "conflict" as const,
        message: `There is already ${withArticle(LISTS[list].noun)} named ${title.slice(0, 80)}: ${row.key}.`,
      };
      return yield* row.sensitive === 1 ? new SensitiveRefusal(error) : new KinChatError(error);
    }
  });

  const resolveList = Effect.fn("KinRecords.resolveList")(function* (orgId: KinOrgId, id: string) {
    const def = yield* listDef(orgId, id).pipe(provideSql);
    if (def === undefined) return yield* unknownList(id);
    return def;
  });

  /** A repeat rule with the days of the month its dates keep, or a refusal if it has no date. */
  const storedRepeat = Effect.fn("KinRecords.storedRepeat")(function* (
    orgId: KinOrgId,
    rule: KinRepeatRule,
    dueAt: number | null,
    dateAt: number | null,
  ) {
    if (dueAt === null && dateAt === null)
      return yield* invalid("A repeating entry needs a due date or a date to repeat from.");
    const zone = yield* ownerZone(orgId).pipe(provideSql);
    const dueDay = rule.every === "days" ? undefined : anchorOf(dueAt, zone);
    const dateDay = rule.every === "days" ? undefined : anchorOf(dateAt, zone);
    return {
      rule,
      ...(dueDay === undefined ? {} : { dueDay }),
      ...(dateDay === undefined ? {} : { dateDay }),
    } satisfies StoredRepeat;
  });

  /** Who keeps a suggestion: an owner-level person now, or an agent one asked in person. */
  const mayKeep = Effect.fn("KinRecords.mayKeep")(function* (orgId: KinOrgId, writer: Writer) {
    if (writer.actor._tag === "person")
      return yield* ownerLevel(orgId, writer.actor.personId).pipe(provideSql);
    if (writer.actor._tag === "agent" && writer.wakeupId !== undefined)
      return yield* ownerLevelAsked(orgId, writer.actor.agentId, writer.wakeupId).pipe(provideSql);
    return false;
  });

  /**
   * An agent's turn that follows an outside read it did not make, and that no owner-level person
   * asked in person: anything new it makes, on any list, waits to be kept.
   */
  const followsUnasked = Effect.fn("KinRecords.followsUnasked")(function* (
    orgId: KinOrgId,
    writer: Writer,
  ) {
    if (writer.actor._tag !== "agent" || writer.wakeupId === undefined) return false;
    if (!(yield* followsOutsideRead(orgId, writer.wakeupId).pipe(provideSql))) return false;
    return !(yield* ownerLevelAsked(orgId, writer.actor.agentId, writer.wakeupId).pipe(provideSql));
  });

  /**
   * Whether a new entry starts kept, from who makes it, in the write's transaction. Made from a
   * suggestion, or asked to be one, it is one. A quote or invoice is real only on an owner-level
   * person's word: theirs, or their ask in person of an agent (an approved draft's one entry is
   * `approvalKeeps`'). Anything else starts kept, unless its caller asks for less.
   */
  const startsKept = Effect.fn("KinRecords.startsKept")(function* (
    orgId: KinOrgId,
    writer: Writer,
    list: string,
    input: Pick<CreateInput, "confirmed" | "from">,
  ) {
    if (input.confirmed === false) return false;
    if (input.from !== undefined) {
      const [source] = yield* sql<{ confirmed: number }>`SELECT confirmed FROM kin_records
        WHERE org_id = ${orgId} AND record_id = ${input.from}`;
      if (source !== undefined && isSuggestion(source)) return false;
    }
    if (!ISSUED_LISTS.has(list) || writer.actor._tag === "system") return true;
    return yield* mayKeep(orgId, writer);
  });

  /**
   * An entry made under the owner's Approve of a sent-up quote or invoice (`approval.ts`): it
   * starts kept, as his Draft, only on the approved kind's list, for the approved party when the
   * draft named one, and only as the first entry made under that approval. Undefined when the
   * writer's wake runs for no approval; then the entry starts as on any other turn.
   */
  const approvalKeeps = Effect.fn("KinRecords.approvalKeeps")(function* (
    orgId: KinOrgId,
    writer: Writer,
    list: string,
    partyId: string | null,
  ) {
    if (writer.actor._tag !== "agent" || writer.wakeupId === undefined) return undefined;
    const approval = yield* approvedFor({
      orgId,
      agentId: writer.actor.agentId,
      wakeupId: writer.wakeupId,
    }).pipe(provideSql);
    if (approval === undefined) return undefined;
    const { draft } = approval;
    const approved = approval.made === null && DRAFT_LIST[draft.kind] === list;
    // The approved entry is for the card's client: another, or none, is refused before it is written.
    if (approved && draft.for !== null && draft.for.partyId !== partyId)
      return yield* invalid(approvedClient(draft.for.title));
    return { questionId: approval.questionId, keeps: approved };
  });

  type InsertOptions = {
    readonly wake: boolean;
    readonly repeat?: StoredRepeat;
    /** Whose words the copied title and notes are, for an occurrence copied from another. */
    readonly authors?: { readonly title: string | null; readonly notes: string | null };
    /** Decided for it already, as for an occurrence by whoever closed the one before. */
    readonly kept?: boolean;
  };

  // The caller traces the single insert or the whole chunk.
  const prepareNew = Effect.fnUntraced(function* (
    orgId: KinOrgId,
    writer: Writer,
    input: CreateInput,
    recordId: string,
    guarded: { readonly draftFor: KinPersonId } | undefined,
    options: InsertOptions,
    batch?: { readonly def: ListDef; readonly prefix: string; readonly next: number },
  ) {
    // Before the list is read: an amount for a list not made yet waits on the country too.
    // A list that may hold money takes entries without any, such as a deadline with no fee.
    if (batch === undefined && recordsMoney(input.amount, input.fields))
      yield* countryFirst(orgId).pipe(provideSql);
    const def = batch?.def ?? (yield* resolveList(orgId, input.list ?? "work"));
    if (def.archivedAt !== null)
      return yield* invalid(`${def.name} is archived; the owner can restore it.`);
    const list = def.id;
    if (list === "deals" && writer.deal !== true) return yield* dealsOnly;
    const contact = list === "contacts" ? contactFields({}, input.fields ?? {}) : input.fields;
    if (isChatError(contact)) return yield* contact;
    const tagged = yield* cleanTags(orgId, list, contact).pipe(provideSql);
    const fields = Object.fromEntries(
      Object.entries(tagged ?? {}).filter(
        (entry): entry is [string, FieldValue] => entry[1] !== null,
      ),
    );
    const invalidFor = checkInput(def, {
      title: input.title,
      state: input.state,
      category: input.category,
      fields,
      amount: input.amount,
      dateAt: input.dateAt,
      repeat: input.repeat,
      steps: (input.steps?.length ?? 0) > 0 || input.urgent === true,
    });
    if (invalidFor !== undefined) return yield* invalidFor;
    // An agent's funder the owner didn't give in person waits with the new entry for Keep.
    const unaskedFunding =
      list === "expenses" &&
      writer.actor._tag === "agent" &&
      FUNDING.some((field) => field in fields) &&
      !(yield* agentMayFund(orgId, writer).pipe(provideSql));
    // Money counts a partner's expense as owed: the entry says so too, not "None".
    if (funds(def, fields[FUNDED_BY]) && fields[REIMBURSEMENT] === undefined)
      fields[REIMBURSEMENT] = "owed";
    const zero = zeroOwed(def, input.amount, input.category, writer);
    if (zero !== undefined) return yield* zero;
    if (input.askSlip === true && input.amount != null)
      yield* askSlip(orgId, def, input.amount).pipe(provideSql);
    if (list === "receipts" && RECEIPT_TIES.some((field) => field in fields))
      return yield* invalid(RECEIPT_TIES_ARE_KINS);
    if (writer.actor._tag !== "person" && numberingOf(def) !== undefined && "number" in fields)
      return yield* invalid(NUMBERS_ARE_ISSUED);
    if (def.builtIn === null) yield* verifyRefs(orgId, def, fields).pipe(provideSql);
    const projectId = input.projectId ?? null;
    const project = projectId === null ? undefined : yield* target(orgId, projectId, "projects");
    // An entry in a client's project is part of that client's record unless it names another;
    // a teammate's draft only when they see that client (`draftDoc`).
    const inherited = project?.partyId ?? null;
    const partyId =
      input.partyId !== undefined
        ? input.partyId
        : guarded !== undefined &&
            inherited !== null &&
            !(yield* teamVisible(orgId, guarded.draftFor, [inherited]).pipe(provideSql)).has(
              inherited,
            )
          ? null
          : inherited;
    const invalidRefs = checkRefs(def, partyId, projectId);
    if (invalidRefs !== undefined) return yield* invalidRefs;
    const party = partyId === null ? undefined : yield* target(orgId, partyId, "clients");
    if (
      hasBillTo(list) &&
      Object.keys(fields).some((field) => Object.hasOwn(BILL_TO_FIELDS, field))
    ) {
      yield* validateBillTo(gstCompany(orgId), undefined, party, fields, fields.billToName, false);
      if (party === undefined && billToNameOf(fields) === null)
        for (const field of Object.keys(clearedBillTo)) delete fields[field];
    }
    yield* sameName(orgId, list, input.title, partyId, null, input.category, writer.namesSeenBy);
    if (batch === undefined) yield* ownerExists(orgId, input.owner);
    if (list === "work") {
      // Kin's own copy, such as a repeat's next one, keeps whoever was on the one before.
      const copied = writer.actor._tag === "system" ? fieldList(fields, "alsoOn") : [];
      const alsoOn = yield* alsoOnFor(orgId, writer, fields.alsoOn, copied, input.owner);
      if (alsoOn.length === 0) delete fields.alsoOn;
      else fields.alsoOn = alsoOn;
    }
    const repeat =
      options.repeat ??
      (input.repeat === undefined || input.repeat === null
        ? undefined
        : yield* storedRepeat(orgId, input.repeat, input.dueAt ?? null, input.dateAt ?? null));
    const now = yield* Clock.currentTimeMillis;
    if (list === "expenses" && REPAID_ON in fields) {
      const ahead = repaidAhead(fields, dayIn(now, yield* ownerZone(orgId).pipe(provideSql)));
      if (ahead !== undefined) return yield* ahead;
    }
    const next = batch ?? (yield* reserveKeys(orgId, def, now, 1));
    const key = `${next.prefix}-${next.next}`;
    const approved =
      options.kept === undefined ? yield* approvalKeeps(orgId, writer, list, partyId) : undefined;
    const kept =
      options.kept ??
      (!unaskedFunding &&
        (approved === undefined ? yield* startsKept(orgId, writer, list, input) : approved.keeps) &&
        !(yield* followsUnasked(orgId, writer)));
    // Nobody issued, sent or was paid for what nobody kept: it waits as a draft on its own day.
    // Only Issue makes an invoice owed, with its number; an agent sets none, so it starts a draft.
    // An approval's entry is the owner's Draft whatever state it was given.
    const state =
      (!kept && ISSUED_LISTS.has(list)) ||
      (writer.actor._tag === "agent" && list === "invoices") ||
      approved?.keeps === true
        ? "open"
        : (input.state ??
          startState(def, {
            dateAt: input.dateAt ?? null,
            numbered: "number" in fields,
            now,
            zone:
              def.id === "expenses" || def.id === "invoices"
                ? yield* ownerZone(orgId).pipe(provideSql)
                : "UTC",
          }));
    if ((yield* markedKey(writer)) !== undefined) {
      const refused = keyRefusal({
        list,
        money: moneyOf(def),
        state,
        numbered: "number" in fields,
      });
      if (refused !== undefined) return yield* refused;
    }
    const waitingOn = state === "waiting" ? (input.waitingOn ?? null) : null;
    const givenAway =
      !(writer.actor._tag === "agent" && samePrincipal(writer.actor, input.owner)) &&
      !(writer.actor._tag === "person" && samePrincipal(writer.actor, input.owner));
    const assignedBy = writer.askedBy ?? null;
    const amount = input.amount ?? null;
    const notes = input.notes ?? "";
    const author = textBy(writer);
    const steps = input.steps ?? [];
    const values = {
      org_id: orgId,
      record_id: recordId,
      register_id: list,
      key,
      title: input.title,
      state,
      waiting_on_kind: waitingOn?._tag ?? null,
      waiting_on_id: waitingOn === null ? null : principalId(waitingOn),
      owner_kind: input.owner._tag,
      owner_id: principalId(input.owner),
      side: input.side ?? "ours",
      category: input.category ?? null,
      due_at: input.dueAt ?? null,
      due_all_day: input.dueAllDay === true ? 1 : 0,
      sensitive: input.sensitive === true || def.sensitive ? 1 : 0,
      confirmed: kept ? 1 : 0,
      notes,
      rev: 1,
      source_chat_id: input.source?.chatId ?? null,
      source_message_id: input.source?.messageId ?? null,
      created_by_kind: writer.actor._tag,
      created_by_id: actorIdOf(writer),
      assigned_by_person_id: assignedBy,
      assigned_at: assignedBy === null ? null : now,
      origin_key: input.originKey,
      created_at: input.createdAt ?? now,
      updated_at: now,
      closed_at: isClosed(state) ? (input.closedAt ?? now) : null,
      party_id: partyId,
      project_id: projectId,
      repo: input.repo ?? null,
      fields_json: yield* encodeFieldValues(
        guarded === undefined ? fields : { ...fields, draftFor: guarded.draftFor },
      ),
      amount_minor: amount?.minor ?? null,
      currency: amount?.currency ?? null,
      date_at: input.dateAt ?? null,
      date_all_day: input.dateAllDay === true ? 1 : 0,
      repeat_json: repeat === undefined ? null : yield* encodeRepeat(repeat),
      request_hash: input.requestHash ?? null,
      team_shared:
        input.team === true ||
        (writer.teammate === true && def.team !== true) ||
        writer.teamShared === true ||
        (writer.view !== undefined && (ROOM_LISTS as ReadonlyArray<string>).includes(list))
          ? 1
          : 0,
      title_by: options.authors === undefined ? author : options.authors.title,
      notes_by:
        notes === "" ? null : options.authors === undefined ? author : options.authors.notes,
      assigned_by_agent_id:
        givenAway && writer.actor._tag === "agent" && writer.askedBy == null
          ? writer.actor.agentId
          : null,
      marked_by_person_id: input.sensitive === true ? author : null,
      asked_by_person_id: author,
      steps_json: steps.length === 0 ? null : yield* encodeSteps(steps),
      urgent: input.urgent === true ? 1 : null,
    };
    const changes: Array<FieldChange> = [
      { field: "title", from: null, to: input.title },
      { field: "state", from: null, to: state },
      { field: "owner", from: null, to: shownPrincipal(input.owner) },
      ...(input.dueAt === undefined || input.dueAt === null
        ? []
        : [{ field: "due", from: null, to: shownDue(input.dueAt) }]),
      ...(input.dateAt === undefined || input.dateAt === null
        ? []
        : [{ field: "date", from: null, to: shownDue(input.dateAt) }]),
      ...(amount === null ? [] : [{ field: "amount", from: null, to: shownAmount(amount) }]),
      ...(repeat === undefined
        ? []
        : [{ field: "repeat", from: null, to: shownRepeat(repeat.rule) }]),
      ...(waitingOn === null
        ? []
        : [{ field: "waitingOn", from: null, to: shownPrincipal(waitingOn) }]),
      ...(party === undefined ? [] : [{ field: "party", from: null, to: party.key }]),
      ...(project === undefined ? [] : [{ field: "project", from: null, to: project.key }]),
      ...(input.side === "theirs" ? [{ field: "side", from: null, to: "theirs" }] : []),
      ...(input.repo === undefined || input.repo === null
        ? []
        : [{ field: "repo", from: null, to: input.repo }]),
      ...(steps.length === 0 ? [] : [{ field: "steps", from: null, to: shownSteps(steps) }]),
      ...(input.urgent === true ? [{ field: "urgent", from: null, to: "true" }] : []),
      ...Object.entries(fields).map(([field, value]) => ({
        field,
        from: null,
        to: shownField(value),
      })),
    ];
    return { values, changes, now, approved, givenAway, assignedBy, kept, state, fields };
  });

  /**
   * One new entry, in the caller's transaction. `wake` is false for the next occurrence of a
   * repeating entry, which is owed later and is nobody's new instruction.
   */
  const insert = Effect.fn("KinRecords.insert")(function* (
    orgId: KinOrgId,
    writer: Writer,
    input: CreateInput,
    options: InsertOptions,
  ) {
    const recordId = recordIdFor(orgId, input.originKey);
    const existing = yield* byId(orgId, recordId).pipe(provideSql);
    if (writer.teammate === true && writer.actor._tag === "person")
      yield* teamGuard(orgId, writer.actor.personId, {
        row: existing,
        changes: false,
        input,
      }).pipe(provideSql);
    const guarded =
      writer.view === undefined
        ? undefined
        : yield* viewGuard(
            orgId,
            writer.view,
            { row: existing, changes: false, input },
            writer.actor._tag === "agent" && writer.wakeupId !== undefined
              ? {
                  agentId: writer.actor.agentId,
                  wakeupId: writer.wakeupId,
                  headStartFor: writer.headStartFor,
                }
              : undefined,
          ).pipe(provideSql);
    if (existing !== undefined) {
      const [stored] = yield* sql<{ hash: string | null }>`SELECT request_hash AS hash
        FROM kin_records WHERE org_id = ${orgId} AND record_id = ${recordId}`;
      if (
        input.requestHash !== undefined &&
        stored?.hash != null &&
        stored.hash !== input.requestHash
      )
        return yield* new KinChatError({
          reason: "not_allowed",
          message: "That retry key already created a different entry.",
        });
      return { row: existing, created: false };
    }
    const { values, changes, now, approved, givenAway, assignedBy, kept, state, fields } =
      yield* prepareNew(orgId, writer, input, recordId, guarded, options);
    const { key, register_id: list } = values;
    yield* sql`INSERT INTO kin_records ${sql.insert(values)}`;
    if (approved?.keeps === true)
      yield* recordMade(orgId, approved.questionId, { kind: "entry", recordId, key, list }).pipe(
        provideSql,
      );
    const seq = yield* logChange(orgId, writer, { recordId, key, rev: 1 }, "created", changes, now);
    yield* choicesMoved(orgId, list);
    if (input.source !== undefined)
      yield* insertLink(
        orgId,
        recordId,
        {
          kind: "message",
          target: input.source.messageId,
          relation: "source",
          chatId: input.source.chatId,
        },
        now,
      );
    for (const link of input.links ?? []) yield* insertLink(orgId, recordId, link, now);
    yield* indexRecord(orgId, recordId).pipe(provideSql);
    // A suggestion is nobody's instruction until a person keeps it (`update`, `keeping`).
    if (givenAway && options.wake && kept)
      yield* wakeLead(
        orgId,
        writer,
        { recordId, key, registerId: list },
        input.owner,
        assignedBy,
        seq,
        now,
      );
    if (options.wake && kept)
      yield* joinedWakes(
        orgId,
        writer,
        { recordId, key, registerId: list },
        state,
        fieldList(fields, "alsoOn"),
        seq,
        now,
        false,
      );
    const row = yield* byId(orgId, recordId).pipe(provideSql);
    if (row === undefined) return yield* unavailable;
    return { row, created: true };
  });

  /**
   * The next occurrence of a repeating entry that just closed: same owner, client, fields and
   * amount, its dates moved on by the rule, open. Keyed by the entry it follows, so a retry, a
   * reopen and a second close all find the one already made.
   */
  const spawnNext = Effect.fn("KinRecords.spawnNext")(function* (
    orgId: KinOrgId,
    writer: Writer,
    row: RecordRow,
  ) {
    const repeat = repeatOf(row.repeatJson);
    if (repeat === undefined) return;
    const def = yield* resolveList(orgId, row.registerId);
    // The next one is owed, so it starts in a state that is not closed; a list with none has no next.
    const state = (["open", "waiting", "doing"] as const).find((one) => def.states.includes(one));
    if (state === undefined) return;
    const zone = yield* ownerZone(orgId).pipe(provideSql);
    const next = nextDates(
      repeat,
      {
        dueAt: row.dueAt,
        dueAllDay: row.dueAllDay === 1,
        dateAt: row.dateAt,
        dateAllDay: row.dateAllDay === 1,
      },
      zone,
    );
    const owner = principal(row.ownerKind, row.ownerId);
    if (owner === null) return;
    // The next one takes its own number when it is issued.
    const dropped = new Set([
      ...def.fields.filter((one) => one.type === "file").map((one) => one.key),
      ...(numberingOf(def) === undefined ? [] : ["number"]),
    ]);
    const kept = Object.fromEntries(
      Object.entries(parseFields(row.fieldsJson)).filter(([key]) => !dropped.has(key)),
    );
    const amount = amountOf(row);
    // The next one is whoever closed this one's to keep, and a suggestion if this one is.
    const keptNext = yield* startsKept(orgId, writer, row.registerId, { from: row.recordId });
    yield* insert(
      orgId,
      {
        actor: { _tag: "system" },
        via: writer.via,
        ...(writer.chatId === undefined ? {} : { chatId: writer.chatId }),
        askedBy: row.assignedBy === null ? null : KinPersonId.make(row.assignedBy),
      },
      {
        list: row.registerId,
        originKey: `repeat:${row.recordId}`,
        title: row.title,
        owner,
        state,
        category: row.category,
        side: row.side,
        dueAt: next.dueAt,
        dueAllDay: row.dueAllDay === 1,
        dateAt: next.dateAt,
        dateAllDay: row.dateAllDay === 1,
        notes: row.notes,
        sensitive: row.sensitive === 1,
        // The next one is seen by whoever saw this one.
        team: row.teamShared === 1,
        partyId: row.partyId,
        projectId: row.projectId,
        repo: row.repo,
        fields: kept,
        ...(amount === undefined ? {} : { amount }),
        // The next one's checklist starts unticked; urgent was about this one.
        steps: stepsOf(row).map((step) => ({ title: step.title, done: false })),
        links: [{ kind: "record", target: row.recordId, relation: "relates", label: row.key }],
      },
      {
        wake: false,
        repeat,
        authors: { title: row.titleBy, notes: row.notesBy },
        kept: keptNext,
      },
    );
  });

  const create = Effect.fn("KinRecords.create")(function* (
    orgId: KinOrgId,
    writer: Writer,
    input: CreateInput,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const result = yield* insert(orgId, writer, input, { wake: true });
        if (!result.created && result.row.state === "dropped" && input.state !== "dropped")
          return yield* undoneRetry("entry");
        // Made already closed, a repeating entry's next one is owed at once.
        if (result.created && isClosed(result.row.state))
          yield* spawnNext(orgId, writer, result.row);
        return result;
      }),
    );
  });

  const createImportChunk = Effect.fn("KinRecords.createImportChunk")(function* (
    orgId: KinOrgId,
    personId: KinPersonId,
    list: "work" | "expenses",
    entries: ReadonlyArray<PlainImportInput>,
  ) {
    if (entries.length === 0) return true;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const owner = { _tag: "person", personId } as const;
          const writer: Writer = { actor: owner, via: "import" };
          if (entries.some((entry) => recordsMoney(entry.amount, undefined)))
            yield* countryFirst(orgId).pipe(provideSql);
          const def = yield* resolveList(orgId, list);
          yield* ownerExists(orgId, owner);
          const reservation = yield* reserveKeys(
            orgId,
            def,
            yield* Clock.currentTimeMillis,
            entries.length,
          );
          const records = [];
          const history = [];
          for (const [offset, entry] of entries.entries()) {
            const recordId = recordIdFor(orgId, entry.originKey);
            const { values, changes, now } = yield* prepareNew(
              orgId,
              writer,
              { ...entry, list, owner },
              recordId,
              undefined,
              { wake: false },
              { def, prefix: reservation.prefix, next: reservation.next + offset },
            );
            records.push(values);
            history.push(
              yield* changeValues(orgId, writer, { recordId, rev: 1 }, "created", changes, now),
            );
          }
          if (!Arr.isArrayNonEmpty(records) || !Arr.isArrayNonEmpty(history))
            return yield* unavailable;
          yield* sql`INSERT INTO kin_records ${sql.insert(records)}`;
          const ids = records.map((one) => one.record_id);
          // Replay one by one if these writes move a teammate's per-entry sequence.
          if ((yield* teamPairs(orgId, ids).pipe(provideSql)).length > 0) return yield* unavailable;
          const changes = yield* sql<{ recordId: string; seq: number }>`
        INSERT INTO kin_record_changes ${sql.insert(history)} RETURNING record_id AS "recordId", seq`;
          const sequenceById = new Map(changes.map((one) => [one.recordId, one.seq]));
          yield* indexRecords(orgId, ids).pipe(provideSql);
          let previous = 0;
          for (const one of records) {
            const seq = sequenceById.get(one.record_id);
            if (seq === undefined || seq <= previous) return yield* unavailable;
            previous = seq;
            yield* sql.afterCommit(
              PubSub.publish(ticks, {
                orgId,
                seq,
                key: one.key,
                registerId: list,
                created: true,
                team: new Map<string, number>(),
              }),
            );
          }
          return true;
        }),
      )
      .pipe(Effect.orElseSucceed(() => false));
  });

  /**
   * Whether an entry's notes were last written by a person (a coding agent's write is not), back
   * through a repeat's earlier occurrences (`wordsOf`).
   */
  const notesByPerson = Effect.fn("KinRecords.notesByPerson")(function* (
    orgId: KinOrgId,
    recordId: string,
  ) {
    const { writers, madeBy } = yield* wordsOf(orgId, recordId).pipe(provideSql);
    const last = writers.find((one) => one.notes === 1);
    return last === undefined
      ? madeBy?.kind === "person"
      : last.actorKind === "person" && last.coding === 0;
  });

  const update = Effect.fn("KinRecords.update")(function* (
    orgId: KinOrgId,
    writer: Writer,
    key: string,
    asked: Patch,
    expectedRev?: number,
    also: ReadonlyArray<FieldChange> = [],
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const row = yield* byKey(orgId, key).pipe(provideSql);
        if (row === undefined) return yield* notFound(key);
        const contact =
          row.registerId === "contacts" && asked.fields !== undefined
            ? contactFields(parseFields(row.fieldsJson), asked.fields)
            : undefined;
        if (isChatError(contact)) return yield* contact;
        const given = contact === undefined ? asked : { ...asked, fields: contact };
        const patch =
          given.fields === undefined
            ? given
            : {
                ...given,
                fields: yield* cleanTags(orgId, row.registerId, given.fields).pipe(provideSql),
              };
        if ((yield* markedKey(writer)) !== undefined) {
          const stored = parseFields(row.fieldsJson);
          const listed = yield* listDef(orgId, row.registerId).pipe(provideSql);
          const refused = keyRefusal({
            list: row.registerId,
            money:
              listed === undefined
                ? { paidOverTime: row.takesPayments === 1, carriesAmount: false }
                : moneyOf(listed),
            state: patch.state ?? row.state,
            numbered: "number" in stored || patch.fields?.number != null,
            before: { state: row.state, numbered: "number" in stored },
            touches: Object.entries(patch).flatMap(([field, value]) =>
              value === undefined
                ? []
                : field === "fields" && value !== null && typeof value === "object"
                  ? Object.keys(value)
                  : [field],
            ),
          });
          if (refused !== undefined) return yield* refused;
        }
        const write = {
          row,
          changes: true,
          input: patch,
          leaveBy: selfLeave(writer, row, asked, also),
        };
        if (writer.teammate === true && writer.actor._tag === "person")
          yield* teamGuard(orgId, writer.actor.personId, write).pipe(provideSql);
        if (writer.view !== undefined) yield* viewGuard(orgId, writer.view, write).pipe(provideSql);
        const now = yield* Clock.currentTimeMillis;
        const before = toRecord(row, now);
        const def = yield* resolveList(orgId, row.registerId);
        const list = def.id;
        if (list === "deals" && writer.deal !== true) return yield* dealsOnly;
        const invalidFor = checkInput(def, {
          title: patch.title,
          state: patch.state,
          category: patch.category,
          fields: patch.fields,
          amount: patch.amount,
          dateAt: patch.dateAt,
          repeat: patch.repeat,
          steps:
            patch.steps !== undefined || patch.urgent !== undefined || patch.tick !== undefined,
        });
        if (invalidFor !== undefined) return yield* invalidFor;
        if (recordsMoney(patch.amount, patch.fields))
          yield* countryFirst(orgId, { saved: true }).pipe(provideSql);
        const zero = zeroOwed(def, patch.amount, patch.category ?? row.category, writer);
        if (zero !== undefined) return yield* zero;
        if (
          patch.askSlip === true &&
          patch.amount != null &&
          (patch.amount.minor !== row.amountMinor || patch.amount.currency !== row.currency)
        )
          yield* askSlip(orgId, def, patch.amount, row.recordId).pipe(provideSql);
        if (list === "receipts") {
          if (RECEIPT_TIES.some((field) => field in (patch.fields ?? {})))
            return yield* invalid(RECEIPT_TIES_ARE_KINS);
          // Its payment may have a new receipt since: two live ones would count it twice.
          if (row.state === "dropped" && patch.state !== undefined && patch.state !== "dropped")
            return yield* invalid(`${row.key} is a void receipt, and stays void. Make a new one.`);
          const tied =
            patch.amount !== undefined &&
            (patch.amount?.minor !== row.amountMinor || patch.amount?.currency !== row.currency) &&
            (typeof parseFields(row.fieldsJson).payment === "string" ||
              (yield* sql`SELECT 1 FROM kin_issued_numbers
                WHERE org_id = ${orgId} AND record_id = ${row.recordId} LIMIT 1`).length > 0);
          if (tied)
            return yield* invalid(
              `${row.key} is a receipt Kin numbered or tied to a payment, so its amount stays what was received. Void it and make a new one instead.`,
            );
        }
        if (
          numberingOf(def) !== undefined &&
          patch.fields !== undefined &&
          "number" in patch.fields
        ) {
          if (writer.actor._tag !== "person") return yield* invalid(NUMBERS_ARE_ISSUED);
          const issued = yield* sql`SELECT 1 FROM kin_issued_numbers
            WHERE org_id = ${orgId} AND record_id = ${row.recordId} LIMIT 1`;
          if (issued.length > 0)
            return yield* invalid(
              `${row.key} was issued its number, and an issued number never changes.`,
            );
        }
        if (def.builtIn === null && patch.fields !== undefined)
          yield* verifyRefs(orgId, def, patch.fields).pipe(provideSql);
        const changes: Array<FieldChange> = [];
        const sets: Array<Statement.Fragment> = [];
        const set = (column: string, value: string | number | null) =>
          sets.push(sql`${sql(column)} = ${value}`);
        // A task given another client leaves a project of a different client; one with none stays.
        const [heldIn] =
          row.registerId !== "work" ||
          patch.projectId !== undefined ||
          row.projectId === null ||
          patch.partyId === undefined ||
          patch.partyId === null ||
          patch.partyId === row.partyId
            ? []
            : yield* sql<{ partyId: string | null }>`SELECT party_id AS "partyId" FROM kin_records
                WHERE org_id = ${orgId} AND record_id = ${row.projectId}`;
        const offProject =
          heldIn !== undefined && heldIn.partyId !== null && heldIn.partyId !== patch.partyId;
        const projectId = offProject
          ? null
          : patch.projectId === undefined
            ? row.projectId
            : patch.projectId;
        const project =
          patch.projectId === undefined || patch.projectId === null
            ? undefined
            : yield* target(orgId, patch.projectId, "projects");
        // Moved to another project, a task under the old project's client (or none) takes the new one's.
        const moved = project !== undefined && projectId !== row.projectId;
        const [was] =
          !moved || row.projectId === null || row.partyId === null
            ? []
            : yield* sql<{ partyId: string | null }>`SELECT party_id AS "partyId" FROM kin_records
                WHERE org_id = ${orgId} AND record_id = ${row.projectId}`;
        const partyId =
          patch.partyId !== undefined
            ? patch.partyId
            : project !== undefined &&
                (row.partyId === null || (was !== undefined && was.partyId === row.partyId))
              ? project.partyId
              : row.partyId;
        const invalidRefs = checkRefs(def, partyId, projectId);
        if (invalidRefs !== undefined) return yield* invalidRefs;
        const partyChanged = partyId !== row.partyId;
        const newParty =
          partyChanged && partyId !== null ? yield* target(orgId, partyId, "clients") : undefined;
        if (partyChanged) {
          changes.push({ field: "party", from: row.partyKey, to: newParty?.key ?? null });
          set("party_id", partyId);
        }
        if (projectId !== row.projectId) {
          changes.push({ field: "project", from: row.projectKey, to: project?.key ?? null });
          set("project_id", projectId);
        }
        if (patch.repo !== undefined && patch.repo !== row.repo) {
          changes.push({ field: "repo", from: row.repo, to: patch.repo });
          set("repo", patch.repo);
        }
        const author = textBy(writer);
        if (patch.title !== undefined && patch.title !== row.title) {
          changes.push({ field: "title", from: row.title, to: patch.title });
          set("title", patch.title);
          set("title_by", author ?? row.titleBy);
        }
        if (patch.title !== undefined || partyId !== row.partyId || patch.category !== undefined)
          yield* sameName(
            orgId,
            list,
            patch.title ?? row.title,
            partyId,
            row.recordId,
            patch.category === undefined ? row.category : patch.category,
            writer.namesSeenBy,
          );
        const stored = parseFields(row.fieldsJson);
        const alsoOn =
          list === "work"
            ? yield* alsoOnFor(
                orgId,
                writer,
                patch.fields?.alsoOn,
                fieldList(stored, "alsoOn"),
                patch.owner ?? before.owner,
              )
            : undefined;
        if (alsoOn !== undefined)
          yield* helperGuard(orgId, writer, row, before.owner, patch, alsoOn);
        const billToPatch =
          hasBillTo(list) &&
          (partyChanged ||
            Object.keys(patch.fields ?? {}).some((field) => Object.hasOwn(BILL_TO_FIELDS, field)))
            ? (patch.fields ?? {})
            : undefined;
        const name =
          patch.fields?.billToName === undefined ? stored.billToName : patch.fields.billToName;
        if (billToPatch !== undefined) {
          const client =
            newParty ?? (partyId === null ? undefined : yield* target(orgId, partyId, "clients"));
          yield* validateBillTo(
            gstCompany(orgId),
            row.key,
            client,
            billToPatch,
            name,
            partyChanged,
          );
        }
        const clearBilling =
          hasBillTo(list) &&
          ((billToPatch !== undefined && clearsBillTo(billToPatch)) ||
            (partyId === null && billToNameOf({ billToName: name ?? null }) === null));
        const merged: Record<string, FieldValue> = { ...stored };
        let fieldsChanged = false;
        for (const [field, value] of Object.entries({
          ...patch.fields,
          ...(clearBilling ? clearedBillTo : {}),
          ...(alsoOn === undefined ? {} : { alsoOn: alsoOn.length === 0 ? null : alsoOn }),
        })) {
          const from = shownField(stored[field]);
          const to = shownField(value);
          if (from === to) continue;
          const names = patch.names?.[field];
          changes.push({ field, from, to, ...(names === undefined ? {} : { names }) });
          fieldsChanged = true;
          if (value === null) delete merged[field];
          else merged[field] = value;
        }
        // Why it was given no longer holds once it moves on with no new why; its history keeps the old.
        const movedOn =
          patch.handedBack !== undefined ||
          (patch.owner !== undefined &&
            !samePrincipal(patch.owner, before.owner) &&
            patch.fields?.reason === undefined);
        if (movedOn && merged.reason !== undefined) {
          changes.push({ field: "reason", from: shownField(merged.reason), to: null });
          delete merged.reason;
          fieldsChanged = true;
        }
        // A notice held for one holder means nothing once it moves to another.
        if (
          patch.owner !== undefined &&
          !samePrincipal(patch.owner, before.owner) &&
          patch.fields?.untold === undefined &&
          merged.untold !== undefined
        ) {
          changes.push({ field: "untold", from: shownField(merged.untold), to: null });
          delete merged.untold;
          fieldsChanged = true;
        }
        // Who funded it decides what is owed: a partner's reads owed, the company's nothing.
        if (
          shownField(stored[FUNDED_BY]) !== shownField(merged[FUNDED_BY]) &&
          patch.fields?.[REIMBURSEMENT] === undefined &&
          def.fields.some((one) => one.key === REIMBURSEMENT)
        ) {
          const was = shownField(merged[REIMBURSEMENT]);
          if (funds(def, merged[FUNDED_BY]) && merged[REIMBURSEMENT] === undefined)
            merged[REIMBURSEMENT] = "owed";
          else if (merged[FUNDED_BY] === undefined) {
            delete merged[REIMBURSEMENT];
            delete merged[REPAID_ON];
          }
          if (shownField(merged[REIMBURSEMENT]) !== was) {
            changes.push({
              field: REIMBURSEMENT,
              from: was,
              to: shownField(merged[REIMBURSEMENT]),
            });
            fieldsChanged = true;
          }
        }
        if (fieldsChanged) set("fields_json", yield* encodeFieldValues(merged));
        const amount = amountOf(row) ?? null;
        const byOwner = writer.via === "owner";
        const amountChanged =
          patch.amount !== undefined &&
          (patch.amount?.minor !== amount?.minor || patch.amount?.currency !== amount?.currency);
        if (
          list === "expenses" &&
          shownField(stored[REPAID_ON]) !== shownField(merged[REPAID_ON])
        ) {
          const today = dayIn(
            yield* Clock.currentTimeMillis,
            yield* ownerZone(orgId).pipe(provideSql),
          );
          const ahead = repaidAhead(merged, today);
          if (ahead !== undefined) return yield* ahead;
        }
        const fundingMoved =
          list === "expenses"
            ? FUNDING.filter((field) => shownField(stored[field]) !== shownField(merged[field]))
            : [];
        if (writer.actor._tag === "agent" && fundingMoved.length > 0) {
          if (!(yield* agentMayFund(orgId, writer).pipe(provideSql)))
            return yield* notAllowed(FUNDING_IS_THE_OWNERS);
          const set = fundingMoved.filter((field) => shownField(stored[field]) !== null);
          if (set.length > 0) {
            const [byPerson] = yield* sql`SELECT 1 FROM kin_record_changes c
              WHERE c.org_id = ${orgId} AND c.record_id = ${row.recordId}
                AND c.actor_kind <> 'agent'
                AND c.seq = (SELECT MAX(l.seq) FROM kin_record_changes l, json_each(l.fields_json) f
                  WHERE l.org_id = c.org_id AND l.record_id = c.record_id
                    AND json_extract(f.value, '$.field') IN ${sql.in(set)})
              LIMIT 1`;
            if (byPerson !== undefined) return yield* notAllowed(FUNDING_A_PERSON_SET);
          }
        }
        // A repayment Confirm linked to a bank row binds the expenses it settled: what they cost,
        // who is paid back and when stay as the bank saw them until that repayment is undone.
        if (list === "expenses") {
          const was = fundingOf(stored);
          const moves =
            amountChanged ||
            (patch.state !== undefined && patch.state !== row.state) ||
            [FUNDED_BY, REIMBURSEMENT, REPAID_ON].some(
              (field) => shownField(stored[field]) !== shownField(merged[field]),
            );
          if (moves && was.by === "partner" && was.state === "repaid") {
            const [bound] = yield* sql`SELECT 1 FROM kin_bank_statement_entries
              WHERE org_id = ${orgId} AND target_record_id = ${row.recordId}
                AND action = 'expense_linked' AND json_extract(prior_json, '$.repaid') IS NOT NULL
              LIMIT 1`;
            if (bound !== undefined)
              return yield* invalid(
                `This was paid back on ${was.repaidOn ?? "its bank line's day"}. Undo that repayment first.`,
              );
          }
        }
        if (amountChanged && row.paid > 0) {
          const received = formatMoney({ minor: row.paid, currency: amount!.currency });
          // An invoice's payments are in its currency: a different one would make them nonsense.
          if (patch.amount?.currency !== amount?.currency)
            return yield* invalid(
              `${row.key} has payments in ${amount?.currency}; void them before changing its currency.`,
            );
          if (patch.amount!.minor < row.paid)
            return yield* new SensitiveRefusal({
              reason: "invalid_state",
              message: `${row.key} has ${received} received, so its amount can't be less. ${byOwner ? "Take a payment back first" : "Void a payment with payment_record first"}, then change the amount.`,
            });
        }
        // Paid or owed follows the balance whenever the amount moves; a state saying otherwise is
        // refused, while Draft and Void stay the caller's to set.
        const balanced = amountChanged && row.paid > 0;
        const owed = balanced ? patch.amount!.minor - row.paid : 0;
        const owing = owedState(def);
        if (
          balanced &&
          ((patch.state === "done" && owed > 0) || (patch.state === owing && owed === 0))
        )
          return yield* new SensitiveRefusal({
            reason: "invalid_state",
            message:
              owed > 0
                ? `${row.key} would still have ${formatMoney({ minor: owed, currency: amount!.currency })} owed, so it can't be ${stateLabel(def, "done")}. Leave the state out: recording the rest ${byOwner ? "as a payment" : "with payment_record"} marks it ${stateLabel(def, "done")}.`
                : `${row.key} would be fully paid at this amount, so it can't be ${stateLabel(def, patch.state ?? "waiting")}. Leave the state out.`,
          });
        const settled =
          balanced && patch.state === undefined && row.state !== "dropped"
            ? owed === 0
              ? def.states.includes("done")
                ? "done"
                : row.state
              : row.state === "done"
                ? (owing ?? row.state)
                : row.state
            : undefined;
        const wanted = patch.state ?? settled ?? row.state;
        // A turn no person started settles nothing paid over time, and voids or reopens no
        // numbered entry, by its state: the other ways to a payment or a void (`refuseKinOwn`).
        const settles = wanted === "done" && row.takesPayments === 1;
        if (
          writer.actor._tag === "agent" &&
          writer.wakeupId !== undefined &&
          wanted !== row.state &&
          !isSuggestion(row) &&
          (settles ||
            (yield* sql`SELECT 1 FROM kin_issued_numbers
              WHERE org_id = ${orgId} AND record_id = ${row.recordId} LIMIT 1`).length > 0) &&
          (yield* kinOwnTurn(orgId, writer.actor.agentId, writer.wakeupId).pipe(provideSql))
        )
          return yield* new KinChatError({
            reason: "not_allowed",
            message: settles ? KIN_OWN_REFUSAL.payment : KIN_OWN_REFUSAL.number,
          });
        // An agent never issues or settles an invoice by its state: Issue gives it its number.
        const unissued =
          writer.actor._tag === "agent" &&
          list === "invoices" &&
          !isSuggestion(row) &&
          (wanted === "waiting" || wanted === "done") &&
          wanted !== row.state &&
          (yield* sql`SELECT 1 FROM kin_issued_numbers
            WHERE org_id = ${orgId} AND record_id = ${row.recordId} LIMIT 1`).length === 0;
        // An agent's done on a task with an open card about it waits on that card's person; a
        // card this very write settles (`answering`) is no longer open.
        const spared = writer.answering?.length ? writer.answering : [""];
        const [carded] =
          list === "work" &&
          wanted === "done" &&
          !isClosed(row.state) &&
          (writer.actor._tag === "agent" || (yield* markedKey(writer)) !== undefined)
            ? yield* sql<{ personId: string }>`SELECT person_id AS "personId" FROM kin_questions
                WHERE org_id = ${orgId} AND state = 'open'
                  AND (' ' || about || ' ') LIKE ${`% ${row.key} %`}
                  AND (widget_id IS NULL OR widget_id NOT IN ${sql.in(spared)})
                  AND (raise_widget_id IS NULL OR raise_widget_id NOT IN ${sql.in(spared)})
                ORDER BY asked_at, question_id LIMIT 1`
            : [];
        const state = unissued ? row.state : carded !== undefined ? "waiting" : wanted;
        // Only who may keep one keeps a suggestion, and only an owner-level person takes it back;
        // anyone else's `confirmed` changes nothing, so an agent's slip ack stays only that.
        const keeping =
          patch.confirmed === true && isSuggestion(row) && (yield* mayKeep(orgId, writer));
        const unkeeping =
          patch.confirmed === false &&
          !isSuggestion(row) &&
          writer.actor._tag === "person" &&
          (yield* ownerLevel(orgId, writer.actor.personId).pipe(provideSql));
        // Until it is kept, a suggestion is issued, sent or paid by nobody; undoing its drop
        // puts back only what it was.
        if (
          isSuggestion(row) &&
          !keeping &&
          MONEY_LISTS.has(list) &&
          row.state !== "dropped" &&
          state !== row.state &&
          (state === "waiting" || state === "done")
        )
          return yield* invalid(stillSuggestion(row.key));
        // Closing a client or project would strand what points at it: close or move that first.
        if (
          (list === "clients" || list === "projects") &&
          isClosed(state) &&
          !isClosed(row.state)
        ) {
          const open = yield* sql<{ key: string; withheld: number }>`SELECT r.key,
              ${keyWithheld(sql)} AS withheld FROM kin_records r
            WHERE r.org_id = ${orgId}
              AND (r.party_id = ${row.recordId} OR r.project_id = ${row.recordId})
              AND r.register_id IN ('work', 'projects') AND r.state NOT IN ${sql.in(CLOSED)}
            ORDER BY r.created_at, r.key`;
          // Through a coding agent's key, what it can't reach is not named or counted.
          if (open.length > 0 && (yield* markedKey(writer)) !== undefined) {
            const shown = open.filter((one) => one.withheld !== 1).map((one) => one.key);
            return yield* new KinChatError({
              reason: "invalid_state",
              message: `${row.key} still has open entries pointing at it${
                shown.length === 0 ? "" : `: ${shown.slice(0, OPEN_KEYS_NAMED).join(", ")}`
              }${shown.length < open.length ? ", and open entries you cannot see here" : ""}. Close or move them first.`,
            });
          }
          if (open.length > 0) {
            const named = open.slice(0, OPEN_KEYS_NAMED).map((one) => one.key);
            const more = open.length - named.length;
            return yield* new KinChatError({
              reason: "invalid_state",
              message: `${row.key} still has ${open.length} open ${list === "clients" ? "entries or projects" : "entries"} pointing at it: ${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}. Close or move them first.`,
            });
          }
          const unpaid =
            list === "clients"
              ? yield* owedInvoices({ orgId, now, partyId: row.recordId }).pipe(provideSql)
              : [];
          if (unpaid.length > 0) {
            const named = unpaid
              .slice(0, OPEN_KEYS_NAMED)
              .map((one) => `${one.key} (${formatMoney(one.balance)} owed)`);
            const more = unpaid.length - named.length;
            return yield* new SensitiveRefusal({
              reason: "invalid_state",
              message: `${row.key} still owes on ${unpaid.length} unpaid ${unpaid.length === 1 ? "invoice" : "invoices"}: ${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}. Record their payments or void them first.`,
            });
          }
        }
        if (state !== row.state) {
          changes.push({ field: "state", from: row.state, to: state });
          set("state", state);
          if (isClosed(state) !== isClosed(row.state))
            set("closed_at", isClosed(state) ? now : null);
        }
        const waitingOn =
          state !== "waiting"
            ? null
            : carded !== undefined
              ? ({ _tag: "person", personId: KinPersonId.make(carded.personId) } as const)
              : patch.waitingOn !== undefined
                ? patch.waitingOn
                : before.waitingOn;
        if (waitingOn !== null && !samePrincipal(waitingOn, before.waitingOn))
          yield* ownerExists(orgId, waitingOn, "to wait on");
        // A dismissed question released this task; only Undo or that person's own word re-waits it.
        if (
          waitingOn?._tag === "person" &&
          carded === undefined &&
          writer.actor._tag === "agent" &&
          !samePrincipal(waitingOn, before.waitingOn)
        ) {
          const dismisser = yield* dismissedHold(orgId, row.recordId, waitingOn.personId).pipe(
            provideSql,
          );
          if (
            dismisser !== undefined &&
            (writer.wakeupId === undefined ||
              !(yield* personInTurn(
                orgId,
                writer.actor.agentId,
                writer.wakeupId,
                waitingOn.personId,
              ).pipe(provideSql)))
          )
            return yield* invalid(dismissedHoldText(dismisser, row.key));
        }
        if (
          !samePrincipal(waitingOn, before.waitingOn) ||
          (state !== "waiting" && row.waitingOnId !== null)
        ) {
          if (!samePrincipal(waitingOn, before.waitingOn))
            changes.push({
              field: "waitingOn",
              from: shownPrincipal(before.waitingOn),
              to: shownPrincipal(waitingOn),
            });
          set("waiting_on_kind", waitingOn?._tag ?? null);
          set("waiting_on_id", waitingOn === null ? null : principalId(waitingOn));
        }
        let reassigned: KinWorkPrincipal | undefined;
        if (patch.owner !== undefined && !samePrincipal(patch.owner, before.owner)) {
          if (isClosed(state))
            return yield* new KinChatError({
              reason: "invalid_state",
              message: `${row.key} is ${state}. Reopen it before giving it to someone.`,
            });
          yield* ownerExists(orgId, patch.owner);
          // A project's lead sees more or less from now on; their places follow `leads`.
          if (list === "projects") {
            const refresh = yield* Effect.serviceOption(KinRefreshObserver);
            if (Option.isSome(refresh)) yield* sql.afterCommit(refresh.value.touch(orgId, "leads"));
          }
          changes.push({
            field: "owner",
            from: shownPrincipal(before.owner),
            to: shownPrincipal(patch.owner),
          });
          set("owner_kind", patch.owner._tag);
          set("owner_id", principalId(patch.owner));
          // Reassigning never launders authority: the assigner is whoever asked for this change.
          // Handed back, it keeps the authority it was given with; the holder's words go with it.
          // Handed back, it says so on the giver's row until it is given again; never while closed.
          set("handed_back_kind", patch.handedBack === undefined ? null : before.owner._tag);
          set("handed_back_id", patch.handedBack === undefined ? null : principalId(before.owner));
          set("handed_back_at", patch.handedBack === undefined ? null : now);
          if (patch.handedBack === undefined) {
            set("assigned_by_person_id", writer.askedBy ?? null);
            set(
              "assigned_at",
              writer.askedBy === undefined || writer.askedBy === null ? null : now,
            );
          } else
            changes.push({
              field: "handedBack",
              from: shownPrincipal(before.owner),
              to: patch.handedBack.note,
            });
          // A lead is the giver only on its own initiative; asked, the person who asked is.
          set(
            "assigned_by_agent_id",
            writer.actor._tag === "agent" &&
              writer.askedBy == null &&
              patch.handedBack === undefined &&
              !samePrincipal(writer.actor, patch.owner)
              ? writer.actor.agentId
              : null,
          );
          reassigned = patch.owner;
        }
        // Reopened by a person, a lead's entry is given to it again, with that person's authority.
        const reopened =
          writer.undoing === undefined &&
          reassigned === undefined &&
          before.owner._tag === "agent" &&
          writer.actor._tag === "person" &&
          isClosed(row.state) &&
          !isClosed(state);
        const undoneFor =
          writer.undoing !== undefined &&
          reassigned === undefined &&
          before.owner._tag === "agent" &&
          before.owner.agentId !== writer.undoing.asker &&
          isClosed(row.state) &&
          !isClosed(state);
        if (reopened) {
          set("assigned_by_person_id", writer.askedBy ?? null);
          set("assigned_at", writer.askedBy === undefined || writer.askedBy === null ? null : now);
        }
        if (patch.dueAt !== undefined && patch.dueAt !== row.dueAt) {
          changes.push({ field: "due", from: shownDue(row.dueAt), to: shownDue(patch.dueAt) });
          set("due_at", patch.dueAt);
        }
        if (patch.dueAllDay !== undefined && (patch.dueAllDay ? 1 : 0) !== row.dueAllDay) {
          if ((patch.dueAt === undefined ? row.dueAt : patch.dueAt) !== null)
            changes.push({
              field: "dueAllDay",
              from: shown(row.dueAllDay === 1),
              to: shown(patch.dueAllDay),
            });
          set("due_all_day", patch.dueAllDay ? 1 : 0);
        }
        if (amountChanged) {
          changes.push({
            field: "amount",
            from: shownAmount(amount),
            to: shownAmount(patch.amount),
          });
          set("amount_minor", patch.amount?.minor ?? null);
          set("currency", patch.amount?.currency ?? null);
        }
        if (patch.dateAt !== undefined && patch.dateAt !== row.dateAt) {
          changes.push({ field: "date", from: shownDue(row.dateAt), to: shownDue(patch.dateAt) });
          set("date_at", patch.dateAt);
        }
        if (patch.dateAllDay !== undefined && (patch.dateAllDay ? 1 : 0) !== row.dateAllDay)
          set("date_all_day", patch.dateAllDay ? 1 : 0);
        if (patch.repeat !== undefined) {
          const was = repeatOf(row.repeatJson)?.rule ?? null;
          if (shownRepeat(was) !== shownRepeat(patch.repeat)) {
            const stored =
              patch.repeat === null
                ? null
                : yield* storedRepeat(
                    orgId,
                    patch.repeat,
                    patch.dueAt === undefined ? row.dueAt : patch.dueAt,
                    patch.dateAt === undefined ? row.dateAt : patch.dateAt,
                  );
            changes.push({
              field: "repeat",
              from: shownRepeat(was),
              to: shownRepeat(patch.repeat),
            });
            set("repeat_json", stored === null ? null : yield* encodeRepeat(stored));
          }
        } else if (
          (patch.dueAt !== undefined || patch.dateAt !== undefined) &&
          repeatOf(row.repeatJson) !== undefined
        ) {
          // Moved dates move the days of the month later occurrences keep.
          const stored = yield* storedRepeat(
            orgId,
            repeatOf(row.repeatJson)!.rule,
            patch.dueAt === undefined ? row.dueAt : patch.dueAt,
            patch.dateAt === undefined ? row.dateAt : patch.dateAt,
          );
          set("repeat_json", yield* encodeRepeat(stored));
        }
        const storedSteps = stepsOf(row);
        const ticked = patch.tick === undefined ? undefined : storedSteps[patch.tick.index];
        if (patch.tick !== undefined && ticked?.title !== patch.tick.title)
          return yield* conflict(row.key, row.rev);
        const steps =
          patch.tick === undefined
            ? patch.steps
            : storedSteps.map((step, index) =>
                index === patch.tick?.index ? { title: step.title, done: patch.tick.done } : step,
              );
        const same = (a: ReadonlyArray<Step>, b: ReadonlyArray<Step>) =>
          a.length === b.length &&
          a.every((step, index) => step.title === b[index]?.title && step.done === b[index]?.done);
        if (steps !== undefined && !same(steps, storedSteps)) {
          changes.push({ field: "steps", from: shownSteps(storedSteps), to: shownSteps(steps) });
          set("steps_json", steps.length === 0 ? null : yield* encodeSteps(steps));
        }
        if (patch.urgent !== undefined && patch.urgent !== (row.urgent === 1)) {
          changes.push({ field: "urgent", from: shown(row.urgent === 1), to: shown(patch.urgent) });
          set("urgent", patch.urgent ? 1 : null);
        }
        if (patch.notes !== undefined && patch.notes !== row.notes) {
          // A person's notes on a task stay theirs: an agent's text goes on its activity instead.
          if (
            writer.actor._tag === "agent" &&
            list === "work" &&
            row.notes !== "" &&
            (yield* notesByPerson(orgId, row.recordId))
          ) {
            if (patch.notes.trim() !== "") {
              const requestHash = commentHashOf(patch.notes, []);
              // Keyed by the one event the turn answers, which a stopped and resumed turn keeps.
              const events =
                writer.wakeupId === undefined
                  ? []
                  : yield* sql<{ eventId: string }>`SELECT event_id AS "eventId" FROM kin_events
                      WHERE org_id = ${orgId} AND agent_id = ${writer.actor.agentId}
                        AND wakeup_id = ${writer.wakeupId}
                      ORDER BY event_id LIMIT 2`;
              const source = events.length === 1 ? `${events[0]!.eventId}:` : "";
              const noter = {
                _tag: "agent" as const,
                agentId: writer.actor.agentId,
                askedBy: writer.askedBy ?? null,
              };
              const requestId = `notes:${source}${requestHash}`;
              // A stale revision writes no new note; a retry of one already written still lands.
              if (expectedRev !== undefined && expectedRev !== row.rev) {
                const [noted] = yield* sql`SELECT 1 FROM kin_record_comments
                  WHERE org_id = ${orgId}
                    AND comment_id = ${commentIdFor(orgId, row.recordId, noter, requestId)}`;
                if (noted === undefined) return yield* conflict(row.key, row.rev);
              }
              yield* insertComment({
                orgId,
                key: row.key,
                author: noter,
                requestId,
                requestHash,
                body: patch.notes,
                files: [],
                now,
                sees: () => Effect.succeed(true),
              }).pipe(provideSql);
            }
          } else {
            changes.push({ field: "notes", from: row.notes, to: patch.notes });
            set("notes", patch.notes);
            set("notes_by", patch.notes === "" ? null : (author ?? row.notesBy));
          }
        }
        if (patch.category !== undefined && patch.category !== row.category) {
          changes.push({ field: "category", from: row.category, to: patch.category });
          set("category", patch.category);
        }
        if (patch.side !== undefined && patch.side !== row.side) {
          changes.push({ field: "side", from: row.side, to: patch.side });
          set("side", patch.side);
        }
        if (keeping || unkeeping) {
          changes.push({
            field: "confirmed",
            from: shown(row.confirmed === 1),
            to: shown(patch.confirmed),
          });
          set("confirmed", patch.confirmed ? 1 : 0);
        }
        // Anyone may raise a label; only a person lowers one, and only the owner reaches here so.
        if (patch.sensitive === true && row.sensitive === 0) {
          changes.push({ field: "sensitive", from: "false", to: "true" });
          set("sensitive", 1);
          set("marked_by_person_id", textBy(writer));
        } else if (patch.sensitive === true && row.markedBy === null) {
          // Labelled only by its list's default until now: whose label it is now is recorded.
          set("marked_by_person_id", textBy(writer));
        } else if (
          patch.sensitive === false &&
          row.sensitive === 1 &&
          writer.actor._tag === "person"
        ) {
          changes.push({ field: "sensitive", from: "true", to: "false" });
          set("sensitive", 0);
          set("marked_by_person_id", null);
        }
        if (patch.team !== undefined && (patch.team ? 1 : 0) !== row.teamShared) {
          changes.push({ field: "team", from: shown(row.teamShared === 1), to: shown(patch.team) });
          set("team_shared", patch.team ? 1 : 0);
        }
        changes.push(...also);
        // A retry of a change that already landed finds nothing to do: that is success.
        if (sets.length === 0 && also.length === 0) return row;
        if (writer.since !== undefined) {
          // A doc's body keeps to its own base version (`docs.ts`); its version count is no field.
          const writes = new Set(
            changes.filter((one) => one.field !== "version").map((one) => asSet(one.field)),
          );
          if (patch.dateAllDay !== undefined && (patch.dateAllDay ? 1 : 0) !== row.dateAllDay)
            writes.add("date");
          yield* keptForPerson(orgId, writer.since, row, def, writes, writer.view);
        }
        if (expectedRev !== undefined && expectedRev !== row.rev)
          return yield* conflict(row.key, row.rev);
        const rev = row.rev + 1;
        set("rev", rev);
        set("updated_at", now);
        // A viewer may see a dependent row without seeing the record that changes it.
        const directoryChanged =
          (list === "clients" || list === "projects") &&
          (patch.sensitive !== undefined ||
            patch.partyId !== undefined ||
            patch.owner !== undefined ||
            (list === "projects" && patch.fields?.["members"] !== undefined));
        const changesIndirectRows =
          (list === "deals" && changes.some((field) => field.field === "sensitive")) ||
          (row.takesPayments === 1 &&
            list !== "receipts" &&
            (partyId !== row.partyId || projectId !== row.projectId));
        const dependents =
          directoryChanged || changesIndirectRows
            ? yield* dependentRows(orgId, row.recordId, list).pipe(provideSql)
            : [];
        const scope = [row.recordId, ...dependents.map((dependent) => dependent.recordId)];
        const members = (fields: Record<string, FieldValue>) =>
          fieldList(fields, "members").flatMap((text) =>
            text.startsWith("person:") ? [text.slice("person:".length)] : [],
          );
        const joined =
          list === "projects" && patch.fields?.["members"] !== undefined
            ? [...new Set([...members(stored), ...members(merged)])].filter(
                (person) => members(stored).includes(person) !== members(merged).includes(person),
              )
            : [];
        const team: TeamScope = {
          scope,
          before: yield* teamPairs(orgId, scope).pipe(provideSql),
          ...(changesIndirectRows && dependents.length > 0 ? { dependents } : {}),
          joined,
        };
        // Each update rewrites only the fields it changed, so two changes to one entry both land.
        yield* sql`UPDATE kin_records SET ${sql.csv(sets)}
          WHERE org_id = ${orgId} AND record_id = ${row.recordId}`;
        yield* indexRecord(orgId, row.recordId).pipe(provideSql);
        yield* choicesMoved(orgId, row.registerId);
        const seq = yield* logChange(
          orgId,
          writer,
          { recordId: row.recordId, key: row.key, rev },
          "updated",
          changes,
          now,
          team,
        );
        // Only a person lowers what is sensitive: any other write that would, labels the entry
        // instead, as Kin's own change. What inherits through it then stays sensitive too.
        if (
          writer.actor._tag !== "person" &&
          !(OWN_LABEL_LISTS as ReadonlyArray<string>).includes(list) &&
          (row.sensitive === 1 || row.inheritedSensitive === 1) &&
          (yield* effectivelySensitive(orgId, row.recordId).pipe(provideSql)) === false
        ) {
          yield* sql`UPDATE kin_records SET sensitive = 1, rev = ${rev + 1}, updated_at = ${now}
            WHERE org_id = ${orgId} AND record_id = ${row.recordId}`;
          yield* logChange(
            orgId,
            {
              actor: { _tag: "system" },
              via: writer.via,
              ...(writer.wakeupId === undefined ? {} : { wakeupId: writer.wakeupId }),
              ...(writer.chatId === undefined ? {} : { chatId: writer.chatId }),
            },
            { recordId: row.recordId, key: row.key, rev: rev + 1 },
            "updated",
            [{ field: "sensitive", from: "false", to: "true" }],
            now,
            team,
          );
        }
        if (keeping) {
          const holder = reassigned ?? before.owner;
          if (
            !isClosed(state) &&
            holder._tag === "agent" &&
            !(yield* alreadyGiven(orgId, row.recordId, holder.agentId))
          )
            yield* wakeLead(orgId, writer, row, holder, textBy(writer), seq, now);
        } else if (!isSuggestion(row) && !unkeeping) {
          if (reassigned !== undefined && patch.handedBack !== undefined)
            yield* wakeLead(
              orgId,
              writer,
              row,
              reassigned,
              row.assignedBy === null
                ? yield* agentOwner(orgId, reassigned)
                : KinPersonId.make(row.assignedBy),
              seq,
              now,
              "handed_back",
              patch.handedBack.note,
            );
          else if (reassigned !== undefined || reopened || undoneFor)
            yield* wakeLead(
              orgId,
              writer,
              row,
              reassigned ?? before.owner,
              writer.askedBy ?? null,
              seq,
              now,
            );
        }
        // A lead never keeps working an open entry a person closed or took from it; a suggestion
        // nobody kept was never its work.
        const withdrawnFrom: Principal | undefined =
          !isSuggestion(row) &&
          !isClosed(row.state) &&
          (isClosed(state) || reassigned !== undefined)
            ? before.owner
            : undefined;
        // Told only when the person is the lead's owner.
        if (withdrawnFrom?._tag === "agent" && writer.actor._tag === "person")
          yield* wakeLead(
            orgId,
            writer,
            row,
            withdrawnFrom,
            writer.actor.personId,
            seq,
            now,
            "withdrawn",
          );
        if (alsoOn !== undefined && (!isSuggestion(row) || keeping)) {
          const was = fieldList(stored, "alsoOn");
          const added = keeping ? alsoOn : alsoOn.filter((text) => !was.includes(text));
          yield* joinedWakes(orgId, writer, row, state, added, seq, now, keeping);
          if (!isClosed(state) && !isSuggestion(row) && writer.actor._tag === "person")
            for (const text of was) {
              const off = storedPrincipal(text);
              if (off?._tag !== "agent" || alsoOn.includes(text)) continue;
              if (reassigned !== undefined && samePrincipal(off, reassigned)) continue;
              yield* wakeLead(
                orgId,
                writer,
                row,
                off,
                writer.actor.personId,
                seq,
                now,
                "withdrawn",
              );
            }
        }
        const updated = yield* byId(orgId, row.recordId).pipe(provideSql);
        if (updated === undefined) return yield* unavailable;
        if (!isClosed(row.state) && isClosed(updated.state))
          yield* spawnNext(orgId, writer, updated);
        const left = patch.leftover?.trim() ?? "";
        if (list === "work" && left !== "" && updated.state === "done" && row.state !== "done")
          yield* insert(
            orgId,
            writer,
            {
              originKey: `leftover:${row.recordId}:${rev}`,
              title: left.split("\n")[0]!.slice(0, LEFTOVER_TITLE),
              ...(left.length > LEFTOVER_TITLE || left.includes("\n") ? { notes: left } : {}),
              owner: before.owner,
              partyId: row.partyId,
              projectId: row.projectId,
              ...(isSuggestion(row) ? { confirmed: false } : {}),
              links: [
                { kind: "record", target: row.recordId, relation: "relates", label: row.key },
              ],
            },
            { wake: true },
          );
        return updated;
      }),
    );
  });

  /** `update`; a client handed to someone else takes with it what it owes us (`promises.ts`). */
  const updateFollowing = Effect.fn("KinRecords.updateFollowing")(function* (
    orgId: KinOrgId,
    writer: Writer,
    key: string,
    asked: Patch,
    expectedRev?: number,
    also: ReadonlyArray<FieldChange> = [],
  ) {
    if (asked.owner === undefined)
      return yield* update(orgId, writer, key, asked, expectedRev, also);
    return yield* transaction(
      Effect.gen(function* () {
        const row = yield* byKey(orgId, key).pipe(provideSql);
        const updated = yield* update(orgId, writer, key, asked, expectedRev, also);
        if (row === undefined || row.registerId !== "clients") return updated;
        const was = yield* holderFor(orgId, row.ownerKind, row.ownerId).pipe(provideSql);
        const holder = yield* theirsHolder(orgId, row.recordId).pipe(provideSql);
        if (was === undefined || holder === undefined || samePrincipal(was, holder)) return updated;
        const moving: Writer = { actor: writer.actor, via: writer.via };
        for (const owed of yield* theirsHeldBy(orgId, row.recordId, was).pipe(provideSql))
          yield* update(orgId, moving, owed, { owner: holder });
        return updated;
      }),
    );
  });

  const handBack = Effect.fn("KinRecords.handBack")(function* (
    orgId: KinOrgId,
    writer: Writer,
    key: string,
    holder: KinWorkPrincipal,
    note: string | null,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const row = yield* byKey(orgId, key).pipe(provideSql);
        if (row === undefined) return yield* notFound(key);
        // What a teammate can't see is no task at all, before anything says who holds it.
        if (writer.teammate === true && writer.actor._tag === "person")
          yield* teamGuard(orgId, writer.actor.personId, { row, changes: false, input: {} }).pipe(
            provideSql,
          );
        const held = toRecord(row, yield* Clock.currentTimeMillis);
        if (row.registerId !== "work" || !samePrincipal(held.owner, holder))
          return yield* new KinChatError({
            reason: "not_allowed",
            message: `Only whoever holds ${row.key} can hand it back.`,
          });
        if (isClosed(row.state))
          return yield* new KinChatError({
            reason: "invalid_state",
            message: `${row.key} is ${row.state}. Reopen it first.`,
          });
        const [owner] = yield* sql<{ id: string }>`SELECT owner_person_id AS id FROM kin_agents
          WHERE org_id = ${orgId} ORDER BY created_at, agent_id LIMIT 1`;
        const to: KinWorkPrincipal | undefined =
          row.assignedByAgent !== null
            ? { _tag: "agent", agentId: KinAgentId.make(row.assignedByAgent) }
            : row.assignedBy !== null
              ? { _tag: "person", personId: KinPersonId.make(row.assignedBy) }
              : owner === undefined
                ? undefined
                : { _tag: "person", personId: KinPersonId.make(owner.id) };
        if (to === undefined || samePrincipal(to, holder))
          return yield* new KinChatError({
            reason: "invalid_state",
            message: `Nobody else gave ${row.key} to its holder, so there is no one to hand it back to. Drop it or give it to someone.`,
          });
        return yield* update(orgId, writer, key, {
          owner: to,
          state: "open",
          handedBack: { note },
        });
      }),
    );
  });

  const link = Effect.fn("KinRecords.link")(function* (
    orgId: KinOrgId,
    writer: Writer,
    recordId: string,
    input: LinkInput,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        if (input.kind === "url" && (yield* markedKey(writer)) !== undefined) {
          const row = yield* byId(orgId, recordId).pipe(provideSql);
          if (row === undefined) return yield* notFound(recordId);
          const listed = yield* listDef(orgId, row.registerId).pipe(provideSql);
          const numbered = "number" in parseFields(row.fieldsJson);
          const refused = keyRefusal({
            list: row.registerId,
            money:
              listed === undefined
                ? { paidOverTime: row.takesPayments === 1, carriesAmount: false }
                : moneyOf(listed),
            state: row.state,
            numbered,
            before: { state: row.state, numbered },
            touches: ["links"],
          });
          if (refused !== undefined) return yield* refused;
        }
        const now = yield* Clock.currentTimeMillis;
        if (!(yield* insertLink(orgId, recordId, input, now))) return false;
        const [row] = yield* sql<{ rev: number; key: string }>`SELECT rev, key FROM kin_records
          WHERE org_id = ${orgId} AND record_id = ${recordId}`;
        if (row === undefined) return yield* notFound(recordId);
        yield* logChange(
          orgId,
          writer,
          { recordId, key: row.key, rev: row.rev },
          "linked",
          [{ field: input.kind, from: null, to: input.label ?? input.target }],
          now,
        );
        return true;
      }),
    );
  });

  const unlink = Effect.fn("KinRecords.unlink")(function* (
    orgId: KinOrgId,
    writer: Writer,
    recordId: string,
    link: { readonly kind: string; readonly shown: string; readonly at: number },
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const [made] = yield* sql<{ target: string }>`SELECT target FROM kin_record_links
          WHERE org_id = ${orgId} AND record_id = ${recordId} AND kind = ${link.kind}
            AND created_at = ${link.at} AND COALESCE(label, target) = ${link.shown}`;
        if (made === undefined) return false;
        // The half back is written in its own moment of the same call, so a few ms either side.
        const halves = [
          { recordId, target: made.target, from: link.at, to: link.at },
          ...(link.kind === "record"
            ? [
                {
                  recordId: made.target,
                  target: recordId,
                  from: link.at - 5000,
                  to: link.at + 5000,
                },
              ]
            : []),
        ];
        for (const half of halves) {
          const [gone] = yield* sql<{ shown: string }>`DELETE FROM kin_record_links
            WHERE org_id = ${orgId} AND record_id = ${half.recordId} AND kind = ${link.kind}
              AND target = ${half.target} AND created_at BETWEEN ${half.from} AND ${half.to}
            RETURNING COALESCE(label, target) AS shown`;
          const [row] = yield* sql<{ rev: number; key: string }>`SELECT rev, key FROM kin_records
            WHERE org_id = ${orgId} AND record_id = ${half.recordId}`;
          if (gone === undefined || row === undefined) continue;
          yield* logChange(
            orgId,
            writer,
            { recordId: half.recordId, key: row.key, rev: row.rev },
            "linked",
            [{ field: link.kind, from: gone.shown, to: null }],
            now,
          );
        }
        return true;
      }),
    );
  });

  const pay = Effect.fn("KinRecords.pay")(function* (
    orgId: KinOrgId,
    writer: Writer,
    key: string,
    payment: PaymentInput,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        yield* refuseKinOwn(orgId, writer, KIN_OWN_REFUSAL.payment).pipe(provideSql);
        const row = yield* byKey(orgId, key).pipe(provideSql);
        if (row === undefined) return yield* notFound(key);
        if (row.takesPayments !== 1)
          return yield* invalid(
            `${row.key} is not an invoice or in a list paid over time; payments are recorded on those.`,
          );
        const def = yield* resolveList(orgId, row.registerId);
        const paymentId = paymentIdFor(orgId, payment.originKey);
        const [earlier] = yield* sql<{
          recordId: string;
          minor: number;
          currency: string;
          paidOn: string;
          note: string;
          withheld: number;
          voidedAt: number | null;
        }>`
          SELECT record_id AS "recordId", amount_minor AS minor, currency, paid_on AS "paidOn", note,
            withheld, voided_at AS "voidedAt"
          FROM kin_record_payments WHERE org_id = ${orgId} AND origin_key = ${payment.originKey}`;
        if (earlier !== undefined) {
          if (
            earlier.recordId !== row.recordId ||
            earlier.minor !== payment.amount.minor ||
            earlier.currency !== payment.amount.currency ||
            earlier.paidOn !== payment.paidOn ||
            earlier.note !== (payment.note ?? "") ||
            earlier.withheld !== (payment.withheld === true ? 1 : 0)
          )
            return yield* new KinChatError({
              reason: "not_allowed",
              message: "That retry key already recorded a different payment.",
            });
          if (earlier.voidedAt !== null) return yield* undoneRetry("payment");
          return { row, paymentId };
        }
        if (row.state === "dropped")
          return yield* invalid(`${row.key} is void; it takes no payments.`);
        if (isSuggestion(row)) return yield* invalid(stillSuggestion(row.key));
        const amount = amountOf(row);
        if (amount === undefined)
          return yield* invalid(`${row.key} has no amount yet; set it before recording payments.`);
        if (payment.amount.currency !== amount.currency)
          return yield* invalid(
            `${row.key} is in ${amount.currency}; record the payment in ${amount.currency}.`,
          );
        if (payment.amount.minor <= 0) return yield* invalid("A payment is more than nothing.");
        const balance = amount.minor - row.paid;
        if (payment.amount.minor > balance)
          return yield* new SensitiveRefusal({
            reason: "invalid_state",
            message: `That is more than the ${formatMoney({ minor: balance, currency: amount.currency })} still owed on ${row.key}.`,
          });
        const now = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO kin_record_payments (org_id, payment_id, record_id, amount_minor,
            currency, paid_on, note, origin_key, created_at, created_by_kind, created_by_id,
            withheld)
          VALUES (${orgId}, ${paymentId}, ${row.recordId}, ${payment.amount.minor},
            ${payment.amount.currency}, ${payment.paidOn}, ${payment.note ?? ""},
            ${payment.originKey}, ${now}, ${writer.actor._tag}, ${actorIdOf(writer)},
            ${payment.withheld === true ? 1 : 0})`;
        const paidUp =
          payment.amount.minor === balance && row.state !== "done" && def.states.includes("done");
        const rev = row.rev + 1;
        yield* sql`UPDATE kin_records SET rev = ${rev}, updated_at = ${now},
            state = ${paidUp ? "done" : row.state},
            closed_at = ${paidUp ? now : row.closedAt},
            waiting_on_kind = ${paidUp ? null : row.waitingOnKind},
            waiting_on_id = ${paidUp ? null : row.waitingOnId}
          WHERE org_id = ${orgId} AND record_id = ${row.recordId}`;
        yield* logChange(
          orgId,
          writer,
          { recordId: row.recordId, key: row.key, rev },
          "updated",
          [
            {
              field: "payment",
              from: null,
              to: `${formatMoney(payment.amount)} on ${payment.paidOn}`,
            },
            ...(paidUp ? [{ field: "state", from: row.state, to: "done" }] : []),
          ],
          now,
        );
        const updated = yield* byId(orgId, row.recordId).pipe(provideSql);
        if (updated === undefined) return yield* unavailable;
        if (paidUp && !isClosed(row.state)) yield* spawnNext(orgId, writer, updated);
        return { row: updated, paymentId };
      }),
    );
  });

  const voidPayment = Effect.fn("KinRecords.voidPayment")(function* (
    orgId: KinOrgId,
    writer: Writer,
    key: string,
    paymentId: string,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        yield* refuseKinOwn(orgId, writer, KIN_OWN_REFUSAL.payment).pipe(provideSql);
        const row = yield* byKey(orgId, key).pipe(provideSql);
        if (row === undefined) return yield* notFound(key);
        const [found] = yield* sql<{
          minor: number;
          currency: string;
          paidOn: string;
          voidedAt: number | null;
          originKey: string;
        }>`
          SELECT amount_minor AS minor, currency, paid_on AS "paidOn", voided_at AS "voidedAt",
            origin_key AS "originKey"
          FROM kin_record_payments WHERE org_id = ${orgId} AND payment_id = ${paymentId}
            AND record_id = ${row.recordId}`;
        if (found === undefined)
          return yield* new KinChatError({
            reason: "not_found",
            message: `No payment ${paymentId.slice(0, 40)} on ${row.key}.`,
          });
        if (found.voidedAt !== null) return row;
        const now = yield* Clock.currentTimeMillis;
        yield* sql`UPDATE kin_record_payments SET voided_at = ${now}
          WHERE org_id = ${orgId} AND payment_id = ${paymentId}`;
        // Paid no longer, it is owed again: issued, as it was before the payment closed it.
        const owing = owedState(yield* resolveList(orgId, row.registerId));
        const reissued = row.state === "done" && owing !== undefined;
        const rev = row.rev + 1;
        yield* sql`UPDATE kin_records SET rev = ${rev}, updated_at = ${now},
            state = ${reissued ? owing : row.state}, closed_at = ${reissued ? null : row.closedAt}
          WHERE org_id = ${orgId} AND record_id = ${row.recordId}`;
        yield* logChange(
          orgId,
          writer,
          { recordId: row.recordId, key: row.key, rev },
          "updated",
          [
            {
              field: "payment",
              from: `${formatMoney({ minor: found.minor, currency: found.currency })} on ${found.paidOn}`,
              to: null,
            },
            ...(reissued ? [{ field: "state", from: "done", to: owing }] : []),
          ],
          now,
        );
        if (found.originKey.startsWith(BANK_CREDIT_ORIGIN))
          yield* reopenCredit(
            orgId,
            found.originKey.slice(BANK_CREDIT_ORIGIN.length).split(":")[0]!,
            now,
          );
        const updated = yield* byId(orgId, row.recordId).pipe(provideSql);
        if (updated === undefined) return yield* unavailable;
        return updated;
      }),
    );
  });

  /**
   * A card's payment from a Bank transactions credit taken back: the credit is Unexplained again,
   * written as Kin's own. The voided payment keeps that pair from being offered again
   * (`invoiceCredits.ts`).
   */
  const reopenCredit = Effect.fn("KinRecords.reopenCredit")(function* (
    orgId: KinOrgId,
    bankRecordId: string,
    now: number,
  ) {
    const def = yield* findBankList(orgId).pipe(provideSql);
    const bank = yield* byId(orgId, bankRecordId).pipe(provideSql);
    if (def === undefined || bank === undefined || bank.registerId !== def.id) return;
    const states = bankStates(def);
    if (bank.state !== states.explained) return;
    const rev = bank.rev + 1;
    yield* sql`UPDATE kin_records SET rev = ${rev}, updated_at = ${now}, state = ${states.open},
        category = NULL, closed_at = NULL
      WHERE org_id = ${orgId} AND record_id = ${bank.recordId}`;
    yield* logChange(
      orgId,
      { actor: { _tag: "system" }, via: "import" },
      { recordId: bank.recordId, key: bank.key, rev },
      "updated",
      [
        { field: "state", from: bank.state, to: states.open },
        ...(bank.category === null ? [] : [{ field: "category", from: bank.category, to: null }]),
      ],
      now,
    );
  });

  const queryViewer = (input: QueryInput) =>
    input.team !== undefined
      ? viewerOfPeople([input.team])
      : input.view === undefined
        ? undefined
        : viewerOfPeople(input.view);

  const totals = Effect.fn("KinRecords.totals")(function* (
    orgId: KinOrgId,
    input: QueryInput,
    by?: TotalsBy,
    everyEntry?: boolean,
  ) {
    return yield* failed(
      Effect.gen(function* () {
        const now = input.at ?? (yield* Clock.currentTimeMillis);
        const home = yield* homeCurrency(orgId).pipe(provideSql);
        const filter =
          everyEntry === true
            ? filterOf(orgId, input, now)
            : sql.and([filterOf(orgId, input, now), sql`r.amount_minor IS NOT NULL`]);
        // A void entry's amount is no money: a total leaves it out unless the filter names it.
        const asked = input.states ?? (input.open === false ? ["done", "dropped"] : undefined);
        const viewer = queryViewer(input);
        const checkAccess =
          viewer !== undefined && !TEAM_LIST_RESERVED.includes(input.list ?? "work");
        const hidden = checkAccess
          ? sql`, MAX(CASE WHEN ${legacySeenBy(sql, viewer)} THEN 0 ELSE 1 END) AS hidden`
          : sql``;
        const [count] = yield* sql<{ n: number; hidden?: number }>`SELECT COUNT(*) AS n${hidden}
          FROM kin_records r WHERE ${filter} AND ${countedEntry(sql, asked)}`;
        const counted = count?.n ?? 0;
        if (count?.hidden === 1) return { total: [], counted, withheld: true } satisfies Totals;
        if (counted > TOTALS_CAP)
          return yield* invalid(
            `${counted} entries match; narrow it to under ${TOTALS_CAP} by dates or category to total them.`,
          );
        const windowed = input.paidFrom !== undefined || input.paidTo !== undefined;
        const live = sql`FROM kin_record_payments p WHERE p.org_id = r.org_id
          AND p.record_id = r.record_id AND p.voided_at IS NULL`;
        const rows = yield* sql<{
          minor: number | null;
          currency: string;
          category: string | null;
          party: string | null;
          project: string | null;
          side: string;
          state: KinRecordState;
          owner: string;
          at: number;
          paid: number;
          received: number;
          fields: string;
          legacy?: number;
        }>`SELECT r.amount_minor AS minor, r.currency, r.category, r.party_id AS party,
            r.project_id AS project, r.side, r.state, r.owner_kind || ':' || r.owner_id AS owner,
            ${moneyDay(sql)} AS at,
            (SELECT COALESCE(SUM(p.amount_minor), 0) ${live}) AS paid,
            (SELECT COALESCE(SUM(p.amount_minor), 0) ${live} AND p.withheld = 0
              AND p.paid_on >= ${input.paidFrom ?? "0000-00-00"}
              AND p.paid_on <= ${input.paidTo ?? "9999-12-31"}) AS received,
            r.fields_json AS fields${checkAccess ? sql`, ${legacySeenBy(sql, viewer)} AS legacy` : sql``}
          FROM kin_records r WHERE ${filter} AND ${countedEntry(sql, asked)}
          ORDER BY r.record_id`;
        if (checkAccess && rows.some((row) => row.legacy !== 1))
          return { total: [], counted, withheld: true } satisfies Totals;
        const listDef = yield* resolveList(orgId, input.list ?? "work");
        const paidOverTime = listDef.payments === true;
        const directed = (yield* findBankList(orgId).pipe(provideSql))?.id === listDef.id;
        const amounts = (members: typeof rows): Sums => {
          const priced = members.flatMap((row) =>
            row.minor === null ? [] : [{ ...row, minor: row.minor }],
          );
          // Money in and out never add up to one figure; an entry with no direction is in neither.
          const way = directed ? priced.map((row) => directionOf(parseFields(row.fields))) : [];
          const side = (direction: "credit" | "debit") =>
            addUp(
              priced.filter((_, at) => way[at] === direction),
              home,
            );
          return {
            total: addUp(priced, home),
            ...(directed
              ? {
                  moneyIn: side("credit"),
                  moneyOut: side("debit"),
                  net: addUp(
                    priced.flatMap((row, at) =>
                      way[at] === null
                        ? []
                        : [way[at] === "debit" ? { ...row, minor: -row.minor } : row],
                    ),
                    home,
                  ),
                }
              : {}),
            ...(paidOverTime
              ? {
                  owed: addUp(
                    priced
                      .filter((row) => owesIn(listDef, row.state) && row.minor > row.paid)
                      .map((row) => ({ minor: row.minor - row.paid, currency: row.currency })),
                    home,
                  ),
                }
              : {}),
            ...(listDef.id === "quotes"
              ? {
                  sent: addUp(
                    priced.filter((row) => row.state === "waiting"),
                    home,
                  ),
                  accepted: addUp(
                    priced.filter((row) => row.state === "done"),
                    home,
                  ),
                }
              : {}),
            ...(windowed
              ? {
                  received: addUp(
                    priced
                      .filter((row) => row.received > 0)
                      .map((row) => ({ minor: row.received, currency: row.currency })),
                    home,
                  ),
                }
              : {}),
          };
        };
        const total = amounts(rows);
        if (by === undefined) return { ...total, counted } satisfies Totals;
        const zone =
          by === "month" || by === "financialYear"
            ? yield* ownerZone(orgId).pipe(provideSql)
            : "UTC";
        const startMonth =
          by === "financialYear"
            ? (yield* companyMoney(orgId).pipe(provideSql)).financialYearStartMonth
            : 1;
        const keyOf = (row: (typeof rows)[number]): string | null =>
          by === "month"
            ? monthOf(dayIn(row.at, zone))
            : by === "financialYear"
              ? financialYearOf(dayIn(row.at, zone), startMonth)
              : by === "party"
                ? row.party
                : by === "owner"
                  ? row.owner
                  : row[by];
        const grouped = new Map<string | null, Array<(typeof rows)[number]>>();
        for (const row of rows) {
          const group = keyOf(row);
          const members = grouped.get(group);
          if (members === undefined) grouped.set(group, [row]);
          else members.push(row);
        }
        const groups = [...grouped].map(([group, members]) => ({
          group,
          count: members.length,
          ...amounts(members),
        }));
        // Periods read in time order; anything else most entries first.
        const ordered =
          by === "month" || by === "financialYear"
            ? groups.toSorted((a, b) => ((a.group ?? "") < (b.group ?? "") ? -1 : 1))
            : groups.toSorted(
                (a, b) => b.count - a.count || ((a.group ?? "") < (b.group ?? "") ? -1 : 1),
              );
        return { ...total, counted, groups: ordered.slice(0, 50) } satisfies Totals;
      }).pipe(
        Effect.catchDefect((defect) =>
          defect instanceof RangeError
            ? Effect.fail(invalid("Those totals are too large to add up exactly."))
            : Effect.die(defect),
        ),
      ),
    );
  });

  const filterOf = (orgId: KinOrgId, input: QueryInput, now: number) => {
    const where = [sql`r.org_id = ${orgId}`, sql`r.register_id = ${input.list ?? "work"}`];
    if (input.team !== undefined) where.push(personSees(sql, input.team));
    if (input.view !== undefined) where.push(viewSees(sql, input.view));
    if (input.withoutSensitive === true) where.push(sql`NOT ${keyWithheld(sql)}`);
    if (input.partyId !== undefined) where.push(sql`r.party_id IS ${input.partyId}`);
    if (input.projectId !== undefined) where.push(sql`r.project_id = ${input.projectId}`);
    if (input.repo !== undefined) where.push(sql`lower(r.repo) = lower(${input.repo})`);
    if (input.owner !== undefined)
      where.push(
        input.orAlsoOn === true && input.owner._tag === "person"
          ? sql`((r.owner_kind = 'person' AND r.owner_id = ${input.owner.personId})
              OR ${alsoOnIt(sql, input.owner.personId)})`
          : sql`r.owner_kind = ${input.owner._tag} AND r.owner_id = ${principalId(input.owner)}`,
      );
    if (input.states !== undefined && input.states.length > 0)
      where.push(sql`r.state IN ${sql.in(input.states)}`);
    else if (input.open === true) where.push(sql`r.state NOT IN ('done', 'dropped')`);
    else if (input.open === false) where.push(sql`r.state IN ('done', 'dropped')`);
    // As a figure: an invoice falls due by its terms too, as Overdue counts it (`invoiceDue`).
    if (input.late === true && input.kept === true && input.list === "invoices")
      where.push(sql`${invoiceDue(sql)} < ${now} AND r.state NOT IN ('done', 'dropped')`);
    else if (input.late === true)
      where.push(sql`r.due_at < ${now} AND r.state NOT IN ('done', 'dropped')`);
    else if (input.late === false)
      where.push(sql`(r.due_at IS NULL OR r.due_at >= ${now} OR r.state IN ('done', 'dropped'))`);
    if (input.dueBy !== undefined) where.push(sql`r.due_at <= ${input.dueBy}`);
    if (input.dueAfter !== undefined) where.push(sql`r.due_at >= ${input.dueAfter}`);
    if (input.dateFrom !== undefined) where.push(sql`${moneyDay(sql)} >= ${input.dateFrom}`);
    if (input.dateTo !== undefined) where.push(sql`${moneyDay(sql)} < ${input.dateTo}`);
    if (input.category !== undefined) where.push(sql`r.category IS ${input.category}`);
    // The tile's own rule (`moneyViews` spent): money that left the company's accounts.
    if (input.spent !== undefined)
      where.push(sql`(r.state = 'done' AND ${countedEntry(sql)} AND r.amount_minor IS NOT NULL
        AND ${companyCashOut(sql)}
        AND CASE WHEN ${partnerRepaidDay(sql)} IS NOT NULL
          THEN ${partnerRepaidDay(sql)} BETWEEN ${input.spent.from} AND ${input.spent.to}
          ELSE ${moneyDay(sql)} >= ${input.spent.fromAt} AND ${moneyDay(sql)} < ${input.spent.toAt}
        END)`);
    if (input.paidFrom !== undefined || input.paidTo !== undefined) {
      const viewer = queryViewer(input);
      if (viewer !== undefined) where.push(listMoneySeenBy(sql, viewer));
      where.push(sql`EXISTS (SELECT 1 FROM kin_record_payments p
        WHERE p.org_id = r.org_id AND p.record_id = r.record_id AND p.voided_at IS NULL
          AND p.paid_on >= ${input.paidFrom ?? "0000-00-00"}
          AND p.paid_on <= ${input.paidTo ?? "9999-12-31"})`);
    }
    if (input.kept === true) where.push(countedEntry(sql, input.states));
    else if (input.kept === false) where.push(sql`NOT ${keptEntry(sql)} AND r.state <> 'dropped'`);
    if (input.side !== undefined) where.push(sql`r.side = ${input.side}`);
    if (input.keys !== undefined && input.keys.length > 0)
      where.push(sql`r.key IN ${sql.in(input.keys)}`);
    if (input.closedAfter !== undefined) where.push(sql`r.closed_at >= ${input.closedAfter}`);
    const text = input.text?.trim().toLowerCase();
    if (text !== undefined && text !== "")
      where.push(sql`(instr(lower(r.title), ${text}) > 0 OR instr(lower(r.notes), ${text}) > 0)`);
    return sql.and(where);
  };

  const query = Effect.fn("KinRecords.query")(function* (orgId: KinOrgId, input: QueryInput) {
    return yield* failed(
      Effect.gen(function* () {
        const now = input.at ?? (yield* Clock.currentTimeMillis);
        // The number is read first: a change landing during the read then reads as newer.
        const seq =
          input.team === undefined
            ? yield* latestSeq(orgId).pipe(provideSql)
            : yield* teamSeq(orgId, input.team).pipe(provideSql);
        const filter = filterOf(orgId, input, now);
        const [count] = yield* sql<{ total: number }>`SELECT COUNT(*) AS total FROM kin_records r
          WHERE ${filter}`;
        const limit = Math.min(Math.max(input.limit ?? 50, 1), KIN_RECORDS_PAGE_CAP);
        // Work by what is under way and due; a directory of clients or projects by name; a defined
        // list open and soonest due first, then newest.
        const list = input.list ?? "work";
        const order =
          input.order === "dueFirst"
            ? sql`r.due_at IS NULL, r.due_at, r.created_at, r.key`
            : list === "work"
              ? sql`CASE r.state WHEN 'doing' THEN 0 WHEN 'waiting' THEN 1 WHEN 'open' THEN 2
                ELSE 3 END, r.due_at IS NULL, r.due_at, r.created_at, r.key`
              : isBuiltIn(list)
                ? sql`r.state IN ('done', 'dropped'), lower(r.title), r.key`
                : sql`r.state IN ('done', 'dropped'), r.due_at IS NULL, r.due_at,
                  ${moneyDay(sql)} DESC, r.created_at DESC, r.key`;
        const viewer = queryViewer(input);
        const extra =
          viewer === undefined || TEAM_LIST_RESERVED.includes(list)
            ? sql``
            : sql`, ${listMoneySeenBy(sql, viewer)} AS "listMoneyVisible"`;
        const rows = yield* sql<RecordRow>`${selectRecords(sql, extra)} WHERE ${filter}
          ORDER BY ${order}
          LIMIT ${limit} OFFSET ${Math.max(input.offset ?? 0, 0)}`;
        return { rows, total: count?.total ?? 0, seq };
      }),
    );
  });

  const moveRows = Effect.fn("KinRecords.moveRows")(function* (orgId: KinOrgId, input: QueryInput) {
    return yield* failed(
      Effect.gen(function* () {
        const now = input.at ?? (yield* Clock.currentTimeMillis);
        return yield* sql<MoveRow>`SELECT r.record_id AS "recordId", r.key, r.state,
            r.owner_kind AS "ownerKind", r.owner_id AS "ownerId",
            r.waiting_on_kind AS "waitingOnKind", r.waiting_on_id AS "waitingOnId",
            r.due_at AS "dueAt", r.confirmed,
            COALESCE(r.asked_by_person_id,
              CASE WHEN r.created_by_kind = 'person' THEN r.created_by_id END,
              r.assigned_by_person_id) AS "askedBy",
            r.assigned_by_person_id AS "assignedBy", r.assigned_by_agent_id AS "assignedByAgent",
            r.created_at AS "createdAt", r.updated_at AS "updatedAt",
            CASE WHEN r.state IN ('done', 'dropped') THEN NULL ELSE r.handed_back_at END
              AS "handedBackAt", r.urgent,
            CASE WHEN r.register_id = 'work' THEN json_extract(r.fields_json, '$.alsoOn') END
              AS "alsoOn"
          FROM kin_records r WHERE ${filterOf(orgId, input, now)}
          ORDER BY r.record_id LIMIT ${MOVE_ROWS_CAP}`;
      }),
    );
  });

  const groups = Effect.fn("KinRecords.groups")(function* (
    orgId: KinOrgId,
    input: QueryInput,
    by: GroupBy,
  ) {
    return yield* failed(
      Effect.gen(function* () {
        const now = input.at ?? (yield* Clock.currentTimeMillis);
        const column =
          by === "party"
            ? sql`r.party_id`
            : by === "project"
              ? sql`r.project_id`
              : by === "side"
                ? sql`r.side`
                : by === "state"
                  ? sql`r.state`
                  : by === "category"
                    ? sql`r.category`
                    : sql`r.owner_kind || ':' || r.owner_id`;
        const rows = yield* sql<{ group: string | null; count: number; late: number | null }>`
          SELECT ${column} AS "group", COUNT(*) AS count,
            SUM(r.due_at IS NOT NULL AND r.due_at < ${now}
              AND r.state NOT IN ('done', 'dropped')) AS late
          FROM kin_records r WHERE ${filterOf(orgId, input, now)}
          GROUP BY 1 ORDER BY COUNT(*) DESC, 1 LIMIT 50`;
        return rows.map((row) => ({ group: row.group, count: row.count, late: row.late ?? 0 }));
      }),
    );
  });

  return KinRecords.of({
    create,
    createImportChunk,
    update: updateFollowing,
    principalExists: Effect.fn("KinRecords.principalExists")(function* (orgId, who, role) {
      return yield* failed(ownerExists(orgId, who, role));
    }),
    handBack,
    link,
    unlink,
    pay,
    voidPayment,
    totals,
    query,
    moveRows,
    groups,
    get: Effect.fn("KinRecords.get")(function* (orgId, key) {
      return yield* failed(byKey(orgId, key).pipe(provideSql));
    }),
    getById: Effect.fn("KinRecords.getById")(function* (orgId, recordId) {
      return yield* failed(byId(orgId, recordId).pipe(provideSql));
    }),
    detail: Effect.fn("KinRecords.detail")(function* (row, changeLimit) {
      const now = yield* Clock.currentTimeMillis;
      return yield* failed(
        Effect.gen(function* () {
          const detail = yield* toDetail(row, now, changeLimit);
          const [record] = yield* sql<{ askedBy: string | null }>`SELECT
              asked_by_person_id AS "askedBy" FROM kin_records
            WHERE org_id = ${row.orgId} AND record_id = ${row.recordId}`;
          const seqs = detail.changes.map((change) => change.seq);
          const through = new Map(
            seqs.length === 0
              ? []
              : (yield* sql<{ seq: number; askedBy: string | null; codingAgent: string | null }>`
                  SELECT seq, asked_by_person_id AS "askedBy",
                    ${sql.literal(CODING_AGENT_NAME("kin_record_changes"))} AS "codingAgent"
                  FROM kin_record_changes
                  WHERE org_id = ${row.orgId} AND record_id = ${row.recordId}
                    AND seq IN ${sql.in(seqs)}
                    AND (asked_by_person_id IS NOT NULL OR coding_agent_key IS NOT NULL)
                  ORDER BY seq`).map((one) => [one.seq, one] as const),
          );
          const page = yield* commentsPage(row.orgId as KinOrgId, row.recordId);
          return {
            ...detail,
            changes: detail.changes.map((change) => {
              const one = through.get(change.seq);
              return one === undefined
                ? change
                : {
                    ...change,
                    ...(one.askedBy === null ? {} : { askedBy: KinPersonId.make(one.askedBy) }),
                    ...(one.codingAgent === null ? {} : { codingAgent: one.codingAgent }),
                  };
            }),
            ...(record?.askedBy == null ? {} : { askedBy: KinPersonId.make(record.askedBy) }),
            comments: page.comments,
            olderComments: page.older,
          };
        }).pipe(provideSql),
      );
    }),
    commented: Effect.fn("KinRecords.commented")(
      function* (orgId, personId, row, commentSeq, note) {
        const now = yield* Clock.currentTimeMillis;
        const writer: Writer = {
          actor: { _tag: "person", personId },
          via: "owner",
          askedBy: personId,
        };
        return yield* wakeLead(
          orgId,
          writer,
          row,
          principal(row.ownerKind, row.ownerId) ?? { _tag: "person", personId },
          personId,
          commentSeq,
          now,
          "commented",
          note.length > 280 ? `${note.slice(0, 279)}…` : note,
        ).pipe(
          // A teammate whose agent this no longer is still comments; the agent just isn't woken.
          Effect.catchTags({ KinChatError: () => Effect.succeed(false) }),
        );
      },
      (effect) => failed(effect),
    ),
    seq: Effect.fn("KinRecords.seq")(function* (orgId) {
      return yield* failed(latestSeq(orgId).pipe(provideSql));
    }),
    changes: (orgId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(ticks);
          const now = yield* failed(latestSeq(orgId).pipe(provideSql));
          const first: Tick = { seq: now };
          return Stream.concat(
            Stream.make(first),
            Stream.fromEffectRepeat(PubSub.take(subscription)).pipe(
              Stream.filter((tick) => tick.orgId === orgId),
              Stream.map(({ orgId: _orgId, ...tick }): Tick => tick),
            ),
          );
        }),
      ),
    attachClosing: Effect.fn("KinRecords.attachClosing")(function* (handler) {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          closing = handler;
        }),
        () =>
          Effect.sync(() => {
            if (closing === handler) closing = undefined;
          }),
      );
    }),
    // Nested in the caller's transaction when there is one, so every tick waits for the outermost
    // commit (screens read on readers) and a rollback tells no one.
    announce: Effect.fn("KinRecords.announce")(function* (orgId, recordIds) {
      const moved =
        recordIds === undefined
          ? undefined
          : recordIds.length === 0
            ? []
            : yield* failed(
                sql<{ recordId: string; key: string; registerId: string }>`SELECT
                    record_id AS "recordId", key, register_id AS "registerId" FROM kin_records
                  WHERE org_id = ${orgId} AND record_id IN ${sql.in([...new Set(recordIds)])}
                  ORDER BY key`,
              );
      if (moved?.length === 0) return;
      // A number no change will take, past every one a client heard: an undo's entries took their
      // changes with them, and clients read again only past what they already hold.
      const [taken] = yield* failed(
        sql<{ seq: number }>`UPDATE sqlite_sequence SET seq = seq + 1
          WHERE name = 'kin_record_changes' RETURNING seq`,
      );
      const seq = taken?.seq ?? (yield* failed(latestSeq(orgId).pipe(provideSql)));
      if (moved !== undefined) {
        // Only who sees these entries hears of them, each at their own next number.
        const pairs = yield* failed(
          teamPairs(
            orgId,
            moved.map((one) => one.recordId),
          ).pipe(provideSql),
        );
        const numbers = yield* failed(
          bumpTeamSeqs(orgId, [...new Set(pairs.map((pair) => pair.personId))]).pipe(provideSql),
        );
        for (const one of moved) {
          const team = new Map<string, number>();
          for (const pair of pairs) {
            const number = numbers.get(pair.personId);
            if (pair.recordId === one.recordId && number !== undefined)
              team.set(pair.personId, number);
          }
          yield* sql.afterCommit(
            PubSub.publish(ticks, { orgId, seq, key: one.key, registerId: one.registerId, team }),
          );
        }
        return;
      }
      // Anyone's view may have moved, so every teammate's own number moves too: one who resumes
      // later is behind, not told nothing changed.
      const everyone = yield* failed(
        sql<{ personId: string }>`SELECT person_id AS "personId" FROM kin_people
          WHERE org_id = ${orgId}`,
      );
      const team = yield* failed(
        bumpTeamSeqs(
          orgId,
          everyone.map((one) => one.personId),
        ).pipe(provideSql),
      );
      yield* sql.afterCommit(PubSub.publish(ticks, { orgId, seq, team }));
    }, transaction),
    peopleMoved: Effect.fn("KinRecords.peopleMoved")(function* (orgId, personIds) {
      if (personIds.length === 0) return;
      const team = yield* failed(bumpTeamSeqs(orgId, personIds).pipe(provideSql));
      const seq = yield* failed(latestSeq(orgId).pipe(provideSql));
      yield* sql.afterCommit(PubSub.publish(ticks, { orgId, seq, team, people: personIds }));
    }),
  });
});

export const layer = Layer.effectContext(
  make.pipe(
    Effect.map((records) =>
      Context.make(KinRecords, records).pipe(
        Context.add(KinWorkRefresh, (orgId) => records.announce(orgId)),
      ),
    ),
  ),
);
