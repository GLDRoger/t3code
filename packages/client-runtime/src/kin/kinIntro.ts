import type { KinMessage } from "@t3tools/contracts";

/**
 * Sample asks on the first-run intro, each read whole on its chip (`label`). `send` posts `text`
 * as is; the rest open `text` in the composer for the owner to finish.
 */
export const KIN_INTRO_PROMPTS: ReadonlyArray<{
  readonly label: string;
  readonly text: string;
  readonly send: boolean;
}> = [
  // Every lead gets these, whatever its domain, so none of them names engineering work.
  { label: "What can you do?", text: "What can you do?", send: true },
  { label: "What are you working on?", text: "What are you working on?", send: true },
  { label: "Set a reminder", text: "Remind me tomorrow at 9 to ", send: false },
];

/** Said of a chip that opens its words in the composer instead of sending them. */
export const KIN_INTRO_START_HINT = "Starts the message for you to finish";
export const kinIntroSendsTo = (agentName: string) => `Sends this to ${agentName}`;

/** On the intro while a company made new has no country (`countryNeeded`): opens Company details. */
export const KIN_INTRO_COUNTRY = "Choose your company's country";

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
