import { kinRpcAccess, type KinBankSendersResult, type KinOrgId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinPermission } from "./kinAccess.ts";
import {
  KIN_BANK_SENDERS,
  KIN_BANK_SENDER_METHODS,
  kinBankSenderAddInput,
  kinBankSenderAddNotice,
  kinBankSenderAddressSegments,
  kinBankSenderKnownBanks,
  kinBankSenderPermissions,
  kinBankSenderRows,
  kinBankSenderRowView,
  kinAddressSentencePieces,
} from "./kinBankSenders.ts";

const ORG = "org-tidewater" as KinOrgId;
const NOW = Date.UTC(2026, 10, 27, 12, 0);
const NOV_24 = Date.UTC(2026, 10, 24, 9, 0);
const DEC_2025 = Date.UTC(2025, 11, 15, 9, 0);
const WORDS = { zone: "UTC", locale: "en-GB" } as const;

type Row = KinBankSendersResult["rows"][number];

const makeRow = (overrides: Partial<Row> = {}): Row => ({
  address: "alerts@harborbank.example",
  bankName: "Harbor Bank",
  state: "approved",
  accounts: ["4821"],
  firstSeenAt: NOV_24,
  decidedAt: NOV_24,
  decidedBy: "Rhea",
  recordedCount: 0,
  heldCount: 0,
  ...overrides,
});

describe("kinBankSenderAddressSegments", () => {
  it.each([
    [
      "very.long.automated.notifications.service+tidewater@alerts.sub.harborbank.example",
      ["very.", "long.", "automated.", "notifications.", "service+tidewater@"],
      ["alerts.", "sub.", "harborbank.", "example"],
    ],
    [
      "alerts@harborbank.relay-mail.example",
      ["alerts@"],
      ["harborbank.", "relay-mail.", "example"],
    ],
    ["odd@name@harborbank.example", ["odd@", "name@"], ["harborbank.", "example"]],
    ["not-an-address", [], ["not-an-address"]],
  ])("breaks %j only after @ and after a dot", (address, local, domain) => {
    const segments = kinBankSenderAddressSegments(address);
    expect(segments.map((one) => one.text).join("")).toBe(address);
    expect(segments.filter((one) => !one.domain).map((one) => one.text)).toEqual(local);
    expect(segments.filter((one) => one.domain).map((one) => one.text)).toEqual(domain);
  });
});

describe("kinAddressSentencePieces", () => {
  it.each([
    [
      "Read bills from billing@inkspot.example?",
      ["Read ", "bills ", "from ", "billing@", "inkspot.", "example?"],
    ],
    [
      "Read by Kin from a mail from billing@inkspot.example, received Nov 27.",
      [
        "Read ",
        "by ",
        "Kin ",
        "from ",
        "a ",
        "mail ",
        "from ",
        "billing@",
        "inkspot.",
        "example, ",
        "received ",
        "Nov ",
        "27.",
      ],
    ],
  ])("breaks %j between words, and inside the address only after @ and a dot", (text, pieces) => {
    expect(kinAddressSentencePieces(text)).toEqual(pieces);
    expect(kinAddressSentencePieces(text)?.join("")).toBe(text);
  });

  it("leaves a sentence with no address whole", () => {
    expect(kinAddressSentencePieces("Approve this sender?")).toBeNull();
  });
});

describe("kinBankSenderAddInput", () => {
  it("accepts and normalizes a valid address, bank name, and one or more four-digit endings", () => {
    expect(
      kinBankSenderAddInput(ORG, {
        address: " Alerts@HarborBank.Example ",
        bankName: "  Harbor Bank  ",
        accounts: "7310, 4821  4821\n5530;7310",
      }),
    ).toEqual({
      ok: true,
      input: {
        orgId: ORG,
        address: "alerts@harborbank.example",
        bankName: "Harbor Bank",
        accounts: ["4821", "5530", "7310"],
      },
    });
  });

  it.each([
    ["blank", "", KIN_BANK_SENDERS.addressRequired],
    ["no @", "alertsharborbank.example", KIN_BANK_SENDERS.addressInvalid],
    ["two @ signs", "alerts@ops@harborbank.example", KIN_BANK_SENDERS.addressInvalid],
    ["no domain dot", "alerts@harborbank", KIN_BANK_SENDERS.addressInvalid],
    ["spaces inside", "alerts @harborbank.example", KIN_BANK_SENDERS.addressInvalid],
    ["over 254 chars", `${"a".repeat(240)}@harborbank.example`, KIN_BANK_SENDERS.addressInvalid],
  ])("rejects an invalid address (%s)", (_label, address, expected) => {
    const result = kinBankSenderAddInput(ORG, {
      address,
      bankName: "Harbor Bank",
      accounts: "4821",
    });
    expect(result).toEqual({ ok: false, problems: { address: expected } });
  });

  it.each([
    ["blank", "   ", KIN_BANK_SENDERS.bankNameRequired],
    ["over 160 chars", "H".repeat(161), KIN_BANK_SENDERS.bankNameTooLong],
  ])("rejects an invalid bank name (%s)", (_label, bankName, expected) => {
    const result = kinBankSenderAddInput(ORG, {
      address: "alerts@harborbank.example",
      bankName,
      accounts: "4821",
    });
    expect(result).toEqual({ ok: false, problems: { bankName: expected } });
  });

  it.each([
    ["empty", " ,  ", KIN_BANK_SENDERS.accountsRequired],
    ["three digits", "482", KIN_BANK_SENDERS.accountsInvalid],
    ["five digits", "48210", KIN_BANK_SENDERS.accountsInvalid],
    ["non-digits", "482a", KIN_BANK_SENDERS.accountsInvalid],
    ["masked prefix", "xx4821", KIN_BANK_SENDERS.accountsInvalid],
    ["valid mixed with invalid", "4821, 99", KIN_BANK_SENDERS.accountsInvalid],
  ])("rejects invalid account endings (%s)", (_label, accounts, expected) => {
    const result = kinBankSenderAddInput(ORG, {
      address: "alerts@harborbank.example",
      bankName: "Harbor Bank",
      accounts,
    });
    expect(result).toEqual({ ok: false, problems: { accounts: expected } });
  });

  it("reports every invalid field at once", () => {
    expect(kinBankSenderAddInput(ORG, { address: "", bankName: "", accounts: "" })).toEqual({
      ok: false,
      problems: {
        address: KIN_BANK_SENDERS.addressRequired,
        bankName: KIN_BANK_SENDERS.bankNameRequired,
        accounts: KIN_BANK_SENDERS.accountsRequired,
      },
    });
  });
});

describe("kinBankSenderAddNotice", () => {
  const rows = [
    makeRow({ address: "alerts@harborbank.example", accounts: ["4821"] }),
    makeRow({ address: "multi@harborbank.example", accounts: ["4821", "7310"] }),
    makeRow({ address: "notices@harborbank.example", state: "waiting", accounts: [] }),
    makeRow({ address: "old@harborbank.example", state: "declined", accounts: [] }),
    makeRow({ address: "asked@harborbank.example", state: "waiting", askedInChat: true }),
    makeRow({ address: "unasked@harborbank.example", state: "waiting", askedInChat: false }),
  ];

  it.each([
    [
      " Alerts@HarborBank.example ",
      "Rhea",
      "Kin already counts this address as Harbor Bank's for the account ending 4821, and adding it here replaces that with the bank name and endings below.",
    ],
    [
      "multi@harborbank.example",
      "Rhea",
      "Kin already counts this address as Harbor Bank's for the accounts ending 4821 and 7310, and adding it here replaces that with the bank name and endings below.",
    ],
    [
      "notices@harborbank.example",
      "Rhea",
      "This address is waiting for Rhea's answer in chat, and adding it here counts its alerts now.",
    ],
    [
      "notices@harborbank.example",
      null,
      "This address is waiting for the owner's answer in chat, and adding it here counts its alerts now.",
    ],
    [
      "asked@harborbank.example",
      "Rhea",
      "This address is waiting for Rhea's answer in chat, and adding it here counts its alerts now.",
    ],
    [
      "unasked@harborbank.example",
      "Rhea",
      "Kin will ask Rhea about this address in chat; adding it here counts its alerts now.",
    ],
    [
      "unasked@harborbank.example",
      null,
      "Kin will ask the owner about this address in chat; adding it here counts its alerts now.",
    ],
    ["old@harborbank.example", "Rhea", null],
    ["new@harborbank.example", "Rhea", null],
    ["", "Rhea", null],
  ])("says before submit what adding %j does", (address, ownerName, expected) => {
    expect(kinBankSenderAddNotice(address, rows, ownerName)).toBe(expected);
  });
});

describe("kinBankSenderKnownBanks", () => {
  it("lists Company details' bank first, then unique bank names from rows ignoring case", () => {
    expect(
      kinBankSenderKnownBanks({
        companyBankName: " Harbor Bank ",
        rows: [
          { bankName: "harbor bank" },
          { bankName: "Northstar Bank" },
          { bankName: "  " },
          { bankName: "Northstar Bank" },
        ],
      }),
    ).toEqual(["Harbor Bank", "Northstar Bank"]);
  });
});

describe("kinBankSenderRowView", () => {
  it("presents a Counting row with accounts, non-zero counts, decided line, and Remove allowed", () => {
    const view = kinBankSenderRowView(
      makeRow({
        accounts: ["4821", "7310"],
        recordedCount: 12,
        heldCount: 2,
        decidedBy: "Meera",
        decidedAt: NOV_24,
      }),
      { ownerName: "Rhea", now: NOW, words: WORDS },
    );
    expect(view).toMatchObject({
      address: "alerts@harborbank.example",
      addressSegments: [
        { text: "alerts@", domain: false },
        { text: "harborbank.", domain: true },
        { text: "example", domain: true },
      ],
      bankName: "Harbor Bank",
      state: "approved",
      stateLabel: "Counting",
      accountsLine: "Accounts ending 4821, 7310",
      countsLine: "12 transactions recorded · 2 mails held",
      decidedLine: "Approved by Meera on 24 Nov",
      waitingLine: null,
      canRemove: true,
      canAddAgain: false,
    });
  });

  it("uses singular count words, omits zero counts, and handles carried-over rows with no decision", () => {
    const carried = kinBankSenderRowView(
      makeRow({
        accounts: ["4821"],
        recordedCount: 1,
        heldCount: 0,
        decidedBy: null,
        decidedAt: null,
        firstSeenAt: null,
      }),
      { ownerName: "Rhea", now: NOW, words: WORDS },
    );
    expect(carried.accountsLine).toBe("Account ending 4821");
    expect(carried.countsLine).toBe("1 transaction recorded");
    expect(carried.decidedLine).toBe("Carried over from earlier alerts");

    const zeroCounts = kinBankSenderRowView(
      makeRow({ recordedCount: 0, heldCount: 0, decidedAt: DEC_2025, decidedBy: "Rhea" }),
      { ownerName: "Rhea", now: NOW, words: WORDS },
    );
    expect(zeroCounts.countsLine).toBeNull();
    expect(zeroCounts.decidedLine).toBe("Approved by Rhea on 15 Dec 2025");
  });

  it("presents a Waiting row naming the owner in chat with no approve or remove action", () => {
    const view = kinBankSenderRowView(
      makeRow({
        state: "waiting",
        accounts: [],
        recordedCount: 0,
        heldCount: 3,
        decidedBy: null,
        decidedAt: null,
        firstSeenAt: NOV_24,
      }),
      { ownerName: "Rhea", now: NOW, words: WORDS },
    );
    expect(view).toMatchObject({
      state: "waiting",
      stateLabel: "Waiting for the owner",
      accountsLine: null,
      countsLine: "3 mails held",
      decidedLine: "First seen 24 Nov",
      waitingLine: "Waiting for Rhea to answer in chat",
      canRemove: false,
      canAddAgain: false,
    });

    const withoutOwnerName = kinBankSenderRowView(
      makeRow({ state: "waiting", accounts: [], decidedBy: null, decidedAt: null }),
      { ownerName: null, now: NOW, words: WORDS },
    );
    expect(withoutOwnerName.waitingLine).toBe("Waiting for the owner to answer in chat");
  });

  it.each([
    [undefined, "Rhea", "Waiting for Rhea to answer in chat"],
    [true, "Rhea", "Waiting for Rhea to answer in chat"],
    [false, "Rhea", "Kin will ask Rhea about this address in chat"],
    [false, null, "Kin will ask the owner about this address in chat"],
  ])("a Waiting row asked in chat %j says so only once Kin has asked", (asked, owner, line) => {
    const row = makeRow({ state: "waiting", accounts: [], decidedBy: null, decidedAt: null });
    const view = kinBankSenderRowView(asked === undefined ? row : { ...row, askedInChat: asked }, {
      ownerName: owner,
      now: NOW,
      words: WORDS,
    });
    expect(view.waitingLine).toBe(line);
    expect(view.stateLabel).toBe("Waiting for the owner");
  });

  it("presents a Declined row as Not counted with no Remove and Add-again allowed", () => {
    const view = kinBankSenderRowView(
      makeRow({
        state: "declined",
        accounts: [],
        recordedCount: 0,
        heldCount: 1,
        decidedBy: "Rhea",
        decidedAt: NOV_24,
      }),
      { ownerName: "Rhea", now: NOW, words: WORDS },
    );
    expect(view).toMatchObject({
      state: "declined",
      stateLabel: "Not counted",
      accountsLine: null,
      countsLine: "1 mail held",
      decidedLine: "Declined by Rhea on 24 Nov",
      waitingLine: null,
      canRemove: false,
      canAddAgain: true,
    });
  });

  it("orders approved rows first, then waiting, then declined, alphabetical within each group", () => {
    const ordered = kinBankSenderRows(
      [
        makeRow({ address: "z@bank.example", state: "declined" }),
        makeRow({ address: "b@bank.example", state: "waiting" }),
        makeRow({ address: "m@bank.example", state: "approved" }),
        makeRow({ address: "a@bank.example", state: "approved" }),
      ],
      { ownerName: "Rhea", now: NOW, words: WORDS },
    );
    expect(ordered.map((row) => `${row.state}:${row.address}`)).toEqual([
      "approved:a@bank.example",
      "approved:m@bank.example",
      "waiting:b@bank.example",
      "declined:z@bank.example",
    ]);
  });
});

describe("bank senders permission gating", () => {
  it("guards all three RPCs at owner_level so teammates are refused and owners/co-owners are granted", () => {
    for (const method of Object.values(KIN_BANK_SENDER_METHODS)) {
      const access = kinRpcAccess(method);
      expect(access).toBe("owner_level");
      expect(
        kinPermission({
          sessionKnown: true,
          scopesGranted: true,
          kind: "owner",
          access,
          failed: false,
        }),
      ).toBe("granted");
      expect(
        kinPermission({
          sessionKnown: true,
          scopesGranted: true,
          kind: "co_owner",
          access,
          failed: false,
        }),
      ).toBe("granted");
      expect(
        kinPermission({
          sessionKnown: true,
          scopesGranted: true,
          kind: "member",
          access,
          failed: false,
        }),
      ).toBe("refused");
      expect(
        kinPermission({
          sessionKnown: true,
          scopesGranted: true,
          kind: null,
          access,
          failed: false,
        }),
      ).toBe("refused");
      expect(
        kinPermission({
          sessionKnown: true,
          scopesGranted: false,
          kind: "owner",
          access,
          failed: false,
        }),
      ).toBe("refused");
    }
  });

  it("hides the section for teammates and hides actions when add/remove are not granted", () => {
    expect(kinBankSenderPermissions({ list: "refused", canAdd: false, canRemove: false })).toEqual({
      visible: false,
      canAdd: false,
      canRemove: false,
    });
    expect(kinBankSenderPermissions({ list: "granted", canAdd: false, canRemove: false })).toEqual({
      visible: true,
      canAdd: false,
      canRemove: false,
    });
    expect(kinBankSenderPermissions({ list: "granted", canAdd: true, canRemove: true })).toEqual({
      visible: true,
      canAdd: true,
      canRemove: true,
    });
    expect(kinBankSenderPermissions({ list: "unknown", canAdd: true, canRemove: true })).toEqual({
      visible: true,
      canAdd: false,
      canRemove: false,
    });
  });
});
