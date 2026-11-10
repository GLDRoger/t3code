import type { KinAgentIntent } from "@t3tools/contracts";

export const FLOOR_MAX_AGENT_TURNS = 6;
export const FLOOR_GRANT_TTL_MS = 5 * 60_000;

/** After the first reply, only an agent still owed its turn answers; the rest add or object. */
export const replyIntentAllowed = (turns: number, intent: KinAgentIntent) =>
  turns === 0 || intent === "evidence" || intent === "objection" || intent === "decision";
export const noticeIntentAllowed = (intent: KinAgentIntent) =>
  intent === "evidence" || intent === "decision" || intent === "question";
