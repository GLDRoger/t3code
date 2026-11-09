import {
  KinChatError,
  KinPromotionCard,
  KinShadowReviewCard,
  type KinLevel,
  type KinLevelsView,
  type KinPromotionStats,
  type KinShadowVerdict,
  type KinWidget,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";

import { kinSentences } from "../state/kinScreenState";
import { KIN_SEND_FAILED_TEXT } from "./kinDeferralPresentation";

const decodeShadowReview = Schema.decodeUnknownOption(KinShadowReviewCard);
const decodePromotion = Schema.decodeUnknownOption(KinPromotionCard);
const isKinChatError = Schema.is(KinChatError);

// Server-drawn, but titles and previews carry lead-written text: plain text, clamped.
const clamp = (text: string, max: number) => {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
};

export const KIN_VERDICTS: ReadonlyArray<{
  readonly verdict: KinShadowVerdict;
  readonly label: string;
}> = [
  { verdict: "fine", label: "Fine as is" },
  { verdict: "change", label: "I'd change it" },
  { verdict: "wrong", label: "Wrong" },
  { verdict: "harmful", label: "Harmful" },
];

const VERDICT_LABEL = Object.fromEntries(
  KIN_VERDICTS.map((option) => [option.verdict, option.label]),
) as Record<KinShadowVerdict, string>;

const TOOL_LABELS: Record<string, string> = {
  kin_chat_post: "Post",
  kin_delegate: "Delegation",
  kin_follow_up: "Follow-up",
  request_action: "Request",
};

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Day 3 of 7 at L0. 12 of 20 reviewed, 10 fine as is, none harmful, 2 unreviewed." */
export function kinTrialLines(stats: KinPromotionStats): ReadonlyArray<string> {
  const { rule } = stats;
  const share = Math.round(rule.minFineShare * 100);
  const lines = [
    stats.to === null
      ? `${count(stats.daysAtLevel, "day")} at ${stats.from}, the top level.`
      : `Day ${stats.daysAtLevel} of ${rule.minDays} at ${stats.from}.`,
    `${stats.reviewed} of ${rule.minReviewed} reviewed, ${stats.fine} fine as is, ${
      stats.harmful === 0 ? "none" : stats.harmful
    } harmful, ${stats.unreviewed} unreviewed.`,
  ];
  if (stats.to !== null) {
    lines.push(
      stats.eligible
        ? `Ready for ${stats.to}.`
        : `${stats.to} needs ${rule.minDays} days, ${rule.minReviewed} reviewed, ${share}% fine as is, none harmful and none unreviewed.`,
    );
  }
  return lines;
}

export interface KinShadowReviewEntryView {
  readonly entryId: string;
  /** "kin_chat_post at L0" and what it would have reached. */
  readonly heading: string;
  readonly target: string | null;
  /** Shown whole, line breaks kept; the server already spelled out hidden characters. */
  readonly preview: string;
  readonly truncated: boolean;
  readonly verdict: KinShadowVerdict | null;
  readonly accessibilityLabel: string;
}

export interface KinShadowReviewCardView {
  readonly orgId: KinWidget["orgId"];
  readonly revision: number;
  readonly title: string;
  readonly summary: string;
  readonly entries: ReadonlyArray<KinShadowReviewEntryView>;
  readonly more: string | null;
  readonly trial: ReadonlyArray<string>;
  readonly closed: boolean;
}

export function kinShadowReviewView(
  widget: KinWidget,
  card: KinShadowReviewCard,
): KinShadowReviewCardView {
  const hidden = card.total - card.entries.length;
  return {
    orgId: widget.orgId,
    revision: widget.revision,
    title: clamp(card.title, 200) || "Trial review",
    summary:
      card.unreviewed === 0
        ? `All ${count(card.total, "entry", "entries")} reviewed.`
        : `${card.unreviewed} of ${card.total} still need a verdict.`,
    entries: card.entries.map((entry) => {
      const heading = `${TOOL_LABELS[entry.tool] ?? clamp(entry.tool, 60)} at ${entry.level}`;
      const target = clamp(entry.wouldTarget, 160) || null;
      const preview = entry.preview.trim();
      return {
        entryId: entry.entryId,
        heading,
        target,
        preview,
        truncated: entry.truncated,
        verdict: entry.verdict,
        accessibilityLabel: kinSentences([
          heading,
          target === null ? null : `Would reach ${target}`,
          preview,
          entry.truncated ? "Cut short" : null,
          entry.verdict === null ? "Not reviewed" : `Marked ${VERDICT_LABEL[entry.verdict]}`,
        ]),
      };
    }),
    more: hidden > 0 ? `${hidden} more after these.` : null,
    trial: kinTrialLines(card.promotion),
    closed: widget.closedAt !== null,
  };
}

/** The verdict to show: the owner's tap until the server's next revision carries it. */
export function kinShownVerdict(
  entry: Pick<KinShadowReviewEntryView, "entryId" | "verdict">,
  revision: number,
  local: { readonly revision: number; readonly verdicts: ReadonlyMap<string, KinShadowVerdict> },
): KinShadowVerdict | null {
  if (local.revision !== revision) return entry.verdict;
  return local.verdicts.get(entry.entryId) ?? entry.verdict;
}

export type KinPromotionActionId = "raise" | "defer" | "keep" | "discard";

export interface KinPromotionAction {
  readonly id: KinPromotionActionId;
  readonly label: string;
  readonly tone: "primary" | "secondary";
  readonly disabled: boolean;
}

export interface KinPromotionCardView {
  readonly orgId: KinWidget["orgId"];
  readonly agentId: KinPromotionCard["agentId"];
  readonly revision: number;
  readonly status: KinPromotionCard["status"];
  readonly eyebrow: string;
  readonly title: string;
  readonly lines: ReadonlyArray<string>;
  /** Paths Keep would commit, and those that need the owner's review in a PR. */
  readonly paths: ReadonlyArray<string>;
  readonly ownerReviewed: ReadonlyArray<string>;
  readonly target: KinLevel | null;
  readonly actions: ReadonlyArray<KinPromotionAction>;
  readonly accessibilityLabel: string;
}

const dateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});

function promotionBody(
  card: KinPromotionCard,
): Pick<KinPromotionCardView, "eyebrow" | "lines" | "actions"> {
  const to = card.stats.to ?? card.stats.from;
  // A lead at the top level has nothing to raise to.
  const raise: ReadonlyArray<KinPromotionAction> =
    card.stats.to === null
      ? []
      : [{ id: "raise", label: `Raise to ${to}`, tone: "primary", disabled: false }];
  switch (card.status) {
    case "ready":
      return {
        eyebrow: "Promotion",
        lines: [],
        actions: [
          ...raise,
          { id: "defer", label: "Another week", tone: "secondary", disabled: false },
        ],
      };
    case "deferred":
      return {
        eyebrow: "Promotion",
        lines: [
          card.deferredUntil === null
            ? "Put off for a week."
            : `Put off until ${dateFormat.format(new Date(card.deferredUntil))}.`,
        ],
        actions: raise,
      };
    case "awaiting_approval":
      // There is no approval screen on the phone yet, so the card says where the raise stands.
      return {
        eyebrow: "Waiting on your approval",
        lines: [`Raise to ${to} is waiting for your signed approval. It applies once you sign it.`],
        actions: [],
      };
    case "raised": {
      const raised = `Raised to ${to}.`;
      if (card.shadowMemory === "kept")
        return { eyebrow: "Promotion", lines: [raised, "Shadow memory kept."], actions: [] };
      if (card.shadowMemory === "discarded")
        return { eyebrow: "Promotion", lines: [raised, "Started clean."], actions: [] };
      if (card.shadowMemory !== "pending")
        return { eyebrow: "Promotion", lines: [raised], actions: [] };
      const changes = card.shadowChanges;
      const blocked = changes === null || changes.ownerReviewed.length > 0;
      return {
        eyebrow: "Shadow memory",
        lines: [
          raised,
          changes === null
            ? "Listing what the shadow week wrote…"
            : changes.paths.length === 0
              ? "The shadow week wrote nothing to keep."
              : `Keep commits ${count(changes.paths.length, "file")} from the shadow week${changes.truncated ? " (list cut short)" : ""}:`,
        ],
        actions: [
          { id: "keep", label: "Keep shadow memory", tone: "primary", disabled: blocked },
          { id: "discard", label: "Start clean", tone: "secondary", disabled: false },
        ],
      };
    }
    case "closed":
      return { eyebrow: "Promotion", lines: ["Closed."], actions: [] };
  }
}

export function kinPromotionView(widget: KinWidget, card: KinPromotionCard): KinPromotionCardView {
  const title = clamp(card.title, 300) || "Promotion";
  const body =
    widget.closedAt !== null && card.status !== "raised"
      ? { eyebrow: "Promotion", lines: ["Closed."], actions: [] }
      : promotionBody(card);
  const pending = card.status === "raised" && card.shadowMemory === "pending";
  const paths = pending ? (card.shadowChanges?.paths ?? []).map((path) => clamp(path, 200)) : [];
  const ownerReviewed = pending
    ? (card.shadowChanges?.ownerReviewed ?? []).map((path) => clamp(path, 200))
    : [];
  const lines =
    ownerReviewed.length === 0
      ? body.lines
      : [
          ...body.lines,
          "Some of these need your review in a pull request, which Kin can't open yet, so only Start clean is available.",
        ];
  return {
    orgId: widget.orgId,
    agentId: card.agentId,
    revision: widget.revision,
    status: card.status,
    eyebrow: body.eyebrow,
    title,
    lines,
    paths,
    ownerReviewed,
    target: card.stats.to,
    actions: body.actions,
    accessibilityLabel: kinSentences([title, ...lines, ...paths]),
  };
}

export type KinLevelsCardView =
  | { readonly kind: "shadow_review"; readonly review: KinShadowReviewCardView }
  | { readonly kind: "promotion"; readonly promotion: KinPromotionCardView };

/** Null when the widget isn't a levels card this build can read. */
export function kinLevelsCardView(widget: KinWidget): KinLevelsCardView | null {
  if (widget.type === "shadow_review") {
    const card = decodeShadowReview(widget.state);
    return Option.isSome(card)
      ? { kind: "shadow_review", review: kinShadowReviewView(widget, card.value) }
      : null;
  }
  if (widget.type === "promotion") {
    const card = decodePromotion(widget.state);
    return Option.isSome(card)
      ? { kind: "promotion", promotion: kinPromotionView(widget, card.value) }
      : null;
  }
  return null;
}

/** What failed, or null when the command succeeded. */
export function kinLevelsFailure(result: AsyncResult.AsyncResult<unknown, unknown>): unknown {
  return AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null;
}

/** The server writes levels refusals for the owner ("The lead isn't eligible…"), so they show. */
export function kinLevelsFailureText(cause: unknown): string {
  if (!isKinChatError(cause)) return KIN_SEND_FAILED_TEXT;
  switch (cause.reason) {
    case "invalid_state":
    case "not_allowed":
    case "not_found":
    case "limit":
    case "unavailable":
      return clamp(cause.message, 280) || KIN_SEND_FAILED_TEXT;
    default:
      return KIN_SEND_FAILED_TEXT;
  }
}

/** What the card says after an action the server took, until its next revision lands. */
export const KIN_PROMOTION_SENT: Record<KinPromotionActionId, string> = {
  raise: "Raise requested. It applies once you sign the approval.",
  defer: "Put off for a week.",
  keep: "Keeping shadow memory.",
  discard: "Starting clean.",
};

const LEVELS: ReadonlyArray<KinLevel> = ["L0", "L1", "L2", "L3"];
const below = (level: KinLevel) => LEVELS[LEVELS.indexOf(level) - 1] ?? null;
const rank = (level: KinLevel) => LEVELS.indexOf(level);

const RAISE_STATE: Record<KinLevelsView["pendingRaises"][number]["state"], string> = {
  awaiting_approval: "waiting for your signed approval",
  approved: "approved, applying soon",
  executing: "applying now",
};

/** One level change the screen offers: `chatId` null is the lead itself. */
export interface KinLevelChange {
  readonly key: string;
  readonly kind: "raise" | "lower";
  readonly chatId: KinLevelsView["chats"][number]["chatId"] | null;
  readonly level: KinLevel;
  readonly label: string;
  /** Why it is off, when it is. */
  readonly blocked: string | null;
}

export interface KinLevelsRow {
  readonly key: string;
  readonly title: string;
  readonly level: KinLevel;
  readonly since: string;
  readonly changes: ReadonlyArray<KinLevelChange>;
}

export interface KinLevelsScreenView {
  readonly lead: KinLevelsRow;
  readonly trial: ReadonlyArray<string>;
  readonly pending: ReadonlyArray<{ readonly key: string; readonly text: string }>;
  readonly chats: ReadonlyArray<KinLevelsRow>;
}

const sinceFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/**
 * What the owner's Levels screen offers. Lowering applies at once; raising asks for a signed
 * approval, one level at a time for the lead and back up to the lead's level for a chat.
 */
export function kinLevelsScreenView(
  view: KinLevelsView,
  chatTitle: (chatId: string) => string,
): KinLevelsScreenView {
  type ChatId = KinLevelChange["chatId"];
  const raising = (chatId: ChatId) => view.pendingRaises.some((raise) => raise.chatId === chatId);
  const lower = (chatId: ChatId, level: KinLevel): ReadonlyArray<KinLevelChange> => {
    const to = below(level);
    return to === null
      ? []
      : [
          {
            key: `lower:${chatId ?? "lead"}`,
            kind: "lower",
            chatId,
            level: to,
            label: `Lower to ${to}`,
            blocked: null,
          },
        ];
  };
  const leadTo = view.promotion.to;
  const leadRaise: ReadonlyArray<KinLevelChange> =
    leadTo === null
      ? []
      : [
          {
            key: "raise:lead",
            kind: "raise",
            chatId: null,
            level: leadTo,
            label: `Raise to ${leadTo}`,
            blocked: raising(null)
              ? "A raise is already waiting."
              : view.promotion.eligible
                ? null
                : "Not eligible yet.",
          },
        ];
  return {
    lead: {
      key: "lead",
      title: "Lead",
      level: view.level,
      since: `Since ${sinceFormat.format(new Date(view.levelSince))}`,
      changes: [...leadRaise, ...lower(null, view.level)],
    },
    trial: kinTrialLines(view.promotion),
    pending: view.pendingRaises.map((raise) => ({
      key: raise.actionId,
      text: `${raise.chatId === null ? "Lead" : chatTitle(raise.chatId)} to ${raise.level}: ${RAISE_STATE[raise.state]}.`,
    })),
    chats: view.chats.map((chat) => ({
      key: chat.chatId,
      title: chatTitle(chat.chatId),
      level: chat.level,
      since: `Since ${sinceFormat.format(new Date(chat.levelSince))}`,
      changes: [
        ...(rank(chat.level) < rank(view.level)
          ? [
              {
                key: `raise:${chat.chatId}`,
                kind: "raise" as const,
                chatId: chat.chatId,
                level: view.level,
                label: `Raise to ${view.level}`,
                blocked: raising(chat.chatId) ? "A raise is already waiting." : null,
              },
            ]
          : []),
        ...lower(chat.chatId, chat.level),
      ],
    })),
  };
}
