import type { KinMessage } from "@t3tools/contracts";

/** Sample asks on the first-run intro. `send` posts as is; the rest open in the composer. */
export const KIN_INTRO_PROMPTS: ReadonlyArray<{ readonly text: string; readonly send: boolean }> = [
  { text: "What can you do?", send: true },
  { text: "Remind me tomorrow at 9 to review PRs", send: true },
  { text: "Remember that I prefer short replies", send: true },
  // Sending a worker costs a real run, so the owner finishes this one before it goes.
  { text: "Get a worker to ", send: false },
];

/**
 * The intro shows in the owner's direct chat with their lead until the owner has said anything.
 * It stays hidden while older messages are unread from the host: one of them may be the owner's.
 */
export function kinIntroVisible(input: {
  readonly ownsLead: boolean;
  readonly agentName: string | null;
  readonly viewerPersonId: string | null;
  readonly messages: ReadonlyArray<KinMessage>;
  /** Sends still in the outbox. */
  readonly pendingCount: number;
  /** "Load earlier" has more to read, or a reset is reloading the feed. */
  readonly historyIncomplete: boolean;
}): boolean {
  if (!input.ownsLead || input.agentName === null || input.viewerPersonId === null) return false;
  if (input.pendingCount > 0 || input.historyIncomplete) return false;
  return !input.messages.some(
    (message) =>
      message.author._tag === "human" && message.author.personId === input.viewerPersonId,
  );
}
