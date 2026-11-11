import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** `person` is not the owner member of `chat`: someone besides the owner (`chat/sharing.ts`). */
const notOwnerText = (chat: string, person: string) =>
  `NOT EXISTS (SELECT 1 FROM kin_chat_members oc WHERE oc.org_id = m.org_id
    AND oc.chat_id = ${chat} AND oc.role = 'owner' AND oc.principal_kind = 'person'
    AND oc.person_id = ${person})`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const notOwner = (chat: string, person: string) => sql.literal(notOwnerText(chat, person));
  const now = yield* Clock.currentTimeMillis;
  const has = Effect.fnUntraced(function* (table: string, name: string) {
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(${sql(table)})`;
    return columns.some((column) => column.name === name);
  });
  // Set once, when someone besides the owner first could read the chat; never cleared after.
  if (!(yield* has("kin_chats", "shared_at"))) {
    yield* sql`ALTER TABLE kin_chats ADD COLUMN shared_at INTEGER`;
    yield* sql`ALTER TABLE kin_chats ADD COLUMN shared_from_seq INTEGER`;
  }
  // The first seq a person may read: their join's; the owner's is 0.
  if (!(yield* has("kin_chat_members", "joined_seq")))
    yield* sql`ALTER TABLE kin_chat_members ADD COLUMN joined_seq INTEGER NOT NULL DEFAULT 0`;
  // Who a worker's work was for: 'private' (an owner-only turn admitted it or a follow-up),
  // else shared. moved_at: its chat was shared after, so it answers in the owner's chat.
  if (!(yield* has("kin_workers", "context"))) {
    yield* sql`ALTER TABLE kin_workers ADD COLUMN context TEXT
      CHECK (context IS NULL OR context IN ('private', 'shared'))`;
    yield* sql`ALTER TABLE kin_workers ADD COLUMN moved_at INTEGER`;
  }

  const join = `COALESCE((SELECT MAX(x.seq) FROM kin_messages x
      WHERE x.org_id = m.org_id AND x.chat_id = m.chat_id AND x.created_at < m.joined_at), 0) + 1`;
  yield* sql`UPDATE kin_chat_members AS m SET joined_seq = ${sql.literal(join)}
    WHERE m.principal_kind = 'person' AND ${notOwner("m.chat_id", "m.person_id")}`;

  // A chat someone besides the owner was ever in, wrote or reacted in, or asked from, is shared
  // from the first seq they could read; with only a reaction or origin to go by, from now on.
  yield* sql`UPDATE kin_chats AS c SET shared_at = ${now},
    shared_from_seq = COALESCE((SELECT MIN(seq) FROM (
        SELECT m.joined_seq AS seq FROM kin_chat_members m
          WHERE m.org_id = c.org_id AND m.chat_id = c.chat_id AND m.principal_kind = 'person'
            AND ${notOwner("m.chat_id", "m.person_id")}
        UNION ALL SELECT m.seq FROM kin_messages m
          WHERE m.org_id = c.org_id AND m.chat_id = c.chat_id AND m.author_kind = 'human'
            AND ${notOwner("m.chat_id", "m.author_person_id")})), c.last_seq + 1)
    WHERE c.shared_at IS NULL AND (
      EXISTS (SELECT 1 FROM kin_chat_members m WHERE m.org_id = c.org_id AND m.chat_id = c.chat_id
        AND m.principal_kind = 'person' AND ${notOwner("m.chat_id", "m.person_id")})
      OR EXISTS (SELECT 1 FROM kin_messages m WHERE m.org_id = c.org_id AND m.chat_id = c.chat_id
        AND m.author_kind = 'human' AND ${notOwner("m.chat_id", "m.author_person_id")})
      OR EXISTS (SELECT 1 FROM kin_reactions r JOIN kin_chat_members m
          ON m.org_id = r.org_id AND m.member_id = r.member_id
        WHERE r.org_id = c.org_id AND r.chat_id = c.chat_id AND m.principal_kind = 'person'
          AND ${notOwner("m.chat_id", "m.person_id")})
      OR EXISTS (SELECT 1 FROM kin_events m WHERE m.org_id = c.org_id
        AND json_extract(m.json, '$.origin.chatId') = c.chat_id
        AND json_extract(m.json, '$.origin.personId') IS NOT NULL
        AND ${notOwner("c.chat_id", "json_extract(m.json, '$.origin.personId')")}))`;

  // A worker an owner-only prompt started is private; one a shared prompt or a teammate's
  // message started is shared. Before prompts recorded their audience, its stored asker decides.
  yield* sql`UPDATE kin_workers AS m SET context = CASE
      WHEN (SELECT w.audience FROM kin_wakeups w
        WHERE w.org_id = m.org_id AND w.wakeup_id = m.wakeup_id) = 'shared' THEN 'shared'
      WHEN (SELECT w.audience FROM kin_wakeups w
        WHERE w.org_id = m.org_id AND w.wakeup_id = m.wakeup_id) = 'owner_only' THEN 'private'
      WHEN json_extract(m.provenance_json, '$._tag') = 'human'
        AND NOT EXISTS (SELECT 1 FROM kin_agents oa WHERE oa.org_id = m.org_id
          AND oa.agent_id = m.agent_id
          AND oa.owner_person_id = json_extract(m.provenance_json, '$.personId')) THEN 'shared'
      ELSE 'private' END
    WHERE m.context IS NULL`;
  yield* sql`UPDATE kin_workers AS k SET moved_at = ${now}
    WHERE k.context = 'private' AND k.moved_at IS NULL AND EXISTS (SELECT 1 FROM kin_chats c
      WHERE c.org_id = k.org_id AND c.chat_id = k.chat_id AND c.shared_at IS NOT NULL)`;
});
