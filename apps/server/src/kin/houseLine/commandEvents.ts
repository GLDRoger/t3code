import type { KinHouseLineCrownCommand, KinHouseLineWillCommand } from "@t3tools/contracts";
import { KIN_WILL_CHAR_LIMIT, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

type KinHouseLineCommand = KinHouseLineCrownCommand | KinHouseLineWillCommand;

/** The crowning id is derived from the command so the caller and the event agree. */
export function crowningIdFromCommand(command: {
  readonly commandId: string;
  readonly laneId: string;
}): string {
  return `kin-crowning:${command.laneId}:${command.commandId}`;
}

/** Pure: the orchestrator emits this event or rejects the command. */
export function planKinHouseLineCommand(
  command: KinHouseLineCommand,
  occurredAt: DateTime.Utc,
): { readonly event: Omit<OrchestrationV2DomainEvent, "id"> } | { readonly error: string } {
  if (command.role === "reviewer" || command.crownable === false) {
    return {
      error:
        command.type === "kin.houseLine.crown"
          ? "Reviewers are not crowned."
          : "Reviewers do not leave wills.",
    };
  }
  const at = DateTime.formatIso(occurredAt);
  if (command.type === "kin.houseLine.crown") {
    return {
      event: {
        type: "kin.houseLine.crowned",
        threadId: command.threadId,
        occurredAt,
        payload: {
          crowningId: crowningIdFromCommand(command),
          laneId: command.laneId,
          projectId: command.projectId,
          houseId: command.houseId,
          houseName: command.houseName,
          lineId: command.lineId,
          label: command.label,
          threadId: command.threadId,
          profile: command.profile,
          role: command.role,
          provider: command.provider,
          model: command.model,
          regnalNumber: command.regnalNumber,
          at,
        },
      },
    };
  }
  if (command.body.trim().length === 0) return { error: "A will needs text." };
  if (command.body.length > KIN_WILL_CHAR_LIMIT) {
    return { error: `A will is at most ${KIN_WILL_CHAR_LIMIT} characters.` };
  }
  return {
    event: {
      type: "kin.houseLine.will-recorded",
      threadId: command.threadId,
      occurredAt,
      payload: {
        willId: command.willId,
        crowningId: command.crowningId,
        laneId: command.laneId,
        body: command.body,
        at,
      },
    },
  };
}
