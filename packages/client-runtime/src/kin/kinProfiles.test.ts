import { describe, expect, it } from "@effect/vitest";
import { KinPersonId } from "@t3tools/contracts";

import {
  kinHoursLine,
  kinParseRoleTags,
  kinProfileChanges,
  kinProfileDraft,
  kinTimeZoneChoices,
} from "./kinProfiles.ts";

const profile = {
  personId: KinPersonId.make("asha"),
  displayName: "Asha",
  handle: "asha",
  pictureId: null,
  roleTags: ["tech"],
  skills: "SwiftUI",
  timeZone: "Asia/Kolkata",
  workHours: { days: [1, 2, 3, 4, 5], start: "10:00", end: "19:00" },
};

describe("kinProfiles", () => {
  it("turns what someone typed into role tags the host accepts", () => {
    expect(kinParseRoleTags(" Tech, iOS / Sales,tech ,, Front End ")).toEqual([
      "tech",
      "ios",
      "sales",
      "front-end",
    ]);
    expect(kinParseRoleTags("a,b,c,d,e,f,g")).toHaveLength(6);
  });

  it("reads hours as a run of days or a list", () => {
    expect(kinHoursLine(profile.workHours)).toBe("Mon–Fri 10:00–19:00");
    expect(kinHoursLine({ days: [1, 3], start: "09:00", end: "13:00" })).toBe(
      "Mon, Wed 09:00–13:00",
    );
    expect(kinHoursLine(null)).toBeNull();
  });

  it("sends only what changed, and refuses what the host would", () => {
    const draft = kinProfileDraft(profile);
    expect(kinProfileChanges(profile, draft)).toEqual({ ok: true, changes: {} });
    expect(kinProfileChanges(profile, { ...draft, tags: "tech, design", days: [] })).toEqual({
      ok: true,
      changes: { roleTags: ["tech", "design"], workHours: null },
    });
    expect(kinProfileChanges(profile, { ...draft, talkStyle: " Short. " })).toEqual({
      ok: true,
      changes: { talkStyle: "Short." },
    });
    expect(kinProfileChanges(profile, { ...draft, displayName: " " }).ok).toBe(false);
    expect(kinProfileChanges(profile, { ...draft, start: "9am" }).ok).toBe(false);
  });
});

describe("kinTimeZoneChoices", () => {
  it("finds a zone by the words people type, and keeps the one held", () => {
    expect(kinTimeZoneChoices("Asia/Kolkata", "new york")).toContain("America/New_York");
    expect(kinTimeZoneChoices("Invented/Zone", "invented")).toEqual(["Invented/Zone"]);
    expect(kinTimeZoneChoices("Asia/Kolkata", "").length).toBeLessThanOrEqual(40);
  });
});
