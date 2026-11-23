import { KinPersonId, KinRecordKey, type KinNumber } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  kinNumberChange,
  kinNumberChart,
  kinNumberDecimal,
  kinNumberDraft,
  kinNumberHistory,
  kinNumberRow,
  kinNumberSave,
  kinNumberValueText,
  kinNumbersShown,
  type KinNumberDraft,
  type KinNumberLocale,
} from "./kinNumbers.ts";

// Invented company (Ambermill) and numbers only.
const en: KinNumberLocale = { group: ",", decimal: ".", indian: false };
const de: KinNumberLocale = { group: ".", decimal: ",", indian: false };
const inLocale: KinNumberLocale = { group: ",", decimal: ".", indian: true };
const today = "2026-11-23";
const number = (patch: Partial<KinNumber>): KinNumber => ({
  key: KinRecordKey.make("G-4"),
  name: "Daily users",
  value: "4210",
  asOf: today,
  off: false,
  stale: false,
  canType: true,
  ...patch,
});
const by = { kind: "person" as const, id: KinPersonId.make("rhea"), name: "Rhea" };

describe("kinNumberValueText", () => {
  it.each([
    ["4210", "users", en, "4,210 users"],
    ["1234567.125", undefined, inLocale, "12,34,567.125"],
    ["1234567.5", "boxes", de, "1.234.567,5 boxes"],
    ["-2.5", "%", en, "−2.5%"],
    ["120000", "inr", en, "₹1,20,000"],
    ["120000.5", "USD", en, "$120,000.50"],
    // More decimals than the currency has: shown exactly, never rounded to cents.
    ["1.005", "USD", en, "1.005 USD"],
    ["123456789012345678901234567890", undefined, en, "123,456,789,012,345,678,901,234,567,890"],
  ] satisfies ReadonlyArray<[string, string | undefined, KinNumberLocale, string]>)(
    "%s %s",
    (value, unit, locale, shown) => {
      expect(kinNumberValueText(value, unit, locale)).toBe(shown);
    },
  );

  it("says money per currency, never added, and none as zero", () => {
    expect(
      kinNumberValueText(
        [
          { minor: 120000, currency: "INR" },
          { minor: 5000, currency: "USD" },
        ],
        undefined,
        en,
      ),
    ).toBe("₹1,200 · $50");
    expect(kinNumberValueText([], "INR", en)).toBe("₹0");
    expect(kinNumberValueText(null, "users", en)).toBeNull();
  });
});

describe("kinNumberRow", () => {
  it.each([
    ["today's value", {}, { asOf: null, typeToday: false }],
    ["yesterday's", { asOf: "2026-11-22" }, { asOf: "as of 22 Nov", typeToday: true }],
    ["last year's", { asOf: "2025-12-31" }, { asOf: "as of 31 Dec 2025", typeToday: true }],
    ["stale today", { stale: true }, { asOf: "as of 23 Nov", typeToday: false }],
    ["nothing yet", { value: null, asOf: null }, { asOf: null, typeToday: true }],
    ["not theirs to type", { asOf: "2026-11-22", canType: false }, { typeToday: false }],
  ] satisfies ReadonlyArray<[string, Partial<KinNumber>, object]>)("%s", (_, patch, view) => {
    expect(kinNumberRow(number(patch), today, en)).toMatchObject(view);
  });

  it("names both marks for a screen reader", () => {
    expect(kinNumberRow(number({ off: true, stale: true }), today, en).label).toBe(
      "Daily users, 4,210, as of 23 Nov, Outside its limit, Not updated lately",
    );
  });
});

describe("kinNumberDecimal", () => {
  it.each([
    ["1,234.50", undefined, en, "1234.50"],
    ["  -12 ", undefined, en, "-12"],
    ["−0.5", undefined, en, "-0.5"],
    [".5", undefined, en, "0.5"],
    ["7.", undefined, en, "7"],
    ["12,34,567", undefined, inLocale, "1234567"],
    ["1.234,5", undefined, de, "1234.5"],
    ["1 234,5", undefined, de, "1234.5"],
    ["99.99", "INR", en, "99.99"],
  ] satisfies ReadonlyArray<[string, string | undefined, KinNumberLocale, string]>)(
    "reads %s",
    (typed, unit, locale, value) => {
      expect(kinNumberDecimal(typed, unit, locale)).toEqual({ ok: true, value });
    },
  );

  it.each([
    ["", undefined, en, "Type a value first."],
    ["12a", undefined, en, "Type a number, like 1,234.5."],
    ["1,5", undefined, en, "Type a number, like 1,234.5."],
    ["1.2.3", undefined, en, "Type a number, like 1,234.5."],
    ["1.5", undefined, de, "Type a number, like 1.234,5."],
    ["-", undefined, en, "Type a number, like 1,234.5."],
    ["99.999", "INR", en, "INR has 2 decimals at most."],
    ["5.5", "JPY", en, "JPY has no decimals."],
    ["9".repeat(65), undefined, en, "That number is too long."],
  ] satisfies ReadonlyArray<[string, string | undefined, KinNumberLocale, string]>)(
    "refuses %s",
    (typed, unit, locale, problem) => {
      expect(kinNumberDecimal(typed, unit, locale)).toEqual({ ok: false, problem });
    },
  );
});

describe("kinNumberChange", () => {
  const values = [
    { value: "10", asOf: "2026-11-21" },
    { value: "12.5", asOf: "2026-11-22" },
    { value: "11", asOf: "2026-11-22" },
  ];
  it.each([
    [undefined, { text: "Up 1 since 21 Nov", tone: "plain" }],
    ["up", { text: "Up 1 since 21 Nov", tone: "good" }],
    ["down", { text: "Up 1 since 21 Nov", tone: "bad" }],
  ] satisfies ReadonlyArray<[KinNumber["direction"], object]>)(
    "a rise where %s is good",
    (direction, change) => {
      expect(
        kinNumberChange(values, direction === undefined ? {} : { direction }, today, en),
      ).toEqual(change);
    },
  );

  it("needs two days", () => {
    expect(kinNumberChange(values.slice(1), { direction: "up" }, today, en)).toBeNull();
  });
});

describe("kinNumberHistory", () => {
  it("lists newest first and keeps a corrected value, marked replaced", () => {
    const rows = kinNumberHistory(
      [
        { value: "10", asOf: "2026-11-21", by },
        {
          value: "120",
          asOf: "2026-11-22",
          source: "the Daily sales mail",
          by: { ...by, name: "Finance" },
        },
        { value: "12", asOf: "2026-11-22", by },
      ],
      undefined,
      today,
      en,
    );
    expect(rows.map(({ day, value, by, replaced }) => ({ day, value, by, replaced }))).toEqual([
      { day: "22 Nov", value: "12", by: "Rhea", replaced: false },
      { day: "22 Nov", value: "120", by: "Finance, from the Daily sales mail", replaced: true },
      { day: "21 Nov", value: "10", by: "Rhea", replaced: false },
    ]);
  });
});

describe("kinNumberChart", () => {
  it("draws the value each day ended on, money in minor units", () => {
    const chart = kinNumberChart({ name: "Collections", unit: "INR" }, [
      { value: "10.10", asOf: "2026-11-21" },
      { value: "99", asOf: "2026-11-22" },
      { value: "12.5", asOf: "2026-11-22" },
    ]);
    expect(chart).toMatchObject({
      chart: "line",
      unit: { kind: "money", currency: "INR" },
      labels: ["2026-11-21", "2026-11-22"],
      series: [{ values: [1010, 1250] }],
    });
    expect(kinNumberChart({ name: "One day" }, [{ value: "1", asOf: today }])).toBeNull();
  });
});

describe("kinNumberSave", () => {
  const definition = {
    key: KinRecordKey.make("G-4"),
    rev: 3,
    name: "Refund rate",
    unit: "%",
    above: "4.5",
    computed: false,
    shared: false,
    archived: false,
  };
  it.each([
    [
      "a new number leaves out what is blank",
      null,
      { name: " Daily users ", above: "1,000" },
      { ok: true, input: { name: "Daily users", above: "1000", shared: false } },
    ],
    [
      "an edit clears what was emptied",
      definition,
      { above: "" },
      {
        ok: true,
        input: {
          key: "G-4",
          rev: 3,
          name: "Refund rate",
          unit: "%",
          direction: null,
          every: null,
          source: null,
          above: null,
          below: null,
          shared: false,
        },
      },
    ],
    ["needs a name", null, { name: "  " }, { ok: false, problem: "Give the number a name." }],
    [
      "limits the right way up",
      null,
      { name: "Stock", above: "1", below: "2" },
      { ok: false, problem: "The lower limit is above the upper one." },
    ],
    [
      "a limit is a number",
      null,
      { name: "Stock", below: "few" },
      { ok: false, problem: "Below: Type a number, like 1,234.5." },
    ],
  ] satisfies ReadonlyArray<[string, typeof definition | null, Partial<KinNumberDraft>, object]>)(
    "%s",
    (_, held, patch, outcome) => {
      expect(kinNumberSave({ ...kinNumberDraft(held, en), ...patch }, held, en)).toEqual(outcome);
    },
  );
});

describe("kinNumbersShown", () => {
  it.each([
    [true, null, true],
    [true, 0, true],
    [false, null, false],
    [false, 0, false],
    [false, 2, true],
  ] satisfies ReadonlyArray<[boolean, number | null, boolean]>)(
    "owner level %s with %s numbers",
    (ownerLevel, count, shown) => {
      expect(kinNumbersShown({ ownerLevel, count })).toBe(shown);
    },
  );
});
