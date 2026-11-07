import { expect, it } from "@effect/vitest";
import type { MemoryItemKind } from "@t3tools/contracts";

import { defaultReviewBy } from "./freshness.ts";

const cases: ReadonlyArray<{
  kind: MemoryItemKind;
  due: string | null;
  milestone?: string | null;
  expected: string | null;
}> = [
  { kind: "person", due: null, expected: "2027-02-06T04:00:00.000Z" },
  { kind: "claim", due: null, expected: "2026-12-08T04:00:00.000Z" },
  { kind: "decision", due: "2026-11-09", expected: null },
  { kind: "commitment", due: "2026-11-09", expected: "2026-11-09" },
  { kind: "deferral", due: "2026-11-09T10:00+05:30", expected: "2026-11-09T10:00+05:30" },
  { kind: "deferral", due: null, expected: null },
  { kind: "objective", due: "2026-12-01", milestone: "2026-11-15", expected: "2026-11-15" },
  { kind: "objective", due: "2026-12-01", expected: "2026-12-01" },
  { kind: "objective", due: null, expected: null },
];

it.each(cases)(
  "defaults $kind freshness ($due, $milestone)",
  ({ kind, due, milestone, expected }) => {
    expect(defaultReviewBy({ kind, due }, Date.parse("2026-11-08T04:00:00.000Z"), milestone)).toBe(
      expected,
    );
  },
);
