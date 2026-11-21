// @effect-diagnostics globalDate:off - Fixtures build days and times relative to a fixed clock.
import { describe, expect, it } from "@effect/vitest";
import { kinAwayLine, kinAwayProblem, kinMessageOnMyClock, kinWhenText } from "./kinAway.ts";
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
    expect(kinAwayLine(zoya, { mine: true, short: true, zone: "Europe/London", now })).toBe(
      "Until Thu Nov 19 (India Standard Time)",
    );
    expect(kinAwayLine({ ...zoya, awayUntil: undefined }, { mine: false, now })).toBeNull();
  });

  it("takes only a day after today on their calendar", () => {
    // 01:30 on the 18th in Kolkata: the 18th is today there, not tomorrow.
    expect(kinAwayProblem("2026-11-18", now, "Asia/Kolkata")).not.toBeNull();
    expect(kinAwayProblem("2026-11-18", now, "America/New_York")).toBeNull();
  });
});
