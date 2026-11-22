import {
  type KinAgentId,
  KinChatError,
  type KinChatId,
  KinChoiceCardState,
  KinChoiceOption,
  type KinOrgId,
  type KinPersonId,
  KinText,
  KinTrimmedText,
  type KinWakeupId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import { storedClientId } from "../chat/KinChatRepository.ts";
import { keysIn } from "../chat/messageLinks.ts";
import type { KinChatService } from "../chat/KinChatService.ts";
import type { AgentIdentity } from "../chat/KinIdentity.ts";
import {
  aborted,
  askersDirectChat,
  effectiveAudience,
  mayReadChat,
  turnAsker,
  turnPeople,
} from "../lead/Audience.ts";
import { arrivesNote } from "../lead/Handoff.ts";
import { directKey } from "../lead/LeadAccess.ts";
import type { KinLevelGate } from "../lead/LevelGate.ts";
import { outsideStamp, stampEvent } from "../lead/OutsideContent.ts";
import * as Reach from "../lead/Reach.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import { signedIn } from "../people/signedIn.ts";
import { heldUntil } from "../triggers/quietHold.ts";
import { personMiss, personNamed } from "../people/personNamed.ts";
import { laneFor } from "../reply/replyLane.ts";
import { choiceCardState } from "../widgets/choiceCard.ts";
import { personSees, unreadableBy, withoutOwnFigures } from "../work/teamView.ts";
import {
  DRAFT_KINDS,
  answeredEventId,
  approvalOf,
  CHANGES_FIRST,
  decodeStoredDraft,
  DRAFT_OPTIONS,
  draftDetail,
  draftLine,
  encodeStoredDraft,
  type StoredDraft,
} from "./approval.ts";
import { askedBy, encodeHeldCard, openFor, personClock, readQuestion } from "./openQuestions.ts";
import { defaultDue, namedDue, normaliseAbout, normaliseIntent, raiseAt } from "./rules.ts";

/** What an agent asks someone outside the chat: `kin_ask`'s card, with no default or actions. */
export const AskPersonInput = Schema.Struct({
  to: KinTrimmedText.check(Schema.isMaxLength(120)),
  question: KinTrimmedText.check(Schema.isMaxLength(240)),
  options: Schema.optional(
    Schema.Array(
      Schema.Struct({ label: KinChoiceOption.fields.label, kind: KinChoiceOption.fields.kind }),
    ).check(Schema.isMinLength(2), Schema.isMaxLength(4)),
  ),
  detail: Schema.optional(KinText.check(Schema.isMaxLength(1800))),
  by: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(10))),
  about: Schema.optional(
    Schema.Array(KinTrimmedText.check(Schema.isMaxLength(20))).check(Schema.isMaxLength(8)),
  ),
  intent: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(120))),
  draft: Schema.optional(
    Schema.Struct({
      kind: Schema.Literals(DRAFT_KINDS),
      for: Schema.optional(
        KinTrimmedText.check(Schema.isMaxLength(120)).annotate({
          description: "The key of the client or deal it is for.",
        }),
      ),
    }).annotate({
      description:
        "Only from a teammate's own chat, to the owner: detail is a draft of what only the owner may finish for them. Leave out options: Kin adds Approve and Changes first, and his Approve has you make that one thing at the owner's level.",
    }),
  ),
});

/** What `kin_ask_person` returns: where the question is, and what to tell whoever asked. */
export const AskPersonResult = Schema.Struct({
  questionId: KinTrimmedText,
  to: KinTrimmedText,
  state: Schema.Literals(["posted", "held"]),
  at: Schema.optional(Schema.Number),
  dueAt: Schema.Number,
  retry: Schema.Boolean,
  signedIn: Schema.optional(Schema.Boolean),
  note: KinTrimmedText,
});

/** What the agent is told when the person has never signed in: it waits, and nobody was alerted. */
const notSignedIn = (name: string) =>
  `${name} hasn't signed in to Kin yet: it waits in their chat with you and reaches them when they do. Nobody was alerted. Their answer comes back here.`;

/** At most this many questions asked for others wait on one person, from every agent together. */
const ASKED_FOR_PER_PERSON = 3;
const NOTHING = "Nothing was asked.";
const refuse = (message: string) =>
  new KinChatError({ reason: "not_allowed", message: `${message} ${NOTHING}` });
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
/** Draft kinds a teammate files as her own card, which she sends up herself. */
const CARD_KINDS: ReadonlyArray<StoredDraft["kind"]> = ["mail", "post"];
const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const cardHolds = Schema.is(KinChoiceCardState.fields.detail);
/** One redo of an answered draft per turn: a retry finds it. */
const redoId = (questionId: string, wakeupId: string) =>
  `q-${hash(`for:redo:${questionId}:${wakeupId}`).slice(0, 12)}`;

/** The same thing asked of the same person: one intent, and a record in common unless one names none. */
const askedAgain = (
  asked: { readonly intent: string; readonly about: ReadonlyArray<string> },
  open: { readonly intent: string; readonly about: ReadonlyArray<string> },
) =>
  asked.intent !== "" && asked.intent === open.intent
    ? asked.about.length === 0 ||
      open.about.length === 0 ||
      asked.about.some((key) => open.about.includes(key))
    : asked.intent === "" && asked.about.some((key) => open.about.includes(key));

/**
 * A question card to one person outside the chat, for it: to anyone in the company who may
 * message the agent (`Reach`), from the owner side or from a teammate's own chat with it.
 * Checked against the people behind the turn, in the write's transaction. Held for their quiet
 * hours, it is stored and posted later (`settleDue`); a retry returns the stored question.
 */
export const askPerson = Effect.fn("KinQuestions.askPerson")(function* (
  lead: AgentIdentity & { readonly wakeupId: KinWakeupId },
  input: typeof AskPersonInput.Type,
  deps: AskDeps,
) {
  return yield* ask({ _tag: "turn", lead }, input, deps.chat, deps.gate.askTo);
});

/**
 * A teammate's own "Send to" on a draft card in their direct chat with the agent: the same ask,
 * from them, as their message there would have the agent make it. A second press finds the first.
 */
export const sendUpFromCard = Effect.fn("KinQuestions.sendUpFromCard")(function* (
  press: Omit<Press, "_tag" | "mayPost">,
  input: typeof AskPersonInput.Type,
  deps: {
    readonly chat: AskDeps["chat"] & Pick<KinChatService["Service"], "mayPost">;
    readonly gate: Pick<KinLevelGate["Service"], "askToOnPress">;
  },
) {
  const mayPost = deps.chat.mayPost(
    { _tag: "person", orgId: press.agent.orgId, personId: press.personId },
    press.chatId,
  );
  return yield* ask({ _tag: "press", ...press, mayPost }, input, deps.chat, deps.gate.askToOnPress);
});

type AskDeps = {
  readonly chat: Pick<KinChatService["Service"], "createDirect" | "notice">;
  readonly gate: Pick<KinLevelGate["Service"], "askTo">;
};
type Press = {
  readonly _tag: "press";
  readonly agent: AgentIdentity;
  readonly personId: KinPersonId;
  readonly chatId: KinChatId;
  readonly widgetId: string;
  /** A post's service, by name, as the draft's card holds it. */
  readonly on?: string;
  /** The turn that wrote the card: what she wrote it from is hers here too (`draftSource`). */
  readonly madeIn?: KinWakeupId | undefined;
  /** Checks the press as a message of theirs in that chat would be checked (`send`). */
  readonly mayPost: ReturnType<KinChatService["Service"]["mayPost"]>;
};
type TurnLead = AgentIdentity & { readonly wakeupId: KinWakeupId };
/** A draft still waiting on the owner's Changes first, as `redoOf` found it. */
export type Redraft = {
  readonly questionId: string;
  readonly question: string;
  readonly about: ReadonlyArray<string>;
  readonly intent: string;
  readonly forChatId: KinChatId;
  readonly forPersonId: KinPersonId;
  readonly draft: StoredDraft;
};
type AskFrom =
  | { readonly _tag: "turn"; readonly lead: TurnLead }
  | Press
  /** The owner's turn redrafting one that waits on her Changes first: asked for its chat again. */
  | { readonly _tag: "redo"; readonly lead: TurnLead; readonly of: Redraft };

/**
 * The owner's redraft of a teammate's draft she answered Changes first on goes to her again as
 * the first one did: the same ask, for the teammate's chat, from the answered question.
 */
export const redo = Effect.fn("KinQuestions.redo")(function* (
  lead: TurnLead,
  of: Redraft,
  text: string,
  deps: AskDeps,
) {
  return yield* ask(
    { _tag: "redo", lead, of },
    {
      to: lead.ownerPersonId,
      question: of.question,
      detail: text,
      draft: {
        kind: of.draft.kind,
        ...(of.draft.for === null ? {} : { for: of.draft.for.key }),
      },
      ...(of.about.length === 0 ? {} : { about: of.about }),
      ...(of.intent === "" ? {} : { intent: of.intent }),
    },
    deps.chat,
    deps.gate.askTo,
  );
});

/**
 * In the owner's own turn in her chat with the agent, the one teammate's draft she answered
 * Changes first on there and that no later round replaced, which this redraft is: the same kind
 * for the same client, or an edit of a doc it was about. Undefined unless exactly one.
 */
export const redoOf = Effect.fn("KinQuestions.redoOf")(function* (
  turn: { readonly orgId: KinOrgId; readonly agentId: KinAgentId; readonly wakeupId: KinWakeupId },
  redraft:
    | { readonly kind: StoredDraft["kind"]; readonly partyId: string | null }
    | { readonly docKey: string },
) {
  const sql = yield* SqlClient.SqlClient;
  if ((yield* effectiveAudience(turn)) !== "owner_only") return undefined;
  if ((yield* approvalOf(turn))._tag !== "none") return undefined;
  const lane = yield* laneFor(turn);
  if (Option.isNone(lane) || lane.value.team === true) return undefined;
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
      AND q.chat_id = ${lane.value.chatId} AND q.person_id = a.owner_person_id
      AND q.draft_json IS NOT NULL AND q.state = 'answered' AND q.answer = ${CHANGES_FIRST}
      AND q.approved_at IS NULL AND q.for_chat_id IS NOT NULL AND q.for_person_id IS NOT NULL
    ORDER BY q.question_id`;
  // A later round of the same draft replaced it, unless it is this turn's own redo of it.
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
  const found = current.flatMap((row) =>
    Option.toArray(decodeStoredDraft(row.draft)).flatMap((draft) => {
      const about = row.about === "" ? [] : row.about.split(" ");
      const same =
        "docKey" in redraft
          ? about.includes(redraft.docKey)
          : draft.kind === redraft.kind && (draft.for?.partyId ?? null) === redraft.partyId;
      return same ? [{ ...row, about, draft }] : [];
    }),
  );
  return found.length === 1 ? found[0] : undefined;
});

const ask = Effect.fn("KinQuestions.ask")(function* (
  from: AskFrom,
  input: typeof AskPersonInput.Type,
  chat: AskDeps["chat"],
  askTo: KinLevelGate["Service"]["askTo"],
) {
  const sql = yield* SqlClient.SqlClient;
  const lead = from._tag === "press" ? from.agent : from.lead;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const { orgId, agentId } = lead;
      const turn = from._tag === "press" ? null : { orgId, agentId, wakeupId: from.lead.wakeupId };
      const press = from._tag === "press" ? from : null;
      const redone = from._tag === "redo" ? { ...from.of, wakeupId: from.lead.wakeupId } : null;
      if (press !== null) yield* press.mayPost;
      if (turn !== null && (yield* aborted(turn)))
        return yield* refuse("Someone else joined this chat while you were working.");
      if (turn !== null && (yield* passedOn(turn)))
        return yield* refuse(
          "This was passed on to you by another agent, so it stops with you: ask nobody further from here.",
        );
      const lane = turn === null || redone !== null ? null : yield* laneFor(turn);
      const own =
        press ??
        (redone === null ? null : { chatId: redone.forChatId, personId: redone.forPersonId });
      const [here] =
        own !== null
          ? yield* sql<{ chatId: KinChatId }>`SELECT chat_id AS "chatId" FROM kin_chats
              WHERE org_id = ${orgId} AND chat_id = ${own.chatId} AND kind = 'direct'
                AND archived_at IS NULL AND direct_key = ${directKey(own.personId, agentId)}`
          : lane === null || lane._tag === "None" || lane.value.team === true
            ? []
            : yield* sql<{ chatId: KinChatId }>`SELECT chat_id AS "chatId" FROM kin_chats
                WHERE org_id = ${orgId} AND chat_id = ${lane.value.chatId} AND kind = 'direct'
                  AND archived_at IS NULL`;
      if (here === undefined)
        return yield* refuse(
          "Only a direct chat with one person asks someone else for them, never a group or the Team room.",
        );
      const found = yield* personNamed(orgId, input.to);
      if (found._tag !== "found") return yield* refuse(personMiss(input.to, found));
      const target = found.item;
      const [self] = yield* sql<{ name: string; owner: KinPersonId }>`SELECT l.name,
          a.owner_person_id AS owner FROM kin_leads l
        JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
        WHERE l.org_id = ${orgId} AND l.agent_id = ${agentId} AND a.retired_at IS NULL`;
      if (self === undefined) return yield* refuse("You are no longer here.");
      const asker = own !== null ? own.personId : turn === null ? null : yield* turnAsker(turn);
      const ownerTurn =
        turn === null || redone !== null
          ? asker === null || (yield* ownerLevel(orgId, asker))
          : (yield* effectiveAudience(turn)) === "owner_only";
      const chatPerson = yield* sql<{ personId: KinPersonId }>`SELECT person_id AS "personId"
        FROM kin_chat_members WHERE org_id = ${orgId} AND chat_id = ${here.chatId}
          AND principal_kind = 'person' AND left_at IS NULL ORDER BY person_id`;
      if (target.id === asker || chatPerson.some((one) => one.personId === target.id))
        return yield* refuse(`${target.name} is in this chat: ask them here with kin_ask.`);
      const targetOwnerSide = target.id === self.owner || (yield* ownerLevel(orgId, target.id));
      // A teammate's own request, from their own direct chat: only to someone who decides for them.
      if (!ownerTurn && turn !== null && redone === null) {
        const askers = (yield* turnPeople(turn))?.askers ?? [];
        if (
          askers.length !== 1 ||
          askers[0] !== asker ||
          !(yield* askersDirectChat(turn, here.chatId))
        )
          return yield* refuse(
            "Only one person's own request, in their own chat with you, asks someone else.",
          );
      }
      const askerName =
        asker === null
          ? null
          : ((yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
              WHERE org_id = ${orgId} AND person_id = ${asker}`)[0]?.name ?? null);
      // A sent-up draft is a teammate's, to the agent's owner only: his Approve has it made.
      let draft: string | null = null;
      let sentUp: StoredDraft | undefined;
      let hers: ReadonlyArray<string> | undefined;
      if (input.draft !== undefined) {
        if (ownerTurn || asker === null)
          return yield* refuse(
            "Only a teammate's own request sends a draft up; here you act at the owner's level, so make it yourself.",
          );
        if (target.id !== self.owner) {
          const [owner] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
            WHERE org_id = ${orgId} AND person_id = ${self.owner}`;
          return yield* refuse(`A draft goes up only to ${owner?.name ?? "the owner"}.`);
        }
        if (input.options !== undefined)
          return yield* refuse(
            "Kin writes this card's buttons, Approve and Changes first: leave out options when you send a draft up.",
          );
        // A redraft's source is the draft she sent up, held to her then.
        const source =
          redone !== null
            ? null
            : (turn ??
              (press?.madeIn === undefined ? null : { orgId, agentId, wakeupId: press.madeIn }));
        const from =
          redone !== null
            ? { texts: [redone.draft.text], changesFirst: true }
            : source === null
              ? undefined
              : yield* draftSource(source, here.chatId, asker);
        hers = from?.texts;
        if (turn !== null && from === undefined)
          return yield* refuse(
            `A draft goes up only from ${askerName ?? "the teammate"}'s own message here, or after the owner's Changes first on one of theirs.`,
          );
        // Her mail or post is her draft card's to send up (`draftCards.sendUp`), unless it is redone.
        if (
          turn !== null &&
          from?.changesFirst === false &&
          CARD_KINDS.includes(input.draft.kind)
        ) {
          const [owner] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
            WHERE org_id = ${orgId} AND person_id = ${self.owner}`;
          return yield* refuse(
            `A mail or post ${askerName ?? "a teammate"} asks for is filed with doc_create and draft: its card lets them send it to ${owner?.name ?? "the owner"}.`,
          );
        }
        if (input.detail === undefined || input.detail.trim() === "")
          return yield* refuse("Put the draft itself in detail.");
        // Who it is for, as one client or deal key the text holds: "Tidewater Freight (C-7)" is C-7.
        const named = input.draft.for === undefined ? [] : keysIn(input.draft.for);
        const parties =
          named.length === 0
            ? []
            : yield* sql<{
                key: string;
                title: string;
                recordId: string;
                list: "clients" | "deals";
                partyId: string | null;
              }>`SELECT r.key, r.title, r.record_id AS "recordId", r.register_id AS list,
                  CASE WHEN r.register_id = 'clients' THEN r.record_id ELSE r.party_id END
                    AS "partyId"
                FROM kin_records r
                WHERE r.org_id = ${orgId} AND r.key IN ${sql.in(named)}
                  AND r.register_id IN ('clients', 'deals') AND ${personSees(sql, asker)}
                ORDER BY r.key`;
        if (input.draft.for !== undefined && parties.length !== 1)
          return yield* refuse(
            parties.length > 1
              ? `draft.for is one client or deal; “${input.draft.for}” names ${parties.map((one) => one.key).join(" and ")}. Send the key of the one it is for.`
              : named.length === 0
                ? `draft.for is the key of the client or deal it is for, such as C-4; “${input.draft.for}” holds none.`
                : `No client or deal ${named.join(" or ")} that ${askerName ?? "they"} sees.`,
          );
        const [party] = parties;
        const [owner] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
          WHERE org_id = ${orgId} AND person_id = ${self.owner}`;
        const on = press?.on ?? redone?.draft.on;
        sentUp = {
          kind: input.draft.kind,
          for: party ?? null,
          text: input.detail,
          line: draftLine(input.draft.kind, on, party?.title),
          ...(on === undefined ? {} : { on }),
          names: {
            owner: owner?.name ?? "the owner",
            asker: askerName ?? "them",
            agent: self.name,
          },
        };
        draft = yield* encodeStoredDraft(sentUp);
      }
      if (sentUp === undefined && input.options === undefined)
        return yield* refuse("Give it 2 to 4 options.");
      // Their own direct chat with this agent: opening it is their own reach check (`Reach`).
      const unreached = new KinChatError({
        reason: "not_allowed",
        message: Reach.restrictedLine(
          target.name,
          self.name,
          asker === self.owner ? null : (askerName ?? undefined),
        ),
      });
      if (!(yield* Reach.reaches(orgId, Reach.person(target.id), Reach.agent(agentId))))
        return yield* unreached;
      // Whoever it is asked for must reach them too, whichever agent carries it.
      if (
        asker !== null &&
        (yield* Reach.mayReach(orgId, Reach.person(asker), Reach.person(target.id))) ===
          "restricted"
      )
        return yield* new KinChatError({
          reason: "not_allowed",
          message: Reach.restrictedLine(target.name, askerName ?? "they", askerName),
        });
      const direct = yield* chat
        .createDirect({ _tag: "person", orgId, personId: target.id }, { orgId, agentId })
        .pipe(Effect.mapError(() => unreached));
      const about = normaliseAbout(input.about);
      const intent = normaliseIntent(input.intent);
      if (intent === "" && about.length === 0)
        return yield* refuse(
          "Say what it is for (intent) or which records it is about (about), so Kin can tell it from any other question.",
        );
      const questionId =
        redone !== null
          ? redoId(redone.questionId, redone.wakeupId)
          : `q-${hash(
              press !== null
                ? `for:card:${press.widgetId}`
                : `for:${lead.wakeupId}:${stableStringify(input)}`,
            ).slice(0, 12)}`;
      const seen = yield* readQuestion(orgId, questionId);
      if (seen !== undefined) {
        // A retry returns what it stored; the same id with other people behind it is no retry.
        if (
          seen.agentId !== agentId ||
          seen.personId !== target.id ||
          seen.forChatId !== here.chatId ||
          seen.forPersonId !== asker
        )
          return yield* new KinChatError({
            reason: "not_allowed",
            message: "Chat operation not allowed.",
          });
        if (redone !== null && seen.draft?.text !== input.detail)
          return yield* refuse(
            `This turn already put a redraft of it to ${target.name}, which waits on them.`,
          );
        return {
          questionId,
          to: target.name,
          state: seen.widgetId === null ? ("held" as const) : ("posted" as const),
          dueAt: seen.dueAt,
          retry: true,
          note: `Already asked: it waits on ${target.name}. Their answer comes back here.`,
        };
      }
      const open = yield* openFor(orgId, target.id);
      // Its wording and asker are quoted only to a turn that may read the card or the chat it is for.
      const readable = Effect.fn("KinQuestions.askPerson.readable")(function* (
        row: (typeof open)[number],
      ) {
        if (turn === null) return false;
        if (yield* mayReadChat(turn, row.chatId)) return true;
        return row.forChatId !== null && (yield* mayReadChat(turn, row.forChatId));
      });
      const repeat = open.find((row) => askedAgain({ intent, about }, row));
      if (repeat !== undefined)
        return yield* refuse(
          (yield* readable(repeat))
            ? `${repeat.agentName} already asked ${target.name} that: “${repeat.question}”. It waits on ${target.name}; don't ask it again.`
            : `${target.name} already has an open question on this; don't ask it again.`,
        );
      const forOthers = open.filter((row) => row.forChatId !== null);
      if (forOthers.length >= ASKED_FOR_PER_PERSON)
        return yield* refuse(
          (yield* Effect.forEach(forOthers, readable)).every(Boolean)
            ? `${ASKED_FOR_PER_PERSON} questions asked for others already wait on ${target.name}: ${forOthers
                .map((row) => `“${row.question}” (${row.agentName})`)
                .join(", ")}.`
            : `${ASKED_FOR_PER_PERSON} questions asked for others already wait on ${target.name}.`,
        );
      if (
        asker === null &&
        forOthers.some((row) => row.agentId === agentId && row.forPersonId === null)
      )
        return yield* refuse(
          `You already asked ${target.name} something nobody asked you for; wait for that answer first.`,
        );
      const words = flat(
        [
          input.question,
          input.detail ?? "",
          ...(sentUp !== undefined ? DRAFT_OPTIONS : (input.options ?? [])).map((one) => one.label),
        ].join("\n"),
      );
      // What they will read, and what comes back to the asker, each held to its reader.
      if (!targetOwnerSide) {
        const why = yield* unreadableBy(
          orgId,
          target.id,
          words,
          ownerTurn ? undefined : (asker ?? undefined),
        );
        if (why !== undefined)
          return yield* refuse(
            `Not for ${target.name}: ${why}. Ask without that, or ask the owner to share it with ${target.name}.`,
          );
      }
      if (!ownerTurn && asker !== null) {
        // A figure she wrote herself is no secret from her: only the company's others are held.
        const why = yield* unreadableBy(
          orgId,
          asker,
          hers === undefined ? words : withoutOwnFigures(words, hers.join("\n")),
        );
        if (why !== undefined) return yield* refuse(`Not for ${askerName ?? "the asker"}: ${why}.`);
      }
      const now = yield* Clock.currentTimeMillis;
      const clock = yield* personClock(orgId, target.id);
      const named =
        input.by === undefined ? undefined : namedDue(input.by, now, clock.zone, clock.work);
      if (named !== undefined && "refused" in named) return yield* refuse(named.refused);
      const dueAt = named?.at ?? defaultDue(now, clock.zone, clock.work);
      const by = askedBy(askerName, self.name);
      if (redone !== null && sentUp !== undefined && !cardHolds(draftDetail(by, sentUp)))
        return yield* refuse(
          "With who asks and who it is for, this draft is too long for its card.",
        );
      // A sent-up draft's card is Kin's from its stored payload: its line and its two buttons.
      const detail =
        sentUp !== undefined
          ? draftDetail(by, sentUp)
          : `${by}${
              input.detail === undefined || input.detail.trim() === "" ? "" : `\n\n${input.detail}`
            }`;
      const card = {
        question: flat(input.question),
        detail,
        askedBy: by,
        ...(sentUp === undefined ? {} : { draft: sentUp.text }),
        options:
          sentUp !== undefined
            ? DRAFT_OPTIONS.map((one) => ({ ...one }))
            : (input.options ?? []).map((one) => ({
                label: one.label,
                ...(one.kind === undefined ? {} : { kind: one.kind }),
              })),
      };
      const options = choiceCardState(card).options.map(({ optionId, label }) => ({
        optionId,
        label,
      }));
      const heldCard = yield* encodeHeldCard({ detail, askedBy: by, options: card.options });
      const store = (widgetId: string | null) =>
        sql`INSERT INTO kin_questions (question_id, org_id, agent_id, person_id, chat_id, kind,
            widget_id, question, options_json, default_label, safe, about, intent, asked_at, due_at,
            act_at, state, for_chat_id, for_person_id, card_json, draft_json)
          VALUES (${questionId}, ${orgId}, ${agentId}, ${target.id}, ${direct.chatId}, 'card',
            ${widgetId}, ${card.question}, ${JSON.stringify(options)}, NULL, 0, ${about.join(" ")},
            ${intent}, ${now}, ${dueAt}, ${raiseAt(dueAt, clock.zone, clock.work)}, 'open',
            ${here.chatId}, ${asker},
            ${widgetId === null ? heldCard : null}, ${draft})
          ON CONFLICT (question_id) DO NOTHING`.pipe(Effect.asVoid);
      const posted = yield* askTo(
        lead,
        target.id,
        {
          ...card,
          untilAnswered: true,
          chatId: direct.chatId,
          clientMessageId: `kin-ask-for:${questionId}`,
        },
        (widget) => store(widget === null ? null : widget.widgetId),
      );
      // Asked after an outside read, its answer wakes a turn that has read outside text too.
      if (turn !== null) yield* stampEvent(orgId, questionId, yield* outsideStamp(turn));
      const joined = yield* signedIn(orgId, target.id);
      if ("_tag" in posted) {
        if (turn !== null && redone === null)
          yield* arrivesNote(
            chat,
            turn,
            target.name,
            posted,
            questionId,
            ownerTurn ? "owner" : "chat",
          );
        return {
          questionId,
          to: target.name,
          state: "held" as const,
          at: posted.at,
          dueAt,
          retry: false,
          signedIn: joined,
          note: joined
            ? `${heldUntil(target.name, posted)}: Kin posts it in their chat with you then, and this chat has been told. Their answer comes back here.`
            : notSignedIn(target.name),
        };
      }
      return {
        questionId,
        to: target.name,
        state: "posted" as const,
        dueAt,
        retry: false,
        signedIn: joined,
        note: joined
          ? `Posted in ${target.name}'s chat with you, waiting on them. Their answer comes back here.`
          : notSignedIn(target.name),
      };
    }),
  );
});

/** A request another agent passed on to this turn, as Kin's row or as a copy of someone's words. */
const passedOn = Effect.fn("KinQuestions.passedOn")(function* (turn: {
  readonly orgId: string;
  readonly agentId: string;
  readonly wakeupId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_events e
    LEFT JOIN kin_messages m ON m.org_id = e.org_id
      AND m.message_id = json_extract(e.json, '$.messageId')
    WHERE e.org_id = ${turn.orgId} AND e.agent_id = ${turn.agentId} AND e.wakeup_id = ${turn.wakeupId}
      AND e.tag = 'chat.message'
      AND (json_extract(e.json, '$.origin') IS NOT NULL OR m.origin_json IS NOT NULL
        OR EXISTS (SELECT 1 FROM kin_handoffs h WHERE h.org_id = m.org_id
          AND m.client_message_id = ${storedClientId("send", "")} || h.message_id))
    LIMIT 1`;
  return rows.length > 0;
});

/**
 * Where a sent-up draft may start: her own message in her direct chat with this agent, or the turn
 * carrying the owner's Changes first on one she sent up through it (`sendBack`, `changesFirst`),
 * never a turn that merely carries her as its origin. Its words are hers to read: her message, or
 * the draft she sent up, which was held to her then.
 */
const draftSource = Effect.fn("KinQuestions.draftSource")(function* (
  turn: { readonly orgId: string; readonly agentId: string; readonly wakeupId: string },
  chatId: string,
  asker: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  const own = yield* sql<{ body: string }>`SELECT m.body FROM kin_events e
    JOIN kin_messages m ON m.org_id = e.org_id
      AND m.message_id = json_extract(e.json, '$.messageId')
    WHERE e.org_id = ${turn.orgId} AND e.agent_id = ${turn.agentId}
      AND e.wakeup_id = ${turn.wakeupId} AND e.tag = 'chat.message'
      AND json_extract(e.json, '$.origin') IS NULL AND m.chat_id = ${chatId}
      AND m.author_kind = 'human' AND m.author_person_id = ${asker} AND m.origin_json IS NULL
    ORDER BY e.event_id`;
  const answered = yield* sql<{ eventId: string; questionId: string; draft: string }>`SELECT
      e.event_id AS "eventId", q.question_id AS "questionId", q.draft_json AS draft
    FROM kin_events e
    JOIN kin_questions q ON q.org_id = e.org_id
      AND q.question_id = json_extract(e.json, '$.subject.questionId')
    WHERE e.org_id = ${turn.orgId} AND e.agent_id = ${turn.agentId}
      AND e.wakeup_id = ${turn.wakeupId} AND e.tag = 'deferral.due'
      AND e.dedupe_key = 'question-answered:' || q.question_id
      AND json_extract(e.json, '$.provenance._tag') = 'system'
      AND json_extract(e.json, '$.subject.answered') = 1
      AND json_extract(e.json, '$.subject.approved') IS NULL
      AND json_extract(e.json, '$.origin.personId') = ${asker}
      AND json_extract(e.json, '$.origin.agentId') = ${turn.agentId}
      AND json_extract(e.json, '$.chatId') = ${chatId}
      AND q.agent_id = ${turn.agentId} AND q.for_person_id = ${asker}
      AND q.for_chat_id = ${chatId} AND q.draft_json IS NOT NULL
      AND q.state = 'answered' AND q.approved_at IS NULL
    ORDER BY e.event_id`;
  const earlier = answered.filter(
    (one) => one.eventId === answeredEventId(turn.orgId, one.questionId),
  );
  if (own.length === 0 && earlier.length === 0) return undefined;
  return {
    texts:
      own.length > 0
        ? own.map((one) => one.body)
        : earlier.flatMap((one) => Option.toArray(decodeStoredDraft(one.draft)).map((d) => d.text)),
    changesFirst: earlier.length > 0,
  };
});
