// @effect-diagnostics globalDate:off - Fixtures build days relative to a fixed clock.
import { assert, it } from "@effect/vitest";
import {
  KinAgentId,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  type KinListDefinition,
  type KinRecord,
} from "@t3tools/contracts";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import type { KinRates } from "./kinCurrency.ts";
import { kinMoneyText, type KinListContext } from "./kinLists.ts";
import { kinSubscriptionsView } from "./kinSubscriptions.ts";

// Invented plans and amounts only.
const def: KinListDefinition = {
  list: "subscriptions",
  name: "Subscriptions",
  prefix: "SUB",
  builtIn: false,
  states: ["open", "done", "dropped"],
  stateLabels: { open: "Active", dropped: "Cancelled" },
  defaultState: "open",
  categories: [],
  fields: [],
  sensitive: false,
  amount: true,
  currency: "INR",
  dateLabel: "Renews on",
  archivedAt: null,
  rev: 1,
  open: 0,
};
const me = KinPersonId.make("invented-owner");
const context: KinListContext = {
  names: { people: new Map(), agents: new Map(), me, zone: "UTC" },
  refs: new Map(),
  now: new Date(2026, 10, 15, 10, 0),
};
const rates: KinRates = {
  home: "INR",
  rates: [{ currency: "USD", rate: "84.25", asOf: "2026-11-10" }],
};
const day = (text: string) => new Date(`${text}T12:00:00`).toISOString();

const CYCLES = { month: 1, quarter: 3, year: 12 } as const;
type Cycle = keyof typeof CYCLES;
const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));
const plan = Arbitrary.all({
  /** What one month of it costs; a quarterly or yearly plan costs that many months at once. */
  perMonth: int(1, 5_000_000),
  currency: Arbitrary.schema(Schema.Literals(["INR", "USD", "JPY"])),
  cycle: Arbitrary.schema(Schema.Literals(["month", "quarter", "year"])),
  cancelled: Arbitrary.schema(Schema.Boolean),
  renews: int(1, 28),
});
type Plan = typeof plan extends Arbitrary.Arbitrary<infer A> ? A : never;
const plans = Arbitrary.array(plan, { maxLength: 8 });

const recordOf = (one: Plan, index: number, cycle: Cycle = one.cycle): KinRecord => ({
  recordId: KinRecordId.make(`rec-${index}`),
  orgId: KinOrgId.make("org"),
  key: `SUB-${index}`,
  title: `Invented ${index}`,
  state: one.cancelled ? "dropped" : "open",
  waitingOn: null,
  owner: { _tag: "agent", agentId: KinAgentId.make("finance") },
  category: null,
  side: "ours",
  dueAt: null,
  dueAllDay: false,
  late: false,
  confirmed: true,
  sensitive: false,
  working: false,
  pullRequest: null,
  rev: 1,
  createdAt: day("2026-01-01"),
  updatedAt: day("2026-01-01"),
  closedAt: one.cancelled ? day("2026-11-01") : null,
  list: "subscriptions",
  amount: { minor: one.perMonth * CYCLES[cycle], currency: one.currency },
  repeat: { every: cycle },
  dateAt: day(`2026-12-${String(one.renews).padStart(2, "0")}`),
});
const viewOf = (records: ReadonlyArray<KinRecord>) =>
  kinSubscriptionsView(def, records, context, rates, "2026-04-01");
const figures = (view: ReturnType<typeof viewOf>) => ({
  monthly: view.monthly,
  monthlyAll: view.monthlyAll,
  runRate: view.runRate,
  missingRates: view.missingRates,
});

it.prop(
  "a plan counts the same a month and a year whether it is billed monthly, quarterly or yearly",
  [plans],
  ([given]) => {
    const asBilled = viewOf(given.map((one, index) => recordOf(one, index)));
    const monthly = viewOf(given.map((one, index) => recordOf(one, index, "month")));
    assert.deepStrictEqual(figures(asBilled), figures(monthly));
  },
);

it.prop(
  "each currency has one line, from its own active plans alone; cancelled ones count for nothing",
  [plans],
  ([given]) => {
    const view = viewOf(given.map((one, index) => recordOf(one, index)));
    const active = new Set<string>(
      given.filter((one) => !one.cancelled).map((one) => one.currency),
    );
    for (const lines of [view.monthly, view.runRate]) {
      const currencies = lines.map((line) => line.currency);
      assert.strictEqual(new Set(currencies).size, currencies.length);
      assert.isTrue(currencies.every((code) => active.has(code)));
      for (const line of lines)
        assert.strictEqual(
          line.estimate === null,
          !rates.rates.some((rate) => rate.currency === line.currency),
          line.currency,
        );
    }
    const kept = viewOf(
      given.flatMap((one, index) => (one.cancelled ? [] : [recordOf(one, index)])),
    );
    assert.deepStrictEqual(figures(view), figures(kept));
  },
);

it.prop(
  "plans billed monthly add up to their exact sum a month, and twelve of it a year",
  [plans],
  ([given]) => {
    const active = given.filter((one) => !one.cancelled);
    const view = viewOf(active.map((one, index) => recordOf(one, index, "month")));
    const sums = new Map<string, number>();
    for (const one of active) sums.set(one.currency, (sums.get(one.currency) ?? 0) + one.perMonth);
    for (const line of view.monthly)
      assert.strictEqual(
        line.text,
        kinMoneyText({ minor: sums.get(line.currency)!, currency: line.currency }),
      );
    for (const line of view.runRate)
      assert.strictEqual(
        line.text,
        kinMoneyText({ minor: 12 * sums.get(line.currency)!, currency: line.currency }),
      );
  },
);
