// @effect-diagnostics globalDate:off - Fixtures read change lines against a fixed day.
import {
  type KinAgentChange,
  KinRecordKey,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  kinAdviseEffort,
  KIN_AGENT_CHANGES,
  kinAgentChangeLine,
  kinAgentChangeOffer,
  kinAgentPageCan,
  kinAgentUsageLine,
  kinEffortOffAdvice,
  kinWithMediumEffort,
} from "./kinAgentPage.ts";

describe("kinAgentPageCan", () => {
  it.each([
    ["owner", { access: "owner" as const }, "full", true],
    ["co-owner", { access: "co_owner" as const }, "full", true],
    ["project lead", { access: "member" as const, leadsAProject: true }, "short", false],
    ["member", { access: "member" as const }, "short", false],
    ["not yet known", { access: undefined }, "unknown", false],
    ["named no kind by the host", { access: null }, "short", false],
  ])("%s", (_who, viewer, card, edits) => {
    const can = kinAgentPageCan(viewer);
    expect(can.card).toBe(card);
    for (const what of ["edit", "model", "character", "access", "pause", "remove"] as const)
      expect(can[what]).toBe(edits);
  });
});

describe("kinAgentUsageLine", () => {
  it.each([
    [{ turns: 0, tokens: 0 }, "No replies yet this month."],
    [{ turns: 1, tokens: 900 }, "1 reply this month, about 900 tokens."],
    [{ turns: 3, tokens: 0 }, "3 replies this month."],
    [{ turns: 12, tokens: 1_240_000 }, "12 replies this month, about 1.2M tokens."],
  ])("%j", (used, line) => {
    expect(kinAgentUsageLine(used as never)).toBe(line);
  });
});

describe("Kin's effort advice", () => {
  // Any provider's reasoning control: Codex calls it reasoningEffort, Claude effort.
  const reasoning: ProviderOptionDescriptor = {
    id: "reasoningEffort",
    label: "Reasoning",
    type: "select",
    options: ["low", "medium", "high", "xhigh"].map((id) => ({
      id,
      label: id,
      ...(id === "high" ? { isDefault: true } : {}),
    })),
  };
  const models = [{ slug: "invented-model", capabilities: { optionDescriptors: [reasoning] } }];
  const at = (effort?: string) => ({
    instanceId: ProviderInstanceId.make("invented"),
    model: "invented-model",
    ...(effort === undefined ? {} : { options: [{ id: "reasoningEffort", value: effort }] }),
  });

  it("lists Medium and High first, marked, and keeps every other level selectable", () => {
    const advised = kinAdviseEffort(reasoning);
    expect(advised.type === "select" ? advised.options : []).toEqual([
      { id: "medium", label: "medium", description: "Recommended" },
      { id: "high", label: "high", isDefault: true, description: "Recommended" },
      { id: "low", label: "low" },
      { id: "xhigh", label: "xhigh" },
    ]);
  });

  it.each([
    ["low", true],
    ["medium", false],
    ["high", false],
    ["xhigh", true],
    [undefined, false],
  ])("flags %s: %s", (effort, off) => {
    expect(kinEffortOffAdvice(at(effort), models)).toBe(off);
  });

  it("starts a freshly picked model at Medium, and leaves a chosen effort alone", () => {
    expect(kinWithMediumEffort(at(), models)).toEqual(at("medium"));
    expect(kinWithMediumEffort(at("xhigh"), models)).toEqual(at("xhigh"));
    expect(kinWithMediumEffort(at(), [])).toEqual(at());
  });
});

describe("kinAgentChangeLine and kinAgentChangeOffer", () => {
  const change = (over: Partial<KinAgentChange>): KinAgentChange => ({
    seq: 1,
    at: "2026-11-17T10:00:00.000Z",
    key: KinRecordKey.make("D-3"),
    title: "Invented chase notes",
    registerId: "docs",
    kind: "linked",
    fields: [{ field: "record", from: null, to: "rec-9" }],
    undo: false,
    since: false,
    ...over,
  });
  const end = { key: KinRecordKey.make("W-8"), title: "Invented harbour invoice" };
  const C = KIN_AGENT_CHANGES;
  it.each([
    [
      "a live link names its other end",
      { linkedTo: end, undo: true },
      "Linked D-3 Invented chase notes to W-8 Invented harbour invoice",
      { kind: "undo", done: C.linkUndone },
    ],
    [
      "a removed link says so",
      { linkedTo: end, undone: true },
      "Linked D-3 Invented chase notes to W-8 Invented harbour invoice",
      { kind: "undone", text: C.linkGone },
    ],
    [
      "an end the viewer can't see is not named",
      { linkedTo: null, undo: true },
      `Linked D-3 Invented chase notes to ${C.unseenEnd}`,
      { kind: "undo", done: C.linkUndone },
    ],
    [
      "a long other end is shortened",
      { linkedTo: { ...end, title: "Invented harbour invoice for the long autumn season" } },
      "Linked D-3 Invented chase notes to W-8 Invented harbour invoice for the lo…",
      { kind: "none" },
    ],
    [
      "a pull request names its label",
      { fields: [{ field: "pull_request", from: null, to: "PR #12" }], undo: true },
      "Linked D-3 Invented chase notes to PR #12",
      { kind: "undo", done: C.linkUndone },
    ],
    [
      "an older host's link, said as before and never 'changed since'",
      { since: true },
      "Linked D-3 Invented chase notes",
      { kind: "none" },
    ],
    [
      "an add with only links after it",
      { kind: "created", fields: [], since: true, linkedSince: true },
      "Added D-3 Invented chase notes",
      { kind: "since", text: C.linkedSinceDetail },
    ],
    [
      "an add changed after",
      { kind: "created", fields: [], since: true },
      "Added D-3 Invented chase notes",
      { kind: "since", text: C.sinceDetail },
    ],
    [
      "an add Kin never takes back",
      { kind: "created", fields: [] },
      "Added D-3 Invented chase notes",
      { kind: "manual", text: C.manualAddDetail },
    ],
    [
      "a field put back",
      { kind: "updated", fields: [{ field: "title", from: "Old", to: "New" }], undone: true },
      "D-3 Invented chase notes: title Old → New",
      { kind: "undone", text: C.undone },
    ],
    [
      "a field changed again after",
      { kind: "updated", fields: [{ field: "state", from: "open", to: "doing" }], since: true },
      "D-3 Invented chase notes: status open → doing",
      { kind: "since", text: C.sinceDetail },
    ],
    [
      "a move to another project, both named",
      {
        kind: "updated",
        fields: [{ field: "project", from: "P-1", to: "P-2" }],
        named: [
          { key: KinRecordKey.make("P-1"), title: "Invented portal" },
          { key: KinRecordKey.make("P-2"), title: "Invented rebrand" },
        ],
        undo: false,
      },
      "D-3 Invented chase notes: project P-1 Invented portal → P-2 Invented rebrand",
      { kind: "manual", text: C.manualDetail },
    ],
    [
      "a move to a client, the one the viewer can't see by its key alone",
      {
        kind: "updated",
        fields: [{ field: "party", from: "C-1", to: "C-2" }],
        named: [{ key: KinRecordKey.make("C-2"), title: "Invented Harbour Co" }],
      },
      "D-3 Invented chase notes: client C-1 → C-2 Invented Harbour Co",
      { kind: "manual", text: C.manualDetail },
    ],
    [
      "an amount Kin can't put back",
      { kind: "updated", fields: [{ field: "amount", from: "10", to: "12" }] },
      "D-3 Invented chase notes: amount 10 → 12",
      { kind: "manual", text: C.manualDetail },
    ],
  ] as const)("%s", (_case, over, line, offer) => {
    const one = change(over as Partial<KinAgentChange>);
    expect(kinAgentChangeLine(one, new Map())).toBe(line);
    expect(kinAgentChangeOffer(one)).toEqual(offer);
  });

  it("names a holder as people read names everywhere, never by id", () => {
    const moved = change({
      kind: "updated",
      fields: [{ field: "owner", from: "person:p-gone", to: "agent:a-fin" }],
    });
    expect(kinAgentChangeLine(moved, new Map([["a-fin", "Finance"]]))).toBe(
      "D-3 Invented chase notes: holder a teammate → Finance",
    );
  });

  it.each([
    ["Pacific/Honolulu", "2026-11-28T09:59:59.999Z", "2026-11-23T09:59:59.999Z"],
    ["Asia/Kolkata", "2026-11-27T18:29:59.999Z", "2026-11-22T18:29:59.999Z"],
  ])("a due moved reads the company's days in %s, whatever this device's", (zone, from, to) => {
    const moved = change({ kind: "updated", fields: [{ field: "due", from, to }] });
    expect(kinAgentChangeLine(moved, new Map(), new Date("2026-11-18T09:00:00.000Z"), zone)).toBe(
      "D-3 Invented chase notes: due Nov 27 → Nov 22",
    );
  });

  it.each([
    ["a link this person just removed", { linkedTo: end, undone: true }, true, C.linkUndone],
    ["a link someone else removed first", { linkedTo: end, undone: true }, false, C.linkGone],
    [
      "a field this person just put back",
      { kind: "updated", fields: [{ field: "title", from: "Old", to: "New" }], undone: true },
      true,
      C.undone,
    ],
  ] as const)("%s says so once read again", (_case, over, undoneHere, text) => {
    expect(kinAgentChangeOffer(change(over as Partial<KinAgentChange>), undoneHere)).toEqual({
      kind: "undone",
      text,
    });
  });
});
