import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  KinAgentId,
  KinChatError,
  KinChatId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinText,
  KinTrimmedText,
} from "./kinChat.ts";
import {
  KinDay,
  KinFieldValue,
  KinFileRef,
  KinListFieldKey,
  KinListId,
  KinMoney,
  KinMoneyTotals,
  KinPayment,
  KinRepeatRule,
} from "./kinMoney.ts";

/**
 * Work: everything someone owes someone, as entries in lists. Built in: Work, and the light CRM's
 * clients (and vendors), their contacts and projects. Owner-only reads and writes; amounts later.
 */
export const KinRecordId = TrimmedNonEmptyString.pipe(Schema.brand("KinRecordId"));
export type KinRecordId = typeof KinRecordId.Type;
/** The short handle leads cite and people see small, such as `W-142`. Server-issued per list. */
export const KinRecordKey = Schema.String.check(
  Schema.isPattern(/^[A-Z][A-Z0-9]{0,7}-[1-9]\d{0,8}$/),
);
export type KinRecordKey = typeof KinRecordKey.Type;

/** Five fixed classes; a list may rename their labels later, never add one. */
const KIN_RECORD_STATES = ["open", "doing", "waiting", "done", "dropped"] as const;
export const KinRecordState = Schema.Literals(KIN_RECORD_STATES);
export type KinRecordState = typeof KinRecordState.Type;
/** The Work list's kinds: one field, so a request that turns out to be a bug keeps its key. */
export const KinRecordCategory = Schema.Literals(["task", "issue", "obligation"]);
export type KinRecordCategory = typeof KinRecordCategory.Type;
/** Who has to do it: `theirs` when the other party owes it and the owner is whoever chases. */
export const KinRecordSide = Schema.Literals(["ours", "theirs"]);
export type KinRecordSide = typeof KinRecordSide.Type;

/** An owner, assigner or the one waited on: a person or a lead, always someone on our side. */
export const KinWorkPrincipal = Schema.Union([
  Schema.TaggedStruct("person", { personId: KinPersonId }),
  Schema.TaggedStruct("agent", { agentId: KinAgentId }),
]);
export type KinWorkPrincipal = typeof KinWorkPrincipal.Type;
/** Who made a change: a principal, or Kin itself from a worker or GitHub event. */
export const KinWorkActor = Schema.Union([
  ...KinWorkPrincipal.members,
  Schema.TaggedStruct("system", {}),
]);
export type KinWorkActor = typeof KinWorkActor.Type;

const KinPullRequestRef = Schema.Struct({ url: Schema.String, number: NonNegativeInt });

/** The built-in lists. Only `work` entries are tasks; the other three are the light CRM. */
export const KinWorkListName = Schema.Literals(["work", "clients", "contacts", "projects"]);
export type KinWorkListName = typeof KinWorkListName.Type;
/** A client or a vendor: one list, by kind. */
export const KinPartyKind = Schema.Literals(["client", "vendor"]);
export type KinPartyKind = typeof KinPartyKind.Type;
/** Another entry, as it is now, to open it by key. */
export const KinRecordRef = Schema.Struct({
  recordId: KinRecordId,
  key: KinRecordKey,
  title: KinTrimmedText,
});
export type KinRecordRef = typeof KinRecordRef.Type;
/** A client or vendor an entry or project is for. `kind` is absent from hosts before it was sent. */
export const KinPartyRef = Schema.Struct({
  ...KinRecordRef.fields,
  kind: Schema.optional(KinPartyKind),
});
export type KinPartyRef = typeof KinPartyRef.Type;
/** `owner/name` on GitHub. */
export const KinRepoName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
);
export type KinRepoName = typeof KinRepoName.Type;

/** One slim list row, about 150 bytes: what a list, the profile and the prompt show. */
export const KinRecord = Schema.Struct({
  recordId: KinRecordId,
  orgId: KinOrgId,
  key: KinRecordKey,
  title: KinTrimmedText,
  state: KinRecordState,
  /** Set only while `waiting`. */
  waitingOn: Schema.NullOr(KinWorkPrincipal),
  owner: KinWorkPrincipal,
  category: Schema.NullOr(KinRecordCategory),
  side: KinRecordSide,
  /** When it is due. `dueAllDay` means a calendar day in the owner's time zone; `dueAt` is its end. */
  dueAt: Schema.NullOr(IsoDateTime),
  dueAllDay: Schema.Boolean,
  /** Computed, never stored: due has passed and it is neither done nor dropped. */
  late: Schema.Boolean,
  /** False while a lead only inferred it. */
  confirmed: Schema.Boolean,
  sensitive: Schema.Boolean,
  /** A worker linked to it is running now. */
  working: Schema.Boolean,
  /** The latest pull request linked to it. */
  pullRequest: Schema.NullOr(KinPullRequestRef),
  rev: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
  // Optional below: absent when unset, and from hosts older than the clients slice.
  /** The client or vendor it is for, which makes it part of that client's record. */
  party: Schema.optional(KinPartyRef),
  project: Schema.optional(KinRecordRef),
  repo: Schema.optional(KinRepoName),
  /** True when its project or client is labelled sensitive, whatever its own label says. */
  sensitiveInherited: Schema.optional(Schema.Literal(true)),
  // Defined lists, such as expenses (slice 5); absent on Work and the light CRM.
  /** The defined list it is in. */
  list: Schema.optional(KinListId),
  /** Its category among the list's own, such as an expense's `travel`. */
  listCategory: Schema.optional(KinTrimmedText),
  amount: Schema.optional(KinMoney),
  /** When it happened, was issued or starts; `dateAllDay` as for `dueAt`. */
  dateAt: Schema.optional(IsoDateTime),
  dateAllDay: Schema.optional(Schema.Boolean),
  repeat: Schema.optional(KinRepeatRule),
  /** An invoice's amount less the payments received against it. */
  balance: Schema.optional(KinMoney),
  /** Of what settled an invoice, the money paid in; absent from older servers. */
  received: Schema.optional(KinMoney),
  /** Tax the client deducted at source: it settles the invoice but is not money received. */
  tdsDeducted: Schema.optional(KinMoney),
  /** In a defined list's own rows, its fields by key, as its definition types them. */
  fields: Schema.optional(Schema.Record(Schema.String, KinFieldValue)),
});
export type KinRecord = typeof KinRecord.Type;

export const KinRecordLinkKind = Schema.Literals([
  "message",
  "worker",
  "pull_request",
  "record",
  "memory",
  "url",
]);
export type KinRecordLinkKind = typeof KinRecordLinkKind.Type;
/** `source`: where it came from. `attempt`: a worker doing it. `evidence`: proof it happened. */
export const KinRecordRelation = Schema.Literals([
  "source",
  "attempt",
  "evidence",
  "relates",
  "blocks",
  "parent",
]);
export type KinRecordRelation = typeof KinRecordRelation.Type;
export const KinRecordLink = Schema.Struct({
  kind: KinRecordLinkKind,
  relation: KinRecordRelation,
  /** A message, worker, record or memory item id, or a URL. */
  target: Schema.String,
  /** Message links name their chat so a client can open it. */
  chatId: Schema.NullOr(KinChatId),
  // Server-written: a PR number, a worker title. Plain text, never markup.
  label: Schema.NullOr(KinText),
  createdAt: IsoDateTime,
  /** A `record` link's other end as it is now, to open it by key; absent once it is gone. */
  record: Schema.optional(KinRecordRef),
  /**
   * A `worker` link's run, as its task card shows it: the thread (in `remoteEnvironmentId` when
   * that is set, else on this host) and the draft pull request Kin opened from it.
   */
  worker: Schema.optional(
    Schema.Struct({
      threadId: Schema.NullOr(ThreadId),
      remoteEnvironmentId: Schema.NullOr(EnvironmentId),
      running: Schema.Boolean,
      pullRequest: Schema.NullOr(KinPullRequestRef),
    }),
  ),
});
export type KinRecordLink = typeof KinRecordLink.Type;

export const KinRecordChangeVia = Schema.Literals(["lead", "owner", "worker", "github", "import"]);
export type KinRecordChangeVia = typeof KinRecordChangeVia.Type;
/** One line of an entry's history. Values are shown as text: a state, a key, an ISO time. */
export const KinRecordChange = Schema.Struct({
  seq: NonNegativeInt,
  at: IsoDateTime,
  by: KinWorkActor,
  via: KinRecordChangeVia,
  kind: Schema.Literals(["created", "updated", "linked"]),
  fields: Schema.Array(
    Schema.Struct({
      field: TrimmedNonEmptyString,
      from: Schema.NullOr(Schema.String),
      to: Schema.NullOr(Schema.String),
    }),
  ),
});
export type KinRecordChange = typeof KinRecordChange.Type;

/** An entry with everything the entry sheet shows. */
export const KinRecordDetail = Schema.Struct({
  ...KinRecord.fields,
  notes: KinText,
  /** The chat and message it came from, when it came from one. */
  source: Schema.Struct({
    chatId: Schema.NullOr(KinChatId),
    messageId: Schema.NullOr(KinMessageId),
  }),
  /** The human who gave it to its current owner. The only authority a lead's work on it has. */
  assignedBy: Schema.NullOr(KinWorkPrincipal),
  assignedAt: Schema.NullOr(IsoDateTime),
  createdBy: KinWorkActor,
  links: Schema.Array(KinRecordLink),
  /** Newest first, at most `KIN_RECORD_CHANGES_CAP`. */
  changes: Schema.Array(KinRecordChange),
  /** This entry's latest change number, links included: compare with a `changed` event's. */
  seq: Schema.optional(NonNegativeInt),
  /** The files its file fields keep, such as a receipt. */
  files: Schema.optional(Schema.Array(KinFileRef)),
  /** An invoice's payments, newest first, voided ones included. */
  payments: Schema.optional(Schema.Array(KinPayment)),
});
export type KinRecordDetail = typeof KinRecordDetail.Type;
export const KIN_RECORD_CHANGES_CAP = 50;
export const KIN_RECORDS_PAGE_CAP = 100;

/** How a defined list's totals split: none, its categories, or its entries' dates. */
export const KinListGroupBy = Schema.Literals(["none", "category", "month", "financialYear"]);
export type KinListGroupBy = typeof KinListGroupBy.Type;
const KinListSums = {
  /** Full amounts. */
  total: KinMoneyTotals,
  /** In a list whose entries are paid over time: what the open ones still have unpaid. */
  owed: Schema.optional(KinMoneyTotals),
  /** With `paidFrom` or `paidTo`: the payments made in those days, not the entries' amounts. */
  received: Schema.optional(KinMoneyTotals),
};
/** `group` is a category, `2026-11` or `FY2026-27`; null is entries with none. */
export const KinListTotals = Schema.Struct({
  ...KinListSums,
  groups: Schema.Array(
    Schema.Struct({
      group: Schema.NullOr(Schema.String),
      count: NonNegativeInt,
      ...KinListSums,
    }),
  ),
});
export type KinListTotals = typeof KinListTotals.Type;

export const KinWorkListInput = Schema.Struct({
  orgId: KinOrgId,
  /** Default `work`; a defined list such as `expenses` lists its entries. */
  list: Schema.optional(KinListId),
  /** A lead's profile and the per-owner rows of the Work screen. */
  owner: Schema.optional(KinWorkPrincipal),
  states: Schema.optional(Schema.Array(KinRecordState)),
  /** Neither done nor dropped. Ignored when `states` is set. */
  open: Schema.optional(Schema.Boolean),
  /** `true`: only late entries. `false`: none that are late. Late is as of the first page. */
  late: Schema.optional(Schema.Boolean),
  /** Due at or before this time. */
  dueBy: Schema.optional(IsoDateTime),
  /** Due at or after this time. */
  dueAfter: Schema.optional(IsoDateTime),
  category: Schema.optional(KinRecordCategory),
  side: Schema.optional(KinRecordSide),
  /** A client's or vendor's key: its entries. `null`: entries with no client. */
  party: Schema.optional(Schema.NullOr(KinRecordKey)),
  /** A project's key: its entries, such as its issues with `category: "issue"`. */
  project: Schema.optional(KinRecordKey),
  repo: Schema.optional(KinRepoName),
  /** Case-insensitive match on title and notes. */
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  // Defined lists only.
  /** One of the list's own categories. `null`: entries with none. */
  listCategory: Schema.optional(Schema.NullOr(KinTrimmedText.check(Schema.isMaxLength(60)))),
  /**
   * Its own date, or the day it was added when it has none, on or after this day and on or
   * before `dateTo`, in the owner's time zone: the rule Money's "spent" uses.
   */
  dateFrom: Schema.optional(KinDay),
  dateTo: Schema.optional(KinDay),
  /** A payment was received against it on or after this day, and on or before `paidTo`. */
  paidFrom: Schema.optional(KinDay),
  paidTo: Schema.optional(KinDay),
  /** Also answer `totals` for everything the filter matches, split this way. First page only. */
  totalsBy: Schema.optional(KinListGroupBy),
  /** From the previous page's `nextCursor`. */
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
  ),
});
export type KinWorkListInput = typeof KinWorkListInput.Type;
/** Ordered open first, then soonest due, then key. `seq` is the change number the page is as of. */
export const KinWorkListResult = Schema.Struct({
  records: Schema.Array(KinRecord),
  total: NonNegativeInt,
  nextCursor: Schema.NullOr(Schema.String),
  seq: NonNegativeInt,
  asOf: IsoDateTime,
  /** Asked for with `totalsBy`: exact sums per currency of every match, not of this page. */
  totals: Schema.optional(KinListTotals),
});
export type KinWorkListResult = typeof KinWorkListResult.Type;

/** By key, or by record id as a `record` link names it. */
export const KinWorkGetInput = Schema.Union([
  Schema.Struct({ orgId: KinOrgId, key: KinRecordKey }),
  Schema.Struct({ orgId: KinOrgId, recordId: KinRecordId }),
]);
export type KinWorkGetInput = typeof KinWorkGetInput.Type;

/** What a client or vendor and we owe each other, open entries only. */
const KinPartyCounts = {
  weOwe: NonNegativeInt,
  theyOwe: NonNegativeInt,
  /** What we owe that is past due. */
  late: NonNegativeInt,
  /** What they owe that is past due. */
  overdue: NonNegativeInt,
};
/**
 * Derived by rule on every read, never stored or typed: `late` once the target date passed,
 * `at_risk` while an entry is late or has waited more than a week, else `on_track`.
 */
export const KinProjectHealth = Schema.Literals(["on_track", "at_risk", "late"]);
export type KinProjectHealth = typeof KinProjectHealth.Type;
const KinProjectCounts = {
  open: NonNegativeInt,
  late: NonNegativeInt,
  /** `null` once the project is done or dropped. */
  health: Schema.NullOr(KinProjectHealth),
};

/** Counts for the pinned row and the Work screen's people and leads section; under 2 KB. */
const KinWorkCounts = {
  open: NonNegativeInt,
  doing: NonNegativeInt,
  waiting: NonNegativeInt,
  late: NonNegativeInt,
  dueThisWeek: NonNegativeInt,
};
export const KinWorkSummaryInput = Schema.Struct({ orgId: KinOrgId });
export type KinWorkSummaryInput = typeof KinWorkSummaryInput.Type;
export const KinWorkSummary = Schema.Struct({
  ...KinWorkCounts,
  /** Done or dropped, ever. */
  closed: Schema.optional(NonNegativeInt),
  /** Every owner with an open entry, most open first. */
  owners: Schema.Array(Schema.Struct({ owner: KinWorkPrincipal, ...KinWorkCounts })),
  /** Active clients and vendors with open entries, most open first, at most 20. */
  parties: Schema.optional(Schema.Array(Schema.Struct({ party: KinRecordRef, ...KinPartyCounts }))),
  /** Active projects, late first, then at risk, then soonest target, at most 20. */
  projects: Schema.optional(
    Schema.Array(Schema.Struct({ project: KinRecordRef, ...KinProjectCounts })),
  ),
  seq: NonNegativeInt,
  asOf: IsoDateTime,
});
export type KinWorkSummary = typeof KinWorkSummary.Type;

/**
 * Live updates without lists on the socket: the latest change number now, then again after each
 * change. A client with a list, entry or count open refetches it, debounced.
 */
export const KinWorkSubscribeInput = Schema.Struct({ orgId: KinOrgId });
export type KinWorkSubscribeInput = typeof KinWorkSubscribeInput.Type;
export const KinWorkEvent = Schema.Union([
  Schema.TaggedStruct("changed", {
    seq: NonNegativeInt,
    /** The entry that changed; absent on the first event, which is only the latest number. */
    key: Schema.optional(KinRecordKey),
  }),
]);
export type KinWorkEvent = typeof KinWorkEvent.Type;

/** The owner's "New": a short form. Long text belongs in chat. */
export const KinWorkCreateInput = Schema.Struct({
  orgId: KinOrgId,
  title: KinTrimmedText.check(Schema.isMaxLength(280)),
  /** Defaults to the owner. A lead given work this way is woken to do it. */
  owner: Schema.optional(KinWorkPrincipal),
  dueAt: Schema.optional(IsoDateTime),
  dueAllDay: Schema.optional(Schema.Boolean),
  notes: Schema.optional(KinText.check(Schema.isMaxLength(4_000))),
  category: Schema.optional(KinRecordCategory),
  /** A client's or vendor's key: makes it an obligation between us and them. */
  party: Schema.optional(KinRecordKey),
  /** A project's key. With no `party`, the entry takes the project's client. */
  project: Schema.optional(KinRecordKey),
  /** `theirs` when the client owes it and the owner is whoever chases. Default `ours`. */
  side: Schema.optional(KinRecordSide),
  repo: Schema.optional(KinRepoName),
  /** A retry with the same id returns the same entry. */
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
});
export type KinWorkCreateInput = typeof KinWorkCreateInput.Type;

/**
 * The owner gives an open entry to a lead or a person; given to a lead, it is an instruction to do
 * it. `null` takes it back: every entry has one owner, so it returns to the owner. A lead that
 * loses an open entry is told, in a turn only the owner reads.
 */
export const KinWorkAssignInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  to: Schema.NullOr(KinWorkPrincipal),
  /** The revision the owner saw; a different current one is refused as a conflict. */
  rev: Schema.optional(NonNegativeInt),
});
export type KinWorkAssignInput = typeof KinWorkAssignInput.Type;

/**
 * The owner's edit: only the fields given change, each logged. A stale `rev` is a conflict unless
 * the entry already holds every value given, so a retry succeeds. Closing an entry a lead holds
 * tells that lead to stop; reopening one gives it back to the lead to do.
 */
export const KinWorkUpdateInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  rev: NonNegativeInt,
  title: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(280))),
  notes: Schema.optional(KinText.check(Schema.isMaxLength(4_000))),
  /** `null` clears it. A `YYYY-MM-DD` day with `dueAllDay` is that day in the owner's zone. */
  dueAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  dueAllDay: Schema.optional(Schema.Boolean),
  state: Schema.optional(KinRecordState),
  /** Who it waits on, while `waiting`; ignored in any other state. */
  waitingOn: Schema.optional(Schema.NullOr(KinWorkPrincipal)),
  category: Schema.optional(Schema.NullOr(KinRecordCategory)),
  /** Keys; `null` clears. A new project with no `party` given brings the project's client. */
  party: Schema.optional(Schema.NullOr(KinRecordKey)),
  project: Schema.optional(Schema.NullOr(KinRecordKey)),
  side: Schema.optional(KinRecordSide),
  repo: Schema.optional(Schema.NullOr(KinRepoName)),
  /** The entry's own label; only the owner lowers one. */
  sensitive: Schema.optional(Schema.Boolean),
  /** Lists with money and dates. `null` clears; the currency is the amount's own. */
  amount: Schema.optional(Schema.NullOr(KinMoney)),
  dateAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  dateAllDay: Schema.optional(Schema.Boolean),
  repeat: Schema.optional(Schema.NullOr(KinRepeatRule)),
  // Defined lists only.
  /** One of the list's own categories; `null` clears it. */
  listCategory: Schema.optional(Schema.NullOr(KinTrimmedText.check(Schema.isMaxLength(60)))),
  /**
   * The list's own fields by key, as stored and as its definition types them: text, a choice, a
   * `YYYY-MM-DD` day, `person:<id>` or `agent:<id>`, a client's or project's record id, an amount,
   * or the ids of files from `kin.work.files`. `null` clears one. Checked as an agent's are.
   */
  fields: Schema.optional(
    Schema.Record(KinListFieldKey, Schema.NullOr(KinFieldValue)).check(Schema.isMaxProperties(20)),
  ),
});
export type KinWorkUpdateInput = typeof KinWorkUpdateInput.Type;

/** Keep a lead's suggested entry (`confirm`), or decline it, which drops it. */
export const KinWorkConfirmInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  rev: NonNegativeInt,
});
export type KinWorkConfirmInput = typeof KinWorkConfirmInput.Type;

// The light CRM. A client page and a project page each come whole from one call: no joins or
// arithmetic on the client. Everything is computed on read from entries and their change logs.

/** Fields sensitive whatever the entry's own label: contact details and commercial terms. */
export const KIN_SENSITIVE_FIELDS = {
  clients: ["terms"],
  contacts: ["email", "phone"],
} as const;
const SensitiveFields = Schema.Array(TrimmedNonEmptyString);
const Name = KinTrimmedText.check(Schema.isMaxLength(200));
const Notes = KinText.check(Schema.isMaxLength(4_000));
const ShortText = KinTrimmedText.check(Schema.isMaxLength(200));
const RequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
const Address = KinTrimmedText.check(Schema.isMaxLength(500));
const PageLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(KIN_RECORDS_PAGE_CAP),
);
const PageCursor = Schema.String.check(Schema.isMaxLength(200));
/** By key, or by record id as a `party` or `project` ref names it. */
const KinRecordLookup = Schema.Union([
  Schema.Struct({ orgId: KinOrgId, key: KinRecordKey }),
  Schema.Struct({ orgId: KinOrgId, recordId: KinRecordId }),
]);

/** One row of the clients directory and the Work screen's clients section. */
export const KinPartyRow = Schema.Struct({
  recordId: KinRecordId,
  key: KinRecordKey,
  name: KinTrimmedText,
  kind: KinPartyKind,
  /** Who looks after them on our side. */
  owner: KinWorkPrincipal,
  /** False once closed; its history and the entries pointing at it stay. */
  active: Schema.Boolean,
  sensitive: Schema.Boolean,
  ...KinPartyCounts,
  /** The soonest open entry we owe them. */
  next: Schema.NullOr(
    Schema.Struct({
      key: KinRecordKey,
      title: KinTrimmedText,
      dueAt: Schema.NullOr(IsoDateTime),
      dueAllDay: Schema.Boolean,
      late: Schema.Boolean,
    }),
  ),
  rev: NonNegativeInt,
});
export type KinPartyRow = typeof KinPartyRow.Type;
export const KinPartyDetail = Schema.Struct({
  ...KinPartyRow.fields,
  notes: KinText,
  /** Commercial terms in a line or a paragraph. Always sensitive. */
  terms: Schema.NullOr(KinText),
  /** The billing address an invoice shows. */
  address: Schema.NullOr(KinText),
  /** Which fields here are sensitive whatever `sensitive` says. */
  sensitiveFields: SensitiveFields,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
  /** This client's own latest change number. */
  seq: NonNegativeInt,
});
export type KinPartyDetail = typeof KinPartyDetail.Type;

export const KinContact = Schema.Struct({
  recordId: KinRecordId,
  key: KinRecordKey,
  party: KinRecordRef,
  name: KinTrimmedText,
  role: Schema.NullOr(KinTrimmedText),
  email: Schema.NullOr(KinTrimmedText),
  phone: Schema.NullOr(KinTrimmedText),
  notes: KinText,
  active: Schema.Boolean,
  /** The contact's own label, or its client's. */
  sensitive: Schema.Boolean,
  sensitiveFields: SensitiveFields,
  rev: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type KinContact = typeof KinContact.Type;

/** Projects are open while under way, then done or dropped. */
export const KinProjectState = Schema.Literals(["open", "done", "dropped"]);
export type KinProjectState = typeof KinProjectState.Type;
export const KinProjectRow = Schema.Struct({
  recordId: KinRecordId,
  key: KinRecordKey,
  name: KinTrimmedText,
  party: Schema.NullOr(KinPartyRef),
  /** Who leads it: a person or a lead. */
  owner: KinWorkPrincipal,
  state: KinProjectState,
  /** The target date. With `targetAllDay`, a day in the owner's time zone and `targetAt` its end. */
  targetAt: Schema.NullOr(IsoDateTime),
  targetAllDay: Schema.Boolean,
  ...KinProjectCounts,
  sensitive: Schema.Boolean,
  /** True when its client is labelled sensitive. */
  sensitiveInherited: Schema.Boolean,
  rev: NonNegativeInt,
});
export type KinProjectRow = typeof KinProjectRow.Type;
export const KinProjectDetail = Schema.Struct({
  ...KinProjectRow.fields,
  notes: KinText,
  repos: Schema.Array(KinRepoName),
  /** Why `health` is what it is. */
  healthBecause: Schema.Struct({
    targetPassed: Schema.Boolean,
    late: NonNegativeInt,
    waitingOverAWeek: NonNegativeInt,
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
  seq: NonNegativeInt,
});
export type KinProjectDetail = typeof KinProjectDetail.Type;

/** One line of a client's or project's history: a change to it or to something pointing at it. */
export const KinWorkHistoryItem = Schema.Struct({
  ...KinRecordChange.fields,
  /** The entry the change happened to, as it is now. */
  record: Schema.Struct({ ...KinRecordRef.fields, list: KinWorkListName }),
});
export type KinWorkHistoryItem = typeof KinWorkHistoryItem.Type;

/** At most `KIN_RECORDS_PAGE_CAP` of a longer set, with the full count. */
const Capped = <S extends Schema.Top>(item: S) =>
  Schema.Struct({ records: Schema.Array(item), total: NonNegativeInt });

/** Who a blocked entry waits on: a person or lead, or the client when nobody on our side is named. */
export const KinBlockedOn = Schema.Union([
  ...KinWorkPrincipal.members,
  Schema.TaggedStruct("party", KinRecordRef.fields),
]);
export type KinBlockedOn = typeof KinBlockedOn.Type;

export const KinPartyPageInput = KinRecordLookup;
export type KinPartyPageInput = typeof KinPartyPageInput.Type;
/** The client page. `weOwe` is soonest due first; `theyOwe` is overdue first, then soonest. */
export const KinPartyPage = Schema.Struct({
  party: KinPartyDetail,
  /** Active first, then by name. */
  contacts: Schema.Array(KinContact),
  /** Open first, then by target date. */
  projects: Schema.Array(KinProjectRow),
  weOwe: Capped(KinRecord),
  theyOwe: Capped(KinRecord),
  seq: NonNegativeInt,
  asOf: IsoDateTime,
});
export type KinPartyPage = typeof KinPartyPage.Type;

export const KinProjectPageInput = KinRecordLookup;
export type KinProjectPageInput = typeof KinProjectPageInput.Type;
/** The project page. Its full entry list is `kin.work.list` with `project`. */
export const KinProjectPage = Schema.Struct({
  project: KinProjectDetail,
  counts: Schema.Struct({
    open: NonNegativeInt,
    doing: NonNegativeInt,
    waiting: NonNegativeInt,
    done: NonNegativeInt,
    dropped: NonNegativeInt,
    late: NonNegativeInt,
  }),
  /** Waiting entries, longest waiting first. */
  blocked: Schema.Array(
    Schema.Struct({ record: KinRecord, on: Schema.NullOr(KinBlockedOn), since: IsoDateTime }),
  ),
  /** The soonest-due open entry that is not late yet. */
  nextDue: Schema.NullOr(KinRecord),
  /** Pull requests linked to its open entries; an entry closes when its pull request merges. */
  pullRequests: Schema.Array(
    Schema.Struct({ url: Schema.String, number: NonNegativeInt, record: KinRecordRef }),
  ),
  /** The last seven days of its history, newest first. */
  changedThisWeek: Schema.Struct({
    items: Schema.Array(KinWorkHistoryItem),
    total: NonNegativeInt,
  }),
  seq: NonNegativeInt,
  asOf: IsoDateTime,
});
export type KinProjectPage = typeof KinProjectPage.Type;

/** A client's or project's history, newest first, a page at a time. */
export const KinWorkHistoryInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  cursor: Schema.optional(PageCursor),
  limit: Schema.optional(PageLimit),
});
export type KinWorkHistoryInput = typeof KinWorkHistoryInput.Type;
export const KinWorkHistory = Schema.Struct({
  items: Schema.Array(KinWorkHistoryItem),
  nextCursor: Schema.NullOr(Schema.String),
  seq: NonNegativeInt,
});
export type KinWorkHistory = typeof KinWorkHistory.Type;

/** The clients directory, by name. Active only unless `active: false` asks for the closed. */
export const KinPartiesInput = Schema.Struct({
  orgId: KinOrgId,
  kind: Schema.optional(KinPartyKind),
  active: Schema.optional(Schema.Boolean),
  /** Case-insensitive match on the name. */
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  cursor: Schema.optional(PageCursor),
  limit: Schema.optional(PageLimit),
});
export type KinPartiesInput = typeof KinPartiesInput.Type;
export const KinPartiesResult = Schema.Struct({
  parties: Schema.Array(KinPartyRow),
  total: NonNegativeInt,
  nextCursor: Schema.NullOr(Schema.String),
  seq: NonNegativeInt,
  asOf: IsoDateTime,
});
export type KinPartiesResult = typeof KinPartiesResult.Type;

/** Projects, soonest target first. Open only unless `state` says otherwise. */
export const KinProjectsInput = Schema.Struct({
  orgId: KinOrgId,
  party: Schema.optional(KinRecordKey),
  state: Schema.optional(KinProjectState),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  cursor: Schema.optional(PageCursor),
  limit: Schema.optional(PageLimit),
});
export type KinProjectsInput = typeof KinProjectsInput.Type;
export const KinProjectsResult = Schema.Struct({
  projects: Schema.Array(KinProjectRow),
  total: NonNegativeInt,
  nextCursor: Schema.NullOr(Schema.String),
  seq: NonNegativeInt,
  asOf: IsoDateTime,
});
export type KinProjectsResult = typeof KinProjectsResult.Type;

/** A new client or vendor. A name another active one already has is refused with its key. */
export const KinPartyCreateInput = Schema.Struct({
  orgId: KinOrgId,
  name: Name,
  kind: Schema.optional(KinPartyKind),
  /** Defaults to the owner. Looking after a client is not an instruction to a lead. */
  owner: Schema.optional(KinWorkPrincipal),
  notes: Schema.optional(Notes),
  terms: Schema.optional(Notes),
  address: Schema.optional(Address),
  /** Labels everything pointing at it sensitive too. */
  sensitive: Schema.optional(Schema.Boolean),
  clientRequestId: RequestId,
});
export type KinPartyCreateInput = typeof KinPartyCreateInput.Type;
/**
 * Only the fields given change, each logged. `active: false` closes it, which is refused while
 * open entries or projects point at it; `active: true` reopens it. Nothing is ever deleted.
 */
export const KinPartyUpdateInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  rev: NonNegativeInt,
  name: Schema.optional(Name),
  kind: Schema.optional(KinPartyKind),
  owner: Schema.optional(KinWorkPrincipal),
  notes: Schema.optional(Notes),
  /** `null` clears. */
  terms: Schema.optional(Schema.NullOr(Notes)),
  /** `null` clears. */
  address: Schema.optional(Schema.NullOr(Address)),
  sensitive: Schema.optional(Schema.Boolean),
  active: Schema.optional(Schema.Boolean),
});
export type KinPartyUpdateInput = typeof KinPartyUpdateInput.Type;

export const KinContactCreateInput = Schema.Struct({
  orgId: KinOrgId,
  /** The client's or vendor's key. */
  party: KinRecordKey,
  name: Name,
  role: Schema.optional(ShortText),
  email: Schema.optional(ShortText),
  phone: Schema.optional(ShortText),
  notes: Schema.optional(Notes),
  sensitive: Schema.optional(Schema.Boolean),
  clientRequestId: RequestId,
});
export type KinContactCreateInput = typeof KinContactCreateInput.Type;
export const KinContactUpdateInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  rev: NonNegativeInt,
  /** Moves the contact to another client. */
  party: Schema.optional(KinRecordKey),
  name: Schema.optional(Name),
  /** `null` clears these three. */
  role: Schema.optional(Schema.NullOr(ShortText)),
  email: Schema.optional(Schema.NullOr(ShortText)),
  phone: Schema.optional(Schema.NullOr(ShortText)),
  notes: Schema.optional(Notes),
  sensitive: Schema.optional(Schema.Boolean),
  active: Schema.optional(Schema.Boolean),
});
export type KinContactUpdateInput = typeof KinContactUpdateInput.Type;

export const KinProjectCreateInput = Schema.Struct({
  orgId: KinOrgId,
  name: Name,
  party: Schema.optional(KinRecordKey),
  /** Who leads it; defaults to the owner. Leading a project is not an instruction to a lead. */
  owner: Schema.optional(KinWorkPrincipal),
  /** A `YYYY-MM-DD` day with `targetAllDay` is that day in the owner's zone. */
  targetAt: Schema.optional(IsoDateTime),
  targetAllDay: Schema.optional(Schema.Boolean),
  repos: Schema.optional(Schema.Array(KinRepoName).check(Schema.isMaxLength(20))),
  notes: Schema.optional(Notes),
  sensitive: Schema.optional(Schema.Boolean),
  clientRequestId: RequestId,
});
export type KinProjectCreateInput = typeof KinProjectCreateInput.Type;
/** Done or dropped is refused while open entries point at it; `open` reopens it. */
export const KinProjectUpdateInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  rev: NonNegativeInt,
  name: Schema.optional(Name),
  /** `null` clears. Its entries keep the client they have. */
  party: Schema.optional(Schema.NullOr(KinRecordKey)),
  owner: Schema.optional(KinWorkPrincipal),
  targetAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  targetAllDay: Schema.optional(Schema.Boolean),
  repos: Schema.optional(Schema.Array(KinRepoName).check(Schema.isMaxLength(20))),
  notes: Schema.optional(Notes),
  sensitive: Schema.optional(Schema.Boolean),
  state: Schema.optional(KinProjectState),
});
export type KinProjectUpdateInput = typeof KinProjectUpdateInput.Type;

export const KIN_WORK_WS_METHODS = {
  summary: "kin.work.summary",
  list: "kin.work.list",
  get: "kin.work.get",
  subscribe: "kin.work.subscribe",
  create: "kin.work.create",
  assign: "kin.work.assign",
  update: "kin.work.update",
  confirm: "kin.work.confirm",
  decline: "kin.work.decline",
  parties: "kin.work.parties",
  party: "kin.work.party",
  projects: "kin.work.projects",
  project: "kin.work.project",
  history: "kin.work.history",
  createParty: "kin.work.createParty",
  updateParty: "kin.work.updateParty",
  createContact: "kin.work.createContact",
  updateContact: "kin.work.updateContact",
  createProject: "kin.work.createProject",
  updateProject: "kin.work.updateProject",
} as const;

const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
// Owner only, on the server; a chat-only session is refused before any handler runs.
export const KinWorkRpcs = [
  Rpc.make(KIN_WORK_WS_METHODS.summary, {
    payload: KinWorkSummaryInput,
    success: KinWorkSummary,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.list, {
    payload: KinWorkListInput,
    success: KinWorkListResult,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.get, { payload: KinWorkGetInput, success: KinRecordDetail, error }),
  Rpc.make(KIN_WORK_WS_METHODS.subscribe, {
    payload: KinWorkSubscribeInput,
    success: KinWorkEvent,
    error,
    stream: true,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.create, {
    payload: KinWorkCreateInput,
    success: KinRecordDetail,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.assign, {
    payload: KinWorkAssignInput,
    success: KinRecordDetail,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.update, {
    payload: KinWorkUpdateInput,
    success: KinRecordDetail,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.confirm, {
    payload: KinWorkConfirmInput,
    success: KinRecordDetail,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.decline, {
    payload: KinWorkConfirmInput,
    success: KinRecordDetail,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.parties, {
    payload: KinPartiesInput,
    success: KinPartiesResult,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.party, { payload: KinPartyPageInput, success: KinPartyPage, error }),
  Rpc.make(KIN_WORK_WS_METHODS.projects, {
    payload: KinProjectsInput,
    success: KinProjectsResult,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.project, {
    payload: KinProjectPageInput,
    success: KinProjectPage,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.history, {
    payload: KinWorkHistoryInput,
    success: KinWorkHistory,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.createParty, {
    payload: KinPartyCreateInput,
    success: KinPartyDetail,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.updateParty, {
    payload: KinPartyUpdateInput,
    success: KinPartyDetail,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.createContact, {
    payload: KinContactCreateInput,
    success: KinContact,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.updateContact, {
    payload: KinContactUpdateInput,
    success: KinContact,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.createProject, {
    payload: KinProjectCreateInput,
    success: KinProjectDetail,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.updateProject, {
    payload: KinProjectUpdateInput,
    success: KinProjectDetail,
    error,
  }),
] as const;

export const KIN_WORK_RPC_SCOPES = {
  [KIN_WORK_WS_METHODS.summary]: AuthOrchestrationReadScope,
  [KIN_WORK_WS_METHODS.list]: AuthOrchestrationReadScope,
  [KIN_WORK_WS_METHODS.get]: AuthOrchestrationReadScope,
  [KIN_WORK_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
  // Giving a lead work starts agent work on the owner's budget, as a message to it does.
  [KIN_WORK_WS_METHODS.create]: AuthOrchestrationOperateScope,
  [KIN_WORK_WS_METHODS.assign]: AuthOrchestrationOperateScope,
  // Closing, reopening or declining an entry a lead holds wakes that lead.
  [KIN_WORK_WS_METHODS.update]: AuthOrchestrationOperateScope,
  [KIN_WORK_WS_METHODS.confirm]: AuthOrchestrationOperateScope,
  [KIN_WORK_WS_METHODS.decline]: AuthOrchestrationOperateScope,
  [KIN_WORK_WS_METHODS.parties]: AuthOrchestrationReadScope,
  [KIN_WORK_WS_METHODS.party]: AuthOrchestrationReadScope,
  [KIN_WORK_WS_METHODS.projects]: AuthOrchestrationReadScope,
  [KIN_WORK_WS_METHODS.project]: AuthOrchestrationReadScope,
  [KIN_WORK_WS_METHODS.history]: AuthOrchestrationReadScope,
  // Writes like the entry edits beside them; none of these starts agent work.
  [KIN_WORK_WS_METHODS.createParty]: AuthOrchestrationOperateScope,
  [KIN_WORK_WS_METHODS.updateParty]: AuthOrchestrationOperateScope,
  [KIN_WORK_WS_METHODS.createContact]: AuthOrchestrationOperateScope,
  [KIN_WORK_WS_METHODS.updateContact]: AuthOrchestrationOperateScope,
  [KIN_WORK_WS_METHODS.createProject]: AuthOrchestrationOperateScope,
  [KIN_WORK_WS_METHODS.updateProject]: AuthOrchestrationOperateScope,
} as const;
