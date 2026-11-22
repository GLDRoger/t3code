import {
  KIN_TROUBLE_ACTION_LABELS,
  KinTroubleCause,
  kinBytesText,
  kinTroubleWords,
  type KinHostStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** What `kin_computer` answers: the facts Settings › Kin's computer shows, in the table's words. */
export const KinComputerResult = Schema.Struct({
  troubles: Schema.Array(
    Schema.Struct({
      cause: KinTroubleCause,
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

export const kinComputerView = (status: KinHostStatus): typeof KinComputerResult.Type => ({
  troubles: status.agents.troubles.map(({ card }) => {
    const words = kinTroubleWords(card, (iso) => iso);
    return {
      cause: card.cause,
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
