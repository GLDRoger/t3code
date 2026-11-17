import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { TEAM_MAX_MESSAGES, type TurnKind } from "./turns.ts";

/** What each kind of turn asks of the agent woken for it: the speak-or-pass check among them. */
const ASKED: Record<TurnKind, string> = {
  named: "You were asked. Answer, push back or add what's new, with team_say.",
  decider:
    "It's your call. Argue, ask, or decide with end decide once it's settled; don't settle too early.",
  pitch_in:
    "Nobody asked you, but this touches your lane. Speak only if you have something new: a fact, figure or risk nobody said; a view or an idea isn't new. Otherwise pass: end the turn without team_say.",
  chair:
    "Chair check: call it now (end decide, or end park), or pass to let them go on to the limit.",
  object:
    "A decision was made. If it's wrong for your lane, object once with team_say (intent objection) and say why; otherwise pass.",
  closing:
    "Closing turn at the limit: decide (end decide), park it (end park: where it stands, the default and when), or bring it to the owner if it's his to decide (end bring). You must end it.",
};
const TRANSCRIPT_BODY = 600;
const decodeTurn = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      agentId: Schema.String,
      kind: Schema.Literals(["named", "decider", "pitch_in", "chair", "object", "closing"]),
    }),
  ),
);

/**
 * The discussion a Team-room turn is for, from stored rows: its question, whose call it is, what
 * this turn asks, how many messages are left, and every message so far as a conversation.
 */
export const teamTurnFacts = Effect.fn("KinTeam.turnFacts")(function* (
  orgId: KinOrgId,
  agentId: string,
  discussionId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    topic: string;
    question: string;
    widened: number;
    decider: string;
    messages: number;
    state: string;
    final: number;
    turn: string | null;
  }>`SELECT d.topic, d.question, d.widened, l.name AS decider, d.messages, d.state, d.final,
      d.turn_json AS turn
    FROM kin_discussions d LEFT JOIN kin_leads l ON l.org_id = d.org_id
      AND l.agent_id = d.decider_agent_id
    WHERE d.org_id = ${orgId} AND d.discussion_id = ${discussionId}`;
  if (row === undefined) return undefined;
  const turn = row.turn === null ? undefined : decodeTurn(row.turn);
  const mine = turn?._tag === "Some" && turn.value.agentId === agentId ? turn.value : undefined;
  const said = yield* sql<{ name: string | null; intent: string | null; body: string }>`
    SELECT l.name, m.intent, m.body FROM kin_messages m
    LEFT JOIN kin_leads l ON l.org_id = m.org_id AND l.agent_id = m.author_agent_id
    WHERE m.org_id = ${orgId} AND m.discussion_id = ${discussionId} AND m.status = 'posted'
      AND m.author_kind = 'agent'
    ORDER BY m.seq`;
  return {
    discussion: discussionId,
    topic: row.topic,
    question: row.question,
    ...(row.widened === 1 ? { widened: "already, once" } : {}),
    whoseCall: row.decider ?? "the Chief of staff",
    yourTurn:
      row.final === 1 || mine === undefined
        ? "This turn has passed. End without team_say."
        : ASKED[mine.kind],
    messagesLeft: Math.max(0, TEAM_MAX_MESSAGES - row.messages),
    so_far: said.map(
      (message) =>
        `${message.name ?? "An agent"}${message.intent === null ? "" : ` (${message.intent})`}: ${
          message.body.length > TRANSCRIPT_BODY
            ? `${message.body.slice(0, TRANSCRIPT_BODY)}…`
            : message.body
        }`,
    ),
  };
});
