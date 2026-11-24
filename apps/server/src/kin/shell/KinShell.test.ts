import { assert, it } from "@effect/vitest";
import { KinOrgId, KinPersonId, KinShellRpcs } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as RefreshHub from "../chat/KinRefreshHub.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { KIN_OWNER_LEVEL, type KinViewer, viewerOfPeople } from "../work/teamView.ts";
import * as KinShell from "./KinShell.ts";
import { shellFor } from "./listSections.ts";

const layer = KinShell.layer.pipe(
  Layer.provideMerge(RefreshHub.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);
const orgId = KinOrgId.make("ambermill");
const decodeSet = Schema.decodeEffect(KinShellRpcs[0].payloadSchema);
const rhea = KinPersonId.make("rhea");
const meera = KinPersonId.make("meera");
const zoya = KinPersonId.make("zoya");

it.effect("defaults on; only owner level can set Deals on or off at the current revision", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const shell = yield* KinShell.KinShell;
    const refresh = yield* RefreshHub.KinRefreshHub;
    yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', '2026-11-22')`;
    yield* sql`INSERT INTO kin_people (org_id, person_id, handle, display_name, access, created_at)
      VALUES (${orgId}, ${rhea}, 'rhea', 'Rhea', 'owner', '2026-11-22'),
      (${orgId}, ${meera}, 'meera', 'Meera', 'member', '2026-11-22'),
      (${orgId}, ${zoya}, 'zoya', 'Zoya', 'co_owner', '2026-11-22')`;
    const off = [{ id: "deals", on: false }];
    const refusal = (person: KinPersonId, rev: number, sections: typeof off) =>
      shell.set(orgId, person, rev, sections).pipe(Effect.flip);
    assert.deepStrictEqual(yield* shell.get(orgId), {
      rev: 0,
      sections: ["clients", "deals", "money", "invoices", "docs"].map((id) => ({ id, on: true })),
    });
    assert.equal((yield* refusal(meera, 0, off)).reason, "not_allowed");
    const strangers = KinOrgId.make("strangers");
    assert.equal((yield* Effect.flip(shell.set(strangers, rhea, 0, off))).reason, "not_allowed");
    assert.equal((yield* refusal(rhea, 0, [{ id: "docs", on: false }])).reason, "invalid_state");
    const first = yield* shell.set(orgId, rhea, 0, [...off, { id: "unknown", on: false }]);
    assert.equal(first.rev, 1);
    assert.isFalse(yield* shell.sectionOn(orgId, "deals"));
    assert.isFalse(first.sections.some(({ id }) => id === "unknown"));
    const stale = yield* refusal(rhea, 0, [{ id: "deals", on: true }]);
    assert.equal(stale.reason, "conflict");
    assert.equal(
      stale.message,
      "Someone else changed the sections just now, so nothing was saved. Check them and save again.",
    );
    assert.deepStrictEqual(yield* shell.get(orgId), first);
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* shell.set(orgId, rhea, 1, [{ id: "deals", on: true }]);
          assert.isTrue(yield* shell.sectionOn(orgId, "deals"));
          return yield* Effect.fail("rollback");
        }),
      )
      .pipe(Effect.flip);
    assert.deepStrictEqual(yield* shell.get(orgId), first);
    assert.equal((yield* shell.set(orgId, zoya, 1, [{ id: "deals", on: true }])).rev, 2);
    assert.isTrue(yield* shell.sectionOn(orgId, "deals"));
    const saves = yield* Effect.all(
      [
        Effect.result(shell.set(orgId, rhea, 2, off)),
        Effect.result(shell.set(orgId, zoya, 2, [{ id: "deals", on: true }])),
      ],
      { concurrency: 2 },
    );
    const winner = saves.find((result) => result._tag === "Success");
    const loser = saves.find((result) => result._tag === "Failure");
    assert.equal(winner?.success.rev, 3);
    assert.equal(loser?.failure.reason, "conflict");
    assert.equal(
      loser?.failure.message,
      "Someone else changed the sections just now, so nothing was saved. Check them and save again.",
    );
    assert.deepStrictEqual(yield* shell.get(orgId), winner?.success);
    yield* sql`UPDATE kin_people SET removed_at = 1 WHERE org_id = ${orgId} AND person_id = ${zoya}`;
    assert.equal((yield* refusal(zoya, 3, off)).reason, "not_allowed");
    assert.equal(Option.getOrUndefined(yield* Stream.runHead(refresh.changes(orgId)))?.shell, 3);
    const moneyOff = yield* shell.set(orgId, rhea, 3, [
      { id: "money", on: false },
      { id: "clients", on: true, name: "Donors" },
    ]);
    assert.deepStrictEqual(
      moneyOff.sections.find(({ id }) => id === "invoices"),
      {
        id: "invoices",
        on: true,
      },
    );
    assert.isFalse(KinShell.sectionOn(moneyOff, "invoices"));
    assert.isTrue(KinShell.sectionOn(moneyOff, "deals"));
    const clientsOff = yield* shell.set(orgId, rhea, 4, [
      { id: "clients", on: false, name: "Donors", noun: "donor" },
      { id: "money", on: true },
      { id: "invoices", on: true },
    ]);
    assert.isFalse(KinShell.sectionOn(clientsOff, "deals"));
    assert.isTrue(KinShell.sectionOn(clientsOff, "invoices"));
    const bothOff = yield* shell.set(orgId, rhea, 5, [
      { id: "clients", on: false },
      { id: "invoices", on: false },
    ]);
    assert.isFalse(KinShell.sectionOn(bothOff, "invoices"));
    const invoicesOn = yield* shell.set(orgId, rhea, 6, [
      { id: "clients", on: false },
      { id: "invoices", on: true },
    ]);
    assert.isFalse(KinShell.sectionOn(invoicesOn, "clients"));
    assert.isTrue(KinShell.sectionOn(invoicesOn, "invoices"));
    const resetInput = yield* decodeSet({
      orgId,
      rev: 7,
      shell: { sections: [{ id: "clients", on: true, name: "  ", noun: "" }] },
    });
    const reset = yield* shell.set(orgId, rhea, 7, resetInput.shell.sections);
    assert.deepStrictEqual(reset.sections[0], { id: "clients", on: true });
    yield* sql`DROP TABLE kin_company_shell`;
    assert.equal((yield* refusal(rhea, 8, off)).reason, "unavailable");
    assert.equal(Option.getOrUndefined(yield* Stream.runHead(refresh.changes(orgId)))?.shell, 8);
  }).pipe(Effect.provide(layer)),
);

it.effect("returns one-line service errors for bad section names from the set wire", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const shell = yield* KinShell.KinShell;
    yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', '2026-11-22')`;
    yield* sql`INSERT INTO kin_people (org_id, person_id, handle, display_name, access, created_at)
      VALUES (${orgId}, ${rhea}, 'rhea', 'Rhea', 'owner', '2026-11-22')`;
    for (const [labels, message] of [
      [{ name: "Patients\nStaff" }, "A name is one line of plain text."],
      [{ noun: "patient\t" }, "A name is one line of plain text."],
      [{ name: "Patients\u0000" }, "A name is one line of plain text."],
      [{ noun: "p".repeat(41) }, "A name can be at most 40 characters."],
    ] as const) {
      const decoded = yield* decodeSet({
        orgId,
        rev: 0,
        shell: { sections: [{ id: "clients", on: true, ...labels }] },
      });
      const result = yield* shell.set(orgId, rhea, 0, decoded.shell.sections).pipe(Effect.result);
      assert.deepInclude(result, { _tag: "Failure" });
      if (result._tag === "Failure") assert.equal(result.failure.message, message);
    }
    assert.equal((yield* shell.get(orgId)).rev, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("limits newly docked lists and lets an overfull dock be edited", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const shell = yield* KinShell.KinShell;
    yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', '2026-11-22')`;
    yield* sql`INSERT INTO kin_people (org_id, person_id, handle, display_name, access, created_at)
      VALUES (${orgId}, ${rhea}, 'rhea', 'Rhea', 'owner', '2026-11-22')`;
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
      created_at, definition_json)
      VALUES (${orgId}, 'stock', 'Stock', 'STK', 0, 1, '{}'),
        (${orgId}, 'bookings', 'Bookings', 'BK', 0, 1, '{}'),
        (${orgId}, 'visits', 'Visits', 'VIS', 0, 1, '{}')`;
    const stock = { id: "list:stock", on: true, dock: true };
    const bookings = { id: "list:bookings", on: true, dock: true };
    const visits = { id: "list:visits", on: true, dock: true };
    const clientsOff = { id: "clients", on: false };
    const moneyOff = { id: "money", on: false };
    let current = yield* shell.get(orgId);
    for (const [label, sections, saved] of [
      ["both built-ins on, add one", [stock], false],
      ["Clients off, add one", [clientsOff, stock], true],
      ["Clients off, add a second", [clientsOff, stock, bookings], false],
      ["both built-ins off, add a second", [clientsOff, moneyOff, stock, bookings], true],
      [
        "both built-ins off, store a third switched off",
        [clientsOff, moneyOff, stock, bookings, { ...visits, on: false }],
        true,
      ],
      [
        "both built-ins off, switch on the third",
        [clientsOff, moneyOff, stock, bookings, visits],
        false,
      ],
      ["turn Clients back on", [moneyOff, stock, bookings], true],
      [
        "rename Clients with the dock already overfull",
        [{ id: "clients", on: true, name: "Donors" }, moneyOff, stock, bookings],
        true,
      ],
      ["turn Money back on", [{ id: "clients", on: true, name: "Donors" }, stock, bookings], true],
      [
        "turn a docked list off",
        [{ id: "clients", on: true, name: "Donors" }, stock, { ...bookings, on: false }],
        true,
      ],
    ] as const) {
      const result = yield* Effect.result(shell.set(orgId, rhea, current.rev, sections));
      assert.strictEqual(result._tag, saved ? "Success" : "Failure", label);
      if (result._tag === "Success") {
        assert.equal(result.success.rev, current.rev + 1, label);
        assert.deepInclude(result.success.sections, stock, label);
        current = result.success;
      } else {
        assert.strictEqual(
          result.failure.message,
          "The dock holds five places. Turn one off first.",
          label,
        );
      }
      assert.deepStrictEqual(yield* shell.get(orgId), current, label);
    }
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "keeps a company list as a section after the built-ins, shown only where it reaches",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const shell = yield* KinShell.KinShell;
      yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', '2026-11-22')`;
      yield* sql`INSERT INTO kin_people (org_id, person_id, handle, display_name, access, created_at,
        sees_money)
      VALUES (${orgId}, ${rhea}, 'rhea', 'Rhea', 'owner', '2026-11-22', 0),
      (${orgId}, ${meera}, 'meera', 'Meera', 'member', '2026-11-22', 1)`;
      const list = (id: string, prefix: string, more: object, archivedAt: number | null = null) =>
        sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at,
          definition_json, archived_at)
        VALUES (${orgId}, ${id}, ${id[0]!.toUpperCase() + id.slice(1)}, ${prefix}, 0, 1,
          ${JSON.stringify({ sensitive: false, ...more })}, ${archivedAt})`;
      yield* list("bookings", "BK", { team: true, teamSince: 0 });
      yield* list("payroll", "PAY", { sensitive: true });
      yield* list("stock", "STK", {});
      yield* list("visits", "VIS", {}, 5);
      yield* list("expenses", "EXP", { payments: true });
      const refusal = (sections: ReadonlyArray<{ id: string; on: boolean }>) =>
        shell.set(orgId, rhea, 0, sections).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );
      assert.equal(
        yield* refusal([{ id: "list:visits", on: true }]),
        "There is no list visits to show as a section.",
      );
      assert.equal(
        yield* refusal([{ id: "list:shelves", on: true }]),
        "There is no list shelves to show as a section.",
      );
      assert.equal(
        yield* refusal([{ id: "list:expenses", on: true }]),
        "Expenses has its place in Kin already, so it can't be a section of its own.",
      );
      assert.equal(
        yield* refusal([
          { id: "list:stock", on: true },
          { id: "list:stock", on: false },
        ]),
        "A section can only be set once.",
      );
      const saved = yield* shell.set(orgId, rhea, 0, [
        { id: "clients", on: false },
        { id: "list:stock", on: true, dock: true, name: "Inventory" } as never,
        { id: "deals", on: false },
        { id: "list:payroll", on: true },
        { id: "list:bookings", on: false },
      ]);
      assert.deepStrictEqual(saved.sections.slice(5), [
        { id: "list:stock", on: true, dock: true },
        { id: "list:payroll", on: true },
        { id: "list:bookings", on: false },
      ]);
      assert.isTrue(KinShell.listSectionOn(saved, "stock"));
      assert.isFalse(KinShell.listSectionOn(saved, "bookings"));
      assert.isFalse(KinShell.listSectionOn(saved, "visits"));
      assert.isFalse(KinShell.builtInsOn(saved));
      const lists = (viewer: KinViewer) =>
        shellFor(orgId, viewer).pipe(
          Effect.map(({ sections }) =>
            sections.flatMap(({ id }) => KinShell.listOfSection(id) ?? []),
          ),
        );
      assert.deepStrictEqual(yield* lists(KIN_OWNER_LEVEL), ["stock", "payroll", "bookings"]);
      // A teammate reaches the team list; never a sensitive one, nor one they see nothing of.
      assert.deepStrictEqual(yield* lists(viewerOfPeople([meera])), ["bookings"]);
      // An archived list's section is gone for everyone, and comes back with the list.
      yield* sql`UPDATE kin_registers SET archived_at = 9 WHERE register_id = 'stock'`;
      assert.deepStrictEqual(yield* lists(KIN_OWNER_LEVEL), ["payroll", "bookings"]);
      yield* sql`UPDATE kin_registers SET archived_at = NULL WHERE register_id = 'stock'`;
      assert.deepStrictEqual(yield* lists(KIN_OWNER_LEVEL), ["stock", "payroll", "bookings"]);
      // A list section gates no Work row: open pages hear it on the shell topic, and Work
      // restarts only for a built-in switch that takes effect.
      let restarts = 0;
      const counted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.provideService(effect, RefreshHub.KinWorkRefresh, () =>
          Effect.sync(() => {
            restarts += 1;
          }),
        );
      const refresh = yield* RefreshHub.KinRefreshHub;
      const shellTopic = Effect.map(
        Stream.runHead(refresh.changes(orgId)),
        (head) => Option.getOrUndefined(head)?.shell,
      );
      const docked = yield* counted(
        KinShell.set(orgId, rhea, 1, [
          { id: "deals", on: false },
          { id: "clients", on: false },
          { id: "list:stock", on: true, dock: false },
          { id: "list:payroll", on: true },
          { id: "list:bookings", on: true },
        ]),
      );
      assert.deepStrictEqual([restarts, yield* shellTopic], [0, docked.rev]);
      const shown = yield* counted(
        sql.withTransaction(KinShell.showList(orgId, "bookings", true, rhea)),
      );
      assert.deepStrictEqual([restarts, yield* shellTopic], [0, shown.rev]);
      yield* counted(
        KinShell.set(orgId, rhea, shown.rev, [
          { id: "deals", on: true },
          ...shown.sections.slice(5),
        ]),
      );
      assert.strictEqual(restarts, 1);
      // Taken out again: the setter given the sections without it.
      const out = yield* shell.set(orgId, rhea, 4, [{ id: "list:payroll", on: true }]);
      assert.deepStrictEqual(out.sections.slice(5), [{ id: "list:payroll", on: true }]);
      assert.isTrue(KinShell.builtInsOn(out));
      // A put-away list's section isn't shown to the setter: a save without it keeps it, in its
      // place, and another list is still shown as a section meanwhile.
      const both = yield* shell.set(orgId, rhea, out.rev, [
        { id: "list:stock", on: true },
        { id: "list:payroll", on: true },
      ]);
      yield* sql`UPDATE kin_registers SET archived_at = 9 WHERE register_id = 'stock'`;
      const without = yield* shell.set(orgId, rhea, both.rev, [{ id: "list:payroll", on: false }]);
      assert.deepStrictEqual(without.sections.slice(5), [
        { id: "list:stock", on: true },
        { id: "list:payroll", on: false },
      ]);
      const more = yield* sql.withTransaction(
        KinShell.showList(orgId, "bookings", undefined, rhea),
      );
      assert.deepStrictEqual(
        more.sections.slice(5).map(({ id }) => id),
        ["list:stock", "list:payroll", "list:bookings"],
      );
      yield* sql`UPDATE kin_registers SET archived_at = NULL WHERE register_id = 'stock'`;
      assert.deepStrictEqual(yield* lists(KIN_OWNER_LEVEL), ["stock", "payroll", "bookings"]);
    }).pipe(Effect.provide(layer)),
);
