import {
  KinChatError,
  type KinChatId,
  KinChoiceOption,
  type KinPersonId,
  KinText,
  KinTrimmedText,
  type KinWakeupId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import { storedClientId } from "../chat/KinChatRepository.ts";
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
import type { KinLevelGate } from "../lead/LevelGate.ts";
import * as Reach from "../lead/Reach.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import { signedIn } from "../people/signedIn.ts";
import { heldUntil } from "../triggers/quietHold.ts";
import { personMiss, personNamed } from "../people/personNamed.ts";
import { laneFor } from "../reply/replyLane.ts";
import { choiceCardState } from "../widgets/choiceCard.ts";
import { unreadableBy } from "../work/teamView.ts";
import { askedBy, encodeHeldCard, openFor, personClock, readQuestion } from "./openQuestions.ts";
import { defaultDue, namedDue, normaliseAbout, normaliseIntent, raiseAt } from "./rules.ts";

/** What an agent asks someone outside the chat: `kin_ask`'s card, with no default or actions. */
export const AskPersonInput = Schema.Struct({
  to: KinTrimmedText.check(Schema.isMaxLength(120)),
  question: KinTrimmedText.check(Schema.isMaxLength(240)),
  options: Schema.Array(
    Schema.Struct({ label: KinChoiceOption.fields.label, kind: KinChoiceOption.fields.kind }),
  ).check(Schema.isMinLength(2), Schema.isMaxLength(4)),
  detail: Schema.optional(KinText.check(Schema.isMaxLength(1800))),
  by: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(10))),
  about: Schema.optional(
    Schema.Array(KinTrimmedText.check(Schema.isMaxLength(20))).check(Schema.isMaxLength(8)),
  ),
  intent: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(120))),
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
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

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
  deps: {
    readonly chat: Pick<KinChatService["Service"], "createDirect" | "notice">;
    readonly gate: Pick<KinLevelGate["Service"], "askTo">;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const { orgId, agentId } = lead;
      const turn = { orgId, agentId, wakeupId: lead.wakeupId };
      if (yield* aborted(turn))
        return yield* refuse("Someone else joined this chat while you were working.");
      if (yield* passedOn(turn))
        return yield* refuse(
          "This was passed on to you by another agent, so it stops with you: ask nobody further from here.",
        );
      const lane = yield* laneFor(turn);
      const [here] =
        lane._tag === "None" || lane.value.team === true
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
      const asker = yield* turnAsker(turn);
      const ownerTurn = (yield* effectiveAudience(turn)) === "owner_only";
      const chatPerson = yield* sql<{ personId: KinPersonId }>`SELECT person_id AS "personId"
        FROM kin_chat_members WHERE org_id = ${orgId} AND chat_id = ${here.chatId}
          AND principal_kind = 'person' AND left_at IS NULL ORDER BY person_id`;
      if (target.id === asker || chatPerson.some((one) => one.personId === target.id))
        return yield* refuse(`${target.name} is in this chat: ask them here with kin_ask.`);
      const targetOwnerSide = target.id === self.owner || (yield* ownerLevel(orgId, target.id));
      // A teammate's own request, from their own direct chat: only to someone who decides for them.
      if (!ownerTurn) {
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
      const direct = yield* deps.chat
        .createDirect({ _tag: "person", orgId, personId: target.id }, { orgId, agentId })
        .pipe(Effect.mapError(() => unreached));
      const about = normaliseAbout(input.about);
      const intent = normaliseIntent(input.intent);
      if (intent === "" && about.length === 0)
        return yield* refuse(
          "Say what it is for (intent) or which records it is about (about), so Kin can tell it from any other question.",
        );
      const questionId = `q-${hash(`for:${lead.wakeupId}:${stableStringify(input)}`).slice(0, 12)}`;
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
        [input.question, input.detail ?? "", ...input.options.map((one) => one.label)].join("\n"),
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
        const why = yield* unreadableBy(orgId, asker, words);
        if (why !== undefined) return yield* refuse(`Not for ${askerName ?? "the asker"}: ${why}.`);
      }
      const now = yield* Clock.currentTimeMillis;
      const clock = yield* personClock(orgId, target.id);
      const named = input.by === undefined ? undefined : namedDue(input.by, now, clock.zone);
      if (named !== undefined && "refused" in named) return yield* refuse(named.refused);
      const dueAt = named?.at ?? defaultDue(now, clock.zone, clock.days);
      const detail = `${askedBy(askerName, self.name)}${
        input.detail === undefined || input.detail.trim() === "" ? "" : `\n\n${input.detail}`
      }`;
      const card = {
        question: flat(input.question),
        detail,
        options: input.options.map((one) => ({
          label: one.label,
          ...(one.kind === undefined ? {} : { kind: one.kind }),
        })),
      };
      const options = choiceCardState(card).options.map(({ optionId, label }) => ({
        optionId,
        label,
      }));
      const heldCard = yield* encodeHeldCard({ detail, options: card.options });
      const store = (widgetId: string | null) =>
        sql`INSERT INTO kin_questions (question_id, org_id, agent_id, person_id, chat_id, kind,
            widget_id, question, options_json, default_label, safe, about, intent, asked_at, due_at,
            act_at, state, for_chat_id, for_person_id, card_json)
          VALUES (${questionId}, ${orgId}, ${agentId}, ${target.id}, ${direct.chatId}, 'card',
            ${widgetId}, ${card.question}, ${JSON.stringify(options)}, NULL, 0, ${about.join(" ")},
            ${intent}, ${now}, ${dueAt}, ${raiseAt(dueAt, clock.zone, clock.days)}, 'open',
            ${here.chatId}, ${asker},
            ${widgetId === null ? heldCard : null})
          ON CONFLICT (question_id) DO NOTHING`.pipe(Effect.asVoid);
      const posted = yield* deps.gate.askTo(
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
      const joined = yield* signedIn(orgId, target.id);
      if ("_tag" in posted) {
        yield* arrivesNote(
          deps.chat,
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
