import { assert, it } from "@effect/vitest";
import { KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { KinDeferralGithubReader } from "../triggers/deferralGithub.ts";
import { readNowState } from "./nowState.ts";

const orgId = KinOrgId.make("tidewater");
const owner = KinPersonId.make("rhea");
const layer = KinPersistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect("live state limits eligible connections to 30 and counts the rest", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Tidewater Freight', '2026-11-01T00:00:00Z')`;
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, access, created_at)
      VALUES (${owner}, ${orgId}, 'rhea', 'Rhea', 'owner', '2026-11-01T00:00:00Z')`;
    yield* sql`WITH RECURSIVE n(i) AS (VALUES (1) UNION ALL SELECT i + 1 FROM n WHERE i < 36)
      INSERT INTO kin_connections (org_id, connection_id, label, kind, url_host, auth,
        reach, state, created_at, updated_at, paused_at, removed_at)
      SELECT ${orgId}, printf('mail-%02d', i), printf('Mailbox %02d', i), 'remote',
        'mail.tidewater.example', 'none', 'closed', CASE WHEN i = 2 THEN 'error'
          WHEN i = 3 THEN 'needs_review' ELSE 'active' END, 0, 0,
        CASE WHEN i = 1 THEN 1 END, CASE WHEN i = 36 THEN 1 END FROM n`;
    const now = yield* readNowState({
      orgId,
      owner,
      at: Date.parse("2026-11-09T09:00:00Z"),
      zone: "UTC",
      links: [],
    });
    assert.deepStrictEqual(now.lines, [
      "Mailbox 01: paused",
      "Mailbox 02: needs a look in Settings › Connections",
      "Mailbox 03: needs a look in Settings › Connections",
      ...Array.from(
        { length: 27 },
        (_, i) => `Mailbox ${String(i + 4).padStart(2, "0")}: signed in`,
      ),
      "and 5 more connections",
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("the GitHub budget leaves an unread link beside links that could be checked", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const read = yield* readNowState({
      orgId,
      owner,
      at: Date.parse("2026-11-09T09:00:00Z"),
      zone: "UTC",
      links: ["https://github.com/tidewater/site/pull/9", "tidewater/app#41"],
    }).pipe(
      Effect.provideService(KinDeferralGithubReader, {
        readRepo: (_org, repo) =>
          repo === "tidewater/site"
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(new Map([[41, { state: "merged", assignees: [], linkedPrs: [] }]])),
      }),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("10 seconds");
    const now = yield* Fiber.join(read);
    assert.deepStrictEqual(now.lines, [
      "https://github.com/tidewater/site/pull/9: Kin couldn't check it now",
      "tidewater/app#41: merged",
    ]);
  }).pipe(Effect.provide(layer)),
);
