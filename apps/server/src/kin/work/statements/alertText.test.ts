import { describe, expect, it } from "@effect/vitest";

import {
  alertSenderCheck,
  alertSigns,
  isReplyOrForward,
  judgeAlert,
  readAlertText,
} from "./alertText.ts";

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

  const read = readAlertText({ ...SENTENCE, mailDay: "2026-11-18", home: "INR" })!;
  const sender = {
    account: "4821",
    currency: "INR",
    today: "2026-11-18",
    coveredThrough: "2026-10-31",
  };
  it.each([
    ["counted", read, sender, undefined],
    ["another account", { ...read, account: "9999" }, sender, "other_account"],
    ["another currency", { ...read, currency: "USD" }, sender, "other_currency"],
    ["a day not come yet", { ...read, day: "2026-11-19" }, sender, "future"],
    ["a day a statement covers", { ...read, day: "2026-10-31" }, sender, "covered"],
    ["no statement yet", read, { ...sender, coveredThrough: null }, undefined],
  ] as const)("judges %s", (_name, alert, who, reason) => {
    expect(judgeAlert(alert, who)).toBe(reason);
  });

  it.each([
    ["dmarc passes for the sender", ["mx.example; dmarc=pass header.from=bank.example"], "passed"],
    [
      "dmarc passes for another domain",
      ["mx.example; dmarc=pass header.from=evil.example"],
      "failed",
    ],
    ["dmarc fails", ["mx.example; spf=pass; dmarc=fail header.from=bank.example"], "failed"],
    ["dkim signed by the sender", ["mx.example; dkim=pass header.d=bank.example"], "passed"],
    ["dkim signed by someone else", ["mx.example; dkim=pass header.d=evil.example"], "not checked"],
    [
      "a forged result below the receiver's own",
      ["mx.example; spf=softfail", "forged; dmarc=pass header.from=bank.example"],
      "not checked",
    ],
    ["nothing to go on", [], "not checked"],
  ] as const)("sender check: %s", (_name, results, verdict) => {
    expect(alertSenderCheck(results, "alerts@bank.example")).toBe(verdict);
  });

  it.each([
    ["Fwd: Account credited", true],
    ["RE: Account credited", true],
    ["WG: Gutschrift", true],
    ["Account credited", false],
  ])("a reply or forward: %s", (subject, is) => {
    expect(isReplyOrForward(subject)).toBe(is);
  });
});
