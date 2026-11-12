import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { KinAgentId, KinOrgId, KinWorkerId, type VcsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";

import { ServerConfig } from "../../config.ts";
import * as Vcs from "../../vcs/VcsProcess.ts";
import { STARTER_FILES } from "./starter.ts";
import * as Workspace from "./workspace.ts";

const orgId = KinOrgId.make("org-sample");
const agentId = KinAgentId.make("agent-1");

const layer = Workspace.layer.pipe(
  Layer.provideMerge(Vcs.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-workspace-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const vcs = yield* Vcs.VcsProcess;
    const result = yield* vcs.run({
      operation: "KinWorkspaceTest.git",
      command: "git",
      cwd,
      args: ["-c", "user.name=Worker", "-c", "user.email=worker@example.com", ...args],
      env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    return result.stdout.trim();
  });

it.layer(layer)("KinWorkspace", (it) => {
  it.effect("starts with the starter recipes", () =>
    Effect.gen(function* () {
      const workspace = yield* Workspace.KinWorkspace;
      const recipes = yield* workspace.recipes(orgId);
      assert.deepStrictEqual(recipes.map((recipe) => recipe.name).sort(), [
        "accountant-pack",
        "invoice",
        "report",
      ]);
      assert.deepStrictEqual(recipes[0]!.changed, { _tag: "starter" });
    }),
  );

  it.effect("writes the job's files, and a retry starts from a clean worktree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* Workspace.KinWorkspace;
      const workerId = KinWorkerId.make("wk-retry");
      const first = yield* workspace.prepare(orgId, workerId, { "in/inputs.json": '{"a":1}' });
      yield* fs.writeFileString(`${first.worktree}/left.pdf`, "stale");
      const again = yield* workspace.prepare(orgId, workerId, { "in/inputs.json": '{"a":2}' });
      assert.strictEqual(yield* fs.readFileString(`${again.worktree}/in/inputs.json`), '{"a":2}');
      assert.isFalse(yield* fs.exists(`${again.worktree}/left.pdf`));
      yield* workspace.discard(orgId, workerId);
      assert.isFalse(yield* fs.exists(again.worktree));
    }),
  );

  it.effect("commits only the recipe the job was for, and keeps the history", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* Workspace.KinWorkspace;
      const workerId = KinWorkerId.make("wk-recipe");
      const job = yield* workspace.prepare(orgId, workerId, {});
      const md = STARTER_FILES["recipes/report/RECIPE.md"]!.replace(
        "name: report",
        "name: quote",
      ).replace("title: Report", "title: Quote");
      yield* fs.makeDirectory(`${job.worktree}/recipes/quote`, { recursive: true });
      yield* fs.writeFileString(`${job.worktree}/recipes/quote/RECIPE.md`, md);
      yield* fs.writeFileString(`${job.worktree}/recipes/quote/build.mjs`, "export {};\n");
      // Planted beside it: another recipe changed, and a project script Kin would run.
      yield* fs.writeFileString(`${job.worktree}/recipes/invoice/build.mjs`, "process.exit(0);\n");
      yield* fs.writeFileString(`${job.worktree}/t3.json`, '{"scripts":[]}');
      const change = yield* workspace.applyRecipeChange(orgId, {
        workerId,
        recipe: "quote",
        agentId,
      });
      assert.strictEqual(change._tag === "refused" ? change.reason : change._tag, "committed");
      assert.deepStrictEqual(change._tag === "committed" ? [...change.left].sort() : [], [
        "recipes/invoice/build.mjs",
        "t3.json",
      ]);
      const recipes = yield* workspace.recipes(orgId);
      const quote = recipes.find((recipe) => recipe.name === "quote");
      assert.deepStrictEqual(quote?.changed, { _tag: "agent", agentId, workerId });
      const invoice = recipes.find((recipe) => recipe.name === "invoice");
      assert.deepStrictEqual(invoice?.changed, { _tag: "starter" });
      yield* workspace.discard(orgId, workerId);
    }),
  );

  it.effect(
    "refuses links, files Kin never commits, a broken RECIPE.md and the worker's own commits",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const workspace = yield* Workspace.KinWorkspace;
        const attempt = Effect.fn("attempt")(function* (
          name: string,
          plant: (
            worktree: string,
          ) => Effect.Effect<
            void,
            PlatformError.PlatformError | VcsError,
            FileSystem.FileSystem | Vcs.VcsProcess
          >,
        ) {
          const workerId = KinWorkerId.make(`wk-${name}`);
          const job = yield* workspace.prepare(orgId, workerId, {});
          yield* plant(job.worktree);
          const change = yield* workspace.applyRecipeChange(orgId, {
            workerId,
            recipe: "report",
            agentId,
          });
          yield* workspace.discard(orgId, workerId);
          return change._tag === "refused" ? change.reason : change._tag;
        });
        const reasons = [
          yield* attempt("link", (worktree) =>
            fs.symlink("/etc/passwd", `${worktree}/recipes/report/logo.png`),
          ),
          yield* attempt("claude", (worktree) =>
            fs
              .makeDirectory(`${worktree}/recipes/report/.claude`)
              .pipe(
                Effect.andThen(
                  fs.writeFileString(`${worktree}/recipes/report/.claude/settings.json`, "{}"),
                ),
              ),
          ),
          yield* attempt("broken", (worktree) =>
            fs.writeFileString(`${worktree}/recipes/report/RECIPE.md`, "no front matter"),
          ),
          yield* attempt("renamed", (worktree) =>
            fs.writeFileString(
              `${worktree}/recipes/report/RECIPE.md`,
              STARTER_FILES["recipes/report/RECIPE.md"]!.replace("name: report", "name: other"),
            ),
          ),
          yield* attempt("committed", (worktree) =>
            Effect.gen(function* () {
              yield* fs.writeFileString(`${worktree}/README.md`, "changed\n");
              yield* git(worktree, "commit", "-qam", "mine");
              yield* fs.writeFileString(`${worktree}/recipes/report/notes.md`, "x\n");
            }),
          ),
          yield* attempt("nothing", () => Effect.void),
        ];
        assert.match(reasons[0]!, /link or a submodule/);
        assert.match(reasons[1]!, /never commits/);
        assert.match(reasons[2]!, /doesn't read/);
        assert.match(reasons[3]!, /names other, not report/);
        assert.match(reasons[4]!, /commits Kin didn't make/);
        assert.strictEqual(reasons[5], "unchanged");
        const report = (yield* workspace.recipes(orgId)).find((recipe) => recipe.name === "report");
        assert.deepStrictEqual(report?.changed, { _tag: "starter" });
        // A Git LFS pointer is no file a worker can run; and the cap is the whole folder's.
        const pointer = yield* attempt("lfs", (worktree) =>
          fs.writeFileString(
            `${worktree}/recipes/report/font.ttf`,
            "version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1\n",
          ),
        );
        assert.match(pointer, /Git LFS pointer/);
        const grow = (name: string) =>
          attempt(name, (worktree) =>
            fs.writeFile(
              `${worktree}/recipes/report/${name}.bin`,
              new Uint8Array(11 * 1024 * 1024),
            ),
          );
        assert.strictEqual(yield* grow("first"), "committed");
        assert.match(yield* grow("second"), /recipe holds at most 20 MB/);
      }),
  );
});
