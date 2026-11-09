import {
  KinChatError,
  KinMemoryChangeCard,
  type KinMemoryChangeKind,
  type KinMemoryUndoInput,
  type KinWidget,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { KIN_SEND_FAILED_TEXT } from "./kinDeferralPresentation";

const decodeCard = Schema.decodeUnknownOption(KinMemoryChangeCard);
const isKinChatError = Schema.is(KinChatError);

const VERBS: Record<KinMemoryChangeKind, string> = {
  created: "Remembered",
  updated: "Updated",
  superseded: "Replaced",
  invalidated: "Forgot",
};

export interface KinMemoryChangeItemView {
  readonly itemId: KinMemoryUndoInput["itemId"];
  readonly line: string;
  /** `available` offers Undo; the others say what already happened. */
  readonly undo: "available" | "undone" | "stale";
  readonly accessibilityLabel: string;
}

export interface KinMemoryChangesCardView {
  readonly orgId: KinWidget["orgId"];
  readonly widgetId: KinWidget["widgetId"];
  readonly items: ReadonlyArray<KinMemoryChangeItemView>;
  readonly more: string | null;
}

/** Null when the state isn't a change card this build can read. */
export function kinMemoryChangesView(widget: KinWidget): KinMemoryChangesCardView | null {
  const card = decodeCard(widget.state);
  if (Option.isNone(card)) return null;
  const { items, more } = card.value;
  return {
    orgId: widget.orgId,
    widgetId: widget.widgetId,
    items: items.map((item) => {
      const line = `${VERBS[item.change]}: ${item.title}`;
      const undo = item.undo ?? "available";
      return {
        itemId: item.itemId,
        line,
        undo,
        accessibilityLabel:
          undo === "undone"
            ? `${line}. Undone.`
            : undo === "stale"
              ? `${line}. Changed again since, so it can't be undone here.`
              : line,
      };
    }),
    more: more === 0 ? null : `And ${more} more ${more === 1 ? "change" : "changes"}.`,
  };
}

/** The server writes Undo refusals for the owner ("This changed again since…"), so they show. */
export function kinMemoryUndoFailureText(cause: unknown): string {
  if (!isKinChatError(cause)) return KIN_SEND_FAILED_TEXT;
  switch (cause.reason) {
    case "conflict":
    case "invalid_state":
    case "not_allowed":
    case "not_found":
    case "unavailable":
      return cause.message.trim().slice(0, 280) || KIN_SEND_FAILED_TEXT;
    default:
      return KIN_SEND_FAILED_TEXT;
  }
}
