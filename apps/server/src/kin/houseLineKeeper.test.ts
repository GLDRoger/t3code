import { describe, expect, it } from "@effect/vitest";

import { keeperEntriesFromRows } from "./houseLineKeeper.ts";

describe("house-line keeper source", () => {
  it("turns wills and notes into primary-source entries", () => {
    const entries = keeperEntriesFromRows({
      wills: [{ id: "will-1", body: "left the map", at: "2026-10-01T00:00:00Z", houseId: "web" }],
      notes: [
        {
          id: "note-1",
          body: "routes live here",
          at: "2026-10-02T00:00:00Z",
          houseId: "web",
          flaggedJson: "[]",
        },
        {
          id: "note-1",
          body: "routes live here",
          at: "2026-10-02T00:00:00Z",
          houseId: "server",
          flaggedJson: '["lane"]',
        },
      ],
    });
    expect(entries.map((entry) => entry.kind)).toEqual(["will", "note"]);
    expect(entries[1]?.houseIds).toEqual(["web", "server"]);
    expect(entries[1]?.flaggedMisleading).toBe(true);
  });
});
