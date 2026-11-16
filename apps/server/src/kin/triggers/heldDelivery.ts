import {
  type KinAgentId,
  KinChatId,
  KinMessageId,
  type KinOrgId,
  type KinPersonId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { WriteAudience } from "../chat/KinChatRepository.ts";
import type { KinChatService } from "../chat/KinChatService.ts";
import { personQuietUntil } from "./quietHold.ts";

/**
 * Posts every held line now due, oldest first, one message per chat and kind. The message id
 * comes from the first line held, so a run repeated after a crash finds its own post.
 */
export const deliverHeld = Effect.fn("KinQuiet.deliver")(function* (
  orgId: KinOrgId,
  chat: Pick<KinChatService["Service"], "notice">,
) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const rows = yield* sql<{
    holdId: string;
    chatId: string;
    personId: KinPersonId;
    kind: string;
    body: string;
    audience: WriteAudience;
    agentId: KinAgentId | null;
    waits: number;
  }>`SELECT hold_id AS "holdId", chat_id AS "chatId", person_id AS "personId", kind, body, audience,
      agent_id AS "agentId", waits
    FROM kin_held_posts
    WHERE org_id = ${orgId} AND delivered_at IS NULL AND deliver_at <= ${now}
    ORDER BY held_at, rowid`;
  const groups = new Map<string, Array<(typeof rows)[number]>>();
  for (const row of rows)
    groups.set(`${row.chatId}\0${row.personId}\0${row.kind}`, [
      ...(groups.get(`${row.chatId}\0${row.personId}\0${row.kind}`) ?? []),
      row,
    ]);
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
    // One that can't post (they left the chat) stays held and doesn't block the others.
    const sent = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* chat.notice({
            orgId,
            chatId: KinChatId.make(first.chatId),
            messageId: KinMessageId.make(`kin-held:${first.holdId}`),
            audience: first.audience,
            body: [...new Set(group.map((row) => row.body))].join("\n\n"),
            ...(first.agentId === null ? {} : { from: first.agentId }),
            ...(first.waits === 1 ? { waitingFor: first.personId } : {}),
          });
          yield* sql`UPDATE kin_held_posts SET delivered_at = ${now}
          WHERE org_id = ${orgId} AND hold_id IN ${sql.in(group.map((row) => row.holdId))}`;
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
