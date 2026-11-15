// @effect-diagnostics globalDate:off - Fixtures build times relative to a fixed clock.
import { describe, expect, it } from "vite-plus/test";

import { KinPersonId, KinRecordId, KinRecordKey, type KinPartyRow } from "@t3tools/contracts";

import { kinClientRow, kinLastContactLine, kinTouchAt } from "./kinWorkClients.ts";

describe("kinLastContactLine", () => {
  const now = new Date("2026-11-15T10:00:00.000Z");
  it.each([
    [undefined, null],
    [null, "No logged contact yet"],
    ["2026-11-15T08:00:00.000Z", "Last contact today"],
    ["2026-11-13T09:00:00.000Z", "Last contact 2 days ago"],
    ["2026-11-08T10:00:00.000Z", "No logged contact for 7 days"],
    ["2026-09-01T10:00:00.000Z", "No logged contact for 75 days"],
  ] as const)("%s reads %s", (lastAt, line) => {
    expect(kinLastContactLine(lastAt, now)).toBe(line);
  });
});

describe("kinTouchAt", () => {
  it("is now for today and midday for an earlier day, never ahead", () => {
    const now = new Date(2026, 10, 15, 9);
    expect(kinTouchAt("2026-11-15", now)).toBeUndefined();
    expect(kinTouchAt("2026-11-20", now)).toBeUndefined();
    expect(kinTouchAt("2026-11-14", now)).toBe(new Date(2026, 10, 14, 12).toISOString());
  });
});

describe("kinClientRow", () => {
  const now = new Date("2026-11-15T10:00:00.000Z");
  const names = { people: new Map(), agents: new Map(), me: null, zone: "Asia/Kolkata" };
  const row: KinPartyRow = {
    recordId: KinRecordId.make("r-C-1"),
    key: KinRecordKey.make("C-1"),
    name: "Pinecrest Pharmacy",
    kind: "client",
    owner: { _tag: "person", personId: KinPersonId.make("owner") },
    active: true,
    sensitive: false,
    weOwe: 0,
    theyOwe: 0,
    late: 0,
    overdue: 0,
    next: null,
    rev: 1,
  };
  it("counts for whoever runs the company and names only for a teammate", () => {
    expect(kinClientRow({ ...row, lastContactAt: null }, names, now).line).toBe(
      "Nothing open · No logged contact yet",
    );
    // A teammate's row comes without counts, so its zeros aren't "Nothing open".
    expect(kinClientRow(row, names, now).line).toBe("");
  });
});
