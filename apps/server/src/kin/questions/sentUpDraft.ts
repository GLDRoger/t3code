import { type KinAgentId, KinMessageId, type KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { KinChatService } from "../chat/KinChatService.ts";
import * as Reach from "../lead/Reach.ts";
import { personSees } from "../work/teamView.ts";
import { personOfChat, readQuestion, type StoredDraft } from "./openQuestions.ts";

const NOUN: Record<StoredDraft["kind"], string> = {
  proposal: "the proposal is",
  quote: "the quote is",
  invoice: "the invoice is",
  terms: "the terms are",
  mail: "the mail is",
  post: "the post is",
};

/**
 * At the end of the owner's turn that his Approve on a sent-up draft queued (`approveDraft`): when
 * that turn made it (a doc, a quote or invoice entry, or a mail on his Confirm card), the teammate
 * who asked hears once, in her chat, where it is. Its key, which links it, only when she may open
 * it; nothing when she no longer writes there.
 */
export const tellDraftMade = Effect.fn("KinSentUpDraft.tellMade")(function* (
  wake: { readonly orgId: KinOrgId; readonly agentId: KinAgentId; readonly wakeupId: string },
  chat: Pick<KinChatService["Service"], "notice">,
) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, agentId, wakeupId } = wake;
  const [event] = yield* sql<{ questionId: string }>`SELECT
      json_extract(json, '$.subject.questionId') AS "questionId" FROM kin_events
    WHERE org_id = ${orgId} AND agent_id = ${agentId} AND wakeup_id = ${wakeupId}
      AND tag = 'deferral.due' AND json_extract(json, '$.subject.approved') = 1
    ORDER BY event_id LIMIT 1`;
  if (event === undefined) return;
  const row = yield* readQuestion(orgId, event.questionId);
  if (
    row?.draft == null ||
    row.agentId !== agentId ||
    row.forChatId === null ||
    row.forPersonId === null
  )
    return;
  const asker = row.forPersonId;
  if (
    (yield* personOfChat(orgId, row.forChatId)) !== asker ||
    !(yield* Reach.reaches(orgId, Reach.person(asker), Reach.agent(agentId)))
  )
    return;
  const [entry] = yield* sql<{ key: string; list: string; sees: number }>`SELECT r.key,
      r.register_id AS list, ${personSees(sql, KinPersonId.make(asker))} AS sees
    FROM kin_record_changes c
    JOIN kin_records r ON r.org_id = c.org_id AND r.record_id = c.record_id
    WHERE c.org_id = ${orgId} AND c.wakeup_id = ${wakeupId} AND c.kind = 'created'
      AND r.register_id IN ('docs', 'quotes', 'invoices')
    ORDER BY c.seq LIMIT 1`;
  const [mail] =
    entry === undefined
      ? yield* sql<{ askId: string }>`SELECT ask_id AS "askId" FROM kin_connection_asks
          WHERE org_id = ${orgId} AND agent_id = ${agentId} AND wakeup_id = ${wakeupId}
          ORDER BY proposed_at, ask_id LIMIT 1`
      : [];
  if (entry === undefined && mail === undefined) return;
  const [owner] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
    WHERE org_id = ${orgId} AND person_id = ${row.personId}`;
  const who = owner?.name ?? "The owner";
  const what = NOUN[row.draft.kind];
  const body =
    entry === undefined
      ? `${who} approved; ${what} ready, and goes once ${who} confirms it.`
      : `${who} approved; ${what} ${entry.list === "docs" ? "in Docs" : "a draft in Money"}${
          entry.sees === 1 ? `: ${entry.key}` : ""
        }.`;
  yield* chat.notice({
    orgId,
    chatId: row.forChatId,
    messageId: KinMessageId.make(`kin-draft-made:${row.questionId}`),
    audience: "chat",
    body,
  });
});
