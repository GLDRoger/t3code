import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  ARCHIVIST_MIN_NEW_NOTES,
  ARCHIVIST_MIN_NEW_WILLS,
  CHRONICLE_MAX_BYTES,
  CHRONICLE_MAX_AGE_HOURS,
  archivistScope,
  countNew,
  deterministicDigest,
  fitChronicle,
  formatChronicle,
  memoryKeeperScope,
  parseAsOf,
  passNumber,
  planSession,
  readChronicle,
  renderSummarizerPrompt,
  renderVerbatimWills,
  shouldRunPass,
  utf8ByteLength,
  validEntries,
  type KeeperEntry,
} from "./chronicle.ts";

const T0 = "2026-10-24T12:00:00.000Z";
const now = DateTime.makeUnsafe(T0);

const will = (id: string, at: string, body = `will ${id}`): KeeperEntry => ({
  id,
  kind: "will",
  at,
  body,
});

const note = (id: string, at: string, body = `note ${id}`): KeeperEntry => ({
  id,
  kind: "note",
  at,
  body,
});

const hoursAfter = (iso: string, hours: number, extraMs = 0) =>
  DateTime.makeUnsafe(
    DateTime.toEpochMillis(DateTime.makeUnsafe(iso)) + hours * 60 * 60 * 1000 + extraMs,
  );

describe("keeper trigger", () => {
  it("opens on 8 new wills or 30 new notes, and stays shut under either bar", () => {
    const trigger = archivistScope("proj").trigger;
    const wills = Array.from({ length: ARCHIVIST_MIN_NEW_WILLS }, (_, index) =>
      will(`w${index}`, `2026-10-24T11:0${index}:00.000Z`),
    );
    expect(shouldRunPass(countNew(wills, null), trigger)).toBe(true);
    expect(shouldRunPass(countNew(wills.slice(0, 7), null), trigger)).toBe(false);

    const notes = Array.from({ length: ARCHIVIST_MIN_NEW_NOTES }, (_, index) =>
      note(`n${index}`, "2026-10-24T11:30:00.000Z"),
    );
    expect(shouldRunPass(countNew(notes, null), trigger)).toBe(true);
    expect(shouldRunPass(countNew(notes.slice(0, 29), null), trigger)).toBe(false);
    expect(
      shouldRunPass(countNew([...wills.slice(0, 7), ...notes.slice(0, 29)], null), trigger),
    ).toBe(false);
  });

  it("counts only entries newer than the last As-of time", () => {
    const entries = [
      will("old", "2026-10-24T10:00:00.000Z"),
      will("new", "2026-10-24T13:00:00.000Z"),
    ];
    const since = DateTime.toEpochMillis(DateTime.makeUnsafe(T0));
    expect(countNew(entries, since)).toEqual({ wills: 1, notes: 0, entries: 1 });
  });

  it("uses the entry gate for the life scope", () => {
    const trigger = memoryKeeperScope("nishchay").trigger;
    const days: KeeperEntry[] = Array.from({ length: 30 }, (_, index) => ({
      id: `d${index}`,
      kind: "day",
      at: "2026-10-24T11:00:00.000Z",
      body: "day",
    }));
    expect(shouldRunPass(countNew(days, null), trigger)).toBe(true);
    expect(shouldRunPass(countNew(days.slice(0, 29), null), trigger)).toBe(false);
    expect(memoryKeeperScope("nishchay").id).toBe("life:nishchay");
  });
});

describe("chronicle readers", () => {
  const text = formatChronicle(T0, "A stable digest.");

  it("accepts a timestamped chronicle that is 12 hours old and within 24 KB", () => {
    expect(text.startsWith(`As of ${T0}`)).toBe(true);
    expect(readChronicle(text, now).status).toBe("fresh");
    expect(readChronicle(text, hoursAfter(T0, CHRONICLE_MAX_AGE_HOURS)).status).toBe("fresh");
    const padded = text + "a".repeat(CHRONICLE_MAX_BYTES - utf8ByteLength(text));
    expect(utf8ByteLength(padded)).toBe(CHRONICLE_MAX_BYTES);
    expect(readChronicle(padded, now).status).toBe("fresh");
  });

  it("ignores a missing timestamp, age past 12 hours, and size past 24 KB", () => {
    expect(readChronicle("No stamp\n", now)).toMatchObject({ reason: "no-timestamp" });
    expect(readChronicle("As of not-a-time\n", now)).toMatchObject({ reason: "no-timestamp" });
    expect(readChronicle(text, hoursAfter(T0, CHRONICLE_MAX_AGE_HOURS, 1))).toMatchObject({
      reason: "stale",
    });
    const oversized = `${text}${"a".repeat(CHRONICLE_MAX_BYTES)}`;
    expect(readChronicle(oversized, now)).toMatchObject({ reason: "too-large" });
  });

  it("fits an oversized summary under the cap without dropping the As-of line", () => {
    const fitted = fitChronicle(formatChronicle(T0, "あ".repeat(20_000)), CHRONICLE_MAX_BYTES);
    expect(utf8ByteLength(fitted)).toBeLessThanOrEqual(CHRONICLE_MAX_BYTES);
    expect(parseAsOf(fitted)).toBe(T0);
    expect(fitted).toContain("[truncated]");
    expect(readChronicle(fitted, now).status).toBe("fresh");
  });
});

describe("verbatim wills and summarizer input", () => {
  it("appends only wills newer than As-of, with their bodies unchanged", () => {
    const body = "Ship the gate.\nDo not soften it.";
    const section = renderVerbatimWills(
      [
        will("later", "2026-10-24T13:00:00.000Z", body),
        will("same", T0, "already in the chronicle"),
        will("earlier-id", "2026-10-24T12:30:00.000Z", "first of the new"),
        note("n", "2026-10-24T13:00:00.000Z", "not a will"),
      ],
      T0,
    );
    expect(section).toContain(body);
    expect(section.indexOf("earlier-id")).toBeLessThan(section.indexOf("later"));
    expect(section).not.toContain("already in the chronicle");
    expect(section).not.toContain("not a will");
  });

  it("builds the model prompt from raw entries and never from a chronicle", () => {
    const planted = "As of 2026-10-01T00:00:00.000Z\n\n# Earlier chronicle";
    const entries = validEntries([
      will("b", "2026-10-24T11:05:00.000Z", "second"),
      will("a", "2026-10-24T11:00:00.000Z", "first raw will"),
    ]);
    const prompt = renderSummarizerPrompt({
      rebuilt: true,
      entries,
      model: { provider: "inherit", model: "cheap", reuseSession: true },
    });
    expect(prompt).toContain("first raw will");
    expect(prompt).toContain("This pass rebuilds from the raw sources.");
    expect(prompt).not.toContain(planted);
    expect(prompt.indexOf("## will a")).toBeLessThan(prompt.indexOf("## will b"));
    const incremental = renderSummarizerPrompt({
      rebuilt: false,
      entries,
      model: { provider: "inherit", model: "cheap", reuseSession: true },
    });
    expect(incremental).not.toContain("This pass rebuilds");
  });

  it("digests the same primary sources to the same text regardless of input order", () => {
    const left = [will("b", "2026-10-24T11:05:00.000Z"), will("a", "2026-10-24T11:00:00.000Z")];
    expect(deterministicDigest(validEntries(left))).toBe(
      deterministicDigest(validEntries([...left].reverse())),
    );
  });
});

describe("passes and sessions", () => {
  const model = { provider: "codex", model: "cheap", reuseSession: true } as const;

  it("rebuilds every 4th pass and reuses the session until then", () => {
    expect(passNumber(null, 4)).toEqual({ pass: 1, rebuilt: false });
    expect(passNumber(3, 4)).toEqual({ pass: 4, rebuilt: true });
    const first = planSession({
      scopeId: "repo:p",
      pass: 1,
      rebuilt: false,
      previousSessionId: null,
      model,
    });
    const second = planSession({
      scopeId: "repo:p",
      pass: 2,
      rebuilt: false,
      previousSessionId: first.sessionId,
      model,
    });
    const fourth = planSession({
      scopeId: "repo:p",
      pass: 4,
      rebuilt: true,
      previousSessionId: first.sessionId,
      model,
    });
    expect(second).toEqual({ sessionId: first.sessionId, reused: true });
    expect(fourth.reused).toBe(false);
    expect(fourth.sessionId).not.toBe(first.sessionId);
  });

  it("mints a new session when the provider cannot keep one", () => {
    const stateless = { provider: "http", model: "cheap", reuseSession: true } as const;
    const next = planSession({
      scopeId: "repo:p",
      pass: 2,
      rebuilt: false,
      previousSessionId: "repo:p#1",
      model: stateless,
    });
    expect(next.reused).toBe(false);
  });
});
