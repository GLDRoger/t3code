import {
  formatKinWhen,
  KIN_DOC_CARD,
  KIN_TEXT_LOCALE,
  KinAgentId,
  KinChatError,
  KinChatId,
  type KinChoiceOutcome,
  KinEvent,
  KinEventId,
  KinMessageId,
  type KinOrgId,
  KinPersonId,
  type KinWidget,
  KinWidgetId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import { storedClientId } from "../chat/KinChatRepository.ts";
import type { KinChatService } from "../chat/KinChatService.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { effectiveAudience, turnAsker, turnChat } from "../lead/Audience.ts";
import { isOrgPaused } from "../lead/orgState.ts";
import * as Reach from "../lead/Reach.ts";
import { stampEvent, storedStamp } from "../lead/OutsideContent.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import { signedIn } from "../people/signedIn.ts";
import { holdFor } from "../triggers/quietHold.ts";
import { storedWorkHours } from "../triggers/quietHours.ts";
import type * as CardActions from "../widgets/cardActions.ts";
import {
  type AnsweredPlan,
  type CardPlan,
  plansOf,
  sealPlans,
  sealedOptions,
  takesAsDefault,
} from "../widgets/cardPlans.ts";
import { holdOverAbout, refusalText } from "../pulse/holds.ts";
import { choiceCardState } from "../widgets/choiceCard.ts";
import type { KinRecords } from "../work/KinRecords.ts";
import { ownerZone } from "../work/recordRows.ts";
import { unreadableBy } from "../work/teamView.ts";
import { allLists } from "../work/registers.ts";
import { leadNamer } from "../work/toolNames.ts";
import {
  dayWord,
  defaultDue,
  endingQuestion,
  namedDue,
  normaliseAbout,
  normaliseIntent,
  raiseAt,
  repeats,
  unsafeDefault,
} from "./rules.ts";
import { TAKEN_KEY, tellDeclined, tellTaken, tellWithdrawn } from "./defaultTaken.ts";
import {
  answeredEventId,
  approvalDedupeKey,
  approvalEventId,
  CHANGES_FIRST,
  decodeStoredDraft,
  DRAFT_OPTIONS,
  draftDetail,
  DRAFT_WORDS,
  type StoredDraft,
  writtenOnApprove,
} from "./approval.ts";
import { keySentSql } from "../chat/keySent.ts";
import { capital, inDocs, tellMade, writeApproved } from "./sentUpDraft.ts";

/** The fixed headings of the open-questions sections; Kin's evals check a case's against these. */
export const OPEN_QUESTION_HEADINGS = {
  askedHere: "# Questions you asked for this chat (not answered yet)",
  draftsBack: "# Drafts back from Changes first (not redrafted yet)",
} as const;
/** The heading over the questions already put to one person. */
export const openQuestionsHeading = (who: string) =>
  `# Open questions to ${who} (already asked; don't ask or repeat them)`;

export type QuestionState =
  | "open"
  | "answered"
  | "default_taken"
  | "withdrawn"
  | "dismissed"
  | "lapsed";
export type QuestionRow = {
  readonly questionId: string;
  readonly agentId: KinAgentId;
  readonly agentName: string;
  readonly personId: KinPersonId;
  readonly chatId: KinChatId;
  readonly kind: "card" | "text";
  readonly widgetId: string | null;
  readonly raiseWidgetId: string | null;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly optionId: string; readonly label: string }>;
  readonly defaultLabel: string | null;
  readonly safe: boolean;
  readonly about: ReadonlyArray<string>;
  readonly intent: string;
  readonly askedAt: number;
  readonly dueAt: number;
  readonly actAt: number;
  readonly state: QuestionState;
  readonly raisedAt: number | null;
  readonly answer: string | null;
  /** Asked for another chat (`askPerson.ts`): its answer goes back there. */
  readonly forChatId: KinChatId | null;
  /** Who asked for it there; null when no person did, as in a check-in. */
  readonly forPersonId: KinPersonId | null;
  /** The teammate's draft it carries up to the owner (`sentUpDraft.ts`); null on any other. */
  readonly draft: StoredDraft | null;
};

/** How a question raised again opens its card, so what answers it can read past it. */
export const STILL_OPEN = "Still open: ";
const OptionsJson = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ optionId: Schema.String, label: Schema.String })),
);
const decodeOptions = Schema.decodeUnknownOption(OptionsJson);
const encodeOptions = Schema.encodeEffect(OptionsJson);
const validZone = (zone: string) => {
  try {
    DateTime.makeZonedUnsafe(0, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};
const decodeEvent = Schema.decodeUnknownEffect(KinEvent);
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};
const refuse = (message: string) => new KinChatError({ reason: "invalid_state", message });

const COLUMNS = `q.question_id AS "questionId", q.agent_id AS "agentId",
  COALESCE(l.name, a.display_name, q.agent_id) AS "agentName", q.person_id AS "personId",
  q.chat_id AS "chatId", q.kind, q.widget_id AS "widgetId", q.raise_widget_id AS "raiseWidgetId",
  q.question, q.options_json AS "options", q.default_label AS "defaultLabel", q.safe, q.about,
  q.intent, q.asked_at AS "askedAt", q.due_at AS "dueAt", q.act_at AS "actAt", q.state,
  q.raised_at AS "raisedAt", q.answer, q.for_chat_id AS "forChatId",
  q.for_person_id AS "forPersonId", q.draft_json AS "draft"`;
const FROM = `FROM kin_questions q
  LEFT JOIN kin_leads l ON l.org_id = q.org_id AND l.agent_id = q.agent_id
  LEFT JOIN kin_agents a ON a.org_id = q.org_id AND a.agent_id = q.agent_id`;
type Raw = Omit<QuestionRow, "options" | "safe" | "about" | "draft"> & {
  readonly options: string | null;
  readonly safe: number;
  readonly about: string;
  readonly draft: string | null;
};
const toRow = (raw: Raw): QuestionRow => ({
  ...raw,
  options: raw.options === null ? [] : Option.getOrElse(decodeOptions(raw.options), () => []),
  safe: raw.safe === 1,
  about: raw.about === "" ? [] : raw.about.split(" "),
  draft: raw.draft === null ? null : Option.getOrNull(decodeStoredDraft(raw.draft)),
});

/**
 * The person's clock and working hours: the owner's zone is the company's (`ownerZone`), anyone
 * else's their profile's, else the company's.
 */
export const personClock = Effect.fn("KinQuestions.personClock")(function* (
  orgId: KinOrgId,
  personId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [person] = yield* sql<{ zone: string | null; hours: string | null; owner: number }>`
    SELECT time_zone AS zone, work_hours_json AS hours, EXISTS (SELECT 1 FROM kin_agents a
        WHERE a.org_id = p.org_id AND a.owner_person_id = p.person_id) AS owner
    FROM kin_people p WHERE org_id = ${orgId} AND person_id = ${personId} ORDER BY person_id`;
  const company = yield* ownerZone(orgId);
  const own = person?.owner === 1 || person?.zone == null ? undefined : person.zone;
  const zone = own !== undefined && validZone(own) ? own : company;
  return { zone, work: storedWorkHours(person?.hours) };
});

/** The one person in a direct chat; questions are stored only where one person is asked. */
export const personOfChat = Effect.fn("KinQuestions.personOfChat")(function* (
  orgId: KinOrgId,
  chatId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ personId: string }>`SELECT m.person_id AS "personId"
    FROM kin_chat_members m JOIN kin_chats c ON c.org_id = m.org_id AND c.chat_id = m.chat_id
    WHERE m.org_id = ${orgId} AND m.chat_id = ${chatId} AND c.kind = 'direct'
      AND m.person_id IS NOT NULL AND m.left_at IS NULL ORDER BY m.person_id`;
  return rows.length === 1 ? KinPersonId.make(rows[0]!.personId) : undefined;
});

export const openFor = Effect.fn("KinQuestions.openFor")(function* (
  orgId: KinOrgId,
  personId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const raw = yield* sql<Raw>`SELECT ${sql.literal(COLUMNS)} ${sql.literal(FROM)}
    WHERE q.org_id = ${orgId} AND q.person_id = ${personId} AND q.state = 'open'
    ORDER BY q.asked_at, q.question_id`;
  return raw.map(toRow);
});

export const readQuestion = Effect.fn("KinQuestions.read")(function* (
  orgId: KinOrgId,
  questionId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [raw] = yield* sql<Raw>`SELECT ${sql.literal(COLUMNS)} ${sql.literal(FROM)}
    WHERE q.org_id = ${orgId} AND q.question_id = ${questionId}`;
  return raw === undefined ? undefined : toRow(raw);
});

/** Whether any of `about` is an entry in a list that carries amounts: an invoice, quote, expense. */
const aboutMoney = Effect.fn("KinQuestions.aboutMoney")(function* (
  orgId: KinOrgId,
  about: ReadonlyArray<string>,
) {
  if (about.length === 0) return false;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ listId: string }>`SELECT DISTINCT register_id AS "listId"
    FROM kin_records WHERE org_id = ${orgId} AND key IN ${sql.in(about)} ORDER BY register_id`;
  if (rows.length === 0) return false;
  const lists = yield* allLists(orgId);
  return rows.some((row) => lists.get(row.listId)?.amount === true);
});

/** "already asked by Finance on Monday: “…”. Default “Draft it” on Wednesday." */
const alreadyAsked = (open: QuestionRow, now: number, zone: string) =>
  `Already asked by ${open.agentName} ${dayWord(open.askedAt, now, zone)}: “${open.question}”. ${
    open.defaultLabel !== null && open.safe
      ? `Default “${open.defaultLabel}” ${dayWord(open.dueAt, now, zone)}`
      : "It has no safe default, so it waits for them"
  }. It is in their Waiting on you; don't ask it again.`;

/** Why a question's default waits for its person: none set, money, sending out, its kind of action, or a task whose closing Undo couldn't put back. */
export type Untaken = "none" | "money" | "leaves" | "action" | "repeats" | "handed_back";
export type AskPlan = {
  readonly questionId: string;
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly personId: KinPersonId;
  readonly chatId: KinChatId;
  readonly question: string;
  readonly defaultLabel: string | null;
  readonly safe: boolean;
  readonly about: ReadonlyArray<string>;
  readonly intent: string;
  readonly askedAt: number;
  readonly dueAt: number;
  readonly actAt: number;
  /** Why Kin won't take the default on its own, when it won't. */
  readonly untaken?: Untaken | undefined;
  /** What the asker is told when Kin won't take the default on its own. */
  readonly note?: string | undefined;
  /** An identical call already recorded it: the retry answers with the same card. */
  readonly retry: boolean;
};

/**
 * Checks a `kin_ask` before its card is posted: its default is one of its options or "none", its
 * day is sane, and no agent already put the same thing to the same person. Undefined when the
 * chat isn't one person's direct chat: the card is then an ordinary one.
 */
export const planAsk = Effect.fn("KinQuestions.planAsk")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly chatId: KinChatId;
  readonly key: string;
  readonly question: string;
  readonly labels: ReadonlyArray<string>;
  readonly default: string;
  readonly by?: string | undefined;
  readonly about?: ReadonlyArray<string> | undefined;
  readonly intent?: string | undefined;
  readonly now: number;
  /** The default's sealed action: only one `takesAsDefault` allows is taken at its day. */
  readonly acts?: CardPlan | undefined;
  /** Why that done or drop won't be taken at its day (`untakenAtDay`). */
  readonly held?: "repeats" | "handed_back" | undefined;
  /** Woken by an owner-level person's own message: they may be asked about what is set aside. */
  readonly ownerLevelAsked?: boolean | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const wanted = input.default.trim().toLowerCase();
  const label =
    wanted === "none" ? null : input.labels.find((one) => one.trim().toLowerCase() === wanted);
  if (label === undefined)
    return yield* refuse(
      `default is the label of the option you'll take if they don't answer (one of ${input.labels
        .map((one) => `“${one}”`)
        .join(", ")}), or "none" when nothing is safe to do without them.`,
    );
  const personId = yield* personOfChat(input.orgId, input.chatId);
  if (personId === undefined) return undefined;
  const questionId = `q-${hash(input.key).slice(0, 12)}`;
  const [seen] = yield* sql<{ id: string }>`SELECT question_id AS id FROM kin_questions
    WHERE org_id = ${input.orgId} AND question_id = ${questionId}`;
  const clock = yield* personClock(input.orgId, personId);
  const named =
    input.by === undefined ? undefined : namedDue(input.by, input.now, clock.zone, clock.work);
  if (named !== undefined && "refused" in named) return yield* refuse(named.refused);
  const dueAt = named?.at ?? defaultDue(input.now, clock.zone, clock.work);
  const about = normaliseAbout(input.about);
  if (input.ownerLevelAsked !== true) {
    const hold = yield* holdOverAbout({ orgId: input.orgId, at: input.now, keys: about, personId });
    if (hold !== undefined)
      return yield* refuse(
        refusalText(hold, yield* leadNamer(input.orgId, input.agentId), clock.zone),
      );
  }
  const untaken: Untaken | undefined =
    unsafeDefault(label, input.question, {
      labels: input.labels,
      aboutMoney: yield* aboutMoney(input.orgId, about),
    }) ?? (input.acts === undefined || takesAsDefault(input.acts) ? input.held : "action");
  const safe = untaken === undefined;
  const actAt = safe ? dueAt : raiseAt(dueAt, clock.zone, clock.work);
  const intent = normaliseIntent(input.intent);
  if (seen === undefined) {
    for (const open of yield* openFor(input.orgId, personId))
      if (repeats({ intent, about }, open))
        return yield* refuse(alreadyAsked(open, input.now, clock.zone));
    if (about.length > 0) {
      const text = yield* dismissedRepeat({ ...input, personId, intent, about }, clock.zone);
      if (text !== undefined) return yield* refuse(text);
    }
  }
  return {
    questionId,
    orgId: input.orgId,
    agentId: input.agentId,
    personId,
    chatId: input.chatId,
    question: oneLine(input.question, 240),
    defaultLabel: label,
    safe,
    untaken,
    about,
    intent,
    askedAt: input.now,
    dueAt,
    actAt,
    ...(untaken === undefined ? {} : { note: untakenNote(label, untaken) }),
    retry: seen !== undefined,
  } satisfies AskPlan;
});

const UNTAKEN_WHY: Record<Exclude<Untaken, "none">, string> = {
  money: "the card mentions an amount or a percentage, or is about a money record",
  leaves: "the wording suggests sending something out or moving money",
  action: "only a tap runs that option's action",
  repeats:
    "its task repeats. It stays as it is until they answer; say so, and set nothing to take it later",
  handed_back: "its task was handed back",
};
/** What Kin won't do with the default, and the rule that says so; only a repeating task's says what comes next. */
const untakenNote = (label: string | null, why: Untaken) =>
  why === "none" || label === null
    ? "Kin won't take any answer on its own: no default was set."
    : `Kin won't take “${label}” on its own: ${UNTAKEN_WHY[why]}.`;

/** Stores a planned question with the card that asks it; a retry stores nothing more. */
export const recordAsk = Effect.fn("KinQuestions.recordAsk")(function* (
  plan: AskPlan,
  card: {
    readonly widgetId: string;
    readonly options: ReadonlyArray<{ readonly optionId: string; readonly label: string }>;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const options = yield* encodeOptions(card.options).pipe(Effect.orDie);
  yield* sql`INSERT INTO kin_questions (question_id, org_id, agent_id, person_id, chat_id, kind,
      widget_id, question, options_json, default_label, safe, about, intent, asked_at, due_at,
      act_at, state)
    VALUES (${plan.questionId}, ${plan.orgId}, ${plan.agentId}, ${plan.personId}, ${plan.chatId},
      'card', ${card.widgetId}, ${plan.question}, ${options},
      ${plan.defaultLabel}, ${plan.safe ? 1 : 0}, ${plan.about.join(" ")}, ${plan.intent},
      ${plan.askedAt}, ${plan.dueAt}, ${plan.actAt}, 'open')
    ON CONFLICT (question_id) DO NOTHING`;
});

/** A question asked in words, by the turn that asked it: its message carries the same turn. */
export const textQuestionId = (wakeupId: string) => `q-${hash(`text:${wakeupId}`).slice(0, 12)}`;

/**
 * A reply that ended on a question to the one person in a direct chat, with no card: stored
 * with no default, so every agent sees it is open. Their next message in that chat answers it,
 * and at its day it lapses, with nobody told. An older open one from the same agent there gives way.
 */
export const recordTextQuestion = Effect.fn("KinQuestions.recordText")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly chatId: KinChatId;
  readonly wakeupId: string;
  readonly question: string;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const personId = yield* personOfChat(input.orgId, input.chatId);
  if (personId === undefined) return undefined;
  const clock = yield* personClock(input.orgId, personId);
  const questionId = textQuestionId(input.wakeupId);
  const dueAt = defaultDue(input.now, clock.zone, clock.work);
  yield* sql`UPDATE kin_questions SET state = 'withdrawn', closed_at = ${input.now}
    WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} AND chat_id = ${input.chatId}
      AND kind = 'text' AND state = 'open' AND question_id <> ${questionId}`;
  yield* sql`INSERT INTO kin_questions (question_id, org_id, agent_id, person_id, chat_id, kind,
      question, default_label, safe, asked_at, due_at, act_at, state)
    VALUES (${questionId}, ${input.orgId}, ${input.agentId}, ${personId}, ${input.chatId}, 'text',
      ${oneLine(input.question, 240)}, NULL, 0, ${input.now}, ${dueAt}, ${dueAt}, 'open')
    ON CONFLICT (question_id) DO NOTHING`;
  return questionId;
});

/**
 * The person's tap on a question's card: it closes as answered, in the tap's transaction. One
 * asked for another chat goes back there (`sendBack`), and its card's outcome says so. `approves`:
 * the option's stored kind is yes, which on a sent-up draft is its Approve (`approveDraft`).
 */
export const answerCard = Effect.fn("KinQuestions.answerCard")(function* (
  input: {
    readonly orgId: KinOrgId;
    readonly widgetId: string;
    readonly personId: string;
    readonly label: string;
    readonly approves?: boolean;
    readonly via?: "tap" | "reaction";
    readonly now: number;
  },
  chat: Pick<KinChatService["Service"], "notice" | "setDocCardChangesFirst">,
) {
  const sql = yield* SqlClient.SqlClient;
  const open = sql`org_id = ${input.orgId} AND person_id = ${input.personId} AND state = 'open'
    AND (widget_id = ${input.widgetId} OR raise_widget_id = ${input.widgetId})`;
  if (input.via === "reaction") {
    const [draft] = yield* sql`SELECT 1 FROM kin_questions WHERE ${open} AND draft_json IS NOT NULL
      ORDER BY question_id LIMIT 1`;
    if (draft !== undefined)
      return yield* new KinChatError({
        reason: "not_allowed",
        message: "Tap Approve or Changes first on the card.",
      });
  }
  const moved = yield* sql<{ questionId: string }>`UPDATE kin_questions SET state = 'answered',
      answer = ${input.label}, closed_at = ${input.now}
    WHERE ${open} RETURNING question_id AS "questionId"`;
  const row =
    moved[0] === undefined ? undefined : yield* readQuestion(input.orgId, moved[0].questionId);
  if (row?.forChatId == null) return undefined;
  const queue = yield* KinEventQueue.KinEventQueue;
  const approved =
    input.approves === true && row.draft !== null
      ? yield* approveDraft(input.orgId, row, row.draft, input.now, queue)
      : undefined;
  const asker = yield* sendBack(
    input.orgId,
    row,
    row.forChatId,
    input.label,
    "tap",
    input.now,
    chat,
    queue,
    approved !== undefined,
  );
  if (approved?._tag === "written" && row.draft !== null) {
    if (row.forPersonId !== null)
      yield* tellMade(
        input.orgId,
        {
          questionId: row.questionId,
          agentId: row.agentId,
          ownerId: row.personId,
          askerId: row.forPersonId,
          forChatId: row.forChatId,
          draft: row.draft,
          made: approved.made,
        },
        chat,
      ).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Kin couldn't tell the asker an approved draft is made", {
            orgId: input.orgId,
            questionId: row.questionId,
            cause,
          }),
        ),
      );
    return {
      title: "Approved",
      text: `Sent to ${asker}. ${capital(inDocs(row.draft.kind, approved.made.key))}.`,
    } satisfies KinChoiceOutcome;
  }
  if (approved !== undefined)
    return {
      title: "Approved",
      text: `Sent to ${asker}. ${row.agentName} is making it now.`,
    } satisfies KinChoiceOutcome;
  if (isChangesFirst(row, input.label))
    return yield* changesFirst(input.orgId, row, row.forChatId, input.now, chat, "tap");
  return { title: "Answered", text: `Sent to ${asker}.` } satisfies KinChoiceOutcome;
});

/** A sent-up draft answered Changes first: by the owner's tap, or taken from her words. */
const isChangesFirst = (row: QuestionRow, said: string | null) =>
  row.draft !== null && said === CHANGES_FIRST;

/**
 * The one path of a draft answered Changes first, tapped or from words: her own cards that sent
 * it up may send it again, as they now say; `sendBack` told her chat and woke no turn there.
 */
const changesFirst = Effect.fn("KinQuestions.changesFirst")(function* (
  orgId: KinOrgId,
  row: QuestionRow,
  forChatId: KinChatId,
  now: number,
  chat: Pick<KinChatService["Service"], "setDocCardChangesFirst">,
  how: "tap" | "words",
) {
  for (const { widgetId } of yield* draftCardsAbout(orgId, forChatId, row.about, "sent"))
    yield* chat.setDocCardChangesFirst({
      orgId,
      widgetId,
      changesFirst: { name: yield* personName(orgId, row.personId), at: iso(now) },
    });
  return {
    title: "Answered",
    text:
      how === "tap"
        ? "Say here what to change; the new draft comes back to you to approve."
        : "The new draft comes back to you to approve.",
  } satisfies KinChoiceOutcome;
});

/**
 * The owner's Approve on a teammate's sent-up draft, in the tap's transaction, once per question
 * (`approved_at`) and only while he is the agent's owner. A proposal or client terms Kin writes
 * itself, word for word (`writeApproved`); any other kind is one turn of the agent in his own chat
 * with it, at his level (no origin), to make it (`sentUpDraft.ts`). Undefined when it did neither.
 */
const approveDraft = Effect.fn("KinQuestions.approveDraft")(function* (
  orgId: KinOrgId,
  row: QuestionRow,
  draft: StoredDraft,
  now: number,
  queue: Pick<KinEventQueue.KinEventQueue["Service"], "enqueue">,
) {
  const sql = yield* SqlClient.SqlClient;
  const [agent] = yield* sql<{ owner: string; ownerChatId: string }>`SELECT
      a.owner_person_id AS owner, l.owner_chat_id AS "ownerChatId" FROM kin_agents a
    JOIN kin_leads l ON l.org_id = a.org_id AND l.agent_id = a.agent_id
    WHERE a.org_id = ${orgId} AND a.agent_id = ${row.agentId} AND a.retired_at IS NULL`;
  if (agent?.owner !== row.personId || !(yield* ownerLevel(orgId, row.personId))) return undefined;
  const marked = yield* sql`UPDATE kin_questions SET approved_at = ${now}
    WHERE org_id = ${orgId} AND question_id = ${row.questionId} AND state = 'answered'
      AND draft_json IS NOT NULL AND approved_at IS NULL
    RETURNING question_id`;
  if (marked.length === 0) return undefined;
  if (writtenOnApprove(draft.kind))
    return {
      _tag: "written" as const,
      made: yield* writeApproved(orgId, {
        questionId: row.questionId,
        agentId: row.agentId,
        ownerChatId: agent.ownerChatId,
        draft,
      }),
    };
  const event = yield* decodeEvent({
    _tag: "deferral.due",
    eventId: approvalEventId(orgId, row.questionId),
    orgId,
    agentId: row.agentId,
    receivedAt: iso(now),
    provenance: { _tag: "system" },
    dedupeKey: approvalDedupeKey(row.questionId),
    subject: { type: "question", questionId: row.questionId, answered: true, approved: true },
    lateByMs: 0,
  }).pipe(Effect.orDie);
  yield* queue.enqueue(event).pipe(
    Effect.catchTags({
      KinEventQueueRetiredAgent: () => Effect.fail(notSentBack),
      KinEventQueueUnknownAgent: () => Effect.fail(notSentBack),
      KinEventQueueConflict: () => Effect.fail(notSentBack),
      KinEventQueueUnknownEvent: () => Effect.fail(notSentBack),
    }),
  );
  // Shaped on a turn that read outside text, the draft's turn has read it too.
  yield* stampEvent(orgId, event.eventId, yield* storedStamp(orgId, row.questionId));
  return { _tag: "queued" as const };
});

/**
 * A teammate's own draft cards in her chat for the docs a sent-up draft is about: those that read
 * sent, or those the owner's Changes first made sendable again.
 */
export const draftCardsAbout = Effect.fn("KinQuestions.draftCardsAbout")(function* (
  orgId: KinOrgId,
  chatId: string,
  about: ReadonlyArray<string>,
  state: "sent" | "changesFirst",
) {
  if (about.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ widgetId: KinWidgetId; text: string }>`SELECT widget_id AS "widgetId",
      json_extract(state_json, '$.draft.text') AS text
    FROM kin_widgets WHERE org_id = ${orgId} AND chat_id = ${chatId} AND type = ${KIN_DOC_CARD}
      AND json_extract(state_json, '$.key') IN ${sql.in(about)}
      AND json_extract(state_json, '$.draft.sendTo') IS NOT NULL
      AND ${
        state === "sent"
          ? sql`json_extract(state_json, '$.draft.sent') IS NOT NULL`
          : sql`json_extract(state_json, '$.draft.sent') IS NULL
              AND json_extract(state_json, '$.draft.changesFirst') IS NOT NULL`
      }
    ORDER BY widget_id`;
});

/** One redo of an answered draft per turn: a retry finds it. */
export const redoId = (questionId: string, wakeupId: string) =>
  `q-${hash(`for:redo:${questionId}:${wakeupId}`).slice(0, 12)}`;

/**
 * The teammates' drafts the agent's owner answered Changes first on in this chat that no later
 * round replaced: each waits on her redraft (`redo`). A later round is this turn's own redo of it
 * only on a retry, so that one still waits.
 */
export const waitingRedrafts = Effect.fn("KinQuestions.waitingRedrafts")(function* (
  turn: { readonly orgId: KinOrgId; readonly agentId: KinAgentId; readonly wakeupId: string },
  chatId: KinChatId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    questionId: string;
    question: string;
    about: string;
    intent: string;
    forChatId: KinChatId;
    forPersonId: KinPersonId;
    draft: string;
  }>`SELECT q.question_id AS "questionId", q.question, q.about, q.intent,
      q.for_chat_id AS "forChatId", q.for_person_id AS "forPersonId", q.draft_json AS draft
    FROM kin_questions q
    JOIN kin_agents a ON a.org_id = q.org_id AND a.agent_id = q.agent_id AND a.retired_at IS NULL
    WHERE q.org_id = ${turn.orgId} AND q.agent_id = ${turn.agentId}
      AND q.chat_id = ${chatId} AND q.person_id = a.owner_person_id
      AND q.draft_json IS NOT NULL AND q.state = 'answered' AND q.answer = ${CHANGES_FIRST}
      AND q.approved_at IS NULL AND q.for_chat_id IS NOT NULL AND q.for_person_id IS NOT NULL
    ORDER BY q.question_id`;
  const later = (row: (typeof rows)[number]) =>
    sql<{ questionId: string }>`SELECT n.question_id AS "questionId" FROM kin_questions n
      JOIN kin_questions q ON q.org_id = n.org_id AND q.question_id = ${row.questionId}
      WHERE n.org_id = ${turn.orgId} AND n.agent_id = q.agent_id
        AND n.for_chat_id = q.for_chat_id AND n.draft_json IS NOT NULL AND n.intent = q.intent
        AND n.about = q.about AND n.question_id <> q.question_id AND n.asked_at >= q.closed_at
      ORDER BY n.question_id`.pipe(
      Effect.map((newer) =>
        newer.some((one) => one.questionId !== redoId(row.questionId, turn.wakeupId)),
      ),
    );
  const current = yield* Effect.filter(rows, (row) => Effect.map(later(row), (one) => !one));
  return current.flatMap((row) =>
    Option.toArray(decodeStoredDraft(row.draft)).map((draft) => ({
      ...row,
      about: row.about === "" ? [] : row.about.split(" "),
      draft,
    })),
  );
});

/** The teammates' drafts whose cards in this chat still wait on the agent's owner. */
export const draftsOnHerCard = Effect.fn("KinQuestions.draftsOnHerCard")(function* (
  turn: { readonly orgId: KinOrgId; readonly agentId: KinAgentId },
  chatId: KinChatId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    questionId: string;
    about: string;
    forPersonId: KinPersonId;
    draft: string;
  }>`SELECT q.question_id AS "questionId", q.about, q.for_person_id AS "forPersonId",
      q.draft_json AS draft
    FROM kin_questions q
    JOIN kin_agents a ON a.org_id = q.org_id AND a.agent_id = q.agent_id AND a.retired_at IS NULL
    WHERE q.org_id = ${turn.orgId} AND q.agent_id = ${turn.agentId}
      AND q.chat_id = ${chatId} AND q.person_id = a.owner_person_id AND q.state = 'open'
      AND q.draft_json IS NOT NULL AND q.for_chat_id IS NOT NULL AND q.for_person_id IS NOT NULL
    ORDER BY q.question_id`;
  return rows.flatMap((row) =>
    Option.toArray(decodeStoredDraft(row.draft)).map((draft) => ({
      ...row,
      about: row.about === "" ? [] : row.about.split(" "),
      draft,
    })),
  );
});

/** Whether a card asks a question for another chat: its tap answers there, not here. */
export const askedForCard = Effect.fn("KinQuestions.askedForCard")(function* (
  orgId: KinOrgId,
  widgetId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_questions WHERE org_id = ${orgId}
    AND for_chat_id IS NOT NULL AND (widget_id = ${widgetId} OR raise_widget_id = ${widgetId})
    LIMIT 1`;
  return rows.length > 0;
});

export const questionForCard = Effect.fn("KinQuestions.questionForCard")(function* (
  card: Pick<KinWidget, "orgId" | "chatId" | "widgetId">,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ state: QuestionState }>`SELECT state FROM kin_questions
    WHERE org_id = ${card.orgId} AND chat_id = ${card.chatId}
      AND (widget_id = ${card.widgetId} OR raise_widget_id = ${card.widgetId})
    ORDER BY asked_at DESC, question_id LIMIT 1`;
  return row;
});

/** The card's first line, the server's own: who asks, and through which agent (`askedBy`). */
export const askedBy = (askerName: string | null, agentName: string) =>
  askerName === null ? `${agentName} asks.` : `${askerName} asks, through ${agentName}.`;

/**
 * An answer to a question asked for another chat goes back there: Kin's line, and one turn there
 * (`question-answered:<id>`) unless its asker no longer writes there or it is a draft's Changes
 * first, whose redraft comes from the owner's chat (`redo`). Returns who that chat is with.
 */
const sendBack = Effect.fn("KinQuestions.sendBack")(function* (
  orgId: KinOrgId,
  row: QuestionRow,
  forChatId: KinChatId,
  said: string | null,
  how: "tap" | "words",
  now: number,
  chat: Pick<KinChatService["Service"], "notice">,
  queue: Pick<KinEventQueue.KinEventQueue["Service"], "enqueue">,
  approved = false,
) {
  const who = yield* personName(orgId, row.personId);
  const asker = yield* personOfChat(orgId, forChatId);
  const changesFirst = !approved && isChangesFirst(row, said);
  const body =
    changesFirst && row.draft !== null
      ? `${who} wants changes first; the new ${DRAFT_WORDS[row.draft.kind]} goes back to ${who} to approve.`
      : said === null
        ? `${who} answered “${row.question}” in the chat with ${row.agentName}.`
        : `${who} answered “${said}” to “${row.question}”`;
  // Its answer is told even when that chat can't take a line now; the turn still carries it.
  yield* chat
    .notice({
      orgId,
      chatId: forChatId,
      messageId: KinMessageId.make(`kin-asked-back:${row.questionId}`),
      audience: "chat",
      body: oneLine(body, 600),
    })
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Kin couldn't post an answer back", {
          orgId,
          questionId: row.questionId,
          how,
          cause,
        }),
      ),
    );
  const named = asker === undefined ? "the chat that asked" : yield* personName(orgId, asker);
  // An approved draft's turn is the owner's own (`approveDraft`): none in the chat that asked.
  if (approved || changesFirst) return named;
  yield* wakeAsker(orgId, row, forChatId, now, queue, {
    eventId: answeredEventId(orgId, row.questionId),
    dedupeKey: `question-answered:${row.questionId}`,
    subject: { type: "question", questionId: row.questionId, answered: true },
    notNow: notSentBack,
  });
  return named;
});

/**
 * One turn of a question's asker in the chat it was asked for, on what became of it there: only
 * while its asker still writes there, or when that is its owner's own chat.
 */
const wakeAsker = Effect.fn("KinQuestions.wakeAsker")(function* (
  orgId: KinOrgId,
  row: QuestionRow,
  forChatId: KinChatId,
  now: number,
  queue: Pick<KinEventQueue.KinEventQueue["Service"], "enqueue">,
  turn: {
    readonly eventId: KinEventId;
    readonly dedupeKey: string;
    readonly subject: {
      readonly type: "question";
      readonly questionId: string;
      readonly answered?: true;
      readonly lapsed?: true;
    };
    readonly notNow: KinChatError;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const asker = yield* personOfChat(orgId, forChatId);
  const [lead] = yield* sql<{ ownerChatId: string }>`SELECT owner_chat_id AS "ownerChatId"
    FROM kin_leads WHERE org_id = ${orgId} AND agent_id = ${row.agentId}`;
  const ownerAsked = lead === undefined || lead.ownerChatId === forChatId;
  if (
    !ownerAsked &&
    (asker === undefined ||
      asker !== row.forPersonId ||
      !(yield* Reach.reaches(orgId, Reach.person(asker), Reach.agent(row.agentId))))
  ) {
    yield* Effect.logInfo("Kin dropped an asker's turn: the chat that asked can't take it", {
      orgId,
      questionId: row.questionId,
      forChatId,
      dedupeKey: turn.dedupeKey,
    });
    return;
  }
  const event = yield* decodeEvent({
    _tag: "deferral.due",
    eventId: turn.eventId,
    orgId,
    agentId: row.agentId,
    receivedAt: iso(now),
    provenance: { _tag: "system" },
    dedupeKey: turn.dedupeKey,
    subject: turn.subject,
    lateByMs: 0,
    ...(ownerAsked || asker === undefined
      ? {}
      : {
          chatId: forChatId,
          origin: { agentId: row.agentId, chatId: forChatId, personId: asker },
        }),
  }).pipe(Effect.orDie);
  yield* queue.enqueue(event).pipe(
    Effect.catchTags({
      KinEventQueueRetiredAgent: () => Effect.void,
      KinEventQueueUnknownAgent: () => Effect.void,
      KinEventQueueConflict: () => Effect.fail(turn.notNow),
      KinEventQueueUnknownEvent: () => Effect.fail(turn.notNow),
    }),
  );
  yield* stampEvent(orgId, event.eventId, yield* storedStamp(orgId, row.questionId));
});
const notSentBack = new KinChatError({
  reason: "conflict",
  message: "Kin couldn't send that answer back just now, so nothing changed. Try again.",
});

/** The person wrote in a chat where an agent's text question waits: that is its answer. */
export const answerByReply = Effect.fn("KinQuestions.answerByReply")(function* (input: {
  readonly orgId: KinOrgId;
  readonly chatId: string;
  readonly personId: string;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_questions SET state = 'answered', closed_at = ${input.now}
    WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND person_id = ${input.personId}
      AND kind = 'text' AND state = 'open' AND asked_at < ${input.now}`;
});

const cardIds = (row: QuestionRow) =>
  [row.raiseWidgetId ?? row.widgetId].filter((id): id is string => id !== null);

/**
 * Whether this wake-up woke on the person's own message in the question's chat, written after its
 * card and after its last Undo, in the chat's order: the only words its asker may take an answer
 * from. A copy passed on from elsewhere, another chat, another person, a schedule or another agent
 * never counts.
 */
export const wokenByTheirWords = Effect.fn("KinQuestions.wokenByTheirWords")(function* (
  orgId: KinOrgId,
  agentId: KinAgentId,
  wakeupId: string,
  row: Pick<QuestionRow, "questionId" | "widgetId" | "chatId" | "personId" | "askedAt">,
  after?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const [card] =
    row.widgetId === null
      ? []
      : yield* sql<{ seq: number }>`SELECT m.seq FROM kin_widgets w
          JOIN kin_messages m ON m.org_id = w.org_id AND m.message_id = w.message_id
          WHERE w.org_id = ${orgId} AND w.widget_id = ${row.widgetId}
            AND m.chat_id = ${row.chatId}`;
  // Each Undo of an answer taken from words is its tap's message in this chat (`markRan`).
  const [undone] = yield* sql<{ seq: number | null }>`SELECT MAX(t.seq) AS seq
    FROM kin_card_plans p JOIN kin_messages t ON t.org_id = p.org_id
      AND t.message_id = p.ran_message_id AND t.chat_id = p.chat_id
    WHERE p.org_id = ${orgId} AND p.chat_id = ${row.chatId}
      AND json_extract(p.plan_json, '$.kind') = 'undo_answer'
      AND json_extract(p.plan_json, '$.questionId') = ${row.questionId}`;
  const rows = yield* sql`SELECT 1 FROM kin_events e
    JOIN kin_messages m ON m.org_id = e.org_id
      AND m.message_id = json_extract(e.json, '$.messageId')
    WHERE e.org_id = ${orgId} AND e.agent_id = ${agentId} AND e.wakeup_id = ${wakeupId}
      AND e.tag = 'chat.message' AND json_extract(e.json, '$.origin') IS NULL
      AND m.chat_id = ${row.chatId} AND m.author_kind = 'human'
      AND NOT ${sql.literal(keySentSql("m.client_message_id"))}
      AND m.author_person_id = ${row.personId} AND m.origin_json IS NULL
      AND m.status = 'posted' AND trim(m.body) <> ''
      AND ${card === undefined ? sql`m.created_at > ${iso(row.askedAt)}` : sql`m.seq > ${card.seq}`}
      AND m.seq > ${undone?.seq ?? -1}
      ${after === undefined ? sql`` : sql`AND m.created_at > ${iso(after)}`}
      -- A copy kin_take_private posted before copies were marked: its claim's key is its client id.
      AND NOT EXISTS (SELECT 1 FROM kin_handoffs h WHERE h.org_id = m.org_id
        AND m.client_message_id = ${storedClientId("send", "")} || h.message_id)
    LIMIT 1`;
  return rows.length > 0;
});

const DISMISSAL_WINDOW_MS = 7 * 86_400_000;

const dismissedRepeat = Effect.fn("KinQuestions.dismissedRepeat")(function* (
  input: {
    readonly orgId: KinOrgId;
    readonly agentId: KinAgentId;
    readonly chatId: KinChatId;
    readonly personId: KinPersonId;
    readonly key: string;
    readonly intent: string;
    readonly about: ReadonlyArray<string>;
    readonly now: number;
  },
  zone: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    questionId: string;
    widgetId: string | null;
    chatId: KinChatId;
    agentId: KinAgentId;
    askedAt: number;
    closedAt: number;
    intent: string;
    about: string;
  }>`SELECT question_id AS "questionId", widget_id AS "widgetId", chat_id AS "chatId",
      agent_id AS "agentId", asked_at AS "askedAt", closed_at AS "closedAt", intent, about
    FROM kin_questions WHERE org_id = ${input.orgId} AND person_id = ${input.personId}
      AND state = 'dismissed' AND closed_at BETWEEN ${input.now - DISMISSAL_WINDOW_MS} AND ${input.now}
    ORDER BY closed_at DESC, question_id`;
  // The kin_ask handler keys each call by its wake-up followed by the input hash.
  const wakeupId = input.key.slice(0, input.key.lastIndexOf(":"));
  for (const row of rows) {
    const about = row.about.split(" ");
    if (
      !repeats(input, { intent: row.intent, about }) &&
      !(
        row.agentId === input.agentId &&
        row.chatId === input.chatId &&
        input.about.some((key) => about.includes(key))
      )
    )
      continue;
    if (
      yield* wokenByTheirWords(
        input.orgId,
        input.agentId,
        wakeupId,
        { ...row, personId: input.personId },
        row.closedAt,
      )
    )
      continue;
    const who = yield* personName(input.orgId, input.personId);
    const when = formatKinWhen(row.closedAt, "dayTime", { zone, locale: KIN_TEXT_LOCALE });
    return `${who} dismissed this question on ${when} without choosing. Do not ask it again or post another card about it. If it still matters, say in one line what is still open and that they dismissed the card; they will tell you in words what they want.`;
  }
});

/** The Undo line on the note of an answer taken from someone's words. */
export const UNDO_ANSWER_LINE = "Open the question again";

/**
 * The person hears, on a note in the question's chat, that the asker took their words as its
 * answer; its Undo opens the question again (`runAnswered`), as a taken default's note does.
 */
const offerUndo = Effect.fn("KinQuestions.offerUndo")(function* (
  orgId: KinOrgId,
  row: QuestionRow,
  answer: string | null,
  closedAt: number,
  chat: Pick<KinChatService["Service"], "ask">,
) {
  const sql = yield* SqlClient.SqlClient;
  const [agent] = yield* sql<{ owner: string; threadId: string | null }>`SELECT
      a.owner_person_id AS owner, l.thread_id AS "threadId"
    FROM kin_agents a JOIN kin_leads l ON l.org_id = a.org_id AND l.agent_id = a.agent_id
    WHERE a.org_id = ${orgId} AND a.agent_id = ${row.agentId} AND a.retired_at IS NULL`;
  if (agent === undefined || agent.threadId === null) return;
  const plan = (kind: AnsweredPlan["kind"]): AnsweredPlan => ({
    kind,
    questionId: row.questionId,
    agentId: row.agentId,
    answer,
    closedAt,
  });
  const card = yield* chat.ask(
    {
      _tag: "agent",
      orgId,
      agentId: row.agentId,
      ownerPersonId: KinPersonId.make(agent.owner),
      threadId: ThreadId.make(agent.threadId),
      hostPosted: true,
    },
    {
      question: oneLine(
        `I took ${answer === null ? "your answer" : `“${answer}”`} from what you wrote, on “${row.question}”.`,
        240,
      ),
      options: [{ label: "Undo" }, { label: "Keep it" }],
      actions: [{ label: "Undo", line: UNDO_ANSWER_LINE }, undefined],
      untilAnswered: true,
      chatId: row.chatId,
      clientMessageId: `kin-answer-taken:${row.questionId}:${closedAt}`,
    },
  );
  yield* sealPlans({
    orgId,
    chatId: row.chatId,
    widgetId: card.widgetId,
    plans: [
      { optionId: "option-1", plan: plan("undo_answer") },
      { optionId: "option-2", plan: plan("keep_answer") },
    ],
    now: closedAt,
  });
});

/**
 * An agent closes a question: answered from the person's own words in its chat
 * (`wokenByTheirWords`), or withdrawn; both only by its asker. Its card stops taking taps. An
 * answer's note offers Undo, unless it was asked for another chat: then only that side withdraws
 * it, and its answer goes back there (`sendBack`).
 */
export const closeQuestion = Effect.fn("KinQuestions.close")(function* (
  input: {
    readonly orgId: KinOrgId;
    readonly agentId: KinAgentId;
    readonly wakeupId: string;
    readonly questionId: string;
    readonly outcome: "answered" | "withdrawn";
    readonly answer?: string | undefined;
    readonly now: number;
  },
  chat: Pick<
    KinChatService["Service"],
    "closeReplaced" | "ask" | "notice" | "setDocCardChangesFirst"
  >,
  queue: Pick<KinEventQueue.KinEventQueue["Service"], "enqueue">,
) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* readQuestion(input.orgId, input.questionId);
  if (row === undefined) return yield* refuse("No such question. Your seat lists the open ones.");
  if (row.state !== "open")
    return { questionId: row.questionId, state: row.state, changed: false } as const;
  if (input.outcome === "withdrawn" && row.agentId !== input.agentId)
    return yield* refuse(`Only ${row.agentName}, who asked it, can withdraw it.`);
  const turn = { orgId: input.orgId, agentId: input.agentId, wakeupId: input.wakeupId };
  const who = yield* personName(input.orgId, row.personId);
  let withdrewBy = row.agentName;
  if (input.outcome === "withdrawn" && row.forChatId !== null) {
    const here = (yield* turnChat(turn))?.chatId;
    const ownerSide = here !== row.chatId && (yield* effectiveAudience(turn)) === "owner_only";
    if (here !== row.forChatId && !ownerSide) return yield* refuse(notTheAskersSide(who));
    const asker = yield* turnAsker(turn);
    if (asker !== null) withdrewBy = yield* personName(input.orgId, asker);
  }
  const said = input.answer === undefined ? null : oneLine(input.answer, 200);
  // A draft's Changes first taken from the owner's words is her tap's answer, stored as the tap's.
  const answer =
    row.draft !== null && said?.replace(/\.$/, "").toLowerCase() === CHANGES_FIRST.toLowerCase()
      ? CHANGES_FIRST
      : said;
  let backTo: string | undefined;
  let changed: KinChoiceOutcome | undefined;
  if (input.outcome === "answered") {
    if (row.agentId !== input.agentId) return yield* refuse(notTheAsker(row, who));
    if (!(yield* wokenByTheirWords(input.orgId, input.agentId, input.wakeupId, row)))
      return yield* refuse(notTheirWords(who));
    // Her words go back to the chat that asked: held to what its person may read.
    const asker =
      row.forChatId === null ? undefined : yield* personOfChat(input.orgId, row.forChatId);
    if (asker !== undefined && answer !== null && !(yield* ownerLevel(input.orgId, asker))) {
      const why = yield* unreadableBy(input.orgId, asker, answer);
      if (why !== undefined)
        return yield* refuse(
          `Not for ${yield* personName(input.orgId, asker)}, who asked: ${why}. Record the answer without that.`,
        );
    }
  }
  yield* sql`UPDATE kin_questions SET state = ${input.outcome}, answer = ${answer},
      closed_at = ${input.now}
    WHERE org_id = ${input.orgId} AND question_id = ${row.questionId} AND state = 'open'`;
  if (input.outcome === "answered" && row.forChatId !== null) {
    backTo = yield* sendBack(
      input.orgId,
      row,
      row.forChatId,
      answer,
      "words",
      input.now,
      chat,
      queue,
    );
    if (isChangesFirst(row, answer))
      changed = yield* changesFirst(input.orgId, row, row.forChatId, input.now, chat, "words");
  }
  const cards = cardIds(row);
  for (const widgetId of cards)
    yield* chat.closeReplaced({
      orgId: input.orgId,
      widgetId: KinWidgetId.make(widgetId),
      outcome:
        changed !== undefined
          ? changed
          : input.outcome === "answered"
            ? {
                title: "Answered",
                text: `${tookFromWords(row.agentName, answer)}${backTo === undefined ? "" : `${answer === null ? "" : "."} Sent to ${backTo}.`}`,
              }
            : { title: "Withdrawn", text: `${withdrewBy} withdrew this question.` },
    });
  // Sent on already, her answer has no Undo here: she says so in the chat if it was wrong.
  if (input.outcome === "answered" && cards.length > 0 && backTo === undefined)
    yield* offerUndo(input.orgId, row, answer, input.now, chat);
  return { questionId: row.questionId, state: input.outcome, changed: true } as const;
});

/** What a question's card says once its asker took its answer from the person's words. */
const tookFromWords = (agentName: string, answer: string | null) =>
  answer === null
    ? `${agentName} took this from what you wrote.`
    : `${agentName} took this from what you wrote: ${answer}`;
const notTheAsker = (row: QuestionRow, who: string) =>
  `${row.agentName} asked this, so only ${row.agentName} records ${who}'s answer. Don't decide it: if what ${who} told you bears on it, say so to ${who} and leave the card, still open in ${who}'s chat with ${row.agentName}.`;
const notTheAskersSide = (who: string) =>
  `This question waits on ${who} for another chat, so only that chat, or the owner, withdraws it. If it no longer stands for ${who}, take ${who}'s answer in words instead.`;
const notTheirWords = (who: string) =>
  `An answer is recorded only in a turn woken by ${who}'s own message in this question's chat, written since you asked; this turn wasn't. Leave it open: its card still takes ${who}'s tap.`;

/** The asker hears once that the person undid the answer it took, so it doesn't act on it. */
const tellAnswerUndone = Effect.fn("KinQuestions.tellAnswerUndone")(function* (
  orgId: KinOrgId,
  row: QuestionRow,
  closedAt: number,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const [lead] = yield* sql<{ ownerChatId: string }>`SELECT owner_chat_id AS "ownerChatId"
    FROM kin_leads WHERE org_id = ${orgId} AND agent_id = ${row.agentId}`;
  const event = yield* decodeEvent({
    _tag: "deferral.due",
    eventId: KinEventId.make(
      `question_${hash(`${orgId}\0${row.questionId}\0${closedAt}\0answer-undone`).slice(0, 32)}`,
    ),
    orgId,
    agentId: row.agentId,
    receivedAt: iso(now),
    provenance: { _tag: "system" },
    dedupeKey: `question-answer-undone:${row.questionId}:${closedAt}`,
    subject: { type: "question", questionId: row.questionId, undone: true, words: true },
    lateByMs: 0,
    ...(lead === undefined || lead.ownerChatId === row.chatId
      ? {}
      : { origin: { agentId: row.agentId, chatId: row.chatId, personId: row.personId } }),
  }).pipe(Effect.orDie);
  // A retired asker has no turn to tell; anything else rolls the whole Undo back.
  yield* (yield* KinEventQueue.KinEventQueue).enqueue(event).pipe(
    Effect.catchTags({
      KinEventQueueRetiredAgent: () => Effect.void,
      KinEventQueueUnknownAgent: () => Effect.void,
      KinEventQueueConflict: () => Effect.fail(undoNotNow),
      KinEventQueueUnknownEvent: () => Effect.fail(undoNotNow),
    }),
  );
});
const undoNotNow = new KinChatError({
  reason: "conflict",
  message: "That couldn't be undone just now, so nothing changed. Try again.",
});

/**
 * A tap on the note of an answer taken from someone's words: Keep leaves it; Undo, only by the
 * person it was asked of, only while that answer stands and its asker is still here, opens the
 * question again on its cards, waiting for that person with no default.
 */
export const runAnswered = Effect.fn("KinQuestions.runAnswered")(function* (
  tap: { readonly orgId: KinOrgId; readonly personId: KinPersonId; readonly now: number },
  plan: AnsweredPlan,
  chat: Pick<KinChatService["Service"], "reopenClosed">,
) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId } = tap;
  const row = yield* readQuestion(orgId, plan.questionId);
  if (row !== undefined && row.personId !== tap.personId)
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Only the person it was asked of can undo this.",
    });
  const [closed] =
    row === undefined
      ? []
      : yield* sql<{ closedAt: number | null }>`SELECT closed_at AS "closedAt"
          FROM kin_questions WHERE org_id = ${orgId} AND question_id = ${row.questionId}`;
  if (
    row === undefined ||
    row.state !== "answered" ||
    row.agentId !== plan.agentId ||
    closed?.closedAt !== plan.closedAt
  )
    return {
      title: "Nothing was undone",
      text: "That question was settled another way since, so nothing was undone.",
    } satisfies KinChoiceOutcome;
  if (plan.kind === "keep_answer")
    return {
      title: "Kept",
      text: plan.answer === null ? "Your answer stands." : `“${plan.answer}” stands.`,
    } satisfies KinChoiceOutcome;
  const [asker] = yield* sql`SELECT 1 FROM kin_agents a
    JOIN kin_leads l ON l.org_id = a.org_id AND l.agent_id = a.agent_id
    WHERE a.org_id = ${orgId} AND a.agent_id = ${row.agentId} AND a.retired_at IS NULL`;
  if (asker === undefined)
    return {
      title: "Nothing was undone",
      text: `${row.agentName} is no longer here, so the question stays closed and its answer stands as taken. You can raise it with another agent.`,
    } satisfies KinChoiceOutcome;
  // Open again with no default and nothing due (`raised_at`): it waits for its person, so
  // nothing at its day repeats what the first answer did.
  yield* sql`UPDATE kin_questions SET state = 'open', answer = NULL, closed_at = NULL,
      default_label = NULL, safe = 0, raised_at = COALESCE(raised_at, ${tap.now})
    WHERE org_id = ${orgId} AND question_id = ${row.questionId} AND state = 'answered'
      AND closed_at = ${plan.closedAt}`;
  for (const widgetId of cardIds(row))
    yield* chat.reopenClosed({
      orgId,
      widgetId: KinWidgetId.make(widgetId),
      awaiting: [row.personId],
    });
  yield* tellAnswerUndone(orgId, row, plan.closedAt, tap.now);
  return {
    title: "Undone",
    text: oneLine(
      `“${row.question}” is open again, and ${row.agentName} waits for your answer. What was already done from the first answer stands.`,
      600,
    ),
    undone: {
      personId: tap.personId,
      name: yield* personName(orgId, tap.personId),
      at: iso(tap.now),
    },
  } satisfies KinChoiceOutcome;
});

const withdraw = Effect.fn("KinQuestions.withdraw")(function* (
  orgId: KinOrgId,
  rows: ReadonlyArray<QuestionRow>,
  reason: (row: QuestionRow) => string,
  closedAt: number,
  chat: Pick<KinChatService["Service"], "closeReplaced"> &
    Partial<Pick<KinChatService["Service"], "notice">>,
  title = "Closed",
) {
  const sql = yield* SqlClient.SqlClient;
  for (const row of rows) {
    const moved = yield* sql`UPDATE kin_questions SET state = 'withdrawn', closed_at = ${closedAt}
      WHERE org_id = ${orgId} AND question_id = ${row.questionId} AND state = 'open'
      RETURNING question_id`;
    if (moved.length === 0) continue;
    for (const widgetId of cardIds(row))
      yield* chat.closeReplaced({
        orgId,
        widgetId: KinWidgetId.make(widgetId),
        outcome: { title, text: reason(row) },
      });
    // The chat it was asked for hears once that no answer is coming.
    if (row.forChatId !== null && chat.notice !== undefined)
      yield* chat
        .notice({
          orgId,
          chatId: row.forChatId,
          messageId: KinMessageId.make(`kin-asked-closed:${row.questionId}:${closedAt}`),
          audience: "chat",
          body: oneLine(
            `“${row.question}” was closed before ${yield* personName(orgId, row.personId)} answered.`,
            600,
          ),
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Kin couldn't say an asked question closed", {
              orgId,
              questionId: row.questionId,
              cause,
            }),
          ),
        );
  }
});

/** What a retired agent's question card says when it closes. */
export const retiredQuestionText = (agentName: string) =>
  `${agentName} was retired; nothing will happen on this.`;

/**
 * Closes every open question an agent asked, or that waits on a person, in the caller's
 * transaction: each is withdrawn at `closedAt` and its card closes saying `reason`.
 */
export const closeHeldQuestions = Effect.fn("KinQuestions.closeHeld")(function* (
  input: {
    readonly orgId: KinOrgId;
    readonly holder:
      | { readonly agentId: KinAgentId; readonly personId?: never }
      | { readonly personId: KinPersonId; readonly agentId?: never };
    readonly reason: (row: QuestionRow) => string;
    readonly closedAt: number;
  },
  chat: Pick<KinChatService["Service"], "closeReplaced"> &
    Partial<Pick<KinChatService["Service"], "notice">>,
) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, holder } = input;
  const rows = (yield* sql<Raw>`SELECT ${sql.literal(COLUMNS)} ${sql.literal(FROM)}
    WHERE q.org_id = ${orgId} AND q.state = 'open' AND ${
      holder.agentId === undefined
        ? sql`q.person_id = ${holder.personId}`
        : sql`q.agent_id = ${holder.agentId}`
    }
    ORDER BY q.asked_at, q.question_id`).map(toRow);
  yield* withdraw(orgId, rows, input.reason, input.closedAt, chat);
  return rows.length;
});

/**
 * Closes every open question about a record that just closed (`about` names its key), or asked
 * on one of `cards`, in the caller's transaction. One on a card in `sparing` is left to the tap
 * that settles it.
 */
export const closeQuestionsAbout = Effect.fn("KinQuestions.closeAbout")(function* (
  input: {
    readonly orgId: KinOrgId;
    readonly key: string;
    readonly cards: ReadonlyArray<string>;
    readonly sparing: ReadonlyArray<string>;
    readonly text: string;
    readonly closedAt: number;
    /** The card's outcome title: a task's says it closed with its task. */
    readonly title?: string;
  },
  chat: Pick<KinChatService["Service"], "closeReplaced"> &
    Partial<Pick<KinChatService["Service"], "notice">>,
) {
  const sql = yield* SqlClient.SqlClient;
  const onCards =
    input.cards.length === 0
      ? sql`0`
      : sql`(q.widget_id IN ${sql.in(input.cards)} OR q.raise_widget_id IN ${sql.in(input.cards)})`;
  const rows = (yield* sql<Raw>`SELECT ${sql.literal(COLUMNS)} ${sql.literal(FROM)}
    WHERE q.org_id = ${input.orgId} AND q.state = 'open'
      AND ((' ' || q.about || ' ') LIKE ${`% ${input.key} %`} OR ${onCards})
    ORDER BY q.asked_at, q.question_id`)
    .map(toRow)
    .filter((row) => !input.sparing.some((id) => id === row.widgetId || id === row.raiseWidgetId));
  yield* withdraw(input.orgId, rows, () => input.text, input.closedAt, chat, input.title);
  return rows.length;
});

/**
 * Restoring an agent reopens the questions its retirement closed (withdrawn at that very
 * instant), each with a fresh day as if asked now, so no default is taken before the person
 * has had one. Its next raise posts the card again.
 */
export const reopenRetiredQuestions = Effect.fn("KinQuestions.reopenRetired")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly retiredAt: number;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ questionId: string; personId: string; safe: number }>`SELECT
      question_id AS "questionId", person_id AS "personId", safe FROM kin_questions
    WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} AND state = 'withdrawn'
      AND closed_at = ${input.retiredAt}
    ORDER BY asked_at, question_id`;
  for (const row of rows) {
    const clock = yield* personClock(input.orgId, row.personId);
    const dueAt = defaultDue(input.now, clock.zone, clock.work);
    const actAt = row.safe === 1 ? dueAt : raiseAt(dueAt, clock.zone, clock.work);
    yield* sql`UPDATE kin_questions SET state = 'open', closed_at = NULL, raised_at = NULL,
        due_at = ${dueAt}, act_at = ${actAt}
      WHERE org_id = ${input.orgId} AND question_id = ${row.questionId} AND state = 'withdrawn'`;
  }
  return rows.length;
});

/** The turn that takes a default: one per question, keyed so a replay finds its own. */
const takeEventId = (orgId: string, questionId: string) =>
  KinEventId.make(`question_${hash(`${orgId}\0${questionId}`).slice(0, 32)}`);

type SettleDeps = {
  readonly chat: Pick<KinChatService["Service"], "closeReplaced" | "ask" | "notice">;
  readonly queue: Pick<KinEventQueue.KinEventQueue["Service"], "enqueue">;
  /** Runs a default's own action; without it such a default waits for its person. */
  readonly records?: KinRecords["Service"] | undefined;
};

/**
 * Settles each question whose day came, once: a safe default is taken (its own action run, else
 * the asker's turn queued, as it is marked), one with none is raised once more on the next working
 * morning, a text question lapses. One asked for another chat lapses at its raise's own day, or
 * instead of its raise when its person hasn't signed in (`lapseAsked`). Conditional updates make
 * a rerun do nothing. Then each person a default was taken for is told, once.
 */
export const settleDue = Effect.fn("KinQuestions.settleDue")(function* (
  orgId: KinOrgId,
  now: number,
  deps: SettleDeps,
) {
  const sql = yield* SqlClient.SqlClient;
  // Paused, Kin or its asker, a question waits for resume and fills no pass's batch.
  const due = (yield* isOrgPaused(orgId))
    ? []
    : (yield* sql<Raw>`SELECT ${sql.literal(COLUMNS)} ${sql.literal(FROM)}
        WHERE q.org_id = ${orgId} AND q.state = 'open' AND q.act_at <= ${now}
          AND (q.safe = 1 OR q.raised_at IS NULL
            OR (q.for_chat_id IS NOT NULL AND q.draft_json IS NULL)) AND a.paused_at IS NULL
          AND NOT (q.for_chat_id IS NOT NULL AND q.widget_id IS NULL)
        ORDER BY q.act_at, q.question_id LIMIT 50`).map(toRow);
  let settled = 0;
  for (const row of due) {
    const done = yield* sql
      .withTransaction(
        row.kind === "text"
          ? lapse(orgId, row, now)
          : row.safe
            ? takeDefault(orgId, row, now, deps)
            : raise(orgId, row, now, deps),
      )
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Kin open question not settled", {
            orgId,
            questionId: row.questionId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
    if (done) settled += 1;
  }
  yield* postHeld(orgId, now, deps.chat);
  yield* tellDue(orgId, now, deps.chat);
  return settled;
});

const HeldCardJson = Schema.fromJsonString(
  Schema.Struct({
    detail: Schema.String,
    askedBy: Schema.optional(Schema.String),
    options: Schema.Array(
      Schema.Struct({
        label: Schema.String,
        kind: Schema.optional(Schema.Literals(["yes", "no"])),
      }),
    ),
  }),
);
export const encodeHeldCard = Schema.encodeEffect(HeldCardJson);
const decodeHeldCard = Schema.decodeUnknownOption(HeldCardJson);

/**
 * Each question asked for another chat and held for its person's quiet hours or away days: its
 * card posted once their hold lets it through, its day counted from then. Read each pass, so a
 * changed away date or "I'm back" counts at the next one; held ones fill no pass's batch.
 */
const postHeld = Effect.fn("KinQuestions.postHeld")(function* (
  orgId: KinOrgId,
  now: number,
  chat: SettleDeps["chat"],
) {
  const sql = yield* SqlClient.SqlClient;
  if (yield* isOrgPaused(orgId)) return;
  const held = (yield* sql<Raw & { card: string | null }>`SELECT ${sql.literal(COLUMNS)},
      q.card_json AS card ${sql.literal(FROM)}
    WHERE q.org_id = ${orgId} AND q.state = 'open' AND q.for_chat_id IS NOT NULL
      AND q.widget_id IS NULL AND a.paused_at IS NULL AND a.retired_at IS NULL
    ORDER BY q.asked_at, q.question_id`).map((raw) => ({ row: toRow(raw), card: raw.card }));
  let tried = 0;
  for (const { row, card } of held) {
    if (tried >= TELL_PER_PASS) break;
    if (
      (yield* holdFor({ orgId, personId: row.personId, chatId: row.chatId, unasked: true })) !==
      undefined
    )
      continue;
    tried += 1;
    yield* sql.withTransaction(postHeldCard(orgId, row, card, now, chat)).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Kin couldn't post a held question", {
          orgId,
          questionId: row.questionId,
          cause,
        }),
      ),
    );
  }
});

const postHeldCard = Effect.fn("KinQuestions.postHeldCard")(function* (
  orgId: KinOrgId,
  row: QuestionRow,
  stored: string | null,
  now: number,
  chat: SettleDeps["chat"],
) {
  const sql = yield* SqlClient.SqlClient;
  const card = Option.getOrUndefined(decodeHeldCard(stored));
  const [agent] = yield* sql<{ owner: string; threadId: string | null }>`SELECT
      a.owner_person_id AS owner, l.thread_id AS "threadId"
    FROM kin_agents a JOIN kin_leads l ON l.org_id = a.org_id AND l.agent_id = a.agent_id
    WHERE a.org_id = ${orgId} AND a.agent_id = ${row.agentId} AND a.retired_at IS NULL`;
  if (card === undefined || agent === undefined || agent.threadId === null) return;
  // No longer in that chat, or no longer reachable, they can't be asked there: the chat it was
  // for is told.
  if (
    (yield* personOfChat(orgId, row.chatId)) !== row.personId ||
    (yield* pairRestricted(orgId, row))
  )
    return yield* withdraw(orgId, [row], () => "", now, chat);
  const widget = yield* chat.ask(
    {
      _tag: "agent",
      orgId,
      agentId: row.agentId,
      ownerPersonId: KinPersonId.make(agent.owner),
      threadId: ThreadId.make(agent.threadId),
      hostPosted: true,
    },
    {
      question: row.question,
      detail: card.detail,
      ...(card.askedBy === undefined ? {} : { askedBy: card.askedBy }),
      ...(row.draft === null ? {} : { draft: row.draft.text }),
      options: card.options,
      untilAnswered: true,
      chatId: row.chatId,
      clientMessageId: `kin-asked-held:${row.questionId}`,
      // Its words were checked for them when it was asked (`askPerson`).
      forChat: true,
    },
  );
  // Its day counts from the minute it reached them, never earlier than the day it named.
  const clock = yield* personClock(orgId, row.personId);
  const dueAt = Math.max(row.dueAt, defaultDue(now, clock.zone, clock.work));
  yield* sql`UPDATE kin_questions SET widget_id = ${widget.widgetId}, card_json = NULL,
      due_at = ${dueAt}, act_at = ${raiseAt(dueAt, clock.zone, clock.work)}
    WHERE org_id = ${orgId} AND question_id = ${row.questionId} AND state = 'open'
      AND widget_id IS NULL`;
});

/** The question's person and its agent, or the person it was asked for, are restricted now. */
const pairRestricted = Effect.fn("KinQuestions.pairRestricted")(function* (
  orgId: KinOrgId,
  row: QuestionRow,
) {
  if (
    (yield* Reach.mayReach(orgId, Reach.person(row.personId), Reach.agent(row.agentId))) ===
    "restricted"
  )
    return true;
  return (
    row.forPersonId !== null &&
    (yield* Reach.mayReach(orgId, Reach.person(row.forPersonId), Reach.person(row.personId))) ===
      "restricted"
  );
});

/** Notices told in one pass; ones held for someone away or in quiet hours don't count. */
const TELL_PER_PASS = 50;

/**
 * Each default taken since this was built (`raised_at` marks it owed) whose person, still in its
 * chat, hasn't been told: told now, unless their quiet hours or an away day hold it, when a later
 * pass tells them. Owed until told, however long they are away.
 */
const tellDue = Effect.fn("KinQuestions.tellDue")(function* (
  orgId: KinOrgId,
  now: number,
  chat: SettleDeps["chat"],
) {
  const sql = yield* SqlClient.SqlClient;
  const owed = (yield* sql<Raw>`SELECT ${sql.literal(COLUMNS)} ${sql.literal(FROM)}
    WHERE q.org_id = ${orgId} AND q.state = 'default_taken'
      AND q.raised_at IS NOT NULL AND q.default_label IS NOT NULL AND NOT EXISTS (SELECT 1 FROM kin_pulse_told t
        WHERE t.org_id = q.org_id AND t.person_id = q.person_id
          AND t.fact_key = ${TAKEN_KEY} || q.question_id)
      AND EXISTS (SELECT 1 FROM kin_chat_members m WHERE m.org_id = q.org_id
        AND m.chat_id = q.chat_id AND m.principal_kind = 'person' AND m.person_id = q.person_id
        AND m.left_at IS NULL)
    ORDER BY q.raised_at, q.question_id`).map(toRow);
  let tried = 0;
  for (const row of owed) {
    if (tried >= TELL_PER_PASS) break;
    if ((yield* holdFor({ orgId, personId: row.personId, chatId: row.chatId })) !== undefined)
      continue;
    tried += 1;
    yield* sql
      .withTransaction(
        tellTaken(
          {
            orgId,
            questionId: row.questionId,
            agentId: row.agentId,
            personId: row.personId,
            chatId: row.chatId,
            label: row.defaultLabel!,
            question: row.question,
            about: row.about,
            now,
          },
          chat,
        ),
      )
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Kin couldn't say a default was taken", {
            orgId,
            questionId: row.questionId,
            cause,
          }),
        ),
      );
  }
});

const lapse = Effect.fn("KinQuestions.lapse")(function* (
  orgId: KinOrgId,
  row: QuestionRow,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const moved = yield* sql`UPDATE kin_questions SET state = 'lapsed', closed_at = ${now}
    WHERE org_id = ${orgId} AND question_id = ${row.questionId} AND state = 'open'
    RETURNING question_id`;
  return moved.length > 0;
});

/** The pauses the runner keeps to: the company's (`isOrgPaused`) and the agent's own. */
const pausedFor = Effect.fn("KinQuestions.pausedFor")(function* (orgId: KinOrgId, agentId: string) {
  if (yield* isOrgPaused(orgId)) return true;
  const sql = yield* SqlClient.SqlClient;
  const paused = yield* sql`SELECT 1 FROM kin_agents
    WHERE org_id = ${orgId} AND agent_id = ${agentId} AND paused_at IS NOT NULL`;
  return paused.length > 0;
});

const takeDefault = Effect.fn("KinQuestions.takeDefault")(function* (
  orgId: KinOrgId,
  row: QuestionRow,
  now: number,
  deps: SettleDeps,
) {
  const sql = yield* SqlClient.SqlClient;
  // Paused, Kin or its asker, it stays due: the first pass after resume takes it.
  if (yield* pausedFor(orgId, row.agentId)) return false;
  // Never before its day, and at most once: only an open row past its day moves. `raised_at`
  // marks its person as owed the news (`tellDue`).
  const moved = yield* sql`UPDATE kin_questions SET state = 'default_taken', closed_at = ${now},
      raised_at = ${now}
    WHERE org_id = ${orgId} AND question_id = ${row.questionId} AND state = 'open'
      AND safe = 1 AND due_at <= ${now}
    RETURNING question_id`;
  if (moved.length === 0) return false;
  const option = row.options.find((one) => one.label === row.defaultLabel);
  const acts =
    row.widgetId !== null &&
    option !== undefined &&
    (yield* sealedOptions(orgId, row.widgetId)).has(option.optionId);
  const clock = yield* personClock(orgId, row.personId);
  if (acts) {
    // Its own action runs here, as the asker; one that no longer holds waits for its person.
    const plan = (yield* plansOf(orgId, row.widgetId!)).get(option!.optionId);
    const { takeAtDay } = yield* Effect.promise(() => import("../widgets/cardActions.ts"));
    const ran =
      plan !== undefined &&
      deps.records !== undefined &&
      (yield* takeAtDay(orgId, plan, row, deps.records));
    if (!ran) {
      yield* sql`UPDATE kin_questions SET state = 'open', closed_at = NULL, raised_at = NULL,
          safe = 0, act_at = ${raiseAt(row.dueAt, clock.zone, clock.work)}
        WHERE org_id = ${orgId} AND question_id = ${row.questionId}`;
      return true;
    }
  } else {
    const [lead] = yield* sql<{ ownerChatId: string }>`SELECT owner_chat_id AS "ownerChatId"
      FROM kin_leads WHERE org_id = ${orgId} AND agent_id = ${row.agentId}`;
    const event = yield* decodeEvent({
      _tag: "deferral.due",
      eventId: takeEventId(orgId, row.questionId),
      orgId,
      agentId: row.agentId,
      receivedAt: iso(now),
      provenance: { _tag: "system" },
      dedupeKey: `question:${row.questionId}`,
      subject: { type: "question", questionId: row.questionId },
      lateByMs: Math.max(0, now - row.dueAt),
      ...(lead?.ownerChatId === row.chatId
        ? {}
        : { origin: { agentId: row.agentId, chatId: row.chatId, personId: row.personId } }),
    });
    yield* deps.queue.enqueue(event);
  }
  // The person's own notice says nobody answered (`tellTaken`): the card only reads as closed.
  const went = `Went with “${row.defaultLabel ?? ""}”`;
  for (const widgetId of cardIds(row))
    yield* deps.chat.closeReplaced({
      orgId,
      widgetId: KinWidgetId.make(widgetId),
      outcome: {
        title: went,
        text: acts ? `${went}.` : `${went}. Say "undo it" in the chat to reverse.`,
      },
    });
  return true;
});

const raise = Effect.fn("KinQuestions.raise")(function* (
  orgId: KinOrgId,
  row: QuestionRow,
  now: number,
  deps: SettleDeps,
) {
  const sql = yield* SqlClient.SqlClient;
  const { chat } = deps;
  const [agent] = yield* sql<{ owner: string; threadId: string | null; retiredAt: string | null }>`
    SELECT a.owner_person_id AS owner, l.thread_id AS "threadId", a.retired_at AS "retiredAt"
    FROM kin_agents a LEFT JOIN kin_leads l ON l.org_id = a.org_id AND l.agent_id = a.agent_id
    WHERE a.org_id = ${orgId} AND a.agent_id = ${row.agentId}`;
  // Nobody would ever answer it: it closes as retiring does, so a restore reopens it.
  if (agent?.retiredAt != null)
    return (
      (yield* closeHeldQuestions(
        {
          orgId,
          holder: { agentId: row.agentId },
          reason: (one) => retiredQuestionText(one.agentName),
          closedAt: Date.parse(agent.retiredAt),
        },
        chat,
      )) > 0
    );
  // A pair restricted since it was asked: it closes rather than being raised across it.
  if (yield* pairRestricted(orgId, row)) {
    yield* withdraw(
      orgId,
      [row],
      (one) => `You and ${one.agentName} can't message each other here.`,
      now,
      chat,
    );
    return true;
  }
  // Asked for someone, it ends unanswered at its raise's own day, or now when its person hasn't
  // signed in: asking again in Kin can't reach them. A sent-up draft waits on the owner as before.
  const lapses = row.forChatId !== null && row.draft === null;
  if (lapses && (row.raisedAt !== null || !(yield* signedIn(orgId, row.personId))))
    return yield* lapseAsked(orgId, row, now, deps);
  const clock = yield* personClock(orgId, row.personId);
  const moved = yield* sql`UPDATE kin_questions SET raised_at = ${now},
      act_at = ${lapses ? defaultDue(now, clock.zone, clock.work) : row.actAt}
    WHERE org_id = ${orgId} AND question_id = ${row.questionId} AND state = 'open'
      AND raised_at IS NULL
    RETURNING question_id`;
  if (moved.length === 0 || row.options.length < 2) return moved.length > 0;
  if (agent === undefined || agent.threadId === null) return true;
  // An option that runs an action is drawn again, as a new card's; one that no longer holds is
  // left off, and a default left off leaves the raised card with none. The stored options are
  // the last card's, so their seals are too.
  const last = row.raiseWidgetId ?? row.widgetId;
  const sealed = last === null ? new Map<string, CardPlan>() : yield* plansOf(orgId, last);
  const acting = last === null ? new Set<string>() : yield* sealedOptions(orgId, last);
  const offered: Array<{
    readonly label: string;
    readonly drawn?: Effect.Success<ReturnType<typeof CardActions.redraw>>;
  }> = [];
  let defaultLabel: string | null = null;
  // Loaded here: cardActions reaches KinChatService, which imports this module.
  const { redraw } = yield* Effect.promise(() => import("../widgets/cardActions.ts"));
  for (const option of row.options) {
    const plan = sealed.get(option.optionId);
    const drawn = plan === undefined ? undefined : yield* redraw(orgId, row.chatId, plan);
    if (acting.has(option.optionId) && drawn === undefined) continue;
    const label = drawn?.label ?? option.label;
    if (option.label === row.defaultLabel) defaultLabel = label;
    offered.push({ label, drawn });
  }
  if (defaultLabel !== row.defaultLabel)
    yield* sql`UPDATE kin_questions SET default_label = ${defaultLabel}
      WHERE org_id = ${orgId} AND question_id = ${row.questionId}`;
  // Too few left for a card: the last card stays open, each tap on it checked as it runs. A
  // default left off is said once, so it is raised only once its person has heard. With no card
  // open (a retirement closed it), nothing is left to tap: the question closes, saying why.
  if (offered.length < 2) {
    const [open] =
      last === null
        ? []
        : yield* sql`SELECT 1 FROM kin_widgets
            WHERE org_id = ${orgId} AND widget_id = ${last} AND closed_at IS NULL`;
    if (open === undefined) {
      yield* sql`UPDATE kin_questions SET state = 'withdrawn', closed_at = ${now}
        WHERE org_id = ${orgId} AND question_id = ${row.questionId} AND state = 'open'`;
      yield* tellWithdrawn(
        {
          orgId,
          questionId: row.questionId,
          agentId: row.agentId,
          personId: row.personId,
          chatId: row.chatId,
          question: row.question,
        },
        chat,
      );
      return true;
    }
    if (row.defaultLabel !== null && defaultLabel === null) {
      const option = row.options.find((one) => one.label === row.defaultLabel);
      const plan = option === undefined ? undefined : sealed.get(option.optionId);
      yield* tellDeclined(
        {
          orgId,
          questionId: row.questionId,
          agentId: row.agentId,
          personId: row.personId,
          chatId: row.chatId,
          label: row.defaultLabel,
          recordId: plan !== undefined && "recordId" in plan ? plan.recordId : undefined,
        },
        chat,
      );
    }
    return true;
  }
  const said = `${row.agentName} asked ${dayWord(row.askedAt, now, clock.zone)}. Nothing happens until you answer.`;
  // Asked for someone, it says who still: the server's line, as on the first card.
  const by =
    row.forChatId === null
      ? undefined
      : askedBy(
          row.forPersonId === null ? null : yield* personName(orgId, row.forPersonId),
          row.agentName,
        );
  const asked = {
    question: oneLine(`${STILL_OPEN}${row.question}`, 240),
    // A sent-up draft is raised from its stored payload, Approve still its one of kind yes.
    detail:
      row.draft !== null
        ? draftDetail(by === undefined ? said : `${by}\n${said}`, row.draft)
        : by === undefined
          ? said
          : `${by}\n${said}`,
    ...(by === undefined ? {} : { askedBy: by }),
    ...(row.draft === null ? {} : { draft: row.draft.text }),
    options:
      row.draft !== null
        ? DRAFT_OPTIONS.map((one) => ({ ...one }))
        : offered.map((option) => ({ label: option.label })),
    actions:
      row.draft !== null
        ? DRAFT_OPTIONS.map(() => undefined)
        : offered.map((option) => option.drawn),
    untilAnswered: true as const,
  };
  const card = yield* chat.ask(
    {
      _tag: "agent",
      orgId,
      agentId: row.agentId,
      ownerPersonId: KinPersonId.make(agent.owner),
      threadId: ThreadId.make(agent.threadId),
      hostPosted: true,
    },
    {
      ...asked,
      chatId: row.chatId,
      // Keyed on the card it replaces: a reopened question's raise draws anew, a retry finds its own.
      clientMessageId: `kin-question-raise:${row.questionId}${row.raiseWidgetId === null ? "" : `:${row.raiseWidgetId}`}`,
      ...(row.forChatId === null ? {} : { forChat: true as const }),
    },
  );
  const options = choiceCardState(asked).options.map(({ optionId, label }) => ({
    optionId,
    label,
  }));
  yield* sealPlans({
    orgId,
    chatId: row.chatId,
    widgetId: card.widgetId,
    plans: offered.flatMap((option, index) =>
      option.drawn === undefined
        ? []
        : [{ optionId: options[index]!.optionId, plan: option.drawn.plan }],
    ),
    now,
  });
  yield* sql`UPDATE kin_questions SET raise_widget_id = ${card.widgetId},
      options_json = ${yield* encodeOptions(options).pipe(Effect.orDie)}
    WHERE org_id = ${orgId} AND question_id = ${row.questionId}`;
  if (row.widgetId !== null)
    yield* chat.closeReplaced({
      orgId,
      widgetId: KinWidgetId.make(row.widgetId),
      by: card.widgetId,
    });
  // Keyed on the question, so a reopened one raised again tells the chat that asked nothing more.
  if (row.forChatId !== null) {
    const who = yield* personName(orgId, row.personId);
    yield* chat
      .notice({
        orgId,
        chatId: row.forChatId,
        messageId: KinMessageId.make(`kin-asked-again:${row.questionId}`),
        audience: "chat",
        body: oneLine(
          `${who} hasn't answered “${row.question}” by its day; Kin asked ${who} once more.`,
          600,
        ),
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Kin couldn't tell the asker a question ran past its day", {
            orgId,
            questionId: row.questionId,
            cause,
          }),
        ),
      );
  }
  return true;
});

/** The asker's turn on a question asked for another chat that lapsed: one per question. */
const lapsedEventId = (orgId: string, questionId: string) =>
  KinEventId.make(`question_${hash(`${orgId}\0${questionId}\0lapsed`).slice(0, 32)}`);
/** "Mon 16 Nov", on `zone`'s clock. */
const dayOf = (at: number, zone: string) =>
  formatKinWhen(at, "day", { zone, locale: KIN_TEXT_LOCALE }).replace(/,/g, "");
const shortQuote = (text: string) => `“${oneLine(text, 80)}”`;

/** What a lapsed question's card says to a client that doesn't read `lapsed`. */
export const lapsedCardText = (who: string, day: string) =>
  `Lapsed on ${day}: ${who} didn't answer.`;

/**
 * Kin's one line in the chat a question was asked for, once it lapsed: who, what and since when.
 * `question` is null where that chat's person may no longer read it.
 */
export const lapsedNotice = (input: {
  readonly who: string;
  readonly question: string | null;
  readonly asked: string;
  readonly unsigned: boolean;
}) => {
  const what =
    input.question === null ? "a question asked for this chat" : shortQuote(input.question);
  return input.unsigned
    ? `${input.who} hasn't signed in to Kin, so ${what}, asked on ${input.asked}, lapsed without an answer.`
    : `${input.who} didn't answer ${what}, asked on ${input.asked}. It has lapsed.`;
};

/**
 * A question asked for another chat ends unanswered, in the sweep's transaction: it closes as
 * lapsed, its card says so, the chat it was asked for hears once (`kin-asked-lapsed:<id>`), and its
 * asker is woken there once to carry on without it. One raised before this was built gets its
 * raise's day first.
 */
const lapseAsked = Effect.fn("KinQuestions.lapseAsked")(function* (
  orgId: KinOrgId,
  row: QuestionRow,
  now: number,
  deps: SettleDeps,
) {
  const sql = yield* SqlClient.SqlClient;
  const forChatId = row.forChatId;
  if (forChatId === null) return false;
  const clock = yield* personClock(orgId, row.personId);
  if (row.raisedAt !== null) {
    const day = defaultDue(row.raisedAt, clock.zone, clock.work);
    if (now < day) {
      yield* sql`UPDATE kin_questions SET act_at = ${day}
        WHERE org_id = ${orgId} AND question_id = ${row.questionId} AND state = 'open'`;
      return false;
    }
  }
  const moved = yield* sql`UPDATE kin_questions SET state = 'lapsed', closed_at = ${now}
    WHERE org_id = ${orgId} AND question_id = ${row.questionId} AND state = 'open'
    RETURNING question_id`;
  if (moved.length === 0) return false;
  const who = yield* personName(orgId, row.personId);
  for (const widgetId of cardIds(row))
    yield* deps.chat.closeReplaced({
      orgId,
      widgetId: KinWidgetId.make(widgetId),
      outcome: {
        title: "Lapsed",
        text: lapsedCardText(who, dayOf(now, clock.zone)),
        lapsed: { personId: row.personId, name: who, at: iso(now) },
      },
    });
  // Its words only to the person it was asked for, while they may still read them.
  const asker = yield* personOfChat(orgId, forChatId);
  const askerLevel = asker !== undefined && (yield* ownerLevel(orgId, asker));
  const reads =
    asker !== undefined &&
    (row.forPersonId === null ? askerLevel : asker === row.forPersonId) &&
    (askerLevel || (yield* unreadableBy(orgId, asker, row.question)) === undefined);
  const zone = asker === undefined ? clock.zone : (yield* personClock(orgId, asker)).zone;
  yield* deps.chat
    .notice({
      orgId,
      chatId: forChatId,
      messageId: KinMessageId.make(`kin-asked-lapsed:${row.questionId}`),
      audience: "chat",
      body: lapsedNotice({
        who,
        question: reads ? row.question : null,
        asked: dayOf(row.askedAt, zone),
        unsigned: row.raisedAt === null,
      }),
    })
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Kin couldn't tell the asker a question lapsed", {
          orgId,
          questionId: row.questionId,
          cause,
        }),
      ),
    );
  yield* wakeAsker(orgId, row, forChatId, now, deps.queue, {
    eventId: lapsedEventId(orgId, row.questionId),
    dedupeKey: `question-lapsed:${row.questionId}`,
    subject: { type: "question", questionId: row.questionId, lapsed: true },
    notNow: notLapsedNow,
  });
  return true;
});
const notLapsedNow = new KinChatError({
  reason: "conflict",
  message: "Kin couldn't tell the asker that question lapsed just now.",
});

const personName = Effect.fn("KinQuestions.personName")(function* (
  orgId: KinOrgId,
  personId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
    WHERE org_id = ${orgId} AND person_id = ${personId}`;
  return row?.name ?? "them";
});

/** What the turn that takes a question's default is told; undefined when there is nothing to take. */
export const dueTurnText = Effect.fn("KinQuestions.dueTurnText")(function* (
  orgId: KinOrgId,
  questionId: string,
  now: number,
) {
  const row = yield* readQuestion(orgId, questionId);
  if (row === undefined || row.state !== "default_taken" || row.defaultLabel === null)
    return undefined;
  const clock = yield* personClock(orgId, row.personId);
  const who = yield* personName(orgId, row.personId);
  return {
    text: `Your question to ${who}, asked ${dayWord(row.askedAt, now, clock.zone)}, got no answer by its day, and its card now says you went with your default. Do “${row.defaultLabel}” now with your tools, inside the company only: anything that would send, post or move money stays on its Confirm card. Kin tells ${who} it went with “${row.defaultLabel}”, so don't say that again. Don't ask it again.`,
    data: {
      question: row.question,
      options: row.options.map((option) => option.label),
      default: row.defaultLabel,
      ...(row.about.length === 0 ? {} : { about: row.about }),
    },
  };
});

/**
 * What the asker's turn is told when its person undid what was taken: a default Kin took, or
 * (`words`) the answer the asker took from their words. Undefined when there is nothing to say.
 */
export const undoneTurnText = Effect.fn("KinQuestions.undoneTurnText")(function* (
  orgId: KinOrgId,
  subject: { readonly questionId: string; readonly words?: true | undefined },
) {
  const row = yield* readQuestion(orgId, subject.questionId);
  if (row === undefined) return undefined;
  // Which was undone is the event's, never read off the row: it may have moved on since.
  if (subject.words === true) {
    const who = yield* personName(orgId, row.personId);
    const now =
      row.state === "open"
        ? "It is open again on its card, waiting for their answer with no default. Don't act on that answer or ask again; wait for theirs."
        : row.state === "answered"
          ? `It has since been answered${row.answer === null ? "" : `: “${row.answer}”`}. Don't act on the undone answer, and don't ask again.`
          : "It has since been closed, so don't act on the undone answer or ask again.";
    return `Your question to ${who}, “${row.question}”: ${who} undid the answer you took from their words. ${now}`;
  }
  if (row.state !== "default_taken" || row.defaultLabel === null) return undefined;
  return `Your question to ${yield* personName(orgId, row.personId)}, “${row.question}”, got no answer, so Kin took your default “${row.defaultLabel}”. It has now been undone: what it changed is back as it was. Don't do it again or ask the same again; ask anew only if it still needs deciding.`;
});

/**
 * What the asker's turn is told when its person dismissed its question without choosing, or
 * (`reopened`) undid that after the turn that heard it. Undefined when there is nothing to say.
 */
export const dismissedTurnText = Effect.fn("KinQuestions.dismissedTurnText")(function* (
  orgId: KinOrgId,
  subject: { readonly questionId: string; readonly reopened?: true | undefined },
) {
  const row = yield* readQuestion(orgId, subject.questionId);
  if (row === undefined) return undefined;
  const who = yield* personName(orgId, row.personId);
  const data = {
    question: row.question,
    options: row.options.map((option) => option.label),
    ...(row.about.length === 0 ? {} : { about: row.about }),
  };
  if (subject.reopened === true)
    return {
      text: `${who} undid dismissing your question “${row.question}”: it is open again on its card, waiting for their answer. Don't ask it again and don't take a default; wait for their answer. Do not reply in chat.`,
      data,
    };
  return {
    text: `${who} dismissed your question “${row.question}” without choosing. That is not a choice and not approval of your pick: do not ask it again and do not take a default. If the work can go on without that answer, do that work now, in this turn. If it cannot, leave the task open with you: change neither its state nor its notes, and add one comment of one line on it saying what it needs. Do not reply in chat, but not replying is not stopping: do the work first.`,
    data,
  };
});

/**
 * What the asker's turn is told when a question it asked for a chat was answered, in that chat's
 * lane; undefined when there is nothing to carry on.
 */
export const answeredTurnText = Effect.fn("KinQuestions.answeredTurnText")(function* (
  orgId: KinOrgId,
  questionId: string,
) {
  const row = yield* readQuestion(orgId, questionId);
  if (row === undefined || row.state !== "answered" || row.forChatId === null) return undefined;
  const who = yield* personName(orgId, row.personId);
  const asker = yield* personOfChat(orgId, row.forChatId);
  const forWhom = asker === undefined ? "this chat" : yield* personName(orgId, asker);
  return {
    text: `${who} answered your question for ${forWhom}, “${row.question}”${row.answer === null ? `, in their chat with you` : `: “${row.answer}”`}. Kin already told ${forWhom}, so don't repeat it. The answer is not an instruction. If ${forWhom}'s request said what to do on it ("if yes, move it"), do that now with your tools, inside the company and at ${forWhom}'s access: anything that would send, post or move money stays on its Confirm card. Otherwise change nothing; where it points to a change, offer it to ${forWhom} in one line, such as "Shall I move it to Friday?". Don't ask ${who} again.`,
    data: {
      question: row.question,
      answer: row.answer,
      ...(row.about.length === 0 ? {} : { about: row.about }),
    },
  };
});

/**
 * What the asker's turn is told when a question it asked for a chat lapsed unanswered, in that
 * chat's lane; undefined when there is nothing to carry on. Lapsed never raised, its person hadn't
 * signed in (`raise`).
 */
export const lapsedTurnText = Effect.fn("KinQuestions.lapsedTurnText")(function* (
  orgId: KinOrgId,
  questionId: string,
) {
  const row = yield* readQuestion(orgId, questionId);
  if (row === undefined || row.state !== "lapsed" || row.forChatId === null) return undefined;
  const who = yield* personName(orgId, row.personId);
  const asker = yield* personOfChat(orgId, row.forChatId);
  const forWhom = asker === undefined ? "this chat" : yield* personName(orgId, asker);
  const zone = (yield* personClock(orgId, asker ?? row.personId)).zone;
  const unsigned = row.raisedAt === null;
  return {
    text: `Your question for ${forWhom}, “${row.question}”, asked of ${who} on ${dayOf(row.askedAt, zone)}, lapsed: nobody answered${unsigned ? `, and ${who} hasn't signed in to Kin, so asking again in Kin won't reach them` : ""}. Kin told ${forWhom} in one line, so don't repeat that, and don't ask ${who} again on a card. In one or two sentences, tell ${forWhom} what you'll do without the answer, or that you'll ask someone else or take it to the owner, and then do it.`,
    data: {
      question: row.question,
      asked: who,
      signedIn: !unsigned,
      ...(row.about.length === 0 ? {} : { about: row.about }),
    },
  };
});

/**
 * Every open question to the person this chat is with, whoever asked: listed in each agent's turn
 * like facts already told, so no agent asks one again. Record keys only in owner-only turns.
 */
export const openQuestionsSection = Effect.fn("KinQuestions.section")(function* (input: {
  readonly orgId: KinOrgId;
  readonly chatId: string;
  readonly ownerOnly: boolean;
  readonly now: number;
}) {
  const personId = yield* personOfChat(input.orgId, input.chatId);
  if (personId === undefined) return undefined;
  const open = yield* openFor(input.orgId, personId);
  if (open.length === 0) return undefined;
  const clock = yield* personClock(input.orgId, personId);
  const who = yield* personName(input.orgId, personId);
  const forWhom = new Map<string, string>();
  for (const row of open)
    if (row.forChatId !== null && !forWhom.has(row.forChatId)) {
      const asker = yield* personOfChat(input.orgId, row.forChatId);
      forWhom.set(
        row.forChatId,
        asker === undefined ? "another chat" : yield* personName(input.orgId, asker),
      );
    }
  const lines = open.slice(-8).map((row) => {
    const tail =
      row.kind === "text"
        ? "asked in text: their next message in that chat answers it"
        : row.defaultLabel !== null && row.safe
          ? `default “${row.defaultLabel}” ${dayWord(row.dueAt, input.now, clock.zone)}`
          : row.raisedAt === null
            ? `no safe default: raised once more ${dayWord(row.actAt, input.now, clock.zone)}, then it waits for them`
            : "no safe default: waits for them";
    const about = input.ownerOnly && row.about.length > 0 ? ` (about ${row.about.join(", ")})` : "";
    const asker = row.forChatId === null ? "" : ` for ${forWhom.get(row.forChatId)}`;
    return `- ${row.questionId}, ${row.agentName}${asker}, ${dayWord(row.askedAt, input.now, clock.zone).replace(/^on /, "")}: “${row.question}”${about}; ${tail}`;
  });
  return {
    heading: openQuestionsHeading(who),
    body: [
      "Like a fact already told, each is with them once: never put one to them again, on a card or in words; at most say it is open and what happens at its day. When they answer one of yours in words in its chat, kin_ask_close it as answered; withdraw yours when it no longer stands. Another agent's is that agent's to close. A task one of yours is about waits on its answer: never set it done.",
      ...(forWhom.size === 0
        ? []
        : [
            "One marked “for” someone was asked for their chat: Kin sends the answer back there, and only that chat withdraws it.",
          ]),
      ...lines,
    ].join("\n"),
  };
});

/**
 * The questions this agent asked someone else for this chat, still open: so a turn here can say
 * truly whether they answered. Their answer arrives here as Kin's line.
 */
export const askedForSection = Effect.fn("KinQuestions.askedForSection")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly chatId: string;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const open = (yield* sql<Raw>`SELECT ${sql.literal(COLUMNS)} ${sql.literal(FROM)}
    WHERE q.org_id = ${input.orgId} AND q.agent_id = ${input.agentId}
      AND q.for_chat_id = ${input.chatId} AND q.state = 'open'
    ORDER BY q.asked_at DESC, q.question_id LIMIT 8`).map(toRow);
  if (open.length === 0) return undefined;
  const zone = yield* ownerZone(input.orgId);
  const lines: Array<string> = [];
  for (const row of open.toReversed())
    lines.push(
      `- ${row.questionId}, to ${yield* personName(input.orgId, row.personId)}, ${dayWord(row.askedAt, input.now, zone).replace(/^on /, "")}: “${row.question}”; ${
        row.widgetId === null
          ? "held for their quiet hours or away days: Kin posts it when they're free"
          : "waiting on their answer in their chat with you"
      }`,
    );
  return {
    heading: OPEN_QUESTION_HEADINGS.askedHere,
    body: [
      "Each waits on its person, with no default. When one answers, Kin says so here and wakes you to carry on; until then say it is with them, and don't ask again. Withdraw one with kin_ask_close when it no longer stands.",
      ...lines,
    ].join("\n"),
  };
});

/**
 * In the owner's own turn in her chat with the agent, the drafts there that wait on her redraft
 * (`waitingRedrafts`), so a fresh turn knows the redo's way back up.
 */
export const redraftsSection = Effect.fn("KinQuestions.redraftsSection")(function* (
  turn: { readonly orgId: KinOrgId; readonly agentId: KinAgentId; readonly wakeupId: string },
  chatId: KinChatId,
) {
  const waiting = yield* waitingRedrafts(turn, chatId);
  if (waiting.length === 0) return undefined;
  return {
    heading: OPEN_QUESTION_HEADINGS.draftsBack,
    body: waiting
      .map(({ draft }) => {
        const party = draft.for === null ? "" : ` for ${draft.for.title} (${draft.for.key})`;
        return `- ${draft.names.asker}'s ${DRAFT_WORDS[draft.kind]}${party}: its new draft goes up with kin_ask_person and draft, or doc_create with draft; Kin puts it back on ${draft.names.owner}'s Approve card.`;
      })
      .join("\n"),
  };
});

/**
 * At the end of a turn: when the agent's last words in a direct chat with one person ended on a
 * question, and it asked no card, that question is stored as open (`recordTextQuestion`).
 */
export const flagTextQuestion = Effect.fn("KinQuestions.flagText")(function* (wake: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly wakeupId: string;
  readonly threadId: string;
  readonly startedAt: number;
  readonly chatId: KinChatId;
}) {
  const sql = yield* SqlClient.SqlClient;
  const said = yield* sql<{ body: string; card: number }>`SELECT body,
      widget_id IS NOT NULL AS card FROM kin_messages
    WHERE org_id = ${wake.orgId} AND chat_id = ${wake.chatId} AND author_kind = 'agent'
      AND author_agent_id = ${wake.agentId} AND author_thread_id = ${wake.threadId}
      AND created_at >= ${iso(wake.startedAt)} AND status = 'posted'
    ORDER BY seq`;
  if (said.length === 0 || said.some((row) => row.card === 1)) return undefined;
  const question = endingQuestion(said.at(-1)!.body);
  if (question === undefined) return undefined;
  return yield* recordTextQuestion({
    orgId: wake.orgId,
    agentId: wake.agentId,
    chatId: wake.chatId,
    wakeupId: wake.wakeupId,
    question,
    now: yield* Clock.currentTimeMillis,
  });
});
