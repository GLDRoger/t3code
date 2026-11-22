import {
  KIN_TROUBLE_ACTION_LABELS,
  KinChatError,
  KinTroubleCause,
  kinBytesText,
  kinTroubleWords,
  type KinHostStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { effectiveAudience, turnChat } from "../lead/Audience.ts";
import type { resolveLead } from "../lead/LeadMemory.ts";
import { sensitiveShown } from "../work/sensitiveReads.ts";
import { KinHostCare } from "./KinHostCare.ts";

// Keep the agent tool's enum stable; the accompanying words still identify the memory problem.
const ComputerTroubleCause = Schema.Literals(
  KinTroubleCause.literals.filter((cause) => cause !== "memory"),
);

const OwnerComputerResult = Schema.Struct({
  troubles: Schema.Array(
    Schema.Struct({
      cause: ComputerTroubleCause,
      agents: Schema.Array(Schema.String),
      heldTurns: Schema.Number,
      openedAt: Schema.String,
      what: Schema.String,
      doing: Schema.NullOr(Schema.String),
      personCanTap: Schema.Array(Schema.String),
    }),
  ),
  space: Schema.NullOr(
    Schema.Struct({
      free: Schema.String,
      total: Schema.String,
      level: Schema.Literals(["ok", "low", "out"]),
    }),
  ),
  backup: Schema.NullOr(
    Schema.Struct({ setUp: Schema.Boolean, lastGoodAt: Schema.NullOr(Schema.String) }),
  ),
  turnsRunning: Schema.Number,
  version: Schema.String,
  lastRestart: Schema.String,
});

export const KinComputerResult = Schema.Union([
  OwnerComputerResult,
  Schema.Struct({ message: Schema.String }),
]);

const kinComputerView = (status: KinHostStatus): typeof OwnerComputerResult.Type => ({
  troubles: status.agents.troubles.map(({ card }) => {
    const words = kinTroubleWords(card, (iso) => iso);
    return {
      cause: card.cause === "memory" ? "unknown" : card.cause,
      agents: card.agents.map((agent) => agent.name),
      heldTurns: card.count,
      openedAt: card.openedAt,
      what: words.what,
      doing: words.doing,
      personCanTap: words.actions.map((action) => KIN_TROUBLE_ACTION_LABELS[action]),
    };
  }),
  space:
    status.space === null
      ? null
      : {
          free: kinBytesText(status.space.freeBytes),
          total: kinBytesText(status.space.totalBytes),
          level: status.space.level,
        },
  backup:
    status.backup === null
      ? null
      : { setUp: status.backup.configured, lastGoodAt: status.backup.lastGoodAt },
  turnsRunning: status.agents.running,
  version: status.version,
  lastRestart: status.startedAt,
});

export const readKinComputer = Effect.fn("KinHostCare.readForTurn")(function* (
  turn: Effect.Success<ReturnType<typeof resolveLead>>,
) {
  if ((yield* effectiveAudience(turn)) === "owner_only") {
    const care = yield* Effect.serviceOption(KinHostCare);
    if (Option.isNone(care))
      return yield* new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });
    const status = yield* care.value.status(turn.orgId);
    yield* sensitiveShown(turn);
    return kinComputerView(status);
  }

  const chat = yield* turnChat(turn);
  const none = { message: "You have no requests held by a computer problem in this chat." };
  if (chat?.asked !== true) return none;
  const sql = yield* SqlClient.SqlClient;
  const [held] = yield* sql<{ waiting: number; told: number }>`SELECT
      e.state = 'queued' AS waiting, t.told_at IS NOT NULL AS told
    FROM kin_events e JOIN kin_troubles t ON t.org_id = e.org_id AND t.trouble_id = e.held_by
    WHERE e.org_id = ${turn.orgId} AND e.agent_id = ${turn.agentId}
      AND e.state IN ('queued', 'failed') AND t.closed_at IS NULL
      AND COALESCE(json_extract(e.json, '$.origin.chatId'), json_extract(e.json, '$.chatId')) = ${chat.chatId}
    ORDER BY e.received_at DESC, e.event_id DESC LIMIT 1`;
  if (held === undefined) return none;
  const problem = held.told
    ? "Kin's computer has a problem its owner has been told about"
    : "Kin's computer has a problem";
  return {
    message: held.waiting
      ? `${problem}; your request will run when it is fixed.`
      : `${problem}; your request won't run again unless the owner taps Try again.`,
  };
});
