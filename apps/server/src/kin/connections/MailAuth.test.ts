import { describe, expect, it } from "@effect/vitest";

import { exchangeOwn, gmailOwn, oneMailbox, senderCheckOf } from "./MailAuth.ts";

// An invented bank's alert address, and each vendor's own stamp of its checks.
const FROM = "Harbour Trust <alerts@harbourtrust.example>";
const GOOGLE =
  "mx.google.com; dkim=pass header.i=@harbourtrust.example header.s=s1 header.b=abc; spf=pass (google.com: domain of alerts@harbourtrust.example designates 192.0.2.1 as permitted sender) smtp.mailfrom=alerts@harbourtrust.example; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=harbourtrust.example";
const EXCHANGE =
  "spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=harbourtrust.example; dkim=pass (signature was verified) header.d=harbourtrust.example;dmarc=pass action=none header.from=harbourtrust.example;compauth=pass reason=100";
const FORGED = "mx.google.com; dmarc=pass header.from=harbourtrust.example";
const FORGED_EXCHANGE =
  "dmarc=pass action=none header.from=harbourtrust.example;compauth=pass reason=100";

describe("the receiving service's verdict on a sender", () => {
  const vendors = { gmail: gmailOwn, exchange: exchangeOwn } as const;
  it.each([
    ["gmail", "its own pass", [GOOGLE], [FROM], "passed"],
    ["exchange", "its own pass", [EXCHANGE], [FROM], "passed"],
    // The service writes its own on top: a forged one sits below it and is never read.
    [
      "gmail",
      "a forged pass below its own fail",
      [GOOGLE.replace("dmarc=pass", "dmarc=fail"), FORGED],
      [FROM],
      "failed",
    ],
    [
      "exchange",
      "a forged pass below its own fail",
      [EXCHANGE.replace("dmarc=pass", "dmarc=fail"), FORGED_EXCHANGE],
      [FROM],
      "failed",
    ],
    // With the service's own missing, a sender's header in another shape is nobody's word.
    [
      "gmail",
      "only a forged header in another issuer's name",
      ["mx.harbourtrust.example; dmarc=pass header.from=harbourtrust.example"],
      [FROM],
      "not_checked",
    ],
    [
      "exchange",
      "only a forged header in another shape",
      ["mx.harbourtrust.example; dmarc=pass header.from=harbourtrust.example; compauth=pass"],
      [FROM],
      "not_checked",
    ],
    [
      "gmail",
      "another issuer on top",
      ["relay.example.net; dmarc=pass header.from=harbourtrust.example", GOOGLE],
      [FROM],
      "not_checked",
    ],
    [
      "exchange",
      "another issuer on top",
      ["relay.example.net; dmarc=pass header.from=harbourtrust.example", EXCHANGE],
      [FROM],
      "not_checked",
    ],
    ["gmail", "no header at all", [], [FROM], "not_checked"],
    // A pass is for the domain it names; another domain's pass says nothing of this From.
    [
      "gmail",
      "a DMARC pass for an unrelated domain",
      ["mx.google.com; dmarc=pass header.from=elsewhere.example"],
      [FROM],
      "failed",
    ],
    [
      "exchange",
      "a DKIM pass by an unrelated signer",
      ["dkim=pass header.d=elsewhere.example; compauth=pass reason=109"],
      [FROM],
      "not_checked",
    ],
    [
      "gmail",
      "a DKIM pass by a parent domain, no DMARC",
      ["mx.google.com; dkim=pass header.i=@harbourtrust.example"],
      ["alerts@mail.harbourtrust.example"],
      "passed",
    ],
    [
      "gmail",
      "a DKIM pass by a look-alike suffix",
      ["mx.google.com; dkim=pass header.d=trust.example"],
      ["alerts@harbourtrust.example"],
      "not_checked",
    ],
    // Comments are dropped before anything is matched.
    [
      "gmail",
      "dmarc=pass only inside a comment",
      [
        "mx.google.com; dmarc=fail (but dmarc=pass header.from=harbourtrust.example) header.from=harbourtrust.example",
      ],
      [FROM],
      "failed",
    ],
    [
      "gmail",
      "a comment that is all a pass",
      ["mx.google.com; spf=neutral (dmarc=pass header.from=harbourtrust.example)"],
      [FROM],
      "not_checked",
    ],
    // Folded and odd-case headers read the same as one plain line.
    [
      "gmail",
      "folded and odd case",
      [
        "MX.Google.COM;\r\n\tDKIM=pass header.i=@HarbourTrust.example;\r\n DMARC = PASS (p=NONE)\r\n  header.from = HarbourTrust.Example",
      ],
      ["ALERTS@HARBOURTRUST.EXAMPLE"],
      "passed",
    ],
    [
      "exchange",
      "folded and odd case",
      [
        "SPF=pass smtp.mailfrom=harbourtrust.example;\r\n DMARC=Pass action=none\r\n header.FROM=harbourtrust.EXAMPLE;CompAuth=pass reason=100",
      ],
      [FROM],
      "passed",
    ],
    // One From mailbox only.
    [
      "gmail",
      "two From addresses",
      [GOOGLE],
      ["alerts@harbourtrust.example, Rhea <rhea@ambermill.example>"],
      "not_checked",
    ],
    ["gmail", "two From headers", [GOOGLE], [FROM, FROM], "not_checked"],
    [
      "gmail",
      "a quoted display name naming the bank",
      [GOOGLE],
      ['"alerts@harbourtrust.example" <payouts@elsewhere.example>'],
      "failed",
    ],
  ] as const)("%s: %s", (vendor, _name, results, from, verdict) => {
    expect(senderCheckOf(results, from, vendors[vendor]).verdict).toBe(verdict);
  });

  it.each([
    ["Harbour Trust <Alerts@HarbourTrust.example>", "alerts@harbourtrust.example"],
    ["alerts@harbourtrust.example", "alerts@harbourtrust.example"],
    ['"Trust, Harbour (alerts)" <alerts@harbourtrust.example>', "alerts@harbourtrust.example"],
    ["Bank (alerts@harbourtrust.example) <payouts@elsewhere.example>", "payouts@elsewhere.example"],
    ['"<alerts@harbourtrust.example>" <payouts@elsewhere.example>', "payouts@elsewhere.example"],
    ["a@one.example, b@two.example", undefined],
    ["Bank <a@one.example> <b@two.example>", undefined],
    ["Bank: a@one.example;", undefined],
    ["not an address", undefined],
    ["Bank <alerts@harbourtrust.example> trailing", undefined],
  ] as const)("reads %s as one mailbox", (header, address) => {
    expect(oneMailbox(header)).toBe(address);
  });
});
