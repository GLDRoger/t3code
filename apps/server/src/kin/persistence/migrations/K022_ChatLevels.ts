import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A lead's level in one chat (the set_level target's chatId). Absent means the lead's own level.
  yield* sql`
    CREATE TABLE kin_chat_levels (
      org_id TEXT NOT NULL REFERENCES kin_orgs(org_id),
      agent_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      level TEXT NOT NULL CHECK (level IN ('L0', 'L1', 'L2', 'L3')),
      level_since INTEGER NOT NULL,
      PRIMARY KEY (org_id, agent_id, chat_id),
      FOREIGN KEY (org_id, agent_id) REFERENCES kin_leads(org_id, agent_id),
      FOREIGN KEY (org_id, chat_id) REFERENCES kin_chats(org_id, chat_id)
    )
  `;
});
