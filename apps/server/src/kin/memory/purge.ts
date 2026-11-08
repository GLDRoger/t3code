// @effect-diagnostics-next-line nodeBuiltinImport:off -- The plan digest must match the grant's sha256 content target.
import * as NodeCrypto from "node:crypto";
import type { KinOrgId, MemoryItemKind } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { stringify } from "yaml";

import { VcsProcess } from "../../vcs/VcsProcess.ts";
import { parseFrontMatter } from "./frontMatter.ts";
import { memoryGit } from "./git.ts";
import { Memory } from "./Memory.ts";
import { MemoryConfig } from "./MemoryConfig.ts";
import { readObjects } from "./objects.ts";
import { KinSecretScan, type SecretFinding } from "./secretScan.ts";

export interface PurgePlan {
  readonly orgId: KinOrgId;
  readonly repo: string;
  readonly paths: ReadonlyArray<string>;
  readonly mode: "drop_file" | "redact_text";
  readonly patterns?: ReadonlyArray<string>;
}

/** Lane B's `KinGrant` (APPR-4) fields the purge binds to. The executor verifies the signature. */
export interface PurgeGrant {
  readonly id: string;
  readonly orgId: KinOrgId;
  readonly actionId: string;
  readonly revision: number;
  readonly jti: string;
  readonly approverHumanId: string;
  readonly keyThumbprint: string;
}

/** Lane B's `KinPendingAction` (APPR-2) for kind `memory_purge`; the target is the plan's digest. */
export interface PurgeAction {
  readonly id: string;
  readonly orgId: KinOrgId;
  readonly kind: "memory_purge";
  readonly revision: number;
  readonly target: { readonly _tag: "content"; readonly path: string; readonly sha256: string };
}

export interface PurgeAuthority {
  readonly action: PurgeAction;
  readonly grant: PurgeGrant;
  /** Id of the executor's `execution_started` audit entry, written before `run`. */
  readonly auditId: string;
  readonly deviceLabel?: string;
}

/** Lane B's `KinAuditAppendInput` (APPR-10) for the `execution_finished` entry. */
export interface PurgeAuditInput {
  readonly orgId: KinOrgId;
  readonly event: "execution_finished";
  readonly actionId: string;
  readonly kind: "memory_purge";
  readonly grantJti: string;
  readonly keyThumbprint: string;
  readonly deviceLabel?: string;
  readonly headSha: string;
  readonly result: string;
}

export interface PurgeRefUpdate {
  readonly ref: string;
  readonly old: string;
  readonly new: string | null;
}

export interface PurgeResult {
  readonly mode: PurgePlan["mode"];
  readonly paths: ReadonlyArray<string>;
  readonly oldHead: string;
  readonly newHead: string;
  readonly rewrittenRefs: ReadonlyArray<PurgeRefUpdate>;
  readonly tombstones: ReadonlyArray<string>;
  readonly audit: PurgeAuditInput;
}

export class KinPurgeRejected extends Schema.TaggedError<KinPurgeRejected>()("KinPurgeRejected", {
  reason: Schema.String,
}) {}
export class KinPurgeExecutorNotReady extends Schema.TaggedError<KinPurgeExecutorNotReady>()(
  "KinPurgeExecutorNotReady",
  { actionId: Schema.String },
) {}
export class KinPurgePushError extends Schema.TaggedError<KinPurgePushError>()(
  "KinPurgePushError",
  { reason: Schema.String },
) {}
export class KinPurgeFailed extends Schema.TaggedError<KinPurgeFailed>()("KinPurgeFailed", {
  orgId: Schema.String,
  stage: Schema.Literals(["clone", "rewrite", "verify", "tombstone", "push", "rebuild"]),
  reason: Schema.String,
  /** Once the push starts, local checkouts may hold the old history, so the queue stays paused. */
  queueHeld: Schema.Boolean,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** LEAD-11 supplies the real org pause; the default is a no-op that the purge still calls. */
export class KinPurgeQueue extends Context.Reference<{
  readonly pause: (orgId: KinOrgId) => Effect.Effect<void>;
  readonly resume: (orgId: KinOrgId) => Effect.Effect<void>;
}>("t3/kin/memory/purge/KinPurgeQueue", {
  defaultValue: () => ({ pause: () => Effect.void, resume: () => Effect.void }),
}) {}

export const GitFilterRepoCommand = Context.Reference<string>(
  "t3/kin/memory/purge/GitFilterRepoCommand",
  { defaultValue: () => "git-filter-repo" },
);

export class KinPurgePush extends Context.Service<
  KinPurgePush,
  {
    readonly push: (input: {
      readonly orgId: KinOrgId;
      readonly repoUrl: string;
      readonly gitDir: string;
      readonly updates: ReadonlyArray<PurgeRefUpdate>;
    }) => Effect.Effect<void, KinPurgePushError>;
  }
>()("t3/kin/memory/purge/KinPurgePush") {}

/** Pushes with the owner's git credential helper or SSH command; T3 never reads the secret. */
export const gitPushLayer = (owner: {
  readonly credentialHelper?: string;
  readonly sshCommand?: string;
}) =>
  Layer.effect(
    KinPurgePush,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const vcs = yield* VcsProcess;
      const config = yield* MemoryConfig;
      const ownerConfig = MemoryConfig.of({
        baseDirectory: config.baseDirectory,
        repositories: config.repositories,
        ...(owner.credentialHelper ? { credentialHelper: owner.credentialHelper } : {}),
        ...(owner.sshCommand ? { sshCommand: owner.sshCommand } : {}),
      });
      return KinPurgePush.of({
        push: Effect.fn("KinPurgePush.git")(function* ({ repoUrl, gitDir, updates }) {
          yield* memoryGit(gitDir, [
            "push",
            "--atomic",
            "--porcelain",
            ...updates.map((update) => `--force-with-lease=${update.ref}:${update.old}`),
            "--",
            repoUrl,
            ...updates.map((update) => `${update.new ?? ""}:${update.ref}`),
          ]).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(VcsProcess, vcs),
            Effect.provideService(MemoryConfig, ownerConfig),
            // The cause can echo the remote URL or helper output; keep both out of errors and logs.
            Effect.mapError(() => new KinPurgePushError({ reason: "Force-push failed" })),
          );
        }),
      });
    }),
  );

const itemKinds = new Map<string, MemoryItemKind>([
  ["objectives", "objective"],
  ["commitments", "commitment"],
  ["deferrals", "deferral"],
  ["decisions", "decision"],
  ["people", "person"],
  ["claims", "claim"],
]);

const isPurgePath = (path: string) =>
  path.length > 0 &&
  path.length <= 512 &&
  path.normalize("NFC") === path &&
  !/[\u0000-\u001f\u007f-\u009f\\]|\p{Default_Ignorable_Code_Point}/u.test(path) &&
  path.endsWith(".md") &&
  path !== "rules.md" &&
  path
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.startsWith("-") &&
        segment.trim() === segment &&
        !/^\.git[. ]*$/i.test(segment),
    );

const isPattern = (pattern: string) =>
  pattern.length >= 8 &&
  pattern.length <= 1024 &&
  !/[\u0000-\u001f\u007f]/.test(pattern) &&
  !pattern.includes("==>");

export const purgePlanDigest = (plan: PurgePlan) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        orgId: plan.orgId,
        repo: plan.repo,
        mode: plan.mode,
        paths: plan.paths,
        patterns: plan.patterns ?? [],
      }),
    )
    .digest("hex");

/** Returns why the plan or its authority is unacceptable, or `undefined`. */
export const purgeRejection = (plan: PurgePlan, authority: PurgeAuthority) => {
  const { action, grant } = authority;
  if (action.kind !== "memory_purge" || action.target._tag !== "content")
    return "Action is not a memory purge";
  if (action.orgId !== plan.orgId || grant.orgId !== plan.orgId)
    return "Grant, action and plan organizations differ";
  if (grant.actionId !== action.id || grant.revision !== action.revision)
    return "Grant does not bind this action revision";
  if (action.target.sha256 !== purgePlanDigest(plan))
    return "Plan does not match the approved digest";
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(authority.auditId)) return "Invalid audit id";
  if (plan.paths.length === 0 || plan.paths.length > 64) return "Expected 1-64 paths";
  if (new Set(plan.paths).size !== plan.paths.length) return "Duplicate paths";
  if (!plan.paths.every(isPurgePath)) return "Invalid path";
  const patterns = plan.patterns ?? [];
  if (plan.mode === "drop_file" && patterns.length > 0) return "drop_file takes no patterns";
  if (plan.mode === "redact_text") {
    if (patterns.length === 0 || patterns.length > 64) return "Expected 1-64 patterns";
    if (new Set(patterns).size !== patterns.length) return "Duplicate patterns";
    if (!patterns.every(isPattern)) return "Invalid pattern";
  }
  return undefined;
};

const isPurgeFailed = Schema.is(KinPurgeFailed);
const auditResult = (result: {
  readonly mode: PurgePlan["mode"];
  readonly paths: ReadonlyArray<string>;
  readonly oldHead: string;
  readonly newHead: string;
  readonly refs: ReadonlyArray<PurgeRefUpdate>;
}) => JSON.stringify(result);
const render = (fields: object, body: string) => `---\n${stringify(fields)}---\n${body}`;
const scanBatchFiles = 256;
const scanBatchBytes = 4 * 1024 * 1024;

export class KinPurge extends Context.Service<
  KinPurge,
  {
    /** Server-only: reached through `memoryPurgeHandler`, never a model, MCP tool or RPC. */
    readonly purge: (
      plan: PurgePlan,
      authority: PurgeAuthority,
    ) => Effect.Effect<PurgeResult, KinPurgeRejected | KinPurgeFailed>;
  }
>()("t3/kin/memory/purge/KinPurge") {}

const make = Effect.gen(function* () {
  const memory = yield* Memory;
  const config = yield* MemoryConfig;
  const scanner = yield* KinSecretScan;
  const pusher = yield* KinPurgePush;
  const queue = yield* KinPurgeQueue;
  const filterRepo = yield* GitFilterRepoCommand;
  const fs = yield* FileSystem.FileSystem;
  const vcs = yield* VcsProcess;
  const provide = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | VcsProcess>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(VcsProcess, vcs),
    );
  const git = (
    work: string,
    args: ReadonlyArray<string>,
    stdin?: string,
    env: NodeJS.ProcessEnv = {},
  ) =>
    provide(memoryGit(work, args, stdin, env)).pipe(
      Effect.provideService(MemoryConfig, config),
      Effect.map((stdout) => stdout.trim()),
    );
  const failed =
    (orgId: KinOrgId, stage: KinPurgeFailed["stage"], reason: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isPurgeFailed(cause)
            ? cause
            : new KinPurgeFailed({ orgId, stage, reason, queueHeld: false, cause }),
        ),
      );
  const fail = (orgId: KinOrgId, stage: KinPurgeFailed["stage"], reason: string) =>
    Effect.fail(new KinPurgeFailed({ orgId, stage, reason, queueHeld: false }));

  const branchRefs = Effect.fn("KinPurge.branchRefs")(function* (work: string) {
    const lines = yield* git(work, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads/",
      "refs/tags/",
    ]);
    return new Map(
      lines.split("\n").flatMap((line) => {
        const [ref, sha] = line.split(" ");
        return ref && sha ? [[ref, sha] as const] : [];
      }),
    );
  });

  const historyFiles = Effect.fn("KinPurge.historyFiles")(function* (
    orgId: KinOrgId,
    work: string,
  ) {
    const raw = yield* git(work, [
      "log",
      "--all",
      "--raw",
      "--no-abbrev",
      "--no-renames",
      "--diff-merges=separate",
      "--format=",
      "-z",
    ]);
    const blobs = new Map<string, { sha: string; path: string }>();
    const tokens = raw.split("\0");
    for (let index = 0; index < tokens.length; index++) {
      const header = /^\n*:\d{6} (\d{6}) [a-f0-9]+ ([a-f0-9]+) [A-Z]\d*$/.exec(tokens[index] ?? "");
      if (!header) continue;
      const path = tokens[++index] ?? "";
      const [, mode, sha] = header;
      if (!sha || /^0+$/.test(sha) || mode === "160000") continue;
      blobs.set(`${sha} ${path}`, { sha, path });
    }
    const commits = (yield* git(work, ["rev-list", "--all"])).split("\n").filter(Boolean);
    const requests = [
      ...[...blobs.values()].map(({ sha, path }) => ({ sha, type: "blob" as const, path })),
      ...commits.map((sha) => ({ sha, type: "commit" as const, path: `commit ${sha}` })),
    ];
    const files: Array<{ path: string; content: Uint8Array }> = [];
    for (let index = 0; index < requests.length; index += 32) {
      const batch = requests.slice(index, index + 32);
      const objects = yield* provide(readObjects(orgId, work, batch));
      for (const [position, request] of batch.entries()) {
        const content = objects[position];
        if (content) files.push({ path: request.path, content });
      }
    }
    return files;
  });

  const scanAll = Effect.fn("KinPurge.scanAll")(function* (
    orgId: KinOrgId,
    files: ReadonlyArray<{ path: string; content: Uint8Array }>,
  ) {
    const findings: SecretFinding[] = [];
    let batch: Array<{ path: string; content: Uint8Array }> = [];
    let bytes = 0;
    const flush = Effect.gen(function* () {
      if (batch.length) findings.push(...(yield* scanner.scan({ orgId, files: batch })));
      batch = [];
      bytes = 0;
    });
    for (const file of files) {
      if (batch.length >= scanBatchFiles || bytes + file.content.length > scanBatchBytes)
        yield* flush;
      batch.push(file);
      bytes += file.content.length;
    }
    yield* flush;
    return findings;
  });

  const tombstone = Effect.fn("KinPurge.tombstone")(function* (
    orgId: KinOrgId,
    work: string,
    oldHead: string,
    path: string,
    authority: PurgeAuthority,
    now: number,
  ) {
    const folder = path.split("/")[0] ?? "";
    const kind = itemKinds.get(folder);
    if (!kind) return undefined;
    const blob = yield* git(work, ["rev-parse", "--verify", "--quiet", `${oldHead}:${path}`]).pipe(
      Effect.option,
    );
    if (blob._tag === "None") return undefined;
    const original = yield* provide(
      readObjects(orgId, work, [{ sha: blob.value, type: "blob" }]),
    ).pipe(
      Effect.flatMap((objects) =>
        parseFrontMatter(orgId, path, objects[0]?.toString("utf8") ?? ""),
      ),
      Effect.option,
    );
    const iso = DateTime.formatIso(DateTime.makeUnsafe(now));
    const content = render(
      {
        id:
          original._tag === "Some"
            ? original.value.frontMatter.id
            : (path.split("/").at(-1) ?? path).slice(0, -3),
        kind,
        title: "Purged item",
        status: "cancelled",
        due: null,
        recorded_at: iso,
        valid_from: iso,
        invalid_at: iso,
        superseded_by: null,
        review_by: null,
        source: `kin-audit:${authority.auditId}`,
        said_by: authority.grant.approverHumanId,
        trust: "owner",
        links: [],
      },
      `Purged on ${iso.slice(0, 10)} by the owner (audit ${authority.auditId}).\n`,
    );
    yield* parseFrontMatter(orgId, path, content);
    return content;
  });

  const commitTombstones = Effect.fn("KinPurge.commitTombstones")(function* (
    orgId: KinOrgId,
    work: string,
    branch: string,
    head: string,
    tombstones: ReadonlyMap<string, string>,
    auditId: string,
    now: number,
  ) {
    const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "kin-purge-index-" });
    const date = `${Math.floor(now / 1000)} +0000`;
    const env = {
      GIT_INDEX_FILE: `${scratch}/index`,
      GIT_AUTHOR_NAME: config.botName ?? "Kin Memory Bot",
      GIT_AUTHOR_EMAIL: config.botEmail ?? "kin-memory@localhost",
      GIT_COMMITTER_NAME: config.botName ?? "Kin Memory Bot",
      GIT_COMMITTER_EMAIL: config.botEmail ?? "kin-memory@localhost",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    };
    yield* git(work, ["read-tree", head], undefined, env);
    const entries: string[] = [];
    for (const [path, content] of tombstones) {
      const blob = yield* git(work, ["hash-object", "-w", "--stdin"], content);
      entries.push(`100644 blob ${blob}\t${path}`);
    }
    yield* git(work, ["update-index", "--index-info"], entries.join("\n") + "\n", env);
    const tree = yield* git(work, ["write-tree"], undefined, env);
    const commit = yield* git(
      work,
      ["commit-tree", tree, "-p", head, "-m", `Purge tombstones (audit ${auditId})`],
      undefined,
      env,
    );
    yield* git(work, ["update-ref", `refs/heads/${branch}`, commit, head]);
    return commit;
  });

  const rewrite = Effect.fn("KinPurge.rewrite")(function* (
    plan: PurgePlan,
    authority: PurgeAuthority,
    repoUrl: string,
    onPush: () => void,
  ) {
    const { orgId } = plan;
    const branch = config.defaultBranch ?? "main";
    const now = yield* Clock.currentTimeMillis;
    const work = yield* fs
      .makeTempDirectoryScoped({ prefix: "kin-purge-" })
      .pipe(failed(orgId, "clone", "Could not create a scratch directory"));
    yield* git(work, [
      "clone",
      "--mirror",
      "--no-local",
      "--template=",
      "--",
      repoUrl,
      `${work}/.git`,
    ]).pipe(failed(orgId, "clone", "Mirror clone failed"));
    const before = yield* branchRefs(work).pipe(failed(orgId, "clone", "Could not list refs"));
    const oldHead = before.get(`refs/heads/${branch}`);
    if (!oldHead) return yield* fail(orgId, "clone", "Remote default branch is missing");

    const tombstones = new Map<string, string>();
    if (plan.mode === "drop_file")
      for (const path of plan.paths) {
        const content = yield* tombstone(orgId, work, oldHead, path, authority, now).pipe(
          failed(orgId, "tombstone", "Could not build a tombstone"),
        );
        if (content !== undefined) tombstones.set(path, content);
      }

    const scratch = yield* fs
      .makeTempDirectoryScoped({ prefix: "kin-purge-rules-" })
      .pipe(failed(orgId, "rewrite", "Could not create a scratch directory"));
    const rules = `${scratch}/rules.txt`;
    if (plan.mode === "redact_text")
      yield* fs
        .writeFileString(
          rules,
          (plan.patterns ?? []).map((pattern) => `literal:${pattern}==>***REMOVED***`).join("\n") +
            "\n",
        )
        .pipe(failed(orgId, "rewrite", "Could not write replacement rules"));
    yield* vcs
      .run({
        operation: "KinPurge.filterRepo",
        command: filterRepo,
        cwd: `${work}/.git`,
        args: [
          "--quiet",
          ...(plan.mode === "drop_file"
            ? ["--invert-paths", ...plan.paths.flatMap((path) => ["--path", path])]
            : ["--replace-text", rules, "--replace-message", rules]),
        ],
        env: {
          // filter-repo accepts only a fresh clone opened as GIT_DIR=. from its own directory.
          GIT_DIR: ".",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_CONFIG_COUNT: "3",
          GIT_CONFIG_KEY_0: "core.hooksPath",
          GIT_CONFIG_VALUE_0: "/dev/null",
          GIT_CONFIG_KEY_1: "core.fsmonitor",
          GIT_CONFIG_VALUE_1: "false",
          GIT_CONFIG_KEY_2: "core.attributesFile",
          GIT_CONFIG_VALUE_2: "/dev/null",
        },
        timeoutMs: 600_000,
      })
      .pipe(failed(orgId, "rewrite", "git filter-repo failed"));

    const rewritten = yield* branchRefs(work).pipe(failed(orgId, "rewrite", "Could not list refs"));
    const rewrittenHead = rewritten.get(`refs/heads/${branch}`);
    if (!rewrittenHead) return yield* fail(orgId, "rewrite", "Rewrite removed the default branch");
    if ([...before].every(([ref, sha]) => rewritten.get(ref) === sha))
      return yield* fail(orgId, "rewrite", "Nothing in history matched the plan");

    if (plan.mode === "drop_file") {
      const remaining = yield* git(work, ["rev-list", "--all", "--", ...plan.paths]).pipe(
        failed(orgId, "verify", "Could not check rewritten history"),
      );
      if (remaining) return yield* fail(orgId, "verify", "Purged paths remain in history");
    }
    const newHead =
      tombstones.size > 0
        ? yield* commitTombstones(
            orgId,
            work,
            branch,
            rewrittenHead,
            tombstones,
            authority.auditId,
            now,
          ).pipe(failed(orgId, "tombstone", "Could not commit tombstones"))
        : rewrittenHead;

    const files = yield* historyFiles(orgId, work).pipe(
      failed(orgId, "verify", "Could not read rewritten history"),
    );
    const leftovers = (plan.patterns ?? []).map((pattern) => Buffer.from(pattern, "utf8"));
    if (
      files.some((file) => leftovers.some((pattern) => Buffer.from(file.content).includes(pattern)))
    )
      return yield* fail(orgId, "verify", "Redacted text remains in history");
    const findings = yield* scanAll(orgId, files).pipe(
      failed(orgId, "verify", "Secret scan of rewritten history failed"),
    );
    if (findings.length > 0)
      return yield* fail(
        orgId,
        "verify",
        `Secret scan found ${findings.length} finding(s) in rewritten history: ${[
          ...new Set(findings.map((finding) => finding.ruleId)),
        ].join(", ")}`,
      );

    const after = yield* branchRefs(work).pipe(failed(orgId, "verify", "Could not list refs"));
    const updates: PurgeRefUpdate[] = [...before]
      .filter(([ref, sha]) => after.get(ref) !== sha)
      .map(([ref, old]) => ({ ref, old, new: after.get(ref) ?? null }));
    onPush();
    yield* pusher
      .push({ orgId, repoUrl, gitDir: work, updates })
      .pipe(failed(orgId, "push", "Force-push failed"));
    yield* memory
      .reclone(orgId)
      .pipe(failed(orgId, "rebuild", "Could not rebuild local memory checkouts"));
    return { oldHead, newHead, updates, tombstones: [...tombstones.keys()] };
  });

  return KinPurge.of({
    purge: Effect.fn("KinPurge.purge")(function* (plan, authority) {
      const rejection = purgeRejection(plan, authority);
      if (rejection !== undefined) return yield* new KinPurgeRejected({ reason: rejection });
      const repo = config.repositories.find((entry) => entry.orgId === plan.orgId);
      if (!repo || repo.repoUrl !== plan.repo)
        return yield* new KinPurgeRejected({
          reason: "Plan repo is not this organization's memory",
        });
      let pushStarted = false;
      yield* queue.pause(plan.orgId);
      const exit = yield* memory
        .withWriterLock(
          plan.orgId,
          Effect.scoped(
            rewrite(plan, authority, repo.repoUrl, () => {
              pushStarted = true;
            }),
          ),
        )
        .pipe(Effect.exit);
      if (Exit.isFailure(exit)) {
        if (!pushStarted) {
          yield* queue.resume(plan.orgId);
          return yield* Effect.failCause(exit.cause);
        }
        return yield* Effect.failCause(exit.cause).pipe(
          Effect.mapError(
            (error) =>
              new KinPurgeFailed({
                orgId: error.orgId,
                stage: error.stage,
                reason: error.reason,
                queueHeld: true,
                ...(error.cause === undefined ? {} : { cause: error.cause }),
              }),
          ),
        );
      }
      yield* queue.resume(plan.orgId);
      const { oldHead, newHead, updates, tombstones } = exit.value;
      return {
        mode: plan.mode,
        paths: plan.paths,
        oldHead,
        newHead,
        rewrittenRefs: updates,
        tombstones,
        audit: {
          orgId: plan.orgId,
          event: "execution_finished",
          actionId: authority.action.id,
          kind: "memory_purge",
          grantJti: authority.grant.jti,
          keyThumbprint: authority.grant.keyThumbprint,
          ...(authority.deviceLabel === undefined ? {} : { deviceLabel: authority.deviceLabel }),
          headSha: newHead,
          result: auditResult({
            mode: plan.mode,
            paths: plan.paths,
            oldHead,
            newHead,
            refs: updates,
          }),
        },
      } satisfies PurgeResult;
    }),
  });
});

export const layer = Layer.effect(KinPurge, make);

// Gated until APPR-9 (executor) and APPR-10 (audit) land.
const purgeExecutorReady = false;
/** Test seam for the release gate; production always reads `purgeExecutorReady`. */
export const PurgeExecutorGate = Context.Reference<boolean>(
  "t3/kin/memory/purge/PurgeExecutorGate",
  { defaultValue: () => purgeExecutorReady },
);

/** The only way to purge: APPR-9's executor calls `run` with a verified grant. */
export const memoryPurgeHandler = {
  kind: "memory_purge",
  run: Effect.fn("KinPurge.handler")(function* (plan: PurgePlan, authority: PurgeAuthority) {
    if (!(yield* PurgeExecutorGate))
      return yield* new KinPurgeExecutorNotReady({ actionId: authority.action.id });
    return yield* (yield* KinPurge).purge(plan, authority);
  }),
} as const;
