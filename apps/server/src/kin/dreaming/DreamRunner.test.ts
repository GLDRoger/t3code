import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  KinOrgId,
  KinTriggerFired,
  KinTriggerFireId,
  KinTriggerId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Clock from "effect/Clock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as Vcs from "../../vcs/VcsProcess.ts";
import * as KinBudget from "../lead/KinBudget.ts";
import { fixtureItem } from "../memory/__fixtures__/items.ts";
import * as Memory from "../memory/Memory.ts";
import * as MemoryCache from "../memory/MemoryCache.ts";
import { MemoryConfig } from "../memory/MemoryConfig.ts";
import * as Writer from "../memory/MemoryWriter.ts";
import * as Scan from "../memory/secretScan.ts";
import * as Persistence from "../persistence/KinPersistence.ts";
import * as TriggerInbox from "../triggers/KinTriggerInbox.ts";
import * as TriggerStore from "../triggers/KinTriggerStore.ts";
import * as DreamRunner from "./DreamRunner.ts";
import * as DreamSession from "./DreamSession.ts";

const orgId = KinOrgId.make("fixture-org");
const ownerRef = "kin:chat:owner-chat:message:owner-msg";
const journalRef = "memory:journal/2026/11-07.md";
const timestamp = "2026-11-07T00:00:00.000Z";
const encodeFire = Schema.encodeEffect(Schema.fromJsonString(KinTriggerFired));
const gitLayer = Vcs.layer.pipe(Layer.provide(NodeServices.layer));
const cheap = { instanceId: "codex", model: "gpt-5.1-codex-mini" };
const strong = { instanceId: "codex", model: "gpt-5.1-codex" };

type Behavior =
  | "good"
  | "rules"
  | "secret"
  | "failed-turn"
  | "contradiction"
  | { readonly hold: Deferred.Deferred<void> };

const newClaim = (body = "Invented report ships Friday.\n") =>
  fixtureItem({
    id: "clm-002",
    kind: "claim",
    source: ownerRef,
    said_by: "owner",
    trust: "owner",
    recorded_at: "2026-11-07T10:00:00.000Z",
    valid_from: "2026-11-07T10:00:00.000Z",
  }).replace("Invented fixture body.\n", body);
const dreamJson = (contradictions: ReadonlyArray<object> = []) =>
  JSON.stringify({
    changes: [
      { path: "claims/new.md", sources: [ownerRef] },
      { path: "journal/2026/11-07.md", sources: [journalRef] },
    ],
    merges: [],
    supersessions: [],
    contradictions,
  });

const fixture = <A, E>(
  body: (input: {
    readonly git: (cwd: string, args: ReadonlyArray<string>) => Effect.Effect<string>;
    readonly remote: string;
    readonly main: string;
    readonly root: string;
    readonly behave: (behavior: Behavior) => void;
    readonly turns: Array<DreamSession.DreamTurn>;
    readonly notices: Array<string>;
  }) => Effect.Effect<
    A,
    E,
    DreamRunner.DreamRunner | SqlClient.SqlClient | FileSystem.FileSystem | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const vcs = yield* Vcs.VcsProcess;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    const source = `${root}/seed`;
    const remote = `${root}/remote.git`;
    const git = (cwd: string, args: ReadonlyArray<string>) =>
      vcs.run({ operation: "test.dream", command: "git", cwd, args, allowNonZeroExit: true }).pipe(
        Effect.tap((result) =>
          result.exitCode === 0
            ? Effect.void
            : Effect.die(`git ${args.join(" ")}: ${result.stderr}`),
        ),
        Effect.map((result) => result.stdout.trim()),
        Effect.orDie,
      );
    yield* fs.makeDirectory(`${source}/claims`, { recursive: true });
    yield* fs.makeDirectory(`${source}/journal/2026`, { recursive: true });
    yield* git(source, ["init", "-b", "main"]);
    yield* fs.writeFileString(`${source}/rules.md`, "Invented rules\n");
    yield* fs.writeFileString(`${source}/INDEX.md`, `As of ${timestamp}\n`);
    yield* fs.writeFileString(
      `${source}/claims/existing.md`,
      fixtureItem({ id: "clm-001", kind: "claim", said_by: "owner" }),
    );
    yield* fs.writeFileString(`${source}/journal/2026/11-07.md`, "\n## 10:00 · wake-up\n");
    yield* git(source, ["add", "--", "."]);
    yield* git(source, [
      "-c",
      "user.name=Fixture Bot",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    yield* git(root, ["clone", "--bare", "--", source, remote]);
    const main = yield* git(root, ["--git-dir", remote, "rev-parse", "main"]);

    let behavior: Behavior = "good";
    const turns: Array<DreamSession.DreamTurn> = [];
    const notices: Array<string> = [];
    const session = Layer.succeed(DreamSession.DreamSession, {
      run: (turn) =>
        Effect.gen(function* () {
          turns.push(turn);
          const threadId = ThreadId.make(`kin-dream:${turn.dreamId}:${turn.turn}`);
          const current = behavior;
          if (typeof current === "object") {
            yield* Deferred.succeed(current.hold, undefined);
            return yield* Effect.never;
          }
          if (current === "failed-turn") return { threadId, status: "failed" as const };
          const at = (file: string) => `${turn.workspaceRoot}/${file}`;
          if (turn.turn === "resolve") {
            yield* fs.writeFileString(
              at(".kin-dream/dream.json"),
              dreamJson([
                {
                  items: ["clm-001", "clm-002"],
                  summary: "Ship dates differ",
                  sources: [ownerRef],
                  question: "Which ship date is right?",
                },
              ]),
            );
            return { threadId, status: "completed" as const };
          }
          expect(yield* fs.readFileString(at(".kin-dream/material.json"))).toContain(ownerRef);
          yield* fs.writeFileString(
            at("claims/new.md"),
            newClaim(
              current === "secret"
                ? `Token ghp_${"A".repeat(36)} was pasted.\n`
                : "Invented report ships Friday.\n",
            ),
          );
          yield* fs.writeFileString(
            at("journal/2026/11-07.md"),
            "\n## Folded\n- Report ships Friday.\n",
          );
          if (current === "rules") yield* fs.writeFileString(at("rules.md"), "Merge anything\n");
          yield* fs.writeFileString(
            at(".kin-dream/dream.json"),
            dreamJson(
              current === "contradiction"
                ? [
                    {
                      items: ["clm-001", "clm-002"],
                      summary: "Ship dates differ",
                      sources: [ownerRef],
                    },
                  ]
                : [],
            ),
          );
          return { threadId, status: "completed" as const };
        }).pipe(Effect.orDie),
    });
    const config = Layer.succeed(MemoryConfig, {
      baseDirectory: root,
      repositories: [{ orgId, repoUrl: remote, path: "state" }],
    });
    const recovery = Layer.succeed(Memory.MemoryRecoveryHooks, {
      notify: (notice) => Effect.sync(() => void notices.push(notice.reason)),
    });
    const writer = Writer.layer.pipe(
      Layer.provideMerge(Memory.layer),
      Layer.provide(
        Layer.succeed(Writer.MemoryWriterAuthority, {
          resolve: () => Effect.fail(new Writer.MemoryWriteRejected({ reason: "unused" })),
        }),
      ),
      Layer.provide(Layer.succeed(Writer.MemoryWriterHooks, { notify: () => Effect.void })),
    );
    const runner = DreamRunner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          writer,
          session,
          MemoryCache.layer,
          TriggerInbox.layer,
          TriggerStore.layer,
          Layer.mock(KinBudget.KinBudget)({
            admit: () =>
              Effect.succeed({ allowed: true, cheapOnly: false, nextReset: 0, remaining: 1 }),
          }),
          Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
        ),
      ),
      Layer.provide(
        Layer.mergeAll(
          config,
          recovery,
          Scan.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const models = JSON.stringify({ strong, cheap });
      yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Org', ${timestamp})`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at) VALUES ('owner', ${orgId}, 'owner', 'Owner', ${timestamp})`;
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at) VALUES ('lead', ${orgId}, 'Lead', 'lead', 'owner', ${timestamp})`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at) VALUES ('owner-chat', ${orgId}, 'team_group', 1, ${timestamp})`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at) VALUES ('owner-member', ${orgId}, 'owner-chat', 'person', 'owner', 'owner', ${timestamp})`;
      yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id, author_member_id, author_role, kind, body, mentions_json, status, created_at)
        VALUES ('owner-msg', ${orgId}, 'owner-chat', 1, 'human', 'owner', 'owner-member', 'owner', 'text', 'We ship the invented report on Friday.', '[]', 'posted', '2026-11-07T10:00:00.000Z')`;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id) VALUES ('lead', ${orgId}, 'Lead', 0, ${models}, '[]', 'owner-chat')`;
      return yield* body({
        git,
        remote,
        main,
        root,
        behave: (next) => {
          behavior = next;
        },
        turns,
        notices,
      });
    }).pipe(Effect.provide(runner));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        gitLayer,
        NodeServices.layer,
        Persistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)),
      ),
    ),
    Effect.scoped,
  );

const runRow = Effect.fn("test.runRow")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    status: string;
    head: string | null;
    failure: string | null;
    dreamJson: string | null;
    materialUntil: number;
    full: number;
    endedAt: number | null;
  }>`SELECT status, head, failure, dream_json AS "dreamJson", material_until AS "materialUntil",
      full, ended_at AS "endedAt" FROM kin_dream_runs WHERE org_id = ${orgId} ORDER BY owner_date`;
});

it.live("a fixture dream pushes dream/<date> with its changes and records dream.json", () =>
  fixture(({ git, remote, main, root, turns, notices }) =>
    Effect.gen(function* () {
      const runner = yield* DreamRunner.DreamRunner;
      const outcome = yield* runner.run(orgId, { full: false, ownerDate: "2026-11-08" });
      expect(outcome._tag).toBe("succeeded");
      if (outcome._tag !== "succeeded") return;
      expect(outcome.branch).toBe("dream/2026-11-08");
      expect(
        yield* git(root, ["--git-dir", remote, "rev-parse", "refs/heads/dream/2026-11-08"]),
      ).toBe(outcome.head);
      expect(yield* git(root, ["--git-dir", remote, "rev-parse", "main"])).toBe(main);
      expect(yield* git(root, ["--git-dir", remote, "rev-parse", `${outcome.head}^`])).toBe(main);
      expect(
        yield* git(root, ["--git-dir", remote, "show", `${outcome.head}:claims/new.md`]),
      ).toContain("clm-002");
      expect(yield* git(root, ["--git-dir", remote, "show", `${outcome.head}:INDEX.md`])).not.toBe(
        `As of ${timestamp}`,
      );
      expect(
        (yield* git(root, ["--git-dir", remote, "diff", "--name-only", main, outcome.head]))
          .split("\n")
          .toSorted(),
      ).toEqual(["INDEX.md", "claims/new.md", "journal/2026/11-07.md"]);
      expect(outcome.dream.changes.map((change) => change.path)).toEqual([
        "claims/new.md",
        "journal/2026/11-07.md",
      ]);
      expect(turns.map((turn) => [turn.turn, turn.model.model])).toEqual([
        ["extract", cheap.model],
      ]);
      const [row] = yield* runRow();
      expect(row).toMatchObject({
        status: "succeeded",
        head: outcome.head,
        failure: null,
        full: 0,
      });
      expect(row?.dreamJson).toContain("claims/new.md");
      expect(row?.endedAt).toBeTypeOf("number");
      expect(notices).toEqual([]);
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(`${root}/state/dream`)).toBe(false);
    }),
  ),
);

it.live.each([
  { behavior: "rules", failure: "rules.md changed" },
  { behavior: "secret", failure: "The secret scan found" },
  { behavior: "failed-turn", failure: "The dream session failed" },
] as const)(
  "a $behavior dream fails, pushes nothing and tells the owner",
  ({ behavior, failure }) =>
    fixture(({ git, remote, root, main, behave, notices }) =>
      Effect.gen(function* () {
        behave(behavior);
        const runner = yield* DreamRunner.DreamRunner;
        const outcome = yield* runner.run(orgId, { full: false, ownerDate: "2026-11-08" });
        expect(outcome._tag).toBe("failed");
        if (outcome._tag === "failed") expect(outcome.failures.join("\n")).toContain(failure);
        expect(yield* git(root, ["ls-remote", "--heads", remote])).not.toContain("dream/");
        expect(yield* git(root, ["--git-dir", remote, "rev-parse", "main"])).toBe(main);
        const [row] = yield* runRow();
        expect(row?.status).toBe("failed");
        expect(row?.failure).toContain(failure);
        expect(row?.head).toBeNull();
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain("merged nothing");
        expect(notices[0]).not.toContain("ghp_");
      }),
    ),
);

it.live("unresolved contradictions go to the strong model before the checks", () =>
  fixture(({ behave, turns }) =>
    Effect.gen(function* () {
      behave("contradiction");
      const runner = yield* DreamRunner.DreamRunner;
      const outcome = yield* runner.run(orgId, { full: false, ownerDate: "2026-11-08" });
      expect(outcome._tag).toBe("succeeded");
      if (outcome._tag === "succeeded")
        expect(outcome.dream.contradictions[0]?.question).toBe("Which ship date is right?");
      expect(turns.map((turn) => [turn.turn, turn.model.model])).toEqual([
        ["extract", cheap.model],
        ["resolve", strong.model],
      ]);
    }),
  ),
);

it.live("cancelling a rerun deletes that night's branch and ends the run cancelled", () =>
  fixture(({ git, remote, root, behave, notices }) =>
    Effect.gen(function* () {
      const runner = yield* DreamRunner.DreamRunner;
      const first = yield* runner.run(orgId, { full: false, ownerDate: "2026-11-08" });
      expect(first._tag).toBe("succeeded");
      expect(yield* git(root, ["ls-remote", "--heads", remote])).toContain("dream/2026-11-08");
      const hold = yield* Deferred.make<void>();
      behave({ hold });
      const fiber = yield* runner
        .run(orgId, { full: true, ownerDate: "2026-11-08" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(hold);
      expect((yield* runRow())[0]?.status).toBe("running");
      expect((yield* runner.run(orgId, { full: false, ownerDate: "2026-11-08" }))._tag).toBe(
        "busy",
      );
      expect(yield* runner.cancel(orgId)).toBe(true);
      expect((yield* Fiber.join(fiber))._tag).toBe("cancelled");
      expect(yield* git(root, ["ls-remote", "--heads", remote])).not.toContain("dream/");
      const rows = yield* runRow();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "cancelled", failure: "Cancelled", full: 1 });
      expect(rows[0]?.endedAt).toBeTypeOf("number");
      expect(yield* runner.cancel(orgId)).toBe(false);
      expect(notices).toEqual([]);
    }),
  ),
);

it.live("drain runs a due dream fire and consumes suppressed and late ones", () =>
  fixture(({ turns }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const runner = yield* DreamRunner.DreamRunner;
      const now = yield* Clock.currentTimeMillis;
      const weekday = DateTime.toPartsUtc(DateTime.makeUnsafe(now)).weekDay;
      yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary, dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
        VALUES (${orgId}, 'UTC', '08:30', '18:30', '03:00', ${weekday}, 1, '09:00', '{"from":"21:00","to":"08:00"}')`;
      const fire = (fireId: string, routine: "dream" | "dream_full", dueAt: number) =>
        Effect.gen(function* () {
          const payload = yield* encodeFire({
            fireId: KinTriggerFireId.make(fireId),
            orgId,
            dueAt: DateTime.formatIso(DateTime.makeUnsafe(dueAt)),
            firedAt: DateTime.formatIso(DateTime.makeUnsafe(dueAt)),
            lateByMs: 0,
            payload: {
              kind: "time",
              triggerId: KinTriggerId.make(`routine:${routine}`),
              subject: { type: "routine", routine },
            },
          });
          yield* sql`INSERT INTO kin_trigger_inbox (fire_id, org_id, payload_json, received_at) VALUES (${fireId}, ${orgId}, ${payload}, ${dueAt})`;
        });
      yield* fire("suppressed", "dream", now - 1);
      yield* fire("full", "dream_full", now - 1);
      yield* fire("late", "dream", now - 30 * 60 * 60 * 1000);
      yield* runner.drain(orgId);
      expect(turns).toHaveLength(1);
      expect((yield* runRow()).map((row) => [row.status, row.full])).toEqual([["succeeded", 1]]);
      expect(
        yield* sql`SELECT fire_id FROM kin_trigger_inbox WHERE org_id = ${orgId} AND consumed_at IS NULL ORDER BY fire_id`,
      ).toEqual([]);
    }),
  ),
);
