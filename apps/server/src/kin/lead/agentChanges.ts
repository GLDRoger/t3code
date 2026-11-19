import {
  type KinAgentChange,
  type KinAgentId,
  KinChatError,
  type KinMessageId,
  type KinOrgId,
  type KinPersonId,
  KinRecordKey,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { takenBy, undoTaken } from "../questions/defaultTaken.ts";
import { KinRecords } from "../work/KinRecords.ts";
import { tellMoved } from "../work/ownerWork.ts";
import { parseChanges } from "../work/recordRows.ts";
import { KIN_OWNER_LEVEL, type KinViewer, seenBy } from "../work/teamView.ts";
import { changeOf, linkOf, reversal, rowsOf } from "./changeRows.ts";

/** Fields that name a client or project by key. */
const NAMED_BY_KEY = new Set(["party", "project"]);

/** The agent's last record changes this viewer sees, newest first, kept on each record. */
export const agentChanges = Effect.fn("KinAgentChanges.list")(function* (
  viewer: KinViewer,
  orgId: KinOrgId,
  agentId: KinAgentId,
) {
  const changes = (yield* rowsOf(viewer, orgId, agentId)).map(changeOf);
  const keysOf = (change: KinAgentChange) =>
    change.fields
      .filter((one) => NAMED_BY_KEY.has(one.field))
      .flatMap((one) => [one.from, one.to])
      .filter((key): key is string => key !== null && key !== "");
  const keys = [...new Set(changes.flatMap(keysOf))];
  if (keys.length === 0) return changes;
  const sql = yield* SqlClient.SqlClient;
  const seen = new Map(
    (yield* sql<{ key: string; title: string }>`SELECT r.key, r.title FROM kin_records r
      WHERE r.org_id = ${orgId} AND r.key IN ${sql.in(keys)} AND ${seenBy(sql, viewer)}`).map(
      (row) => [row.key, row.title] as const,
    ),
  );
  return changes.map((change): KinAgentChange => {
    const named = keysOf(change).flatMap((key) => {
      const title = seen.get(key);
      return title === undefined ? [] : [{ key: KinRecordKey.make(key), title }];
    });
    return change.fields.some((one) => NAMED_BY_KEY.has(one.field)) ? { ...change, named } : change;
  });
});

/** Every reader of the replies from this wake-up gets them again, their receipt as it is now. */
const rereadReplies = Effect.fn("KinAgentChanges.rereadReplies")(
  function* (orgId: KinOrgId, wakeupId: string) {
    const sql = yield* SqlClient.SqlClient;
    // Any update moves the message's change_seq (K010), so a resuming reader gets it as well.
    const touched = yield* sql<{ messageId: KinMessageId }>`UPDATE kin_messages
    SET edited_at = edited_at
    WHERE org_id = ${orgId} AND source_wakeup_id = ${wakeupId} AND author_kind = 'agent'
      AND body <> ''
    RETURNING message_id AS "messageId"`;
    const hub = yield* Effect.serviceOption(KinChatHub);
    const repo = yield* Effect.serviceOption(KinChatRepository);
    if (Option.isNone(hub) || Option.isNone(repo)) return;
    for (const { messageId } of touched) {
      const message = yield* repo.value.getMessage({ orgId, messageId });
      if (Option.isSome(message))
        yield* hub.value.publish({ type: "message.changed", orgId, message: message.value });
    }
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin couldn't refresh a turn's receipt", { cause }),
  ),
);

/**
 * Puts back what one of the agent's changes replaced, as `by`'s own change, recorded on the entry
 * like any edit; whoever holds a task it moves is told. Refused once the entry changed since. A
 * default Kin took is put back as its note's Undo does (`undoTaken`).
 */
export const ownerLevelUndoAgentChange = Effect.fn("KinAgentChanges.undo")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly seq: number;
  readonly by: KinPersonId;
}) {
  const [row] = yield* rowsOf(KIN_OWNER_LEVEL, input.orgId, input.agentId, input.seq);
  if (row === undefined)
    return yield* new KinChatError({ reason: "not_found", message: "That change isn't there." });
  if (changeOf(row).since)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: `${row.key} changed since, so Kin won't put this back over it. Open it to change it yourself.`,
    });
  const writer = {
    actor: { _tag: "person", personId: input.by },
    via: "owner",
    askedBy: input.by,
  } as const;
  const records = yield* KinRecords;
  const made = linkOf({ ...row, fields: parseChanges(row.fieldsJson) });
  if (made !== undefined) {
    if (yield* records.unlink(input.orgId, writer, row.recordId, made)) {
      if (row.wakeupId !== null) yield* rereadReplies(input.orgId, row.wakeupId);
      return;
    }
    return yield* new KinChatError({
      reason: "invalid_state",
      message: `That link on ${row.key} is already gone.`,
    });
  }
  const fields = parseChanges(row.fieldsJson);
  const patch = reversal({ ...row, fields });
  if (patch === undefined)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: `Kin can't put this change to ${row.key} back on its own. Open it to change it yourself.`,
    });
  const questionId = takenBy(fields);
  if (questionId !== undefined)
    return yield* undoTaken(
      {
        orgId: input.orgId,
        questionId,
        agentId: input.agentId,
        writer,
        by: input.by,
        key: row.key,
        patch,
        name: row.key,
      },
      {
        records,
        chat: Option.getOrUndefined(yield* Effect.serviceOption(KinChatService)),
      },
    );
  const before = yield* records.get(input.orgId, row.key);
  yield* records.update(input.orgId, writer, row.key, patch);
  yield* tellMoved(
    { _tag: "person", orgId: input.orgId, personId: input.by },
    before,
    yield* records.get(input.orgId, row.key),
  );
  if (row.wakeupId !== null) yield* rereadReplies(input.orgId, row.wakeupId);
});
