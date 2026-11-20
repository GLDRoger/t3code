import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

import { CLAUDE_PROVIDER } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

// The Claude adapter names a thinking block's item `<message id>:thinking:<index>`;
// ClaudeAdapterV2.test.ts pins that against the adapter's own output.
export const claudeThinkingItemId = (messageId: string, index: number) =>
  `${messageId}:thinking:${index}`;
const THINKING_ITEM_ID = /:thinking:\d+$/u;

/** A turn item made from a thinking block, even one shown as an update. */
export const isClaudeThinkingItem = (item: Pick<OrchestrationV2TurnItem, "nativeItemRef">) =>
  item.nativeItemRef?.driver === CLAUDE_PROVIDER &&
  THINKING_ITEM_ID.test(item.nativeItemRef.nativeId ?? "");
