import { expect, it } from "@effect/vitest";
import { KinMemoryItemId, KinOrgId, MemoryItemHead } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";

import { buildIndex } from "./buildIndex.ts";

const now = Date.parse("2026-11-08T04:00:00.000Z");
const week = 7 * 24 * 60 * 60 * 1000;
const decodeHead = Schema.decodeSync(MemoryItemHead);
const item = (
  id: string,
  fields: Partial<MemoryItemHead> & { readonly misleading?: boolean } = {},
) => ({
  ...decodeHead({
    id: KinMemoryItemId.make(id),
    orgId: KinOrgId.make("fixture-org"),
    path: `${fields.kind === "person" ? "people" : `${fields.kind ?? "claim"}s`}/${id}.md`,
    kind: "claim",
    title: `Invented ${id}`,
    status: "open",
    due: null,
    recorded_at: "2026-11-01T00:00:00.000Z",
    valid_from: "2026-11-01T00:00:00.000Z",
    invalid_at: null,
    superseded_by: null,
    review_by: null,
    said_by: "fixture-owner",
    trust: "owner",
    source: "https://example.invalid/fixture",
    links: [],
    ...fields,
  }),
  ...(fields.misleading === undefined ? {} : { misleading: fields.misleading }),
});

it("matches the bounded index golden, independently of input order, and fades only unread items", async () => {
  const items = [
    item("waiting", { kind: "deferral", on_due: "ask", due: "2026-11-08T04:00:00.000Z" }),
    item("future-ask", { kind: "deferral", on_due: "ask", due: "2026-11-10" }),
    item("undated-ask", { kind: "deferral", on_due: "ask" }),
    item("soon", { kind: "deferral", due: "2026-11-09" }),
    item("objective", { kind: "objective" }),
    item("commitment", { kind: "commitment", due: "2026-11-07" }),
    item("overdue", { review_by: "2026-11-07" }),
    item("duplicate"),
    item("duplicate", { path: "claims/moved.md", invalid_at: "2026-11-07" }),
    item("misleading", { misleading: true, review_by: "2026-11-07" }),
    item("unread", { recorded_at: DateTime.formatIso(DateTime.makeUnsafe(now - 8 * week)) }),
    item("read", { recorded_at: "2026-01-01" }),
    item("constructor", { title: "Invented multiline\ntitle\u2028safe" }),
  ];
  const reads = { read: now - 8 * week + 1 };
  const actual = buildIndex(items, reads, now, "Asia/Kolkata");
  expect(buildIndex(items.toReversed(), reads, now, "Asia/Kolkata")).toBe(actual);
  expect(actual).not.toContain("Invented unread");
  const large = buildIndex(
    Array.from({ length: 250 }, (_, n) => item(`fixture-${n.toString().padStart(3, "0")}`)),
    {},
    now,
    "Asia/Kolkata",
  );
  expect(large.trimEnd().split("\n")).toHaveLength(200);
  await expect(actual + "\n" + large.trimEnd().split("\n").at(-1) + "\n").toMatchFileSnapshot(
    "./buildIndex.golden.txt",
  );
});

it.each([
  { zone: "UTC", now: "2026-11-08T23:30:00Z", due: "2026-11-16T00:00:00Z", soon: false },
  { zone: "Asia/Kolkata", now: "2026-11-08T23:30:00Z", due: "2026-11-16T00:00:00Z", soon: true },
  {
    zone: "America/New_York",
    now: "2026-03-07T17:00:00Z",
    due: "2026-03-15T04:00:00Z",
    soon: false,
  },
  {
    zone: "America/New_York",
    now: "2026-03-07T17:00:00Z",
    due: "2026-03-15T03:59:59Z",
    soon: true,
  },
])("uses owner calendar days, including DST: $zone $due", ({ zone, now: time, due, soon }) => {
  const result = buildIndex(
    [item("boundary", { due, recorded_at: time })],
    {},
    Date.parse(time),
    zone,
  );
  expect(result.includes("## Due in 7 days")).toBe(soon);
});
