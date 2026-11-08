// @effect-diagnostics-next-line nodeBuiltinImport:off -- A synchronous probe decides the platform gate before tests register.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  KinActionId,
  KinAgentId,
  KinMemoryItemId,
  KinOrgId,
  KinPersonId,
  ThreadId,
  type KinGrantPayload,
  type KinPendingAction,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Persistence from "../persistence/KinPersistence.ts";
import * as Vcs from "../../vcs/VcsProcess.ts";
import { fixtureItem } from "./__fixtures__/items.ts";
import { parseFrontMatter } from "./frontMatter.ts";
import * as Memory from "./Memory.ts";
import { MemoryConfig } from "./MemoryConfig.ts";
import * as Writer from "./MemoryWriter.ts";
import * as Purge from "./purge.ts";
import * as PurgePush from "./purgePush.ts";
import * as Scan from "./secretScan.ts";

const orgId = KinOrgId.make("fixture-org");
const token = ["gh", "p_"].join("") + "A1b2C3d4E5".repeat(3) + "abcdef";
// TRIG-20 installs git-filter-repo on the Kin host; machines without it skip the real rewrite.
const filterRepoMissing = NodeChildProcess.spawnSync("git-filter-repo", ["--version"]).status !== 0;

const actionId = KinActionId.make("act-1");
const thumbprint = "T".repeat(43);
const targetDigest = "d".repeat(64);
const actionFor = (plan: Purge.PurgePlan): KinPendingAction => ({
  id: actionId,
  orgId,
  idempotencyKey: "e".repeat(64),
  kind: "memory_purge",
  target: Purge.purgePlanJson(plan).target,
  resolved: { _tag: "none" },
  targetDigest,
  nonce: "fixture-nonce",
  revision: 1,
  reason: "Invented purge",
  requestedBy: { agentId: KinAgentId.make("fixture-lead"), threadId: ThreadId.make("thread-1") },
  provenance: { startedBy: "schedule", startedByRole: "none", chain: [] },
  requiredApprovers: [{ role: "owner" }],
  state: "executing",
  createdAt: DateTime.makeUnsafe("2026-11-08T00:00:00.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-11-08T00:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2026-11-09T00:00:00.000Z"),
});
const grantFor = (plan: Purge.PurgePlan): KinGrantPayload => ({
  v: 1,
  orgId,
  actionId,
  revision: 1,
  nonce: "fixture-nonce",
  jti: "jti-1",
  kind: "memory_purge",
  targetDigest,
  target: Purge.purgePlanJson(plan).target,
  approver: { humanId: KinPersonId.make("fixture-owner"), kid: thumbprint },
  decision: "approve",
  iat: 0,
  exp: 900,
});
const gateOpen = Effect.provideService(Purge.PurgeExecutorGate, true);

const services = Layer.mergeAll(
  Vcs.layer.pipe(Layer.provide(NodeServices.layer)),
  NodeServices.layer,
  Persistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)),
);

interface PurgeOptions {
  readonly push?: (
    real: PurgePush.KinPurgePush["Service"],
  ) => Partial<PurgePush.KinPurgePush["Service"]> | undefined;
  readonly scan?: Layer.Layer<Scan.KinSecretScan>;
  readonly filterRepo?: string;
  readonly queue?: "default";
}

const fixture = Effect.fn(function* (tokenInMessage = false) {
  const fs = yield* FileSystem.FileSystem;
  const vcs = yield* Vcs.VcsProcess;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const source = `${root}/seed`;
  const remote = `${root}/remote.git`;
  // A file:// URL transfers reachable objects only, like a real remote; a bare path copies them all.
  const remoteUrl = `file://${remote}`;
  const git = (cwd: string, args: ReadonlyArray<string>) =>
    vcs
      .run({
        operation: "test.purge",
        command: "git",
        cwd,
        args: cwd === remote ? [`--git-dir=${remote}`, ...args] : args,
        maxOutputBytes: 64 * 1024 * 1024,
      })
      .pipe(Effect.map((result) => result.stdout.trim()));
  const commit = (message: string) =>
    git(source, [
      "-c",
      "user.name=Fixture Bot",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-q",
      "-m",
      message,
    ]);
  yield* fs.makeDirectory(`${source}/claims`, { recursive: true });
  yield* git(source, ["init", "-q", "-b", "main"]);
  yield* fs.writeFileString(`${source}/rules.md`, "Invented rules\n");
  yield* fs.writeFileString(`${source}/INDEX.md`, "As of 2026-11-08T00:00:00.000Z\n");
  yield* fs.writeFileString(
    `${source}/claims/leak.md`,
    fixtureItem({ id: "claim-leak", kind: "claim", title: "Invented vendor note" }) +
      `vendor key: ${token}\n`,
  );
  yield* fs.writeFileString(
    `${source}/claims/keep.md`,
    fixtureItem({ id: "claim-keep", kind: "claim", title: "Invented keeper" }),
  );
  yield* git(source, ["add", "--", "."]);
  yield* commit(tokenInMessage ? `fixture ${token}` : "fixture");
  yield* git(source, ["switch", "-q", "-c", "side"]);
  yield* fs.writeFileString(`${source}/claims/leak.md`, `side copy ${token}\n`);
  yield* git(source, ["add", "--", "."]);
  yield* commit("side");
  yield* git(source, ["switch", "-q", "main"]);
  yield* fs.writeFileString(`${source}/rules.md`, "Invented rules, revised\n");
  yield* git(source, ["add", "--", "."]);
  yield* commit("revise rules");
  yield* git(root, ["clone", "-q", "--bare", "--", source, remote]);
  // GitHub's read-only pull refs: a purge can't rewrite them and must not wait on them.
  yield* git(remote, ["update-ref", "refs/pull/1/head", "refs/heads/side"]);
  const pullHead = yield* git(remote, ["rev-parse", "refs/pull/1/head"]);
  const remoteHistory = git(remote, ["log", "--exclude=refs/pull/*", "--all", "-p"]);

  const events: string[] = [];
  const config = Layer.succeed(MemoryConfig, {
    baseDirectory: root,
    repositories: [{ orgId, repoUrl: remoteUrl, path: "state" }],
  });
  const purgeLayer = (options: PurgeOptions = {}) => {
    const realPush = PurgePush.gitPushLayer({ credentialHelper: "fixture-helper" });
    const push = options.push
      ? Layer.effect(
          PurgePush.KinPurgePush,
          Effect.gen(function* () {
            const real = yield* PurgePush.KinPurgePush;
            return PurgePush.KinPurgePush.of({ ...real, ...options.push?.(real) });
          }),
        ).pipe(Layer.provide(realPush))
      : realPush;
    return Purge.layer.pipe(
      Layer.provideMerge(
        Memory.layer.pipe(
          Layer.provide(config),
          Layer.provide(Layer.succeed(Memory.MemoryRecoveryHooks, { notify: () => Effect.void })),
        ),
      ),
      Layer.provide(config),
      Layer.provide(options.scan ?? Scan.layer),
      Layer.provide(push),
      Layer.provide(
        Layer.succeed(Purge.GitFilterRepoCommand, options.filterRepo ?? "git-filter-repo"),
      ),
      Layer.provide(
        options.queue === "default"
          ? Layer.empty
          : Layer.succeed(Purge.KinPurgeQueue, {
              pause: () => Effect.sync(() => events.push("pause")),
              resume: () => Effect.sync(() => events.push("resume")),
            }),
      ),
    );
  };
  /** The purge plus the dream and wake-up writer, which push to the same remote. */
  const writerLayer = (options: PurgeOptions = {}) =>
    Writer.layer.pipe(
      Layer.provideMerge(purgeLayer(options)),
      Layer.provide(config),
      Layer.provide(Scan.layer),
      Layer.provide(Layer.succeed(Memory.MemoryRecoveryHooks, { notify: () => Effect.void })),
      Layer.provide(Layer.succeed(Writer.MemoryWriterHooks, { notify: () => Effect.void })),
      Layer.provide(
        Layer.succeed(Writer.MemoryWriterAuthority, {
          resolve: (_org, wakeupId) =>
            Effect.succeed({
              orgId,
              wakeupId,
              agentId: KinAgentId.make("fixture-lead"),
              level: "L1",
              timeZone: "UTC",
              startedAt: "2026-11-08T00:00:00.000Z",
              eventIds: [],
              sources: new Map(),
            }),
        }),
      ),
    );
  const writerHistory = (writer: string) =>
    Effect.gen(function* () {
      if (!(yield* fs.exists(`${writer}/.git`))) return "";
      return [
        yield* git(writer, ["log", "--all", "-p"]),
        yield* git(writer, ["cat-file", "--batch-all-objects", "--batch"]),
      ].join("\n");
    });
  /** Seeds anchors and checkouts the way a lead's first wake-up does. */
  const prepare = Effect.gen(function* () {
    const memory = yield* Memory.Memory;
    const paths = yield* memory.ensureCheckouts(orgId);
    yield* memory.prepareWakeup(orgId);
    return paths;
  });
  return {
    fs,
    git,
    root,
    source,
    remote,
    remoteUrl,
    events,
    commit,
    purgeLayer,
    writerLayer,
    writerHistory,
    prepare,
    pullHead,
    remoteHistory,
  };
});

const dropPlan = (remoteUrl: string, paths = ["claims/leak.md"]): Purge.PurgePlan => ({
  orgId,
  repo: remoteUrl,
  mode: "drop_file",
  paths,
});
const runPurge = (plan: Purge.PurgePlan) =>
  Effect.gen(function* () {
    const target = yield* (yield* Purge.KinPurge).storePlan(plan);
    expect(target).toEqual(actionFor(plan).target);
    return yield* Purge.memoryPurgeHandler
      .run(actionFor(plan), grantFor(plan))
      .pipe(gateOpen, Effect.exit);
  });
const reconcile = (plan: Purge.PurgePlan) =>
  Purge.memoryPurgeHandler.reconcile(actionFor(plan)).pipe(gateOpen);
const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;

describe.skipIf(filterRepoMissing)("purge with git-filter-repo", () => {
  it.live.each(["drop_file", "redact_text"] as const)("purges a fixture repo: %s", (mode) =>
    Effect.gen(function* () {
      const {
        fs,
        git,
        root,
        remote,
        remoteUrl,
        events,
        writerLayer,
        writerHistory,
        prepare,
        pullHead,
        remoteHistory,
      } = yield* fixture(mode === "redact_text");
      yield* Effect.gen(function* () {
        const memory = yield* Memory.Memory;
        const writer = yield* Writer.MemoryWriter;
        const paths = yield* prepare;
        // A wake-up staged against the old history before the queue paused.
        yield* writer.stage(orgId, "wake1", {
          path: "claims/staged.md",
          content: fixtureItem({
            id: "claim-staged",
            kind: "claim",
            title: "Invented staged",
            links: [],
          }),
        });
        const oldMain = yield* git(remote, ["rev-parse", "refs/heads/main"]);
        const oldSide = yield* git(remote, ["rev-parse", "refs/heads/side"]);
        const plan: Purge.PurgePlan =
          mode === "redact_text"
            ? { orgId, repo: remoteUrl, mode, patterns: [token] }
            : dropPlan(remoteUrl);
        yield* fs.makeDirectory(`${root}/state/purge-scratch/mirror-stale`, { recursive: true });
        const exit = yield* runPurge(plan);

        expect(Exit.isSuccess(exit)).toBe(true);
        expect(yield* fs.readDirectory(`${root}/state/purge-scratch`)).toEqual([]);
        if (!Exit.isSuccess(exit)) return;
        const result = exit.value;
        const newMain = yield* git(remote, ["rev-parse", "refs/heads/main"]);
        const newSide = yield* git(remote, ["rev-parse", "refs/heads/side"]);
        expect(events).toEqual(["pause", "resume"]);
        expect(yield* memory.purgeInFlight(orgId)).toBeUndefined();
        expect(
          yield* writer.commitWakeup(orgId, "wake1", "completed").pipe(Effect.result),
        ).toMatchObject({ failure: { _tag: "MemorySyncConflict" } });
        // A dream that read its base before the purge.
        expect(
          yield* writer
            .commitDream(orgId, {
              branch: "dream/2026-11-08",
              base: oldMain,
              files: new Map(),
              message: "dream",
            })
            .pipe(Effect.result),
        ).toMatchObject({ failure: { _tag: "MemorySyncConflict" } });
        expect(yield* git(remote, ["rev-parse", "refs/heads/main"])).toBe(newMain);
        expect(yield* reconcile(plan)).toBe("done");
        expect(yield* git(remote, ["rev-parse", "refs/pull/1/head"])).toBe(pullHead);
        expect(result).toMatchObject({ oldHead: oldMain, newHead: newMain });
        expect(result.rewrittenRefs).toEqual([
          { ref: "refs/heads/main", old: oldMain, new: newMain },
          { ref: "refs/heads/side", old: oldSide, new: newSide },
        ]);
        expect(result.audit).toMatchObject({
          orgId,
          event: "execution_finished",
          actionId: "act-1",
          kind: "memory_purge",
          grantJti: "jti-1",
          keyThumbprint: thumbprint,
          headSha: newMain,
        });
        expect(JSON.parse(result.audit.result)).toMatchObject({
          oldHead: oldMain,
          newHead: newMain,
        });
        expect(result.audit.result).not.toContain(token);

        expect(yield* remoteHistory).not.toContain(token);
        expect(yield* writerHistory(paths.writer)).not.toContain(token);
        expect(yield* memory.anchor(orgId, "main")).toBe(newMain);
        expect(yield* git(remote, ["show", `${newMain}:claims/keep.md`])).toContain("claim-keep");

        const leak = yield* git(remote, ["show", `${newMain}:claims/leak.md`]);
        if (mode === "redact_text") {
          expect(result.tombstones).toEqual([]);
          expect(leak).toContain("vendor key: ***REMOVED***");
          return;
        }
        expect(result.tombstones).toEqual(["claims/leak.md"]);
        // Only this purge's exact tombstone counts as purged; a look-alike at the path is old content.
        const later = `${root}/later`;
        yield* git(root, ["clone", "-q", "--", remote, later]);
        yield* fs.writeFileString(`${later}/claims/leak.md`, `${leak}\nInvented restored note\n`);
        yield* git(later, [
          "-c",
          "user.name=Fixture Bot",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-qam",
          "look-alike tombstone",
        ]);
        yield* git(later, ["push", "-q", "origin", "main"]);
        expect(yield* reconcile(plan)).toBe("not_done");
        const tombstone = yield* parseFrontMatter(orgId, "claims/leak.md", leak + "\n");
        expect(tombstone.frontMatter).toMatchObject({
          id: "claim-leak",
          kind: "claim",
          status: "cancelled",
          said_by: "fixture-owner",
          source: "kin-action:act-1",
        });
        expect(tombstone.frontMatter.invalid_at).not.toBeNull();
        expect(tombstone.body).toMatch(
          /^Purged on \d{4}-\d{2}-\d{2} by the owner \(action act-1\)/,
        );
        expect(
          (yield* memory.readItemQuietly(orgId, KinMemoryItemId.make("claim-leak"))).head.status,
        ).toBe("cancelled");
        expect(yield* fs.readFileString(`${paths.read}/INDEX.md`)).toContain("Purged item");
      }).pipe(Effect.provide(writerLayer()));
    }).pipe(Effect.provide(services), Effect.scoped),
  );

  it.live.each([
    ["wrong pattern", { _tag: "KinPurgeFailed", stage: "verify", queueHeld: false }],
    ["missing tool", { _tag: "KinPurgeFailed", stage: "rewrite", queueHeld: false }],
    ["path typo", { _tag: "KinPurgeRejected" }],
    ["interrupted", undefined],
    ["no pause", { _tag: "KinPurgePauseUnavailable" }],
    // `clone --bare` leaves notes and custom refs behind, and they would keep the old history.
    ["notes ref", { _tag: "KinPurgeFailed", stage: "clone", queueHeld: false }],
    // filter-repo leaves a tag on a blob or tree alone, and history checks walk commits only.
    ["blob tag", { _tag: "KinPurgeFailed", stage: "clone", queueHeld: false }],
    // filter-repo rewrites tag messages but not tagger idents.
    ["tagger ident", { _tag: "KinPurgeFailed", stage: "verify", queueHeld: false }],
  ] as const)(
    "a purge that stops before the push resumes the queue and changes nothing: %s",
    ([scenario, expected]) =>
      Effect.gen(function* () {
        const { fs, git, root, remote, remoteUrl, events, purgeLayer, writerHistory, prepare } =
          yield* fixture();
        const layer = purgeLayer({
          ...(scenario === "missing tool" ? { filterRepo: `${root}/missing/git-filter-repo` } : {}),
          ...(scenario === "interrupted"
            ? { scan: Layer.succeed(Scan.KinSecretScan, { scan: () => Effect.interrupt }) }
            : {}),
          ...(scenario === "no pause" ? { queue: "default" as const } : {}),
        });
        yield* Effect.gen(function* () {
          const memory = yield* Memory.Memory;
          const paths = yield* prepare;
          const oldMain = yield* git(remote, ["rev-parse", "refs/heads/main"]);
          const plan: Purge.PurgePlan =
            scenario === "wrong pattern"
              ? { orgId, repo: remoteUrl, mode: "redact_text", patterns: ["Invented vendor note"] }
              : scenario === "tagger ident"
                ? {
                    orgId,
                    repo: remoteUrl,
                    mode: "redact_text",
                    patterns: [token],
                  }
                : dropPlan(remoteUrl, scenario === "path typo" ? ["claims/leek.md"] : undefined);
          if (scenario === "notes ref")
            yield* git(remote, ["update-ref", "refs/notes/commits", "refs/heads/side"]);
          if (scenario === "tagger ident")
            yield* git(remote, [
              "-c",
              "user.name=Tagger",
              "-c",
              `user.email=${token}`,
              "tag",
              "-a",
              "v1",
              "-m",
              `release ${token}`,
              "refs/heads/side",
            ]);
          if (scenario === "blob tag")
            yield* git(remote, [
              "update-ref",
              "refs/tags/blobtag",
              "refs/heads/side:claims/leak.md",
            ]);
          const exit = yield* runPurge(plan);

          expect(Exit.isFailure(exit)).toBe(true);
          if (!Exit.isFailure(exit)) return;
          if (expected === undefined) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
          else expect(failureOf(exit)).toMatchObject({ value: expected });
          if (scenario === "wrong pattern")
            expect(failureOf(exit)).toMatchObject({
              value: { reason: expect.stringMatching(/Secret scan/) },
            });
          if (scenario === "path typo")
            expect(failureOf(exit)).toMatchObject({
              value: { reason: expect.stringMatching(/not in history/) },
            });
          if (scenario === "notes ref" || scenario === "blob tag") {
            expect(failureOf(exit)).toMatchObject({
              value: {
                reason: expect.stringContaining(
                  scenario === "notes ref" ? "refs/notes/commits" : "refs/tags/blobtag",
                ),
              },
            });
            expect(yield* reconcile(plan)).toBe("unknown");
          }
          expect(JSON.stringify(exit)).not.toContain(token);
          expect(events).toEqual(scenario === "no pause" ? [] : ["pause", "resume"]);
          expect(yield* git(remote, ["rev-parse", "refs/heads/main"])).toBe(oldMain);
          expect(yield* memory.anchor(orgId, "main")).toBe(oldMain);
          expect(yield* memory.purgeInFlight(orgId)).toBeUndefined();
          expect(yield* writerHistory(paths.writer)).toContain(token);
          expect(
            yield* fs
              .readDirectory(`${root}/state/purge-scratch`)
              .pipe(Effect.orElseSucceed(() => [])),
          ).toEqual([]);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(services), Effect.scoped),
  );

  it.live.each(["error", "checkout during push", "crash", "interrupt"] as const)(
    "a push that lands and then fails never republishes the purged history: %s",
    (scenario) =>
      Effect.gen(function* () {
        const { fs, git, root, remote, remoteUrl, events, writerLayer, writerHistory, prepare } =
          yield* fixture();
        const plan = dropPlan(remoteUrl);
        // A dream or wake-up asking for checkouts while the remote still holds the old history.
        let beforePush: Effect.Effect<void> = Effect.void;
        const landing = writerLayer({
          push: (real) => ({
            push: (input) =>
              Effect.suspend(() => beforePush).pipe(
                Effect.andThen(real.push(input)),
                Effect.andThen(
                  scenario === "crash"
                    ? Effect.die("fixture crash after the push")
                    : scenario === "interrupt"
                      ? Effect.interrupt
                      : Effect.fail(new PurgePush.KinPurgePushError({ reason: "timeout" })),
                ),
              ),
          }),
        });
        const target = Purge.purgePlanJson(plan).target;
        const paths = yield* Effect.gen(function* () {
          const memory = yield* Memory.Memory;
          const paths = yield* prepare;
          const oldMain = yield* git(remote, ["rev-parse", "refs/heads/main"]);
          let checkout: Exit.Exit<unknown, unknown> | undefined;
          if (scenario === "checkout during push")
            beforePush = memory.ensureCheckouts(orgId).pipe(
              Effect.exit,
              Effect.map((exit) => {
                checkout = exit;
              }),
            );
          const exit = yield* runPurge(plan);
          if (scenario === "checkout during push")
            expect(checkout && failureOf(checkout)).toMatchObject({
              value: { _tag: "MemorySyncConflict" },
            });
          expect(Exit.isFailure(exit)).toBe(true);
          if (scenario === "interrupt")
            expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
          else
            expect(failureOf(exit)).toMatchObject({
              value: { _tag: "KinPurgeFailed", stage: "push", queueHeld: true },
            });
          expect(events).toEqual(["pause"]);
          expect(yield* memory.purgeInFlight(orgId)).toBeDefined();
          expect(yield* fs.exists(paths.writer)).toBe(false);
          expect(yield* fs.exists(paths.read)).toBe(false);

          const writer = yield* Writer.MemoryWriter;
          const dream = yield* writer
            .commitDream(orgId, {
              branch: "dream/2026-11-08",
              base: oldMain,
              files: new Map([
                [
                  "claims/dream.md",
                  fixtureItem({ id: "claim-dream", kind: "claim", title: "Invented dream" }),
                ],
              ]),
              message: "dream",
            })
            .pipe(Effect.result);
          expect(dream).toMatchObject({ failure: { _tag: "MemorySyncConflict" } });
          expect(
            yield* writer.commitWakeup(orgId, "wake1", "completed").pipe(Effect.result),
          ).toMatchObject({ failure: { _tag: "MemorySyncConflict" } });
          return paths;
        }).pipe(Effect.provide(landing));

        // A crash restarts the server: fresh Memory and purge services over the same database and files.
        const after = scenario === "crash" ? writerLayer() : landing;
        yield* Effect.gen(function* () {
          const memory = yield* Memory.Memory;
          const purge = yield* Purge.KinPurge;
          yield* memory.prepareWakeup(orgId).pipe(Effect.result);
          yield* memory.recover(orgId).pipe(Effect.result);
          expect(yield* fs.exists(paths.writer)).toBe(false);
          expect(yield* git(remote, ["log", "--exclude=refs/pull/*", "--all", "-p"])).not.toContain(
            token,
          );
          expect(
            yield* git(remote, ["for-each-ref", "--format=%(refname)", "refs/heads/"]),
          ).not.toMatch(/kin\/conflict|dream\//);

          // The marker keeps the plan, so a lost plan file can't strand the held queue.
          expect(yield* purge.discardPlan(target).pipe(Effect.result)).toMatchObject({
            failure: { _tag: "KinPurgeRejected" },
          });
          yield* fs.remove(`${root}/${target.path}`);
          expect(yield* reconcile(plan)).toBe("done");
          expect(events).toEqual(["pause", "resume"]);
          expect(yield* memory.purgeInFlight(orgId)).toBeUndefined();
          const newMain = yield* git(remote, ["rev-parse", "refs/heads/main"]);
          expect((yield* memory.prepareWakeup(orgId)).head).toBe(newMain);
          expect(yield* writerHistory(paths.writer)).not.toContain(token);
          expect(yield* git(remote, ["log", "--exclude=refs/pull/*", "--all", "-p"])).not.toContain(
            token,
          );
          yield* purge.discardPlan(target);
        }).pipe(Effect.provide(after));
      }).pipe(Effect.provide(services), Effect.scoped),
  );

  const lateRef = "The remote may still hold purged history after the push; reconcile it";
  it.live.each([
    ["refused", "Force-push failed: remote_rejected", "not_done"],
    ["lease rejected", "Force-push failed: lease_rejected", "unknown"],
    // Created after the mirror clone, so the push's lease never covers them.
    ["late branch", lateRef, "unknown"],
    ["late tag", lateRef, "unknown"],
    ["late notes ref", lateRef, "unknown"],
  ] as const)(
    "a push that does not land holds the queue until reconcile: %s",
    ([scenario, reason, verdict]) =>
      Effect.gen(function* () {
        const {
          fs,
          git,
          source,
          remote,
          remoteUrl,
          events,
          commit,
          purgeLayer,
          writerHistory,
          prepare,
        } = yield* fixture();
        const plan = dropPlan(remoteUrl);
        const layer = purgeLayer({
          push: (real) => ({
            push: (input) =>
              scenario === "refused"
                ? Effect.fail(new PurgePush.KinPurgePushError({ reason: "remote_rejected" }))
                : scenario !== "lease rejected"
                  ? git(remote, [
                      "update-ref",
                      {
                        "late branch": "refs/heads/sneaky",
                        "late tag": "refs/tags/sneaky",
                        "late notes ref": "refs/notes/commits",
                      }[scenario],
                      "refs/heads/side",
                    ]).pipe(Effect.orDie, Effect.andThen(real.push(input)))
                  : Effect.gen(function* () {
                      // The remote moves after the purge's mirror clone.
                      yield* fs.writeFileString(
                        `${source}/claims/other.md`,
                        "Invented later note\n",
                      );
                      yield* git(source, ["add", "--", "."]);
                      yield* commit("later");
                      yield* git(source, ["push", "-q", remote, "main"]);
                    }).pipe(Effect.orDie, Effect.andThen(real.push(input))),
          }),
        });
        yield* Effect.gen(function* () {
          const memory = yield* Memory.Memory;
          const paths = yield* prepare;
          const oldMain = yield* git(remote, ["rev-parse", "refs/heads/main"]);
          const exit = yield* runPurge(plan);
          expect(failureOf(exit)).toMatchObject({
            value: {
              _tag: "KinPurgeFailed",
              stage: "push",
              queueHeld: true,
              reason,
            },
          });
          expect(events).toEqual(["pause"]);
          const remoteMain = yield* git(remote, ["rev-parse", "refs/heads/main"]);
          if (scenario === "refused") expect(remoteMain).toBe(oldMain);
          else expect(remoteMain).not.toBe(oldMain);
          expect(yield* git(remote, ["log", "--all", "-p"])).toContain(token);

          expect(yield* reconcile(plan)).toBe(verdict);
          if (verdict === "unknown") {
            expect(events).toEqual(["pause"]);
            expect(yield* memory.purgeInFlight(orgId)).toBeDefined();
            return;
          }
          expect(events).toEqual(["pause", "resume"]);
          expect(yield* memory.purgeInFlight(orgId)).toBeUndefined();
          expect(yield* memory.anchor(orgId, "main")).toBe(oldMain);
          expect(yield* writerHistory(paths.writer)).toContain(token);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(services), Effect.scoped),
  );
});

it.live("a marker left before the checkouts dropped blocks every writer push until reconcile", () =>
  Effect.gen(function* () {
    const { fs, git, root, remote, remoteUrl, events, writerLayer, prepare } = yield* fixture();
    const plan = dropPlan(remoteUrl);
    yield* Effect.gen(function* () {
      const memory = yield* Memory.Memory;
      const writer = yield* Writer.MemoryWriter;
      const paths = yield* prepare;
      const oldMain = yield* git(remote, ["rev-parse", "refs/heads/main"]);
      const { json, target } = Purge.purgePlanJson(plan);
      yield* (yield* Purge.KinPurge).storePlan(plan);
      // A crash after the marker rename and before `dropCheckouts`.
      yield* fs.writeFileString(
        `${root}/state/purge-in-flight`,
        JSON.stringify({
          sha256: target.sha256,
          actionId,
          oldHead: oldMain,
          plan: json,
          tombstones: [],
        }),
      );
      expect(yield* fs.exists(paths.writer)).toBe(true);
      const guarded = {
        failure: {
          _tag: "MemorySyncConflict",
          operation: "push",
          reason: expect.stringMatching(/purge is in flight/),
        },
      };
      yield* writer.stage(orgId, "wake1", {
        path: "claims/staged.md",
        content: fixtureItem({
          id: "claim-staged",
          kind: "claim",
          title: "Invented staged",
          links: [],
        }),
      });
      expect(
        yield* writer.commitWakeup(orgId, "wake1", "completed").pipe(Effect.result),
      ).toMatchObject(guarded);
      expect(
        yield* writer
          .commitDream(orgId, {
            branch: "dream/2026-11-08",
            base: oldMain,
            files: new Map(),
            message: "dream",
          })
          .pipe(Effect.result),
      ).toMatchObject(guarded);
      expect(
        yield* writer.deleteDreamBranch(orgId, "dream/2026-11-08").pipe(Effect.result),
      ).toMatchObject(guarded);
      expect(yield* git(remote, ["rev-parse", "refs/heads/main"])).toBe(oldMain);
      expect(yield* git(remote, ["for-each-ref", "--format=%(refname)", "refs/heads/dream/"])).toBe(
        "",
      );

      expect(yield* reconcile(plan)).toBe("not_done");
      expect(events).toEqual(["resume"]);
      expect(yield* memory.purgeInFlight(orgId)).toBeUndefined();
    }).pipe(Effect.provide(writerLayer()));
  }).pipe(Effect.provide(services), Effect.scoped),
);

const drop: Purge.PurgePlan = {
  orgId,
  repo: "fixture-remote",
  mode: "drop_file",
  paths: ["claims/leak.md"],
};

const unitLayer = (baseDirectory: string) =>
  Purge.layer.pipe(
    Layer.provide(Layer.mock(Memory.Memory)({ purgeInFlight: () => Effect.undefined })),
    Layer.provide(
      Layer.succeed(MemoryConfig, {
        baseDirectory,
        repositories: [{ orgId, repoUrl: "fixture-remote", path: "state" }],
      }),
    ),
    Layer.provide(Layer.mock(Scan.KinSecretScan)({})),
    Layer.provide(Layer.mock(PurgePush.KinPurgePush)({})),
    Layer.provide(Layer.mock(Vcs.VcsProcess)({})),
    Layer.provide(NodeServices.layer),
  );

it.effect("the executor gate refuses a purge until APPR-9, APPR-10 and LEAD-11 land", () =>
  Effect.gen(function* () {
    const action = actionFor(drop);
    for (const attempt of [
      Purge.memoryPurgeHandler.precheck(action),
      Purge.memoryPurgeHandler.run(action, grantFor(drop)),
      Purge.memoryPurgeHandler.reconcile(action),
      Effect.gen(function* () {
        return yield* (yield* Purge.KinPurge).purge(action, grantFor(drop));
      }),
    ]) {
      const result = yield* Effect.result(attempt);
      expect(result).toMatchObject({ failure: { _tag: "KinPurgeExecutorNotReady" } });
    }
  }).pipe(Effect.provide(unitLayer("/nonexistent"))),
);

it.effect("a stored plan binds its file to the action digest until it is discarded", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    yield* Effect.gen(function* () {
      const purge = yield* Purge.KinPurge;
      const action = actionFor(drop);
      const target = yield* purge.storePlan(drop);
      expect(target).toEqual(action.target);
      expect(yield* fs.readFileString(`${root}/${target.path}`)).toBe(
        Purge.purgePlanJson(drop).json,
      );
      yield* purge.precheck(action).pipe(gateOpen);

      yield* fs.writeFileString(
        `${root}/${target.path}`,
        Purge.purgePlanJson({ ...drop, paths: ["claims/keep.md"] }).json,
      );
      expect(yield* purge.precheck(action).pipe(gateOpen, Effect.result)).toMatchObject({
        failure: { _tag: "KinPurgeRejected", reason: "Plan does not match the approved digest" },
      });
      expect(
        yield* purge
          .precheck({ ...action, target: { ...target, path: "../escape.json" } })
          .pipe(gateOpen, Effect.result),
      ).toMatchObject({ failure: { _tag: "KinPurgeRejected", reason: "Invalid plan path" } });

      yield* purge.discardPlan(target);
      expect(yield* fs.exists(`${root}/${target.path}`)).toBe(false);
      expect(yield* purge.precheck(action).pipe(gateOpen, Effect.result)).toMatchObject({
        failure: { _tag: "KinPurgeRejected", reason: "Plan file is missing" },
      });
      expect(
        yield* purge.storePlan({ ...drop, repo: "other-remote" }).pipe(Effect.result),
      ).toMatchObject({ failure: { _tag: "KinPurgeRejected" } });
    }).pipe(Effect.provide(unitLayer(root)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

const pushInput = {
  orgId,
  repoUrl: "https://example.invalid/memory.git",
  gitDir: "/nonexistent",
  updates: [{ ref: "refs/heads/main", old: "a".repeat(40), new: "b".repeat(40) }],
};
const pushWith = (
  owner: Parameters<typeof PurgePush.gitPushLayer>[0],
  output: { readonly code: number; readonly stdout?: string; readonly stderr?: string },
  repoUrl = pushInput.repoUrl,
) => {
  const calls: Array<Vcs.VcsProcessInput> = [];
  return Effect.gen(function* () {
    const result = yield* (yield* PurgePush.KinPurgePush)
      .push({ ...pushInput, repoUrl })
      .pipe(Effect.result);
    return { result, calls };
  }).pipe(
    Effect.provide(
      PurgePush.gitPushLayer(owner).pipe(
        Layer.provide(NodeServices.layer),
        Layer.provide(
          Layer.mock(Vcs.VcsProcess)({
            run: (input) =>
              Effect.sync(() => {
                calls.push(input);
                return {
                  exitCode: ChildProcessSpawner.ExitCode(output.code),
                  stdout: output.stdout ?? "",
                  stderr: output.stderr ?? "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                };
              }),
          }),
        ),
      ),
    ),
  );
};

it.effect.each([
  ["no credential", {}, pushInput.repoUrl, "credential_unavailable"],
  [
    "inline helper script",
    { credentialHelper: "!f() { echo password=hunter2; }; f" },
    pushInput.repoUrl,
    "credential_unavailable",
  ],
  [
    "shell in ssh command",
    { sshCommand: "ssh -i key; cat /etc/passwd" },
    pushInput.repoUrl,
    "credential_unavailable",
  ],
  [
    "https without a helper",
    { sshCommand: "ssh -i /keys/owner" },
    pushInput.repoUrl,
    "credential_unavailable",
  ],
  [
    "ssh without a command",
    { credentialHelper: "osxkeychain" },
    "git@example.invalid:memory.git",
    "credential_unavailable",
  ],
  [
    "plain http",
    { credentialHelper: "osxkeychain" },
    "http://example.invalid/memory.git",
    "unsupported_remote",
  ],
  [
    "remote helper",
    { credentialHelper: "osxkeychain", sshCommand: "ssh -i /keys/owner" },
    "ext::ssh -i /keys/owner example.invalid %S memory.git",
    "unsupported_remote",
  ],
] as const)(
  "the owner push fails closed without a matching credential reference: %s",
  ([, owner, repoUrl, reason]) =>
    Effect.gen(function* () {
      const { result, calls } = yield* pushWith(owner, { code: 0 }, repoUrl);
      expect(result).toMatchObject({ failure: { reason } });
      expect(calls).toEqual([]);
    }),
);

it.effect("the owner push passes only credential references and never prompts", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* Effect.acquireUseRelease(
      Effect.sync(() => vi.stubEnv("GIT_CONFIG_PARAMETERS", "'core.hookspath'='/invented'")),
      () =>
        pushWith(
          { credentialHelper: "osxkeychain", sshCommand: "ssh -i /keys/owner" },
          { code: 0 },
        ),
      () => Effect.sync(() => vi.unstubAllEnvs()),
    );
    expect(result._tag).toBe("Success");
    const [call] = calls;
    expect(call?.args).toContain("credential.helper=osxkeychain");
    expect(call?.env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "false",
      SSH_ASKPASS: "false",
      SSH_ASKPASS_REQUIRE: "never",
      GIT_SSH_COMMAND:
        "ssh -i /keys/owner -F none -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none",
    });
    expect(call?.env?.HOME).toMatch(/kin-push-home-/);
    expect(call?.env).toHaveProperty("GIT_CONFIG_PARAMETERS", undefined);
    expect(call?.env).toHaveProperty("SSH_AUTH_SOCK", undefined);

    const helperOnly = yield* pushWith({ credentialHelper: "osxkeychain" }, { code: 0 });
    expect(helperOnly.calls[0]?.env?.GIT_SSH_COMMAND).toBe("false");
  }),
);

it.effect.each([
  [
    "stale lease",
    { stdout: "To x\n!\trefs/heads/main:refs/heads/main\t[rejected] (stale info)\nDone\n" },
    "lease_rejected",
  ],
  [
    "ruleset",
    {
      stdout:
        "To x\n!\trefs/heads/main:refs/heads/main\t[remote rejected] (protected branch hook declined)\n",
    },
    "remote_rejected",
  ],
  [
    "auth",
    { stderr: `fatal: Authentication failed for 'https://x:${token}@example.invalid/'\n` },
    "auth",
  ],
  [
    "network",
    { stderr: "fatal: unable to access 'https://example.invalid/': Could not resolve host\n" },
    "network",
  ],
  ["other", { stderr: "fatal: something else\n" }, "unknown"],
] as const)("classifies a failed owner push: %s", ([, output, reason]) =>
  Effect.gen(function* () {
    const { result } = yield* pushWith({ credentialHelper: "osxkeychain" }, { code: 1, ...output });
    expect(result).toMatchObject({ failure: { _tag: "KinPurgePushError", reason } });
    expect(JSON.stringify(result)).not.toContain(token);
  }),
);

it.each([
  ["parent escape", { paths: ["../claims/leak.md"] }],
  ["inner escape", { paths: ["claims/../rules.md"] }],
  ["absolute", { paths: ["/claims/leak.md"] }],
  ["option", { paths: ["--force.md"] }],
  ["option segment", { paths: ["claims/-x.md"] }],
  ["git dir", { paths: [".git/config.md"] }],
  ["git dir case", { paths: ["claims/.GIT./x.md"] }],
  ["empty segment", { paths: ["claims//leak.md"] }],
  ["dot segment", { paths: ["claims/./leak.md"] }],
  ["backslash", { paths: ["claims\\leak.md"] }],
  ["newline", { paths: ["claims/leak.md\nrules.md"] }],
  ["decomposed", { paths: ["claims/café.md"] }],
  ["not markdown", { paths: ["claims"] }],
  ["rules", { paths: ["rules.md"] }],
  ["no paths", { paths: [] }],
  ["duplicate", { paths: ["claims/leak.md", "claims/leak.md"] }],
] as const)("rejects an unsafe drop plan: %s", (_name, overrides) => {
  const plan = { ...drop, ...overrides };
  expect(Purge.purgeRejection(plan, actionFor(plan), grantFor(plan))).toBeDefined();
});

it.each([
  ["no patterns", []],
  ["short pattern", ["short"]],
  ["duplicate", ["Invented text", "Invented text"]],
  ["rule injection", ["Invented==>regex:.*"]],
  ["extra rule", ["Invented text\nregex:.*"]],
] as const)("rejects an unsafe redact plan: %s", (_name, patterns) => {
  const plan: Purge.PurgePlan = { orgId, repo: "fixture-remote", mode: "redact_text", patterns };
  expect(Purge.purgeRejection(plan, actionFor(plan), grantFor(plan))).toBeDefined();
});

it.each([
  [
    "digest",
    (a: KinPendingAction, g: KinGrantPayload) =>
      [
        { ...a, target: { ...Purge.purgePlanJson(drop).target, sha256: "0".repeat(64) } },
        g,
      ] as const,
  ],
  [
    "plan path",
    (a: KinPendingAction, g: KinGrantPayload) =>
      [
        { ...a, target: { ...Purge.purgePlanJson(drop).target, path: "purge-plans/other.json" } },
        g,
      ] as const,
  ],
  [
    "action",
    (a: KinPendingAction, g: KinGrantPayload) =>
      [a, { ...g, actionId: KinActionId.make("act-2") }] as const,
  ],
  ["revision", (a: KinPendingAction, g: KinGrantPayload) => [a, { ...g, revision: 2 }] as const],
  [
    "grant target",
    (a: KinPendingAction, g: KinGrantPayload) =>
      [
        a,
        { ...g, target: Purge.purgePlanJson({ ...drop, paths: ["claims/keep.md"] }).target },
      ] as const,
  ],
  [
    "grant digest",
    (a: KinPendingAction, g: KinGrantPayload) =>
      [a, { ...g, targetDigest: "0".repeat(64) }] as const,
  ],
  [
    "org",
    (a: KinPendingAction, g: KinGrantPayload) =>
      [a, { ...g, orgId: KinOrgId.make("other-org") }] as const,
  ],
  [
    "action id",
    (a: KinPendingAction, g: KinGrantPayload) =>
      [
        { ...a, id: KinActionId.make("act 1\nforged") },
        { ...g, actionId: KinActionId.make("act 1\nforged") },
      ] as const,
  ],
] as const)("rejects authority that does not bind the plan: %s", (_name, tamper) => {
  expect(Purge.purgeRejection(drop, actionFor(drop), grantFor(drop))).toBeUndefined();
  expect(Purge.purgeRejection(drop, ...tamper(actionFor(drop), grantFor(drop)))).toBeDefined();
});
