import { KinChatError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { keySentClientId } from "../chat/keySent.ts";
import { wakeEvent } from "../lead/ChatWake.ts";
import { codingAgentSource, stampEvent } from "../lead/OutsideContent.ts";
import { requestHashOf } from "../work/KinRecords.ts";
import { workFailure } from "../work/recordRows.ts";
import { whoNamed } from "./people.ts";
import { keyed } from "./tasks.ts";
import type { TasksKeyHolder } from "./TasksKeys.ts";

const notAnAgent = new KinChatError({
  reason: "invalid_state",
  message:
    "ask_agent asks one of Kin's agents. To reach a person, comment on a task or give them one.",
});

const personOf = (holder: TasksKeyHolder): PersonIdentity => ({
  _tag: "person",
  orgId: holder.orgId,
  personId: holder.personId,
});

const keyLabel = Effect.fn("KinTasksKeyChat.keyLabel")(function* (holder: TasksKeyHolder) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ label: string }>`SELECT label FROM kin_tasks_keys
    WHERE org_id = ${holder.orgId} AND session_id = ${holder.sessionId}`.pipe(workFailure);
  const label = row?.label.trim() ?? "";
  return label === "" ? "Coding agent" : label;
});

/**
 * The person's words to one of Kin's agents, in their own direct chat with it, with a first line
 * saying their coding agent wrote them. It starts the agent's turn as their message would, but
 * answers nothing (`replies: false`), and the stamp that tells the turn where the words came from
 * commits with the message. Nothing of the agent's reply comes back through the key.
 */
export const askAgent = Effect.fn("KinTasksKeyChat.ask")(function* (
  holder: TasksKeyHolder,
  input: { readonly agent: string; readonly text: string },
) {
  const who = yield* whoNamed(holder, input.agent);
  if (who._tag !== "agent") return yield* notAnAgent;
  const chats = yield* KinChatService;
  const sql = yield* SqlClient.SqlClient;
  const label = yield* keyLabel(holder);
  const me = personOf(holder);
  const request = { clientRequestId: "", agentId: who.agentId, text: input.text };
  return yield* keyed(holder, () =>
    Effect.gen(function* () {
      const chat = yield* chats.createDirect(me, { orgId: holder.orgId, agentId: who.agentId });
      const sent = yield* chats.send(me, {
        chatId: chat.chatId,
        clientMessageId: keySentClientId(holder.sessionId, requestHashOf(request).slice(0, 40)),
        body: `*Sent by my coding agent, ${label}.*\n\n${input.text}`,
        replies: false,
      });
      yield* stampEvent(
        holder.orgId,
        wakeEvent(sent, who.agentId, undefined).eventId,
        codingAgentSource(label),
      );
      const [agent] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_agents
        WHERE org_id = ${holder.orgId} AND agent_id = ${who.agentId}`;
      return { sent: true as const, agent: agent?.name ?? input.agent, chat: chat.chatId };
    }),
  );
});
