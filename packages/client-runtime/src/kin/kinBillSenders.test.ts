import { kinRpcAccess, type KinBillSendersResult, type KinOrgId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinPermission } from "./kinAccess.ts";
import {
  KIN_BILL_SENDERS,
  KIN_BILL_SENDER_METHODS,
  kinBillSenderAddInput,
  kinBillSenderConfirm,
  kinBillSenderGroups,
  kinBillSenderPermissions,
  kinBillSenderReadResult,
  kinBillSenderRowView,
  kinBillSenderSinceChoices,
  kinBillSenderSinceDefault,
  kinBillSenderToday,
} from "./kinBillSenders.ts";

const ORG = "org-tidewater" as KinOrgId;
const NOW = Date.UTC(2026, 10, 27, 12, 0);
const NOV_24 = Date.UTC(2026, 10, 24, 9, 0);
const NOV_20 = Date.UTC(2026, 10, 20, 9, 0);
const DEC_2025 = Date.UTC(2025, 11, 15, 9, 0);
const WORDS = { zone: "UTC", locale: "en-GB" } as const;
const OPTIONS = { now: NOW, words: WORDS };

type Row = KinBillSendersResult["rows"][number];

const makeRow = (overrides: Partial<Row> = {}): Row => ({
  address: "billing@inkspot.example",
  name: "Inkspot Cloud",
  state: "waiting",
  seenCount: 3,
  firstSeenAt: NOV_20,
  lastSeenAt: NOV_24,
  decidedAt: null,
  decidedBy: null,
  askedInChat: true,
  ...overrides,
});

describe("a billing sender's row", () => {
  it.each<[string, Partial<Row>, Partial<ReturnType<typeof kinBillSenderRowView>>]>([
    [
      "waiting, asked on a card",
      {},
      {
        seenLine: "3 mails seen, the newest on 24 Nov",
        askedLine: "Also asked on a card in chat",
        decidedLine: null,
        actions: ["approve", "decline"],
      },
    ],
    [
      "waiting, its card gone",
      { askedInChat: false, seenCount: 1, lastSeenAt: NOV_24 },
      { seenLine: "1 mail seen, on 24 Nov", askedLine: null },
    ],
    [
      "approved by a person",
      { state: "approved", decidedBy: "Meera", decidedAt: NOV_24 },
      {
        decidedLine: "Approved by Meera on 24 Nov",
        askedLine: null,
        actions: ["remove"],
      },
    ],
    [
      "approved by hand, never mailed yet",
      {
        state: "approved",
        seenCount: 0,
        firstSeenAt: null,
        lastSeenAt: null,
        decidedBy: "Rhea",
        decidedAt: DEC_2025,
      },
      { seenLine: null, decidedLine: "Approved by Rhea on 15 Dec 2025" },
    ],
    [
      "declined, who unknown",
      { state: "declined", decidedAt: NOV_24, askedInChat: true },
      { decidedLine: "Declined on 24 Nov", askedLine: null, actions: ["addBack"] },
    ],
    [
      "declined by a person",
      { state: "declined", decidedBy: "Rhea", decidedAt: NOV_24 },
      { decidedLine: "Declined by Rhea on 24 Nov" },
    ],
  ])("%s", (_name, overrides, expected) => {
    expect(kinBillSenderRowView(makeRow(overrides), OPTIONS)).toMatchObject(expected);
  });

  it("never shows the name the sender wrote", () => {
    const view = kinBillSenderRowView(makeRow({ name: "Your bank — urgent" }), OPTIONS);
    expect(JSON.stringify(view)).not.toContain("urgent");
    expect(view.address).toBe("billing@inkspot.example");
    expect(view.addressSegments.map((segment) => segment.text).join("")).toBe(
      "billing@inkspot.example",
    );
  });
});

describe("billing sender groups", () => {
  it("puts waiting, then approved, then declined, by address, and leaves out empty groups", () => {
    const groups = kinBillSenderGroups(
      [
        makeRow({ address: "z@harborpower.example", state: "declined" }),
        makeRow({ address: "bills@harborpower.example", state: "approved" }),
        makeRow({ address: "billing@inkspot.example" }),
        makeRow({ address: "a@inkspot.example" }),
      ],
      OPTIONS,
    );
    expect(groups.map((group) => [group.title, group.rows.map((row) => row.address)])).toEqual([
      ["Waiting for an answer", ["a@inkspot.example", "billing@inkspot.example"]],
      ["Approved", ["bills@harborpower.example"]],
      ["Declined", ["z@harborpower.example"]],
    ]);
    expect(
      kinBillSenderGroups([makeRow({ state: "approved" })], OPTIONS).map((g) => g.state),
    ).toEqual(["approved"]);
    expect(kinBillSenderGroups([], OPTIONS)).toEqual([]);
  });
});

describe("adding a billing sender", () => {
  it.each([
    [
      "  Billing@Inkspot.Example ",
      { ok: true, input: { orgId: ORG, address: "billing@inkspot.example" } },
    ],
    ["", { ok: false, problem: "Enter a full email address for the billing sender." }],
    [
      "billing@inkspot",
      { ok: false, problem: "Enter a full email address for the billing sender." },
    ],
    ["Inkspot <billing@inkspot.example>", { ok: false, problem: KIN_BILL_SENDERS.addressInvalid }],
    [`${"a".repeat(250)}@x.example`, { ok: false, problem: KIN_BILL_SENDERS.addressInvalid }],
  ])("%j", (typed, expected) => {
    expect(kinBillSenderAddInput(ORG, typed)).toEqual(expected);
  });

  it("asks before reading, with the address whole, in the approval card's words on held mail", () => {
    const address = "bills@harborpower.example";
    expect(kinBillSenderConfirm("approve", address)).toEqual({
      title: "Read bills from bills@harborpower.example?",
      detail:
        "Kin will read bills this address sends to the company's mailboxes and suggest them as expenses for you to keep. Approving also reads the mail Kin held from it in the last 30 days.",
      action: "Approve",
      destructive: false,
    });
    expect(kinBillSenderConfirm("add", address)).toEqual(kinBillSenderConfirm("approve", address));
    expect(kinBillSenderConfirm("addBack", address)).toEqual(
      kinBillSenderConfirm("approve", address),
    );
    expect(kinBillSenderConfirm("remove", address)).toMatchObject({
      title: "Stop reading bills from bills@harborpower.example?",
      destructive: true,
    });
    expect(kinBillSenderConfirm("decline", address)).toMatchObject({
      title: "Decline bills@harborpower.example?",
      destructive: true,
    });
  });
});

describe("who sees billing senders", () => {
  it("guards every method at owner level: owners and co-owners in, teammates out", () => {
    for (const method of Object.values(KIN_BILL_SENDER_METHODS)) {
      const access = kinRpcAccess(method);
      expect(access).toBe("owner_level");
      const as = (kind: "owner" | "co_owner" | "member" | null) =>
        kinPermission({ sessionKnown: true, scopesGranted: true, kind, access, failed: false });
      expect([as("owner"), as("co_owner"), as("member"), as(null)]).toEqual([
        "granted",
        "granted",
        "refused",
        "refused",
      ]);
    }
  });

  it("hides the section on a refusal and offers taps only once granted", () => {
    const grants = {
      approve: true,
      decline: true,
      remove: true,
      addBack: true,
      add: false,
      readSince: true,
    };
    expect(kinBillSenderPermissions({ list: "refused", grants }).visible).toBe(false);
    const unknown = kinBillSenderPermissions({ list: "unknown", grants });
    expect([unknown.visible, unknown.can("approve")]).toEqual([true, false]);
    const granted = kinBillSenderPermissions({ list: "granted", grants });
    expect([granted.can("approve"), granted.can("add"), granted.can("readSince")]).toEqual([
      true,
      false,
      true,
    ]);
    expect(unknown.can("readSince")).toBe(false);
    expect(kinBillSenderPermissions({ list: "refused", grants }).can("readSince")).toBe(false);
  });
});

describe("reading an approved sender's bills since a day", () => {
  it.each([
    // 1 Mar 00:30 in Kolkata is still 28 Feb in UTC, so last month differs by zone.
    ["UTC", Date.UTC(2026, 1, 28, 19, 0), "2026-01-01", "2026-02-28"],
    ["Asia/Kolkata", Date.UTC(2026, 1, 28, 19, 0), "2026-02-01", "2026-03-01"],
    ["America/Los_Angeles", Date.UTC(2026, 0, 1, 3, 0), "2025-11-01", "2025-12-31"],
    ["UTC", Date.UTC(2026, 0, 1, 3, 0), "2025-12-01", "2026-01-01"],
  ])("in %s starts on the first of last month, and today is the latest day", (zone, now, day, today) => {
    expect(kinBillSenderSinceDefault(now, zone)).toBe(day);
    expect(kinBillSenderToday(now, zone)).toBe(today);
    expect(kinBillSenderSinceChoices(now, zone).every((choice) => choice.day <= today)).toBe(true);
  });

  it("offers the first of last month, this month and this year, without repeats", () => {
    expect(kinBillSenderSinceChoices(NOW, "UTC")).toEqual([
      { label: "First of last month", day: "2026-10-01" },
      { label: "First of this month", day: "2026-11-01" },
      { label: "First of this year", day: "2026-01-01" },
    ]);
    expect(kinBillSenderSinceChoices(Date.UTC(2026, 1, 10), "UTC").map((c) => c.day)).toEqual([
      "2026-01-01",
      "2026-02-01",
    ]);
  });

  const INK = "billing@inkspot.example";
  it.each([
    [{ queued: 0, older: false }, `Kin found no new mail from ${INK} since 1 Oct.`, false],
    [{ queued: 1, older: false }, `Kin is reading 1 mail from ${INK} since 1 Oct.`, false],
    [{ queued: 12, older: false }, `Kin is reading 12 mails from ${INK} since 1 Oct.`, false],
    [
      { queued: 200, older: true },
      `Kin is reading 200 mails from ${INK} since 1 Oct. There are older mails. Run this again to read the next 200.`,
      true,
    ],
    [
      { queued: 0, older: false, stopped: true as const },
      `Kin is reading 0 mails from ${INK} since 1 Oct. Kin stopped looking after 20 seconds. Run this again to continue.`,
      true,
    ],
    [
      { queued: 1, older: true, stopped: true as const },
      `Kin is reading 1 mail from ${INK} since 1 Oct. There are older mails. Run this again to read the next 200. Gmail asked Kin to wait before looking further: run this again in a few minutes.`,
      true,
    ],
  ])("%j shows the host's sentence whole", (counts, text, again) => {
    expect(kinBillSenderReadResult({ ...counts, text })).toEqual({ line: text, again });
  });
});
