// @effect-diagnostics globalDate:off - Fixtures build days and times relative to a fixed clock.
import { describe, expect, it } from "@effect/vitest";
import {
  kinAwayLine,
  kinAwayProblem,
  kinArrivesText,
  kinMessageOnMyClock,
  kinWhenText,
} from "./kinAway.ts";
import type { KinMessage } from "@t3tools/contracts";

import { makeKinFixtureMessages } from "./kinChatFixtures.ts";

const kinMessage = (fields: Partial<KinMessage>): KinMessage => ({
  ...makeKinFixtureMessages(1)[0]!,
  ...fields,
});

const when = {
  at: "2026-11-19T04:30:00.000Z",
  zone: "Asia/Kolkata",
  text: "10:00 their time (Thu Nov 19)",
  of: "Zoya Sheikh",
};

describe("a held message's time, on each reader's clock", () => {
  it("reads as written on the receiver's clock and as the reader's own elsewhere, naming whose", () => {
    expect(kinWhenText(when, "Asia/Calcutta")).toBe(when.text);
    expect(kinWhenText(when, "Europe/London")).toBe(
      "4:30 AM your time (Thu Nov 19), 10:00 AM for Zoya Sheikh",
    );
    // The daily limit's notice names no one: the reader's own time alone.
    expect(
      kinWhenText(
        { at: "2026-11-18T01:30:00.000Z", zone: "Asia/Kolkata", text: "7:00 am" },
        "America/New_York",
      ),
    ).toBe("8:30 PM your time (Tue Nov 17)");
  });

  it("rewrites only the time in the body, and leaves a message without one alone", () => {
    const held = kinMessage({
      body: `Zoya Sheikh is away: it arrives at ${when.text}.`,
      when,
    });
    expect(kinMessageOnMyClock(held, "Europe/London").body).toBe(
      "Zoya Sheikh is away: it arrives at 4:30 AM your time (Thu Nov 19), 10:00 AM for Zoya Sheikh.",
    );
    const plain = kinMessage({ body: "Hello" });
    expect(kinMessageOnMyClock(plain, "Europe/London")).toBe(plain);
  });
});

describe("the note under a request that waits for someone", () => {
  // 07:00 on Sat 21 Nov in Kolkata.
  const rhea = {
    at: "2026-11-21T01:30:00.000Z",
    zone: "Asia/Kolkata",
    text: "07:00 their time (Sat 21 Nov)",
    of: "Rhea Kapoor",
  };
  it.each([
    [
      "Rhea's own zone",
      "Asia/Kolkata",
      "Rhea Kapoor will see your request at 7:00 AM (Sat Nov 21).",
    ],
    [
      "UTC",
      "UTC",
      "Rhea Kapoor will see your request at 7:00 AM their time (Sat Nov 21), 1:30 AM your time.",
    ],
    [
      "Auckland",
      "Pacific/Auckland",
      "Rhea Kapoor will see your request at 7:00 AM their time (Sat Nov 21), 2:30 PM your time.",
    ],
    [
      "Bogota, a day behind",
      "America/Bogota",
      "Rhea Kapoor will see your request at 7:00 AM their time (Sat Nov 21), 8:30 PM your time (Fri Nov 20).",
    ],
  ])("names the person and their time, read in %s", (_name, zone, line) => {
    expect(kinArrivesText(rhea, zone)).toBe(line);
  });

  it("replaces Kin's held-request note, and no other message naming a time", () => {
    const note = kinMessage({
      messageId: "kin-arrives:relay-1" as KinMessage["messageId"],
      body: `In Rhea Kapoor's quiet hours: it arrives at ${rhea.text}.`,
      when: rhea,
    });
    expect(kinMessageOnMyClock(note, "Asia/Kolkata").body).toBe(
      "Rhea Kapoor will see your request at 7:00 AM (Sat Nov 21).",
    );
    const limit = kinMessage({
      messageId: "kin-arrives:limit" as KinMessage["messageId"],
      body: "Back at 7:00 am",
      when: { at: rhea.at, zone: rhea.zone, text: "7:00 am" },
    });
    expect(kinMessageOnMyClock(limit, "Asia/Kolkata")).toBe(limit);
  });
});

describe("away until a day", () => {
  const now = new Date("2026-11-17T20:00:00.000Z");
  it("names whose calendar when the reader's differs", () => {
    const zoya = { awayUntil: "2026-11-19", timeZone: "Asia/Kolkata", displayName: "Zoya" };
    expect(kinAwayLine(zoya, { mine: true, zone: "Asia/Kolkata", now })).toBe(
      "You're away until Thu Nov 19",
    );
    expect(kinAwayLine(zoya, { mine: false, zone: "Europe/London", now })).toBe(
      "Away until Thu Nov 19 (India Standard Time)",
    );
    expect(kinAwayLine({ ...zoya, awayUntil: undefined }, { mine: false, now })).toBeNull();
  });

  it("takes only a day after today on their calendar", () => {
    // 01:30 on the 18th in Kolkata: the 18th is today there, not tomorrow.
    expect(kinAwayProblem("2026-11-18", now, "Asia/Kolkata")).not.toBeNull();
    expect(kinAwayProblem("2026-11-18", now, "America/New_York")).toBeNull();
  });
});
