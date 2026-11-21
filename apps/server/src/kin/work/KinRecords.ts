// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@t3tools/shared/relaySigning";
import {
  KIN_RECORDS_PAGE_CAP,
  KIN_TEXT_LOCALE,
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

import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import type { ClosedSubject } from "../open/closeSubject.ts";
import { hashedEventId } from "../lead/eventIds.ts";
import { KinEventQueue } from "../lead/KinEventQueue.ts";
import { teammatesLimited } from "../lead/KinBudget.ts";
import * as LeadAccess from "../lead/LeadAccess.ts";
import * as Reach from "../lead/Reach.ts";
import { ownerLevel, ownerLevelAsked, ownsAgent } from "../people/KinAccess.ts";
import { codingAgentSource, outsideStamp, stampEvent } from "../lead/OutsideContent.ts";
import { companyMoney, countryFirst, homeCurrency } from "./companyProfile.ts";
import { commentsPage } from "./recordComments.ts";
import { indexRecord } from "./searchIndex.ts";
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
} from "./lists.ts";
import { addUp, dayIn, financialYearOf, formatMoney, isCurrency, monthOf } from "./money.ts";
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
  keySensitive,
  sensitiveNow,
  type StoredRepeat,
  toDetail,
  toRecord,
  unavailable,
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
import { cleanTags } from "./tags.ts";
import { anchorOf, nextDates } from "./repeat.ts";
import {
  bumpTeamSeqs,
  dependents,
  teamGuard,
  crmSees,
  teamPairs,
  personSees,
  ROOM_LISTS,
  teamSeesField,
  teamSeq,
  viewGuard,
  viewReadsWhole,
  viewSees,
} from "./teamView.ts";

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
  /**
   * The person's own coding agent, with this key: the write reaches only a Work task that person
   * holds now, whatever their level, and its history names the key.
   */
  readonly codingAgentKey?: string;
  /** Shared with the team when made; a turn others read shares its tasks too (`ROOM_LISTS`). */
  readonly teamShared?: boolean;
  /** A lead's turn others read: `viewGuard` decides the write inside its transaction. */
  // oxlint-disable-next-line t3code/kin-viewer-scoped-reads -- a write's guard, not a read; absent is an owner-level writer.
  readonly view?: {
    readonly people: ReadonlyArray<KinPersonId>;
    readonly askers: ReadonlyArray<KinPersonId>;
  };
  /** The cards a person's tap settles itself: closing the entry leaves them to the tap. */
  readonly answering?: ReadonlyArray<string>;
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
/** A Work task this writer, a person, holds now and nobody dropped. */
const heldBy = (
  row: {
    readonly registerId: string;
    readonly ownerKind: string;
    readonly ownerId: string;
    readonly state: KinRecordState;
  },
  writer: Writer,
) =>
  row.registerId === "work" &&
  row.state !== "dropped" &&
  row.ownerKind === "person" &&
  writer.actor._tag === "person" &&
  row.ownerId === writer.actor.personId;

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
  /** When it happened, was issued or starts; only defined lists. */
  readonly dateAt?: number | null;
  readonly dateAllDay?: boolean;
  /** Needs a due date or a date to repeat from; not on clients, contacts or projects. */
  readonly repeat?: KinRepeatRule | null;
};
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
export type Patch = Partial<Omit<Fields, "owner">> & {
  readonly owner?: KinWorkPrincipal;
  /** The holder gives it back to `owner`, whoever gave it to them, in their own words. */
  readonly handedBack?: { readonly note: string | null };
  /** What a field's old and new ids read as now, kept on its history line (`FieldChange.names`). */
  readonly names?: Readonly<Record<string, NonNullable<FieldChange["names"]>>>;
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
  readonly states?: ReadonlyArray<KinRecordState>;
  readonly open?: boolean;
  readonly late?: boolean;
  readonly dueBy?: number;
  readonly dueAfter?: number;
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
};
export type Totals = Sums & {
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
  due: "its due date",
  party: "its client",
};
/** What a refusal may quote of an entry that isn't sensitive; money, notes and a list's own fields it doesn't. */
const QUOTED = new Set(["title", "state", "owner", "waitingOn", "due", "date", "category", "side"]);
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
/** Whether an entry's amount or fields put money on it. */
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
  },
): KinChatError | undefined => {
  if (input.title !== undefined && mentionsKinMoney(input.title))
    return invalid(
      "A title never holds an amount: give the amount on its own and keep the title to what it was for.",
    );
  if (input.amount !== undefined && input.amount !== null) {
    if (!def.amount && def.builtIn !== "work") return invalid(`A ${def.noun} has no amount.`);
    if (!isCurrency(input.amount.currency))
      return invalid(`${input.amount.currency} is not a currency code.`);
    if (input.amount.minor < 0) return invalid("An amount never goes below zero; give 0 or more.");
  }
  // A Work meeting's start is its date; due stays what someone owes by when.
  if (
    input.dateAt !== undefined &&
    input.dateAt !== null &&
    def.builtIn !== null &&
    def.builtIn !== "work"
  )
    return invalid(`A ${def.noun} has no date of its own; use due.`);
  if (
    input.repeat !== undefined &&
    input.repeat !== null &&
    def.builtIn !== null &&
    def.builtIn !== "work"
  )
    return invalid(`A ${def.noun} doesn't repeat.`);
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
  return input.fields === undefined ? undefined : checkFields(def, input.fields);
};

/** An invoice, or a renewal on Dates, for nothing: it isn't owed, so it isn't kept as owed. */
const zeroOwed = (
  def: ListDef,
  amount: KinMoney | null | undefined,
  category: string | null | undefined,
) =>
  amount?.minor === 0 && (def.id === "invoices" || (def.id === "dates" && category === "renewal"))
    ? invalid(
        `${def.id === "invoices" ? "An invoice" : "A renewal"} for 0 isn't owed; leave the amount off or drop it.`,
      )
    : undefined;

export class KinRecords extends Context.Service<
  KinRecords,
  {
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

  const ensureRegister = Effect.fn("KinRecords.ensureRegister")(function* (
    orgId: KinOrgId,
    def: ListDef,
    now: number,
  ) {
    const take = sql<{ next: number; prefix: string }>`
      UPDATE kin_registers SET next_number = next_number + 1
      WHERE org_id = ${orgId} AND register_id = ${def.id}
      RETURNING next_number - 1 AS next, key_prefix AS prefix`;
    let [register] = yield* take;
    // A defined list's register is written when it is defined; a built-in one on first use.
    if (register === undefined && def.builtIn !== null) {
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
        VALUES (${orgId}, ${def.id}, ${def.name}, ${def.prefix}, 1, ${now})
        ON CONFLICT DO NOTHING`;
      [register] = yield* take;
    }
    if (register === undefined) return yield* unavailable;
    return `${register.prefix}-${register.next}`;
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
    const actorId =
      writer.actor._tag === "agent"
        ? writer.actor.agentId
        : writer.actor._tag === "person"
          ? writer.actor.personId
          : null;
    const [change] = yield* sql<{ seq: number }>`INSERT INTO kin_record_changes (org_id, record_id,
        rev, at, actor_kind, actor_id, via, kind, fields_json, wakeup_id, chat_id,
        asked_by_person_id, coding_agent_key)
      VALUES (${orgId}, ${row.recordId}, ${row.rev}, ${now}, ${writer.actor._tag}, ${actorId},
        ${writer.via}, ${kind}, ${yield* encodeFields(fields)}, ${writer.wakeupId ?? null},
        ${writer.chatId ?? null}, ${writer.actor._tag === "agent" ? (writer.askedBy ?? null) : null},
        ${writer.codingAgentKey ?? null})
      RETURNING seq`;
    const seq = change?.seq ?? 0;
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
  ) {
    const own = writer.actor._tag === "person" && writer.actor.personId === personId;
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
   * given to it (`assigned`, by the stored assigner), or closed or taken back while it held it
   * open (`withdrawn`, by the person who did; only its owner is told). A teammate's assignment
   * wakes it in their own direct chat with it, as a message from them would (`teammateWake`).
   */
  const wakeLead = Effect.fn("KinRecords.wakeLead")(function* (
    orgId: KinOrgId,
    writer: Writer,
    row: { readonly recordId: string; readonly key: string; readonly registerId: string },
    to: KinWorkPrincipal,
    assignedBy: KinPersonId | null,
    seq: number,
    now: number,
    reason: "assigned" | "withdrawn" | "handed_back" | "commented" = "assigned",
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
        ? yield* teammateWake(orgId, writer, to.agentId, assignedBy, now)
        : undefined;
    if (!ownsAgent(lead, assignedBy) && teammate === undefined) return false;
    const key = `record-${reason}:${row.recordId}:${seq}`;
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
          writer.codingAgentKey !== undefined
            ? sql<{ label: string }>`SELECT label FROM kin_tasks_keys
                WHERE org_id = ${orgId} AND session_id = ${writer.codingAgentKey}`.pipe(
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
  ) {
    const rows =
      who._tag === "agent"
        ? yield* sql`SELECT 1 FROM kin_leads l JOIN kin_agents a
            ON a.org_id = l.org_id AND a.agent_id = l.agent_id
            WHERE l.org_id = ${orgId} AND l.agent_id = ${who.agentId} AND a.retired_at IS NULL`
        : yield* sql`SELECT 1 FROM kin_people WHERE org_id = ${orgId} AND person_id = ${who.personId}`;
    if (rows.length === 0)
      return yield* new KinChatError({
        reason: "not_found",
        message: `No ${who._tag === "agent" ? "agent" : "person"} ${principalId(who).slice(0, 60)} here ${role}.`,
      });
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
    const [row] = yield* sql<{ key: string; partyId: string | null; state: KinRecordState }>`
      SELECT key, party_id AS "partyId", state FROM kin_records
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
                message: `A ${LISTS[list].noun} has no project.`,
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
      const error = {
        reason: "conflict" as const,
        message: `There is already a ${LISTS[list].noun} named ${title.slice(0, 80)}: ${row.key}.`,
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
   * Whether a new entry starts kept, from who makes it, in the write's transaction. Made from a
   * suggestion, or asked to be one, it is one. A quote or invoice is real only on an owner-level
   * person's word: theirs, or their ask in person of an agent. Anything else starts kept as it
   * always did, unless its caller asks for less.
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
   * One new entry, in the caller's transaction. `wake` is false for the next occurrence of a
   * repeating entry, which is owed later and is nobody's new instruction.
   */
  const insert = Effect.fn("KinRecords.insert")(function* (
    orgId: KinOrgId,
    writer: Writer,
    input: CreateInput,
    options: {
      readonly wake: boolean;
      readonly repeat?: StoredRepeat;
      /** Whose words the copied title and notes are, for an occurrence copied from another. */
      readonly authors?: { readonly title: string | null; readonly notes: string | null };
      /** Decided for it already, as for an occurrence by whoever closed the one before. */
      readonly kept?: boolean;
    },
  ) {
    const recordId = recordIdFor(orgId, input.originKey);
    const existing = yield* byId(orgId, recordId).pipe(provideSql);
    if (writer.teammate === true && writer.actor._tag === "person")
      yield* teamGuard(orgId, writer.actor.personId, {
        row: existing,
        changes: false,
        input,
      }).pipe(provideSql);
    if (writer.view !== undefined)
      yield* viewGuard(orgId, writer.view, { row: existing, changes: false, input }).pipe(
        provideSql,
      );
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
    // Before the list is read: an amount for a list not made yet waits on the country too.
    // A list that may hold money takes entries without any, such as a deadline with no fee.
    if (recordsMoney(input.amount, input.fields)) yield* countryFirst(orgId).pipe(provideSql);
    const def = yield* resolveList(orgId, input.list ?? "work");
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
    });
    if (invalidFor !== undefined) return yield* invalidFor;
    const zero = zeroOwed(def, input.amount, input.category);
    if (zero !== undefined) return yield* zero;
    if (list === "receipts" && RECEIPT_TIES.some((field) => field in fields))
      return yield* invalid(RECEIPT_TIES_ARE_KINS);
    if (writer.actor._tag !== "person" && numberingOf(def) !== undefined && "number" in fields)
      return yield* invalid(NUMBERS_ARE_ISSUED);
    if (def.builtIn === null) yield* verifyRefs(orgId, def, fields).pipe(provideSql);
    const projectId = input.projectId ?? null;
    const project = projectId === null ? undefined : yield* target(orgId, projectId, "projects");
    // An entry in a client's project is part of that client's record unless it names another.
    const partyId = input.partyId !== undefined ? input.partyId : (project?.partyId ?? null);
    const invalidRefs = checkRefs(def, partyId, projectId);
    if (invalidRefs !== undefined) return yield* invalidRefs;
    const party = partyId === null ? undefined : yield* target(orgId, partyId, "clients");
    yield* sameName(orgId, list, input.title, partyId, null, input.category, writer.namesSeenBy);
    yield* ownerExists(orgId, input.owner);
    const repeat =
      options.repeat ??
      (input.repeat === undefined || input.repeat === null
        ? undefined
        : yield* storedRepeat(orgId, input.repeat, input.dueAt ?? null, input.dateAt ?? null));
    const now = yield* Clock.currentTimeMillis;
    const key = yield* ensureRegister(orgId, def, now);
    const kept = options.kept ?? (yield* startsKept(orgId, writer, list, input));
    // Nobody issued, sent or was paid for what nobody kept: it waits as a draft on its own day.
    // Only Issue makes an invoice owed, with its number; an agent sets none, so it starts a draft.
    const state =
      (!kept && ISSUED_LISTS.has(list)) || (writer.actor._tag === "agent" && list === "invoices")
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
    const waitingOn = state === "waiting" ? (input.waitingOn ?? null) : null;
    const givenAway =
      !(writer.actor._tag === "agent" && samePrincipal(writer.actor, input.owner)) &&
      !(writer.actor._tag === "person" && samePrincipal(writer.actor, input.owner));
    const assignedBy = writer.askedBy ?? null;
    const amount = input.amount ?? null;
    const notes = input.notes ?? "";
    const author = textBy(writer);
    yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state,
        waiting_on_kind, waiting_on_id, owner_kind, owner_id, side, category, due_at, due_all_day,
        sensitive, confirmed, notes, rev, source_chat_id, source_message_id, created_by_kind,
        created_by_id, assigned_by_person_id, assigned_at, origin_key, created_at, updated_at,
        closed_at, party_id, project_id, repo, fields_json, amount_minor, currency, date_at,
        date_all_day, repeat_json, request_hash, team_shared, title_by, notes_by,
        assigned_by_agent_id, marked_by_person_id, asked_by_person_id)
      VALUES (${orgId}, ${recordId}, ${list}, ${key}, ${input.title}, ${state},
        ${waitingOn?._tag ?? null}, ${waitingOn === null ? null : principalId(waitingOn)},
        ${input.owner._tag}, ${principalId(input.owner)}, ${input.side ?? "ours"},
        ${input.category ?? null}, ${input.dueAt ?? null}, ${input.dueAllDay === true ? 1 : 0},
        ${input.sensitive === true || def.sensitive ? 1 : 0}, ${kept ? 1 : 0},
        ${notes}, 1, ${input.source?.chatId ?? null},
        ${input.source?.messageId ?? null}, ${writer.actor._tag},
        ${writer.actor._tag === "agent" ? writer.actor.agentId : writer.actor._tag === "person" ? writer.actor.personId : null},
        ${assignedBy}, ${assignedBy === null ? null : now}, ${input.originKey},
        ${input.createdAt ?? now}, ${now}, ${isClosed(state) ? (input.closedAt ?? now) : null},
        ${partyId}, ${projectId}, ${input.repo ?? null},
        ${yield* encodeFieldValues(fields)}, ${amount?.minor ?? null}, ${amount?.currency ?? null},
        ${input.dateAt ?? null}, ${input.dateAllDay === true ? 1 : 0},
        ${repeat === undefined ? null : yield* encodeRepeat(repeat)}, ${input.requestHash ?? null},
        ${input.team === true || writer.teammate === true || writer.teamShared === true || (writer.view !== undefined && (ROOM_LISTS as ReadonlyArray<string>).includes(list)) ? 1 : 0},
        ${options.authors === undefined ? author : options.authors.title},
        ${notes === "" ? null : options.authors === undefined ? author : options.authors.notes},
        ${givenAway && writer.actor._tag === "agent" && writer.askedBy == null ? writer.actor.agentId : null},
        ${input.sensitive === true ? textBy(writer) : null}, ${textBy(writer)})`;
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
      ...Object.entries(fields).map(([field, value]) => ({
        field,
        from: null,
        to: shownField(value),
      })),
    ];
    const seq = yield* logChange(orgId, writer, { recordId, key, rev: 1 }, "created", changes, now);
    yield* choicesMoved(orgId, def.id);
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
    if (givenAway && options.wake)
      yield* wakeLead(
        orgId,
        writer,
        { recordId, key, registerId: list },
        input.owner,
        assignedBy,
        seq,
        now,
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
        if (writer.codingAgentKey !== undefined && !heldBy(row, writer))
          return yield* notFound(key);
        if (writer.teammate === true && writer.actor._tag === "person")
          yield* teamGuard(orgId, writer.actor.personId, {
            row,
            changes: true,
            input: patch,
          }).pipe(provideSql);
        if (writer.view !== undefined)
          yield* viewGuard(orgId, writer.view, { row, changes: true, input: patch }).pipe(
            provideSql,
          );
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
        });
        if (invalidFor !== undefined) return yield* invalidFor;
        if (recordsMoney(patch.amount, patch.fields))
          yield* countryFirst(orgId, { saved: true }).pipe(provideSql);
        const zero = zeroOwed(def, patch.amount, patch.category ?? row.category);
        if (zero !== undefined) return yield* zero;
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
        if (partyId !== row.partyId) {
          const party = partyId === null ? null : yield* target(orgId, partyId, "clients");
          changes.push({ field: "party", from: row.partyKey, to: party?.key ?? null });
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
        const merged: Record<string, FieldValue> = { ...stored };
        let fieldsChanged = false;
        for (const [field, value] of Object.entries(patch.fields ?? {})) {
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
        if (fieldsChanged) set("fields_json", yield* encodeFieldValues(merged));
        const amount = amountOf(row) ?? null;
        const byOwner = writer.via === "owner";
        const amountChanged =
          patch.amount !== undefined &&
          (patch.amount?.minor !== amount?.minor || patch.amount?.currency !== amount?.currency);
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
        // An agent never issues or settles an invoice by its state: Issue gives it its number.
        const unissued =
          writer.actor._tag === "agent" &&
          list === "invoices" &&
          !isSuggestion(row) &&
          (wanted === "waiting" || wanted === "done") &&
          wanted !== row.state &&
          (yield* sql`SELECT 1 FROM kin_issued_numbers
            WHERE org_id = ${orgId} AND record_id = ${row.recordId} LIMIT 1`).length === 0;
        const state = unissued ? row.state : wanted;
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
          const open = yield* sql<{ key: string }>`SELECT key FROM kin_records
            WHERE org_id = ${orgId} AND (party_id = ${row.recordId} OR project_id = ${row.recordId})
              AND register_id IN ('work', 'projects') AND state NOT IN ${sql.in(CLOSED)}
            ORDER BY created_at, key`;
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
          if (isClosed(state) && row.handedBackAt !== null) {
            set("handed_back_kind", null);
            set("handed_back_id", null);
            set("handed_back_at", null);
          }
        }
        const waitingOn =
          state !== "waiting"
            ? null
            : patch.waitingOn !== undefined
              ? patch.waitingOn
              : before.waitingOn;
        if (waitingOn !== null && !samePrincipal(waitingOn, before.waitingOn))
          yield* ownerExists(orgId, waitingOn, "to wait on");
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
          // Handed back, it says so on the giver's row until it is given again or closed.
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
        if (patch.notes !== undefined && patch.notes !== row.notes) {
          changes.push({ field: "notes", from: row.notes, to: patch.notes });
          set("notes", patch.notes);
          set("notes_by", patch.notes === "" ? null : (author ?? row.notesBy));
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
        // Who saw what before this change, for who it moves: the entry, and what a client's or
        // project's label, client, lead or people show or hide.
        const scope = [
          row.recordId,
          ...((list === "clients" || list === "projects") &&
          (patch.sensitive !== undefined ||
            patch.partyId !== undefined ||
            patch.owner !== undefined ||
            (list === "projects" && patch.fields?.["members"] !== undefined))
            ? yield* dependents(orgId, row.recordId).pipe(provideSql)
            : []),
        ];
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
        else if (reassigned !== undefined)
          yield* wakeLead(orgId, writer, row, reassigned, writer.askedBy ?? null, seq, now);
        if (reopened || undoneFor)
          yield* wakeLead(orgId, writer, row, before.owner, writer.askedBy ?? null, seq, now);
        // A lead never keeps working an open entry a person closed or took from it.
        const withdrawnFrom: Principal | undefined =
          !isClosed(row.state) && (isClosed(state) || reassigned !== undefined)
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
        const updated = yield* byId(orgId, row.recordId).pipe(provideSql);
        if (updated === undefined) return yield* unavailable;
        if (!isClosed(row.state) && isClosed(updated.state))
          yield* spawnNext(orgId, writer, updated);
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
        const row = yield* byKey(orgId, key).pipe(provideSql);
        if (row === undefined) return yield* notFound(key);
        const [found] = yield* sql<{
          minor: number;
          currency: string;
          paidOn: string;
          voidedAt: number | null;
        }>`
          SELECT amount_minor AS minor, currency, paid_on AS "paidOn", voided_at AS "voidedAt"
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
        const updated = yield* byId(orgId, row.recordId).pipe(provideSql);
        if (updated === undefined) return yield* unavailable;
        return updated;
      }),
    );
  });

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
        const [count] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_records r
          WHERE ${filter} AND ${countedEntry(sql, asked)}`;
        const counted = count?.n ?? 0;
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
        }>`SELECT r.amount_minor AS minor, r.currency, r.category, r.party_id AS party,
            r.project_id AS project, r.side, r.state, r.owner_kind || ':' || r.owner_id AS owner,
            ${moneyDay(sql)} AS at,
            (SELECT COALESCE(SUM(p.amount_minor), 0) ${live}) AS paid,
            (SELECT COALESCE(SUM(p.amount_minor), 0) ${live} AND p.withheld = 0
              AND p.paid_on >= ${input.paidFrom ?? "0000-00-00"}
              AND p.paid_on <= ${input.paidTo ?? "9999-12-31"}) AS received
          FROM kin_records r WHERE ${filter} AND ${countedEntry(sql, asked)}
          ORDER BY r.record_id`;
        const listDef = yield* resolveList(orgId, input.list ?? "work");
        const paidOverTime = listDef.payments === true;
        const amounts = (members: typeof rows): Sums => {
          const priced = members.flatMap((row) =>
            row.minor === null ? [] : [{ ...row, minor: row.minor }],
          );
          return {
            total: addUp(priced, home),
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
    if (input.withoutSensitive === true) where.push(sql`NOT ${keySensitive(sql)}`);
    if (input.partyId !== undefined) where.push(sql`r.party_id IS ${input.partyId}`);
    if (input.projectId !== undefined) where.push(sql`r.project_id = ${input.projectId}`);
    if (input.repo !== undefined) where.push(sql`lower(r.repo) = lower(${input.repo})`);
    if (input.owner !== undefined)
      where.push(
        sql`r.owner_kind = ${input.owner._tag} AND r.owner_id = ${principalId(input.owner)}`,
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
    if (input.paidFrom !== undefined || input.paidTo !== undefined)
      where.push(sql`EXISTS (SELECT 1 FROM kin_record_payments p
        WHERE p.org_id = r.org_id AND p.record_id = r.record_id AND p.voided_at IS NULL
          AND p.paid_on >= ${input.paidFrom ?? "0000-00-00"}
          AND p.paid_on <= ${input.paidTo ?? "9999-12-31"})`);
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
        const rows = yield* sql<RecordRow>`${selectRecords(sql)} WHERE ${filter}
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
            r.created_at AS "createdAt"
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
    update,
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

export const layer = Layer.effect(KinRecords, make);
