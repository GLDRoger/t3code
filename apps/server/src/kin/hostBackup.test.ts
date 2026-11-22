import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  KIN_HOST_TROUBLE_CARD,
  KinAgentId,
  KinEventId,
  KinHostTroubleCard,
  KinOrgId,
  type KinTroubleCause,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Hub from "./chat/KinChatHub.ts";
import * as Repository from "./chat/KinChatRepository.ts";
import * as Chat from "./chat/KinChatService.ts";
import * as HostBackupCheck from "./host/backupCheck.ts";
import * as KinHostCare from "./host/KinHostCare.ts";
import { troubleCause, troubleDetail } from "./host/troubleCauses.ts";
import * as HostBackup from "./hostBackup.ts";
import * as KinEventQueue from "./lead/KinEventQueue.ts";
import * as KinPersistence from "./persistence/KinPersistence.ts";
import { KinWakeupError } from "./lead/WakeupRunner.ts";
import { MemoryError } from "./memory/Memory.ts";

const HOUR = 60 * 60 * 1000;
const NOW = 1794009600000;
const orgId = KinOrgId.make("org-ambermill");
const status = (fields: { ok: boolean; lastGoodAt: number | null; error?: string }) =>
  JSON.stringify({ ranAt: NOW, bytes: null, error: "", ...fields });

describe("backupProblem", () => {
  it("is quiet while the last good backup is at most 36 hours old, and names the last good one otherwise", () => {
    const cases: ReadonlyArray<
      readonly [string | undefined, { readonly lastGoodAt: number | null } | undefined]
    > = [
      [status({ ok: true, lastGoodAt: NOW - 36 * HOUR }), undefined],
      [
        status({ ok: false, lastGoodAt: NOW - 20 * HOUR, error: "the volume is not mounted." }),
        undefined,
      ],
      [status({ ok: true, lastGoodAt: NOW - 37 * HOUR }), { lastGoodAt: NOW - 37 * HOUR }],
      [
        status({
          ok: false,
          lastGoodAt: NOW - 72 * HOUR,
          error: "backup failed its integrity check.",
        }),
        { lastGoodAt: NOW - 72 * HOUR },
      ],
      [undefined, { lastGoodAt: null }],
      ["not json", { lastGoodAt: null }],
      [
        status({ ok: false, lastGoodAt: null, error: "no database at the data path." }),
        { lastGoodAt: null },
      ],
    ];
    for (const [file, told] of cases)
      assert.deepStrictEqual(HostBackup.backupProblem(file, NOW), told);
  });
});

const config = (fields: Record<string, unknown>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true, ...fields }));
const servicesWith = (fields: Record<string, unknown>) =>
  KinHostCare.layer.pipe(
    Layer.provideMerge(KinEventQueue.layer),
    Layer.provideMerge(Chat.layer),
    Layer.provideMerge(Hub.layer),
    Layer.provideMerge(Repository.layer),
    Layer.provideMerge(
      KinPersistence.layer.pipe(
        Layer.provideMerge(Sqlite.layerMemory),
        Layer.provideMerge(config(fields)),
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-host-backup-" })),
    Layer.provideMerge(NodeServices.layer),
  );
const services = servicesWith({ KIN_CHECKOUT: "/srv/kin-current" });

// 10:00 in Kolkata, outside the owner's quiet hours (22:00 to 07:00 there).
const DAY_START = NOW + 4.5 * HOUR;

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = DateTime.formatIso(DateTime.makeUnsafe(NOW));
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', ${at})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
    VALUES ('rhea', ${orgId}, 'rhea', 'Rhea', ${at})`;
  yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'Asia/Kolkata', '08:00', '18:00',
    '02:00', 0, 1, '09:00', '{"from":"22:00","to":"07:00"}')`;
  for (const [agent, name, chat] of [
    ["chief", "Chief of staff", "rhea-chief"],
    ["finance", "Finance", "rhea-finance"],
  ] as const) {
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at, retired_at)
      VALUES (${agent}, ${orgId}, ${name}, 'lead', 'rhea', ${at}, NULL)`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
      VALUES (${chat}, ${orgId}, 'direct', ${chat}, 0, ${at})`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
      VALUES (${`m-${chat}`}, ${orgId}, ${chat}, 'person', 'rhea', 'owner', ${at})`;
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
      VALUES (${agent}, ${orgId}, ${name}, 0, '{}', '[]', ${chat})`;
  }
});

const notices = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ body: string }>`SELECT body FROM kin_messages
    WHERE org_id = ${orgId} AND chat_id = 'rhea-chief' AND author_kind = 'system' ORDER BY seq`;
  return rows.map((row) => row.body);
});

const decodeCard = Schema.decodeUnknownSync(Schema.fromJsonString(KinHostTroubleCard));
const cards = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ state: string; closed: string | null; awaiting: string }>`SELECT
      state_json AS state, closed_at AS closed, awaiting_json AS awaiting FROM kin_widgets
    WHERE org_id = ${orgId} AND type = ${KIN_HOST_TROUBLE_CARD} ORDER BY widget_id`;
  return rows.map((row) => ({
    ...decodeCard(row.state),
    open: row.closed === null,
    awaiting: row.awaiting,
  }));
});

it.effect(
  "keeps one backup notice open outside quiet hours, and closes it once a backup is good",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* seed;
      const fs = yield* FileSystem.FileSystem;
      const file = (yield* Path.Path).join(
        (yield* ServerConfig.ServerConfig).stateDir,
        HostBackup.BACKUP_STATUS_FILE,
      );
      // 05:30 in the owner's zone: it waits for the morning.
      yield* HostBackupCheck.check();
      assert.lengthOf(yield* cards, 0);
      yield* TestClock.setTime(DAY_START);
      yield* HostBackupCheck.check();
      yield* HostBackupCheck.check();
      yield* TestClock.adjust(24 * HOUR);
      yield* HostBackupCheck.check();
      assert.deepStrictEqual(
        (yield* cards).map((card) => [
          card.cause,
          card.open,
          card.backupConfigured,
          card.lastGoodAt,
        ]),
        [["backup", true, false, undefined]],
      );
      assert.lengthOf(yield* notices, 1);
      // An old good backup: the same notice, now naming it.
      const lastGood = NOW - 24 * HOUR;
      yield* fs.writeFileString(
        file,
        status({ ok: false, lastGoodAt: lastGood, error: "the volume is not mounted." }),
      );
      yield* HostBackupCheck.check();
      assert.deepStrictEqual(
        (yield* cards).map((card) => [card.open, card.lastGoodAt]),
        [[true, DateTime.formatIso(DateTime.makeUnsafe(lastGood))]],
      );
      yield* fs.writeFileString(file, status({ ok: true, lastGoodAt: DAY_START + 24 * HOUR }));
      yield* HostBackupCheck.check();
      assert.deepStrictEqual(
        (yield* cards).map((card) => card.open),
        [false],
      );
      assert.lengthOf(yield* notices, 1);
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
const provider = (fields: {
  class: "usage_limit" | "provider_error" | "transport_error" | "permission_error" | "unknown";
  message: string;
  code?: string;
  resetAt?: string;
}) => ({ code: null, retryable: null, ...fields });

describe("troubleCause", () => {
  it("reads each cause from the failure's own chain, and an unknown one stays unknown", () => {
    const cases: ReadonlyArray<readonly [unknown, KinTroubleCause]> = [
      [wakeupFailure(-122, "Unknown system error -122"), "space"],
      [wakeupFailure(-28, "ENOSPC"), "space"],
      [
        provider({
          class: "provider_error",
          message: "Error: ENOSPC: no space left on device, write",
        }),
        "space",
      ],
      [
        provider({ class: "provider_error", message: "Disk quota exceeded (os error 122)" }),
        "space",
      ],
      [
        provider({
          class: "provider_error",
          message: "Invalid API key",
          code: "authentication_failed",
        }),
        "signin",
      ],
      [
        provider({ class: "permission_error", message: "Forbidden", code: "api_error_403" }),
        "access",
      ],
      [
        provider({
          class: "provider_error",
          message: "model: claude-x not found",
          code: "api_error_404",
        }),
        "model",
      ],
      [
        provider({
          class: "provider_error",
          message: "Claude Code: program exited before the turn started",
        }),
        "program",
      ],
      [
        provider({
          class: "usage_limit",
          message: "Claude API rate limit reached. Try again later.",
          code: "api_error_429",
          resetAt: "2026-11-07T06:00:00.000Z",
        }),
        "usage_limit",
      ],
      [provider({ class: "transport_error", message: "stream disconnected" }), "unreachable"],
      [
        provider({ class: "provider_error", message: "Overloaded", code: "api_error_529" }),
        "unreachable",
      ],
      [wakeupFailure(-61, "ECONNREFUSED"), "unreachable"],
      [wakeupFailure(-13, "EACCES"), "unknown"],
      [Cause.die(new Error("provider exited")), "unknown"],
      [
        provider({ class: "provider_error", message: "Something odd", code: "api_error_400" }),
        "unknown",
      ],
      [null, "unknown"],
    ];
    for (const [failure, cause] of cases) assert.strictEqual(troubleCause(failure), cause);
    assert.strictEqual(
      troubleDetail(Cause.die(new Error("provider exited\nat line 2"))),
      "provider exited",
    );
  });
});

const queued = (eventId: string, agent: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at,
        queued_at, state, not_before, attempts)
      VALUES (${eventId}, ${orgId}, ${agent}, 'chat.message', 'P1', '{}', ${NOW}, ${NOW}, 'queued',
        ${NOW + 5 * 60_000}, 0)`;
    return KinEventId.make(eventId);
  });

it.effect("makes one notice per cause whose count goes up, and closes it when a turn runs", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DAY_START);
    yield* seed;
    const care = yield* KinHostCare.KinHostCare;
    const sql = yield* SqlClient.SqlClient;
    const chief = KinAgentId.make("chief");
    const finance = KinAgentId.make("finance");
    const first = yield* queued("e1", "chief");
    const second = yield* queued("e2", "finance");
    yield* care.failed({ orgId, agentId: chief, cause: "space", eventIds: [first] });
    // The same turn failing again holds nothing new.
    yield* care.failed({ orgId, agentId: chief, cause: "space", eventIds: [first] });
    yield* care.failed({ orgId, agentId: finance, cause: "space", eventIds: [second] });
    yield* care.failed({ orgId, agentId: finance, cause: "signin", eventIds: [second] });
    assert.deepStrictEqual(
      (yield* cards).map((card) => [
        card.cause,
        card.count,
        card.agents.map((one) => one.name),
        card.open,
        card.awaiting,
      ]),
      [
        ["signin", 1, ["Finance"], true, "[]"],
        ["space", 2, ["Chief of staff", "Finance"], true, "[]"],
      ],
    );
    // Two notices, each one message: one push each, however many turns they count. The message
    // says what is wrong; the card carries the count and the way out.
    assert.deepStrictEqual((yield* notices).toSorted(), [
      "Kin's computer ran out of space, so Chief of staff couldn't work. Kin cleared out old temporary files, but that wasn't enough.",
      "The AI account behind Finance is signed out, so it couldn't work.",
    ]);
    assert.isTrue(yield* care.troubleOpen(orgId, "space"));
    // A scheduled task's "couldn't finish" line says why, from the open notice.
    assert.strictEqual(yield* care.causeFor(orgId, chief), "space");
    // Chief of staff ran a turn: space is back for everyone, but Finance is still signed out.
    yield* care.succeeded(orgId, chief);
    assert.isUndefined(yield* care.causeFor(orgId, chief));
    assert.deepStrictEqual(
      (yield* cards).map((card) => [card.cause, card.open, card.closed?.ran]),
      [
        ["signin", true, undefined],
        ["space", false, 2],
      ],
    );
    const events = yield* sql<{ eventId: string; notBefore: number }>`SELECT event_id AS "eventId",
      not_before AS "notBefore" FROM kin_events WHERE org_id = ${orgId} ORDER BY event_id`;
    assert.deepStrictEqual(events, [
      { eventId: "e1", notBefore: DAY_START },
      { eventId: "e2", notBefore: DAY_START },
    ]);
    // A new failure for space after it closed opens a fresh notice.
    yield* care.failed({ orgId, agentId: chief, cause: "space", eventIds: [first] });
    assert.deepStrictEqual(
      (yield* cards).map((card) => [card.cause, card.open]),
      [
        ["signin", true],
        ["space", false],
        ["space", true],
      ],
    );
    // Try again runs exactly the held turns; they stay listed until a turn proves the cause gone.
    yield* sql`UPDATE kin_events SET not_before = ${DAY_START + HOUR}`;
    assert.deepStrictEqual(yield* care.retry(orgId), { requeued: 2 });
  }).pipe(Effect.provide(services)),
);

const space =
  (left: Record<string, number>) =>
  (folder: string): Effect.Effect<Option.Option<HostBackup.SpaceReading>> =>
    Effect.succeedSome({ folder, freeBytes: left[folder] ?? 100, totalBytes: 100 });

it.effect(
  "clears temporary files at once when a disk is under 20% free, and tells the owner once a day only when that wasn't enough",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* seed;
      let cleans = 0;
      const clean = Effect.sync(() => {
        cleans += 1;
        return { ran: true };
      });
      yield* HostBackup.warnIfLowOnSpace(
        orgId,
        ["/kin-tmp", "/home"],
        space({ "/kin-tmp": 20 }),
        clean,
      );
      assert.strictEqual(cleans, 0);
      // The clean gave enough back: nobody hears of it.
      let left = 5;
      const freed = Effect.sync(() => {
        left = 50;
        return { ran: true };
      });
      yield* HostBackup.warnIfLowOnSpace(
        orgId,
        ["/home"],
        (folder) => space({ "/home": left })(folder),
        freed,
      );
      assert.lengthOf(yield* notices, 0);
      yield* HostBackup.warnIfLowOnSpace(
        orgId,
        ["/kin-tmp", "/home"],
        space({ "/home": 19 }),
        clean,
      );
      yield* HostBackup.warnIfLowOnSpace(
        orgId,
        ["/kin-tmp", "/home"],
        space({ "/home": 5 }),
        clean,
      );
      assert.strictEqual(cleans, 2);
      assert.deepStrictEqual(yield* notices, [HostBackup.LOW_ON_SPACE]);
      yield* TestClock.adjust(24 * HOUR);
      const missing = (yield* Path.Path).join((yield* ServerConfig.ServerConfig).stateDir, "gone");
      yield* HostBackup.warnIfLowOnSpace(orgId, [missing]);
      assert.lengthOf(yield* notices, 1);
    }).pipe(Effect.provide(services)),
);
