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
import { companyListSql } from "./keyGuard.ts";
import { keyWithheld } from "./recordRows.ts";

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
  /** What the calling tool works on: a Work task (the default), a promise, or a company list's entry. */
  readonly kind?: "task" | "promise" | "entry";
  /** Other entries the call names, by key: each checked in the write's own transaction. */
  readonly names?: ReadonlyArray<string>;
}

export const connectionOf = (
  holder: TasksKeyHolder,
  kind: CodingAgentConnection["kind"] = "task",
): CodingAgentConnection => ({
  _tag: "codingAgent",
  orgId: holder.orgId,
  personId: holder.personId,
  sessionId: holder.sessionId,
  kind,
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

/**
 * In the caller's transaction: what the key adds to the screen's own check for one entry: it is
 * the calling tool's own kind (a Work task, a promise, a company list's entry), nobody dropped it,
 * and neither it nor its client or project is labelled now. Whether the person may read or change
 * it is their screen's rule, decided by the Work method as for their app.
 */
const kindSql = (kind: NonNullable<CodingAgentConnection["kind"]>) =>
  kind === "entry"
    ? companyListSql("r")
    : kind === "promise"
      ? "(r.register_id = 'work' AND r.category = 'obligation')"
      : "r.register_id = 'work'";

export const connectionReaches = Effect.fn("KinCodingAgent.reaches")(function* (
  connection: CodingAgentConnection,
  recordId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const found = yield* sql`SELECT 1 FROM kin_records r
    WHERE r.org_id = ${connection.orgId} AND r.record_id = ${recordId}
      AND ${sql.literal(kindSql(connection.kind ?? "task"))}
      AND r.state <> 'dropped' AND NOT ${keyWithheld(sql)}`;
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
