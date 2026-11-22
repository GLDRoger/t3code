import { KinEventId, type KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import { ownerLevelSql } from "../people/KinAccess.ts";

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

/** A sent-up draft's card text from its stored payload: who asks, the draft, then Kin's line. */
export const draftDetail = (head: string, draft: Pick<StoredDraft, "text" | "line">) =>
  `${head}\n\n${draft.text}\n\n${draft.line}`;

/** The card's last line: what it is, where a post goes, and for whom. */
export const draftLine = (kind: DraftKind, on: string | undefined, party: string | undefined) => {
  const word = DRAFT_WORDS[kind];
  const what = `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
  if (on === undefined) return party === undefined ? what : `${what} for ${party}`;
  return party === undefined ? `${what} for ${on}` : `${what} for ${on}, for ${party}`;
};

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
    Schema.Struct({ kind: Schema.Literal("post"), cardId: Schema.String }),
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
  const draft = row === undefined ? undefined : Option.getOrUndefined(decodeStoredDraft(row.draft));
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
 * What a write in this wake makes under its approval, if it is the approved kind's first: a doc for
 * a proposal or client terms, the mail's Confirm card for a mail, the week's card for a post.
 */
export const madeUnderApproval = Effect.fn("KinApproval.madeUnder")(function* (
  turn: Turn,
  made: Made,
) {
  const approval = yield* approvedFor(turn);
  if (approval === undefined || approval.made !== null) return;
  const kind = approval.draft.kind;
  const fits =
    made.kind === "doc"
      ? kind === "proposal" || kind === "terms"
      : made.kind === "mail"
        ? kind === "mail"
        : made.kind === "post"
          ? kind === "post"
          : false;
  if (fits) yield* recordMade(turn.orgId, approval.questionId, made);
});
