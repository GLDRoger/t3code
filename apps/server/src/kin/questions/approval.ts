import {
  kinApproveOpeningNote,
  type KinDocKind,
  KinEventId,
  type KinOrgId,
  KinPersonId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import { ownerLevelSql } from "../people/KinAccess.ts";
import { PLATFORM_RULES } from "../social/rows.ts";
import { MAIL_BODY_MAX, NOTES_MAX } from "../textLimits.ts";

/** What a teammate's draft sent up to the owner is (`askPerson`'s `draft`). */
export const DRAFT_KINDS = ["proposal", "quote", "invoice", "terms", "mail", "post"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

/** Each kind in a person's words: the card's line, the teammate's line, the turn's data. */
export const DRAFT_WORDS: Record<DraftKind, string> = {
  proposal: "proposal",
  terms: "client terms",
  quote: "quote",
  invoice: "invoice",
  mail: "mail",
  post: "post",
};

/** An approved quote or invoice whose entry names another client than its card did. */
export const approvedClient = (title: string) =>
  `Nothing was made: the approved draft is for ${title}, so make the entry for that client.`;

/** The one list an approved quote or invoice is made on; every other kind makes no entry. */
export const DRAFT_LIST: Partial<Record<DraftKind, "quotes" | "invoices">> = {
  quote: "quotes",
  invoice: "invoices",
};

/**
 * The draft on its question, as the card showed it when it was asked: names, kind, party and the
 * card's own line are fixed then, never looked up again.
 */
const StoredDraftJson = Schema.fromJsonString(
  Schema.Struct({
    kind: Schema.Literals(DRAFT_KINDS),
    for: Schema.NullOr(
      Schema.Struct({
        key: Schema.String,
        title: Schema.String,
        recordId: Schema.String,
        list: Schema.Literals(["clients", "deals"]),
        partyId: Schema.NullOr(Schema.String),
      }),
    ),
    text: Schema.String,
    line: Schema.String,
    /** A post's service, by name, as the card's line said it. */
    on: Schema.optional(Schema.String),
    /** The owner's redraft (`redo`): on her card only, never held to the teammate. */
    redo: Schema.optional(Schema.Literal(true)),
    /**
     * A long draft: `text` is its opening, and the draft is this version of this doc, which an
     * Approve approves only while the doc is still at it (`draftMoved`).
     */
    doc: Schema.optional(
      Schema.Struct({
        recordId: Schema.String,
        key: Schema.String,
        version: Schema.Number,
        chars: Schema.Number,
      }),
    ),
    names: Schema.Struct({ owner: Schema.String, asker: Schema.String, agent: Schema.String }),
  }),
);
export type StoredDraft = typeof StoredDraftJson.Type;
export const encodeStoredDraft = Schema.encodeEffect(StoredDraftJson);
export const decodeStoredDraft = Schema.decodeOption(StoredDraftJson);

/** A sent-up draft's card buttons, Kin's own: its Approve is the one of kind yes. */
export const DRAFT_OPTIONS = [
  { label: "Approve", kind: "yes" },
  { label: "Changes first", kind: "no" },
] as const;
/** The answer a sent-up draft's "no" stores. */
export const CHANGES_FIRST = DRAFT_OPTIONS[1].label;

/** A sent-up draft's card text from its stored payload: who asks, the draft, then Kin's line. */
export const draftDetail = (head: string, draft: Pick<StoredDraft, "text" | "line" | "doc">) =>
  `${head}\n\n${draft.text}\n\n${draft.doc === undefined ? "" : `${kinApproveOpeningNote(draft.doc.key)}\n\n`}${draft.line}`;

/** The card's own fields for a long draft's doc and version; none for a short one. */
export const draftDocOf = (draft: Pick<StoredDraft, "doc">) =>
  draft.doc === undefined
    ? {}
    : {
        draftDoc: {
          recordId: draft.doc.recordId,
          key: draft.doc.key,
          version: draft.doc.version,
        },
      };

/** Why an Approve on a long draft finds its doc no longer as it went up: gone, deleted, or moved on. */
export const draftMoved = Effect.fn("KinApproval.draftMoved")(function* (
  orgId: string,
  draft: Pick<StoredDraft, "doc">,
) {
  if (draft.doc === undefined) return false;
  const sql = yield* SqlClient.SqlClient;
  const [doc] = yield* sql<{ state: string; version: number | null }>`SELECT r.state,
      (SELECT MAX(v.version) FROM kin_doc_versions v
        WHERE v.org_id = r.org_id AND v.record_id = r.record_id) AS version
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.record_id = ${draft.doc.recordId} AND r.register_id = 'docs'`;
  return doc === undefined || doc.state === "dropped" || doc.version !== draft.doc.version;
});

/** The draft with its whole text: a long one's from its doc at the version that went up. */
export const wholeDraft = Effect.fn("KinApproval.wholeDraft")(function* (
  orgId: string,
  draft: StoredDraft,
) {
  if (draft.doc === undefined) return draft;
  const sql = yield* SqlClient.SqlClient;
  const [version] = yield* sql<{ body: string }>`SELECT body FROM kin_doc_versions
    WHERE org_id = ${orgId} AND record_id = ${draft.doc.recordId}
      AND version = ${draft.doc.version} AND body_kind = 'markdown'`;
  return version === undefined ? undefined : { ...draft, text: version.body };
});

/** The card's last line: what it is, where a post goes, and for whom. */
export const draftLine = (kind: DraftKind, on: string | undefined, party: string | undefined) => {
  const word = DRAFT_WORDS[kind];
  const what = `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
  if (on === undefined) return party === undefined ? what : `${what} for ${party}`;
  return party === undefined ? `${what} for ${on}` : `${what} for ${on}, for ${party}`;
};

/** Text as compared with an approved draft: line endings and the space around it aside. */
const asWords = (text: string) => text.replace(/\r\n?/g, "\n").trim();
/** Whether what a make writes is the approved draft's text, word for word and nothing else. */
export const keepsDraft = (made: unknown, draft: string) =>
  typeof made === "string" && asWords(made) === asWords(draft);

const HEADER = /^(subject|to|cc):[ \t]*(.*)$/i;
const ADDRESS = /[^\s<>(),;"']+@[^\s<>(),;"']+/g;
const addresses = (values: ReadonlyArray<string>) =>
  new Set(values.flatMap((value) => value.toLowerCase().match(ADDRESS) ?? []));
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((one) => b.has(one));
/** A draft filed as a doc opens with its section's title ("## Mail"), which is not the mail's. */
const TITLE = /^#{1,6}[ \t]+[^\n]*\n[ \t]*\n/;
const untitled = (draft: string) => asWords(draft).replace(TITLE, "");

/**
 * A mail draft's own heading: consecutive `Subject:`, `To:` or `Cc:` lines at its very start,
 * ended by its first blank line, and the rest below it. Undefined when it opens with none.
 */
const headingOf = (draft: string) => {
  const lines = untitled(draft).split("\n");
  const blank = lines.findIndex((line) => line.trim() === "");
  if (blank <= 0) return undefined;
  const fields = lines.slice(0, blank).map((line) => HEADER.exec(line));
  if (fields.some((field) => field === null)) return undefined;
  const values = (name: string) =>
    fields.flatMap((field) => (field![1]!.toLowerCase() === name ? [field![2]!.trim()] : []));
  return {
    subject: values("subject"),
    to: values("to"),
    cc: values("cc"),
    rest: lines.slice(blank + 1).join("\n"),
  };
};

const count = (n: number) => n.toLocaleString("en-US");
/**
 * Why a draft's destination would refuse its whole text, by the limits Kin already holds: a post's
 * caption on its service, a mail's body, a quote's or invoice's notes. Undefined when it fits.
 */
export const destinationRefusal = (kind: DraftKind, text: string, on?: string) => {
  if (kind === "post") {
    const rule = Object.values(PLATFORM_RULES).find((one) => one.label === on);
    const length = asWords(text).length;
    return rule === undefined || length <= rule.caption
      ? undefined
      : `This post is ${count(length)} characters, and ${rule.label} takes at most ${count(rule.caption)}. Shorten it, then send it again.`;
  }
  if (kind === "mail") {
    const length = asWords(headingOf(text)?.rest ?? text).length;
    return length <= MAIL_BODY_MAX
      ? undefined
      : `This mail is ${count(length)} characters, and a mail holds at most ${count(MAIL_BODY_MAX)}. Shorten it, then send it again.`;
  }
  if (kind === "quote" || kind === "invoice") {
    const length = asWords(text).length;
    return length <= NOTES_MAX
      ? undefined
      : `This ${DRAFT_WORDS[kind]} is ${count(length)} characters, and its notes hold at most ${count(NOTES_MAX)}. Shorten it, then send it again.`;
  }
  return undefined;
};

/**
 * Whether a prepared mail is its approved draft. With no heading, the body is the whole draft and
 * the subject is free. With one, the body is the rest; a send's subject is its `Subject:` value;
 * a `To:` or `Cc:` naming addresses names the mail's own. A reply's subject is its thread's.
 */
export const mailKeepsDraft = (
  mail: {
    readonly to: ReadonlyArray<string>;
    readonly cc: ReadonlyArray<string>;
    readonly subject: string;
    readonly body: string;
  },
  draft: string,
  reply: boolean,
) => {
  const heading = headingOf(draft);
  if (heading === undefined)
    return keepsDraft(mail.body, draft) || keepsDraft(mail.body, untitled(draft));
  if (!keepsDraft(mail.body, heading.rest) && !(reply && keepsDraft(mail.body, draft)))
    return false;
  if (!reply && heading.subject.some((subject) => subject !== mail.subject.trim())) return false;
  const named = (said: ReadonlyArray<string>, sent: ReadonlyArray<string>) => {
    const wanted = addresses(said);
    return wanted.size === 0 || sameSet(wanted, addresses(sent));
  };
  return named(heading.to, mail.to) && named(heading.cc, mail.cc);
};

/** The kinds Kin writes itself on the owner's Approve, word for word and with no turn: a doc each. */
const WRITTEN: Partial<Record<DraftKind, KinDocKind>> = { proposal: "proposal", terms: "other" };
export const writtenDocKind = (kind: DraftKind) => WRITTEN[kind];
export const writtenOnApprove = (kind: DraftKind) => WRITTEN[kind] !== undefined;
/** The origin of the doc an Approve wrote: one per question, so a retry finds it. */
export const approvedDocOrigin = (questionId: string) => `approved-draft:${questionId}`;

/** The one thing an approval made, recorded against it at its write (`recordMade`). */
const MadeJson = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("entry"),
      recordId: Schema.String,
      key: Schema.String,
      list: Schema.String,
    }),
    Schema.Struct({ kind: Schema.Literal("doc"), recordId: Schema.String, key: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("mail"), askId: Schema.String }),
    // The saved post (`postId`), then the week card that carries it alone (`cardId`).
    Schema.Struct({
      kind: Schema.Literal("post"),
      postId: Schema.optional(Schema.String),
      cardId: Schema.optional(Schema.String),
    }),
  ]),
);
export type Made = typeof MadeJson.Type;
const encodeMade = Schema.encodeEffect(MadeJson);
const decodeMade = Schema.decodeOption(MadeJson);

const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

/** The id and dedupe key of the one event an Approve writes (`approveDraft`); nothing else is one. */
export const approvalEventId = (orgId: string, questionId: string) =>
  KinEventId.make(`question_${hash(`${orgId}\0${questionId}\0approved`).slice(0, 32)}`);
export const approvalDedupeKey = (questionId: string) => `question-approved:${questionId}`;
/** The id of the turn an answer to a question asked for a chat queues there (`sendBack`). */
export const answeredEventId = (orgId: string, questionId: string) =>
  KinEventId.make(`question_${hash(`${orgId}\0${questionId}\0answered`).slice(0, 32)}`);

export type Approval = {
  readonly questionId: string;
  readonly agentId: string;
  readonly ownerId: KinPersonId;
  readonly askerId: KinPersonId;
  readonly forChatId: string;
  readonly question: string;
  readonly answer: string | null;
  readonly draft: StoredDraft;
  readonly made: Made | null;
};

type Turn = { readonly orgId: KinOrgId; readonly agentId: string; readonly wakeupId: string };

/**
 * What a wake runs for, read off its stored events: `none` when no event names an approval;
 * `approved` only when its one event is exactly the event `approveDraft` writes, for a question
 * still approved by the agent's owner, owner-level now; anything else naming one is `invalid`.
 */
export const approvalOf = Effect.fn("KinApproval.of")(function* (turn: Turn) {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* sql<{
    eventId: string;
    tag: string;
    dedupeKey: string | null;
    approved: number | null;
    json: string;
  }>`SELECT event_id AS "eventId", tag, dedupe_key AS "dedupeKey",
      json_extract(json, '$.subject.approved') AS approved, json
    FROM kin_events
    WHERE org_id = ${turn.orgId} AND agent_id = ${turn.agentId} AND wakeup_id = ${turn.wakeupId}
    ORDER BY event_id`;
  if (!events.some((one) => one.approved !== null)) return { _tag: "none" } as const;
  const invalid = { _tag: "invalid" } as const;
  const [event] = events;
  if (events.length !== 1 || event === undefined || event.tag !== "deferral.due") return invalid;
  const questionId = canonicalQuestion(event.json);
  if (
    questionId === undefined ||
    event.eventId !== approvalEventId(turn.orgId, questionId) ||
    event.dedupeKey !== approvalDedupeKey(questionId)
  )
    return invalid;
  const [row] = yield* sql<{
    questionId: string;
    ownerId: string;
    askerId: string;
    forChatId: string;
    question: string;
    answer: string | null;
    draft: string;
    made: string | null;
  }>`SELECT q.question_id AS "questionId", q.person_id AS "ownerId",
      q.for_person_id AS "askerId", q.for_chat_id AS "forChatId", q.question, q.answer,
      q.draft_json AS draft, q.draft_made_json AS made
    FROM kin_questions q
    JOIN kin_agents a ON a.org_id = q.org_id AND a.agent_id = q.agent_id AND a.retired_at IS NULL
    WHERE q.org_id = ${turn.orgId} AND q.question_id = ${questionId}
      AND q.agent_id = ${turn.agentId} AND q.state = 'answered' AND q.approved_at IS NOT NULL
      AND q.draft_json IS NOT NULL AND q.for_person_id IS NOT NULL AND q.for_chat_id IS NOT NULL
      AND q.person_id = a.owner_person_id
      AND ${sql.literal(ownerLevelSql("q.org_id", "q.person_id"))}`;
  const stored =
    row === undefined ? undefined : Option.getOrUndefined(decodeStoredDraft(row.draft));
  const draft = stored === undefined ? undefined : yield* wholeDraft(turn.orgId, stored);
  if (row === undefined || draft === undefined) return invalid;
  return {
    _tag: "approved",
    approval: {
      questionId: row.questionId,
      agentId: turn.agentId,
      ownerId: KinPersonId.make(row.ownerId),
      askerId: KinPersonId.make(row.askerId),
      forChatId: row.forChatId,
      question: row.question,
      answer: row.answer,
      draft,
      made: row.made === null ? null : Option.getOrNull(decodeMade(row.made)),
    } satisfies Approval,
  } as const;
});

const EventJson = Schema.fromJsonString(
  Schema.Struct({
    _tag: Schema.String,
    provenance: Schema.Struct({ _tag: Schema.String }),
    subject: Schema.Record(Schema.String, Schema.Unknown),
    origin: Schema.optional(Schema.Unknown),
    chatId: Schema.optional(Schema.Unknown),
  }),
);
const decodeEvent = Schema.decodeOption(EventJson);
const SUBJECT_KEYS = "answered,approved,questionId,type";

/** Exactly what `approveDraft` writes: from Kin, its subject and nothing more, for no other chat. */
const canonicalQuestion = (json: string) => {
  const event = Option.getOrUndefined(decodeEvent(json));
  if (event === undefined) return undefined;
  const { subject } = event;
  return event._tag === "deferral.due" &&
    event.provenance._tag === "system" &&
    event.origin === undefined &&
    event.chatId === undefined &&
    Object.keys(subject).toSorted().join(",") === SUBJECT_KEYS &&
    subject["type"] === "question" &&
    subject["answered"] === true &&
    subject["approved"] === true &&
    typeof subject["questionId"] === "string"
    ? subject["questionId"]
    : undefined;
};

/** The approval this wake runs for, or undefined: `approvalOf` when it is one. */
export const approvedFor = (turn: Turn) =>
  approvalOf(turn).pipe(Effect.map((of) => (of._tag === "approved" ? of.approval : undefined)));

/**
 * Records what an approval made, in the write's transaction, once: true when this is the one.
 * Callers record only what the approved kind makes.
 */
export const recordMade = Effect.fn("KinApproval.recordMade")(function* (
  orgId: KinOrgId,
  questionId: string,
  made: Made,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`UPDATE kin_questions SET draft_made_json = ${yield* encodeMade(made)}
    WHERE org_id = ${orgId} AND question_id = ${questionId} AND draft_made_json IS NULL
    RETURNING question_id`;
  return rows.length > 0;
});

/**
 * What a write in this wake makes under its approval, if it is the approved kind's first: the
 * mail's Confirm card for a mail, the saved post for a post.
 */
export const madeUnderApproval = Effect.fn("KinApproval.madeUnder")(function* (
  turn: Turn,
  made: Made,
) {
  const approval = yield* approvedFor(turn);
  if (approval === undefined || approval.made !== null) return;
  const kind = approval.draft.kind;
  if ((made.kind === "mail" && kind === "mail") || (made.kind === "post" && kind === "post"))
    yield* recordMade(turn.orgId, approval.questionId, made);
});

/** The post an approval in this wake saved and no card carries yet: what its week card may hold. */
export const boundPost = (turn: Turn) =>
  approvedFor(turn).pipe(
    Effect.map((approval) =>
      approval?.draft.kind !== "post"
        ? undefined
        : approval.made?.kind === "post" &&
            approval.made.postId !== undefined &&
            approval.made.cardId === undefined
          ? { questionId: approval.questionId, postId: approval.made.postId }
          : { questionId: approval.questionId, postId: undefined },
    ),
  );

/** The week card that carries an approval's bound post, recorded beside it once. */
export const recordPostCard = Effect.fn("KinApproval.recordPostCard")(function* (
  orgId: KinOrgId,
  questionId: string,
  postId: string,
  cardId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const was = yield* encodeMade({ kind: "post", postId });
  const rows = yield* sql`UPDATE kin_questions
    SET draft_made_json = ${yield* encodeMade({ kind: "post", postId, cardId })}
    WHERE org_id = ${orgId} AND question_id = ${questionId} AND draft_made_json = ${was}
    RETURNING question_id`;
  return rows.length > 0;
});
