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
import * as KinShell from "./KinShell.ts";

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
    assert.deepInclude(yield* refusal(rhea, 0, [{ id: "clients", on: false }]), {
      reason: "invalid_state",
      message: "Turn off Invoices and quotes first: an invoice needs a client.",
    });
    assert.deepInclude(
      yield* refusal(rhea, 0, [
        { id: "clients", on: false },
        { id: "money", on: false },
      ]),
      {
        reason: "invalid_state",
        message: "Turn off Invoices and quotes first: an invoice needs a client.",
      },
    );
    assert.equal((yield* refusal(rhea, 0, [{ id: "docs", on: false }])).reason, "invalid_state");
    const first = yield* shell.set(orgId, rhea, 0, [...off, { id: "unknown", on: false }]);
    assert.equal(first.rev, 1);
    assert.isFalse(yield* shell.sectionOn(orgId, "deals"));
    assert.isFalse(first.sections.some(({ id }) => id === "unknown"));
    const stale = yield* refusal(rhea, 0, [{ id: "deals", on: true }]);
    assert.equal(stale.reason, "conflict");
    assert.equal(
      stale.message,
      "Someone changed this since you opened it. Nothing was saved; open it again.",
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
      "Someone changed this since you opened it. Nothing was saved; open it again.",
    );
    assert.deepStrictEqual(yield* shell.get(orgId), winner?.success);
    yield* sql`UPDATE kin_people SET removed_at = 1 WHERE org_id = ${orgId} AND person_id = ${zoya}`;
    assert.equal((yield* refusal(zoya, 3, off)).reason, "not_allowed");
    assert.equal(Option.getOrUndefined(yield* Stream.runHead(refresh.changes(orgId)))?.shell, 3);
    const moneyOff = yield* shell.set(orgId, rhea, 3, [{ id: "money", on: false }]);
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
      { id: "clients", on: false },
      { id: "invoices", on: false },
    ]);
    assert.isFalse(KinShell.sectionOn(clientsOff, "deals"));
    assert.deepInclude(
      yield* refusal(rhea, 5, [
        { id: "invoices", on: true },
        { id: "clients", on: false },
      ]),
      {
        reason: "invalid_state",
        message: "Turn on Clients first: an invoice needs a client.",
      },
    );
    const resetInput = yield* decodeSet({
      orgId,
      rev: 5,
      shell: { sections: [{ id: "clients", on: true, name: "  ", noun: "" }] },
    });
    const reset = yield* shell.set(orgId, rhea, 5, resetInput.shell.sections);
    assert.deepStrictEqual(reset.sections[0], { id: "clients", on: true });
    yield* sql`DROP TABLE kin_company_shell`;
    assert.equal((yield* refusal(rhea, 6, off)).reason, "unavailable");
    assert.equal(Option.getOrUndefined(yield* Stream.runHead(refresh.changes(orgId)))?.shell, 6);
  }).pipe(Effect.provide(layer)),
);
