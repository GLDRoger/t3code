import {
  type KinAgentId,
  KinChatId,
  KinMessageId,
  KinMessageRelay,
  type KinOrgId,
  type KinPersonId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { WriteAudience } from "../chat/KinChatRepository.ts";
import type { KinChatService } from "../chat/KinChatService.ts";
import { turnChat } from "../lead/Audience.ts";
import * as Reach from "../lead/Reach.ts";
import type { KinPushSender } from "../push/KinPushSender.ts";
import { heldGivenBody, isGivenHeld, TASK_NEWS } from "../work/assignNotices.ts";
import { ANSWERS_WITHIN_MS, personQuietUntil, relayWakeup, sameAsk } from "./quietHold.ts";

/** A delivered held line's message id is this before its first hold's id. */
export const HELD_ID = "kin-held:";
/**
 * A teammate's direct message that reached someone in their quiet hours without ringing: its id
 * follows. Posted already, so it is never a chat line; their banner waits for the hours' end.
 */
export const DM_NEWS = "kin-dm-news:";
const decodeRelay = Schema.decodeUnknownOption(Schema.fromJsonString(KinMessageRelay));

/**
 * Posts every held line now due, oldest first, one message per chat and kind. The message id
 * comes from the first line held, so a run repeated after a crash finds its own post. Task news
 * due goes as one banner per person and mover, and a direct message's waited ring as one per
 * sender's chat; neither posts anything.
 */
export const deliverHeld = Effect.fn("KinQuiet.deliver")(function* (
  orgId: KinOrgId,
  chat: Pick<KinChatService["Service"], "notice">,
  push?: Pick<KinPushSender["Service"], "notify">,
) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  yield* deliverNews(orgId, now, push);
  yield* deliverDms(orgId, now, push);
  const rows = yield* sql<{
    holdId: string;
    chatId: string;
    personId: KinPersonId;
    kind: string;
    body: string;
    audience: WriteAudience;
    agentId: KinAgentId | null;
    waits: number;
    relay: string | null;
    heldAt: number;
    deliverAt: number;
  }>`SELECT hold_id AS "holdId", chat_id AS "chatId", person_id AS "personId", kind, body, audience,
      agent_id AS "agentId", waits, relay_json AS relay, held_at AS "heldAt",
      deliver_at AS "deliverAt"
    FROM kin_held_posts
    WHERE org_id = ${orgId} AND delivered_at IS NULL AND deliver_at <= ${now}
      AND substr(kind, 1, ${TASK_NEWS.length}) != ${TASK_NEWS}
      AND substr(kind, 1, ${DM_NEWS.length}) != ${DM_NEWS}
    ORDER BY held_at, rowid`;
  const groups = new Map<string, Array<(typeof rows)[number]>>();
  for (const row of rows) {
    // Tasks given while they waited post as one message, whoever gave them.
    const key = `${row.chatId}\0${row.personId}\0${isGivenHeld(row.kind) ? "given" : row.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  let posted = 0;
  for (const group of groups.values()) {
    const first = group[0]!;
    // A host that slept through the day wakes in the next night: it waits for that one's end.
    const quietUntil = yield* personQuietUntil(orgId, first.personId, now);
    if (quietUntil !== undefined) {
      yield* sql`UPDATE kin_held_posts SET deliver_at = ${quietUntil}
        WHERE org_id = ${orgId} AND hold_id IN ${sql.in(group.map((row) => row.holdId))}`;
      continue;
    }
    const ids = group.map((row) => row.holdId);
    const body = isGivenHeld(first.kind)
      ? yield* heldGivenBody(
          orgId,
          first.personId,
          group.map((row) => row.kind),
        )
      : [...new Set(group.map((row) => row.body))].join("\n\n");
    if (body === undefined) {
      yield* sql`DELETE FROM kin_held_posts WHERE org_id = ${orgId} AND hold_id IN ${sql.in(ids)}`;
      continue;
    }
    if (yield* urgentSince(orgId, first)) {
      yield* sql`DELETE FROM kin_held_posts WHERE org_id = ${orgId} AND hold_id IN ${sql.in(ids)}`;
      continue;
    }
    // An agent's words to a pair restricted since they were held go nowhere; the asker hears so.
    const closed = yield* restrictedSince(orgId, first);
    if (closed !== undefined) {
      yield* sql`DELETE FROM kin_held_posts WHERE org_id = ${orgId} AND hold_id IN ${sql.in(ids)}`;
      yield* tellAsker(orgId, first, closed, chat);
      continue;
    }
    // One that can't post (they left the chat) stays held and doesn't block the others.
    const sent = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* chat.notice({
            orgId,
            chatId: KinChatId.make(first.chatId),
            messageId: KinMessageId.make(`${HELD_ID}${first.holdId}`),
            audience: first.audience,
            body,
            ...(first.agentId === null ? {} : { from: first.agentId }),
            ...(first.waits === 1 ? { waitingFor: first.personId } : {}),
            ...Option.match(decodeRelay(first.relay ?? undefined), {
              onNone: () => ({}),
              onSome: (relay) => ({ relay }),
            }),
          });
          yield* sql`UPDATE kin_held_posts SET delivered_at = ${now}
          WHERE org_id = ${orgId} AND hold_id IN ${sql.in(ids)}`;
        }),
      )
      .pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("Kin held line not delivered", {
            orgId,
            holdId: first.holdId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
    if (sent) posted += 1;
  }
  return posted;
});

/** Task news due: each person's from each mover is one banner, once their hold, if any, is over. */
const deliverNews = Effect.fn("KinQuiet.deliverNews")(function* (
  orgId: KinOrgId,
  now: number,
  push: Pick<KinPushSender["Service"], "notify"> | undefined,
) {
  const sql = yield* SqlClient.SqlClient;
  const due = yield* sql<{ holdId: string; personId: KinPersonId; by: string | null }>`SELECT
      hold_id AS "holdId", person_id AS "personId", json_extract(body, '$.by') AS by
    FROM kin_held_posts
    WHERE org_id = ${orgId} AND delivered_at IS NULL AND deliver_at <= ${now}
      AND substr(kind, 1, ${TASK_NEWS.length}) = ${TASK_NEWS}
    ORDER BY held_at, rowid`;
  const bursts = new Map<string, Array<(typeof due)[number]>>();
  for (const row of due) {
    const key = `${row.personId}\0${row.by}`;
    bursts.set(key, [...(bursts.get(key) ?? []), row]);
  }
  for (const burst of bursts.values()) {
    const ids = burst.map((row) => row.holdId);
    const quietUntil = yield* personQuietUntil(orgId, burst[0]!.personId, now);
    if (quietUntil !== undefined) {
      yield* sql`UPDATE kin_held_posts SET deliver_at = ${quietUntil}
        WHERE org_id = ${orgId} AND hold_id IN ${sql.in(ids)}`;
      continue;
    }
    // Told once: a banner lost to a crash after this is not rung twice.
    yield* sql`UPDATE kin_held_posts SET delivered_at = ${now}
      WHERE org_id = ${orgId} AND hold_id IN ${sql.in(ids)}`;
    if (push !== undefined) yield* push.notify({ _tag: "tasks", orgId, holdIds: ids });
  }
});

/** Direct messages whose ring waited out someone's quiet hours: one banner per sender's chat. */
const deliverDms = Effect.fn("KinQuiet.deliverDms")(function* (
  orgId: KinOrgId,
  now: number,
  push: Pick<KinPushSender["Service"], "notify"> | undefined,
) {
  const sql = yield* SqlClient.SqlClient;
  const due = yield* sql<{ holdId: string; personId: KinPersonId; chatId: string }>`SELECT
      hold_id AS "holdId", person_id AS "personId", chat_id AS "chatId"
    FROM kin_held_posts
    WHERE org_id = ${orgId} AND delivered_at IS NULL AND deliver_at <= ${now}
      AND substr(kind, 1, ${DM_NEWS.length}) = ${DM_NEWS}
    ORDER BY held_at, rowid`;
  const chats = new Map<string, Array<(typeof due)[number]>>();
  for (const row of due) {
    const key = `${row.personId}\0${row.chatId}`;
    chats.set(key, [...(chats.get(key) ?? []), row]);
  }
  for (const group of chats.values()) {
    const ids = group.map((row) => row.holdId);
    const quietUntil = yield* personQuietUntil(orgId, group[0]!.personId, now);
    if (quietUntil !== undefined) {
      yield* sql`UPDATE kin_held_posts SET deliver_at = ${quietUntil}
        WHERE org_id = ${orgId} AND hold_id IN ${sql.in(ids)}`;
      continue;
    }
    yield* sql`UPDATE kin_held_posts SET delivered_at = ${now}
      WHERE org_id = ${orgId} AND hold_id IN ${sql.in(ids)}`;
    if (push !== undefined) yield* push.notify({ _tag: "dm", orgId, holdIds: ids });
  }
});

type Held = {
  readonly personId: KinPersonId;
  readonly kind: string;
  readonly agentId: KinAgentId | null;
  readonly relay: string | null;
};

/**
 * Whether, while this relay waited, its agent sent them an urgent one raised from the same chat:
 * posted in their chat before this was due, not answering anything they wrote. Read at delivery,
 * so it covers lines held before `urgentNow` withdrew them at send.
 */
const urgentSince = Effect.fn("KinQuiet.urgentSince")(function* (
  orgId: KinOrgId,
  held: Held & { readonly chatId: string; readonly heldAt: number; readonly deliverAt: number },
) {
  const wakeupId = relayWakeup(held.kind);
  if (wakeupId === undefined || held.agentId === null) return false;
  const sql = yield* SqlClient.SqlClient;
  const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));
  const sent = yield* sql<{ key: string; at: string }>`SELECT
      COALESCE(substr(client_message_id, 6), message_id) AS key, created_at AS at
    FROM kin_messages WHERE org_id = ${orgId} AND chat_id = ${held.chatId}
      AND author_kind = 'agent' AND author_agent_id = ${held.agentId} AND status = 'posted'
      AND created_at > ${iso(held.heldAt)} AND created_at < ${iso(held.deliverAt)}
      AND (substr(message_id, 1, 10) = 'kin-relay:'
        OR substr(client_message_id, 1, 15) = 'send:kin-relay:')
    ORDER BY seq`;
  for (const row of sent) {
    const twin = relayWakeup(row.key);
    if (twin === undefined || !(yield* sameAsk(orgId, held.agentId, wakeupId, twin))) continue;
    const at = Date.parse(row.at);
    const [answered] = yield* sql`SELECT 1 FROM kin_messages
      WHERE org_id = ${orgId} AND chat_id = ${held.chatId} AND author_person_id = ${held.personId}
        AND origin_json IS NULL AND created_at > ${iso(at - ANSWERS_WITHIN_MS)}
        AND created_at <= ${row.at}
      LIMIT 1`;
    if (answered === undefined) return true;
  }
  return false;
});

/** The pair a held line from an agent may no longer cross, by name; undefined when it may. */
const restrictedSince = Effect.fn("KinQuiet.restrictedSince")(function* (
  orgId: KinOrgId,
  held: Held,
) {
  if (held.agentId === null) return undefined;
  const sql = yield* SqlClient.SqlClient;
  const nameOf = (personId: string) =>
    sql<{ name: string }>`SELECT display_name AS name FROM kin_people
      WHERE org_id = ${orgId} AND person_id = ${personId}`.pipe(
      Effect.map((rows) => rows[0]?.name ?? "They"),
    );
  if (
    (yield* Reach.mayReach(orgId, Reach.person(held.personId), Reach.agent(held.agentId))) ===
    "restricted"
  ) {
    const [lead] = yield* sql<{ name: string }>`SELECT name FROM kin_leads
      WHERE org_id = ${orgId} AND agent_id = ${held.agentId}`;
    return `${yield* nameOf(held.personId)} and ${lead?.name ?? "this agent"}`;
  }
  const from = Option.getOrUndefined(decodeRelay(held.relay ?? undefined))?.personId;
  if (
    from !== undefined &&
    (yield* Reach.mayReach(orgId, Reach.person(from), Reach.person(held.personId))) === "restricted"
  )
    return `${yield* nameOf(held.personId)} and ${yield* nameOf(from)}`;
  return undefined;
});

/** A held relay's asker hears, in the chat its turn answered, that it was dropped. */
const tellAsker = Effect.fn("KinQuiet.tellAsker")(
  function* (
    orgId: KinOrgId,
    held: Held,
    pair: string,
    chat: Pick<KinChatService["Service"], "notice">,
  ) {
    const wakeupId = /^kin-relay:([^:]+):/.exec(held.kind)?.[1];
    if (wakeupId === undefined || held.agentId === null) return;
    const here = yield* turnChat({ orgId, agentId: held.agentId, wakeupId });
    if (here === undefined) return;
    yield* chat.notice({
      orgId,
      chatId: KinChatId.make(here.chatId),
      messageId: KinMessageId.make(`kin-held-dropped:${held.kind}`),
      audience: "chat",
      body: `${pair} can't message each other here, so nothing was sent.`,
    });
  },
  Effect.catch((cause) => Effect.logWarning("Kin couldn't say a held line was dropped", { cause })),
);
