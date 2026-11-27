import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  freeAt,
  heldAt,
  holdRule,
  hoursEndAfter,
  hoursStartAfter,
  KIN_DEFAULT_QUIET_HOURS,
  workingAt,
} from "./quietHours.ts";

const IST = "Asia/Kolkata";
const BERLIN = "Europe/Berlin";
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | undefined) =>
  ms === undefined ? undefined : DateTime.formatIso(DateTime.makeUnsafe(ms));
const NIGHT = { days: [1, 2, 3, 4, 5], start: "22:00", end: "06:00" };
const DAY = { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };

it("hours past midnight run from each of their days into the next morning, on their clock", () => {
  for (const [hours, zone, moment, working] of [
    // Monday to Friday 22:00 to 06:00 in Kolkata: Tuesday 02:00, Tuesday 12:00, Friday 23:00,
    // Saturday 03:00 (Friday's shift) and Saturday 23:00.
    [NIGHT, IST, "2026-11-16T20:30:00Z", true],
    [NIGHT, IST, "2026-11-17T06:30:00Z", false],
    [NIGHT, IST, "2026-11-20T17:30:00Z", true],
    [NIGHT, IST, "2026-11-20T21:30:00Z", true],
    [NIGHT, IST, "2026-11-21T17:30:00Z", false],
    // Monday 22:00 starts it; Tuesday 06:00 ends it; Monday 05:59 follows no Sunday shift.
    [NIGHT, IST, "2026-11-16T16:30:00Z", true],
    [NIGHT, IST, "2026-11-17T00:30:00Z", false],
    [NIGHT, IST, "2026-11-16T00:29:00Z", false],
    // Saturday's shift in Berlin the night the clocks go back: 22:00 CEST to 06:00 CET.
    [{ days: [6], start: "22:00", end: "06:00" }, BERLIN, "2026-10-24T19:59:00Z", false],
    [{ days: [6], start: "22:00", end: "06:00" }, BERLIN, "2026-10-24T20:00:00Z", true],
    [{ days: [6], start: "22:00", end: "06:00" }, BERLIN, "2026-10-25T04:59:00Z", true],
    [{ days: [6], start: "22:00", end: "06:00" }, BERLIN, "2026-10-25T05:00:00Z", false],
    // Day hours as before; hours that start where they end have no minutes.
    [DAY, IST, "2026-11-17T06:30:00Z", true],
    [DAY, IST, "2026-11-17T12:30:00Z", false],
    [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "09:00" }, IST, "2026-11-17T06:30:00Z", false],
  ] as const)
    assert.strictEqual(workingAt(hours, zone, at(moment)), working, `${zone} ${moment}`);
  // When the stretch a moment is in ends, and when the hours next start.
  for (const [hours, zone, moment, ends, starts] of [
    [NIGHT, IST, "2026-11-16T20:30:00Z", "2026-11-17T00:30:00.000Z", "2026-11-17T16:30:00.000Z"],
    [NIGHT, IST, "2026-11-20T21:30:00Z", "2026-11-21T00:30:00.000Z", "2026-11-23T16:30:00.000Z"],
    [DAY, IST, "2026-11-17T06:30:00Z", "2026-11-17T12:30:00.000Z", "2026-11-18T03:30:00.000Z"],
    [
      { days: [6], start: "22:00", end: "06:00" },
      BERLIN,
      "2026-10-24T21:00:00Z",
      "2026-10-25T05:00:00.000Z",
      "2026-10-31T21:00:00.000Z",
    ],
  ] as const) {
    assert.strictEqual(iso(hoursEndAfter(hours, zone, at(moment))), ends, moment);
    assert.strictEqual(iso(hoursStartAfter(hours, zone, at(moment))), starts, moment);
  }
});

it("a night shift holds lines outside it until it starts, and quiet hours inside it hold theirs", () => {
  // Asleep 05:00 to 13:00: the shift's last hour is quiet, the rest of it free.
  const rule = holdRule(IST, { from: "05:00", to: "13:00" }, NIGHT);
  assert.deepStrictEqual(rule.hours, NIGHT);
  for (const [moment, why, free] of [
    // Tuesday 02:00, on Monday's shift: it goes now.
    ["2026-11-16T20:30:00Z", undefined, "2026-11-16T20:30:00.000Z"],
    // Tuesday 05:30, quiet; Tuesday 14:00, off: both wait for Tuesday 22:00.
    ["2026-11-17T00:00:00Z", "quiet", "2026-11-17T16:30:00.000Z"],
    ["2026-11-17T08:30:00Z", "off", "2026-11-17T16:30:00.000Z"],
    // Saturday 03:00 is Friday's shift; Saturday 23:00 waits for Monday 22:00.
    ["2026-11-20T21:30:00Z", undefined, "2026-11-20T21:30:00.000Z"],
    ["2026-11-21T17:30:00Z", "off", "2026-11-23T16:30:00.000Z"],
  ] as const) {
    assert.strictEqual(heldAt(rule, at(moment)), why, moment);
    assert.strictEqual(iso(freeAt(rule, at(moment))), free, moment);
  }
  // A shift wholly inside quiet hours would hold every line for good: only quiet hours hold.
  assert.isUndefined(holdRule(IST, KIN_DEFAULT_QUIET_HOURS, NIGHT).hours);
  assert.deepStrictEqual(holdRule(IST, KIN_DEFAULT_QUIET_HOURS, DAY).hours, DAY);
});

it("hours on the person's own clock are read there, though quiet hours keep another", () => {
  // Quiet hours on Berlin's clock, 09:00 to 18:00 on Kolkata's (04:30 to 13:30 in Berlin).
  const now = at("2026-11-16T00:00:00Z");
  const rule = holdRule(BERLIN, KIN_DEFAULT_QUIET_HOURS, DAY, { zone: IST, at: now });
  assert.strictEqual(rule.hoursZone, IST);
  // Monday 10:00 Kolkata is 05:30 in Berlin, quiet; 17:00 Kolkata goes; 19:00 Kolkata is off.
  assert.strictEqual(heldAt(rule, at("2026-11-16T04:30:00Z")), "quiet");
  assert.isUndefined(heldAt(rule, at("2026-11-16T11:30:00Z")));
  assert.strictEqual(heldAt(rule, at("2026-11-16T13:30:00Z")), "off");
  // 03:00 to 11:00 Kolkata is 22:30 to 06:30 in Berlin, all quiet: only quiet hours hold.
  const early = { days: [1, 2, 3, 4, 5], start: "03:00", end: "11:00" };
  assert.isUndefined(
    holdRule(BERLIN, KIN_DEFAULT_QUIET_HOURS, early, { zone: IST, at: now }).hours,
  );
  assert.deepStrictEqual(holdRule(BERLIN, KIN_DEFAULT_QUIET_HOURS, early).hours, early);
});
