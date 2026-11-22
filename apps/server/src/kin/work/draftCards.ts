import {
  KIN_DOC_CARD,
  KIN_SOCIAL_PLATFORM_LABELS,
  KinAgentId,
  KinChatError,
  KinChoiceCardState,
  type KinDocCardDraft,
  KinDocCardState,
  type KinDocSendUpInput,
  type KinDraftKind,
  KinPersonId,
  KinRecordId,
  KinRecordKey,
  type KinSocialPlatform,
  KinWakeupId,
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
import { DRAFT_WORDS, draftDetail, draftLine } from "../questions/approval.ts";
import { askedBy } from "../questions/openQuestions.ts";
import { sendUpFromCard } from "../questions/askPerson.ts";
import { postsTo } from "../social/rows.ts";
import type { Lead } from "./leadWork.ts";
import { iso, unavailable } from "./recordRows.ts";
import { personSees } from "./teamView.ts";

const DOC_CARD_ID = "kin-doc:";
/** A doc card's client message id: one per turn, doc and version, so a retry finds the same card. */
export const docCardId = (wakeupId: string, recordId: string, version: number) =>
  `${DOC_CARD_ID}${wakeupId}:${recordId}:${version}`;
/** The turn that showed a doc card, read back from its stored client message id ("send:…"). */
const docCardTurn = (stored: string | null) =>
  stored?.startsWith(`send:${DOC_CARD_ID}`) === true
    ? KinWakeupId.make(stored.slice(`send:${DOC_CARD_ID}`.length).split(":")[0]!)
    : undefined;

/** A draft travels up on its card's text, which holds at most this (`kin_ask_person`'s detail). */
export const DRAFT_TEXT_MAX = 1800;
/** What the owner's Approve card carries as its text (`KinChoiceCardState.detail`). */
const cardHolds = Schema.is(KinChoiceCardState.fields.detail);

/**
 * A draft's card, from stored rows: its text, client and service as filed; "Send to" the agent's
 * owner only in the one teammate's own chat with it, and only when the Approve card it raises can
 * carry it whole (`fits`); for a post, that Kin can't post it when that client's group (ours,
 * with none) has no account there.
 */
export const draftCardOf = Effect.fn("KinDraftCards.of")(function* (
  lead: Lead,
  draft: { readonly kind: KinDraftKind; readonly on?: KinSocialPlatform | undefined },
  doc: { readonly text: string; readonly partyId: string | null },
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
  const [client] =
    doc.partyId === null
      ? []
      : yield* sql<{ recordId: string; key: string; title: string }>`SELECT
          record_id AS "recordId", key, title FROM kin_records
        WHERE org_id = ${lead.orgId} AND record_id = ${doc.partyId} AND register_id = 'clients'`;
  const on = draft.kind === "post" ? draft.on : undefined;
  const posts = draft.kind !== "post" || (yield* postsTo(lead.orgId, on, client?.recordId ?? null));
  const sendTo = own && by !== undefined ? by : undefined;
  const [names] =
    sendTo === undefined || asker === undefined
      ? []
      : yield* sql<{ asker: string; agent: string }>`SELECT p.display_name AS asker,
          l.name AS agent FROM kin_people p JOIN kin_leads l ON l.org_id = p.org_id
            AND l.agent_id = ${lead.agentId}
        WHERE p.org_id = ${lead.orgId} AND p.person_id = ${asker}`;
  const card = {
    kind: draft.kind,
    text: doc.text,
    ...(on === undefined ? {} : { on }),
    ...(client === undefined
      ? {}
      : {
          client: {
            recordId: KinRecordId.make(client.recordId),
            key: KinRecordKey.make(client.key),
            title: client.title,
          },
        }),
    ...(sendTo === undefined ? {} : { sendTo }),
    ...(!posts && by !== undefined
      ? {
          noAccount: {
            service: on === undefined ? "social media" : KIN_SOCIAL_PLATFORM_LABELS[on],
            by,
          },
        }
      : {}),
  } satisfies KinDocCardDraft;
  return {
    card,
    fits:
      names === undefined ||
      cardHolds(
        draftDetail(askedBy(names.asker, names.agent), {
          text: doc.text.trim(),
          line: draftLine(
            draft.kind,
            on === undefined ? undefined : KIN_SOCIAL_PLATFORM_LABELS[on],
            client?.title,
          ),
        }),
      ),
  };
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
      clientMessageId: string | null;
    }>`SELECT w.state_json AS state, m.author_agent_id AS "agentId", a.owner_person_id AS owner,
      l.thread_id AS "threadId", c.direct_key AS "directKey",
      m.client_message_id AS "clientMessageId"
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
    const [doc] = yield* sql<{ key: string; title: string; partyId: string | null }>`SELECT r.key,
      r.title, r.party_id AS "partyId"
    FROM kin_records r WHERE r.org_id = ${input.orgId} AND r.record_id = ${card.recordId}
      AND r.register_id = 'docs' AND ${personSees(sql, person.personId)}`;
    if (doc === undefined) return yield* gone;
    // What goes up is what the card holds: once its title or client moved, it is another draft.
    if (doc.title !== card.title || doc.partyId !== (draft.client?.recordId ?? null))
      return yield* new KinChatError({
        reason: "invalid_state",
        message: "This draft has changed since it was written. Ask for a fresh one here.",
      });
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
        round: draft.changesFirst?.at,
        ...(draft.on === undefined ? {} : { on: KIN_SOCIAL_PLATFORM_LABELS[draft.on] }),
        madeIn: docCardTurn(row.clientMessageId),
      },
      {
        to: row.owner,
        question: `Approve this ${DRAFT_WORDS[draft.kind]}: ${card.title}`.slice(0, 239) + "?",
        detail: draft.text.trim(),
        draft: {
          kind: draft.kind,
          ...(draft.client === undefined ? {} : { for: draft.client.key }),
        },
        about: [doc.key],
      },
      { chat, gate: yield* KinLevelGate },
    ).pipe(
      Effect.catchTags({
        KinChatError: (error) =>
          Effect.fail(
            new KinChatError({
              reason: error.reason,
              message: `This draft couldn't go to ${draft.sendTo?.name ?? "the owner"} from here. Ask in this chat instead.`,
            }),
          ),
      }),
    );
    const held = asked.state === "held";
    yield* chat.setDocCardSent({
      orgId: input.orgId,
      widgetId: input.widgetId,
      sent: {
        name: asked.to,
        at: iso(yield* Clock.currentTimeMillis),
        ...(held ? { held: true as const } : {}),
      },
    });
    return { to: asked.to, held };
  },
  // The card, the doc and the ask are read and written in one transaction.
  (effect) => Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(effect)),
  Effect.catchTags({
    SqlError: () => Effect.fail(unavailable),
    PersistenceSqlError: () => Effect.fail(unavailable),
    PersistenceDecodeError: () => Effect.fail(unavailable),
    SchemaError: () => Effect.fail(unavailable),
  }),
);
