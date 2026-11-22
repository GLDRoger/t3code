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
    const cases: ReadonlyArray<[string, ArrivalHeaders, string, string | undefined]> = [
      ["a: our own address", mail("Rhea <rhea@ambermill.example>"), "own", undefined],
      [
        "b: a sign-in code, even from a client",
        mail("ana@lumen.example", { subject: "Your verification code is 123456" }),
        "sign_in",
        undefined,
      ],
      [
        "c: a reply in a thread we sent in",
        mail("someone@else.example", { threadId: "t-sent" }),
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
        mail("accounts@other.example", { subject: "Re: INV-4 for October" }),
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
        mail("billing@inkspot.example", { listUnsubscribe: true }),
        "known_biller",
        "finance",
      ],
      [
        "h: automated mail with a file",
        mail("no-reply@printshop.example", { hasFile: true }),
        "automated_file",
        undefined,
      ],
      [
        "h: automated mail without one",
        mail("Design Weekly <news@designweekly.example>", { listUnsubscribe: true }),
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
        "h: auto-submitted `no` is a person",
        mail("zoya@studio-nine.example", { autoSubmitted: "no" }),
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
    for (const [name, headers, expected, by] of cases) {
      const found = classify(headers, rows);
      assert.strictEqual(found.class, expected, name);
      const look = found.look?.by;
      assert.strictEqual(typeof look === "object" ? look.agentId : look, by, name);
      assert.isAtMost(found.reason.length, 200, name);
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
