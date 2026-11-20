import { describe, expect, it } from "@effect/vitest";

import { alertSigns, cutQuoted, isReplyOrForward, judgeAlert, readAlertText } from "./alertText.ts";

/** Three invented banks' alert styles: a sentence, labelled lines, and Spanish with a comma. */
const SENTENCE = {
  subject: "Account credited",
  text: "INR 95,000.00 credited to your A/c XX4821 on 18-11-26 from BRIGHTWELL LTD. Ref no 5120039981. Avl Bal: INR 4,10,000.00 - Harbour Trust Bank",
};
const LABELLED = {
  subject: "Transaction alert",
  text: "Account: ****7733\nType: Debit\nAmount: $1,250.00\nMerchant: Northgate Supplies\nDate: 2026-11-17",
};
const SPANISH = {
  subject: "Aviso de movimiento",
  text: "Abono recibido: 1.234,56 € en su cuenta terminada en 9050 de COMERCIAL ALBA SL el 15/11/2026. Saldo disponible: 8.765,43 €. Banco Ribera",
};

describe("bank alert text", () => {
  it.each([
    [
      "a sentence with its balance and reference",
      SENTENCE,
      "INR",
      {
        amountMinor: 9_500_000,
        currency: "INR",
        direction: "credit",
        day: "2026-11-18",
        account: "4821",
        party: "BRIGHTWELL LTD",
        balanceMinor: 41_000_000,
        reference: "5120039981",
      },
    ],
    [
      "labelled lines with no balance, a bare dollar read as the company's",
      LABELLED,
      "USD",
      {
        amountMinor: 125_000,
        currency: "USD",
        direction: "debit",
        day: "2026-11-17",
        account: "7733",
        party: "Northgate Supplies",
        balanceMinor: null,
        reference: null,
      },
    ],
    [
      "another language, a decimal comma and the currency after",
      SPANISH,
      "EUR",
      {
        amountMinor: 123_456,
        currency: "EUR",
        direction: "credit",
        day: "2026-11-15",
        account: "9050",
        party: "COMERCIAL ALBA SL",
        balanceMinor: 876_543,
        reference: null,
      },
    ],
  ])("reads %s", (_name, mail, home, fields) => {
    expect(readAlertText({ ...mail, mailDay: "2026-11-18", home })).toEqual(fields);
  });

  it("takes the day it arrived when the alert names none", () => {
    const read = readAlertText({
      subject: "Debit alert",
      text: "USD 40.00 debited from account ending 7733 at CORNER CAFE",
      mailDay: "2026-11-19",
      home: "USD",
    });
    expect(read).toMatchObject({ day: "2026-11-19", party: "CORNER CAFE", direction: "debit" });
  });

  it.each([
    ["an amount, a direction and an account", `${SENTENCE.subject} ${SENTENCE.text}`, true],
    ["a newsletter with prices", "Sale: everything at $20 off this week", false],
    ["a card's name is not a direction", "Your credit card XX4821 statement: INR 2,000 due", false],
    ["no account digits", "INR 500 credited. Thank you for banking with us.", false],
    [
      "a full account number is not its masked digits",
      "INR 500 credited to account 12345678",
      false,
    ],
  ])("looks like an alert: %s", (_name, text, looks) => {
    expect(alertSigns(text, "INR") !== undefined).toBe(looks);
  });

  it("asks about the account the alert names", () => {
    expect(alertSigns(`${SPANISH.subject} ${SPANISH.text}`, "EUR")).toEqual({
      amount: { minor: 123_456, currency: "EUR" },
      direction: "credit",
      account: "9050",
    });
  });

  // The plain reader takes a mail only when it can't be read another way; the rest wait for a reader.
  it.each([
    ["a declined debit", "Debit declined: NZD 50.00 from account ••4821 at CORNER CAFE"],
    ["a pending credit", "NZD 950.00 credit pending to account ••4821"],
    ["a one-time code", "Your one-time code for NZD 50.00 from account ••4821 is 482113"],
    ["two amounts", "NZD 50.00 debited from account ••4821, and a fee of NZD 2.50"],
    ["both directions", "NZD 50.00 debited from account ••4821 and credited to ••9050"],
    ["two accounts", "NZD 50.00 debited from account ••4821 to account ••9050"],
    ["an impossible date", "NZD 50.00 debited from account ••4821 on 31/02/2026"],
    ["a date read two ways", "NZD 50.00 debited from account ••4821 on 05/11/2026"],
    ["two dates", "NZD 50.00 debited from account ••4821 on 2026-11-17, posted 2026-11-18"],
  ])("leaves unread %s", (_name, text) => {
    expect(
      readAlertText({ subject: "Alert", text, mailDay: "2026-11-18", home: "NZD" }),
    ).toBeUndefined();
  });

  const read = readAlertText({ ...SENTENCE, mailDay: "2026-11-18", home: "INR" })!;
  const mail = { text: `${SENTENCE.subject}\n${SENTENCE.text}` };
  const approval = {
    account: "4821",
    currency: "INR",
    today: "2026-11-18",
    since: "2026-11-01",
    covered: (day: string) => day <= "2026-10-31",
  };
  it.each([
    ["counted", read, approval, undefined],
    ["another account", { ...read, account: "9999" }, approval, "other_account"],
    ["another currency", { ...read, currency: "USD" }, approval, "other_currency"],
    [
      "an amount the mail doesn't print",
      { ...read, amountMinor: 9_600_000 },
      approval,
      "not_in_text",
    ],
    ["an impossible day", { ...read, day: "2026-02-30" }, approval, "unreadable"],
    ["a day not come yet", { ...read, day: "2026-11-19" }, approval, "future"],
    [
      "a day before the sender counted",
      { ...read, day: "2026-10-31" },
      { ...approval, since: "2026-11-05", covered: () => false },
      "before_start",
    ],
    [
      "a day a statement covers",
      { ...read, day: "2026-11-02" },
      { ...approval, covered: () => true },
      "covered",
    ],
  ] as const)("judges %s", (_name, alert, who, reason) => {
    expect(judgeAlert(alert, mail, who)).toBe(reason);
  });

  it.each([
    [{ subject: "Fwd: Account credited" }, true],
    [{ subject: "RE: Account credited" }, true],
    [{ subject: "WG: Gutschrift" }, true],
    [{ subject: "Account credited", inReplyTo: "<a@bank.example>" }, true],
    [{ subject: "Account credited", references: "<a@bank.example>" }, true],
    [{ subject: "Account credited", inReplyTo: null, references: null }, false],
  ])("a reply or forward: %o", (mail, is) => {
    expect(isReplyOrForward(mail)).toBe(is);
  });

  it.each([
    [
      "a reply's quote",
      "Thanks\n\nOn Tue, 17 Nov 2026, Harbour Trust wrote:\n> NZD 900.00 credited",
    ],
    ["a quoted line", "Seen this?\n> NZD 900.00 credited to account ••4821"],
    ["a forward's header", "FYI\n---------- Forwarded message ---------\nNZD 900.00 credited"],
  ])("cuts %s", (_name, text) => {
    expect(cutQuoted(text)).not.toContain("900.00");
  });
});
