import {
  KIN_DOC_CARD,
  KIN_SOCIAL_PLATFORM_LABELS,
  KinAgentId,
  KinChatError,
  type KinDocCardDraft,
  KinDocCardState,
  type KinDocSendUpInput,
  type KinDraftKind,
  KinPersonId,
  type KinSocialPlatform,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatService } from "../chat/KinChatService.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { turnChat, turnPeople } from "../lead/Audience.ts";
import { directKey } from "../lead/LeadAccess.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import { DRAFT_WORDS } from "../questions/approval.ts";
import { sendUpFromCard } from "../questions/askPerson.ts";
import { postsTo } from "../social/rows.ts";
import type { Lead } from "./leadWork.ts";
import { iso, unavailable } from "./recordRows.ts";
import { personSees } from "./teamView.ts";

/** A draft travels up on its card's text, which holds at most this (`kin_ask_person`'s detail). */
export const DRAFT_TEXT_MAX = 1800;

/**
 * A draft's card, from stored rows: "Send to" the agent's owner only in the one teammate's own
 * chat with it, and, for a post, that Kin can't post it when no account there is connected.
 */
export const draftCardOf = Effect.fn("KinDraftCards.of")(function* (
  lead: Lead,
  draft: { readonly kind: KinDraftKind; readonly on?: KinSocialPlatform | undefined },
  text: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [owner] = yield* sql<{ personId: string; name: string }>`SELECT
      p.person_id AS "personId", p.display_name AS name
    FROM kin_agents a JOIN kin_people p ON p.org_id = a.org_id AND p.person_id = a.owner_person_id
    WHERE a.org_id = ${lead.orgId} AND a.agent_id = ${lead.agentId}`;
  const by =
    owner === undefined
      ? undefined
      : { personId: KinPersonId.make(owner.personId), name: owner.name };
  const behind = yield* turnPeople(lead);
  const asker =
    behind?.people.length === 1 && behind.askers.length === 1 ? behind.askers[0] : undefined;
  const chat = yield* turnChat(lead);
  const own =
    asker !== undefined &&
    chat !== undefined &&
    (yield* sql`SELECT 1 FROM kin_chats WHERE org_id = ${lead.orgId} AND chat_id = ${chat.chatId}
      AND kind = 'direct' AND archived_at IS NULL
      AND direct_key = ${directKey(asker, lead.agentId)}`).length > 0;
  const posts = draft.kind !== "post" || (yield* postsTo(lead.orgId, draft.on));
  return {
    kind: draft.kind,
    text,
    ...(own && by !== undefined ? { sendTo: by } : {}),
    ...(!posts && by !== undefined
      ? {
          noAccount: {
            service: draft.on === undefined ? "social media" : KIN_SOCIAL_PLATFORM_LABELS[draft.on],
            by,
          },
        }
      : {}),
  } satisfies KinDocCardDraft;
});

const decodeCard = Schema.decodeUnknownOption(Schema.fromJsonString(KinDocCardState));
const gone = new KinChatError({ reason: "not_found", message: "This card isn't here any more." });

/**
 * "Send to" on a teammate's own draft card: X7's send-up (`kin_ask_person` with `draft`), from
 * them, so the agent's owner gets one Approve / Changes first card. A second press finds the first.
 */
export const sendUp = Effect.fn("KinDraftCards.sendUp")(
  function* (people: ReadonlyArray<PersonIdentity>, input: KinDocSendUpInput) {
    const sql = yield* SqlClient.SqlClient;
    const person = people.find((one) => one.orgId === input.orgId);
    if (person === undefined) return yield* gone;
    const [row] = yield* sql<{
      state: string;
      agentId: string;
      owner: string;
      threadId: string | null;
      directKey: string | null;
    }>`SELECT w.state_json AS state, m.author_agent_id AS "agentId", a.owner_person_id AS owner,
      l.thread_id AS "threadId", c.direct_key AS "directKey"
    FROM kin_widgets w
    JOIN kin_messages m ON m.org_id = w.org_id AND m.message_id = w.message_id
      AND m.author_kind = 'agent'
    JOIN kin_chats c ON c.org_id = w.org_id AND c.chat_id = w.chat_id AND c.kind = 'direct'
      AND c.archived_at IS NULL
    JOIN kin_agents a ON a.org_id = w.org_id AND a.agent_id = m.author_agent_id
      AND a.retired_at IS NULL
    JOIN kin_leads l ON l.org_id = a.org_id AND l.agent_id = a.agent_id
    WHERE w.org_id = ${input.orgId} AND w.widget_id = ${input.widgetId}
      AND w.chat_id = ${input.chatId} AND w.type = ${KIN_DOC_CARD}`;
    const card = row === undefined ? undefined : Option.getOrUndefined(decodeCard(row.state));
    const agentId = row === undefined ? undefined : KinAgentId.make(row.agentId);
    if (
      row === undefined ||
      card === undefined ||
      agentId === undefined ||
      row.threadId === null ||
      row.directKey !== directKey(person.personId, agentId)
    )
      return yield* gone;
    const draft = card.draft;
    if (draft?.sendTo === undefined)
      return yield* new KinChatError({
        reason: "not_allowed",
        message: "Only a teammate's own draft goes up from its card.",
      });
    const [doc] = yield* sql<{ key: string; title: string; client: string | null }>`SELECT r.key,
      r.title, (SELECT p.key FROM kin_records p WHERE p.org_id = r.org_id
        AND p.record_id = r.party_id AND p.register_id = 'clients') AS client
    FROM kin_records r WHERE r.org_id = ${input.orgId} AND r.record_id = ${card.recordId}
      AND r.register_id = 'docs' AND ${personSees(sql, person.personId)}`;
    if (doc === undefined) return yield* gone;
    const chat = yield* KinChatService;
    const asked = yield* sendUpFromCard(
      {
        agent: {
          _tag: "agent",
          orgId: input.orgId,
          agentId,
          ownerPersonId: KinPersonId.make(row.owner),
          threadId: ThreadId.make(row.threadId),
          hostPosted: true,
        },
        personId: person.personId,
        chatId: input.chatId,
        widgetId: input.widgetId,
      },
      {
        to: row.owner,
        question: `Approve this ${DRAFT_WORDS[draft.kind]}: ${doc.title}`.slice(0, 239) + "?",
        detail: draft.text.trim().slice(0, DRAFT_TEXT_MAX),
        draft: { kind: draft.kind, ...(doc.client === null ? {} : { for: doc.client }) },
        about: [doc.key],
      },
      { chat, gate: yield* KinLevelGate },
    ).pipe(
      Effect.catchTag("KinChatError", (error) =>
        Effect.fail(
          new KinChatError({
            reason: error.reason,
            message: `This draft couldn't go to ${draft.sendTo?.name ?? "the owner"} from here. Ask in this chat instead.`,
          }),
        ),
      ),
    );
    yield* chat.setDocCardSent({
      orgId: input.orgId,
      widgetId: input.widgetId,
      sent: { name: asked.to, at: iso(yield* Clock.currentTimeMillis) },
    });
    return { to: asked.to, held: asked.state === "held" };
  },
  Effect.catchTags({
    SqlError: () => Effect.fail(unavailable),
    PersistenceSqlError: () => Effect.fail(unavailable),
    PersistenceDecodeError: () => Effect.fail(unavailable),
    SchemaError: () => Effect.fail(unavailable),
  }),
);
