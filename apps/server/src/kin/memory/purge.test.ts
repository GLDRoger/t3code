// @effect-diagnostics-next-line nodeBuiltinImport:off -- A synchronous probe decides the platform gate before tests register.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { KinMemoryItemId, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Persistence from "../persistence/KinPersistence.ts";
import * as Vcs from "../../vcs/VcsProcess.ts";
import { fixtureItem } from "./__fixtures__/items.ts";
import { parseFrontMatter } from "./frontMatter.ts";
import * as Memory from "./Memory.ts";
import { MemoryConfig } from "./MemoryConfig.ts";
import * as Purge from "./purge.ts";
import * as Scan from "./secretScan.ts";

const orgId = KinOrgId.make("fixture-org");
const token = ["gh", "p_"].join("") + "A1b2C3d4E5".repeat(3) + "abcdef";
// TRIG-20 installs git-filter-repo on the Kin host; machines without it skip the real rewrite.
const filterRepoMissing = NodeChildProcess.spawnSync("git-filter-repo", ["--version"]).status !== 0;

const authorityFor = (plan: Purge.PurgePlan): Purge.PurgeAuthority => ({
  action: {
    id: "act-1",
    orgId,
    kind: "memory_purge",
    revision: 1,
    target: { _tag: "content", path: "purge/act-1.json", sha256: Purge.purgePlanDigest(plan) },
  },
  grant: {
    id: "grant-1",
    orgId,
    actionId: "act-1",
    revision: 1,
    jti: "jti-1",
    approverHumanId: "fixture-owner",
    keyThumbprint: "thumb-1",
  },
  auditId: "audit-1",
});

describe.skipIf(filterRepoMissing)("purge with git-filter-repo", () => {
  it.live.each([
    "drop_file",
    "redact_text",
    "wrong pattern",
    "push fails",
    "missing tool",
  ] as const)("purge on a fixture repo: %s", (scenario) =>
    Effect.gen(function* () {
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
      yield* commit(scenario === "redact_text" ? `fixture ${token}` : "fixture");
      yield* git(source, ["switch", "-q", "-c", "side"]);
      yield* fs.writeFileString(`${source}/claims/leak.md`, `side copy ${token}\n`);
      yield* git(source, ["add", "--", "."]);
      yield* commit("side");
      yield* git(source, ["switch", "-q", "main"]);
      yield* fs.writeFileString(`${source}/rules.md`, "Invented rules, revised\n");
      yield* git(source, ["add", "--", "."]);
      yield* commit("revise rules");
      yield* git(root, ["clone", "-q", "--bare", "--", source, remote]);

      const events: string[] = [];
      const config = Layer.succeed(MemoryConfig, {
        baseDirectory: root,
        repositories: [{ orgId, repoUrl: remoteUrl, path: "state" }],
      });
      const memoryLayer = Memory.layer.pipe(
        Layer.provide(config),
        Layer.provide(Layer.succeed(Memory.MemoryRecoveryHooks, { notify: () => Effect.void })),
      );
      const push =
        scenario === "push fails"
          ? Layer.succeed(Purge.KinPurgePush, {
              push: () => Effect.fail(new Purge.KinPurgePushError({ reason: "fixture refusal" })),
            })
          : Purge.gitPushLayer({}).pipe(Layer.provide(config));
      const layer = Purge.layer.pipe(
        Layer.provideMerge(memoryLayer),
        Layer.provide(config),
        Layer.provide(Scan.layer),
        Layer.provide(push),
        Layer.provide(
          Layer.succeed(
            Purge.GitFilterRepoCommand,
            scenario === "missing tool" ? `${root}/missing/git-filter-repo` : "git-filter-repo",
          ),
        ),
        Layer.provide(
          Layer.succeed(Purge.KinPurgeQueue, {
            pause: () => Effect.sync(() => events.push("pause")),
            resume: () => Effect.sync(() => events.push("resume")),
          }),
        ),
      );

      yield* Effect.gen(function* () {
        const memory = yield* Memory.Memory;
        const paths = yield* memory.ensureCheckouts(orgId);
        yield* memory.prepareWakeup(orgId);
        const oldMain = yield* git(remote, ["rev-parse", "refs/heads/main"]);
        const oldSide = yield* git(remote, ["rev-parse", "refs/heads/side"]);
        const plan: Purge.PurgePlan =
          scenario === "redact_text"
            ? {
                orgId,
                repo: remoteUrl,
                mode: "redact_text",
                paths: ["claims/leak.md"],
                patterns: [token],
              }
            : scenario === "wrong pattern"
              ? {
                  orgId,
                  repo: remoteUrl,
                  mode: "redact_text",
                  paths: ["claims/leak.md"],
                  patterns: ["Invented vendor note"],
                }
              : { orgId, repo: remoteUrl, mode: "drop_file", paths: ["claims/leak.md"] };
        const result = yield* Purge.memoryPurgeHandler
          .run(plan, authorityFor(plan))
          .pipe(Effect.provideService(Purge.PurgeExecutorGate, true), Effect.result);

        if (scenario !== "drop_file" && scenario !== "redact_text") {
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") {
            expect(result.failure).toMatchObject({
              _tag: "KinPurgeFailed",
              ...{
                "wrong pattern": { stage: "verify", queueHeld: false },
                "push fails": { stage: "push", queueHeld: true },
                "missing tool": { stage: "rewrite", queueHeld: false },
              }[scenario],
            });
            expect(JSON.stringify(result.failure)).not.toContain(token);
          }
          expect(events).toEqual(scenario === "push fails" ? ["pause"] : ["pause", "resume"]);
          expect(yield* git(remote, ["rev-parse", "refs/heads/main"])).toBe(oldMain);
          expect(yield* memory.anchor(orgId, "main")).toBe(oldMain);
          return;
        }

        expect(result._tag).toBe("Success");
        if (result._tag !== "Success") return;
        const newMain = yield* git(remote, ["rev-parse", "refs/heads/main"]);
        const newSide = yield* git(remote, ["rev-parse", "refs/heads/side"]);
        expect(events).toEqual(["pause", "resume"]);
        expect(result.success).toMatchObject({ oldHead: oldMain, newHead: newMain });
        expect(result.success.rewrittenRefs).toEqual([
          { ref: "refs/heads/main", old: oldMain, new: newMain },
          { ref: "refs/heads/side", old: oldSide, new: newSide },
        ]);
        expect(result.success.audit).toMatchObject({
          orgId,
          event: "execution_finished",
          actionId: "act-1",
          kind: "memory_purge",
          grantJti: "jti-1",
          keyThumbprint: "thumb-1",
          headSha: newMain,
        });
        expect(JSON.parse(result.success.audit.result)).toMatchObject({
          oldHead: oldMain,
          newHead: newMain,
        });

        for (const history of [
          yield* git(remote, ["log", "--all", "-p"]),
          yield* git(paths.writer, ["log", "--all", "-p"]),
          yield* git(paths.writer, ["cat-file", "--batch-all-objects", "--batch"]),
        ])
          expect(history).not.toContain(token);
        expect(yield* memory.anchor(orgId, "main")).toBe(newMain);
        expect(yield* git(remote, ["show", `${newMain}:claims/keep.md`])).toContain("claim-keep");

        const leak = yield* git(remote, ["show", `${newMain}:claims/leak.md`]);
        if (scenario === "redact_text") {
          expect(result.success.tombstones).toEqual([]);
          expect(leak).toContain("vendor key: ***REMOVED***");
          return;
        }
        expect(result.success.tombstones).toEqual(["claims/leak.md"]);
        const tombstone = yield* parseFrontMatter(orgId, "claims/leak.md", leak + "\n");
        expect(tombstone.frontMatter).toMatchObject({
          id: "claim-leak",
          kind: "claim",
          status: "cancelled",
          said_by: "fixture-owner",
        });
        expect(tombstone.frontMatter.invalid_at).not.toBeNull();
        expect(tombstone.body).toMatch(
          /^Purged on \d{4}-\d{2}-\d{2} by the owner \(audit audit-1\)/,
        );
        expect(
          (yield* memory.readItemQuietly(orgId, KinMemoryItemId.make("claim-leak"))).head.status,
        ).toBe("cancelled");
        expect(yield* fs.readFileString(`${paths.read}/INDEX.md`)).toContain("Purged item");
      }).pipe(Effect.provide(layer));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Vcs.layer.pipe(Layer.provide(NodeServices.layer)),
          NodeServices.layer,
          Persistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)),
        ),
      ),
      Effect.scoped,
    ),
  );
});

const drop: Purge.PurgePlan = {
  orgId,
  repo: "fixture-remote",
  mode: "drop_file",
  paths: ["claims/leak.md"],
};

it.effect("the executor gate refuses a purge until APPR-9 and APPR-10 land", () =>
  Effect.gen(function* () {
    const result = yield* Purge.memoryPurgeHandler
      .run(drop, authorityFor(drop))
      .pipe(Effect.provide(Layer.mock(Purge.KinPurge)({})), Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure._tag).toBe("KinPurgeExecutorNotReady");
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
  ["not markdown", { paths: ["claims"] }],
  ["rules", { paths: ["rules.md"] }],
  ["no paths", { paths: [] }],
  ["duplicate", { paths: ["claims/leak.md", "claims/leak.md"] }],
  ["drop with patterns", { patterns: ["Invented text"] }],
  ["no patterns", { mode: "redact_text" }],
  ["short pattern", { mode: "redact_text", patterns: ["short"] }],
  ["rule injection", { mode: "redact_text", patterns: ["Invented==>regex:.*"] }],
  ["extra rule", { mode: "redact_text", patterns: ["Invented text\nregex:.*"] }],
] as const)("rejects an unsafe plan: %s", (_name, overrides) => {
  const plan = { ...drop, ...overrides };
  expect(Purge.purgeRejection(plan, authorityFor(plan))).toBeDefined();
});

it.each([
  [
    "digest",
    (a: Purge.PurgeAuthority) => ({
      ...a,
      action: { ...a.action, target: { ...a.action.target, sha256: "0".repeat(64) } },
    }),
  ],
  ["action", (a: Purge.PurgeAuthority) => ({ ...a, grant: { ...a.grant, actionId: "act-2" } })],
  ["revision", (a: Purge.PurgeAuthority) => ({ ...a, grant: { ...a.grant, revision: 2 } })],
  [
    "org",
    (a: Purge.PurgeAuthority) => ({
      ...a,
      grant: { ...a.grant, orgId: KinOrgId.make("other-org") },
    }),
  ],
  ["audit id", (a: Purge.PurgeAuthority) => ({ ...a, auditId: "audit 1\nforged" })],
] as const)("rejects authority that does not bind the plan: %s", (_name, tamper) => {
  expect(Purge.purgeRejection(drop, authorityFor(drop))).toBeUndefined();
  expect(Purge.purgeRejection(drop, tamper(authorityFor(drop)))).toBeDefined();
});
