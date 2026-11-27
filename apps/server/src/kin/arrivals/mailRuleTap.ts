import { KinChatError, KinMailRuleCardState } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { MailRuleTapHandler } from "../chat/KinChatService.ts";
import { planFor } from "../widgets/cardPlans.ts";
import { KinMailRules } from "./KinMailRules.ts";
import {
  checkMailRuleOwner,
  companyMailRuleMailbox,
  mailRuleDirectLead,
  prepareMailRule,
} from "./ruleDraft.ts";
import { mailRuleFilter } from "./ruleMatch.ts";

const decodeCard = Schema.decodeUnknownEffect(KinMailRuleCardState);
const decodeCardOption = Schema.decodeUnknownOption(KinMailRuleCardState);
const changed = new KinChatError({
  reason: "widget_changed",
  message: "This mail rule card no longer matches what Kin showed, so nothing was turned on.",
});
const stale = new KinChatError({
  reason: "widget_changed",
  message: "This mail rule card has changed, so open the latest card.",
});

export const mailRuleTap = Effect.fn("KinMailRules.answerCard")(function* ({
  identity,
  widget,
  revision,
  action,
  tapId,
}: Parameters<MailRuleTapHandler>[0]) {
  const { orgId, personId } = identity;
  yield* checkMailRuleOwner(orgId, personId).pipe(
    Effect.catchTags({
      KinChatError: () =>
        new KinChatError({
          reason: "not_allowed",
          message: "Only the owner or a co-owner can answer this mail rule card.",
        }),
    }),
  );
  const seal = (yield* planFor({
    orgId,
    chatId: widget.chatId,
    widgetId: widget.widgetId,
    optionId: "turn_on",
  }))?.plan;
  if (seal?.kind !== "mail_rule") return yield* changed;
  if (seal.personId !== personId)
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Only the person this mail rule card was drawn for can answer it.",
    });
  if (widget.closedAt !== null)
    return yield* Option.getOrUndefined(decodeCardOption(widget.state))?.decision.status ===
    "replaced"
      ? new KinChatError({
          reason: "widget_changed",
          message: "A newer mail rule card replaced this one, so nothing was turned on.",
        })
      : new KinChatError({
          reason: "widget_changed",
          message: "This mail rule card was already answered.",
        });
  if (widget.revision !== revision) return yield* stale;
  if ((yield* Clock.currentTimeMillis) >= seal.shown.expiresAt)
    return yield* new KinChatError({
      reason: "widget_changed",
      message: "This mail rule card has expired, so ask for a new one.",
    });
  const state = yield* decodeCard(widget.state).pipe(Effect.mapError(() => changed));
  const { mailbox, lead, what, match, monthlyCap } = state;
  const { shown } = seal;
  const prepared = yield* prepareMailRule(state).pipe(Effect.mapError(() => changed));
  if (
    state.decision.status !== "proposed" ||
    state.contentSha256 !== shown.contentSha256 ||
    prepared.contentSha256 !== shown.contentSha256 ||
    monthlyCap !== shown.monthlyCap ||
    state.expiresAt !== shown.expiresAt ||
    mailbox.connectionId !== shown.mailbox.connectionId ||
    mailbox.label !== shown.mailbox.label ||
    lead.agentId !== shown.lead.agentId ||
    lead.name !== shown.lead.name ||
    state.fromAscii.length !== match.from.length ||
    !match.from.every((sender, index) => mailRuleFilter(sender).spelling === state.fromAscii[index])
  )
    return yield* changed;
  // Not now is the safe direction, so it stays open after the mailbox or lead went away.
  if (action === "not_now")
    return { ...state, decision: { status: "dismissed" } } satisfies KinMailRuleCardState;
  const currentMailbox = yield* companyMailRuleMailbox(orgId, mailbox.connectionId).pipe(
    Effect.catchTags({
      KinChatError: () =>
        new KinChatError({
          reason: "invalid_state",
          message:
            "This mailbox is no longer a connected company mailbox, so nothing was turned on.",
        }),
    }),
  );
  const destination = yield* mailRuleDirectLead(orgId, personId, lead.agentId, widget.chatId).pipe(
    Effect.catchTags({
      KinChatError: () =>
        new KinChatError({
          reason: "invalid_state",
          message:
            "The lead or chat on this mail rule card is no longer available, so nothing was turned on.",
        }),
    }),
  );
  // A rename draws no later card, so the person needs a new proposal, not the latest card.
  if (currentMailbox.label !== mailbox.label || destination.name !== lead.name)
    return yield* new KinChatError({
      reason: "widget_changed",
      message:
        "This mail rule card shows an old name for its mailbox or lead, so ask for a new one.",
    });
  const service = yield* KinMailRules;
  const rule = yield* service.createFromTap(
    [identity],
    {
      orgId,
      connectionId: mailbox.connectionId,
      agentId: lead.agentId,
      chatId: widget.chatId,
      match,
      what,
      monthlyCap,
      tapId,
    },
    shown.contentSha256,
  );
  return {
    ...state,
    decision: { status: "on", ruleId: rule.ruleId },
  } satisfies KinMailRuleCardState;
});
