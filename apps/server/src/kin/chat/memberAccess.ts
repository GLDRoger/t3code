import {
  KIN_TEAM_ROOM_TEAM_ID,
  KinPersonId,
  type KinChatId,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ownerLevel } from "../people/KinAccess.ts";
import type { PersonIdentity } from "./KinIdentity.ts";

/** A membership row alone never lets a teammate read the Team room. */
export const roomReadable = (identity: PersonIdentity, chat: { readonly teamId: string | null }) =>
  chat.teamId === KIN_TEAM_ROOM_TEAM_ID
    ? ownerLevel(identity.orgId, identity.personId)
    : Effect.succeed(true);

export const teammatesIn = Effect.fn("KinChatMembers.teammatesIn")(function* (
  orgId: KinOrgId,
  chatId: KinChatId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ personId: string }>`SELECT DISTINCT person_id AS "personId"
    FROM kin_chat_members WHERE org_id = ${orgId} AND chat_id = ${chatId}
      AND principal_kind = 'person' AND left_at IS NULL AND person_id IS NOT NULL
    ORDER BY person_id`;
  const out: Array<KinPersonId> = [];
  for (const row of rows) {
    const person = KinPersonId.make(row.personId);
    if (!(yield* ownerLevel(orgId, person))) out.push(person);
  }
  return out;
});
