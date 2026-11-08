import { memoryGit } from "./git.ts";
import * as NodeZlib from "node:zlib";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { KinAgentId, KinOrgId } from "@t3tools/contracts";
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
  "completed",
  "failed",
  "blocked",
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
  "sha256",
  "review-default",
  "review-null",
  "credentials",
  "read-during-record",
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
    if (scenario.startsWith("B6") || scenario === "P3-object" || scenario === "P6-malformed") {
      yield* fs.makeDirectory(`${source}/claims`);
      yield* fs.writeFileString(
        `${source}/claims/existing.md`,
        scenario === "P6-malformed"
          ? "---\nid: [\n---\n"
          : fixtureItem({
              kind: "claim",
              status: scenario === "B6-owner-open" ? "open" : "done",
              trust: scenario === "B6-agent-own" ? "agent" : "owner",
              said_by: scenario === "B6-agent-own" ? agentId : "fixture-owner",
            }),
      );
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
    const memoryLayer = Memory.layer.pipe(
      Layer.provide(config),
      Layer.provide(Layer.succeed(Memory.MemoryRecoveryHooks, { notify: () => Effect.void })),
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
                  scenario === "read-during-record"
                    ? "L1"
                    : "L0",
                timeZone: "Asia/Kolkata",
                startedAt: "2026-11-08T00:00:00.000Z",
                eventIds: [],
                sources: new Map([
                  [
                    "owner",
                    { saidBy: "fixture-owner", trust: "owner", source: "fixture-owner-message" },
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
      ]) {
        expect(
          (yield* writer
            .stage(orgId, "wake1", { path, content: fixtureItem() })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }
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
      if (scenario === "blocked")
        yield* writer.appendJournal(orgId, "wake1", [
          ["gh", "p_"].join("") + "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iL3oR6",
        ]);
      const result = yield* writer
        .commitWakeup(orgId, "wake1", scenario === "failed" ? "failed" : "completed")
        .pipe(Effect.result);
      if (result._tag === "Failure") yield* Effect.logError(result.failure);
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
