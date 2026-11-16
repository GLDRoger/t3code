import { assert, describe, it } from "@effect/vitest";
import { KinAgentId, type KinPulseFact } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { factSig } from "./told.ts";

// Invented facts only.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MONDAY = Date.UTC(2026, 10, 16, 9);
const iso = (ms: number) => DateTime.makeUnsafe(ms);
const fact = (over: Partial<KinPulseFact>): KinPulseFact => ({
  sense: "invoice_overdue",
  family: "money",
  key: "invoice_overdue:INV-9",
  subject: { kind: "record", key: "INV-9", title: "Invented invoice" },
  scope: {},
  since: iso(MONDAY - 10 * DAY),
  consequence: "Invented amount owed",
  actor: { _tag: "owner" },
  sensitive: true,
  wake: "sweep",
  handled: null,
  ...over,
});
const overdue = (days: number) =>
  fact({ measure: { value: days, unit: "days", threshold: 7, from: { _tag: "default" } } });
const dueIn = (hours: number) =>
  fact({
    sense: "task_due_soon",
    measure: { value: hours, unit: "hours", threshold: 24, from: { _tag: "default" } },
  });

describe("what a told fact is compared on", () => {
  it.each([
    { name: "a day older, same chase interval", a: overdue(8), b: overdue(13), same: true },
    { name: "past another chase interval", a: overdue(13), b: overdue(14), same: false },
    { name: "due tomorrow, then due today", a: dueIn(30), b: dueIn(5), same: false },
    { name: "due later today, an hour on", a: dueIn(6), b: dueIn(5), same: true },
    {
      name: "taken in hand",
      a: overdue(8),
      b: fact({
        measure: { value: 8, unit: "days", threshold: 7, from: { _tag: "default" } },
        handled: {
          by: { _tag: "agent", agentId: KinAgentId.make("fin") },
          at: iso(MONDAY),
          until: iso(MONDAY + DAY),
          note: null,
        },
      }),
      same: false,
    },
  ])("$name", ({ a, b, same }) => {
    const at = MONDAY - (a.sense === "task_due_soon" && same === false ? DAY : 0);
    assert.strictEqual(factSig(a, at, "UTC") === factSig(b, MONDAY, "UTC"), same);
  });

  it("a hold that ran out reads as open again", () => {
    const held = fact({
      handled: {
        by: { _tag: "agent", agentId: KinAgentId.make("fin") },
        at: iso(MONDAY - DAY),
        until: iso(MONDAY - HOUR),
        note: null,
      },
    });
    assert.strictEqual(factSig(held, MONDAY, "UTC"), factSig(fact({}), MONDAY, "UTC"));
  });
});
