import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { KinAgentId, KinOrgId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Hub from "./chat/KinChatHub.ts";
import * as Repository from "./chat/KinChatRepository.ts";
import * as Chat from "./chat/KinChatService.ts";
import * as HostBackup from "./hostBackup.ts";
import * as KinPersistence from "./persistence/KinPersistence.ts";
import { KinWakeupError } from "./lead/WakeupRunner.ts";
import { MemoryError } from "./memory/Memory.ts";

const HOUR = 60 * 60 * 1000;
const NOW = 1794009600000;
const orgId = KinOrgId.make("org-ambermill");
const status = (fields: { ok: boolean; lastGoodAt: number | null; error?: string }) =>
  JSON.stringify({ ranAt: NOW, bytes: null, error: "", ...fields });

describe("backupProblem", () => {
  it("is quiet while the last good backup is at most 36 hours old, and says why otherwise", () => {
    const cases: ReadonlyArray<readonly [string | undefined, string | undefined]> = [
      [status({ ok: true, lastGoodAt: NOW - 36 * HOUR }), undefined],
      [
        status({ ok: false, lastGoodAt: NOW - 20 * HOUR, error: "the volume is not mounted." }),
        undefined,
      ],
      [
        status({ ok: true, lastGoodAt: NOW - 37 * HOUR }),
        "This server's last good backup was 37 hours ago. The nightly backup hasn't run since.",
      ],
      [
        status({
          ok: false,
          lastGoodAt: NOW - 3 * 24 * HOUR,
          error: "backup failed its integrity check.",
        }),
        "This server's last good backup was 3 days ago. The last try failed: backup failed its integrity check.",
      ],
      [
        undefined,
        "This server has no good backup on record. Set up or fix the nightly backup (ops/kin/host/README.md, Backups) so a failed disk can't lose the company's data.",
      ],
      [
        "not json",
        "This server has no good backup on record. Set up or fix the nightly backup (ops/kin/host/README.md, Backups) so a failed disk can't lose the company's data.",
      ],
      [
        status({ ok: false, lastGoodAt: null, error: "no database at the data path." }),
        "This server has no good backup on record: the last try failed: no database at the data path. Set up or fix the nightly backup (ops/kin/host/README.md, Backups) so a failed disk can't lose the company's data.",
      ],
    ];
    for (const [file, told] of cases) assert.strictEqual(HostBackup.backupProblem(file, NOW), told);
  });
});

const services = Chat.layer.pipe(
  Layer.provideMerge(Hub.layer),
  Layer.provideMerge(Repository.layer),
  Layer.provideMerge(
    KinPersistence.layer.pipe(
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provideMerge(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ KIN_ENABLED: true, KIN_CHECKOUT: "/srv/kin-current" }),
        ),
      ),
    ),
  ),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-host-backup-" })),
  Layer.provideMerge(NodeServices.layer),
);

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = DateTime.formatIso(DateTime.makeUnsafe(NOW));
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', ${at})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
    VALUES ('rhea', ${orgId}, 'rhea', 'Rhea', ${at})`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at, retired_at)
    VALUES ('chief', ${orgId}, 'Chief of staff', 'lead', 'rhea', ${at}, NULL)`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
    VALUES ('rhea-chief', ${orgId}, 'direct', 'direct', 0, ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
    VALUES ('m-rhea', ${orgId}, 'rhea-chief', 'person', 'rhea', 'owner', ${at})`;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
    VALUES ('chief', ${orgId}, 'Chief of staff', 0, '{}', '[]', 'rhea-chief')`;
});

const notices = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ body: string }>`SELECT body FROM kin_messages
    WHERE org_id = ${orgId} AND chat_id = 'rhea-chief' AND author_kind = 'system' ORDER BY seq`;
  return rows.map((row) => row.body);
});

it.effect("tells the owner once a day while the backup is old, and nothing once it is good", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* seed;
    const fs = yield* FileSystem.FileSystem;
    const file = (yield* Path.Path).join(
      (yield* ServerConfig.ServerConfig).stateDir,
      HostBackup.BACKUP_STATUS_FILE,
    );
    // No backup ever set up: once a week.
    yield* HostBackup.check();
    yield* HostBackup.check();
    yield* TestClock.adjust(24 * HOUR);
    yield* HostBackup.check();
    assert.lengthOf(yield* notices, 1);
    yield* TestClock.adjust(6 * 24 * HOUR);
    yield* HostBackup.check();
    assert.lengthOf(yield* notices, 2);
    // One that worked and has gone old: once a day.
    const old = status({ ok: false, lastGoodAt: NOW, error: "the volume is not mounted." });
    yield* fs.writeFileString(file, old);
    yield* HostBackup.check();
    yield* HostBackup.check();
    assert.lengthOf(yield* notices, 3);
    yield* TestClock.adjust(24 * HOUR);
    yield* HostBackup.check();
    assert.lengthOf(yield* notices, 4);
    yield* fs.writeFileString(file, status({ ok: true, lastGoodAt: NOW + 8 * 24 * HOUR }));
    yield* TestClock.adjust(24 * HOUR);
    yield* HostBackup.check();
    assert.deepStrictEqual(yield* notices, [
      HostBackup.backupProblem(undefined, NOW),
      HostBackup.backupProblem(undefined, NOW),
      HostBackup.backupProblem(old, NOW + 7 * 24 * HOUR),
      HostBackup.backupProblem(old, NOW + 8 * 24 * HOUR),
    ]);
  }).pipe(Effect.provide(services)),
);

// The shape a wake-up failed with on a host whose /tmp quota was full.
const wakeupFailure = (errno: number, code: string) =>
  Cause.fail(
    new KinWakeupError({
      orgId,
      agentId: KinAgentId.make("chief"),
      cause: new MemoryError({
        orgId,
        operation: "prepareWakeup",
        cause: PlatformError.systemError({
          _tag: "Unknown",
          module: "FileSystem",
          method: "writeFile",
          pathOrDescriptor: "/tmp/kin-x/config",
          cause: Object.assign(new Error(code), { errno, code, syscall: "open" }),
        }),
      }),
    }),
  );

it.effect.each([
  { errno: -122, code: "Unknown system error -122" },
  { errno: -28, code: "ENOSPC" },
])("tells the owner once a day when a wake-up fails for want of space ($code)", ({ errno, code }) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* seed;
    yield* HostBackup.tellIfOutOfSpace(orgId, wakeupFailure(errno, code));
    yield* HostBackup.tellIfOutOfSpace(orgId, wakeupFailure(errno, code));
    assert.deepStrictEqual(yield* notices, [HostBackup.OUT_OF_SPACE]);
    yield* TestClock.adjust(24 * HOUR);
    yield* HostBackup.tellIfOutOfSpace(orgId, wakeupFailure(errno, code));
    assert.lengthOf(yield* notices, 2);
  }).pipe(Effect.provide(services)),
);

it.effect("tells nobody when a wake-up fails for another reason", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    yield* seed;
    yield* HostBackup.tellIfOutOfSpace(orgId, wakeupFailure(-13, "EACCES"));
    yield* HostBackup.tellIfOutOfSpace(orgId, Cause.die(new Error("provider exited")));
    assert.lengthOf(yield* notices, 0);
  }).pipe(Effect.provide(services)),
);

const space =
  (left: Record<string, number>) =>
  (folder: string): Effect.Effect<Option.Option<HostBackup.SpaceReading>> =>
    Effect.succeedSome({ folder, freeBytes: left[folder] ?? 100, totalBytes: 100 });

it.effect(
  "tells the owner once a day when a disk is under 20% free, and nothing it can't read",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* seed;
      yield* HostBackup.warnIfLowOnSpace(orgId, ["/kin-tmp", "/home"], space({ "/kin-tmp": 20 }));
      assert.lengthOf(yield* notices, 0);
      yield* HostBackup.warnIfLowOnSpace(orgId, ["/kin-tmp", "/home"], space({ "/home": 19 }));
      yield* HostBackup.warnIfLowOnSpace(orgId, ["/kin-tmp", "/home"], space({ "/home": 5 }));
      assert.deepStrictEqual(yield* notices, [HostBackup.LOW_ON_SPACE]);
      yield* TestClock.adjust(24 * HOUR);
      const missing = (yield* Path.Path).join((yield* ServerConfig.ServerConfig).stateDir, "gone");
      yield* HostBackup.warnIfLowOnSpace(orgId, [missing]);
      assert.lengthOf(yield* notices, 1);
    }).pipe(Effect.provide(services)),
);
