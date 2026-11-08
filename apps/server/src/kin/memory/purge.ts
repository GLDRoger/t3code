// @effect-diagnostics-next-line nodeBuiltinImport:off -- The plan digest must match the grant's sha256 content target.
import * as NodeCrypto from "node:crypto";
import {
  KinOrgId,
  type KinActionTarget,
  type KinGrantPayload,
  type KinPendingAction,
  type MemoryItemKind,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { stringify } from "yaml";

import { VcsProcess } from "../../vcs/VcsProcess.ts";
import { KinPurgePush, hardenedGitEnv, scrubbedGitEnv, type PurgeRefUpdate } from "./purgePush.ts";
import { parseFrontMatter } from "./frontMatter.ts";
import { memoryGit } from "./git.ts";
import { Memory, type MemoryHistoryRewrite } from "./Memory.ts";
import { MemoryConfig } from "./MemoryConfig.ts";
import { readObjects } from "./objects.ts";
import { KinSecretScan, type SecretFinding } from "./secretScan.ts";

/** `redact_text` rewrites every blob and commit message in history, so it takes no paths. */
const PurgePlanSchema = Schema.Union([
  Schema.Struct({
    orgId: KinOrgId,
    repo: Schema.String,
    mode: Schema.Literal("drop_file"),
    paths: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    orgId: KinOrgId,
    repo: Schema.String,
    mode: Schema.Literal("redact_text"),
    patterns: Schema.Array(Schema.String),
  }),
]);
export type PurgePlan = typeof PurgePlanSchema.Type;
const decodePlan = Schema.decodeUnknownEffect(Schema.fromJsonString(PurgePlanSchema));

const Tombstones = Schema.Array(Schema.String);
/** Carries the plan so `reconcile` and re-runs still work if the plan file is lost. */
const PurgeMarker = Schema.Struct({
  sha256: Schema.String,
  actionId: Schema.String,
  oldHead: Schema.String,
  plan: Schema.String,
  /** Blob ids of this purge's own tombstones; any other blob at a purged path is old content. */
  tombstones: Tombstones,
});
const decodeMarker = Schema.decodeUnknownOption(Schema.fromJsonString(PurgeMarker));
const decodeTombstones = Schema.decodeUnknownOption(Schema.fromJsonString(Tombstones));
const encodeTombstones = Schema.encodeEffect(Schema.fromJsonString(Tombstones));

/** A `memory_purge` action's target: the stored plan file and its sha256. */
export type PurgeTarget = Extract<KinActionTarget, { readonly _tag: "content" }>;
const purgeTarget = (action: KinPendingAction) =>
  action.kind === "memory_purge" && action.target._tag === "content" ? action.target : undefined;

/** Lane B's `KinAuditAppendInput` (APPR-10) for the `execution_finished` entry. */
export interface PurgeAuditInput {
  readonly orgId: KinOrgId;
  readonly event: "execution_finished";
  readonly actionId: string;
  readonly kind: "memory_purge";
  readonly grantJti: string;
  readonly keyThumbprint: string;
  readonly headSha: string;
  readonly result: string;
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
export class KinPurgePauseUnavailable extends Schema.TaggedError<KinPurgePauseUnavailable>()(
  "KinPurgePauseUnavailable",
  { orgId: Schema.String },
) {}
export class KinPurgeFailed extends Schema.TaggedError<KinPurgeFailed>()("KinPurgeFailed", {
  orgId: Schema.String,
  stage: Schema.Literals([
    "clone",
    "rewrite",
    "verify",
    "tombstone",
    "quarantine",
    "push",
    "rebuild",
  ]),
  reason: Schema.String,
  /** Once the checkouts are quarantined for the push, the queue stays paused until `reconcile`. */
  queueHeld: Schema.Boolean,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * LEAD-11 supplies the real org pause; until then the purge can't run. `pause` must not return while a
 * wake-up or dream is still running for the org: their staged files and dream copies predate the rewrite.
 */
export class KinPurgeQueue extends Context.Reference<{
  readonly pause: (orgId: KinOrgId) => Effect.Effect<void, KinPurgePauseUnavailable>;
  readonly resume: (orgId: KinOrgId) => Effect.Effect<void>;
}>("t3/kin/memory/purge/KinPurgeQueue", {
  defaultValue: () => ({
    pause: (orgId) => Effect.fail(new KinPurgePauseUnavailable({ orgId })),
    resume: () => Effect.void,
  }),
}) {}

export const GitFilterRepoCommand = Context.Reference<string>(
  "t3/kin/memory/purge/GitFilterRepoCommand",
  { defaultValue: () => "git-filter-repo" },
);

const literalPathspecs = { GIT_LITERAL_PATHSPECS: "1" };

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

const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const planFilePath = /^purge-plans\/[a-f0-9]{64}\.json$/;

/** The stored plan file and the action target that binds it, from one serialization. */
export const purgePlanJson = (plan: PurgePlan) => {
  const json = JSON.stringify(
    plan.mode === "drop_file"
      ? { orgId: plan.orgId, repo: plan.repo, mode: plan.mode, paths: plan.paths }
      : { orgId: plan.orgId, repo: plan.repo, mode: plan.mode, patterns: plan.patterns },
  );
  const digest = sha256(json);
  return {
    json,
    target: {
      _tag: "content",
      path: `purge-plans/${digest}.json`,
      sha256: digest,
    } satisfies PurgeTarget,
  };
};

const planRejection = (plan: PurgePlan) => {
  if (plan.mode === "drop_file") {
    if (plan.paths.length === 0 || plan.paths.length > 64) return "Expected 1-64 paths";
    if (new Set(plan.paths).size !== plan.paths.length) return "Duplicate paths";
    if (!plan.paths.every(isPurgePath)) return "Invalid path";
    return undefined;
  }
  if (plan.patterns.length === 0 || plan.patterns.length > 64) return "Expected 1-64 patterns";
  if (new Set(plan.patterns).size !== plan.patterns.length) return "Duplicate patterns";
  if (!plan.patterns.every(isPattern)) return "Invalid pattern";
  return undefined;
};

/** Returns why the plan, its action or its grant is unacceptable, or `undefined`. */
export const purgeRejection = (
  plan: PurgePlan,
  action: KinPendingAction,
  grant?: KinGrantPayload,
) => {
  const actionTarget = purgeTarget(action);
  if (!actionTarget) return "Action is not a memory purge";
  if (action.orgId !== plan.orgId || (grant !== undefined && grant.orgId !== plan.orgId))
    return "Grant, action and plan organizations differ";
  if (
    grant !== undefined &&
    (grant.actionId !== action.id ||
      grant.revision !== action.revision ||
      grant.kind !== action.kind ||
      grant.targetDigest !== action.targetDigest ||
      grant.target._tag !== "content" ||
      grant.target.sha256 !== actionTarget.sha256)
  )
    return "Grant does not bind this action revision";
  const { target } = purgePlanJson(plan);
  if (actionTarget.sha256 !== target.sha256 || actionTarget.path !== target.path)
    return "Plan does not match the approved digest";
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(action.id)) return "Invalid action id";
  return planRejection(plan);
};

const isPurgeFailed = Schema.is(KinPurgeFailed);
const markerJson = (marker: typeof PurgeMarker.Type) => JSON.stringify(marker);
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
    /** Writes the plan file a `memory_purge` action targets; the proposer calls it before `request_action`. */
    readonly storePlan: (
      plan: PurgePlan,
    ) => Effect.Effect<PurgeTarget, KinPurgeRejected | KinPurgeFailed>;
    /** Deletes the plan file once the action is terminal; it can hold the redacted secret. */
    readonly discardPlan: (target: PurgeTarget) => Effect.Effect<void, KinPurgeRejected>;
    readonly precheck: (
      action: KinPendingAction,
    ) => Effect.Effect<void, KinPurgeExecutorNotReady | KinPurgeRejected | KinPurgeFailed>;
    /** Server-only: reached through `memoryPurgeHandler`, never a model, MCP tool or RPC. */
    readonly purge: (
      action: KinPendingAction,
      grant: KinGrantPayload,
    ) => Effect.Effect<
      PurgeResult,
      KinPurgeExecutorNotReady | KinPurgeRejected | KinPurgePauseUnavailable | KinPurgeFailed
    >;
    readonly reconcile: (
      action: KinPendingAction,
    ) => Effect.Effect<
      "done" | "not_done" | "unknown",
      KinPurgeExecutorNotReady | KinPurgeRejected | KinPurgeFailed
    >;
  }
>()("t3/kin/memory/purge/KinPurge") {}

// Gated until APPR-9 (executor), APPR-10 (audit) and LEAD-11 (queue pause) land.
const purgeExecutorReady = false;
/** Test seam for the release gate; production always reads `purgeExecutorReady`. */
export const PurgeExecutorGate = Context.Reference<boolean>(
  "t3/kin/memory/purge/PurgeExecutorGate",
  { defaultValue: () => purgeExecutorReady },
);

const make = Effect.gen(function* () {
  const memory = yield* Memory;
  const config = yield* MemoryConfig;
  const scanner = yield* KinSecretScan;
  const pusher = yield* KinPurgePush;
  const queue = yield* KinPurgeQueue;
  const filterRepo = yield* GitFilterRepoCommand;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
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
    provide(memoryGit(work, args, stdin, { ...scrubbedGitEnv(), ...hardenedGitEnv, ...env })).pipe(
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
  const reject = (reason: string) => Effect.fail(new KinPurgeRejected({ reason }));

  const gate = Effect.fn("KinPurge.gate")(function* (action: KinPendingAction) {
    if (!(yield* PurgeExecutorGate))
      return yield* new KinPurgeExecutorNotReady({ actionId: action.id });
  });

  const repoFor = (plan: PurgePlan) => {
    const repo = config.repositories.find((entry) => entry.orgId === plan.orgId);
    return repo && repo.repoUrl === plan.repo ? repo : undefined;
  };

  const planFile = (target: PurgeTarget) =>
    planFilePath.test(target.path) && target.path === `purge-plans/${target.sha256}.json`
      ? Effect.succeed(path.resolve(config.baseDirectory, target.path))
      : reject("Invalid plan path");
  /** The tombstone ids outlive the marker, so a `reconcile` after a finished purge still knows them. */
  const tombstonesFile = (planPath: string) => planPath.replace(/\.json$/, ".tombstones.json");

  const markerFor = (orgId: KinOrgId) =>
    memory.purgeInFlight(orgId).pipe(
      Effect.map((inFlight) => ({
        inFlight,
        marker: inFlight === undefined ? undefined : Option.getOrUndefined(decodeMarker(inFlight)),
      })),
    );

  const loadPlan = Effect.fn("KinPurge.loadPlan")(function* (
    action: KinPendingAction,
    target: PurgeTarget,
  ) {
    const file = yield* planFile(target);
    const stored = yield* fs.readFileString(file).pipe(Effect.option);
    const json = Option.isSome(stored)
      ? stored.value
      : config.repositories.some((entry) => entry.orgId === action.orgId)
        ? yield* markerFor(action.orgId).pipe(
            Effect.map(({ marker }) =>
              marker?.sha256 === target.sha256 ? marker.plan : undefined,
            ),
            Effect.orElseSucceed(() => undefined),
          )
        : undefined;
    if (json === undefined) return yield* reject("Plan file is missing");
    const plan = yield* decodePlan(json).pipe(
      Effect.mapError(() => new KinPurgeRejected({ reason: "Plan file is malformed" })),
    );
    if (purgePlanJson(plan).json !== json)
      return yield* reject("Plan does not match the approved digest");
    return { plan, file };
  });

  /** Validates the action against its stored plan and the org's config, and returns any purge marker. */
  const checked = Effect.fn("KinPurge.checked")(function* (
    action: KinPendingAction,
    grant?: KinGrantPayload,
  ) {
    yield* gate(action);
    const target = purgeTarget(action);
    if (!target) return yield* reject("Action is not a memory purge");
    const { plan, file } = yield* loadPlan(action, target);
    const rejection = purgeRejection(plan, action, grant);
    if (rejection !== undefined) return yield* reject(rejection);
    const repo = repoFor(plan);
    if (!repo) return yield* reject("Plan repo is not this organization's memory");
    const { inFlight, marker } = yield* markerFor(plan.orgId).pipe(
      failed(plan.orgId, "clone", "Could not read the purge marker"),
    );
    return { plan, file, target, repo, inFlight, marker };
  });

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

  /** Every blob ever introduced, merge sides included, plus every commit and tag object unless `paths` narrows it. */
  const historyFiles = Effect.fn("KinPurge.historyFiles")(function* (
    orgId: KinOrgId,
    work: string,
    paths?: ReadonlyArray<string>,
  ) {
    const raw = yield* git(
      work,
      [
        "log",
        "--all",
        "--raw",
        "--no-abbrev",
        "--no-renames",
        "--diff-merges=separate",
        "--format=",
        "-z",
        ...(paths ? ["--", ...paths] : []),
      ],
      undefined,
      literalPathspecs,
    );
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
    const commits = paths
      ? []
      : (yield* git(work, ["rev-list", "--all"])).split("\n").filter(Boolean);
    // Tagger idents survive filter-repo's text and message rewrites; nested tags included.
    const tags = paths
      ? []
      : (yield* git(work, [
          "cat-file",
          "--batch-all-objects",
          "--batch-check=%(objectname) %(objecttype)",
        ]))
          .split("\n")
          .flatMap((line) => {
            const [sha, type] = line.split(" ");
            return sha && type === "tag" ? [sha] : [];
          });
    const requests = [
      ...[...blobs.values()].map(({ sha, path }) => ({ sha, type: "blob" as const, path })),
      ...commits.map((sha) => ({ sha, type: "commit" as const, path: `commit ${sha}` })),
      ...tags.map((sha) => ({ sha, type: "tag" as const, path: `tag ${sha}` })),
    ];
    const files: Array<{ sha: string; path: string; content: Uint8Array }> = [];
    for (let index = 0; index < requests.length; index += 32) {
      const batch = requests.slice(index, index + 32);
      const objects = yield* provide(readObjects(orgId, work, batch));
      for (const [position, request] of batch.entries()) {
        const content = objects[position];
        if (content) files.push({ sha: request.sha, path: request.path, content });
      }
    }
    return files;
  });

  const containsPattern = (
    files: ReadonlyArray<{ readonly content: Uint8Array }>,
    patterns: ReadonlyArray<string>,
  ) => {
    const needles = patterns.map((pattern) => Buffer.from(pattern, "utf8"));
    return files.some((file) =>
      needles.some((needle) => Buffer.from(file.content).includes(needle)),
    );
  };

  const pathInHistory = (work: string, file: string) =>
    git(work, ["rev-list", "--all", "-n", "1", "--", file], undefined, literalPathspecs).pipe(
      Effect.map((commits) => commits.length > 0),
    );

  /** Whether any reachable commit still holds what the plan removes, besides this purge's `tombstones`. */
  const planInHistory = Effect.fn("KinPurge.planInHistory")(function* (
    plan: PurgePlan,
    tombstones: ReadonlyArray<string>,
    work: string,
  ) {
    if (plan.mode === "drop_file")
      return (yield* historyFiles(plan.orgId, work, plan.paths)).some(
        (file) => !tombstones.includes(file.sha),
      );
    return containsPattern(yield* historyFiles(plan.orgId, work), plan.patterns);
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
    action: KinPendingAction,
    grant: KinGrantPayload,
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
        source: `kin-action:${action.id}`,
        said_by: grant.approver.humanId,
        trust: "owner",
        links: [],
      },
      `Purged on ${iso.slice(0, 10)} by the owner (action ${action.id}).\n`,
    );
    yield* parseFrontMatter(orgId, path, content);
    return content;
  });

  const commitTombstones = Effect.fn("KinPurge.commitTombstones")(function* (
    work: string,
    branch: string,
    head: string,
    tombstones: ReadonlyMap<string, string>,
    actionId: string,
    now: number,
  ) {
    const date = `${Math.floor(now / 1000)} +0000`;
    const env = {
      GIT_INDEX_FILE: `${work}/tombstone-index`,
      GIT_AUTHOR_NAME: config.botName ?? "Kin Memory Bot",
      GIT_AUTHOR_EMAIL: config.botEmail ?? "kin-memory@localhost",
      GIT_COMMITTER_NAME: config.botName ?? "Kin Memory Bot",
      GIT_COMMITTER_EMAIL: config.botEmail ?? "kin-memory@localhost",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    };
    yield* git(work, ["read-tree", head], undefined, env);
    const blobs: string[] = [];
    const entries: string[] = [];
    for (const [path, content] of tombstones) {
      const blob = yield* git(work, ["hash-object", "-w", "--stdin"], content);
      blobs.push(blob);
      entries.push(`100644 blob ${blob}\t${path}`);
    }
    yield* git(work, ["update-index", "--index-info"], entries.join("\n") + "\n", env);
    const tree = yield* git(work, ["write-tree"], undefined, env);
    const commit = yield* git(
      work,
      ["commit-tree", tree, "-p", head, "-m", `Purge tombstones (action ${actionId})`],
      undefined,
      env,
    );
    yield* git(work, ["update-ref", `refs/heads/${branch}`, commit, head]);
    return { commit, blobs };
  });

  /**
   * A fresh bare clone of `refs/heads/*` and `refs/tags/*` under the org's purge directory; stale ones
   * from a crashed purge are swept first. GitHub's read-only `refs/pull/*` stay out of reach. Any other
   * advertised ref (`refs/notes/*`, custom namespaces) would keep the old history, so it fails closed.
   */
  const mirror = Effect.fn("KinPurge.mirror")(function* (
    orgId: KinOrgId,
    repo: { readonly repoUrl: string; readonly path: string },
  ) {
    const advertised = yield* pusher
      .listRefs({ orgId, repoUrl: repo.repoUrl })
      .pipe(failed(orgId, "clone", "Could not list remote refs"));
    const foreign = advertised.filter(
      (ref) => ref !== "HEAD" && !/^refs\/(heads|tags|pull)\//.test(ref),
    );
    if (foreign.length > 0)
      return yield* fail(
        orgId,
        "clone",
        `Remote has refs a purge can't rewrite; remove them first: ${foreign.slice(0, 10).join(", ")}`,
      );
    const root = path.resolve(config.baseDirectory, repo.path, "purge-scratch");
    const work = yield* Effect.gen(function* () {
      yield* fs.remove(root, { recursive: true, force: true });
      yield* fs.makeDirectory(root, { recursive: true });
      return yield* fs.makeTempDirectoryScoped({ directory: root, prefix: "mirror-" });
    }).pipe(failed(orgId, "clone", "Could not create a scratch directory"));
    yield* git(work, [
      "clone",
      "--bare",
      "--no-local",
      "--template=",
      "--",
      repo.repoUrl,
      `${work}/.git`,
    ]).pipe(failed(orgId, "clone", "Bare clone failed"));
    // filter-repo rewrites commits only, and `historyFiles` walks commits only.
    const nonCommitTags = (yield* git(work, [
      "for-each-ref",
      "--format=%(refname) %(objecttype) %(*objecttype)",
      "refs/tags/",
    ]).pipe(failed(orgId, "clone", "Could not list tags")))
      .split("\n")
      .flatMap((line) => {
        const [ref, type, peeled] = line.split(" ");
        return ref && type !== "commit" && !(type === "tag" && peeled === "commit") ? [ref] : [];
      });
    if (nonCommitTags.length > 0)
      return yield* fail(
        orgId,
        "clone",
        `Remote has tags that don't point at a commit; remove them first: ${nonCommitTags.slice(0, 10).join(", ")}`,
      );
    const before = yield* branchRefs(work).pipe(failed(orgId, "clone", "Could not list refs"));
    const head = before.get(`refs/heads/${config.defaultBranch ?? "main"}`);
    if (!head) return yield* fail(orgId, "clone", "Remote default branch is missing");
    return { work, before, head };
  });

  const rewrite = Effect.fn("KinPurge.rewrite")(function* (input: {
    readonly plan: PurgePlan;
    readonly planFile: string;
    readonly target: PurgeTarget;
    readonly action: KinPendingAction;
    readonly grant: KinGrantPayload;
    readonly repo: { readonly repoUrl: string; readonly path: string };
    readonly inFlight: string | undefined;
    readonly marker: typeof PurgeMarker.Type | undefined;
    readonly history: MemoryHistoryRewrite;
    readonly commit: () => void;
  }) {
    const { plan, target, action, grant, repo, history } = input;
    const { orgId } = plan;
    const branch = config.defaultBranch ?? "main";
    const now = yield* Clock.currentTimeMillis;
    if (
      (yield* memory
        .purgeInFlight(orgId)
        .pipe(failed(orgId, "clone", "Could not read the purge marker"))) !== input.inFlight
    ) {
      input.commit();
      return yield* fail(orgId, "clone", "The purge marker changed while waiting for the lock");
    }
    const { work, before, head: oldHead } = yield* mirror(orgId, repo);

    // A re-run after a push that landed: nothing to rewrite, but the checkouts still need a reclone.
    if (input.inFlight !== undefined) {
      const remaining = yield* planInHistory(plan, input.marker?.tombstones ?? [], work).pipe(
        failed(orgId, "verify", "Could not check history"),
      );
      if (!remaining) {
        yield* history
          .reclone()
          .pipe(failed(orgId, "rebuild", "Could not rebuild local memory checkouts"));
        return {
          oldHead: input.marker?.oldHead ?? oldHead,
          newHead: oldHead,
          updates: [],
          tombstones: [],
        };
      }
    }

    const tombstones = new Map<string, string>();
    if (plan.mode === "drop_file")
      for (const file of plan.paths) {
        const present = yield* pathInHistory(work, file).pipe(
          failed(orgId, "verify", "Could not check history"),
        );
        if (!present)
          return yield* reject(
            "A purge path is not in history; check its spelling and Unicode normalization",
          );
        const content = yield* tombstone(orgId, work, oldHead, file, action, grant, now).pipe(
          failed(orgId, "tombstone", "Could not build a tombstone"),
        );
        if (content !== undefined) tombstones.set(file, content);
      }

    const rules = `${work}/rules.txt`;
    if (plan.mode === "redact_text")
      yield* fs
        .writeFileString(
          rules,
          plan.patterns.map((pattern) => `literal:${pattern}==>***REMOVED***`).join("\n") + "\n",
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
            ? ["--invert-paths", ...plan.paths.flatMap((file) => ["--path", file])]
            : ["--replace-text", rules, "--replace-message", rules]),
        ],
        env: {
          ...scrubbedGitEnv(),
          ...hardenedGitEnv,
          // filter-repo accepts only a fresh clone opened as GIT_DIR=. from its own directory.
          GIT_DIR: ".",
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
      const remaining = yield* planInHistory(plan, [], work).pipe(
        failed(orgId, "verify", "Could not check rewritten history"),
      );
      if (remaining) return yield* fail(orgId, "verify", "Purged paths remain in history");
    }
    const { commit: newHead, blobs } =
      tombstones.size > 0
        ? yield* commitTombstones(work, branch, rewrittenHead, tombstones, action.id, now).pipe(
            failed(orgId, "tombstone", "Could not commit tombstones"),
          )
        : { commit: rewrittenHead, blobs: [] };

    const files = yield* historyFiles(orgId, work).pipe(
      failed(orgId, "verify", "Could not read rewritten history"),
    );
    if (plan.mode === "redact_text" && containsPattern(files, plan.patterns))
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

    yield* Effect.gen(function* () {
      const file = tombstonesFile(input.planFile);
      yield* fs.writeFileString(`${file}.tmp`, yield* encodeTombstones(blobs));
      yield* fs.rename(`${file}.tmp`, file);
    }).pipe(failed(orgId, "tombstone", "Could not record the tombstones"));
    // From here a push may land at any moment, so local checkouts holding the old history must go
    // first; the marker keeps preserve and merges from pushing it back until a reclone or reconcile.
    input.commit();
    yield* history
      .quarantine(
        markerJson({
          sha256: target.sha256,
          actionId: action.id,
          oldHead: input.marker?.oldHead ?? oldHead,
          plan: purgePlanJson(plan).json,
          tombstones: blobs,
        }),
      )
      .pipe(failed(orgId, "quarantine", "Could not quarantine local memory checkouts"));
    yield* pusher.push({ orgId, repoUrl: repo.repoUrl, gitDir: work, updates }).pipe(
      Effect.mapError(
        (error) =>
          new KinPurgeFailed({
            orgId,
            stage: "push",
            reason: `Force-push failed: ${error.reason}`,
            queueHeld: true,
          }),
      ),
    );
    // The lease covers only refs this purge saw, so one created since can still hold the old history.
    const clean = yield* mirror(orgId, repo).pipe(
      Effect.flatMap((fresh) => planInHistory(plan, blobs, fresh.work)),
      Effect.map((remaining) => !remaining),
      Effect.orElseSucceed(() => false),
    );
    if (!clean)
      return yield* new KinPurgeFailed({
        orgId,
        stage: "push",
        reason: "The remote may still hold purged history after the push; reconcile it",
        queueHeld: true,
      });
    yield* history
      .reclone()
      .pipe(failed(orgId, "rebuild", "Could not rebuild local memory checkouts"));
    return {
      oldHead: input.marker?.oldHead ?? oldHead,
      newHead,
      updates,
      tombstones: [...tombstones.keys()],
    };
  });

  return KinPurge.of({
    storePlan: Effect.fn("KinPurge.storePlan")(function* (plan) {
      const rejection = planRejection(plan) ?? (repoFor(plan) ? undefined : "Unknown memory repo");
      if (rejection !== undefined) return yield* reject(rejection);
      const { json, target } = purgePlanJson(plan);
      const file = yield* planFile(target);
      yield* Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(`${file}.tmp`, json);
        yield* fs.rename(`${file}.tmp`, file);
      }).pipe(failed(plan.orgId, "clone", "Could not store the plan"));
      return target;
    }),

    discardPlan: Effect.fn("KinPurge.discardPlan")(function* (target) {
      const file = yield* planFile(target);
      for (const { orgId } of config.repositories) {
        const { inFlight, marker } = yield* markerFor(orgId).pipe(
          Effect.mapError(
            () => new KinPurgeRejected({ reason: "Could not read the purge marker" }),
          ),
        );
        if (inFlight !== undefined && (marker === undefined || marker.sha256 === target.sha256))
          return yield* reject("This plan's purge is in flight; reconcile it first");
      }
      yield* Effect.all([
        fs.remove(file, { force: true }),
        fs.remove(tombstonesFile(file), { force: true }),
      ]).pipe(Effect.mapError(() => new KinPurgeRejected({ reason: "Could not delete the plan" })));
    }),

    precheck: Effect.fn("KinPurge.precheck")(function* (action) {
      const { target, inFlight, marker } = yield* checked(action);
      if (inFlight !== undefined && marker?.sha256 !== target.sha256)
        return yield* reject("Another purge is in flight; reconcile it first");
    }),

    purge: Effect.fn("KinPurge.purge")(function* (action, grant) {
      const { plan, file, target, repo, inFlight, marker } = yield* checked(action, grant);
      if (inFlight !== undefined && marker?.sha256 !== target.sha256)
        return yield* reject("Another purge is in flight; reconcile it first");
      const { orgId } = plan;
      // An unresolved marker means the queue is already held for this plan; never resume it early.
      let committed = inFlight !== undefined;
      yield* queue.pause(orgId);
      const { oldHead, newHead, updates, tombstones } = yield* memory
        .withHistoryRewrite(orgId, (history) =>
          Effect.scoped(
            rewrite({
              plan,
              planFile: file,
              target,
              action,
              grant,
              repo,
              inFlight,
              marker,
              history,
              commit: () => {
                committed = true;
              },
            }),
          ),
        )
        .pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) || !committed ? queue.resume(orgId) : Effect.void,
          ),
          Effect.catchCause((cause) => {
            if (!committed || Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
            const error = Option.getOrUndefined(Cause.findErrorOption(cause));
            return Effect.fail(
              new KinPurgeFailed({
                orgId,
                stage: isPurgeFailed(error) ? error.stage : "push",
                reason: isPurgeFailed(error)
                  ? error.reason
                  : "Purge stopped after quarantining local checkouts",
                queueHeld: true,
                ...(isPurgeFailed(error) && error.cause !== undefined
                  ? { cause: error.cause }
                  : {}),
              }),
            );
          }),
        );
      const paths = plan.mode === "drop_file" ? plan.paths : [];
      return {
        mode: plan.mode,
        paths,
        oldHead,
        newHead,
        rewrittenRefs: updates,
        tombstones,
        audit: {
          orgId,
          event: "execution_finished",
          actionId: action.id,
          kind: "memory_purge",
          grantJti: grant.jti,
          keyThumbprint: grant.approver.kid,
          headSha: newHead,
          result: auditResult({ mode: plan.mode, paths, oldHead, newHead, refs: updates }),
        },
      } satisfies PurgeResult;
    }),

    reconcile: Effect.fn("KinPurge.reconcile")(function* (action) {
      const { plan, file, target, repo, inFlight, marker } = yield* checked(action);
      if (inFlight !== undefined && marker?.sha256 !== target.sha256) return "unknown";
      const { orgId } = plan;
      const tombstones =
        marker?.tombstones ??
        Option.getOrElse(
          Option.flatMap(
            yield* fs.readFileString(tombstonesFile(file)).pipe(Effect.option),
            decodeTombstones,
          ),
          () => [],
        );
      return yield* memory.withHistoryRewrite(orgId, (history) =>
        Effect.scoped(
          Effect.gen(function* () {
            const observed = yield* mirror(orgId, repo).pipe(
              Effect.flatMap(({ work, head }) =>
                planInHistory(plan, tombstones, work).pipe(
                  Effect.map((remaining) => ({ head, remaining })),
                ),
              ),
              Effect.option,
            );
            if (Option.isNone(observed)) return "unknown" as const;
            const { head, remaining } = observed.value;
            const verdict = !remaining
              ? ("done" as const)
              : marker === undefined || head === marker.oldHead
                ? ("not_done" as const)
                : ("unknown" as const);
            if (verdict === "unknown") return verdict;
            if (inFlight !== undefined)
              yield* history.reclone().pipe(
                Effect.mapError(
                  () =>
                    new KinPurgeFailed({
                      orgId,
                      stage: "rebuild",
                      reason: "Could not rebuild local memory checkouts",
                      queueHeld: true,
                    }),
                ),
              );
            yield* queue.resume(orgId);
            return verdict;
          }),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(KinPurge, make);

/** APPR-9's `KinActionHandler` for `memory_purge`; the executor calls it with a verified grant. */
export const memoryPurgeHandler = {
  kind: "memory_purge",
  precheck: Effect.fn("KinPurge.handlerPrecheck")(function* (action: KinPendingAction) {
    return yield* (yield* KinPurge).precheck(action);
  }),
  run: Effect.fn("KinPurge.handlerRun")(function* (
    action: KinPendingAction,
    grant: KinGrantPayload,
  ) {
    return yield* (yield* KinPurge).purge(action, grant);
  }),
  reconcile: Effect.fn("KinPurge.handlerReconcile")(function* (action: KinPendingAction) {
    return yield* (yield* KinPurge).reconcile(action);
  }),
} as const;
