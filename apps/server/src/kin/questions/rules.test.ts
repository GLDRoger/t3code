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

it("a question's day ends with the next working day, on the person's clock and hours", () => {
  // Monday 11:30 IST: Tuesday 19:30 IST.
  assert.strictEqual(iso(defaultDue(at("2026-11-16T06:00:00Z"), IST)), "2026-11-17T14:00:00.000Z");
  // Monday 23:00 IST, after the day ended: still Tuesday.
  assert.strictEqual(iso(defaultDue(at("2026-11-16T17:30:00Z"), IST)), "2026-11-17T14:00:00.000Z");
  // Friday afternoon and Saturday: Monday.
  assert.strictEqual(iso(defaultDue(at("2026-11-20T09:00:00Z"), IST)), "2026-11-23T14:00:00.000Z");
  assert.strictEqual(iso(defaultDue(at("2026-11-21T09:00:00Z"), IST)), "2026-11-23T14:00:00.000Z");
  // Someone who works Saturdays only.
  const saturdays = { days: [6], start: "10:30", end: "19:30" };
  assert.strictEqual(
    iso(defaultDue(at("2026-11-16T06:00:00Z"), IST, saturdays)),
    "2026-11-21T14:00:00.000Z",
  );
  // No safe default: raised the next working morning at 10:30.
  assert.strictEqual(iso(raiseAt(at("2026-11-17T14:00:00Z"), IST)), "2026-11-18T05:00:00.000Z");
  assert.strictEqual(iso(raiseAt(at("2026-11-20T14:00:00Z"), IST)), "2026-11-23T05:00:00.000Z");
  // Someone who works 8 to 17 on weekdays: their day ends at 17:00, a raise comes at 8:00.
  const early = { days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00" };
  assert.strictEqual(
    iso(defaultDue(at("2026-11-16T06:00:00Z"), IST, early)),
    "2026-11-17T11:30:00.000Z",
  );
  assert.strictEqual(
    iso(raiseAt(at("2026-11-17T11:30:00Z"), IST, early)),
    "2026-11-18T02:30:00.000Z",
  );
  assert.deepStrictEqual(namedDue("2026-11-18", at("2026-11-16T06:00:00Z"), IST, early), {
    at: at("2026-11-18T11:30:00Z"),
  });
  // A night shift's hours cross midnight: the default day stands.
  const night = { days: [1, 2, 3, 4, 5], start: "22:00", end: "06:00" };
  assert.strictEqual(
    iso(defaultDue(at("2026-11-16T06:00:00Z"), IST, night)),
    "2026-11-17T14:00:00.000Z",
  );
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
  // A field named for money is no act of moving it.
  const ways = ["Paid-by + statement match, ~3 days (my pick)", "Full build, ~2 weeks"];
  assert.isTrue(safeDefault(ways[0]!, "Which way for partner reimbursements?", { labels: ways }));
  assert.isFalse(safeDefault("Pay it today", "Shall I settle INV-8?"));
  // Money terms are the owner's: a rate or an amount in any option, or a money record, in any currency.
  const terms = ["40% advance now, rest on milestones", "Full amount on delivery"];
  assert.isFalse(safeDefault(terms[0]!, "How should Orbit pay for P-3?", { labels: terms }));
  assert.isFalse(safeDefault(terms[1]!, "How should Orbit pay for P-3?", { labels: terms }));
  assert.isFalse(safeDefault("Includes GST", "How should Q-4 read?", { aboutMoney: true }));
  assert.isFalse(safeDefault("Hold at ₹40,000", "Orbit's renewal?"));
  assert.isFalse(
    safeDefault("Quote it", "Orbit's renewal?", { labels: ["Quote it", "AED 1,200"] }),
  );
  assert.isFalse(safeDefault("Ja", "Mit 1.500 € abschließen?"));
  assert.isFalse(safeDefault("Yes", "Offer 15 ٪ off?"));
  // Numbers that aren't money, and words that only look like codes, stay safe.
  const plain = ["Draft it for 3 people", "Keep the top 5", "Skip it"];
  assert.isTrue(safeDefault(plain[0]!, "Shall I draft the onboarding notes?", { labels: plain }));
  assert.isTrue(safeDefault("Move it to week 2", "When does P-3 start?", { aboutMoney: false }));
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
