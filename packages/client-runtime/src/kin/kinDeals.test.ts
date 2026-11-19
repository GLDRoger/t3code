// @effect-diagnostics globalDate:off - Fixtures build times relative to a fixed clock.
import { describe, expect, it } from "vite-plus/test";

import {
  KinOrgId,
  KinPersonId,
  KinRecordId,
  KinRecordKey,
  type KinDealRow,
  type KinRecordChange,
} from "@t3tools/contracts";

import {
  kinDealChangeText,
  kinDealDrop,
  kinDealMoves,
  kinDealNext,
  kinDealNextStage,
  kinDealsByStage,
  kinDealsHeader,
  kinDealsInput,
  kinDealStageBeside,
  kinDealStagesProblem,
  kinDealWhen,
} from "./kinDeals.ts";
import type { KinWorkNames } from "./kinWork.ts";

const zoya = KinPersonId.make("person-zoya");
const rhea = KinPersonId.make("person-rhea");
const names: KinWorkNames = {
  people: new Map([
    [zoya, "Zoya"],
    [rhea, "Rhea"],
  ]),
  agents: new Map(),
  me: rhea,
  zone: "Asia/Kolkata",
};
const now = new Date("2026-11-20T06:00:00.000Z");
const stages = [
  { id: "new", name: "New" },
  { id: "in-talks", name: "In talks" },
  { id: "proposal", name: "Proposal" },
];

const deal = (n: number, over: Partial<KinDealRow> = {}): KinDealRow => ({
  recordId: KinRecordId.make(`rec-${n}`),
  key: KinRecordKey.make(`DL-${n}`),
  title: `Deal ${n}`,
  state: "open",
  stage: "new",
  expectedAt: null,
  expectedAllDay: false,
  party: {
    recordId: KinRecordId.make("rec-c"),
    key: KinRecordKey.make("C-1"),
    title: "Brightwater Clinics",
  },
  owner: { _tag: "person", personId: zoya },
  sensitive: false,
  next: null,
  can: { edit: true, move: true, give: false, mark: false },
  rev: 1,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  closedAt: null,
  ...over,
});

describe("kinDealsByStage", () => {
  it("groups open deals by stage, totals each currency apart, and keeps a removed stage's deals in the first", () => {
    const columns = kinDealsByStage(
      stages,
      [
        deal(1, { value: { minor: 900_000, currency: "EUR" } }),
        deal(2, { stage: "gone", value: { minor: 1_200_000, currency: "EUR" } }),
        deal(3, { stage: "proposal", value: { minor: 24_000_000, currency: "NOK" } }),
        deal(4, { stage: "proposal", value: { minor: 1_000_000, currency: "EUR" } }),
        deal(5, { state: "won", stage: "proposal" }),
      ],
      names,
      now,
    );
    expect(columns.map((column) => [column.name, column.count])).toEqual([
      ["New", 2],
      ["In talks", 0],
      ["Proposal", 2],
    ]);
    expect(columns[0]?.total).toBe("€21,000");
    // Never one figure across currencies.
    expect(columns[2]?.total).toMatch(/NOK.*·.*€10,000|€10,000.*·.*NOK/);
  });
});

describe("kinDealNext", () => {
  it.each([
    [null, "missing", "No next step"],
    [{ late: true, title: "Send the revised proposal" }, "late", "Late: Send the revised proposal"],
    [{ late: false, title: "Call Ingrid" }, "plain", "Next: Call Ingrid"],
  ] as const)("%j reads %s", (next, tone, text) => {
    const view = kinDealNext(
      deal(1, {
        next:
          next === null
            ? null
            : {
                key: KinRecordKey.make("T-9"),
                title: next.title,
                dueAt: null,
                dueAllDay: false,
                late: next.late,
              },
      }),
      names,
      now,
    );
    expect(view).toEqual({ tone, text });
  });

  it("says nothing of a won or lost deal", () => {
    expect(kinDealNext(deal(1, { state: "lost" }), names, now)).toBeNull();
  });
});

describe("moves", () => {
  it("offers each stage, Won and Lost while open, only Reopen once closed", () => {
    expect(
      kinDealMoves(deal(1, { stage: "in-talks" }), stages).map((m) => [m.label, m.current]),
    ).toEqual([
      ["New", false],
      ["In talks", true],
      ["Proposal", false],
      ["Won", false],
      ["Lost…", false],
    ]);
    expect(kinDealMoves(deal(1, { state: "won" }), stages).map((m) => m.to)).toEqual([
      { _tag: "reopen" },
    ]);
  });

  it("moves forward and by key one stage at a time, and drops as the board does", () => {
    expect(kinDealNextStage(deal(1), stages)?.name).toBe("In talks");
    expect(kinDealNextStage(deal(1, { stage: "proposal" }), stages)).toBeNull();
    expect(kinDealStageBeside(deal(1), stages, -1)).toBeNull();
    expect(kinDealStageBeside(deal(1), stages, 1)?.id).toBe("in-talks");
    expect(kinDealDrop(deal(1), "new")).toBeNull();
    expect(kinDealDrop(deal(1), "proposal")).toEqual({ _tag: "stage", stage: "proposal" });
    expect(kinDealDrop(deal(1), "won")).toEqual({ _tag: "won" });
    expect(kinDealDrop(deal(1), "lost")).toBe("lost");
    expect(kinDealDrop(deal(1, { state: "won" }), "new")).toBeNull();
  });
});

describe("kinDealWhen", () => {
  it("reads the expected day in the owner's zone, and the day it closed", () => {
    // 23:59 in Kolkata on 15 Jan is still 15 Jan there, though it is 18:29 UTC.
    expect(
      kinDealWhen(
        deal(1, { expectedAt: "2027-01-15T18:29:59.999Z", expectedAllDay: true }),
        names,
        now,
      ),
    ).toMatch(/^expected (?=.*Jan)(?=.*15)/);
    expect(
      kinDealWhen(deal(1, { state: "won", closedAt: "2026-11-18T09:00:00.000Z" }), names, now),
    ).toMatch(/^won (?=.*Nov)(?=.*18)/);
  });
});

describe("kinDealsHeader", () => {
  it("estimates a single figure only across currencies, and only with every rate", () => {
    const rates = {
      home: "EUR",
      rates: [{ currency: "NOK", rate: "0.085", asOf: "2026-11-17" }],
    };
    const one = kinDealsHeader({ count: 2, values: [{ minor: 100, currency: "EUR" }] }, rates);
    expect(one.estimate).toBeNull();
    const two = kinDealsHeader(
      {
        count: 3,
        values: [
          { minor: 1_000_000, currency: "EUR" },
          { minor: 10_000_000, currency: "NOK" },
        ],
      },
      rates,
    );
    expect(two.values).toHaveLength(2);
    expect(two.estimate).toMatch(/^about €/);
    expect(
      kinDealsHeader(
        { count: 3, values: two.values.map(() => ({ minor: 1, currency: "USD" })) },
        null,
      ).estimate,
    ).toBeNull();
  });
});

describe("kinDealsInput", () => {
  const orgId = KinOrgId.make("org-ambermill");
  it.each([
    [{ _tag: "everyone" } as const, undefined],
    [{ _tag: "me" } as const, { _tag: "person", personId: rhea }],
    [{ _tag: "person", personId: zoya } as const, { _tag: "person", personId: zoya }],
  ])("%j asks for %j", (who, owner) => {
    expect(kinDealsInput(orgId, { who, state: "open" }, rhea).owner).toEqual(owner);
  });
});

describe("kinDealStagesProblem", () => {
  it.each([
    [["New", "In talks"], null],
    [[], "Keep at least one stage."],
    [["New", " "], "Every stage needs a name."],
    [["New", "new"], "“new” is there twice."],
    [Array.from({ length: 13 }, (_, i) => `S${i}`), "At most 12 stages."],
  ])("%j", (list, problem) => {
    expect(kinDealStagesProblem(list)).toBe(problem);
  });
});

describe("kinDealChangeText", () => {
  const change = (fields: KinRecordChange["fields"]): KinRecordChange => ({
    seq: 1,
    at: "2026-11-19T09:00:00.000Z",
    by: { _tag: "person", personId: zoya },
    via: "owner",
    kind: "updated",
    fields,
  });
  it.each([
    [[{ field: "stage", from: "New", to: "In talks" }], "Zoya moved it New → In talks"],
    [[{ field: "state", from: "open", to: "done" }], "Zoya marked it won"],
    [
      [
        { field: "state", from: "open", to: "dropped" },
        { field: "lostReason", from: null, to: "went with someone cheaper" },
      ],
      "Zoya marked it lost: went with someone cheaper",
    ],
    [[{ field: "state", from: "dropped", to: "open" }], "Zoya reopened it"],
  ] as const)("%j", (fields, text) => {
    expect(kinDealChangeText(change(fields), names, now)).toBe(text);
  });
});
