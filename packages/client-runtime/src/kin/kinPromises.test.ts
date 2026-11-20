// @effect-diagnostics globalDate:off - Fixtures read times as a device in each zone does.
import { KinChatId, KinMessageId, type KinPromiseFrom } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatKinTime } from "./kinScreenState.ts";
import {
  kinContractLine,
  kinNoticeDays,
  kinPromiseFromText,
  kinPromiseOf,
  KIN_PROMISES,
} from "./kinPromises.ts";

// Run under TZ=UTC, Pacific/Auckland and America/Los_Angeles: the day is the reader's own.
const day = (at: string) => formatKinTime(new Date(at), new Date("2030-01-01T00:00:00.000Z"));

describe("kinPromiseFromText", () => {
  it("says where a promise was made, on the reader's own day", () => {
    const at = "2026-11-20T09:30:00.000Z";
    const cases: ReadonlyArray<[KinPromiseFrom, string]> = [
      [{ kind: "chat", at }, `From chat, ${day(at)}`],
      [{ kind: "meeting", at }, `From a meeting, ${day(at)}`],
      [{ kind: "mail", at }, `From a mail, ${day(at)}`],
      [{ kind: "meeting" }, "From a meeting"],
      [{ kind: "note", note: "At the site visit" as never }, "At the site visit"],
    ];
    for (const [from, text] of cases) expect(kinPromiseFromText(from)).toBe(text);
    // Late evening in Los Angeles is the next day in Auckland: each reader reads their own.
    const offset = new Date("2026-11-20T23:30:00.000Z");
    const text = kinPromiseFromText({ kind: "chat", at: offset.toISOString() as never });
    expect(text).toBe(`From chat, ${day(offset.toISOString())}`);
    expect(text).toContain(String(offset.getDate()));
  });
});

describe("kinPromiseOf", () => {
  it("marks a promise and opens its message only where the host says the reader may", () => {
    const chatId = KinChatId.make("zoya-growth");
    const messageId = KinMessageId.make("m-said");
    expect(kinPromiseOf({ category: "task" })).toBeNull();
    expect(kinPromiseOf({ category: "obligation" })).toEqual({ from: null, open: null });
    expect(
      kinPromiseOf({ category: "obligation", from: { kind: "chat", chatId, messageId } }),
    ).toEqual({ from: "From chat", open: { chatId, messageId } });
    expect(kinPromiseOf({ category: "obligation", from: { kind: "chat" } })).toEqual({
      from: "From chat",
      open: null,
    });
  });
});

describe("kinContractLine", () => {
  it("reads the renewal and the notice day as calendar days, amber within the heads-up", () => {
    const project = "P-1" as never;
    expect(kinContractLine(undefined)).toBeNull();
    expect(kinContractLine({ project, renewsOn: "2027-03-01" as never })).toEqual({
      text: "Renews 1 Mar",
      soon: false,
    });
    expect(
      kinContractLine({
        project,
        renewsOn: "2027-03-01" as never,
        noticeBy: "2026-12-31" as never,
        soon: true,
      }),
    ).toEqual({ text: "Renews 1 Mar · notice by 31 Dec", soon: true });
  });
});

describe("kinNoticeDays", () => {
  it("takes a whole number of days, 1 to 730, or nothing", () => {
    expect(kinNoticeDays("")).toBeNull();
    expect(kinNoticeDays(" 60 ")).toBe(60);
    for (const text of ["0", "731", "2.5", "sixty", "-3"])
      expect(kinNoticeDays(text)).toEqual({ problem: KIN_PROMISES.noticeDaysProblem });
  });
});
