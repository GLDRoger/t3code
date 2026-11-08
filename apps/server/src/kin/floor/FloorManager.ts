import type {
  KinAgentId,
  KinAgentIntent,
  KinAgentRole,
  KinChatId,
  KinMessageId,
} from "@t3tools/contracts";

export const FLOOR_MAX_AGENT_TURNS = 6;
export const FLOOR_BID_WINDOW_MS = 2_000;
export const FLOOR_GRANT_TTL_MS = 5 * 60_000;

export interface FloorRun {
  readonly runId: string;
  readonly chatId: KinChatId;
  readonly openedBy: KinMessageId;
  readonly mentionQueue: ReadonlyArray<KinAgentId>;
  readonly agentTurns: number;
  readonly lastSpeaker: KinAgentId | null;
  readonly spoken: ReadonlyArray<KinAgentId>;
  readonly grant: {
    readonly agentId: KinAgentId;
    readonly token: string;
    readonly expiresAt: number;
  } | null;
  readonly state: "open" | "closed";
}
interface FloorBid {
  readonly agentId: KinAgentId;
  readonly role: KinAgentRole;
  readonly reason: string;
  readonly intent: KinAgentIntent;
  readonly at: number;
}
export type FloorDecision =
  | { readonly _tag: "grant"; readonly agentId: KinAgentId }
  | { readonly _tag: "wait" }
  | { readonly _tag: "close"; readonly reason: "turn_budget" | "no_bids" | "nothing_to_add" };

export const replyIntentAllowed = (turns: number, intent: KinAgentIntent) =>
  turns === 0 || intent === "evidence" || intent === "objection" || intent === "decision";
export const noticeIntentAllowed = (intent: KinAgentIntent) =>
  intent === "evidence" || intent === "decision" || intent === "question";

export function decideFloor(input: {
  readonly run: FloorRun;
  readonly bids: ReadonlyArray<FloorBid>;
  readonly text: string;
  readonly leadAgentId: KinAgentId;
  readonly bidWindowOpenedAt: number;
  readonly now: number;
}): FloorDecision {
  const { run } = input;
  if (run.agentTurns >= FLOOR_MAX_AGENT_TURNS) return { _tag: "close", reason: "turn_budget" };
  if (run.state === "closed") return { _tag: "close", reason: "nothing_to_add" };
  const mentioned = run.mentionQueue.find((agent) => agent !== run.lastSpeaker);
  if (mentioned !== undefined) return { _tag: "grant", agentId: mentioned };
  if (input.now < input.bidWindowOpenedAt + FLOOR_BID_WINDOW_MS) return { _tag: "wait" };
  const role = /\b(test|tests|testing|bug|bugs)\b/i.test(input.text)
    ? "qa"
    : /\b(deploy|deploying|deployment|release|released)\b/i.test(input.text)
      ? "release"
      : "lead";
  const score = (bid: FloorBid) =>
    role === "lead" ? Number(bid.agentId === input.leadAgentId) : Number(bid.role === role);
  const bids = input.bids.filter(
    (bid) =>
      bid.at >= input.bidWindowOpenedAt &&
      bid.at <= input.bidWindowOpenedAt + FLOOR_BID_WINDOW_MS &&
      bid.at <= input.now &&
      bid.agentId !== run.lastSpeaker &&
      replyIntentAllowed(run.agentTurns, bid.intent),
  );
  bids.sort((a, b) => score(b) - score(a) || a.at - b.at || a.agentId.localeCompare(b.agentId));
  const first = bids[0];
  return first === undefined
    ? { _tag: "close", reason: input.bids.length === 0 ? "no_bids" : "nothing_to_add" }
    : { _tag: "grant", agentId: first.agentId };
}
