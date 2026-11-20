import { describe, expect, it } from "@effect/vitest";
import type { MemoryItemHead } from "@t3tools/contracts";

import { positionsLine } from "./seat.ts";

const position = (recorded_at: string) =>
  ({ title: "Invented: ship the booking screens first", recorded_at }) as MemoryItemHead;

describe("positionsLine", () => {
  it.each([
    ["2026-11-20T03:00:00.000Z", "America/Los_Angeles", "2026-11-19"],
    ["2026-11-20T12:30:00.000Z", "Pacific/Auckland", "2026-11-21"],
    ["2026-11-20", "Pacific/Auckland", "2026-11-20"],
  ])("dates a position taken at %s on the company's day in %s", (at, zone, day) => {
    expect(positionsLine([position(at)], zone)).toBe(
      `- Your positions: "Invented: ship the booking screens first" (${day}).`,
    );
  });
});
