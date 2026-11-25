import { KIN_SET_UP_MESSAGE_PREFIX, type KinAgentId, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { storedClientId } from "../chat/KinChatRepository.ts";

const PRESSED = storedClientId("send", KIN_SET_UP_MESSAGE_PREFIX);

/**
 * Whether a turn in a person's direct chat with the Chief of staff is its set-up turn: a message
 * "Set up for my kind of company…" sent, or the owner's first word to the company's first agent.
 * Any other turn, every turn of a company that already talked to it included, reads no set-up.
 */
export const setUpAsked = Effect.fn("KinSetUp.asked")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly chatId: string;
  readonly personId: string;
  readonly owner: boolean;
  readonly messageIds: ReadonlyArray<string>;
}) {
  if (input.messageIds.length === 0) return false;
  const sql = yield* SqlClient.SqlClient;
  const said = yield* sql<{ seq: number; clientMessageId: string | null }>`
    SELECT seq, client_message_id AS "clientMessageId" FROM kin_messages
    WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}
      AND message_id IN ${sql.in(input.messageIds)}
      AND author_kind = 'human' AND author_person_id = ${input.personId} AND status = 'posted'
    ORDER BY seq`;
  if (said.some((row) => row.clientMessageId?.startsWith(PRESSED) === true)) return true;
  const [first] = said;
  if (!input.owner || first === undefined) return false;
  const [earliest] = yield* sql<{ agentId: string }>`SELECT agent_id AS "agentId" FROM kin_agents
    WHERE org_id = ${input.orgId} AND role = 'lead' ORDER BY created_at, agent_id LIMIT 1`;
  if (earliest?.agentId !== input.agentId) return false;
  const before = yield* sql`SELECT 1 FROM kin_messages
    WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND author_kind = 'human'
      AND seq < ${first.seq}
    ORDER BY seq LIMIT 1`;
  return before.length === 0;
});
