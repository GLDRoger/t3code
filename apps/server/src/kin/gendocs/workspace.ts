import {
  KinAgentId,
  KinChatError,
  type KinOrgId,
  KinPersonId,
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
 * recipe. Only the server commits: a recipe job's change to its own folder, merged into `main`
 * once its sample renders, an undo of a recipe's last change, and its own starter recipes.
 */

const DEFAULT_BRANCH = "main";
const MAX_RECIPE_BYTES = 20 * 1024 * 1024;
const MAX_RECIPE_MD_BYTES = 64 * 1024;
const MAX_RECIPES = 200;
const MAX_RECIPE_FILES = 500;
const LFS_POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\//;
const COMMITTER = ["-c", "user.name=Kin", "-c", "user.email=kin@localhost"];
// Names a tool would act on if they reached a checkout: project scripts, agent settings, git's own.
const forbiddenName =
  /^(?:t3\.json|\.t3|\.claude|\.mcp\.json|\.gitattributes|\.gitmodules|\.git)$/i;
const recipeName = /^[a-z][a-z0-9-]{1,39}$/;

/** Where document jobs' worktrees are; nothing else lives here. */
export const documentWorktrees = (worktreesDir: string) => `${worktreesDir}/kin-documents`;
export const jobWorktree = (worktreesDir: string, workerId: KinWorkerId) =>
  `${documentWorktrees(worktreesDir)}/${workerId}`;
export const jobBranch = (workerId: KinWorkerId) => `kin/doc/${workerId}`;

const SHOWN_FILE = /\.(?:png|jpe?g|gif|webp|svg|pdf)$/i;
export type StoredRecipe = Recipe & {
  /** Its images and PDFs, by name in its folder: what the owner looks at before clearing a label. */
  readonly files: ReadonlyArray<string>;
  readonly commit: string;
  readonly changed: KinRecipe["changedBy"];
  readonly changedAt: number | null;
};
export type Prepared = {
  readonly worktree: string;
  readonly branch: string;
  readonly base: string;
};
/** A commit that last changed a recipe, and the worker whose job wrote it, from its trailer. */
export type Revision = { readonly commit: string; readonly workerId: KinWorkerId | null };
export type RecipeChange =
  | {
      readonly _tag: "committed";
      readonly commit: string;
      /** The recipe's revision on `main` now: the job's commit, or a merge with another change. */
      readonly revision: string;
      /** The revisions it was built on and merged with, whose labels it carries. */
      readonly builtOn: ReadonlyArray<Revision>;
      readonly left: ReadonlyArray<string>;
    }
  | { readonly _tag: "unchanged"; readonly left: ReadonlyArray<string> }
  | { readonly _tag: "refused"; readonly reason: string };
export type RecipeFile = { readonly path: string; readonly blob: string; readonly size: number };
/** A recipe's folder as it would be kept: parsed, with its sample, files and template. */
export type CheckedRecipe = {
  /** A commit, or for a change not yet kept the tree it would commit. */
  readonly commit: string;
  readonly recipe: Recipe;
  readonly sample: string | undefined;
  readonly files: ReadonlyArray<RecipeFile>;
  readonly template: string | undefined;
};
/** Why a change can't be kept, from rendering its sample; `undefined` when it rendered. */
export type VerifyChange = (change: CheckedRecipe) => Effect.Effect<string | undefined>;
export type RecipePreview =
  | ({ readonly _tag: "checked" } & CheckedRecipe)
  | { readonly _tag: "unchanged" }
  | { readonly _tag: "refused"; readonly reason: string };
export type ChangedBy =
  | { readonly _tag: "agent"; readonly agentId: KinAgentId }
  | { readonly _tag: "owner"; readonly personId: KinPersonId };
export type RecipeUndo =
  | {
      readonly _tag: "undone";
      readonly commit: string;
      readonly removed: boolean;
      /** The revision it brought back, whose label the undo takes; `null` when it removed it. */
      readonly restored: Revision | null;
    }
  | { readonly _tag: "refused"; readonly reason: string };
const STARTER_RECIPES = Object.keys(STARTER_FILES).flatMap((file) => {
  const name = /^recipes\/([^/]+)\/RECIPE\.md$/.exec(file)?.[1];
  return name === undefined ? [] : [name];
});

/**
 * Two paths a case-insensitive or normalising file system would write to one place, the second
 * overwriting the first; `undefined` when every name stays its own.
 */
const foldedCollision = (paths: ReadonlyArray<string>) => {
  const seen = new Map<string, string>();
  for (const file of paths) {
    const parts = file.split("/");
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const name = parts.slice(0, depth).join("/");
      const key = name.normalize("NFC").toLowerCase();
      const other = seen.get(key);
      if (other !== undefined && other !== name) return [other, name] as const;
      seen.set(key, name);
    }
  }
  return undefined;
};

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
    /**
     * The recipe's folder at `commit` written into `target`, regular files only: a link, a
     * submodule or an oversize recipe is refused, so nothing in the copy reaches outside it.
     */
    readonly checkoutRecipe: (
      orgId: KinOrgId,
      name: string,
      commit: string,
      target: string,
    ) => Effect.Effect<
      { readonly _tag: "copied" } | { readonly _tag: "refused"; readonly reason: string },
      KinChatError
    >;
    /**
     * The job's change to `recipes/<recipe>/`, committed by Kin and merged into `main` only once
     * `verify` rendered it from its sample.
     */
    readonly applyRecipeChange: (
      orgId: KinOrgId,
      input: {
        readonly workerId: KinWorkerId;
        readonly recipe: string;
        readonly agentId: KinAgentId;
        readonly verify: VerifyChange;
      },
    ) => Effect.Effect<RecipeChange>;
    /**
     * Puts the recipe back as it was before its last change, as a new commit: itself undoable.
     * What comes back is checked and rendered from its sample as a new change is.
     */
    readonly undoRecipe: (
      orgId: KinOrgId,
      name: string,
      by: ChangedBy,
      verify: VerifyChange,
    ) => Effect.Effect<RecipeUndo, KinChatError>;
    /**
     * The job's change to `recipes/<recipe>/` as it would be kept, checked but not committed:
     * `commit` is its tree, which renders as a commit does.
     */
    readonly previewRecipeChange: (
      orgId: KinOrgId,
      input: { readonly workerId: KinWorkerId; readonly recipe: string },
    ) => Effect.Effect<RecipePreview>;
    /** Removes the job's worktree and branch, with the inputs it held. */
    readonly discard: (orgId: KinOrgId, workerId: KinWorkerId) => Effect.Effect<void>;
    /** `main`'s commit now. */
    readonly head: (orgId: KinOrgId) => Effect.Effect<string, KinChatError>;
    /** Whether Kin made `commit` as its starter recipes, or it is `baseline` or in its history. */
    readonly madeBefore: (
      orgId: KinOrgId,
      commit: string,
      baseline: string | null,
    ) => Effect.Effect<boolean, KinChatError>;
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
      options: {
        readonly gitDir?: string;
        readonly raw?: boolean;
        readonly env?: Readonly<Record<string, string>>;
      } = {},
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
            ...options.env,
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

    const current = new Set<string>();
    /**
     * A starter recipe no one has changed is replaced by today's starter: workspaces made before
     * Kin rendered documents itself held script recipes a worker ran.
     */
    const upgradeStarters = Effect.fn("KinWorkspace.upgradeStarters")(function* (root: string) {
      let changed = false;
      for (const name of STARTER_RECIPES) {
        const last = yield* lastChange(root, name);
        const markdown = yield* git(
          root,
          ["cat-file", "blob", `${DEFAULT_BRANCH}:recipes/${name}/RECIPE.md`],
          { raw: true },
        ).pipe(Effect.orElseSucceed(() => ""));
        if (
          last.changed._tag !== "starter" ||
          markdown === STARTER_FILES[`recipes/${name}/RECIPE.md`]
        )
          continue;
        yield* git(root, ["rm", "-r", "-q", "--ignore-unmatch", "--", `recipes/${name}`]);
        for (const [file, text] of Object.entries(STARTER_FILES))
          if (file.startsWith(`recipes/${name}/`)) {
            yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true });
            yield* fs.writeFileString(path.join(root, file), text);
          }
        yield* git(root, ["add", "--all", "--", `recipes/${name}`]);
        changed = true;
      }
      if (!changed) return;
      yield* fs.writeFileString(path.join(root, "README.md"), STARTER_FILES["README.md"]!);
      yield* git(root, ["add", "--", "README.md"]);
      yield* git(root, [
        ...COMMITTER,
        "commit",
        "-q",
        "--no-verify",
        "-m",
        "Kin's starter recipes, rendered by Kin",
      ]);
    });

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
      } else if (!current.has(root)) yield* upgradeStarters(root);
      current.add(root);
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
    const lastChange = Effect.fn("KinWorkspace.lastChange")(function* (
      root: string,
      name: string,
      ref: string = DEFAULT_BRANCH,
    ) {
      const out = yield* git(root, [
        "log",
        "-1",
        "--format=%H%x00%ct%x00%(trailers:key=Kin-Agent,valueonly)%x00%(trailers:key=Kin-Worker,valueonly)%x00%(trailers:key=Kin-Person,valueonly)",
        ref,
        "--",
        `recipes/${name}`,
      ]);
      const [commit = "", at = "", agent = "", worker = "", person = ""] = out
        .split("\0")
        .map((part) => part.trim());
      return {
        commit,
        workerId: worker === "" ? null : KinWorkerId.make(worker),
        changedAt: at === "" ? null : Number.parseInt(at, 10) * 1000,
        changed:
          person !== ""
            ? ({ _tag: "owner", personId: KinPersonId.make(person) } as const)
            : agent === ""
              ? ({ _tag: "starter" } as const)
              : ({
                  _tag: "agent",
                  agentId: KinAgentId.make(agent),
                  workerId: worker === "" ? null : KinWorkerId.make(worker),
                } as const),
      };
    });

    /** One recipe's RECIPE.md at `ref`, parsed; `undefined`, logged, when it doesn't read. */
    const readRecipe = Effect.fn("KinWorkspace.readRecipe")(function* (
      root: string,
      ref: string,
      name: string,
    ) {
      const spec = `${ref}:recipes/${name}/RECIPE.md`;
      const size = yield* git(root, ["cat-file", "-s", spec]).pipe(
        Effect.map((text) => Number.parseInt(text, 10)),
        Effect.orElseSucceed(() => Number.NaN),
      );
      if (!(size > 0 && size <= MAX_RECIPE_MD_BYTES)) return undefined;
      const parsed = parseRecipe(yield* git(root, ["cat-file", "blob", spec], { raw: true }));
      if ("reason" in parsed || parsed.name !== name) {
        yield* Effect.logWarning("Kin skipped a recipe it couldn't read", {
          name,
          reason: "reason" in parsed ? parsed.reason : "its name isn't its folder's",
        });
        return undefined;
      }
      return parsed;
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
        const parsed = yield* readRecipe(root, DEFAULT_BRANCH, name);
        if (parsed !== undefined) {
          const { workerId: _workerId, ...last } = yield* lastChange(root, name);
          const folder = `recipes/${name}/`;
          const files = (yield* git(
            root,
            ["ls-tree", "-r", "-z", "--name-only", DEFAULT_BRANCH, "--", folder],
            { raw: true },
          ))
            .split("\0")
            .filter((file) => SHOWN_FILE.test(file))
            .map((file) => file.slice(folder.length));
          found.push({ ...parsed, files, ...last });
        }
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

    /**
     * The recipe's folder in `tree` as it would be committed: regular files only, none Kin never
     * commits, none two names for one place, within the caps, no LFS pointers, and a RECIPE.md
     * that reads and names the folder. Returns it parsed, with its sample, or why it can't be kept.
     */
    const checkTree = Effect.fn("KinWorkspace.checkTree")(function* (
      root: string,
      tree: string,
      name: string,
    ) {
      const refused = (reason: string) => ({ _tag: "refused", reason }) as const;
      const folder = `recipes/${name}`;
      const listed = (yield* git(root, ["ls-tree", "-r", "-l", "-z", tree, "--", folder], {
        raw: true,
      }))
        .split("\0")
        .filter((line) => line.length > 0);
      if (listed.length > MAX_RECIPE_FILES)
        return refused(`a recipe holds at most ${MAX_RECIPE_FILES} files`);
      let bytes = 0;
      const files: Array<string> = [];
      const blobs: Array<RecipeFile> = [];
      for (const line of listed) {
        const [meta = "", file = ""] = line.split("\t");
        const [mode = "", , blob = "", size = ""] = meta.split(/ +/);
        if (mode !== "100644" && mode !== "100755")
          return refused(`${file} is a link or a submodule, which a recipe can't hold`);
        if (file.split("/").some((part) => forbiddenName.test(part)))
          return refused(`${file} is a file Kin never commits`);
        files.push(file);
        const length = Number.parseInt(size, 10);
        blobs.push({ path: file, blob, size: length });
        bytes += length;
        if (
          length <= 1024 &&
          LFS_POINTER.test(yield* git(root, ["cat-file", "blob", blob], { raw: true }))
        )
          return refused(`${file} is a Git LFS pointer, not the file itself`);
      }
      if (bytes > MAX_RECIPE_BYTES)
        return refused(
          `with this change it is ${Math.ceil(bytes / 1048576)} MB; a recipe holds at most 20 MB`,
        );
      const collision = foldedCollision(files);
      if (collision !== undefined)
        return refused(
          `${collision[0]} and ${collision[1]} are one name on a Mac or Windows; rename one`,
        );
      const markdown = yield* git(root, ["cat-file", "blob", `${tree}:${folder}/RECIPE.md`], {
        raw: true,
      }).pipe(Effect.orElseSucceed(() => ""));
      const parsed = parseRecipe(markdown);
      if ("reason" in parsed) return refused(`its RECIPE.md doesn't read: ${parsed.reason}`);
      if (parsed.name !== name) return refused(`RECIPE.md names ${parsed.name}, not ${name}`);
      const sample = yield* git(root, ["cat-file", "blob", `${tree}:${folder}/sample.json`], {
        raw: true,
      }).pipe(Effect.option);
      const template = blobs.find((one) => one.path === `${folder}/template.typ`);
      return {
        _tag: "checked",
        recipe: parsed,
        sample: sample._tag === "Some" ? sample.value : undefined,
        files: blobs,
        template:
          template === undefined || template.size > MAX_RECIPE_MD_BYTES * 16
            ? undefined
            : yield* git(root, ["cat-file", "blob", template.blob], { raw: true }),
      } as const;
    });

    /** The job's change staged on its own index and checked; nothing is committed. */
    const stageChange = Effect.fn("KinWorkspace.stageChange")(function* (
      orgId: KinOrgId,
      workerId: KinWorkerId,
      recipe: string,
    ) {
      const refused = (reason: string) => ({ _tag: "refused", reason }) as const;
      if (!recipeName.test(recipe))
        return refused(
          "a recipe's name is 2 to 40 lowercase letters, digits and hyphens, starting with a letter",
        );
      const root = yield* rootOf(orgId);
      const worktree = jobPath(workerId);
      const branch = branchOf(workerId);
      const at = { gitDir: gitDirOf(root, workerId) };
      const folder = `recipes/${recipe}`;
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
            file !== folder && !file.startsWith(`${folder}/`) && !/^(?:in|out|build)\//.test(file),
        )
        .slice(0, 20);
      // Only the recipe the job was for is ever staged; anything else stays behind and is reported.
      yield* git(worktree, ["add", "--all", "--", folder], at);
      const staged = yield* git(worktree, ["diff", "--cached", "--name-only", "-z"], {
        ...at,
        raw: true,
      });
      if (staged === "") return { _tag: "unchanged", left } as const;
      // The folder as it would be committed, not just what changed.
      const tree = yield* git(worktree, ["write-tree"], at);
      const checked = yield* checkTree(root, tree, recipe);
      if (checked._tag === "refused") return checked;
      return { ...checked, _tag: "staged", tree, left, root, worktree, branch, at } as const;
    });

    const previewRecipeChange = Effect.fn("KinWorkspace.previewRecipeChange")(
      function* (
        orgId: KinOrgId,
        input: { readonly workerId: KinWorkerId; readonly recipe: string },
      ) {
        const staged = yield* stageChange(orgId, input.workerId, input.recipe);
        if (staged._tag !== "staged")
          return staged._tag === "unchanged" ? ({ _tag: "unchanged" } as const) : staged;
        return {
          _tag: "checked",
          commit: staged.tree,
          recipe: staged.recipe,
          sample: staged.sample,
          files: staged.files,
          template: staged.template,
        } as const;
      },
      lock.withPermits(1),
      Effect.catchCause((cause) =>
        Effect.logWarning("Kin couldn't check a recipe change", { cause }).pipe(
          Effect.as({ _tag: "refused", reason: "Kin couldn't read the change" } as const),
        ),
      ),
    );

    const applyRecipeChange = Effect.fn("KinWorkspace.applyRecipeChange")(
      function* (
        orgId: KinOrgId,
        input: {
          readonly workerId: KinWorkerId;
          readonly recipe: string;
          readonly agentId: KinAgentId;
          readonly verify: VerifyChange;
        },
      ) {
        const refused = (reason: string) => ({ _tag: "refused", reason }) as const;
        const checked = yield* stageChange(orgId, input.workerId, input.recipe);
        if (checked._tag !== "staged") return checked;
        const { root, worktree, branch, at, left } = checked;
        const base = yield* lastChange(root, input.recipe, branch);
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
        const unrendered = yield* input.verify({
          commit,
          recipe: checked.recipe,
          sample: checked.sample,
          files: checked.files,
          template: checked.template,
        });
        if (unrendered !== undefined) return refused(unrendered);
        // Fast-forward when main didn't move, else a merge commit, else nothing on a conflict.
        const onMain = yield* lastChange(root, input.recipe);
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
        return {
          _tag: "committed",
          commit,
          revision: (yield* lastChange(root, input.recipe)).commit,
          builtOn: [base, onMain]
            .filter(
              (one, index, all) =>
                one.commit !== "" &&
                all.findIndex((other) => other.commit === one.commit) === index,
            )
            .map(({ commit, workerId }) => ({ commit, workerId })),
          left,
        } as const;
      },
      lock.withPermits(1),
      Effect.catchCause((cause) =>
        Effect.logWarning("Kin couldn't apply a recipe change", { cause }).pipe(
          Effect.as({ _tag: "refused", reason: "Kin couldn't commit the change" } as const),
        ),
      ),
    );

    const checkoutRecipe = Effect.fn("KinWorkspace.checkoutRecipe")(
      function* (orgId: KinOrgId, name: string, commit: string, target: string) {
        const refused = (reason: string) => ({ _tag: "refused", reason }) as const;
        if (!recipeName.test(name) || !/^[0-9a-f]{40}$/.test(commit))
          return refused("Kin can't name that recipe");
        const root = yield* rootOf(orgId);
        const folder = `recipes/${name}`;
        const listed = (yield* git(root, ["ls-tree", "-r", "-l", "-z", commit, "--", folder], {
          raw: true,
        }))
          .split("\0")
          .filter((line) => line.length > 0);
        if (listed.length === 0) return refused(`there is no ${name} recipe at that commit`);
        if (listed.length > MAX_RECIPE_FILES)
          return refused(`a recipe holds at most ${MAX_RECIPE_FILES} files`);
        let bytes = 0;
        const files: Array<string> = [];
        for (const line of listed) {
          const [meta = "", file = ""] = line.split("\t");
          const [mode = "", , , size = ""] = meta.split(/ +/);
          if (mode !== "100644" && mode !== "100755")
            return refused(`${file} is a link or a submodule, which a recipe can't hold`);
          files.push(file);
          bytes += Number.parseInt(size, 10);
        }
        if (bytes > MAX_RECIPE_BYTES) return refused("the recipe is over 20 MB");
        const collision = foldedCollision(files);
        if (collision !== undefined)
          return refused(`${collision[0]} and ${collision[1]} would be written to one place`);
        // A private index, so the workspace's own is never touched.
        const env = { GIT_INDEX_FILE: path.join(path.dirname(target), ".kin-index") };
        yield* git(root, ["read-tree", `${commit}:${folder}`], { env });
        yield* git(root, ["checkout-index", "-a", "-f", `--prefix=${target}/`], { env });
        yield* fs.remove(env.GIT_INDEX_FILE, { force: true });
        // What git wrote, looked at again: regular files and folders only.
        for (const entry of yield* fs.readDirectory(target, { recursive: true })) {
          const linked = yield* fs.readLink(path.join(target, entry)).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (linked) return refused(`${entry} isn't a plain file`);
          const info = yield* fs.stat(path.join(target, entry));
          if (info.type !== "File" && info.type !== "Directory")
            return refused(`${entry} isn't a plain file`);
        }
        return { _tag: "copied" } as const;
      },
      failed("copy a recipe", "Kin couldn't read the recipe to render it."),
    );

    const undoRecipe = Effect.fn("KinWorkspace.undoRecipe")(
      function* (orgId: KinOrgId, name: string, by: ChangedBy, verify: VerifyChange) {
        const refused = (reason: string) => ({ _tag: "refused", reason }) as const;
        if (!recipeName.test(name)) return refused("Kin can't name that recipe");
        const root = yield* ensureLocked(orgId);
        const folder = `recipes/${name}`;
        const last = yield* lastChange(root, name);
        if (last.commit === "") return refused(`there is no ${name} recipe`);
        const parent = yield* git(root, [
          "rev-parse",
          "--verify",
          "--quiet",
          `${last.commit}^`,
        ]).pipe(Effect.orElseSucceed(() => ""));
        if (parent === "")
          return refused(`the ${name} recipe is as Kin started it; there is nothing to undo`);
        const head = yield* git(root, ["rev-parse", "--verify", DEFAULT_BRANCH]);
        const before = yield* git(root, ["ls-tree", "-d", "--name-only", parent, "--", folder]);
        // Staged in a private index and committed off main, so main moves only once it is checked.
        const env = { GIT_INDEX_FILE: path.join(root, ".git", "kin-undo-index") };
        yield* git(root, ["read-tree", head], { env });
        yield* git(root, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", folder], { env });
        if (before !== "")
          yield* git(root, ["read-tree", `--prefix=${folder}/`, `${parent}:${folder}`], { env });
        const tree = yield* git(root, ["write-tree"], { env });
        yield* fs.remove(env.GIT_INDEX_FILE, { force: true });
        if (tree === (yield* git(root, ["rev-parse", `${head}^{tree}`])))
          return refused(`the ${name} recipe's last change left it as it was`);
        const commit = yield* git(root, [
          ...COMMITTER,
          "commit-tree",
          tree,
          "-p",
          head,
          "-m",
          `Undo the last change to the ${name} recipe`,
          "-m",
          by._tag === "agent" ? `Kin-Agent: ${by.agentId}` : `Kin-Person: ${by.personId}`,
        ]);
        if (before !== "") {
          const checked = yield* checkTree(root, tree, name);
          if (checked._tag === "refused")
            return refused(`what it would bring back can't be kept: ${checked.reason}`);
          const unrendered = yield* verify({
            commit,
            recipe: checked.recipe,
            sample: checked.sample,
            files: checked.files,
            template: checked.template,
          });
          if (unrendered !== undefined)
            return refused(
              `what it would bring back can't be kept, so Kin left the recipe as it is: ${unrendered}`,
            );
        }
        yield* git(root, ["update-ref", `refs/heads/${DEFAULT_BRANCH}`, commit, head]);
        yield* git(root, ["reset", "-q", "--hard", commit]);
        const restored = before === "" ? null : yield* lastChange(root, name, parent);
        return {
          _tag: "undone",
          commit,
          removed: before === "",
          restored:
            restored === null ? null : { commit: restored.commit, workerId: restored.workerId },
        } as const;
      },
      lock.withPermits(1),
      failed("undo a recipe change"),
    );

    const head = Effect.fn("KinWorkspace.head")(
      function* (orgId: KinOrgId) {
        return yield* git(yield* ensureLocked(orgId), ["rev-parse", "--verify", DEFAULT_BRANCH]);
      },
      lock.withPermits(1),
      failed("read the documents workspace"),
    );

    // Only Kin writes commit messages here: a job's, a merge's and an undo's never read like these.
    const STARTER_SUBJECTS = ["Kin's starter recipes", "Kin's starter recipes, rendered by Kin"];
    const madeBefore = Effect.fn("KinWorkspace.madeBefore")(
      function* (orgId: KinOrgId, commit: string, baseline: string | null) {
        if (!/^[0-9a-f]{40}$/.test(commit)) return false;
        const root = yield* ensureLocked(orgId);
        const [parents = "", subject = "", trailers = ""] = (yield* git(root, [
          "log",
          "-1",
          "--format=%P%x00%s%x00%(trailers:only,unfold)",
          commit,
        ])).split("\0");
        if (
          STARTER_SUBJECTS.includes(subject) &&
          !parents.trim().includes(" ") &&
          trailers.trim() === ""
        )
          return true;
        if (baseline === null || !/^[0-9a-f]{40}$/.test(baseline)) return false;
        return (yield* git(root, ["merge-base", commit, baseline])) === commit;
      },
      lock.withPermits(1),
      failed("read the documents workspace"),
    );

    const rootFor = Effect.fn("KinWorkspace.root")(
      function* (orgId: KinOrgId) {
        return yield* ensureLocked(orgId);
      },
      lock.withPermits(1),
      failed("make the documents workspace"),
    );

    return KinWorkspace.of({
      root: rootFor,
      recipes,
      prepare,
      checkoutRecipe,
      applyRecipeChange,
      previewRecipeChange,
      undoRecipe,
      discard,
      head,
      madeBefore,
    });
  }),
);
