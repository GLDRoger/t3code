import { assert, describe, it } from "@effect/vitest";

import { type ArrivalHeaders, type ArrivalRows, classify } from "./classify.ts";

const rows: ArrivalRows = {
  own: new Set(["hello@ambermill.example", "accounts@ambermill.example", "rhea@ambermill.example"]),
  sentThreads: new Map([["t-sent", "agent-growth"]]),
  contacts: new Map([
    [
      "ana@lumen.example",
      {
        key: "CT-1",
        title: "Ana Okafor",
        clientId: "rec_lumen",
        clientKey: "C-1",
        clientTitle: "Lumen Studio",
      },
    ],
  ]),
  money: [
    { key: "INV-4", list: "invoices", number: "INV/26-27/004", unique: true },
    { key: "QUO-12", list: "quotes", number: "2026-17", unique: false },
  ],
  billers: new Set(["billing@inkspot.example"]),
};

const mail = (from: string, more: Partial<ArrivalHeaders> = {}): ArrivalHeaders => ({
  threadId: "t-1",
  from,
  fromAddress: /<([^>]+)>/.exec(from)?.[1] ?? from,
  to: ["hello@ambermill.example"],
  cc: [],
  subject: "Hello",
  authResults: [],
  listUnsubscribe: false,
  precedence: null,
  autoSubmitted: null,
  bulk: false,
  hasFile: false,
  ...more,
});

describe("classify", () => {
  it("decides each class from headers and Kin's rows, first rule first", () => {
    const cases: ReadonlyArray<[string, ArrivalHeaders, string, string | undefined, string?]> = [
      ["a: our own address", mail("Rhea <rhea@ambermill.example>"), "own", undefined],
      [
        "b: a sign-in code, even from a client",
        mail("ana@lumen.example", { subject: "Your verification code is 123456" }),
        "sign_in",
        undefined,
      ],
      [
        "c: a reply in a thread we sent in",
        mail("no-reply@else.example", { threadId: "t-sent", subject: "Invoice overdue" }),
        "reply_to_us",
        "agent-growth",
      ],
      [
        "d: a client's address that fails DMARC is a stranger, even naming an invoice",
        mail("Ana <ana@lumen.example>", {
          subject: "INV-4: new bank details",
          authResults: ["mx.example; dmarc=fail (p=reject) header.from=lumen.example"],
        }),
        "failed_checks",
        "chief",
      ],
      [
        "e: names an open invoice by key",
        mail("no-reply@other.example", { subject: "INV-4 for October is overdue" }),
        "names_money",
        "finance",
      ],
      [
        "e: names it by its issued number",
        mail("accounts@other.example", { subject: "Invoice INV/26-27/004 paid" }),
        "names_money",
        "finance",
      ],
      [
        "e: a number two entries show is not guessed",
        mail("accounts@other.example", { subject: "Re: 2026-17", to: [] }),
        "other",
        undefined,
      ],
      [
        "f: a client contact, in any language",
        mail("Ana <ana@lumen.example>", {
          subject: "Пожалуйста, перенесите встречу на четверг",
          authResults: ["mx.example; dkim=pass; spf=pass; dmarc=pass"],
        }),
        "client",
        "chief",
      ],
      [
        "g: a sender whose bill was filed before",
        mail("billing@inkspot.example", { listUnsubscribe: true, subject: "Invoice overdue" }),
        "known_biller",
        "finance",
      ],
      [
        "f: a known contact even on automated overdue mail",
        mail("ana@lumen.example", { autoSubmitted: "auto-generated", subject: "Invoice overdue" }),
        "client",
        "chief",
      ],
      [
        "h: payment failed",
        mail("no-reply@services.example", { subject: "Payment failed for your subscription" }),
        "automated_notice",
        "chief",
        "failed",
      ],
      [
        "h: the first phrase or word supplies the reason, even with a file",
        mail("alerts@bank.example", { subject: "Your NACH mandate has bounced", hasFile: true }),
        "automated_notice",
        "finance",
        "mandate",
      ],
      [
        "h: final notice",
        mail("no-reply@utility.example", { subject: "Final notice: disconnection of service" }),
        "automated_notice",
        "chief",
        "Final notice",
      ],
      [
        "h: overdue from a sender automated by headers",
        mail("billing@utility.example", {
          subject: "Invoice overdue",
          autoSubmitted: "auto-generated",
        }),
        "automated_notice",
        "finance",
        "overdue",
      ],
      [
        "h: a partial word isn't a notice",
        mail("alerts@utility.example", { subject: "unfailed, failedx and préfailed" }),
        "automated",
        undefined,
      ],
      [
        "h: automated mail with a file",
        mail("no-reply@printshop.example", { subject: "Your receipt", hasFile: true }),
        "automated_file",
        undefined,
      ],
      [
        "h: automated mail without one",
        mail("Design Weekly <news@designweekly.example>", {
          listUnsubscribe: true,
          subject: "Big sale ends tonight",
        }),
        "automated",
        undefined,
      ],
      [
        "h: bulk by precedence",
        mail("team@club.example", { precedence: "bulk" }),
        "automated",
        undefined,
      ],
      [
        "h: auto-submitted, but not `no`",
        mail("robot@ci.example", { autoSubmitted: "auto-generated" }),
        "automated",
        undefined,
      ],
      [
        "h: a person can write about an overdue invoice",
        mail("zoya@studio-nine.example", { autoSubmitted: "no", subject: "Invoice overdue" }),
        "unknown_person",
        "chief",
      ],
      [
        "i: our addresses only in Cc",
        mail("dev@partner.example", {
          to: ["meera@partner.example"],
          cc: ["hello@ambermill.example"],
        }),
        "copied",
        undefined,
      ],
      [
        "j: a person writing to us directly",
        mail("Meera Iyer <meera@lumengrove.example>", {
          subject: "क्या आप छोटे स्टूडियो के लिए काम करते हैं?",
        }),
        "unknown_person",
        "chief",
      ],
      [
        "j: someone at our own domain isn't a stranger",
        mail("arjun@ambermill.example"),
        "other",
        undefined,
      ],
      [
        "k: nothing matched (only Bcc'd)",
        mail("dev@partner.example", { to: ["meera@partner.example"] }),
        "other",
        undefined,
      ],
    ];
    for (const [name, headers, expected, by, match] of cases) {
      const found = classify(headers, rows);
      assert.strictEqual(found.class, expected, name);
      const look = found.look?.by;
      assert.strictEqual(typeof look === "object" ? look.agentId : look, by, name);
      assert.isAtMost(found.reason.length, 200, name);
      if (match !== undefined) {
        assert.strictEqual(found.reason, `automated mail whose subject says “${match}”`, name);
        assert.strictEqual(found.look?.matched, found.reason, name);
      }
    }
    // The client's mail is contact with that client; a forged one is not.
    assert.strictEqual(classify(cases[7]![1], rows).look?.clientId, "rec_lumen");
    assert.isUndefined(classify(cases[3]![1], rows).look?.clientId);
    assert.strictEqual(
      classify(cases[3]![1], rows).reason,
      "This mail failed the sender checks for ana@lumen.example.",
    );
  });
});
