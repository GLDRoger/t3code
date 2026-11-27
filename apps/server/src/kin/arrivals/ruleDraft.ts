import {
  KinChatError,
  KinMailRuleMatch,
  type KinAgentId,
  type KinChatId,
  type KinMailRuleCreateInput,
  type KinOrgId,
  type KinPersonId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { companyRuleMailbox, directRuleLead, ruleSetter } from "./ruleAccess.ts";
import { mailRuleContentHash } from "./ruleContent.ts";
import { mailRuleFilter, mailRuleMatchProblem, mailRulePhrase } from "./ruleMatch.ts";

export const DEFAULT_MAIL_RULE_CAP = 30;
export const mailRuleMatchJson = Schema.fromJsonString(KinMailRuleMatch);
const encodeMatch = Schema.encodeEffect(mailRuleMatchJson);

export const mailRuleOwnerOnly = new KinChatError({
  reason: "not_allowed",
  message: "Only the owner or a co-owner can manage mail rules.",
});
export const badMailRule = new KinChatError({
  reason: "invalid_state",
  message: "Check the sender filters, subject words, instruction and monthly limit.",
});
const noMailbox = new KinChatError({
  reason: "invalid_state",
  message: "Choose a connected company mailbox.",
});
const noLead = new KinChatError({
  reason: "invalid_state",
  message: "Choose an active lead and your direct chat with that lead.",
});

const matchProblem = {
  public_suffix: "Use a company domain, such as junipercold.example, instead of a public suffix.",
  mixed_scripts: "Use a sender domain whose labels do not mix Latin, Cyrillic or Greek letters.",
  invalid_sender: "Use a valid sender address or domain.",
  invalid_phrase: "Use subject phrases that have 2 to 60 characters after normalization.",
} as const;

export const prepareMailRule = Effect.fn("KinMailRules.prepareDraft")(function* (
  input: Pick<KinMailRuleCreateInput, "match" | "what" | "monthlyCap">,
) {
  if (input.what.trim() === "") return yield* badMailRule;
  const problem = mailRuleMatchProblem(input.match);
  if (problem !== undefined)
    return yield* new KinChatError({ reason: "invalid_state", message: matchProblem[problem] });
  const matchJson = yield* encodeMatch(input.match).pipe(Effect.mapError(() => badMailRule));
  return {
    matchJson,
    contentSha256: mailRuleContentHash(matchJson, input.what),
    monthlyCap: input.monthlyCap ?? DEFAULT_MAIL_RULE_CAP,
  };
});

export const mailRuleMatchKey = (match: KinMailRuleMatch) => {
  const sorted = (values: ReadonlyArray<string>) => [...new Set(values)].toSorted();
  return mailRuleContentHash(
    JSON.stringify({
      from: sorted(match.from.flatMap((sender) => mailRuleFilter(sender).spelling ?? [])),
      subjectHas: sorted(match.subjectHas.map(mailRulePhrase)),
      withFile: match.withFile,
      classes: match.classes === null ? null : sorted(match.classes),
    }),
    "",
  );
};

export const checkMailRuleOwner = Effect.fn("KinMailRules.stillOwner")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  if (!(yield* ruleSetter(orgId, personId))?.owner) return yield* mailRuleOwnerOnly;
});

export const companyMailRuleMailbox = Effect.fn("KinMailRules.draftMailbox")(function* (
  orgId: KinOrgId,
  connectionId: string,
) {
  const mailbox = yield* companyRuleMailbox(orgId, connectionId);
  return mailbox ?? (yield* noMailbox);
});

export const mailRuleDirectLead = Effect.fn("KinMailRules.draftLead")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  agentId: KinAgentId,
  chatId: KinChatId,
) {
  const lead = yield* directRuleLead(orgId, personId, agentId, chatId);
  return lead ?? (yield* noLead);
});
