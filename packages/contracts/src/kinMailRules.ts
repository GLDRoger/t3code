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
type KinMailRuleSender = KinMailRuleMatch["from"][number];

/** A kind of mail in words, as a rule's line and page say it. */
export const KIN_MAIL_RULE_CLASS_NAMES: Readonly<Record<typeof KinMailRuleClass.Type, string>> = {
  reply_to_us: "replies to mail we sent",
  names_money: "mail that names one of our invoices or quotes",
  client: "mail from a known contact",
  known_biller: "mail from a sender whose bill was filed before",
  automated_notice: "automated notices",
  automated_file: "automated mail with a file",
  automated: "newsletters and other automated mail",
  copied: "mail this mailbox was copied on",
  unknown_person: "mail from someone Kin doesn't know yet",
  other: "mail no other kind fits",
};

/** "a", "a or b", "a, b or c". */
const orList = (items: ReadonlyArray<string>) =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// RFC 3492 Punycode for one label, so a look-alike domain shows what it really is.
const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const punyDigit = (d: number) => String.fromCharCode(d < 26 ? 97 + d : 22 + d);
const adapt = (delta: number, points: number, first: boolean) => {
  let next = first ? Math.floor(delta / DAMP) : delta >> 1;
  next += Math.floor(next / points);
  let k = 0;
  while (next > ((BASE - T_MIN) * T_MAX) >> 1) {
    next = Math.floor(next / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * next) / (next + SKEW));
};
const punyLabel = (label: string) => {
  const points = Array.from(label, (char) => char.codePointAt(0) ?? 0);
  if (points.every((point) => point < 0x80)) return label;
  let out = points
    .filter((point) => point < 0x80)
    .map((point) => String.fromCodePoint(point))
    .join("");
  const basic = out.length;
  if (basic > 0) out += "-";
  let n = 0x80;
  let delta = 0;
  let bias = 72;
  let handled = basic;
  while (handled < points.length) {
    const m = Math.min(...points.filter((point) => point >= n));
    delta += (m - n) * (handled + 1);
    n = m;
    for (const point of points) {
      if (point < n) delta += 1;
      if (point !== n) continue;
      let q = delta;
      for (let k = BASE; ; k += BASE) {
        const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
        if (q < t) break;
        out += punyDigit(t + ((q - t) % (BASE - t)));
        q = Math.floor((q - t) / (BASE - t));
      }
      out += punyDigit(q);
      bias = adapt(delta, handled + 1, handled === basic);
      delta = 0;
      handled += 1;
    }
    delta += 1;
    n += 1;
  }
  return `xn--${out}`;
};

/** A domain as the mail system compares it: lower case, each label in punycode. */
export function kinMailRuleAscii(domain: string): string {
  return domain.trim().normalize("NFC").toLowerCase().split(".").map(punyLabel).join(".");
}

/**
 * One sender filter in words; one whose ASCII spelling differs shows it beside it. `ascii` is the
 * spelling the host sent, when it sent one; otherwise this device works it out.
 */
export function kinMailRuleSenderWords(sender: KinMailRuleSender, ascii?: string): string {
  if (sender.address !== undefined) {
    const at = sender.address.lastIndexOf("@");
    const domain = at === -1 ? "" : sender.address.slice(at + 1);
    if (ascii !== undefined)
      return ascii === sender.address.toLowerCase()
        ? sender.address
        : `${sender.address} (${ascii})`;
    const own = kinMailRuleAscii(domain);
    return own === domain.toLowerCase() ? sender.address : `${sender.address} (${own})`;
  }
  const spelt = ascii ?? kinMailRuleAscii(sender.domain);
  return spelt === sender.domain.toLowerCase() ? sender.domain : `${sender.domain} (${spelt})`;
}

const quoted = (phrases: ReadonlyArray<string>) => orList(phrases.map((phrase) => `“${phrase}”`));

/** What a rule matches, in one plain line: "From junipercold.example, with a file". */
export function kinMailRuleMatchLine(
  match: KinMailRuleMatch | null,
  /** The host's ASCII spelling of each From filter, in the same order (a proposal card's). */
  fromAscii?: ReadonlyArray<string>,
): string {
  if (match === null) return "Changed outside Kin";
  const senders = match.from.map((sender, index) =>
    kinMailRuleSenderWords(sender, fromAscii?.[index]),
  );
  const parts = [
    ...(senders.length === 0 ? [] : [`From ${orList(senders)}`]),
    ...(match.subjectHas.length === 0 ? [] : [`subject has ${quoted(match.subjectHas)}`]),
    ...(match.withFile === true ? ["with a file"] : []),
    ...(match.classes === null
      ? []
      : [`only ${orList(match.classes.map((one) => KIN_MAIL_RULE_CLASS_NAMES[one]))}`]),
  ];
  return parts.length === 0 ? "Any mail to this mailbox" : capitalize(parts.join(", "));
}

const mailbox = { orgId: KinOrgId, connectionId: id };
const draft = { ...mailbox, match: KinMailRuleMatch, monthlyCap: Schema.optional(cap) };
const destination = { agentId: KinAgentId, chatId: KinChatId, tapId: id };

export const KinMailRuleCreateInput = Schema.Struct({
  ...draft,
  ...destination,
  what: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
});
export type KinMailRuleCreateInput = typeof KinMailRuleCreateInput.Type;

export const KIN_MAIL_RULE_CARD_TYPE = "mail_rule";
export const KIN_MAIL_RULE_CARD_ACTIONS = ["turn_on", "not_now"] as const;
export const KinMailRuleCardState = Schema.Struct({
  mailbox: Schema.Struct({ connectionId: id, label: Schema.String }),
  lead: Schema.Struct({ agentId: KinAgentId, name: Schema.String }),
  match: KinMailRuleMatch,
  /** ASCII spellings of the From filters, in the same order, for showing internationalized domains. */
  fromAscii: Schema.Array(Schema.String),
  what: KinMailRuleCreateInput.fields.what,
  monthlyCap: cap,
  contentSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  expiresAt: Schema.Int,
  decision: Schema.Union([
    Schema.Struct({ status: Schema.Literal("proposed") }),
    Schema.Struct({ status: Schema.Literal("on"), ruleId: id }),
    Schema.Struct({ status: Schema.Literal("dismissed") }),
    // A later proposal for the same filters took its place before either was tapped.
    Schema.Struct({ status: Schema.Literal("replaced") }),
  ]),
});
export type KinMailRuleCardState = typeof KinMailRuleCardState.Type;

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
export const KinMailRuleHoldReason = Schema.Literals([
  "paused",
  "removed",
  "setter_left",
  "mailbox_unavailable",
  "destination_unavailable",
  "setter_demoted",
  "wording_changed",
  "monthly_limit",
  "sender_unverified",
]);
export type KinMailRuleHoldReason = typeof KinMailRuleHoldReason.Type;

const historyRow = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("mail"),
    ...mail,
    noticedAt: time,
    state: Schema.Literals(["woke", "batched", "held_cap", "held_unverified", "held_paused"]),
    outcome: Schema.NullOr(Schema.Literals(["draft", "task", "filed", "nothing"])),
    holdReason: Schema.optional(Schema.NullOr(KinMailRuleHoldReason)),
    runOutcome: Schema.optional(
      Schema.NullOr(Schema.Literals(["posted_message", "raised_card", "nothing", "held"])),
    ),
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
  Schema.Struct({ status: Schema.Literal("queued"), arrivalId: id, eventId: id }),
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
