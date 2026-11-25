import { assert, describe, it } from "@effect/vitest";

import type { AlertMail, AlertRejection } from "./bankAlerts.ts";
import { readHdfcAlert } from "./hdfcAlerts.ts";

// Synthetic alerts, written for these tests in the shape of HDFC's InstaAlerts. Every account,
// name, reference and amount is invented.
const VOUCHED = [
  "mx.google.com; dkim=pass header.i=@hdfcbank.net header.s=sel1 header.b=AbCd; spf=pass (google.com: domain of alerts@hdfcbank.net designates 192.0.2.1 as permitted sender) smtp.mailfrom=alerts@hdfcbank.net; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=hdfcbank.net",
];
const mail = (text: string, more: Partial<AlertMail> = {}): AlertMail => ({
  fromAddress: "alerts@hdfcbank.net",
  subject: "You have done a UPI txn. Check details!",
  date: "Wed, 18 Nov 2026 14:05:09 +0530",
  authResults: VOUCHED,
  text,
  ...more,
});
const UPI_DEBIT =
  "Dear Customer,\n\nRs.1,250.00 has been debited from account **4821 to VPA lakeview.cafe@invented LAKEVIEW CAFE on 18-11-26. Your UPI transaction reference number is 632211110001.\n\nIf you did not authorize this transaction, please report it immediately by calling 18000000000 or SMS BLOCK UPI to 7000000000.\n\nAvl bal: INR 4,10,250.50\n\nWarm Regards,\nHDFC Bank";
const NEFT_CREDIT =
  "Dear Customer, INR 95,000.00 was credited to your A/c No. XX4821 on 17-11-2026 for NEFT Cr-INVT0000001-AMBERMILL DESIGN LLP-Invoice 26-27/004. UTR No: INVTN52026111700042. Available balance: INR 5,05,250.50. Never share your OTP, PIN or CVV with anyone.";

const LABELLED_CREDIT = `(https://mail.invented.example/banner)

Dear Customer,

You've received a credit in your HDFC Bank account.

Details of the transaction:
Amount received: INR 86,420.75
Account: XX5372
Date: 18-Nov-2026
Reference Details: NEFT Cr-ZQTX0009753-CORRAN TILES LLP-SUPPLY ORDER-ZQTWN64261182345

Available Balance: INR 3,24,610.80

For more information about your account balance, contact the bank.

Regards,
HDFC Bank`;

describe("an HDFC alert mail", () => {
  it("reads a debit, a credit, and one without Avl bal", () => {
    const debit = readHdfcAlert(mail(UPI_DEBIT));
    assert.deepStrictEqual(debit, {
      _tag: "alert",
      alert: {
        direction: "debit",
        amountMinor: 125_000,
        currency: "INR",
        account: "4821",
        date: "2026-11-18",
        reference: "632211110001",
        counterparty: "LAKEVIEW CAFE lakeview.cafe@invented",
        balanceMinor: 41_025_050,
        sentAt: Date.parse("2026-11-18T08:35:09Z"),
      },
    });
    const credit = readHdfcAlert(
      mail(NEFT_CREDIT, { subject: "View: Account update for your HDFC Bank A/c" }),
    );
    assert.strictEqual(credit._tag, "alert");
    if (credit._tag !== "alert") return;
    assert.deepInclude(credit.alert, {
      direction: "credit",
      amountMinor: 9_500_000,
      date: "2026-11-17",
      reference: "INVTN52026111700042",
      counterparty: "NEFT Cr-INVT0000001-AMBERMILL DESIGN LLP-Invoice 26-27/004",
      balanceMinor: 50_525_050,
    });
    assert.deepStrictEqual(
      readHdfcAlert(
        mail(LABELLED_CREDIT, { subject: "❗ Incoming transfer: View your account balance" }),
      ),
      {
        _tag: "alert",
        alert: {
          direction: "credit",
          amountMinor: 8_642_075,
          currency: "INR",
          account: "5372",
          date: "2026-11-18",
          reference: "ZQTWN64261182345",
          counterparty: "CORRAN TILES LLP",
          balanceMinor: 32_461_080,
          sentAt: Date.parse("2026-11-18T08:35:09Z"),
        },
      },
    );
    const noBalance = readHdfcAlert(
      mail(
        "Dear Customer, Rs.5000.00 is successfully credited to your account **4821 by VPA rhea.invented@invented RHEA INVENTED on 18-11-26. Your UPI transaction reference number is 632211110002. Thank you for banking with us.",
      ),
    );
    assert.strictEqual(noBalance._tag, "alert");
    if (noBalance._tag !== "alert") return;
    assert.strictEqual(noBalance.alert.balanceMinor, null);
    assert.strictEqual(noBalance.alert.direction, "credit");
    assert.strictEqual(noBalance.alert.amountMinor, 500_000);
  });

  it("rejects, never guesses, what doesn't read one way", () => {
    const cases: ReadonlyArray<readonly [string, AlertMail, AlertRejection]> = [
      ["no reference", mail(UPI_DEBIT.replace(/Your UPI.*?\d+\./, "")), "unparsed"],
      [
        "two references",
        mail(UPI_DEBIT.replace("Warm Regards", "Ref No. 632299990000. Warm Regards")),
        "unparsed",
      ],
      [
        "two movements",
        mail(
          `${UPI_DEBIT} Rs.10.00 has been debited from account **4821 to VPA someone@invented on 18-11-26.`,
        ),
        "unparsed",
      ],
      ["no amount", mail(UPI_DEBIT.replace("Rs.1,250.00 ", "")), "unparsed"],
      ["a malformed amount", mail(UPI_DEBIT.replace("1,250.00", "1,25,0.0")), "unparsed"],
      ["debited to an account", mail(UPI_DEBIT.replace("debited from", "debited to")), "unparsed"],
      ["no such day", mail(UPI_DEBIT.replace("18-11-26", "31-02-26")), "unparsed"],
      ["a day long before its mail", mail(UPI_DEBIT.replace("18-11-26", "01-09-26")), "unparsed"],
      [
        "two balances",
        mail(UPI_DEBIT.replace("Warm", "Available balance: INR 9.00 Warm")),
        "unparsed",
      ],
      [
        "labelled amount without an explicit credit",
        mail(LABELLED_CREDIT.replace("a credit", "an update")),
        "unparsed",
      ],
      [
        "labelled credit explicitly negated",
        mail(LABELLED_CREDIT.replace("You've received", "You have not received")),
        "unparsed",
      ],
      [
        "labelled credit alongside a different movement",
        mail(`${LABELLED_CREDIT}\n\n${UPI_DEBIT}`),
        "unparsed",
      ],
      [
        "a labelled lookalike",
        mail(LABELLED_CREDIT, { fromAddress: "alerts@hdfcbank-secure.net" }),
        "sender",
      ],
      [
        "a labelled credit with a missing reference",
        mail(LABELLED_CREDIT.replace(/-ZQTWN\w+/, "")),
        "unparsed",
      ],
      [
        "a labelled credit with an impossible day",
        mail(LABELLED_CREDIT.replace("18-Nov", "31-Nov")),
        "unparsed",
      ],
      ["no date header", mail(UPI_DEBIT, { date: null }), "unparsed"],
      ["a marketing mail", mail("Get a pre-approved loan at 10.5% today!"), "unparsed"],
      [
        "a lookalike sender",
        mail(UPI_DEBIT, { fromAddress: "alerts@hdfcbank-secure.net" }),
        "sender",
      ],
      ["a forward", mail(UPI_DEBIT, { subject: "Fwd: You have done a UPI txn" }), "sender"],
      ["no Authentication-Results", mail(UPI_DEBIT, { authResults: [] }), "unverified"],
      [
        "DMARC failed",
        mail(UPI_DEBIT, { authResults: [VOUCHED[0]!.replace("dmarc=pass", "dmarc=fail")] }),
        "unverified",
      ],
      [
        "DMARC passed for another domain",
        mail(UPI_DEBIT, {
          authResults: [VOUCHED[0]!.replace("header.from=hdfcbank.net", "header.from=evil.test")],
        }),
        "unverified",
      ],
      [
        "a pass only in a lower header the sender wrote",
        mail(UPI_DEBIT, { authResults: ["mx.google.com; dmarc=fail", VOUCHED[0]!] }),
        "unverified",
      ],
    ];
    for (const [name, input, reason] of cases)
      assert.deepStrictEqual(readHdfcAlert(input), { _tag: "rejected", reason }, name);
  });

  it("reads the same alert printed with its parts repeated as one", () => {
    const twice = readHdfcAlert(mail(`${UPI_DEBIT}\n\n${UPI_DEBIT}`));
    assert.strictEqual(twice._tag, "alert");
  });
});
