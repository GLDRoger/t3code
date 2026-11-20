// @effect-diagnostics globalDate:off - Fixtures build times relative to a fixed clock.
import * as Cause from "effect/Cause";
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
  kinDealsNotRead,
  KIN_DEALS,
  kinDealEditDraft,
  kinDealEditRequest,
  kinDealQuoteChoices,
  kinDealsHeader,
  kinDealsQuery,
  kinDealsStartFilter,
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

describe("kinDealsQuery", () => {
  const orgId = KinOrgId.make("org-ambermill");
  it.each([
    [{ _tag: "everyone" } as const, undefined],
    [{ _tag: "me" } as const, { _tag: "person", personId: rhea }],
    [{ _tag: "person", personId: zoya } as const, { _tag: "person", personId: zoya }],
  ])("%j asks for %j", (who, owner) => {
    expect(kinDealsQuery(orgId, { who, state: "open" }, null, rhea)?.input.owner).toEqual(owner);
  });

  it("starts an owner known late on Everyone without ever asking for Mine, and a teammate on theirs", () => {
    // Each render's answer while the host is asked who the viewer is, then answers.
    const asked = (
      renders: ReadonlyArray<[Parameters<typeof kinDealsStartFilter>[0], KinPersonId | null]>,
    ) => renders.map(([access, me]) => kinDealsQuery(orgId, null, kinDealsStartFilter(access), me));
    const owner = asked([
      [undefined, null],
      [undefined, rhea],
      ["owner", rhea],
    ]);
    expect(owner.slice(0, 2)).toEqual([null, null]);
    expect(owner.at(-1)).toEqual({
      filter: { who: { _tag: "everyone" }, state: "open" },
      input: { orgId, state: "open" },
    });
    expect(asked([["co_owner", null]])[0]?.input.owner).toBeUndefined();
    expect(owner.every((read) => read?.input.owner === undefined)).toBe(true);
    const teammate = asked([
      [undefined, null],
      ["member", null],
      ["member", zoya],
    ]);
    expect(teammate.slice(0, 2)).toEqual([null, null]);
    expect(teammate[2]?.input.owner).toEqual({ _tag: "person", personId: zoya });
    // A choice of their own wins over where it started.
    const everyone = { who: { _tag: "everyone" }, state: "won" } as const;
    expect(kinDealsQuery(orgId, everyone, kinDealsStartFilter("member"), zoya)?.input).toEqual({
      orgId,
      state: "won",
    });
  });
});

describe("kinDealEditRequest", () => {
  const held = deal(7, {
    title: "Clinic scheduling pilot",
    value: { minor: 1_800_000, currency: "NOK" },
    expectedAt: "2027-01-15T18:29:59.999Z",
    expectedAllDay: true,
    source: "Trade fair",
  });

  it("sends only what changed, clears what was emptied, and keeps the deal's own currency", () => {
    const draft = kinDealEditDraft(held, names);
    expect(draft).toMatchObject({ title: "Clinic scheduling pilot", expected: "2027-01-15" });
    expect(kinDealEditRequest(held, draft, names, "EUR")).toEqual({
      ok: true,
      input: { key: held.key, rev: 1 },
    });
    expect(
      kinDealEditRequest(
        held,
        { ...draft, title: " Pilot ", value: "20000", expected: null, source: "", quote: null },
        names,
        "EUR",
      ),
    ).toEqual({
      ok: true,
      input: {
        key: held.key,
        rev: 1,
        title: "Pilot",
        value: { minor: 2_000_000, currency: "NOK" },
        expectedOn: null,
        source: null,
      },
    });
    expect(kinDealEditRequest(held, { ...draft, value: "" }, names, "EUR")).toMatchObject({
      input: { value: null },
    });
    const linked = kinDealEditRequest(
      held,
      { ...draft, quote: KinRecordKey.make("QT-3") },
      names,
      "EUR",
    );
    expect(linked).toMatchObject({ input: { quote: "QT-3" } });
  });

  it("refuses an empty title and an amount it can't read", () => {
    const draft = kinDealEditDraft(held, names);
    expect(kinDealEditRequest(held, { ...draft, title: " " }, names, "EUR")).toEqual({
      ok: false,
      problem: null,
    });
    expect(kinDealEditRequest(held, { ...draft, value: "soon" }, names, "EUR")).toEqual({
      ok: false,
      problem: "That isn't an amount.",
    });
  });
});

describe("kinDealQuoteChoices", () => {
  const quote = (n: number, accepted = false) => ({
    recordId: KinRecordId.make(`rec-q${n}`),
    key: KinRecordKey.make(`QT-${n}`),
    title: `Quote ${n}`,
    accepted,
  });

  it("offers None, then the client's quotes, with the linked one checked", () => {
    const linked = deal(1, { quote: quote(2, true) });
    expect(
      kinDealQuoteChoices({ deal: linked, quotes: [quote(3), quote(2, true)] })?.choices,
    ).toEqual([
      { key: null, label: "None", current: false },
      { key: "QT-3", label: "Quote 3", current: false },
      { key: "QT-2", label: "Quote 2 · accepted", current: true },
    ]);
    // A draft's own pick is what's checked.
    expect(
      kinDealQuoteChoices({ deal: linked, quotes: [quote(2, true)] }, null)?.choices[0]?.current,
    ).toBe(true);
  });

  it("says there is nothing to link, and offers nothing, when the client has no quotes", () => {
    expect(kinDealQuoteChoices({ deal: deal(1), quotes: [] })).toEqual({
      choices: [],
      empty: "No quotes for Brightwater Clinics to link.",
    });
    // Without a list to pick from a linked quote can still be taken off; with neither, someone
    // who doesn't read quotes (no Money) has no Quote row, and nothing says there are none.
    expect(
      kinDealQuoteChoices({ deal: deal(1, { quote: quote(4) }) })?.choices.map((one) => one.key),
    ).toEqual([null, "QT-4"]);
    expect(kinDealQuoteChoices({ deal: deal(1) })).toBeNull();
  });
});

describe("kinDealsNotRead", () => {
  it("says Deals need a newer Kin only for a host without them; a refusal says it is refused", () => {
    expect(kinDealsNotRead({ _tag: "refused" })).toBe(KIN_DEALS.refused);
    expect(
      kinDealsNotRead({ _tag: "failed", cause: Cause.die("Unknown request tag: kin.work.deals") }),
    ).toBe(KIN_DEALS.olderHost);
    // Any other failure offers Retry, as every list does.
    expect(kinDealsNotRead({ _tag: "failed", cause: Cause.die(new Error("Broken")) })).toBeNull();
    expect(kinDealsNotRead({ _tag: "loading" })).toBeNull();
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
    [
      [{ field: "concerns", from: null, to: "Staff confidence: half will never manage it" }],
      "Zoya noted the concerns",
    ],
    [[{ field: "concerns", from: "Staff confidence", to: null }], "Zoya cleared the concerns"],
    [[{ field: "state", from: "dropped", to: "open" }], "Zoya reopened it"],
  ] as const)("%j", (fields, text) => {
    expect(kinDealChangeText(change(fields), names, now)).toBe(text);
  });
});
