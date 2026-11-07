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
import { fixtureItem } from "./__fixtures__/items.ts";

const orgId = KinOrgId.make("fixture-org");
const agentId = KinAgentId.make("fixture-lead");
const gitLayer = Vcs.layer.pipe(Layer.provide(NodeServices.layer));
it.live.each(["completed", "failed", "blocked", "forged", "conflict"] as const)(
  "writer real git: %s",
  (scenario) =>
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
      yield* git(source, ["init", "-b", "main"]);
      yield* fs.writeFileString(`${source}/rules.md`, "Invented rules\n");
      yield* fs.writeFileString(`${source}/INDEX.md`, "As of 2026-11-08T00:00:00.000Z\n");
      yield* git(source, ["add", "--", "."]);
      yield* commit(source);
      yield* git(root, ["clone", "--bare", "--", source, remote]);
      const notices: Writer.WriterNotice[] = [];
      const config = Layer.succeed(MemoryConfig, {
        baseDirectory: root,
        repositories: [{ orgId, repoUrl: remote, path: "state" }],
      });
      const memoryLayer = Memory.layer.pipe(Layer.provide(config));
      const hooks = Layer.succeed(Writer.MemoryWriterHooks, {
        notify: Effect.fn("Test.notice")((notice) =>
          Effect.sync(() => {
            notices.push(notice);
          }),
        ),
        buildIndex: Effect.fn("Test.index")(() => Effect.succeed(null)),
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
                  level: scenario === "conflict" ? "L1" : "L0",
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
      const scan =
        scenario === "blocked"
          ? Scan.testLayer([{ path: "claims/new.md", ruleId: "fixture", line: 1 }])
          : Scan.stubLayer;
      const layer = Writer.layer.pipe(
        Layer.provideMerge(memoryLayer),
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
        yield* fs.symlink(source, `${paths.writer}/claims`);
        expect(
          (yield* writer
            .stage(orgId, "wake1", {
              path: "claims/new.md",
              content: fixtureItem({ kind: "claim" }),
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* fs.remove(`${paths.writer}/claims`);
        if (scenario === "forged") {
          yield* fs.writeFileString(`${paths.read}/rules.md`, "Forged rules\n");
          yield* git(paths.read, ["add", "--", "rules.md"]);
          yield* commit(paths.read);
          const forged = yield* git(paths.read, ["rev-parse", "HEAD"]);
          yield* git(paths.read, ["update-ref", "refs/heads/main", forged]);
          expect(yield* git(paths.writer, ["rev-parse", "HEAD"])).toBe(original);
          expect((yield* memory.prepareWakeup(orgId)).head).toBe(original);
          yield* git(paths.writer, ["fetch", "--", paths.read, forged]);
          yield* git(paths.writer, ["update-ref", "refs/heads/main", forged]);
          expect((yield* memory.prepareWakeup(orgId).pipe(Effect.result))._tag).toBe("Failure");
          expect(
            (yield* writer.commitWakeup(orgId, "wake1", "completed").pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(notices.at(-1)?.error._tag).toBe("MemoryCheckoutInvalid");
          return;
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
        expect(yield* fs.readFileString(`${paths.writer}/claims/new.md`)).toContain(
          "said_by: fixture-lead",
        );
        expect(yield* fs.readFileString(`${paths.writer}/claims/new.md`)).toContain("trust: agent");
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
            expect(
              yield* fs.readFileString(`${paths.writer}/claims/${sourceEventId}.md`),
            ).toContain(`trust: ${sourceEventId}`);
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
        const result = yield* writer
          .commitWakeup(orgId, "wake1", scenario === "failed" ? "failed" : "completed")
          .pipe(Effect.result);
        if (scenario === "blocked" || scenario === "conflict") {
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure._tag).toBe(
              scenario === "blocked" ? "MemorySecretBlocked" : "MemorySyncConflict",
            );
          expect(yield* git(paths.writer, ["status", "--porcelain"])).toBe("");
          expect(notices).toHaveLength(1);
          expect(yield* fs.exists(`${paths.writer}/.git/rebase-merge`)).toBe(false);
        } else {
          expect(result._tag).toBe("Success");
          expect(yield* git(paths.writer, ["rev-list", "--count", `${original}..HEAD`])).toBe("1");
          expect(yield* fs.readFileString(`${paths.writer}/rules.md`)).toBe("Invented rules\n");
          const again = yield* writer.commitWakeup(
            orgId,
            "wake1",
            scenario === "failed" ? "failed" : "completed",
          );
          if (result._tag === "Success") expect(again.commit).toBe(result.success.commit);
          expect(
            yield* git(paths.writer, ["show", "--format=%an <%ae>", "--no-patch", "HEAD"]),
          ).toBe("Fixture Bot <fixture@example.invalid>");
          expect(yield* fs.exists(`${paths.writer}/claims/new.md`)).toBe(scenario === "completed");
          expect(yield* fs.readFileString(`${paths.writer}/journal/2026/11-08.md`)).toContain(
            `Outcome: ${scenario}`,
          );
        }
      }).pipe(Effect.provide(layer));
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
