import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthKinChatScope, EnvironmentAuthorizationError } from "./auth.ts";
import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  KinAgentId,
  KinAttachment,
  KinChatError,
  KinChatId,
  KinChoiceOption,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinText,
  KinTrimmedText,
  KinWidgetId,
} from "./kinChat.ts";
import {
  KinDay,
  KinFieldValue,
  KinFileRef,
  KinListFieldKey,
  KinListId,
  KinMoney,
  KinMoneyTotals,
  KinSignedMoney,
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
/** A `meeting` has its start as `dateAt` and the people in it as `attendees`. */
export const KinRecordCategory = Schema.Literals(["task", "issue", "obligation", "meeting"]);
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

/** The built-in lists. Only `work` entries are tasks; milestones belong to projects. */
export const KinWorkListName = Schema.Literals([
  "work",
  "clients",
  "contacts",
  "projects",
  "milestones",
  "goals",
]);
export type KinWorkListName = typeof KinWorkListName.Type;
/** A client or a vendor: one list, by kind. A prospect goes out as a client with `prospect`. */
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

/**
 * What the reader may do to an entry, decided by the checks its writes run. A screen offers
 * exactly these; absent from older hosts.
 */
export const KinRecordCan = Schema.Struct({
  /** States it may move to from where it is now; empty when its state isn't theirs to change. */
  states: Schema.Array(KinRecordState),
  /** Title, notes, due and who it waits on. */
  edit: Schema.Boolean,
  /** Its client, and its project. */
  party: Schema.Boolean,
  project: Schema.Boolean,
  /** Take it out of its project; a lead may move a task into his project but not out. */
  clearProject: Schema.Boolean,
  /** Give it to someone else; take it back to themselves. */
  give: Schema.Boolean,
  takeBack: Schema.Boolean,
  /** Mark it private; take the mark off. */
  mark: Schema.Boolean,
  unmark: Schema.Boolean,
  /** Share it with the whole team or take that back (`kin.work.share`). */
  share: Schema.Boolean,
  /** Keep or decline an agent's suggestion. */
  confirm: Schema.Boolean,
  /** Set how a task repeats, or turn it off; absent from older hosts. */
  repeat: Schema.optional(Schema.Boolean),
  /** Add or remove its web links (`kin.work.linkAdd`); absent from older hosts. */
  links: Schema.optional(Schema.Boolean),
});
export type KinRecordCan = typeof KinRecordCan.Type;

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
  /** The owner shared it with the team (`kin.work.share`). */
  shared: Schema.optional(Schema.Literal(true)),
  // Defined lists, such as expenses (slice 5); absent on Work and the light CRM.
  /** The defined list it is in. */
  list: Schema.optional(KinListId),
  /** Its category among the list's own, such as an expense's `travel`. */
  listCategory: Schema.optional(KinTrimmedText),
  /** Below zero only on an expense: a refund or credit. */
  amount: Schema.optional(KinSignedMoney),
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
  /** What the reader may do to it now. */
  can: Schema.optional(KinRecordCan),
  /** Who gave it to its holder, when that is someone else; absent from older hosts. */
  givenBy: Schema.optional(KinWorkPrincipal),
  /** Who handed it back to its holder, and when, until it is given again or closed. */
  handedBack: Schema.optional(Schema.Struct({ by: KinWorkPrincipal, at: IsoDateTime })),
  /** Who marked it private ("Only me"), while it is; absent when unknown or not marked. */
  markedBy: Schema.optional(KinPersonId),
});
export type KinRecord = typeof KinRecord.Type;

/**
 * A `KinRecord` as `acceptCompactRows` sends it: no `orgId` (the input's), nulls and `false`
 * flags left out, `confirmed` left out when true, and `can` left out when it is the answer's.
 */
export const KinRecordCompact = Schema.Struct({
  ...KinRecord.fields,
  orgId: Schema.optional(KinOrgId),
  waitingOn: Schema.optional(KinWorkPrincipal),
  category: Schema.optional(KinRecordCategory),
  dueAt: Schema.optional(IsoDateTime),
  dueAllDay: Schema.optional(Schema.Literal(true)),
  late: Schema.optional(Schema.Literal(true)),
  confirmed: Schema.optional(Schema.Literal(false)),
  sensitive: Schema.optional(Schema.Literal(true)),
  working: Schema.optional(Schema.Literal(true)),
  pullRequest: Schema.optional(KinPullRequestRef),
  closedAt: Schema.optional(IsoDateTime),
});
export type KinRecordCompact = typeof KinRecordCompact.Type;

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
  /** An agent's change: the person it acted for, so it reads "Arjun, via Chief of staff". */
  askedBy: Schema.optional(KinPersonId),
  /** A person's change through one of their coding-agent keys: that key's name. */
  codingAgent: Schema.optional(Schema.String),
});
export type KinRecordChange = typeof KinRecordChange.Type;
/** The field a change carries when Kin took a question's default: no list field's key has a colon. */
export const KIN_TAKEN_DEFAULT_FIELD = "kin:default";

export const KIN_RECORD_COMMENT_MAX = 4_000;
export const KIN_RECORD_COMMENT_FILES_MAX = 8;
/** How many comments a record's sheet carries, newest; `kin.work.comments` pages older ones. */
export const KIN_RECORD_COMMENTS_PAGE = 50;
/**
 * A note on an entry from anyone who sees it, a person or an agent. It never changes the entry.
 * A removed one keeps its place with no words or files.
 */
export const KinRecordComment = Schema.Struct({
  commentId: TrimmedNonEmptyString,
  /** Its place among the entry's comments, from 1: the cursor for older ones. */
  seq: NonNegativeInt,
  at: IsoDateTime,
  by: KinWorkPrincipal,
  /** An agent's comment: the person whose turn it wrote it in. */
  askedBy: Schema.optional(KinPersonId),
  /** A person's comment through one of their coding-agent keys: that key's name. */
  codingAgent: Schema.optional(Schema.String),
  body: KinText,
  files: Schema.Array(KinAttachment),
  removed: Schema.optional(Schema.Struct({ at: IsoDateTime, by: KinWorkPrincipal })),
  /** This viewer may remove it: its author, or the owner level. */
  canRemove: Schema.optional(Schema.Boolean),
});
export type KinRecordComment = typeof KinRecordComment.Type;

/**
 * A card in a chat waiting on someone that is about this entry: a mail to Confirm (`send`) or an
 * agent's open question. Only on the sheet of someone who reads that chat.
 */
export const KinRecordWaiting = Schema.Struct({
  kind: Schema.Literals(["send", "question"]),
  chatId: KinChatId,
  messageId: KinMessageId,
  widgetId: KinWidgetId,
  /** One line: a mail's recipients and subject, or the question. */
  preview: KinText,
  files: Schema.Array(Schema.Struct({ name: Schema.String, mimeType: Schema.String })),
  at: IsoDateTime,
});
export type KinRecordWaiting = typeof KinRecordWaiting.Type;

/**
 * A project's one note for every task: a comment on the project, shown at the top of each of its
 * tasks to whoever sees the project. Never copied into a task.
 */
export const KinProjectNote = Schema.Struct({
  body: KinText,
  at: IsoDateTime,
  by: KinWorkPrincipal,
  project: KinRecordRef,
});
export type KinProjectNote = typeof KinProjectNote.Type;

export const KIN_RECORD_LINKED_FROM_CAP = 50;
/** The other way round from `links`, on a record's and a doc's sheet. */
export const KinLinkedFromFields = {
  /**
   * Entries and docs that link to this one and the reader may see, newest first, at most
   * `KIN_RECORD_LINKED_FROM_CAP`: `record` links whose `target` and `record` are the one linking
   * here. Absent when none link here, and from older hosts.
   */
  linkedFrom: Schema.optional(Schema.Array(KinRecordLink)),
  /** How many more past the cap, of those the reader may see. */
  linkedFromMore: Schema.optional(NonNegativeInt),
};

/** An entry with everything the entry sheet shows. */
export const KinRecordDetail = Schema.Struct({
  ...KinRecord.fields,
  notes: KinText,
  /** A task's milestone; absent with none, and from older hosts. */
  milestone: Schema.optional(KinRecordRef),
  /** A milestone's tasks, open first, at most 100; absent on anything else. */
  tasks: Schema.optional(Schema.Array(KinRecord)),
  /** The chat and message it came from, when it came from one. */
  source: Schema.Struct({
    chatId: Schema.NullOr(KinChatId),
    messageId: Schema.NullOr(KinMessageId),
  }),
  /** The human who gave it to its current owner. The only authority a lead's work on it has. */
  assignedBy: Schema.NullOr(KinWorkPrincipal),
  assignedAt: Schema.NullOr(IsoDateTime),
  /** The agent that gave it to its current holder, when one did; absent from older hosts. */
  assignedByAgent: Schema.optional(KinAgentId),
  /** The one line on why its holder was picked. */
  reason: Schema.optional(KinText),
  createdBy: KinWorkActor,
  links: Schema.Array(KinRecordLink),
  ...KinLinkedFromFields,
  /** Newest first, at most `KIN_RECORD_CHANGES_CAP`. */
  changes: Schema.Array(KinRecordChange),
  /** This entry's latest change number, links included: compare with a `changed` event's. */
  seq: Schema.optional(NonNegativeInt),
  /** The files its file fields keep, such as a receipt. */
  files: Schema.optional(Schema.Array(KinFileRef)),
  /** An invoice's payments, newest first, voided ones included. */
  payments: Schema.optional(Schema.Array(KinPayment)),
  /** Mail that carried its file, sent on the owner's Confirm, newest first. */
  sent: Schema.optional(
    Schema.Array(
      Schema.Struct({
        to: Schema.Array(Schema.String),
        subject: Schema.String,
        at: IsoDateTime,
        /** The mail thread it went in: a reminder replies there. */
        threadId: Schema.NullOr(Schema.String),
      }),
    ),
  ),
  /** The person it was made for or by; absent on entries made before hosts stored it. */
  askedBy: Schema.optional(KinPersonId),
  /** The newest `KIN_RECORD_COMMENTS_PAGE` comments, oldest first; absent from older hosts. */
  comments: Schema.optional(Schema.Array(KinRecordComment)),
  /** There are comments before the first of `comments`. */
  olderComments: Schema.optional(Schema.Boolean),
  /** The newest card waiting on someone about it, for a viewer who reads its chat. */
  waiting: Schema.optional(KinRecordWaiting),
  /** Its project's note for every task, for a viewer who sees the project; absent with none. */
  projectNote: Schema.optional(KinProjectNote),
  /**
   * The day its holder is back, on their calendar, while the line telling them it is theirs
   * waits for that; absent otherwise, and from older hosts.
   */
  toldWhenBack: Schema.optional(KinDay),
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
  /** Quotes: those sent and waiting for an answer, and those accepted. Drafts aren't totalled. */
  sent: Schema.optional(KinMoneyTotals),
  accepted: Schema.optional(KinMoneyTotals),
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
  /** Answer `rows` and `can` in place of `records`; `kinWorkListRecords` restores them. */
  acceptCompactRows: Schema.optional(Schema.Boolean),
  /**
   * Open tasks only, ordered by whose move each is for the reader (`kinWorkMove`): Needs you,
   * Waiting on others, the rest; inside each, `kinWorkMoveOrder`. Answers `moves` and `counts`.
   */
  byMove: Schema.optional(Schema.Literal(true)),
});
export type KinWorkListInput = typeof KinWorkListInput.Type;

export const KinWorkMoveGroup = Schema.Literals(["needsYou", "waiting", "rest"]);
export type KinWorkMoveGroup = typeof KinWorkMoveGroup.Type;

/** A card waiting on the reader about a task, with what its buttons post (`kin.widgets.act`). */
export const KinWorkMoveCard = Schema.Struct({
  ...KinRecordWaiting.fields,
  revision: NonNegativeInt,
  options: Schema.Array(KinChoiceOption),
});
export type KinWorkMoveCard = typeof KinWorkMoveCard.Type;

/** Where a row of a `byMove` page sits for the reader, and the one step it carries. */
export const KinWorkRowMove = Schema.Struct({
  key: KinRecordKey,
  group: KinWorkMoveGroup,
  card: Schema.optional(KinWorkMoveCard),
  /** A late task someone else holds for the reader: the holder's latest note. */
  said: Schema.optional(KinText),
  /** When the reader last nudged its holder, if that was today. */
  nudgedAt: Schema.optional(IsoDateTime),
});
export type KinWorkRowMove = typeof KinWorkRowMove.Type;

/** Every match of a `byMove` read, not just the page; `doneRecently` is done in the last 14 days. */
export const KinWorkMoveCounts = Schema.Struct({
  needsYou: NonNegativeInt,
  waiting: NonNegativeInt,
  rest: NonNegativeInt,
  doneRecently: NonNegativeInt,
});
export type KinWorkMoveCounts = typeof KinWorkMoveCounts.Type;
/** Ordered open first, then soonest due, then key. `seq` is the change number the page is as of. */
export const KinWorkListResult = Schema.Struct({
  records: Schema.Array(KinRecord),
  total: NonNegativeInt,
  nextCursor: Schema.NullOr(Schema.String),
  seq: NonNegativeInt,
  asOf: IsoDateTime,
  /** Asked for with `totalsBy`: exact sums per currency of every match, not of this page. */
  totals: Schema.optional(KinListTotals),
  /** With `acceptCompactRows`, `records` is empty and the page is here. */
  rows: Schema.optional(Schema.Array(KinRecordCompact)),
  /** What the reader may do to every row in `rows` that carries no `can` of its own. */
  can: Schema.optional(KinRecordCan),
  /** Asked for with `byMove`: one per row of this page. */
  moves: Schema.optional(Schema.Array(KinWorkRowMove)),
  counts: Schema.optional(KinWorkMoveCounts),
});
export type KinWorkListResult = typeof KinWorkListResult.Type;

/** The reader asks whoever holds a task they asked for where it stands: once a day per task. */
export const KinWorkNudgeInput = Schema.Struct({ orgId: KinOrgId, key: KinRecordKey });
export type KinWorkNudgeInput = typeof KinWorkNudgeInput.Type;
export const KinWorkNudgeResult = Schema.Struct({
  key: KinRecordKey,
  nudgedAt: IsoDateTime,
  /** It had already gone today; nothing more was sent. */
  already: Schema.Boolean,
});
export type KinWorkNudgeResult = typeof KinWorkNudgeResult.Type;

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
 * change. A client with a list, entry or count open refetches it, debounced. Numbers are the
 * viewer's own: a teammate's count only changes to tasks they could see, so compare a number only
 * with others from the same session (summary, list, entry and these events share one count).
 */
export const KinWorkSubscribeInput = Schema.Struct({
  orgId: KinOrgId,
  /**
   * Send each change as the entry itself, as this viewer's `kin.work.list` shows it (`upsert`,
   * `removed`), and the counts that moved (`counts`), in place of `changed`. An older host ignores it.
   */
  acceptRows: Schema.optional(Schema.Boolean),
  /** With `acceptRows`: the `seq` of the last `counts` or `synchronized` held, to resume after it. */
  afterSeq: Schema.optional(NonNegativeInt),
  /** That number was a teammate's own (its event said `team`), not the company's. */
  afterTeam: Schema.optional(Schema.Boolean),
});
export type KinWorkSubscribeInput = typeof KinWorkSubscribeInput.Type;
const KinWorkOwnerCounts = Schema.Struct({ owner: KinWorkPrincipal, ...KinWorkCounts });
export const KinWorkEvent = Schema.Union([
  Schema.TaggedStruct("changed", {
    seq: NonNegativeInt,
    /** The entry that changed; absent on the first event, which is only the latest number. */
    key: Schema.optional(KinRecordKey),
    /** The entry's list, so a client reads again only what that list can change. */
    list: Schema.optional(KinListId),
  }),
  // `acceptRows` only, numbered as `changed` is: a teammate's numbers count only what they see.
  /** The entry as the viewer's list read shows it now; `fresh` when they could not see it before. */
  Schema.TaggedStruct("upsert", {
    seq: NonNegativeInt,
    list: KinListId,
    record: KinRecordCompact,
    fresh: Schema.optional(Schema.Literal(true)),
  }),
  /** An entry the viewer held is gone from their sight; never sent for one they never saw. */
  Schema.TaggedStruct("removed", {
    seq: NonNegativeInt,
    key: KinRecordKey,
    list: Schema.optional(KinListId),
  }),
  /**
   * The counts as `kin.work.summary` answers them at `seq`: the totals always, and of the rest only
   * what moved since the last `counts` (`kinApplyWorkCounts`), all of it with `whole`.
   */
  Schema.TaggedStruct("counts", {
    seq: NonNegativeInt,
    /** `seq` is the viewer's own number, a teammate's; absent for the company's. */
    team: Schema.optional(Schema.Literal(true)),
    asOf: IsoDateTime,
    ...KinWorkCounts,
    closed: Schema.optional(NonNegativeInt),
    whole: Schema.optional(Schema.Literal(true)),
    owners: Schema.optional(Schema.Array(KinWorkOwnerCounts)),
    ownersGone: Schema.optional(Schema.Array(KinWorkPrincipal)),
    parties: KinWorkSummary.fields.parties,
    projects: KinWorkSummary.fields.projects,
  }),
  /** Everything up to `seq` was sent and the counts held are current: the cursor to resume from. */
  Schema.TaggedStruct("synchronized", {
    seq: NonNegativeInt,
    team: Schema.optional(Schema.Literal(true)),
  }),
  /**
   * The gap can't be replayed, or what this viewer may see changed shape: drop every held row and
   * read again. `seq` starts a new numbering, and may be lower than the last.
   */
  Schema.TaggedStruct("snapshot-required", {
    seq: NonNegativeInt,
    team: Schema.optional(Schema.Literal(true)),
  }),
]);
export type KinWorkEvent = typeof KinWorkEvent.Type;

/** The owner's "New": a short form. Long text belongs in chat. */
export const KinWorkCreateInput = Schema.Struct({
  orgId: KinOrgId,
  /** `milestones` adds a milestone to `project`; default a Work entry. */
  list: Schema.optional(Schema.Literal("milestones")),
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
  /** A task that comes back: when it closes, the next one is made from its due date. */
  repeat: Schema.optional(KinRepeatRule),
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

/**
 * The owner shares tasks with the team (`shared: true`) or takes them back. Every task that
 * existed before teammates could read Work is the owner's alone until he shares it.
 */
export const KinWorkShareInput = Schema.Struct({
  orgId: KinOrgId,
  keys: Schema.Array(KinRecordKey).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  shared: Schema.Boolean,
});
export type KinWorkShareInput = typeof KinWorkShareInput.Type;
export const KinWorkShareResult = Schema.Struct({ records: Schema.Array(KinRecord) });
export type KinWorkShareResult = typeof KinWorkShareResult.Type;

/**
 * Whoever holds an open task gives it back to whoever gave it to them, an agent or a person, with
 * an optional word on why. The agent that gave it is woken to give it to someone else.
 */
export const KinWorkHandBackInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  note: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(280))),
});
export type KinWorkHandBackInput = typeof KinWorkHandBackInput.Type;
export const KinWorkHandBackResult = Schema.Struct({ key: KinRecordKey, to: KinWorkPrincipal });
export type KinWorkHandBackResult = typeof KinWorkHandBackResult.Type;

/**
 * Anyone who sees an entry says something on it, with files they just uploaded. The holder is
 * told; nothing on the entry changes. A retry with the same `clientRequestId` returns the comment.
 */
export const KinWorkCommentInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  body: KinText.check(Schema.isMaxLength(KIN_RECORD_COMMENT_MAX)),
  attachments: Schema.optional(
    Schema.Array(KinAttachment).check(Schema.isMaxLength(KIN_RECORD_COMMENT_FILES_MAX)),
  ),
});
export type KinWorkCommentInput = typeof KinWorkCommentInput.Type;
export const KinWorkCommentResult = Schema.Struct({ comment: KinRecordComment });
export type KinWorkCommentResult = typeof KinWorkCommentResult.Type;
/** Its author takes a comment back, or the owner level any; it stays in place as removed. */
export const KinWorkCommentRemoveInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  commentId: TrimmedNonEmptyString,
});
export type KinWorkCommentRemoveInput = typeof KinWorkCommentRemoveInput.Type;
/** The page of an entry's comments before `beforeSeq`, oldest first. */
export const KinWorkCommentsInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  beforeSeq: NonNegativeInt,
});
export type KinWorkCommentsInput = typeof KinWorkCommentsInput.Type;

const KIN_RECORD_URL_MAX = 2_000;
/** "Add a link" on an entry: a web page, kept as a `url` link that relates to it. */
export const KinWorkLinkAddInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(KIN_RECORD_URL_MAX)),
  /** What the link reads as; the address itself when absent. */
  name: Schema.optional(KinText.check(Schema.isMaxLength(200))),
});
export type KinWorkLinkAddInput = typeof KinWorkLinkAddInput.Type;
/** Takes a `url` link off an entry; one already gone answers as removed. */
export const KinWorkLinkRemoveInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(KIN_RECORD_URL_MAX)),
});
export type KinWorkLinkRemoveInput = typeof KinWorkLinkRemoveInput.Type;
/** Sets a project's note for every task; empty words clear it. */
export const KinProjectNoteInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  body: KinText.check(Schema.isMaxLength(KIN_RECORD_COMMENT_MAX)),
});
export type KinProjectNoteInput = typeof KinProjectNoteInput.Type;
export const KinProjectNoteResult = Schema.Struct({ note: Schema.NullOr(KinProjectNote) });
export type KinProjectNoteResult = typeof KinProjectNoteResult.Type;
export const KinWorkCommentsResult = Schema.Struct({
  comments: Schema.Array(KinRecordComment),
  older: Schema.Boolean,
});
export type KinWorkCommentsResult = typeof KinWorkCommentsResult.Type;

/**
 * Every open task `from` holds goes to `to`, each recorded as one reassignment, and each person
 * told once. `keys` limits it to those (Undo gives back exactly what moved); `dryRun` only counts.
 * Anyone for their own tasks; the owner level for anyone's, an agent's included.
 */
export const KinWorkHandOverInput = Schema.Struct({
  orgId: KinOrgId,
  from: KinWorkPrincipal,
  to: KinWorkPrincipal,
  keys: Schema.optional(Schema.Array(KinRecordKey).check(Schema.isMaxLength(500))),
  dryRun: Schema.optional(Schema.Boolean),
});
export type KinWorkHandOverInput = typeof KinWorkHandOverInput.Type;
export const KinWorkHandOverResult = Schema.Struct({
  /** What moved, or with `dryRun` what would. */
  keys: Schema.Array(KinRecordKey),
  /** Tasks that stayed: the write refused them for this caller. */
  kept: NonNegativeInt,
});
export type KinWorkHandOverResult = typeof KinWorkHandOverResult.Type;

/** Keep a lead's suggested entry (`confirm`), or decline it, which drops it. */
export const KinWorkConfirmInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  rev: NonNegativeInt,
});
export type KinWorkConfirmInput = typeof KinWorkConfirmInput.Type;

// The light CRM. A client page and a project page each come whole from one call: no joins or
// arithmetic on the client. Everything is computed on read from entries and their change logs.

/** India's 15-character GST number. */
export const KIN_GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const KinGstin = Schema.String.check(Schema.isPattern(KIN_GSTIN_PATTERN));
/** GST state codes, as the first two digits of a GSTIN, and their states. */
export const KIN_GST_STATES: Readonly<Record<string, string>> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
};

/** Fields sensitive whatever the entry's own label: contact details and commercial terms. */
export const KIN_SENSITIVE_FIELDS = {
  clients: ["terms"],
  contacts: ["email", "phone"],
  projects: ["value"],
} as const;
const SensitiveFields = Schema.Array(TrimmedNonEmptyString);
const Name = KinTrimmedText.check(Schema.isMaxLength(200));
const Notes = KinText.check(Schema.isMaxLength(4_000));
const ShortText = KinTrimmedText.check(Schema.isMaxLength(200));
const RequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
const Address = KinTrimmedText.check(Schema.isMaxLength(500));
const PlaceOfSupply = KinTrimmedText.check(Schema.isMaxLength(60));
const PageLimit = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(KIN_RECORDS_PAGE_CAP),
);
const PageCursor = Schema.String.check(Schema.isMaxLength(200));
/** Where a client or prospect came from, in the company's own words. */
const Source = KinTrimmedText.check(Schema.isMaxLength(120));
/** A client's own words for it, the company's to choose. */
export const KinPartyTag = KinTrimmedText.check(Schema.isMaxLength(60));
const Tags = Schema.Array(KinPartyTag).check(Schema.isMaxLength(20));
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
  /** The latest contact Kin knows of (`KinClientTouch`); absent from hosts before contact logs. */
  lastContactAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** A company we haven't sold to yet; `kind` stays `client`, so an older app shows a client. */
  prospect: Schema.optional(Schema.Literal(true)),
  /** Where it came from. */
  source: Schema.optional(Source),
  tags: Schema.optional(Tags),
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
  /** Its GSTIN, when it has one; its invoices are taxed by its state. */
  gstin: Schema.NullOr(KinText),
  /** Where it is supplied: an Indian state, or a country outside India for an export. */
  placeOfSupply: Schema.NullOr(KinText),
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
export const KIN_PROJECT_BILLING = ["fixed", "hourly", "retainer"] as const;
export const KinProjectBilling = Schema.Literals(KIN_PROJECT_BILLING);
export type KinProjectBilling = typeof KinProjectBilling.Type;
export const KinProjectDetail = Schema.Struct({
  ...KinProjectRow.fields,
  notes: KinText,
  repos: Schema.Array(KinRepoName),
  // Absent from hosts before the project spine.
  billing: Schema.optional(Schema.NullOr(KinProjectBilling)),
  value: Schema.optional(Schema.NullOr(KinMoney)),
  startsOn: Schema.optional(Schema.NullOr(KinDay)),
  /** A retainer's next renewal day. */
  renewsOn: Schema.optional(Schema.NullOr(KinDay)),
  /** The people and agents on it besides its lead (`owner`). Membership only; it grants nothing. */
  members: Schema.optional(Schema.Array(KinWorkPrincipal)),
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
/** What someone logged by hand or a lead was told of. */
export const KinTouchKind = Schema.Literals(["call", "meeting", "email", "message", "other"]);
export type KinTouchKind = typeof KinTouchKind.Type;
/**
 * One contact with a client: logged, or what Kin already knows (an invoice or quote issued, a
 * payment received, a meeting that has passed). A chat mentioning them is not one.
 */
export const KinClientTouch = Schema.Struct({
  /** A logged one's id; Kin's own are `record:<key>` or `payment:<id>` and can't be removed. */
  id: TrimmedNonEmptyString,
  at: IsoDateTime,
  kind: Schema.Literals([...KinTouchKind.literals, "invoice", "quote", "payment"]),
  note: KinText,
  /** Who on our side, by name, when known. */
  who: Schema.NullOr(KinTrimmedText),
  logged: Schema.Boolean,
  /** The entry it comes from, for Kin's own. */
  record: Schema.NullOr(KinRecordRef),
});
export type KinClientTouch = typeof KinClientTouch.Type;

/**
 * What the reader may do on a client page, decided by the checks its writes run. `edit`: name,
 * notes, came from, tags, prospect or client, and contacts. `owner`: terms, tax, who looks after
 * it, Keep private and closing it. Absent from hosts before prospects: the owner level does all.
 */
export const KinPartyCan = Schema.Struct({
  edit: Schema.Boolean,
  log: Schema.Boolean,
  owner: Schema.Boolean,
});
export type KinPartyCan = typeof KinPartyCan.Type;

/** The client page. `weOwe` is soonest due first; `theyOwe` is overdue first, then soonest. */
export const KinPartyPage = Schema.Struct({
  party: KinPartyDetail,
  /** Active first, then by name. */
  contacts: Schema.Array(KinContact),
  /** Open first, then by target date. */
  projects: Schema.Array(KinProjectRow),
  weOwe: Capped(KinRecord),
  theyOwe: Capped(KinRecord),
  /** Newest first, a few; absent from hosts before contact logs. */
  touches: Schema.optional(Schema.Array(KinClientTouch)),
  can: Schema.optional(KinPartyCan),
  seq: NonNegativeInt,
  asOf: IsoDateTime,
});
export type KinPartyPage = typeof KinPartyPage.Type;

export const KinProjectPageInput = KinRecordLookup;
export type KinProjectPageInput = typeof KinProjectPageInput.Type;
/** A milestone with its tasks' progress. `atRisk`: due within a week with late or later work. */
export const KinMilestone = Schema.Struct({
  ...KinRecordRef.fields,
  state: KinRecordState,
  dueAt: Schema.NullOr(IsoDateTime),
  dueAllDay: Schema.Boolean,
  total: NonNegativeInt,
  done: NonNegativeInt,
  late: Schema.Boolean,
  atRisk: Schema.Boolean,
  rev: NonNegativeInt,
});
export type KinMilestone = typeof KinMilestone.Type;
/** A task made from a doc section that has changed since the task was written from it. */
export const KinSpecChange = Schema.Struct({
  record: KinRecordRef,
  doc: KinRecordRef,
  section: Schema.String,
  /** The section is no longer in the doc. */
  gone: Schema.Boolean,
});
export type KinSpecChange = typeof KinSpecChange.Type;
/** One person or agent on the project, with what they hold in it. */
export const KinProjectPerson = Schema.Struct({
  who: KinWorkPrincipal,
  lead: Schema.Boolean,
  member: Schema.Boolean,
  open: NonNegativeInt,
  late: NonNegativeInt,
});
export type KinProjectPerson = typeof KinProjectPerson.Type;
/** Money against the project, per currency: never summed across currencies. */
export const KinProjectMoney = Schema.Struct({
  quoted: Schema.Array(KinMoney),
  invoiced: Schema.Array(KinMoney),
  received: Schema.Array(KinMoney),
  unpaid: Schema.Array(KinMoney),
});
export type KinProjectMoney = typeof KinProjectMoney.Type;

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
  // Absent from hosts before the project spine.
  /** By due date, undated last. */
  milestones: Schema.optional(Schema.Array(KinMilestone)),
  /** Its lead, members, then anyone else holding its open tasks. */
  people: Schema.optional(Schema.Array(KinProjectPerson)),
  /** Meetings from a day ago onwards, soonest first; a passed one stays until it is closed. */
  meetings: Schema.optional(Schema.Array(KinRecord)),
  specChanged: Schema.optional(Schema.Array(KinSpecChange)),
  money: Schema.optional(KinProjectMoney),
  /** What this reader may change on it; absent from older hosts. */
  can: Schema.optional(
    Schema.Struct({
      people: Schema.Boolean,
      /** Set or clear its note for every task; absent from older hosts. */
      note: Schema.optional(Schema.Boolean),
    }),
  ),
  /** Its note for every task; absent with none, and from older hosts. */
  note: Schema.optional(KinProjectNote),
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
  /** `client` lists clients alone, without prospects. */
  kind: Schema.optional(KinPartyKind),
  /** Only prospects. */
  prospect: Schema.optional(Schema.Literal(true)),
  /** Only those this person or agent looks after. */
  owner: Schema.optional(KinWorkPrincipal),
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
  /** Only the projects this person leads or is on. */
  person: Schema.optional(KinPersonId),
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
  /** A prospect: a client we haven't sold to yet. */
  prospect: Schema.optional(Schema.Boolean),
  source: Schema.optional(Source),
  tags: Schema.optional(Tags),
  /** Defaults to the owner. Looking after a client is not an instruction to a lead. */
  owner: Schema.optional(KinWorkPrincipal),
  notes: Schema.optional(Notes),
  terms: Schema.optional(Notes),
  address: Schema.optional(Address),
  gstin: Schema.optional(KinGstin),
  /** A state from `KIN_GST_STATES`, or a country for an export. */
  placeOfSupply: Schema.optional(PlaceOfSupply),
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
  /** `true` makes a client a prospect, `false` a prospect a client; both are logged. */
  prospect: Schema.optional(Schema.Boolean),
  /** `null` clears. */
  source: Schema.optional(Schema.NullOr(Source)),
  /** The whole list; empty clears it. */
  tags: Schema.optional(Tags),
  owner: Schema.optional(KinWorkPrincipal),
  notes: Schema.optional(Notes),
  /** `null` clears. */
  terms: Schema.optional(Schema.NullOr(Notes)),
  /** `null` clears. */
  address: Schema.optional(Schema.NullOr(Address)),
  /** `null` clears these two. */
  gstin: Schema.optional(Schema.NullOr(KinGstin)),
  placeOfSupply: Schema.optional(Schema.NullOr(PlaceOfSupply)),
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
export const KinTouchLogInput = Schema.Struct({
  orgId: KinOrgId,
  party: KinRecordKey,
  kind: KinTouchKind,
  /** When it happened; now if left out. */
  at: Schema.optional(IsoDateTime),
  note: Schema.optional(Notes),
  /** The follow-up it leaves: a task we owe them, held by whoever logs it, made in the same step. */
  next: Schema.optional(
    Schema.Struct({
      title: KinTrimmedText.check(Schema.isMaxLength(280)),
      dueAt: Schema.optional(IsoDateTime),
      dueAllDay: Schema.optional(Schema.Boolean),
    }),
  ),
  clientRequestId: RequestId,
});
export type KinTouchLogInput = typeof KinTouchLogInput.Type;
export const KinTouchRemoveInput = Schema.Struct({
  orgId: KinOrgId,
  touchId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
});
export type KinTouchRemoveInput = typeof KinTouchRemoveInput.Type;
export const KinTouchRemoveResult = Schema.Struct({ removed: Schema.Boolean });
export type KinTouchRemoveResult = typeof KinTouchRemoveResult.Type;
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
  billing: Schema.optional(Schema.NullOr(KinProjectBilling)),
  /** `null` clears. */
  value: Schema.optional(Schema.NullOr(KinMoney)),
  startsOn: Schema.optional(Schema.NullOr(KinDay)),
  renewsOn: Schema.optional(Schema.NullOr(KinDay)),
  members: Schema.optional(Schema.Array(KinWorkPrincipal).check(Schema.isMaxLength(50))),
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
  billing: Schema.optional(Schema.NullOr(KinProjectBilling)),
  /** `null` clears. */
  value: Schema.optional(Schema.NullOr(KinMoney)),
  startsOn: Schema.optional(Schema.NullOr(KinDay)),
  renewsOn: Schema.optional(Schema.NullOr(KinDay)),
  members: Schema.optional(Schema.Array(KinWorkPrincipal).check(Schema.isMaxLength(50))),
  notes: Schema.optional(Notes),
  sensitive: Schema.optional(Schema.Boolean),
  state: Schema.optional(KinProjectState),
});
export type KinProjectUpdateInput = typeof KinProjectUpdateInput.Type;
/** Puts people and agents on a project or takes them off: its owner, a co-owner or its lead. */
export const KinProjectPeopleInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  add: Schema.optional(Schema.Array(KinWorkPrincipal).check(Schema.isMaxLength(50))),
  remove: Schema.optional(Schema.Array(KinWorkPrincipal).check(Schema.isMaxLength(50))),
});
export type KinProjectPeopleInput = typeof KinProjectPeopleInput.Type;
export const KinProjectPeopleResult = Schema.Struct({
  key: KinRecordKey,
  rev: NonNegativeInt,
  members: Schema.Array(KinWorkPrincipal),
});
export type KinProjectPeopleResult = typeof KinProjectPeopleResult.Type;

export const KIN_WORK_WS_METHODS = {
  summary: "kin.work.summary",
  list: "kin.work.list",
  get: "kin.work.get",
  subscribe: "kin.work.subscribe",
  create: "kin.work.create",
  assign: "kin.work.assign",
  handBack: "kin.work.handBack",
  nudge: "kin.work.nudge",
  handOver: "kin.work.handOver",
  update: "kin.work.update",
  confirm: "kin.work.confirm",
  decline: "kin.work.decline",
  share: "kin.work.share",
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
  projectPeople: "kin.work.projectPeople",
  logTouch: "kin.work.logTouch",
  removeTouch: "kin.work.removeTouch",
  comment: "kin.work.comment",
  commentRemove: "kin.work.commentRemove",
  comments: "kin.work.comments",
  linkAdd: "kin.work.linkAdd",
  linkRemove: "kin.work.linkRemove",
  projectNote: "kin.work.projectNote",
} as const;

const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
// Tasks reach a teammate's session too, and the server shows them only their view of them
// (`teamView.ts`); clients, projects, confirming and sharing are the owner's.
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
  Rpc.make(KIN_WORK_WS_METHODS.handBack, {
    payload: KinWorkHandBackInput,
    success: KinWorkHandBackResult,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.nudge, {
    payload: KinWorkNudgeInput,
    success: KinWorkNudgeResult,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.comment, {
    payload: KinWorkCommentInput,
    success: KinWorkCommentResult,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.commentRemove, {
    payload: KinWorkCommentRemoveInput,
    success: KinWorkCommentResult,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.comments, {
    payload: KinWorkCommentsInput,
    success: KinWorkCommentsResult,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.linkAdd, {
    payload: KinWorkLinkAddInput,
    success: KinRecordDetail,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.linkRemove, {
    payload: KinWorkLinkRemoveInput,
    success: KinRecordDetail,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.projectNote, {
    payload: KinProjectNoteInput,
    success: KinProjectNoteResult,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.handOver, {
    payload: KinWorkHandOverInput,
    success: KinWorkHandOverResult,
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
  Rpc.make(KIN_WORK_WS_METHODS.share, {
    payload: KinWorkShareInput,
    success: KinWorkShareResult,
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
  Rpc.make(KIN_WORK_WS_METHODS.projectPeople, {
    payload: KinProjectPeopleInput,
    success: KinProjectPeopleResult,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.logTouch, {
    payload: KinTouchLogInput,
    success: KinClientTouch,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.removeTouch, {
    payload: KinTouchRemoveInput,
    success: KinTouchRemoveResult,
    error,
  }),
] as const;

export const KIN_WORK_RPC_SCOPES = {
  // A teammate's session reaches tasks; the service shows them their view and changes only theirs.
  [KIN_WORK_WS_METHODS.summary]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.list]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.get]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.subscribe]: AuthKinChatScope,
  // Giving a lead work wakes it as a message to it does: a teammate's runs as theirs, within
  // their daily turns, in their own chat with it (`KinRecords.teammateWake`).
  [KIN_WORK_WS_METHODS.create]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.assign]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.handBack]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.nudge]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.handOver]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.comment]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.commentRemove]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.comments]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.linkAdd]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.linkRemove]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.projectNote]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.update]: AuthKinChatScope,
  // Keeping a lead's suggestion makes it the owner's word; only he does that, or shares.
  [KIN_WORK_WS_METHODS.confirm]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.decline]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.share]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.parties]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.party]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.projects]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.project]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.history]: AuthKinChatScope,
  // Writes like the entry edits beside them; none of these starts agent work.
  [KIN_WORK_WS_METHODS.createParty]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.updateParty]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.createContact]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.updateContact]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.createProject]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.updateProject]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.projectPeople]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.logTouch]: AuthKinChatScope,
  [KIN_WORK_WS_METHODS.removeTouch]: AuthKinChatScope,
} as const;
