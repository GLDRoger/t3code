import { MemoryItemHead } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { BODY_MAX, notMemory, spent, writeRefusal } from "./keeping.ts";

const NOW = Date.parse("2026-11-11T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const note = (title: string, body = "") => ({ title, body });

describe("notMemory", () => {
  it.each([
    // The owner's own example, as one item and as its parts.
    [
      "Get back to the owner after the 60-second pause they asked for",
      "Recheck GitHub access and check whether acme/app is a worker project for the README task.",
      "soon",
    ],
    ["Follow up on the README task in 10 minutes", "", "soon"],
    ["Ping Dana later today about the invoice", "", "soon"],
    ["Recheck GitHub access", "", "todo"],
    ["Check whether acme/app is a worker project", "", "todo"],
    ["Need to look into the failing deploy", "", "todo"],
    ["README task", "Worker started; I am waiting for its report.", "progress"],
    ["Status update", "Halfway through the migration.", "progress"],
    // Lasting facts, decisions and promises, including ones that share words with the above.
    ["Acme's contract renews every March", "Dana Okafor signs for them.", undefined],
    ["Always get back to clients in 2 hours", "", undefined],
    ["Owner prefers a reminder in 10 minutes before every call", "", undefined],
    ["Support replies to Acme in 4 hours", "Agreed in the contract.", undefined],
    ["We chose Postgres over SQLite", "Because the reports need concurrent writers.", undefined],
    ["Promised Acme the audit report", "Dana is waiting for it by the 20th.", undefined],
    ["Standup lasts for 15 minutes", "", undefined],
    ["Dana checks whether invoices went out each Friday", "", undefined],
  ] as const)("%s", (title, body, expected) => {
    expect(notMemory(note(title, body))).toBe(expected);
  });
});

describe("writeRefusal", () => {
  const item = (fields: Partial<Parameters<typeof writeRefusal>[0]["item"]> = {}) => ({
    kind: "claim" as const,
    status: "open" as const,
    due: null,
    title: "Acme's contract renews every March",
    body: "Dana Okafor signs for them.",
    ...fields,
  });
  const junk = item({ title: "Get back to the owner after the 60-second pause" });

  it("points a to-do at a reminder and progress at the journal", () => {
    expect(writeRefusal({ op: "create", item: junk }, NOW)).toContain("kin_defer");
    expect(
      writeRefusal(
        { op: "create", item: item({ title: "README task", body: "I'm waiting for the worker." }) },
        NOW,
      ),
    ).toContain("kin_journal");
  });

  it("lets a lasting note through, and always lets junk be closed", () => {
    expect(writeRefusal({ op: "create", item: item() }, NOW)).toBeUndefined();
    expect(writeRefusal({ op: "invalidate", item: junk }, NOW)).toBeUndefined();
    expect(writeRefusal({ op: "update", item: { ...junk, status: "done" } }, NOW)).toBeUndefined();
  });

  it("sends a promise due within the day to a reminder, and keeps one further out", () => {
    const promise = (due: string) =>
      item({ kind: "commitment", title: "Send Acme the audit", due });
    expect(writeRefusal({ op: "create", item: promise("2026-11-11T18:00:00Z") }, NOW)).toContain(
      "under a day away",
    );
    expect(
      writeRefusal({ op: "create", item: promise("2026-11-13T18:00:00Z") }, NOW),
    ).toBeUndefined();
    // A bare date is a day, and a date already past is a record of what was promised.
    expect(writeRefusal({ op: "create", item: promise("2026-11-12") }, NOW)).toBeUndefined();
    expect(
      writeRefusal({ op: "create", item: promise("2026-11-10T18:00:00Z") }, NOW),
    ).toBeUndefined();
  });

  it("refuses a new item too long to be one thing, but not an update to an old one", () => {
    const long = item({ body: "Acme fact. ".repeat(BODY_MAX / 10) });
    expect(writeRefusal({ op: "create", item: long }, NOW)).toContain("one thing");
    expect(writeRefusal({ op: "update", item: long }, NOW)).toBeUndefined();
  });
});

describe("spent", () => {
  const decode = Schema.decodeUnknownSync(MemoryItemHead);
  const stored = (title: string, age: number, fields: Record<string, unknown> = {}) => ({
    head: decode({
      id: "note",
      orgId: "org",
      path: "claims/note.md",
      kind: "claim",
      title,
      status: "open",
      due: null,
      recorded_at: new Date(NOW - age).toISOString(),
      valid_from: new Date(NOW - age).toISOString(),
      invalid_at: null,
      superseded_by: null,
      review_by: null,
      source: "fixture",
      said_by: "fixture",
      trust: "owner",
      links: [],
      ...fields,
    }),
    body: "",
  });
  const followUp = "Get back to the owner after the 60-second pause";

  it("is a follow-up a day old, or a to-do or progress note a week old", () => {
    expect(spent(stored(followUp, 2 * DAY), NOW)).toBe(true);
    expect(spent(stored(followUp, DAY / 2), NOW)).toBe(false);
    expect(spent(stored("Recheck GitHub access", 2 * DAY), NOW)).toBe(false);
    expect(spent(stored("Recheck GitHub access", 8 * DAY), NOW)).toBe(true);
  });

  it("is never a lasting fact, a reminder, or something already closed", () => {
    expect(spent(stored("Acme's contract renews every March", 400 * DAY), NOW)).toBe(false);
    expect(spent(stored(followUp, 2 * DAY, { kind: "deferral" }), NOW)).toBe(false);
    expect(spent(stored(followUp, 2 * DAY, { status: "done" }), NOW)).toBe(false);
    expect(spent(stored(followUp, 2 * DAY, { invalid_at: "2026-11-10" }), NOW)).toBe(false);
  });
});
