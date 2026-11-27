// @effect-diagnostics nodeBuiltinImport:off -- Node's IDNA conversion is pure.
import * as NodeURL from "node:url";

import type { MailArrival } from "../connections/MailProvider.ts";
import { senderCheck } from "../connections/MailText.ts";
import type { ArrivalClass } from "./classify.ts";

export type MailRuleFilters = {
  readonly from: ReadonlyArray<{ readonly address: string } | { readonly domain: string }>;
  readonly subjectHas: ReadonlyArray<string>;
  readonly withFile: true | null;
  readonly classes: ReadonlyArray<ArrivalClass> | null;
};

type SenderCheck = ReturnType<typeof senderCheck>;
type Facts = {
  readonly connectionId: string;
  readonly fromAddress: string | null;
  readonly class: string | null;
  readonly hasFile: boolean | null;
  readonly senderCheck: SenderCheck | null;
  readonly subject?: string;
};

export const mailRuleDomain = (value: string) => {
  const name = value.trim().toLowerCase();
  if (!/^[\p{L}\p{M}\p{N}.\u3002\uff0e\uff61-]+$/u.test(name)) return null;
  const ascii = NodeURL.domainToASCII(name).replace(/\.$/, "");
  return ascii.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      ascii,
    ) &&
    /[a-z]/.test(ascii.slice(ascii.lastIndexOf(".") + 1))
    ? ascii
    : null;
};

export const mailRuleAddress = (value: string) => {
  const found = /^([^\s<>@,;"()\\]+)@([^\s<>@,;"()\\]+)$/.exec(value.trim().toLowerCase());
  if (found === null) return null;
  const domain = mailRuleDomain(found[2]!);
  return domain === null ? null : `${found[1]}@${domain}`;
};

export const mailRulePhrase = (text: string) =>
  text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const excluded = new Set<string>(["own", "sign_in", "failed_checks"]);

export const mailRuleHeaderFacts = (
  mail: Pick<MailArrival, "from" | "fromAddress" | "hasFile" | "authResults">,
): Pick<Facts, "fromAddress" | "hasFile" | "senderCheck"> => {
  // A provider's loose address parser can mistake a quoted display name for an address.
  const raw = mail.from?.trim();
  const angle = /<([^<>]+)>$/.exec(raw ?? "");
  const fromAddress =
    angle !== null
      ? mailRuleAddress(angle[1]!)
      : raw !== undefined && raw.includes("@")
        ? mailRuleAddress(raw)
        : mailRuleAddress(mail.fromAddress ?? "");
  const checked: SenderCheck = senderCheck(mail.authResults);
  return {
    fromAddress,
    hasFile: mail.hasFile,
    senderCheck:
      checked === "not checked" &&
      /\b(?:spf|dkim)=(?:fail|softfail)\b/i.test(mail.authResults.join(";"))
        ? ("failed" as const)
        : checked,
  };
};

export const matchMailRule = (
  rule: MailRuleFilters & { readonly connectionId: string },
  mail: Facts,
  options?: { readonly subject?: "defer"; readonly senderCheck?: "manual" },
): "match" | "held_unverified" | "no_match" => {
  if (
    rule.connectionId !== mail.connectionId ||
    mail.class === null ||
    excluded.has(mail.class) ||
    (rule.classes !== null && !rule.classes.some((kind) => kind === mail.class)) ||
    (rule.withFile === true && mail.hasFile !== true)
  )
    return "no_match";
  if (rule.from.length > 0) {
    const address = mailRuleAddress(mail.fromAddress ?? "");
    if (address === null) return "no_match";
    const domain = address.slice(address.lastIndexOf("@") + 1);
    if (
      !rule.from.some((sender) => {
        if ("address" in sender) return mailRuleAddress(sender.address) === address;
        const expected = mailRuleDomain(sender.domain);
        return expected !== null && (domain === expected || domain.endsWith(`.${expected}`));
      })
    )
      return "no_match";
  }
  if (
    options?.subject !== "defer" &&
    rule.subjectHas.length > 0 &&
    (mail.subject === undefined ||
      !rule.subjectHas.some((filter) => {
        const phrase = mailRulePhrase(filter);
        return (
          phrase.length >= 2 &&
          phrase.length <= 60 &&
          new RegExp(
            `(?<![\\p{L}\\p{M}\\p{N}_])${escape(phrase)}(?![\\p{L}\\p{M}\\p{N}_])`,
            "u",
          ).test(mailRulePhrase(mail.subject!))
        );
      }))
  )
    return "no_match";
  if (
    options?.senderCheck !== "manual" &&
    (mail.senderCheck === "failed" || (rule.from.length > 0 && mail.senderCheck !== "passed"))
  )
    return "held_unverified";
  return "match";
};
