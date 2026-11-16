import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  dayWord,
  defaultDue,
  endingQuestion,
  namedDue,
  normaliseAbout,
  normaliseIntent,
  raiseAt,
  repeats,
  safeDefault,
} from "./rules.ts";

const IST = "Asia/Kolkata";
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

it("a question's day is 19:30 at the end of the next working day, on the person's clock", () => {
  // Monday 11:30 IST: Tuesday 19:30 IST.
  assert.strictEqual(iso(defaultDue(at("2026-11-16T06:00:00Z"), IST)), "2026-11-17T14:00:00.000Z");
  // Monday 23:00 IST, after the day ended: still Tuesday.
  assert.strictEqual(iso(defaultDue(at("2026-11-16T17:30:00Z"), IST)), "2026-11-17T14:00:00.000Z");
  // Friday afternoon and Saturday: Monday.
  assert.strictEqual(iso(defaultDue(at("2026-11-20T09:00:00Z"), IST)), "2026-11-23T14:00:00.000Z");
  assert.strictEqual(iso(defaultDue(at("2026-11-21T09:00:00Z"), IST)), "2026-11-23T14:00:00.000Z");
  // Someone who works Saturdays only.
  assert.strictEqual(
    iso(defaultDue(at("2026-11-16T06:00:00Z"), IST, [6])),
    "2026-11-21T14:00:00.000Z",
  );
  // No safe default: raised the next working morning at 10:30.
  assert.strictEqual(iso(raiseAt(at("2026-11-17T14:00:00Z"), IST)), "2026-11-18T05:00:00.000Z");
  assert.strictEqual(iso(raiseAt(at("2026-11-20T14:00:00Z"), IST)), "2026-11-23T05:00:00.000Z");
});

it("a named day is 19:30 that day, and refused when past or more than a month out", () => {
  const now = at("2026-11-16T06:00:00Z");
  assert.deepStrictEqual(namedDue("2026-11-18", now, IST), { at: at("2026-11-18T14:00:00Z") });
  assert.deepStrictEqual(namedDue("2026-11-16", now, IST), { at: at("2026-11-16T14:00:00Z") });
  for (const bad of ["2026-11-15", "2027-01-30", "Wednesday", "2026-13-01"])
    assert.property(namedDue(bad, now, IST), "refused", bad);
});

it("the same intent about a shared record repeats; anything Kin can't tell is let through", () => {
  const finance = {
    intent: normaliseIntent("Draft the payment reminders"),
    about: normaliseAbout(["inv-8", "INV-9", "not a key"]),
  };
  assert.strictEqual(finance.intent, "draft payment reminder");
  assert.deepStrictEqual(finance.about, ["INV-8", "INV-9"]);
  const chief = { intent: normaliseIntent("should I draft a payment reminder"), about: ["INV-8"] };
  assert.isTrue(repeats(chief, finance));
  // Another intent, no shared record, or nothing to compare: allowed.
  assert.isFalse(
    repeats({ intent: normaliseIntent("send payment reminders"), about: ["INV-8"] }, finance),
  );
  assert.isFalse(repeats({ ...chief, about: ["INV-3"] }, finance));
  assert.isFalse(repeats({ ...chief, about: [] }, finance));
  assert.isFalse(repeats({ intent: "", about: ["INV-8"] }, finance));
});

it("a default that sends or moves money is never safe to take alone", () => {
  assert.isTrue(safeDefault("Draft it", "Shall I draft VIOM's payment reminder?"));
  assert.isTrue(safeDefault("Call it finished", "Is P-3 finished?"));
  assert.isFalse(safeDefault(null, "Anything?"));
  assert.isFalse(safeDefault("Send it Wednesday", "Shall I send VIOM the reminder?"));
  // A bare yes reads its question.
  assert.isFalse(safeDefault("Yes", "Shall I send VIOM the reminder?"));
  assert.isFalse(safeDefault("Yes", "Mark INV-8 paid?"));
});

it("a reply that ends on a question gives that sentence; others give none", () => {
  assert.strictEqual(
    endingQuestion("Logged the call with Orbit.\n\nShould I move the launch to Friday?"),
    "Should I move the launch to Friday?",
  );
  assert.strictEqual(endingQuestion("Done. Want the list too?**"), "Want the list too?");
  assert.isUndefined(endingQuestion("Is it Friday? I moved it to Friday."));
  assert.isUndefined(endingQuestion("Done."));
});

it("days are said on the person's clock", () => {
  const now = at("2026-11-16T06:00:00Z");
  assert.strictEqual(dayWord(now, now, IST), "today");
  assert.strictEqual(dayWord(at("2026-11-17T14:00:00Z"), now, IST), "tomorrow");
  assert.strictEqual(dayWord(at("2026-11-18T14:00:00Z"), now, IST), "on Wednesday");
  assert.strictEqual(dayWord(at("2026-11-30T14:00:00Z"), now, IST), "on Mon 30 Nov");
});
