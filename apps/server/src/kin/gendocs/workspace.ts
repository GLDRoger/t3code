import {
  KinAgentId,
  KinChatError,
  type KinOrgId,
  type KinRecipe,
  KinWorkerId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../../config.ts";
import { VcsProcess } from "../../vcs/VcsProcess.ts";
import { scrubbedEnv } from "../lead/workerPublish.ts";
import { parseRecipe, type Recipe } from "./recipe.ts";
import { STARTER_FILES } from "./starter.ts";

/**
 * The org's workspace: a git repository on this host holding its recipes, never pushed anywhere.
 * Recipes are read from `main` as git objects, so nothing left in a job's worktree reads as a
 * recipe. Only the server commits: a recipe job's change to its own folder, merged into `main`.
 */

const DEFAULT_BRANCH = "main";
const MAX_RECIPE_BYTES = 20 * 1024 * 1024;
const MAX_RECIPE_MD_BYTES = 64 * 1024;
const MAX_RECIPES = 200;
const COMMITTER = ["-c", "user.name=Kin", "-c", "user.email=kin@localhost"];
// Names a tool would act on if they reached a checkout: project scripts, agent settings, git's own.
const forbiddenName =
  /^(?:t3\.json|\.t3|\.claude|\.mcp\.json|\.gitattributes|\.gitmodules|\.git)$/i;
const recipeName = /^[a-z][a-z0-9-]{1,39}$/;

/** Where a job's worktree is; nothing else lives under `kin-documents`. */
export const jobWorktree = (worktreesDir: string, workerId: KinWorkerId) =>
  `${worktreesDir}/kin-documents/${workerId}`;
export const jobBranch = (workerId: KinWorkerId) => `kin/doc/${workerId}`;

export type StoredRecipe = Recipe & {
  readonly commit: string;
  readonly changed: KinRecipe["changedBy"];
  readonly changedAt: number | null;
};
export type Prepared = {
  readonly worktree: string;
  readonly branch: string;
  readonly base: string;
};
export type RecipeChange =
  | { readonly _tag: "committed"; readonly commit: string; readonly left: ReadonlyArray<string> }
  | { readonly _tag: "unchanged"; readonly left: ReadonlyArray<string> }
  | { readonly _tag: "refused"; readonly reason: string };

const isChatError = Schema.is(KinChatError);
const unavailable = (message = "Kin couldn't open the company's recipes on this host.") =>
  new KinChatError({ reason: "unavailable", message });

export class KinWorkspace extends Context.Service<
  KinWorkspace,
  {
    /** The workspace's folder, made from the starter recipes on first use. */
    readonly root: (orgId: KinOrgId) => Effect.Effect<string, KinChatError>;
    /** Every readable recipe on `main`; a broken one is left out and logged. */
    readonly recipes: (orgId: KinOrgId) => Effect.Effect<ReadonlyArray<StoredRecipe>, KinChatError>;
    /** A fresh worktree for the job, holding `files` as Kin wrote them. */
    readonly prepare: (
      orgId: KinOrgId,
      workerId: KinWorkerId,
      files: Readonly<Record<string, string>>,
    ) => Effect.Effect<Prepared, KinChatError>;
    /** The job's change to `recipes/<recipe>/`, committed by Kin and merged into `main`. */
    readonly applyRecipeChange: (
      orgId: KinOrgId,
      input: {
        readonly workerId: KinWorkerId;
        readonly recipe: string;
        readonly agentId: KinAgentId;
      },
    ) => Effect.Effect<RecipeChange>;
    /** Removes the job's worktree and branch, with the inputs it held. */
    readonly discard: (orgId: KinOrgId, workerId: KinWorkerId) => Effect.Effect<void>;
  }
>()("t3/kin/gendocs/workspace/KinWorkspace") {}

export const layer = Layer.effect(
  KinWorkspace,
  Effect.gen(function* () {
    const vcs = yield* VcsProcess;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const digest = yield* Digest.Digest;
    const lock = yield* Semaphore.make(1);

    // A job's worktree is the worker's to write, `.git` file included, so git there always names
    // Kin's own git directory for it: nothing in the worktree chooses the repository or config.
    const git = (
      cwd: string,
      args: ReadonlyArray<string>,
      options: { readonly gitDir?: string; readonly raw?: boolean } = {},
    ) =>
      vcs
        .run({
          operation: "KinWorkspace.git",
          command: "git",
          cwd,
          args: [
            "--no-replace-objects",
            ...(options.gitDir === undefined
              ? []
              : [`--git-dir=${options.gitDir}`, `--work-tree=${cwd}`]),
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.symlinks=false",
            "-c",
            "protocol.allow=never",
            ...args,
          ],
          env: {
            ...scrubbedEnv(),
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            GIT_NO_REPLACE_OBJECTS: "1",
            GIT_CONFIG_COUNT: "0",
          },
          timeoutMs: 120_000,
        })
        .pipe(
          Effect.map((result) => (options.raw === true ? result.stdout : result.stdout.trim())),
        );

    const rootOf = Effect.fn("KinWorkspace.rootOf")(function* (orgId: KinOrgId) {
      const id = Hex.encode(yield* digest.digest(Digest.sha256, new TextEncoder().encode(orgId)));
      return path.join(config.stateDir, "kin", "workspaces", id.slice(0, 24));
    });
    const jobPath = (workerId: KinWorkerId) => jobWorktree(config.worktreesDir, workerId);
    const branchOf = jobBranch;
    const gitDirOf = (root: string, workerId: KinWorkerId) =>
      path.join(root, ".git", "worktrees", workerId);

    const ensureLocked = Effect.fn("KinWorkspace.ensure")(function* (orgId: KinOrgId) {
      const root = yield* rootOf(orgId);
      if (!(yield* fs.exists(path.join(root, ".git", "HEAD")))) {
        // A half-made workspace from a crash is made again from the start.
        yield* fs.remove(root, { recursive: true, force: true });
        yield* fs.makeDirectory(root, { recursive: true });
        yield* git(root, ["init", "-q", "-b", DEFAULT_BRANCH]);
        for (const [file, text] of Object.entries(STARTER_FILES)) {
          yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true });
          yield* fs.writeFileString(path.join(root, file), text);
        }
        yield* git(root, ["add", "--all"]);
        yield* git(root, [
          ...COMMITTER,
          "commit",
          "-q",
          "--no-verify",
          "-m",
          "Kin's starter recipes",
        ]);
      }
      return root;
    });

    const failed =
      (what: string, message?: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.tapError((cause) =>
            isChatError(cause) ? Effect.void : Effect.logWarning(`Kin couldn't ${what}`, { cause }),
          ),
          Effect.mapError((cause) => (isChatError(cause) ? cause : unavailable(message))),
        );

    /** The last commit to change a recipe; only Kin writes these, and only its trailers name who. */
    const lastChange = Effect.fn("KinWorkspace.lastChange")(function* (root: string, name: string) {
      const out = yield* git(root, [
        "log",
        "-1",
        "--format=%H%x00%ct%x00%(trailers:key=Kin-Agent,valueonly)%x00%(trailers:key=Kin-Worker,valueonly)",
        DEFAULT_BRANCH,
        "--",
        `recipes/${name}`,
      ]);
      const [commit = "", at = "", agent = "", worker = ""] = out
        .split("\0")
        .map((part) => part.trim());
      return {
        commit,
        changedAt: at === "" ? null : Number.parseInt(at, 10) * 1000,
        changed:
          agent === ""
            ? ({ _tag: "starter" } as const)
            : ({
                _tag: "agent",
                agentId: KinAgentId.make(agent),
                workerId: worker === "" ? null : KinWorkerId.make(worker),
              } as const),
      };
    });

    const recipes = Effect.fn("KinWorkspace.recipes")(function* (orgId: KinOrgId) {
      const root = yield* lock.withPermits(1)(ensureLocked(orgId));
      const listed = yield* git(
        root,
        ["ls-tree", "-z", "-d", "--name-only", `${DEFAULT_BRANCH}:recipes`],
        {
          raw: true,
        },
      );
      const found: Array<StoredRecipe> = [];
      for (const name of listed
        .split("\0")
        .filter((name) => recipeName.test(name))
        .slice(0, MAX_RECIPES)) {
        const spec = `${DEFAULT_BRANCH}:recipes/${name}/RECIPE.md`;
        const size = yield* git(root, ["cat-file", "-s", spec]).pipe(
          Effect.map((text) => Number.parseInt(text, 10)),
          Effect.orElseSucceed(() => Number.NaN),
        );
        if (!(size > 0 && size <= MAX_RECIPE_MD_BYTES)) continue;
        const parsed = parseRecipe(yield* git(root, ["cat-file", "blob", spec], { raw: true }));
        if ("reason" in parsed || parsed.name !== name) {
          yield* Effect.logWarning("Kin skipped a recipe it couldn't read", {
            name,
            reason: "reason" in parsed ? parsed.reason : "its name isn't its folder's",
          });
          continue;
        }
        found.push({ ...parsed, ...(yield* lastChange(root, name)) });
      }
      return found;
    }, failed("read the recipes"));

    const discardLocked = Effect.fn("KinWorkspace.discardLocked")(function* (
      root: string,
      workerId: KinWorkerId,
    ) {
      const worktree = jobPath(workerId);
      yield* git(root, ["worktree", "remove", "--force", worktree]).pipe(Effect.ignore);
      yield* fs.remove(worktree, { recursive: true, force: true }).pipe(Effect.ignore);
      yield* git(root, ["worktree", "prune"]).pipe(Effect.ignore);
      yield* git(root, ["branch", "-D", branchOf(workerId)]).pipe(Effect.ignore);
    });

    const prepare = Effect.fn("KinWorkspace.prepare")(
      function* (orgId: KinOrgId, workerId: KinWorkerId, files: Readonly<Record<string, string>>) {
        const root = yield* ensureLocked(orgId);
        const worktree = jobPath(workerId);
        const branch = branchOf(workerId);
        // A retry starts clean: whatever a run before it left is gone.
        yield* discardLocked(root, workerId);
        yield* fs.makeDirectory(path.dirname(worktree), { recursive: true });
        yield* git(root, ["worktree", "add", "-q", "-b", branch, worktree, DEFAULT_BRANCH]);
        if (!(yield* fs.exists(path.join(gitDirOf(root, workerId), "HEAD"))))
          return yield* unavailable("Kin couldn't find the job's git directory. Nothing started.");
        for (const [file, text] of Object.entries(files)) {
          const target = path.join(worktree, file);
          yield* fs.makeDirectory(path.dirname(target), { recursive: true });
          yield* fs.writeFileString(target, text);
        }
        return {
          worktree: yield* fs.realPath(worktree),
          branch,
          base: yield* git(root, ["rev-parse", "--verify", DEFAULT_BRANCH]),
        } satisfies Prepared;
      },
      lock.withPermits(1),
      failed(
        "prepare a document job",
        "Kin couldn't make a worktree for this job. Nothing started.",
      ),
    );

    const discard = Effect.fn("KinWorkspace.discard")(
      function* (orgId: KinOrgId, workerId: KinWorkerId) {
        yield* discardLocked(yield* rootOf(orgId), workerId);
      },
      lock.withPermits(1),
      Effect.ignoreCause({ log: true }),
    );

    const applyRecipeChange = Effect.fn("KinWorkspace.applyRecipeChange")(
      function* (
        orgId: KinOrgId,
        input: {
          readonly workerId: KinWorkerId;
          readonly recipe: string;
          readonly agentId: KinAgentId;
        },
      ) {
        const refused = (reason: string) => ({ _tag: "refused", reason }) as const;
        if (!recipeName.test(input.recipe))
          return refused(
            "a recipe's name is 2 to 40 lowercase letters, digits and hyphens, starting with a letter",
          );
        const root = yield* rootOf(orgId);
        const worktree = jobPath(input.workerId);
        const branch = branchOf(input.workerId);
        const at = { gitDir: gitDirOf(root, input.workerId) };
        const folder = `recipes/${input.recipe}`;
        if (
          (yield* git(worktree, ["symbolic-ref", "--quiet", "HEAD"], at)) !== `refs/heads/${branch}`
        )
          return refused("the job's worktree isn't on its branch");
        // Commits made in the worktree aren't Kin's, so a branch that moved past main is refused.
        const ahead = yield* git(root, ["rev-list", "--count", `${DEFAULT_BRANCH}..${branch}`]);
        if (ahead !== "0") return refused("the job's branch has commits Kin didn't make");
        const status = yield* git(
          worktree,
          ["status", "--porcelain", "-z", "--untracked-files=all"],
          {
            ...at,
            raw: true,
          },
        );
        const left = status
          .split("\0")
          .filter((entry) => /^.. /.test(entry))
          .map((entry) => entry.slice(3))
          .filter(
            (file) =>
              file !== folder &&
              !file.startsWith(`${folder}/`) &&
              !/^(?:in|out|build)\//.test(file),
          )
          .slice(0, 20);
        // Only the recipe the job was for is ever staged; anything else stays behind and is reported.
        yield* git(worktree, ["add", "--all", "--", folder], at);
        const raw = (yield* git(
          worktree,
          ["diff", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev"],
          {
            ...at,
            raw: true,
          },
        )).split("\0");
        // `:<old mode> <new mode> <old blob> <new blob> <status>` then the path, one pair each.
        const changes: Array<{
          readonly mode: string;
          readonly blob: string;
          readonly file: string;
        }> = [];
        for (let index = 0; index + 1 < raw.length; index += 2) {
          const [, mode = "", , blob = ""] = raw[index]!.replace(/^:/, "").split(" ");
          changes.push({ mode, blob, file: raw[index + 1]! });
        }
        if (changes.length === 0) return { _tag: "unchanged", left } as const;
        let bytes = 0;
        for (const change of changes) {
          if (change.mode === "120000" || change.mode === "160000")
            return refused(`${change.file} is a link or a submodule, which a recipe can't hold`);
          if (change.file.split("/").some((part) => forbiddenName.test(part)))
            return refused(`${change.file} is a file Kin never commits`);
          if (/^0+$/.test(change.blob)) continue;
          bytes += Number.parseInt(yield* git(root, ["cat-file", "-s", change.blob]), 10);
        }
        if (bytes > MAX_RECIPE_BYTES)
          return refused(
            `the change adds ${Math.ceil(bytes / 1048576)} MB; a recipe holds at most 20 MB`,
          );
        const markdown = yield* git(worktree, ["show", `:${folder}/RECIPE.md`], {
          ...at,
          raw: true,
        }).pipe(Effect.orElseSucceed(() => ""));
        const parsed = parseRecipe(markdown);
        if ("reason" in parsed) return refused(`its RECIPE.md doesn't read: ${parsed.reason}`);
        if (parsed.name !== input.recipe)
          return refused(`RECIPE.md names ${parsed.name}, not ${input.recipe}`);
        yield* git(
          worktree,
          [
            ...COMMITTER,
            "commit",
            "-q",
            "--no-verify",
            "-m",
            `Change the ${input.recipe} recipe`,
            "-m",
            `Kin-Agent: ${input.agentId}\nKin-Worker: ${input.workerId}`,
          ],
          at,
        );
        const commit = yield* git(root, ["rev-parse", "--verify", branch]);
        // Fast-forward when main didn't move, else a merge commit, else nothing on a conflict.
        const merged = yield* git(root, ["merge", "-q", "--ff-only", branch]).pipe(
          Effect.as(true),
          Effect.catch(() =>
            git(root, [...COMMITTER, "merge", "-q", "--no-ff", "--no-edit", branch]).pipe(
              Effect.as(true),
              Effect.catch(() =>
                git(root, ["merge", "--abort"]).pipe(Effect.ignore, Effect.as(false)),
              ),
            ),
          ),
        );
        if (!merged) return refused("the recipe changed meanwhile and the two changes conflict");
        return { _tag: "committed", commit, left } as const;
      },
      lock.withPermits(1),
      Effect.catchCause((cause) =>
        Effect.logWarning("Kin couldn't apply a recipe change", { cause }).pipe(
          Effect.as({ _tag: "refused", reason: "Kin couldn't commit the change" } as const),
        ),
      ),
    );

    const rootFor = Effect.fn("KinWorkspace.root")(
      function* (orgId: KinOrgId) {
        return yield* ensureLocked(orgId);
      },
      lock.withPermits(1),
      failed("make the documents workspace"),
    );

    return KinWorkspace.of({ root: rootFor, recipes, prepare, applyRecipeChange, discard });
  }),
);
