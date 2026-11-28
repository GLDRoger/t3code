import { assert, describe, it } from "@effect/vitest";

import { type ArrivalHeaders, type ArrivalRows, classify, isAutomatedNotice } from "./classify.ts";

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
    [
      "billing@lumen.example",
      {
        key: "CT-2",
        title: "Lumen Billing",
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
          authResults: ["mx.google.com; dmarc=pass (p=REJECT) header.from=lumen.example"],
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
        "automated_notice",
        undefined,
      ],
      [
        "h: auto-submitted, but not `no`",
        mail("robot@ci.example", { autoSubmitted: "auto-generated" }),
        "automated_notice",
        undefined,
      ],
      [
        "h: a person can write about an overdue invoice",
        mail("zoya@studio-nine.example", { autoSubmitted: "no", subject: "Invoice overdue" }),
        "unknown_person",
        "chief",
      ],
      [
        "f: a billing address registered as a client contact",
        mail("billing@lumen.example"),
        "client",
        "chief",
      ],
      [
        "h: a receipt sender with no automation headers",
        mail("receipts@shop.example", { subject: "Your receipt from Shop" }),
        "automated",
        undefined,
      ],
      [
        "h: a billing sender reports a declined card",
        mail("billing@vendor.example", { subject: "Card declined for your plan" }),
        "automated_notice",
        "finance",
        "declined",
      ],
      [
        "h: a billing sender reports a failed payment",
        mail("billing@vendor.example", { subject: "Payment failed for your plan" }),
        "automated_notice",
        "chief",
        "failed",
      ],
      [
        "h: an order sender with a file",
        mail("orders@shop.example", { hasFile: true }),
        "automated_file",
        undefined,
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
        "b: digits before sign-in code",
        mail("arjun@studio-nine.example", { subject: "482913 is your sign-in code" }),
        "sign_in",
        undefined,
      ],
      [
        "b: digits before passcode",
        mail("arjun@studio-nine.example", { subject: "482913 is your passcode" }),
        "sign_in",
        undefined,
      ],
      [
        "b: digits after code",
        mail("arjun@studio-nine.example", { subject: "Your code: 482913" }),
        "sign_in",
        undefined,
      ],
      [
        "j: an invoice number far from the word code",
        mail("arjun@studio-nine.example", { subject: "Invoice 4821 for the March code review" }),
        "unknown_person",
        "chief",
      ],
      [
        "j: digits in a hyphenated project identifier",
        mail("arjun@studio-nine.example", { subject: "Project PIN-2041 kickoff" }),
        "unknown_person",
        "chief",
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

  it.each([
    [
      "a pass in the bounce address before the receiver's failure",
      [
        "mx.google.com; spf=pass (dmarc=pass+header.from=lumen.example@else.example); dmarc=fail header.from=lumen.example",
      ],
    ],
    [
      "a pass inside a quoted property before the receiver's failure",
      [
        'mx.google.com; spf=pass smtp.mailfrom="fixture; dmarc=pass header.from=lumen.example"; dmarc=fail header.from=lumen.example',
      ],
    ],
    [
      "a lower header claims DMARC passed but the receiver has only an SPF softfail",
      ["mx.google.com; spf=softfail", "mx.example; dmarc=pass header.from=lumen.example"],
    ],
    [
      "DMARC passes for a different domain and the receiver reports a failed DKIM check",
      ["mx.google.com; dmarc=pass header.from=else.example; dkim=fail header.d=lumen.example"],
    ],
  ])("classifies a known contact as failed checks when %s", (_name, authResults) => {
    const found = classify(mail("ana@lumen.example", { authResults }), rows);
    assert.strictEqual(found.class, "failed_checks");
    assert.isUndefined(found.look?.clientId);
  });

  const noticeCases: ReadonlyArray<
    [string, ArrivalHeaders, "automated_notice" | "unknown_person"]
  > = [
    [
      "h: a Japanese notice sent in bulk",
      mail("billing@utility.example", { precedence: "bulk", subject: "ご利用料金のお知らせ" }),
      "automated_notice",
    ],
    [
      "h: an Arabic notice marked auto-submitted",
      mail("billing@utility.example", {
        autoSubmitted: "auto-generated",
        subject: "تم تعليق الخدمة",
      }),
      "automated_notice",
    ],
    [
      "h: a Portuguese notice from a no-reply list",
      mail("no-reply@utility.example", {
        listUnsubscribe: true,
        subject: "Seu recibo está disponível",
      }),
      "automated_notice",
    ],
    [
      "j: a person's reply can carry an unsubscribe header",
      mail("zoya@studio-nine.example", {
        listUnsubscribe: true,
        subject: "Re: Payment failed for the subscription",
      }),
      "unknown_person",
    ],
    [
      "j: list precedence can belong to a person",
      mail("arjun@studio-nine.example", {
        precedence: "list",
        listUnsubscribe: true,
        subject: "Re: Final reminder",
      }),
      "unknown_person",
    ],
    [
      "j: a list reply explicitly marked as human can carry bulk headers",
      mail("zoya@studio-nine.example", {
        autoSubmitted: " No ; example=1",
        precedence: "bulk",
        listUnsubscribe: true,
        subject: "Re: Final reminder",
      }),
      "unknown_person",
    ],
  ];

  it.each(noticeCases)("%s", (_name, headers, expected) => {
    assert.strictEqual(classify(headers, rows).class, expected);
    assert.strictEqual(
      isAutomatedNotice(headers.subject, headers, headers.fromAddress),
      expected === "automated_notice",
    );
  });
});
