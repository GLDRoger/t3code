import { KIN_SELLS_MAX } from "@t3tools/contracts";

/** Setting Kin up for the kind of company it is: the question a new company is asked, and the way back in. */
export const KIN_SET_UP = {
  question: "What does your company sell, and to whom?",
  example: "For example: a mobile puzzle game, paid in-app and by subscription, for casual players.",
  hint: "Optional. Kin uses it to suggest a set-up that fits.",
  max: KIN_SELLS_MAX,
  /** Settings › Sections, owner level only. */
  title: "Your kind of company",
  detail:
    "Your Chief of staff reads What we sell and suggests sections, lists and numbers that fit. Nothing changes until you confirm each one.",
  action: "Set up for my kind of company…",
  noChief: "This needs a Chief of staff. Add one under Agents.",
  failed: "Couldn't open the chat with your Chief of staff. Try again.",
  /** The message the action sends as the owner's own. */
  ask: "Set Kin up for my kind of company. Go by What we sell, and ask me what we sell if it doesn't say.",
} as const;

/** The live Chief of staff the action asks, by id so every client picks the same one. */
export const kinSetUpChief = <
  Lead extends { readonly agentId: string; readonly domain: string; readonly retired?: unknown },
>(
  leads: ReadonlyArray<Lead>,
): Lead | null =>
  leads
    .filter((lead) => lead.domain === "chief-of-staff" && lead.retired === undefined)
    .toSorted((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0))[0] ?? null;

/**
 * The answer a new company gave, as the host wrote it: the line between What we sell's title and
 * its first section. Null for Kin's bare outline or a doc written another way.
 */
export function kinWhatWeSellAnswer(body: string): string | null {
  const lines = body.split("\n");
  const title = lines.findIndex((line) => /^#\s/.test(line));
  if (title === -1) return null;
  const rest = lines.slice(title + 1);
  const next = rest.findIndex((line) => /^#{1,6}\s/.test(line));
  const answer = (next === -1 ? rest : rest.slice(0, next)).join(" ").replace(/\s+/g, " ").trim();
  return answer === "" ? null : answer;
}

/** The intro's line in the Chief of staff's first chat when the company said what it sells. */
export const kinIntroSetUpLine = (agentName: string, answer: string) =>
  `You said you sell: ${answer}. Say hello and ${agentName} will suggest how to set Kin up for that.`;
