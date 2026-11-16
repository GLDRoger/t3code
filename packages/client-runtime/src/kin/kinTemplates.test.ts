import { KinPersonId, type KinRecipe, type KinRecordChange } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinHasNotesHistory, kinNotesVersions, kinTemplateGroups } from "./kinTemplates.ts";
import type { KinWorkNames } from "./kinWork.ts";

// @effect-diagnostics-next-line globalDate:off
const now = new Date("2026-11-12T10:00:00Z");
const names: KinWorkNames = {
  people: new Map([["owner", "Asha"]]),
  agents: new Map([["finance", "Finance"]]),
  me: KinPersonId.make("owner"),
  zone: "UTC",
};

const recipe = (patch: Partial<KinRecipe>): KinRecipe =>
  ({
    name: "invoice",
    title: "Invoice",
    description: "",
    inputs: [],
    outputs: ["invoice.pdf"],
    list: "invoices",
    numbered: true,
    sensitive: false,
    changedAt: null,
    changedBy: { _tag: "starter" },
    commit: "c1",
    ...patch,
  }) as KinRecipe;

describe("kinTemplateGroups", () => {
  it("groups by what they make, invoices first, and says who changed one", () => {
    const groups = kinTemplateGroups(
      [
        recipe({ name: "month", title: "Month export", list: null }),
        recipe({ name: "receipt", title: "Receipt", list: "receipts", default: true }),
        recipe({
          name: "invoice-plain",
          labelled: true,
          changedAt: "2026-11-07T10:00:00.000Z",
          changedBy: { _tag: "agent", agentId: "finance", workerId: null } as never,
        }),
      ],
      names,
      now,
    );
    expect(groups.map((group) => group.title)).toEqual(["Invoices", "Receipts", "Other documents"]);
    expect(groups[0]?.templates[0]).toMatchObject({
      labelled: true,
      canUndo: true,
      forEntry: true,
      changed: expect.stringMatching(/^Changed by Finance, /),
    });
    expect(groups[1]?.templates[0]).toMatchObject({
      canUndo: false,
      changed: "Kin's starter",
      isDefault: true,
    });
    expect(groups[0]?.templates[0]?.isDefault).toBe(false);
    expect(groups[2]?.templates[0]?.forEntry).toBe(false);
  });
});

describe("kinNotesVersions", () => {
  const change = (seq: number, from: string | null, to: string | null, by = "finance") =>
    ({
      seq,
      at: "2026-11-10T09:00:00.000Z",
      by: by === "owner" ? { _tag: "person", personId: by } : { _tag: "agent", agentId: by },
      via: { _tag: "app" },
      kind: "updated",
      fields: [{ field: "notes", from, to }],
    }) as unknown as KinRecordChange;

  it("lists what the notes were before, newest first, with who wrote each", () => {
    const versions = kinNotesVersions(
      {
        notes: "Third",
        changes: [
          change(5, "Second", "Third", "owner"),
          { ...change(4, null, null), fields: [{ field: "state", from: "open", to: "done" }] },
          change(3, "First", "Second"),
          change(2, "", "First", "owner"),
        ],
      },
      names,
      now,
    );
    expect(versions.map((version) => [version.text, version.by?.split(",")[0] ?? null])).toEqual([
      ["Second", "Finance"],
      ["First", "You"],
    ]);
  });

  it("keeps a first version that came before the history, and skips copies of the current", () => {
    expect(
      kinNotesVersions({ notes: "Now", changes: [change(2, "Before", "Now")] }, names, now),
    ).toEqual([{ key: "first", text: "Before", by: null }]);
    expect(
      kinNotesVersions({ notes: "Same", changes: [change(2, "Same", "Same")] }, names, now),
    ).toEqual([]);
    // Cleared notes still have versions to bring back; an entry never noted has none.
    expect(kinHasNotesHistory({ changes: [change(2, "Before", "")] })).toBe(true);
    expect(kinHasNotesHistory({ changes: [] })).toBe(false);
  });
});
