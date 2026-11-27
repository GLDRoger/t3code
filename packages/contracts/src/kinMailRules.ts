import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthKinChatScope, EnvironmentAuthorizationError } from "./auth.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinAgentId, KinChatError, KinChatId, KinOrgId, KinPersonId } from "./kinChat.ts";

const id = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
const sender = TrimmedNonEmptyString.check(Schema.isMaxLength(320));
const phrase = Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(60));
const cap = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }));
const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const time = Schema.Int;
const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);

export const KinMailRuleClass = Schema.Literals([
  "reply_to_us",
  "names_money",
  "client",
  "known_biller",
  "automated_notice",
  "automated_file",
  "automated",
  "copied",
  "unknown_person",
  "other",
]);

export const KinMailRuleMatch = Schema.Struct({
  from: Schema.Array(
    Schema.Union([
      Schema.Struct({ address: sender, domain: Schema.optional(Schema.Never) }),
      Schema.Struct({ domain: sender, address: Schema.optional(Schema.Never) }),
    ]),
  ).check(Schema.isMaxLength(50)),
  subjectHas: Schema.Array(phrase).check(Schema.isMaxLength(5)),
  withFile: Schema.NullOr(Schema.Literal(true)),
  classes: Schema.NullOr(Schema.Array(KinMailRuleClass).check(Schema.isMinLength(1))),
});
export type KinMailRuleMatch = typeof KinMailRuleMatch.Type;

const mailbox = { orgId: KinOrgId, connectionId: id };
const draft = { ...mailbox, match: KinMailRuleMatch, monthlyCap: Schema.optional(cap) };
const destination = { agentId: KinAgentId, chatId: KinChatId, tapId: id };

export const KinMailRuleCreateInput = Schema.Struct({
  ...draft,
  ...destination,
  what: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
});
export type KinMailRuleCreateInput = typeof KinMailRuleCreateInput.Type;

export const KinMailRuleRef = Schema.Struct({ orgId: KinOrgId, ruleId: id });
export type KinMailRuleRef = typeof KinMailRuleRef.Type;

export const KinMailRuleResumeInput = Schema.Struct({ ...KinMailRuleRef.fields, ...destination });
export type KinMailRuleResumeInput = typeof KinMailRuleResumeInput.Type;

export const KinMailRulesListInput = Schema.Struct({
  orgId: KinOrgId,
  connectionId: Schema.optional(id),
});
export type KinMailRulesListInput = typeof KinMailRulesListInput.Type;

export const KinMailRulePreviewInput = Schema.Union([KinMailRuleRef, Schema.Struct(draft)]);
export type KinMailRulePreviewInput = typeof KinMailRulePreviewInput.Type;

export const KinMailRule = Schema.Struct({
  ...mailbox,
  ruleId: id,
  /** Null when the stored words or filters no longer hash to what was tapped; such a rule never runs. */
  match: Schema.NullOr(KinMailRuleMatch),
  wordingChanged: Schema.Boolean,
  what: KinMailRuleCreateInput.fields.what,
  agentId: KinAgentId,
  chatId: KinChatId,
  saidBy: KinPersonId,
  setterName: Schema.String,
  state: Schema.Literals(["proposed", "on", "paused", "removed"]),
  pausedWhy: Schema.NullOr(Schema.Literals(["person", "left", "mailbox", "agent"])),
  monthlyCap: cap,
  month: Schema.String,
  fired: count,
  atLimit: Schema.Boolean,
  lastWakeAt: Schema.NullOr(time),
  createdAt: time,
  updatedAt: time,
});
export type KinMailRule = typeof KinMailRule.Type;

const mail = {
  arrivalId: id,
  fromAddress: Schema.NullOr(Schema.String),
  receivedAt: Schema.NullOr(time),
};
const historyRow = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("mail"),
    ...mail,
    noticedAt: time,
    state: Schema.Literals(["woke", "batched", "held_cap", "held_unverified", "held_paused"]),
    outcome: Schema.NullOr(Schema.Literals(["draft", "task", "filed", "nothing"])),
    eventId: Schema.NullOr(id),
    wakeupId: Schema.NullOr(id),
    settledAt: Schema.NullOr(time),
    refs: Schema.NullOr(Schema.Json),
  }),
  Schema.Struct({ kind: Schema.Literal("gap"), arrivalId: id, from: time, to: time }),
]);
export const KinMailRuleHistory = Schema.Struct({ entries: Schema.Array(historyRow) });
export type KinMailRuleHistory = typeof KinMailRuleHistory.Type;

export const KinMailRulePreview = Schema.Struct({
  matches: Schema.Array(
    Schema.Struct({
      ...mail,
      subject: Schema.NullOr(Schema.String),
      state: Schema.Literals(["match", "held_cap", "held_unverified"]),
    }),
  ),
  subjectCheckLimit: Schema.NullOr(Schema.Literal(200)),
  partial: Schema.Boolean,
});
export type KinMailRulePreview = typeof KinMailRulePreview.Type;

export const KinMailRuleRunNow = Schema.Union([
  Schema.Struct({ status: Schema.Literal("no_match"), message: Schema.String }),
  Schema.Struct({ status: Schema.Literal("not_yet"), arrivalId: id, message: Schema.String }),
]);
export type KinMailRuleRunNow = typeof KinMailRuleRunNow.Type;

export const KinMailRuleRpcs = [
  Rpc.make("kin.mailRules.create", {
    payload: KinMailRuleCreateInput,
    success: KinMailRule,
    error,
  }),
  Rpc.make("kin.mailRules.pause", { payload: KinMailRuleRef, success: KinMailRule, error }),
  Rpc.make("kin.mailRules.resume", {
    payload: KinMailRuleResumeInput,
    success: KinMailRule,
    error,
  }),
  Rpc.make("kin.mailRules.remove", { payload: KinMailRuleRef, success: KinMailRule, error }),
  Rpc.make("kin.mailRules.list", {
    payload: KinMailRulesListInput,
    success: Schema.Struct({ rules: Schema.Array(KinMailRule) }),
    error,
  }),
  Rpc.make("kin.mailRules.history", {
    payload: KinMailRuleRef,
    success: KinMailRuleHistory,
    error,
  }),
  Rpc.make("kin.mailRules.preview", {
    payload: KinMailRulePreviewInput,
    success: KinMailRulePreview,
    error,
  }),
  Rpc.make("kin.mailRules.runNow", { payload: KinMailRuleRef, success: KinMailRuleRunNow, error }),
] as const;

export const KIN_MAIL_RULE_RPC_SCOPES = {
  "kin.mailRules.create": AuthKinChatScope,
  "kin.mailRules.pause": AuthKinChatScope,
  "kin.mailRules.resume": AuthKinChatScope,
  "kin.mailRules.remove": AuthKinChatScope,
  "kin.mailRules.list": AuthKinChatScope,
  "kin.mailRules.history": AuthKinChatScope,
  "kin.mailRules.preview": AuthKinChatScope,
  "kin.mailRules.runNow": AuthKinChatScope,
} as const satisfies Record<(typeof KinMailRuleRpcs)[number]["_tag"], typeof AuthKinChatScope>;
