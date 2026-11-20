import { assert, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { KinOrgId } from "@t3tools/contracts";
import * as Arbitrary from "effect/Arbitrary";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { moneySummary } from "./moneyViews.ts";
import { KIN_OWNER_LEVEL } from "./teamView.ts";
import { daysOverdue, endOfDay, owedInvoices, startOfDay, termsDays } from "./recordRows.ts";

// Invented org, clients, invoices and payments only.
const orgId = KinOrgId.make("org");
const NOW = Date.parse("2026-11-12T06:00:00.000Z");
const DAY = 86_400_000;

const int = (min: number, max: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: min, maximum: max })));
const pick = <const L extends ReadonlyArray<string>>(literals: L) =>
  Arbitrary.schema(Schema.Literals(literals));
const pickOrNull = <const L extends ReadonlyArray<string>>(literals: L) =>
  Arbitrary.schema(Schema.NullOr(Schema.Literals(literals)));
const flag = Arbitrary.schema(Schema.Boolean);
const maybe = <A>(arb: Arbitrary.Arbitrary<A>) =>
  Arbitrary.all([flag, arb]).pipe(Arbitrary.map(([some, value]) => (some ? value : null)));

/** A few days either side of now, to the millisecond around each day boundary. */
const when = maybe(
  Arbitrary.all([int(-3, 3), int(-1, 1)]).pipe(
    Arbitrary.map(([days, edge]) => NOW + days * DAY + edge),
  ),
);

const invoice = Arbitrary.all({
  state: pick(["open", "waiting", "done", "dropped"]),
  amount: maybe(int(1, 5_000_000)),
  currency: pick(["INR", "USD"]),
  party: pickOrNull(["c1", "c2"]),
  dueAt: when,
  dateAt: when,
  payments: Arbitrary.array(Arbitrary.all({ share: int(1, 100), voided: flag }), {
    maxLength: 4,
  }),
  /** False for one an agent suggested and nobody confirmed. */
  confirmed: flag,
});
type Invoice = typeof invoice extends Arbitrary.Arbitrary<infer A> ? A : never;
const invoices = Arbitrary.array(invoice, { maxLength: 8 });
const TERM_FORMS = ["Net {n}", "net{n}", "{n} days", "{n} day", "{n}-day terms", "within {n} days"];
/** Each client's terms: days near now, written as people write them, or none that name days. */
const terms = Arbitrary.all({
  c1: maybe(Arbitrary.all([int(0, 4), pick(TERM_FORMS)])),
  c2: pickOrNull(["50% advance", "On delivery"]),
}).pipe(
  Arbitrary.map(({ c1, c2 }) => ({
    c1: c1 === null ? null : c1[1].replace("{n}", String(c1[0])),
    c2,
  })),
);
/** An issued invoice with no due date. */
const undated = (party: Invoice["party"], dateAt: number): Invoice => ({
  state: "waiting",
  amount: 100,
  currency: "INR",
  party,
  dueAt: null,
  dateAt,
  payments: [],
  confirmed: true,
});
type Terms = typeof terms extends Arbitrary.Arbitrary<infer A> ? A : never;

/** Payments as recording allows them: in the invoice's currency, never past what it still owes. */
const paymentsOf = (one: Invoice) => {
  let paid = 0;
  return one.payments.flatMap(({ share, voided }) => {
    if (one.amount === null) return [];
    const minor = Math.max(1, Math.floor((one.amount * share) / 100));
    if (!voided && paid + minor > one.amount) return [];
    if (!voided) paid += minor;
    return [{ minor, voided }];
  });
};

/** What each invoice still owes, written from the rules rather than the query. */
const expected = (all: ReadonlyArray<Invoice>, given: Terms) =>
  all.flatMap((one, i) => {
    if (one.state !== "waiting" || one.amount === null || !one.confirmed) return [];
    const paid = paymentsOf(one)
      .filter((p) => !p.voided)
      .reduce((sum, p) => sum + p.minor, 0);
    const owed = one.amount - paid;
    const days = one.party === null ? undefined : termsDays(given[one.party]);
    const due =
      one.dueAt ?? (one.dateAt === null || days === undefined ? null : one.dateAt + days * DAY);
    return owed > 0
      ? [
          {
            id: `i${i + 1}`,
            owed,
            currency: one.currency,
            party: one.party,
            overdue: due !== null && due < NOW,
          },
        ]
      : [];
  });

const testLayer = KinPersistence.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-owed-" })),
  Layer.provideMerge(NodeServices.layer),
);

const install = (all: ReadonlyArray<Invoice>, given: Terms) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [made] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_orgs`;
    if ((made?.n ?? 0) === 0) {
      yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Co', '2026-11-11')`;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at, definition_json)
        VALUES (${orgId}, 'clients', 'Clients', 'C', 1, ${NOW}, '{}'),
          (${orgId}, 'invoices', 'Invoices', 'INV', 0, ${NOW}, '{"sensitive":true}')`;
    }
    yield* sql`DELETE FROM kin_record_payments WHERE org_id = ${orgId}`;
    yield* sql`DELETE FROM kin_records WHERE org_id = ${orgId}`;
    const row = (id: string, list: string, title: string) =>
      sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
          owner_id, created_by_kind, origin_key, created_at, updated_at)
        VALUES (${orgId}, ${id}, ${list}, ${id.toUpperCase()}, ${title}, 'person', 'owner',
          'system', ${id}, ${NOW}, ${NOW})`;
    yield* row("c1", "clients", "Client one");
    yield* row("c2", "clients", "Client two");
    for (const [id, text] of Object.entries(given))
      yield* sql`UPDATE kin_records SET fields_json = ${JSON.stringify(text === null ? {} : { terms: text })}
        WHERE org_id = ${orgId} AND record_id = ${id}`;
    for (const [i, one] of all.entries()) {
      const id = `i${i + 1}`;
      yield* row(id, "invoices", `Invoice ${i + 1}`);
      yield* sql`UPDATE kin_records SET state = ${one.state}, amount_minor = ${one.amount},
          currency = ${one.amount === null ? null : one.currency}, party_id = ${one.party},
          due_at = ${one.dueAt}, date_at = ${one.dateAt}, sensitive = 1,
          confirmed = ${one.confirmed ? 1 : 0}
        WHERE org_id = ${orgId} AND record_id = ${id}`;
      for (const [j, p] of paymentsOf(one).entries())
        yield* sql`INSERT INTO kin_record_payments (org_id, payment_id, record_id, amount_minor,
            currency, paid_on, origin_key, created_at, created_by_kind, voided_at)
          VALUES (${orgId}, ${`${id}-${j}`}, ${id}, ${p.minor}, ${one.currency}, '2026-11-01',
            ${`${id}-${j}`}, ${NOW}, 'system', ${p.voided ? NOW : null})`;
    }
  });

/** Per-currency sums, each currency once. */
const sums = (rows: ReadonlyArray<{ owed: number; currency: string }>) =>
  Object.fromEntries(
    [...new Set(rows.map((r) => r.currency))].map((c) => [
      c,
      rows.filter((r) => r.currency === c).reduce((sum, r) => sum + r.owed, 0),
    ]),
  );
const asSums = (money: ReadonlyArray<{ minor: number; currency: string }>) => {
  assert.strictEqual(new Set(money.map((m) => m.currency)).size, money.length, "a currency twice");
  return Object.fromEntries(money.map((m) => [m.currency, m.minor]));
};

layer(testLayer)("money owed", (it) => {
  it.effect.prop(
    "each issued invoice owes its amount less payments not taken back, and is overdue only past its due day, else its client's terms",
    [invoices, terms],
    ([all, given]) =>
      Effect.gen(function* () {
        yield* install(all, given);
        const owed = yield* owedInvoices({ orgId, now: NOW });
        const want = expected(all, given);
        assert.deepStrictEqual(
          owed
            .map((one) => ({
              id: one.recordId,
              owed: one.balance.minor,
              currency: one.balance.currency,
              party: one.partyId,
              overdue: one.overdue,
            }))
            .toSorted((a, b) => a.id.localeCompare(b.id)),
          want.toSorted((a, b) => a.id.localeCompare(b.id)),
        );
        for (const one of owed) assert.isAbove(one.balance.minor, 0);
      }),
  );

  it.effect.prop(
    "a client's total is the sum of its invoices, one figure per currency",
    [invoices, terms],
    ([all, given]) =>
      Effect.gen(function* () {
        yield* install(all, given);
        const summary = yield* moneySummary(orgId, NOW, KIN_OWNER_LEVEL);
        const want = expected(all, given);
        assert.deepStrictEqual(asSums(summary.owed.total), sums(want));
        assert.deepStrictEqual(asSums(summary.owed.overdue), sums(want.filter((w) => w.overdue)));
        const parties = [...new Set(want.map((w) => w.party))];
        assert.strictEqual(summary.owed.byClient.length, parties.length);
        for (const client of summary.owed.byClient) {
          const party = client.party === null ? null : client.party.recordId;
          const mine = want.filter((w) => w.party === party);
          assert.deepStrictEqual(asSums(client.owed), sums(mine), `owed by ${party}`);
          assert.deepStrictEqual(
            asSums(client.overdue),
            sums(mine.filter((w) => w.overdue)),
            `overdue from ${party}`,
          );
          assert.strictEqual(client.invoices, mine.length);
        }
        // What no figure counts is listed on its own, for the owner to keep or decline.
        assert.deepStrictEqual(
          (summary.suggested ?? []).map((one) => one.record.recordId).toSorted(),
          all
            .flatMap((one, i) => (!one.confirmed && one.state !== "dropped" ? [`i${i + 1}`] : []))
            .toSorted(),
        );
      }),
  );

  // K080: no due date and no terms is never overdue; Net 30 is overdue on day 31.
  it.effect("an invoice with no due date falls due on its client's terms, or never", () =>
    Effect.gen(function* () {
      const dayOne = NOW - 30 * DAY;
      const overdue = (party: "c1" | "c2", c1: string | null) =>
        install([undated(party, dayOne)], { c1, c2: null }).pipe(
          Effect.andThen(owedInvoices({ orgId, now: NOW })),
          Effect.map((rows) => rows.map((one) => one.overdue)),
        );
      assert.deepStrictEqual(yield* overdue("c2", null), [false]);
      assert.deepStrictEqual(yield* overdue("c1", "Net 30"), [false]);
      assert.deepStrictEqual(yield* overdue("c1", "Net 29"), [true]);
      assert.deepStrictEqual(yield* overdue("c1", "50% advance"), [false]);
    }),
  );

  it.effect.prop(
    "however a client's terms write a number of days, the invoice is given that many, in SQL too",
    [int(0, 999), pick([...TERM_FORMS, "Net {n}, else {n}0 days", "Due in {n} weeks", "Payday"])],
    ([days, form]) =>
      Effect.gen(function* () {
        const text = form.replaceAll("{n}", String(days));
        if (TERM_FORMS.includes(form))
          assert.strictEqual(termsDays(text), days <= 365 ? days : undefined);
        yield* install([undated("c1", NOW)], { c1: text, c2: null });
        const [one] = yield* owedInvoices({ orgId, now: NOW });
        const given = one === undefined || one.dueAt === null ? undefined : (one.dueAt - NOW) / DAY;
        assert.strictEqual(given, termsDays(text), text);
      }),
  );

  it.effect.prop(
    "days overdue are whole calendar days in the company's zone, wherever the server's clock is",
    [
      pick(["UTC", "Pacific/Auckland", "America/Los_Angeles", "Asia/Kolkata"]),
      int(0, 400),
      int(0, 60),
      // Under 23 hours, so a day that loses one to daylight saving still holds it.
      int(0, 23 * 3_600_000 - 1),
    ],
    ([zone, from, late, into]) =>
      Effect.sync(() => {
        const day = (offset: number) =>
          DateTime.formatIsoDate(DateTime.makeUnsafe(Date.UTC(2026, 0, 1) + offset * DAY));
        const now = startOfDay(day(from + late), zone) + into;
        assert.strictEqual(daysOverdue(endOfDay(day(from), zone), now, zone), late);
      }),
  );

  it.effect("an invoice due the 8th is 12 days overdue on the 20th, and due today is none", () =>
    Effect.sync(() => {
      const now = Date.parse("2026-11-20T10:38:00.000+05:30");
      assert.strictEqual(
        daysOverdue(endOfDay("2026-11-08", "Asia/Kolkata"), now, "Asia/Kolkata"),
        12,
      );
      assert.strictEqual(
        daysOverdue(endOfDay("2026-11-20", "Asia/Kolkata"), now, "Asia/Kolkata"),
        0,
      );
    }),
  );
});
