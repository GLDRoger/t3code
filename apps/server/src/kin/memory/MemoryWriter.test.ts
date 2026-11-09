import * as SqlClient from "effect/sql/SqlClient";
import { memoryGit } from "./git.ts";
import * as NodeZlib from "node:zlib";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  KinAgentId,
  KinOrgId,
  type MemoryItemHead,
  VcsProcessSpawnError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Persistence from "../persistence/KinPersistence.ts";
import * as Vcs from "../../vcs/VcsProcess.ts";
import * as Memory from "./Memory.ts";
import { MemoryConfig } from "./MemoryConfig.ts";
import * as Writer from "./MemoryWriter.ts";
import * as Scan from "./secretScan.ts";
import { journalEntry } from "./journal.ts";
import { fixtureItem } from "./__fixtures__/items.ts";

const orgId = KinOrgId.make("fixture-org");
const agentId = KinAgentId.make("fixture-lead");
const gitLayer = Vcs.layer.pipe(Layer.provide(NodeServices.layer));
it.live.each([
  "supersede-retry",
  "update-provenance",
  "recovered-no-end",
  "lost-session-retry",
  "completed",
  "failed",
  "blocked",
  "scan unavailable",
  "scan limit",
  "forged",
  "conflict",
  "B1-shadow",
  "B2-anchor",
  "B3-execution",
  "B4-pushurl",
  "B5-journal",
  "B6-owner-open",
  "B6-owner-closed",
  "B6-agent-own",
  "B7-identity",
  "P3-object",
  "P4-journal",
  "P6-malformed",
  "P7-crash",
  "P8-lost-writer",
  "P9-shadow",
  "shadow-merge",
  "shadow-discard",
  "P10-lost-git-dir",
  "sha256",
  "owner-keep",
  "owner-other-item-keep",
  "owner-drop-keep",
  "owner-chat-keep",
  "agent-keep",
  "review-default",
  "review-null",
  "credentials",
  "read-during-record",
  "deferral-card-remind",
  "deferral-card-monday",
  "deferral-plain-remind",
  "deferral-card-other-item",
  "H3-packed-ref",
  "M1-unanchored",
  "M2-nondescendant",
  "M4-modes",
  "tree-substitution",
] as const)("writer real git: %s", (scenario) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const vcs = yield* Vcs.VcsProcess;
    const tmp = yield* fs.makeTempDirectoryScoped();
    const root = yield* fs.realPath(tmp);
    const source = `${root}/seed`;
    const remote = `${root}/remote.git`;
    yield* fs.makeDirectory(source);
    const git = Effect.fn("WriterTest.git")((cwd: string, args: ReadonlyArray<string>) =>
      vcs
        .run({ operation: "test.writer", command: "git", cwd, args })
        .pipe(Effect.map((r) => r.stdout.trim())),
    );
    const commit = (cwd: string) =>
      git(cwd, [
        "-c",
        "user.name=Fixture Bot",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "fixture",
      ]);
    yield* git(source, [
      "init",
      "-b",
      "main",
      ...(scenario === "sha256" ? ["--object-format=sha256"] : []),
    ]);
    yield* fs.writeFileString(`${source}/rules.md`, "Invented rules\n");
    yield* fs.writeFileString(`${source}/INDEX.md`, "As of 2026-11-08T00:00:00.000Z\n");
    if (
      scenario.startsWith("B6") ||
      scenario.endsWith("-keep") ||
      scenario === "P3-object" ||
      scenario === "supersede-retry" ||
      scenario === "update-provenance" ||
      scenario === "P6-malformed"
    ) {
      yield* fs.makeDirectory(`${source}/claims`);
      yield* fs.writeFileString(
        `${source}/claims/existing.md`,
        scenario === "P6-malformed"
          ? "---\nid: [\n---\n"
          : fixtureItem({
              kind: "claim",
              status: ["B6-owner-open", "supersede-retry", "update-provenance"].includes(scenario)
                ? "open"
                : "done",
              source: scenario === "supersede-retry" ? "fixture-owner-message" : "original-source",
              source_event: "original-event",
              trust: scenario === "B6-agent-own" || scenario === "agent-keep" ? "agent" : "owner",
              said_by: scenario === "B6-agent-own" ? agentId : "fixture-owner",
            }),
      );
    }
    if (scenario.startsWith("deferral-")) {
      yield* fs.makeDirectory(`${source}/deferrals`);
      yield* fs.writeFileString(`${source}/deferrals/def-001.md`, fixtureItem());
    }
    if (scenario === "B5-journal" || scenario === "P4-journal") {
      yield* fs.makeDirectory(`${source}/journal/2026`, { recursive: true });
      yield* fs.writeFile(
        `${source}/journal/2026/11-08.md`,
        Buffer.concat([
          scenario === "B5-journal" ? Buffer.from([255, 10]) : Buffer.alloc(0),
          Buffer.from("Owner journal preserved.\n"),
        ]),
      );
    }
    if (scenario === "M4-modes") {
      yield* fs.symlink("rules.md", `${source}/owner-link`);
      yield* fs.makeDirectory(`${source}/claims`, { recursive: true });
      yield* fs.symlink(fixtureItem({ kind: "claim" }), `${source}/claims/link.md`);
      yield* fs.writeFileString(`${source}/owner-executable`, "fixture executable\n");
      yield* fs.chmod(`${source}/owner-executable`, 0o755);
    }
    yield* git(source, ["add", "--", "."]);
    if (scenario === "M4-modes")
      yield* git(source, ["update-index", "--chmod=+x", "owner-executable"]);
    yield* commit(source);
    if (scenario === "M4-modes") {
      const head = yield* git(source, ["rev-parse", "HEAD"]);
      yield* git(source, [
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${head},owner-submodule`,
      ]);
      yield* commit(source);
    }
    yield* git(root, ["clone", "--bare", "--", source, remote]);
    let attack: { objectPath: string; sha: string; expression: string; bytes: Buffer } | undefined;
    let swapped = false;
    let substituteTree: string | undefined;
    let onRefChange:
      | (() => Effect.Effect<
          void,
          | Memory.MemoryError
          | Memory.MemoryCheckoutInvalid
          | Memory.MemoryConfigError
          | Memory.MemorySyncConflict
          | Memory.MemoryQueryDecodeError
        >)
      | undefined;
    let failBranch = false;
    const interceptedGit = Layer.succeed(
      Vcs.VcsProcess,
      Vcs.VcsProcess.of({
        run: Effect.fn("WriterTest.objectSwap")(function* (input) {
          if (
            attack &&
            input.args.includes("cat-file") &&
            (input.stdin?.includes(attack.sha) || input.args.includes(attack.expression))
          ) {
            yield* fs.remove(attack.objectPath).pipe(Effect.orDie);
            yield* fs.writeFile(attack.objectPath, attack.bytes).pipe(Effect.orDie);
            attack = undefined;
            swapped = true;
          }
          if (failBranch && input.args.includes("rev-parse")) {
            failBranch = false;
            return yield* new VcsProcessSpawnError({
              operation: "test.writer",
              command: "git",
              cwd: input.cwd,
              cause: "fixture branch failure",
            });
          }
          const result = yield* vcs.run(input);
          if (substituteTree && input.args.includes("write-tree"))
            return { ...result, stdout: substituteTree };
          if (onRefChange && input.args.includes("update-ref")) {
            const callback = onRefChange;
            onRefChange = undefined;
            yield* callback().pipe(Effect.orDie);
          }
          return result;
        }),
      }),
    );
    const notices: Writer.WriterNotice[] = [];
    const config = Layer.succeed(MemoryConfig, {
      baseDirectory: root,
      credentialHelper: "fixture-server-helper",
      repositories: [{ orgId, repoUrl: remote, path: "state" }],
    });
    const synced: Array<ReadonlyArray<MemoryItemHead>> = [];
    const memoryLayer = Memory.layer.pipe(
      Layer.provide(config),
      Layer.provide(Layer.succeed(Memory.MemoryRecoveryHooks, { notify: () => Effect.void })),
      Layer.provide(
        Layer.succeed(Memory.MemorySyncHooks, {
          syncItems: (_org, snapshot) =>
            Effect.sync(() => {
              synced.push(snapshot.items.map(({ head }) => head));
            }),
        }),
      ),
    );
    const hooks = Layer.succeed(Writer.MemoryWriterHooks, {
      notify: Effect.fn("Test.notice")((notice) =>
        Effect.sync(() => {
          notices.push(notice);
        }),
      ),
    });
    const auth = Layer.succeed(Writer.MemoryWriterAuthority, {
      resolve: Effect.fn("Test.authority")(
        (
          org: KinOrgId,
          wakeupId: string,
        ): Effect.Effect<Writer.WakeupContext, Writer.MemoryWriteRejected> =>
          org !== orgId
            ? Effect.fail(new Writer.MemoryWriteRejected({ reason: "not_found" }))
            : Effect.succeed({
                orgId,
                wakeupId,
                agentId,
                level:
                  scenario === "conflict" ||
                  scenario === "B5-journal" ||
                  scenario === "read-during-record" ||
                  scenario.startsWith("deferral-")
                    ? "L1"
                    : "L0",
                timeZone: "Asia/Kolkata",
                startedAt: "2026-11-08T00:00:00.000Z",
                eventIds: [],
                stagedReceipts:
                  scenario === "lost-session-retry" || scenario === "recovered-no-end",
                sources: new Map<
                  string,
                  Writer.WakeupContext["sources"] extends ReadonlyMap<string, infer S> ? S : never
                >([
                  [
                    "owner",
                    scenario === "owner-keep" ||
                    scenario === "owner-other-item-keep" ||
                    scenario === "owner-drop-keep"
                      ? {
                          saidBy: "fixture-owner",
                          trust: "owner",
                          source: "fixture-owner-message",
                          kind: "owner_check",
                          itemId: scenario === "owner-other-item-keep" ? "other-item" : "def-001",
                          action: scenario === "owner-drop-keep" ? "drop" : "keep",
                        }
                      : scenario === "deferral-card-monday"
                        ? {
                            saidBy: "fixture-owner",
                            trust: "owner",
                            source: "fixture-owner-message",
                            kind: "deferral_card",
                            itemId: "def-001",
                            action: "monday",
                            due: "2026-11-16T09:00:00.000+05:30",
                          }
                        : scenario === "deferral-card-remind" ||
                            scenario === "deferral-card-other-item"
                          ? {
                              saidBy: "fixture-owner",
                              trust: "owner",
                              source: "fixture-owner-message",
                              kind: "deferral_card",
                              itemId:
                                scenario === "deferral-card-other-item" ? "other-item" : "def-001",
                              action: "remind",
                            }
                          : {
                              saidBy: "fixture-owner",
                              trust: "owner",
                              source: "fixture-owner-message",
                            },
                  ],
                  [
                    "member",
                    {
                      saidBy: "fixture-member",
                      trust: "member",
                      source: "fixture-member-message",
                    },
                  ],
                ]),
              }),
      ),
    });
    const scan = Scan.layer;
    const layer = Writer.layer.pipe(
      Layer.provideMerge(memoryLayer),
      Layer.provide(Layer.succeed(Memory.MemoryRecoveryHooks, { notify: () => Effect.void })),
      Layer.provide(config),
      Layer.provide(hooks),
      Layer.provide(auth),
      Layer.provide(scan),
    );
    yield* Effect.gen(function* () {
      const memory = yield* Memory.Memory;
      const writer = yield* Writer.MemoryWriter;
      const paths = yield* memory.ensureCheckouts(orgId);
      yield* memory.prepareWakeup(orgId);
      yield* git(paths.writer, ["config", "user.name", "Fixture Bot"]);
      yield* git(paths.writer, ["config", "user.email", "fixture@example.invalid"]);
      const original = yield* git(paths.writer, ["rev-parse", "HEAD"]);
      if (scenario === "lost-session-retry") {
        failBranch = true;
        expect((yield* writer.appendJournal(orgId, "wake1", []).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        yield* writer.appendJournal(orgId, "wake1", []);
        const committed = yield* writer.commitWakeup(orgId, "wake1", "completed");
        expect(
          yield* git(paths.writer, ["show", `${committed.commit}:journal/2026/11-08.md`]),
        ).toContain("lost on restart");
        return;
      }
      if (scenario === "recovered-no-end") {
        const committed = yield* writer.commitWakeup(orgId, "wake1", "completed");
        yield* writer.discard(orgId, "wake1");
        yield* writer.appendJournal(orgId, "wake1", ["Lead ended without calling kin_end."]);
        expect(yield* writer.commitWakeup(orgId, "wake1", "completed")).toEqual(committed);
        return;
      }
      if (scenario === "supersede-retry" || scenario === "update-provenance") {
        const change =
          scenario === "supersede-retry"
            ? {
                path: "claims/replacement.md",
                supersedes: "def-001",
                sourceEventId: "owner",
                content: fixtureItem({
                  id: "replacement",
                  kind: "claim",
                  recorded_at: "2026-11-08T00:00:00.000Z",
                }),
              }
            : {
                path: "claims/existing.md",
                sourceEventId: "owner",
                content: fixtureItem({ kind: "claim", status: "done" }),
              };
        yield* writer.stage(orgId, "wake1", change);
        yield* writer.stage(orgId, "wake1", change);
        if (scenario === "supersede-retry") {
          expect(
            (yield* writer
              .stage(orgId, "wake1", { ...change, content: change.content + "changed" })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        const committed = yield* writer.commitWakeup(orgId, "wake1", "completed");
        const existing = yield* git(paths.writer, [
          "show",
          `${committed.commit}:claims/existing.md`,
        ]);
        expect(existing).toContain("source_event: original-event");
        expect(existing).toContain(
          scenario === "supersede-retry" ? "status: superseded" : "status: done",
        );
        return;
      }
      if (scenario === "M4-modes") {
        const before = yield* git(paths.writer, [
          "ls-tree",
          original,
          "owner-link",
          "owner-executable",
          "owner-submodule",
        ]);
        const result = yield* writer.commitWakeup(orgId, "wake1", "completed");
        expect(
          yield* git(paths.writer, [
            "ls-tree",
            result.commit,
            "owner-link",
            "owner-executable",
            "owner-submodule",
          ]),
        ).toBe(before);
        expect(before).toContain("100755");
        expect(before).toContain("120000");
        expect(before).toContain("160000");
        return;
      }
      if (
        scenario === "H3-packed-ref" ||
        scenario === "M1-unanchored" ||
        scenario === "M2-nondescendant"
      ) {
        yield* fs.writeFileString(`${paths.read}/rules.md`, "FORGED RULES\n");
        yield* git(paths.read, ["add", "rules.md"]);
        yield* commit(paths.read);
        const forged = yield* git(paths.read, ["rev-parse", "HEAD"]);
        yield* git(paths.writer, ["fetch", "--", paths.read, forged]);
        const shadow = `kin/shadow/${agentId}`;
        if (scenario === "H3-packed-ref") {
          yield* fs.writeFileString(
            `${paths.writer}/.git/packed-refs`,
            `# pack-refs with: peeled fully-peeled sorted\n${forged} refs/heads/kin/shadow/stray\n${forged} refs/remotes/kin-recovery/${shadow}\n`,
          );
          yield* memory.recover(orgId);
        } else if (scenario === "M1-unanchored") {
          yield* git(paths.writer, ["update-ref", `refs/heads/${shadow}`, forged]);
        } else {
          yield* memory.anchor(orgId, shadow, original);
          yield* git(paths.writer, ["update-ref", `refs/heads/${shadow}`, original]);
          yield* git(paths.read, ["checkout", "--orphan", "unrelated"]);
          yield* commit(paths.read);
          const unrelated = yield* git(paths.read, ["rev-parse", "HEAD"]);
          yield* git(paths.writer, ["fetch", "--", paths.read, unrelated]);
          yield* git(paths.writer, ["update-ref", `refs/heads/${shadow}`, unrelated]);
          yield* git(paths.writer, ["update-ref", "refs/heads/main", unrelated]);
          yield* memory.prepareWakeup(orgId);
        }
        const result = yield* writer.commitWakeup(orgId, "wake1", "completed");
        expect(yield* git(root, [`--git-dir=${remote}`, "show", `${result.commit}:rules.md`])).toBe(
          "Invented rules",
        );
        if (scenario === "H3-packed-ref")
          expect(
            (yield* git(paths.writer, [
              "rev-parse",
              "--verify",
              "refs/heads/kin/shadow/stray",
            ]).pipe(Effect.result))._tag,
          ).toBe("Failure");
        return;
      }
      if (scenario === "read-during-record") {
        onRefChange = () => memory.readRules(orgId).pipe(Effect.asVoid);
        const { commit } = yield* writer.commitWakeup(orgId, "wake1", "completed");
        expect(yield* git(paths.writer, ["rev-parse", "refs/heads/main"])).toBe(commit);
        expect(yield* memory.anchor(orgId, "main")).toBe(commit);
        return;
      }
      if (scenario === "credentials") {
        yield* git(paths.writer, ["config", "credential.helper", "fixture-repo-helper"]);
        const helper = yield* memoryGit(paths.writer, [
          "config",
          "--get-all",
          "credential.helper",
        ]).pipe(
          Effect.provideService(MemoryConfig, {
            baseDirectory: root,
            credentialHelper: "fixture-server-helper",
            repositories: [],
          }),
        );
        expect(helper.trim()).toBe("fixture-server-helper");
        return;
      }
      if (scenario === "review-default" || scenario === "review-null") {
        const content = fixtureItem({
          kind: "claim",
          review_by: null,
          recorded_at: "2026-11-01T00:00:00.000Z",
        });
        yield* writer.stage(orgId, "wake1", {
          path: "claims/default.md",
          content:
            scenario === "review-default" ? content.replace(/^review_by:.*\n/m, "") : content,
        });
        const { commit } = yield* writer.commitWakeup(orgId, "wake1", "completed");
        const text = yield* git(paths.writer, ["show", `${commit}:claims/default.md`]);
        expect(text).toContain(
          scenario === "review-default" ? "2026-12-01T00:00:00.000Z" : "review_by: null",
        );
        expect(yield* git(paths.writer, ["show", `${commit}:INDEX.md`])).toContain(
          "claims/default.md",
        );
        expect(yield* git(paths.writer, ["rev-list", "--count", `${original}..${commit}`])).toBe(
          "1",
        );
        return;
      }
      if (scenario === "P10-lost-git-dir") {
        yield* git(root, ["init", "--quiet"]);
        yield* fs.remove(`${paths.writer}/.git`, { recursive: true });
        const result = yield* writer
          .stage(orgId, "wake1", { path: "claims/new.md", content: fixtureItem({ kind: "claim" }) })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toMatchObject({
            _tag: "MemoryCheckoutInvalid",
            operation: "validate",
          });
        return;
      }
      if (scenario === "shadow-merge" || scenario === "shadow-discard") {
        const remoteHead = (branch: string) =>
          git(root, [`--git-dir=${remote}`, "rev-parse", `refs/heads/${branch}`]);
        yield* writer.stage(orgId, "wake1", {
          path: "deferrals/def-001.md",
          content: fixtureItem(),
          sourceEventId: "owner",
        });
        const shadowed = yield* writer.commitWakeup(orgId, "wake1", "completed");
        const main = yield* remoteHead("main");
        expect(yield* remoteHead(`kin/shadow/${agentId}`)).toBe(shadowed.commit);
        const keep = scenario === "shadow-merge";
        expect(yield* writer.settleShadow(orgId, agentId, keep)).toEqual({ kept: keep ? 2 : 0 });
        const settled = yield* remoteHead("main");
        expect(settled === main).toBe(!keep);
        // Either way the next L0 trial starts from main, not the old shadow week.
        expect(yield* remoteHead(`kin/shadow/${agentId}`)).toBe(settled);
        const files = yield* git(root, [
          `--git-dir=${remote}`,
          "ls-tree",
          "-r",
          "--name-only",
          settled,
        ]);
        expect(files.includes("deferrals/def-001.md")).toBe(keep);
        if (keep) {
          expect(
            yield* git(root, [`--git-dir=${remote}`, "log", "-1", "--format=%B", settled]),
          ).toContain(`Kin-Shadow: ${shadowed.commit}`);
          expect(yield* git(root, [`--git-dir=${remote}`, "show", `${settled}:rules.md`])).toBe(
            "Invented rules",
          );
        }
        // Settling again changes nothing.
        expect(yield* writer.settleShadow(orgId, agentId, keep)).toEqual({ kept: 0 });
        expect(yield* remoteHead("main")).toBe(settled);
        return;
      }
      if (scenario === "P8-lost-writer" || scenario === "P9-shadow") {
        if (scenario === "P9-shadow") yield* writer.commitWakeup(orgId, "wake0", "completed");
        yield* fs.remove(paths.writer, { recursive: true });
        yield* memory.recover(orgId);
        yield* memory.prepareWakeup(orgId);
        const result = yield* writer.commitWakeup(orgId, "wake1", "completed");
        expect(
          yield* git(root, [
            `--git-dir=${remote}`,
            "rev-parse",
            `refs/heads/kin/shadow/${agentId}`,
          ]),
        ).toBe(result.commit);
        return;
      }
      if (scenario === "P3-object" || scenario === "P4-journal") {
        const file = scenario === "P3-object" ? "claims/existing.md" : "journal/2026/11-08.md";
        const sha = yield* git(paths.writer, ["rev-parse", `${original}:${file}`]);
        const forged = Buffer.from("forged bytes after prepare\n");
        attack = {
          objectPath: `${paths.writer}/.git/objects/${sha.slice(0, 2)}/${sha.slice(2)}`,
          sha,
          expression: `${original}:${file}`,
          bytes: NodeZlib.deflateSync(
            Buffer.concat([Buffer.from(`blob ${forged.length}\0`), forged]),
          ),
        };
        const result =
          scenario === "P3-object"
            ? yield* writer
                .stage(orgId, "wake1", {
                  path: "claims/existing.md",
                  content: fixtureItem({ kind: "claim" }),
                })
                .pipe(Effect.result)
            : yield* writer.commitWakeup(orgId, "wake1", "completed").pipe(Effect.result);
        expect(swapped).toBe(true);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure._tag).toBe("MemoryCheckoutInvalid");
        return;
      }
      if (scenario === "P6-malformed") {
        const result = yield* writer
          .stage(orgId, "wake1", {
            path: "claims/existing.md",
            content: fixtureItem({ kind: "claim" }),
          })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure._tag).toBe("MemoryWriteRejected");
        return;
      }
      for (const path of [
        "rules.md",
        "INDEX.md",
        "README.md",
        "../claims/a.md",
        "/claims/a.md",
        "claims/.git/a.md",
        "claims/../../a.md",
        // Paths memory-check refuses in Kin's unowned folders.
        "deferrals/a.b.md",
        "deferrals/nested/a.md",
        "deferrals/CLAUDE.md",
      ]) {
        expect(
          (yield* writer
            .stage(orgId, "wake1", { path, content: fixtureItem() })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }
      // memory_write's `CLAUDE` id lands here; pushed, it would load into the owner's Claude Code.
      for (const path of ["deferrals/CLAUDE.md", "deferrals/AGENTS.md", "journal/x\\..\\a.md"])
        expect(
          yield* writer
            .stage(orgId, "wake1", { path, content: fixtureItem({ id: "CLAUDE" }) })
            .pipe(Effect.result),
        ).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "MemoryWriteRejected",
            reason: expect.stringContaining("Disallowed memory path"),
          },
        });
      yield* fs.symlink(source, `${paths.writer}/people`);
      expect(
        (yield* writer
          .stage(orgId, "wake1", {
            path: "people/new.md",
            content: fixtureItem({ kind: "person" }),
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* fs.remove(`${paths.writer}/people`);
      if (scenario === "completed") {
        yield* fs.makeDirectory(`${paths.writer}/claims`, { recursive: true });
        yield* fs.writeFileString(`${root}/hardlink-source`, fixtureItem({ kind: "claim" }));
        yield* fs.link(`${root}/hardlink-source`, `${paths.writer}/claims/hard.md`);
        expect(
          (yield* writer
            .stage(orgId, "wake1", {
              path: "claims/hard.md",
              content: fixtureItem({ kind: "claim" }),
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* fs.remove(`${paths.writer}/claims/hard.md`);
      }
      if (scenario === "forged") {
        yield* fs.writeFileString(`${paths.read}/rules.md`, "Forged rules\n");
        yield* git(paths.read, ["add", "--", "rules.md"]);
        yield* commit(paths.read);
        const forged = yield* git(paths.read, ["rev-parse", "HEAD"]);
        yield* git(paths.read, ["update-ref", "refs/heads/main", forged]);
        expect(yield* git(paths.writer, ["rev-parse", "HEAD"])).toBe(original);
        yield* git(paths.writer, ["fetch", "--", paths.read, forged]);
        yield* git(paths.writer, ["update-ref", "refs/heads/main", forged]);
        expect((yield* memory.prepareWakeup(orgId).pipe(Effect.result))._tag).toBe("Success");
        expect(yield* memory.readRules(orgId)).toBe("Invented rules\n");
        expect(
          (yield* writer.commitWakeup(orgId, "wake1", "completed").pipe(Effect.result))._tag,
        ).toBe("Success");
        return;
      }
      if (scenario === "B1-shadow" || scenario === "B2-anchor" || scenario === "P7-crash") {
        yield* fs.writeFileString(`${paths.read}/rules.md`, "Forged rules\n");
        yield* git(paths.read, ["add", "rules.md"]);
        yield* commit(paths.read);
        const branch = scenario === "B1-shadow" ? `kin/shadow/${agentId}` : "main";
        yield* git(paths.read, ["push", "--", paths.writer, `HEAD:refs/heads/${branch}`]).pipe(
          Effect.catch(() =>
            git(paths.writer, ["fetch", paths.read, "HEAD"]).pipe(
              Effect.andThen(
                git(paths.writer, ["update-ref", `refs/heads/${branch}`, "FETCH_HEAD"]),
              ),
            ),
          ),
        );
        if (scenario === "B2-anchor")
          yield* fs.writeFileString(
            `${paths.writer}/../writer-head`,
            yield* git(paths.read, ["rev-parse", "HEAD"]),
          );
        expect(
          (yield* writer.commitWakeup(orgId, "wake1", "completed").pipe(Effect.result))._tag,
        ).toBe("Success");
        return;
      }
      if (scenario === "deferral-plain-remind" || scenario === "deferral-card-other-item") {
        const result = yield* writer
          .stage(orgId, "wake1", {
            path: "deferrals/def-001.md",
            content: fixtureItem({ on_due: "remind" }),
            sourceEventId: "owner",
          })
          .pipe(Effect.result);
        expect(result._tag === "Failure" && result.failure._tag).toBe("MemoryConflict");
        return;
      }
      if (scenario === "deferral-card-monday") {
        const stage = (fields: Record<string, unknown>) =>
          writer
            .stage(orgId, "wake1", {
              path: "deferrals/def-001.md",
              content: fixtureItem(fields),
              sourceEventId: "owner",
            })
            .pipe(Effect.result);
        for (const forged of [
          { due: "2026-11-17T09:00:00.000+05:30" },
          { due: "2026-11-16T09:00:00.000+05:30", on_due: "remind" },
        ]) {
          const result = yield* stage(forged);
          expect(result._tag === "Failure" && result.failure._tag).toBe("MemoryConflict");
        }
        expect((yield* stage({ due: "2026-11-16T09:00:00.000+05:30" }))._tag).toBe("Success");
        return;
      }
      if (scenario === "deferral-card-remind") {
        const stage = (onDue: string) =>
          writer
            .stage(orgId, "wake1", {
              path: "deferrals/def-001.md",
              content: fixtureItem({ on_due: onDue }),
              sourceEventId: "owner",
            })
            .pipe(Effect.result);
        const forged = yield* stage("ask");
        expect(forged._tag === "Failure" && forged.failure._tag).toBe("MemoryConflict");
        expect((yield* stage("remind"))._tag).toBe("Success");
        const committed = yield* writer.commitWakeup(orgId, "wake1", "completed");
        expect(
          yield* git(paths.writer, ["show", `${committed.commit}:deferrals/def-001.md`]),
        ).toContain("on_due: remind");
        const last = synced.at(-1)?.find((item) => item.id === "def-001");
        expect(last?.on_due).toBe("remind");
        return;
      }
      if (scenario.endsWith("-keep")) {
        const content = fixtureItem({
          kind: "claim",
          status: "done",
          trust: scenario === "agent-keep" ? "agent" : "owner",
          said_by: "fixture-owner",
          review_by: "2026-12-13",
        });
        const result = yield* writer
          .stage(orgId, "wake1", {
            path: "claims/existing.md",
            content,
            ...(scenario !== "agent-keep" ? { sourceEventId: "owner" } : {}),
          })
          .pipe(Effect.result);
        expect(result._tag).toBe(scenario === "owner-keep" ? "Success" : "Failure");
        if (result._tag === "Failure") expect(result.failure._tag).toBe("MemoryConflict");
        if (result._tag === "Success") {
          const committed = yield* writer.commitWakeup(orgId, "wake1", "completed");
          expect(
            yield* git(paths.writer, ["show", `${committed.commit}:claims/existing.md`]),
          ).toContain("review_by: 2026-12-13");
        }
        return;
      }
      if (scenario.startsWith("B6")) {
        const result = yield* writer
          .stage(orgId, "wake1", {
            path: "claims/existing.md",
            content: fixtureItem({
              kind: "claim",
              title:
                scenario === "B6-owner-open"
                  ? "Invented service maintenance"
                  : "Forged replacement",
              status: scenario === "B6-owner-open" ? "done" : "open",
            }),
          })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        return;
      }
      const marker = `${root}/executed`;
      if (scenario === "B3-execution") {
        const script = `${root}/attack.sh`;
        yield* fs.writeFileString(
          script,
          `#!/bin/sh\ntouch '${marker}'\nprintf 'filtered attack\\n'\n`,
        );
        yield* fs.chmod(script, 0o755);
        for (const repo of [paths.read, paths.writer]) {
          yield* fs.makeDirectory(`${repo}/.git/hooks`, { recursive: true });
          yield* fs.writeFileString(
            `${repo}/.git/hooks/post-checkout`,
            `#!/bin/sh\ntouch '${marker}'\n`,
          );
          yield* fs.chmod(`${repo}/.git/hooks/post-checkout`, 0o755);
          yield* git(repo, ["config", "core.fsmonitor", script]);
        }
        yield* fs.writeFileString(
          `${paths.writer}/.git/hooks/reference-transaction`,
          `#!/bin/sh\ntouch '${marker}'\n`,
        );
        yield* fs.chmod(`${paths.writer}/.git/hooks/reference-transaction`, 0o755);
        yield* git(paths.writer, ["config", "filter.attack.clean", script]);
        yield* fs.writeFileString(`${paths.writer}/.git/info/attributes`, "*.md filter=attack\n");
        yield* git(paths.writer, ["config", "remote.origin.receivepack", script]);
        yield* git(paths.writer, ["config", "uploadpack.packObjectsHook", script]);
        yield* memory.prepareWakeup(orgId);
        expect(yield* fs.exists(marker)).toBe(false);
      }
      let evil = "";
      if (scenario === "B4-pushurl") {
        evil = `${root}/evil.git`;
        yield* git(root, ["init", "--bare", evil]);
        yield* git(paths.writer, ["config", "remote.origin.pushurl", evil]);
      }
      if (scenario === "B5-journal") {
        yield* fs.makeDirectory(`${paths.writer}/journal/2026`, { recursive: true });
        yield* fs.writeFileString(`${paths.writer}/journal/2026/11-08.md`, "Forged journal\n");
      }
      yield* writer.stage(orgId, "wake1", {
        path: "claims/new.md",
        content: fixtureItem({
          kind: "claim",
          trust: "owner",
          said_by: "forged-owner",
          source: "forged",
        }),
      });

      if (scenario === "completed") {
        const contradiction = yield* writer
          .stage(orgId, "wake1", {
            path: "claims/contradiction.md",
            content: fixtureItem({
              id: "other",
              kind: "claim",
              title: "Different invented claim",
            }),
          })
          .pipe(Effect.result);
        expect(contradiction._tag).toBe("Failure");
        if (contradiction._tag === "Failure")
          expect(contradiction.failure._tag).toBe("MemoryConflict");
        for (const sourceEventId of ["owner", "member"]) {
          yield* writer.stage(orgId, "wake1", {
            path: `claims/${sourceEventId}.md`,
            sourceEventId,
            content: fixtureItem({ id: sourceEventId, kind: "claim", links: [] }),
          });
        }
        yield* fs.writeFileString(`${paths.writer}/rules.md`, "Ambient forged edit");
        yield* git(paths.writer, ["add", "--", "rules.md"]);
      }
      if (scenario === "conflict") {
        yield* fs.makeDirectory(`${source}/claims`);
        yield* fs.writeFileString(`${source}/claims/new.md`, "Owner conflicting fixture\n");
        yield* git(source, ["add", "--", "claims/new.md"]);
        yield* commit(source);
        yield* git(source, ["push", "--", remote, "main"]);
      }
      if (scenario === "tree-substitution")
        substituteTree = yield* git(paths.writer, ["rev-parse", `${original}^{tree}`]);
      if (scenario === "blocked") {
        const tokenPath = "claims/" + ["gh", "p_", "a".repeat(36)].join("") + ".md";
        const malformed = yield* writer
          .stage(orgId, "wake1", {
            path: tokenPath,
            content: "---\nid: [\n" + tokenPath + ": [\n---\nbody",
          })
          .pipe(Effect.result);
        expect(malformed._tag).toBe("Failure");
        if (malformed._tag === "Failure") {
          expect(malformed.failure._tag).toBe("MemoryItemError");
          expect(JSON.stringify(malformed.failure).includes(tokenPath.slice(7, -3))).toBe(false);
          if (malformed.failure._tag === "MemoryItemError")
            expect(malformed.failure.path).toBe("[redacted]");
        }
        const inaccessible = yield* writer
          .stage(orgId, "wake1", {
            path: tokenPath.slice(0, -3) + "_".repeat(260) + ".md",
            content: "missing front matter",
          })
          .pipe(Effect.result);
        expect(inaccessible._tag).toBe("Failure");
        if (inaccessible._tag === "Failure")
          expect(JSON.stringify(inaccessible.failure).includes(tokenPath.slice(7, -3))).toBe(false);
      }
      if (scenario === "blocked")
        yield* writer.appendJournal(orgId, "wake1", [
          ["gh", "p_"].join("") + "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iL3oR6",
        ]);
      if (scenario === "scan unavailable") {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DROP TABLE kin_secret_allow`;
      }
      if (scenario === "scan limit")
        yield* writer.appendJournal(orgId, "wake1", ["a".repeat(1024 * 1024)]);
      const result = yield* writer
        .commitWakeup(orgId, "wake1", scenario === "failed" ? "failed" : "completed")
        .pipe(Effect.result);
      if (result._tag === "Failure") yield* Effect.logError(result.failure);
      if (scenario === "scan unavailable" || scenario === "scan limit") {
        expect(result._tag).toBe("Failure");
        expect(notices).toHaveLength(1);
        expect(notices[0]!.error._tag).toBe("KinSecretScanError");
        expect(yield* git(paths.writer, ["rev-parse", "HEAD"])).toBe(original);
        return;
      }
      if (scenario === "tree-substitution") {
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure._tag).toBe("MemoryCheckoutInvalid");
        expect(yield* git(paths.writer, ["rev-parse", "main"])).toBe(original);
        return;
      }
      if (scenario === "blocked" || scenario === "conflict") {
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure._tag).toBe(
            scenario === "blocked" ? "MemorySecretBlocked" : "MemorySyncConflict",
          );

        expect(notices).toHaveLength(1);
        if (scenario === "blocked") {
          expect(JSON.stringify(notices)).not.toContain("aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iL3oR6");
          expect(yield* git(paths.writer, ["rev-parse", "HEAD"])).toBe(original);
          expect(
            (yield* git(root, [
              `--git-dir=${remote}`,
              "show-ref",
              "--verify",
              `refs/heads/kin/shadow/${agentId}`,
            ]).pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(yield* fs.exists(`${paths.writer}/claims/new.md`)).toBe(false);
        }
        expect(yield* fs.exists(`${paths.writer}/.git/rebase-merge`)).toBe(false);
      } else {
        expect(result._tag).toBe("Success");
        const branch = scenario === "B5-journal" ? "main" : `kin/shadow/${agentId}`;
        expect(yield* git(paths.writer, ["rev-list", "--count", `${original}..${branch}`])).toBe(
          "1",
        );
        expect(yield* git(paths.writer, ["show", `${branch}:rules.md`])).toBe("Invented rules");
        if (scenario === "B3-execution") expect(yield* fs.exists(marker)).toBe(false);
        if (scenario === "B4-pushurl") {
          expect(
            yield* git(root, [`--git-dir=${remote}`, "rev-parse", `refs/heads/${branch}`]),
          ).toBe(result._tag === "Success" ? result.success.commit : "");
          expect(
            (yield* git(root, [
              `--git-dir=${evil}`,
              "rev-parse",
              "--verify",
              `refs/heads/${branch}`,
            ]).pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        if (scenario === "B5-journal") {
          const journal = yield* git(paths.writer, ["show", `${branch}:journal/2026/11-08.md`]);
          expect(journal).toContain("Owner journal preserved.");
          const chunks: Uint8Array[] = [];
          yield* vcs.run({
            operation: "WriterTest.journalBytes",
            command: "git",
            cwd: paths.writer,
            args: ["show", `${branch}:journal/2026/11-08.md`],
            onStdoutChunk: (chunk) => chunks.push(chunk),
          });
          expect(Buffer.concat(chunks).subarray(0, 2)).toEqual(Buffer.from([255, 10]));
          expect(journal).not.toContain("Forged journal");
        }
        const again = yield* writer.commitWakeup(
          orgId,
          "wake1",
          scenario === "failed" ? "failed" : "completed",
        );
        if (result._tag === "Success") expect(again.commit).toBe(result.success.commit);
        expect(yield* git(paths.writer, ["show", "--format=%an <%ae>", "--no-patch", branch])).toBe(
          "Kin Memory Bot <kin-memory@localhost>",
        );
        expect(
          (yield* git(paths.writer, ["cat-file", "-e", `${branch}:claims/new.md`]).pipe(
            Effect.result,
          ))._tag,
        ).toBe(scenario !== "failed" ? "Success" : "Failure");
        expect(yield* git(paths.writer, ["show", `${branch}:journal/2026/11-08.md`])).toContain(
          `Outcome: ${scenario === "failed" ? "failed" : "completed"}`,
        );
      }
    }).pipe(Effect.provide(layer.pipe(Layer.provide(interceptedGit))));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        gitLayer,
        NodeServices.layer,
        Persistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)),
      ),
    ),
    Effect.scoped,
  ),
);

it.effect.each([
  { startedAt: "not-a-date", timeZone: "UTC" },
  { startedAt: "2026-11-08T00:00:00Z", timeZone: "Not/AZone" },
])("rejects invalid journal context: %j", (input) =>
  Effect.gen(function* () {
    const result = yield* journalEntry(
      { ...input, wakeupId: "fixture", agentId: "fixture", level: "L1", eventIds: [] },
      "completed",
      [],
    ).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure._tag).toBe("MemoryJournalError");
  }),
);
