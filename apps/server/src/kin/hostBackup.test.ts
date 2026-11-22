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
import * as ProcessRunner from "../processRunner.ts";
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

/**
 * The host's commands, answered without running anything: `du` reads invented sizes (no test walks
 * a real folder), and the clean script isn't there. `seen` gets each command and its arguments.
 */
const fakeRunner = (seen: Array<ReadonlyArray<string>> = []) =>
  Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.sync(() => {
          seen.push([input.command, ...(input.args ?? [])]);
          const du = input.command === "du";
          return {
            stdout: du ? `1024\t${input.args?.at(-1) ?? ""}\n` : "",
            stderr: du ? "" : "not here",
            code: (du ? 0 : 127) as never,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    }),
  );

const config = (fields: Record<string, unknown>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true, ...fields }));
const servicesWith = (
  fields: Record<string, unknown>,
  runner: Layer.Layer<ProcessRunner.ProcessRunner> = fakeRunner(),
) =>
  KinHostCare.layerWithoutRunner.pipe(
    Layer.provide(runner),
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

it.effect(
  "measures Kin's folders once an hour of use, not once for every hour the clock passed",
  () => {
    const seen: Array<ReadonlyArray<string>> = [];
    const walks = () => seen.filter(([command]) => command === "du").length;
    return Effect.gen(function* () {
      const care = yield* KinHostCare.KinHostCare;
      // Starting up measures (data, temporary files, builds, update backups), and so does the first
      // look once the clock is a day on.
      yield* TestClock.setTime(NOW);
      yield* care.status(orgId);
      yield* TestClock.adjust("1 minute");
      const looked = walks();
      assert.isAtMost(looked, 8);
      // A day passes with nobody looking: nothing walks.
      yield* TestClock.adjust(24 * HOUR);
      assert.strictEqual(walks(), looked);
      // Two looks an hour on measure once between them.
      yield* care.status(orgId);
      yield* care.status(orgId);
      yield* TestClock.adjust("1 minute");
      assert.strictEqual(walks(), looked + 4);
    }).pipe(Effect.provide(servicesWith({ KIN_CHECKOUT: "/srv/kin-current" }, fakeRunner(seen))));
  },
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

describe("usingText", () => {
  const GB = 1024 ** 3;
  const usage = (temporary: number, builds: number | null, backups: number | null) => ({
    temporary: temporary * GB,
    builds: builds === null ? null : builds * GB,
    backups: backups === null ? null : backups * GB,
    data: 3 * GB,
    measuredAt: "2026-11-22T09:00:00.000Z",
  });

  it("splits the space as Settings does, and says plainly when Kin can't make room alone", () => {
    assert.strictEqual(
      KinHostCare.usingText(usage(40, 10, 20), { freeBytes: 0, totalBytes: 100 * GB }),
      "What's using the space: temporary files 40 GB, Kin's data 33 GB, everything else on this computer 27 GB.",
    );
    assert.strictEqual(
      KinHostCare.usingText(usage(1, null, 2), { freeBytes: 0, totalBytes: 200 * GB }),
      "What's using the space: everything else on this computer 194 GB, Kin's data 5.0 GB, temporary files 1.0 GB. Kin can't free this by itself: it can clear about 3.0 GB of the 200 GB in use. Whoever set up Kin's computer can make room.",
    );
    assert.strictEqual(KinHostCare.usingText(null, undefined), undefined);
  });
});

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
      // SQLite says so when its database, or the disk under it, is full.
      [Cause.die(new Error("database or disk is full")), "space"],
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

// Held as a trouble holds a turn: until a time still ahead.
const HELD_UNTIL = DAY_START + 5 * 60_000;
const queued = (eventId: string, agent: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at,
        queued_at, state, not_before, attempts)
      VALUES (${eventId}, ${orgId}, ${agent}, 'chat.message', 'P1', '{}', ${NOW}, ${NOW}, 'queued',
        ${HELD_UNTIL}, 0)`;
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
    // The space message goes on to read this computer's real disk; usingText's own test pins that.
    const [spaceNotice, signinNotice] = (yield* notices).toSorted();
    assert.isTrue(
      spaceNotice?.startsWith(
        "Kin's computer ran out of space, so Chief of staff couldn't work. Kin cleared out old temporary files, but that wasn't enough.",
      ),
    );
    assert.strictEqual(
      signinNotice,
      "The AI account behind Finance is signed out, so it couldn't work.",
    );
    assert.isTrue(yield* care.troubleOpen(orgId, "space"));
    // A scheduled task's "couldn't finish" line says why, from the open notice.
    assert.strictEqual((yield* care.causeFor(orgId, chief))?.cause, "space");
    // Chief of staff ran a turn: space is back for everyone, but Finance is still signed out.
    yield* care.succeeded(orgId, chief);
    assert.isUndefined(yield* care.causeFor(orgId, chief));
    // Closed, its held turns woken: none has run yet, and the notice says only what has.
    assert.deepStrictEqual(
      (yield* cards).map((card) => [card.cause, card.open, card.closed?.ran]),
      [
        ["signin", true, undefined],
        ["space", false, 0],
      ],
    );
    const events = yield* sql<{ eventId: string; notBefore: number }>`SELECT event_id AS "eventId",
      not_before AS "notBefore" FROM kin_events WHERE org_id = ${orgId} ORDER BY event_id`;
    // Finance's turn is held by the sign-in trouble it hit last, so space coming back leaves it.
    assert.deepStrictEqual(events, [
      { eventId: "e1", notBefore: DAY_START },
      { eventId: "e2", notBefore: HELD_UNTIL },
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
    // Try again ran the held turn before a turn proved space back: it counts as run, as a turn
    // the first notice held counts once it has finished.
    yield* sql`UPDATE kin_events SET state = 'done' WHERE event_id = ${first}`;
    yield* care.succeeded(orgId, chief);
    assert.deepStrictEqual(
      (yield* cards).filter((card) => card.cause === "space").map((card) => card.closed?.ran),
      [0, 1],
    );
  }).pipe(Effect.provide(services)),
);

it.effect(
  "keeps a trouble's held turns on their own rows, however many, for Settings and Try again",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DAY_START);
      yield* seed;
      const care = yield* KinHostCare.KinHostCare;
      const sql = yield* SqlClient.SqlClient;
      const chief = KinAgentId.make("chief");
      const ids = yield* Effect.forEach(
        Array.from({ length: 600 }, (_, n) => n),
        (n) => queued(`e${String(n).padStart(3, "0")}`, "chief"),
      );
      yield* care.failed({ orgId, agentId: chief, cause: "signin", eventIds: ids });
      const shown = (yield* care.status(orgId)).agents.troubles;
      assert.deepStrictEqual(
        shown.map(({ card }) => [card.cause, card.count]),
        [["signin", 600]],
      );
      const held = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_events
      WHERE org_id = ${orgId} AND held_by = ${shown[0]!.widgetId}`;
      assert.deepStrictEqual(held, [{ n: 600 }]);
      yield* sql`UPDATE kin_events SET not_before = ${DAY_START + HOUR}`;
      assert.deepStrictEqual(yield* care.retry(orgId), { requeued: 600 });
      // A second device's tap finds them all due already: it moved nothing, and says so.
      assert.deepStrictEqual(yield* care.retry(orgId), { requeued: 0 });
      // One used its last automatic try: only Try again runs it now, and the notice counts it.
      yield* sql`UPDATE kin_events SET state = 'failed' WHERE event_id = 'e599'`;
      yield* care.refresh(orgId);
      assert.deepStrictEqual(
        (yield* cards).map((card) => [card.count, card.stopped]),
        [[599, 1]],
      );
      yield* sql`UPDATE kin_events SET state = 'queued' WHERE event_id = 'e599'`;
      // A reminder among them has a time: the notice says so, and once it passes unrun the
      // reminder leaves the held count.
      yield* sql`INSERT INTO kin_lead_deliveries (org_id, event_id, kind, agent_id, chat_id,
          widget_id, widget_type, state_json, fallback_body, deadline_at, status, created_at, updated_at)
        VALUES (${orgId}, 'e000', 'reminder', 'chief', 'rhea-chief', 'w', 'reminder', '{}', 'Call Dev',
          ${DAY_START + HOUR}, 'pending', ${DAY_START}, ${DAY_START})`;
      yield* care.refresh(orgId);
      assert.deepStrictEqual(
        (yield* cards).map((card) => [card.count, card.expiring]),
        [[600, 1]],
      );
      yield* sql`UPDATE kin_events SET state = 'expired' WHERE event_id = 'e000'`;
      yield* sql`UPDATE kin_lead_deliveries SET status = 'fallback' WHERE event_id = 'e000'`;
      yield* care.refresh(orgId);
      assert.deepStrictEqual(
        (yield* cards).map((card) => [card.count, card.expiring]),
        [[599, undefined]],
      );
    }).pipe(Effect.provide(services)),
);

it.effect(
  "an agent working again releases only its own held turns; the trouble closes when every agent has",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DAY_START);
      yield* seed;
      const care = yield* KinHostCare.KinHostCare;
      const sql = yield* SqlClient.SqlClient;
      const chief = KinAgentId.make("chief");
      const finance = KinAgentId.make("finance");
      const mine = yield* queued("c1", "chief");
      const theirs = yield* queued("f1", "finance");
      yield* care.failed({ orgId, agentId: chief, cause: "signin", eventIds: [mine] });
      yield* care.failed({ orgId, agentId: finance, cause: "signin", eventIds: [theirs] });
      const due = sql<{ eventId: string; notBefore: number }>`SELECT event_id AS "eventId",
      not_before AS "notBefore" FROM kin_events WHERE org_id = ${orgId} ORDER BY event_id`;
      // Finance's account is signed in again; Chief of staff's is not.
      yield* care.succeeded(orgId, finance);
      assert.deepStrictEqual(
        (yield* cards).map((card) => [card.cause, card.open, card.agents.map((one) => one.name)]),
        [["signin", true, ["Chief of staff"]]],
      );
      assert.deepStrictEqual(yield* due, [
        { eventId: "c1", notBefore: HELD_UNTIL },
        { eventId: "f1", notBefore: DAY_START },
      ]);
      assert.strictEqual((yield* care.causeFor(orgId, chief))?.cause, "signin");
      assert.isUndefined(yield* care.causeFor(orgId, finance));
      // An agent the trouble never stopped proves nothing about it, even for the provider.
      yield* care.failed({ orgId, agentId: chief, cause: "unreachable", eventIds: [] });
      yield* care.succeeded(orgId, finance);
      assert.isTrue(yield* care.troubleOpen(orgId, "unreachable"));
      yield* sql`UPDATE kin_events SET state = 'done' WHERE event_id = 'f1'`;
      yield* care.succeeded(orgId, chief);
      assert.deepStrictEqual(
        (yield* cards).map((card) => [card.cause, card.open]),
        [
          ["signin", false],
          ["unreachable", false],
        ],
      );
      // Only the turn that finished counts as run.
      assert.strictEqual((yield* cards)[0]!.closed?.ran, 1);
    }).pipe(Effect.provide(services)),
);

it.effect(
  "runs one automatic clean per trouble, recorded on it, however many turns fail for space",
  () => {
    let cleans = 0;
    const runner = Layer.succeed(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.sync(() => {
            if (input.command === "bash") cleans += 1;
            return {
              stdout: "kin-clean removed=0 freed_kb=0 failed=0\n",
              stderr: "",
              code: 0 as never,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      }),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(DAY_START);
      yield* seed;
      const care = yield* KinHostCare.KinHostCare;
      const sql = yield* SqlClient.SqlClient;
      const chief = KinAgentId.make("chief");
      const finance = KinAgentId.make("finance");
      // The first failure spends the trouble's clean; every later one, any agent's, does not.
      assert.isTrue(yield* care.spaceFailed(orgId, chief));
      assert.isFalse(yield* care.spaceFailed(orgId, chief));
      assert.isFalse(yield* care.spaceFailed(orgId, finance));
      assert.strictEqual(cleans, 1);
      const spent = yield* sql<{ spent: number }>`SELECT auto_clean_at IS NOT NULL AS spent
      FROM kin_troubles WHERE org_id = ${orgId} ORDER BY trouble_id`;
      assert.deepStrictEqual(spent, [{ spent: 1 }]);
      // A person's tap runs another.
      yield* care.freeSpace(orgId);
      assert.strictEqual(cleans, 2);
      // Space came back; a new trouble later has its own clean.
      yield* care.succeeded(orgId, chief);
      assert.isTrue(yield* care.spaceFailed(orgId, finance));
      assert.strictEqual(cleans, 3);
    }).pipe(Effect.provide(servicesWith({ KIN_CHECKOUT: "/srv/kin-current" }, runner)));
  },
);

it.effect(
  "tells the owner in a chat only they read, and keeps the trouble when there is none",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DAY_START);
      yield* seed;
      const care = yield* KinHostCare.KinHostCare;
      const sql = yield* SqlClient.SqlClient;
      const at = DateTime.formatIso(DateTime.makeUnsafe(NOW));
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
      VALUES ('meera', ${orgId}, 'meera', 'Meera', ${at})`;
      const share = (chat: string) =>
        sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
        VALUES (${`meera-${chat}`}, ${orgId}, ${chat}, 'person', 'meera', 'member', ${at})`;
      const told = sql<{ chatId: string }>`SELECT chat_id AS "chatId" FROM kin_messages
      WHERE org_id = ${orgId} AND author_kind = 'system' ORDER BY seq`;
      // Rhea shared her chat with Chief of staff: the notice goes to her private chat with Finance.
      yield* share("rhea-chief");
      const chief = KinAgentId.make("chief");
      assert.isTrue(
        yield* care.failed({
          orgId,
          agentId: chief,
          cause: "signin",
          eventIds: [yield* queued("c1", "chief")],
        }),
      );
      assert.deepStrictEqual(yield* told, [{ chatId: "rhea-finance" }]);
      // Every chat of hers is shared: nobody is told, but the trouble stands and Settings shows it.
      yield* share("rhea-finance");
      assert.isFalse(
        yield* care.failed({
          orgId,
          agentId: chief,
          cause: "model",
          eventIds: [yield* queued("c2", "chief")],
        }),
      );
      assert.lengthOf(yield* told, 1);
      assert.deepStrictEqual(
        (yield* care.status(orgId)).agents.troubles.map(({ card }) => [card.cause, card.count]),
        [
          ["model", 1],
          ["signin", 1],
        ],
      );
    }).pipe(Effect.provide(services)),
);

it.effect(
  "a storage failure before any turn claimed cleans once, and becomes a told space trouble once writes work",
  () => {
    let cleans = 0;
    const runner = Layer.succeed(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.sync(() => {
            if (input.command === "bash") cleans += 1;
            return {
              stdout: "kin-clean removed=1 freed_kb=4096 failed=0\n",
              stderr: "",
              code: 0 as never,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }),
      }),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(DAY_START);
      yield* seed;
      const care = yield* KinHostCare.KinHostCare;
      yield* care.storageFailed(orgId);
      yield* care.storageFailed(orgId);
      assert.strictEqual(cleans, 1);
      yield* care.storageRecovered(orgId);
      // Told what happened; this test's disk has room, so it says it is over too.
      assert.deepStrictEqual(
        (yield* cards).map((card) => [card.cause, card.open]),
        [["space", false]],
      );
      assert.lengthOf(yield* notices, 1);
      yield* care.storageRecovered(orgId);
      assert.lengthOf(yield* cards, 1);
    }).pipe(Effect.provide(servicesWith({ KIN_CHECKOUT: "/srv/kin-current" }, runner)));
  },
);

it.effect("Back up now says why it can't start, and a good backup closes the notice at once", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DAY_START);
    yield* seed;
    const care = yield* KinHostCare.KinHostCare;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    assert.deepStrictEqual(yield* care.backUpNow(orgId), {
      started: false,
      reason: "not_set_up",
    });
    yield* fs.writeFileString(path.join(stateDir, "kin-dev-backup.env"), "");
    yield* care.checkBackup(orgId, { lastGoodAt: null });
    assert.deepStrictEqual(
      (yield* cards).map((card) => [card.cause, card.open]),
      [["backup", true]],
    );
    assert.deepStrictEqual(yield* care.backUpNow(orgId), { started: true });
    assert.deepStrictEqual(
      (yield* cards).map((card) => [card.cause, card.open]),
      [["backup", false]],
    );
  }).pipe(Effect.provide(servicesWith({ KIN_DEV_HOST_CARE: "/srv/kin-dev" }))),
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
