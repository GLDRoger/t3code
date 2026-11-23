import {
  type AuthSessionId,
  KinChatError,
  type KinOrgId,
  type KinPersonId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { KinIdentity } from "../chat/KinIdentity.ts";
import { isOwnerHimself } from "../people/KinAccess.ts";
import { holderOf, type TasksKeyHolder } from "../tasksKey/TasksKeys.ts";
import { keyWithheld } from "./recordRows.ts";
import { alsoOnIt } from "./teamView.ts";

/**
 * A person's own coding agent, calling with its key: who it acts as, from `admit`, never from a
 * request. Each Work method that takes one checks it in its own transaction, on top of the
 * person's own screen check, and marks what it writes with `sessionId`.
 */
export interface CodingAgentConnection {
  readonly _tag: "codingAgent";
  readonly orgId: KinOrgId;
  readonly personId: KinPersonId;
  readonly sessionId: AuthSessionId;
}

export const connectionOf = (holder: TasksKeyHolder): CodingAgentConnection => ({
  _tag: "codingAgent",
  orgId: holder.orgId,
  personId: holder.personId,
  sessionId: holder.sessionId,
});

export const connectionEnded = new KinChatError({
  reason: "not_allowed",
  message: "This coding agent key no longer works. Ask its holder for a new one.",
});

/**
 * In the caller's transaction: the key is live for this person, and the person still has a screen
 * to act from, an unrevoked device binding, unless they are the owner, whose devices are paired.
 */
export const connectionLive = Effect.fn("KinCodingAgent.live")(function* (
  connection: CodingAgentConnection,
) {
  const holder = yield* holderOf(connection.sessionId);
  if (Option.isNone(holder) || holder.value.personId !== connection.personId) return false;
  const { owner } = yield* KinIdentity;
  if (isOwnerHimself(owner, connection.personId)) return true;
  const sql = yield* SqlClient.SqlClient;
  const bound = yield* sql`SELECT 1 FROM kin_session_bindings b
    WHERE b.org_id = ${connection.orgId} AND b.person_id = ${connection.personId}
      AND b.revoked_at IS NULL LIMIT 1`;
  return bound.length > 0;
});

/** A coding agent's change to a task its person is only on: they read it and comment. */
export const onlyOnIt = (key: string) =>
  `${key} is held by someone else: comment on it instead. Only whoever holds it changes it.`;

/**
 * In the caller's transaction: what the key adds to the screen's own check for one entry. A Work
 * task this person holds, or is on to read and comment (`changes` false), nobody dropped, and
 * neither it nor its client or project labelled now.
 */
export const connectionReaches = Effect.fn("KinCodingAgent.reaches")(function* (
  connection: CodingAgentConnection,
  recordId: string,
  changes = false,
) {
  const sql = yield* SqlClient.SqlClient;
  const found = yield* sql`SELECT 1 FROM kin_records r
    WHERE r.org_id = ${connection.orgId} AND r.record_id = ${recordId}
      AND r.register_id = 'work' AND r.state <> 'dropped'
      AND ((r.owner_kind = 'person' AND r.owner_id = ${connection.personId})
        OR (${changes ? sql`0` : sql`1`} AND ${alsoOnIt(sql, connection.personId)}))
      AND NOT ${keyWithheld(sql)}`;
  return found.length > 0;
});

/**
 * In the caller's transaction: which of these entries no key reaches, whoever holds it
 * (`keyWithheld`). Every read a key makes beyond its tasks passes its rows through this.
 */
export const keyHidden = Effect.fn("KinCodingAgent.hidden")(function* (
  orgId: KinOrgId,
  recordIds: ReadonlyArray<string>,
) {
  if (recordIds.length === 0) return new Set<string>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ id: string }>`SELECT r.record_id AS id FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.record_id IN ${sql.in([...new Set(recordIds)])}
      AND ${keyWithheld(sql)}
    ORDER BY r.record_id`;
  return new Set(rows.map((row) => row.id));
});
