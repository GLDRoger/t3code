import * as DateTime from "effect/DateTime";
import type { KinAgentId, KinOrgId, MemoryTrust } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { stringify } from "yaml";
import { memoryGit as runMemoryGit } from "./git.ts";
import { VcsProcess } from "../../vcs/VcsProcess.ts";
import { MemoryConfig } from "./MemoryConfig.ts";
import {
  Memory,
  MemoryCheckoutInvalid,
  MemoryError,
  MemorySyncConflict,
  MemoryConfigError,
  MemoryQueryDecodeError,
  MemoryNotFound,
  MemoryDuplicateId,
} from "./Memory.ts";
import { parseFrontMatter, MemoryItemError } from "./frontMatter.ts";
import { journalEntry, MemoryJournalError, type JournalContext } from "./journal.ts";
import { KinSecretScan, KinSecretScanError } from "./secretScan.ts";

export interface WakeupContext extends JournalContext {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly level: "L0" | "L1" | "L2" | "L3";
  readonly sources: ReadonlyMap<
    string,
    { readonly saidBy: string; readonly trust: MemoryTrust; readonly source: string }
  >;
}
// The runner resolves this context from same-org records, never tool input.
export class MemoryWriterAuthority extends Context.Service<
  MemoryWriterAuthority,
  {
    readonly resolve: (
      orgId: KinOrgId,
      wakeupId: string,
    ) => Effect.Effect<WakeupContext, MemoryWriteRejected>;
  }
>()("t3/kin/memory/MemoryWriter/MemoryWriterAuthority") {}
export class MemoryWriteRejected extends Schema.TaggedError<MemoryWriteRejected>()(
  "MemoryWriteRejected",
  {
    reason: Schema.String,
  },
) {}
export class MemoryConflict extends Schema.TaggedError<MemoryConflict>()("MemoryConflict", {
  existingId: Schema.String,
}) {}
export class MemorySecretBlocked extends Schema.TaggedError<MemorySecretBlocked>()(
  "MemorySecretBlocked",
  {
    orgId: Schema.String,
    findings: Schema.Array(
      Schema.Struct({ path: Schema.String, ruleId: Schema.String, line: Schema.Number }),
    ),
  },
) {}
export type WriterNotice = {
  readonly orgId: KinOrgId;
  readonly wakeupId: string;
  readonly error: MemoryCheckoutInvalid | MemorySyncConflict | MemorySecretBlocked;
};
export class MemoryWriterHooks extends Context.Service<
  MemoryWriterHooks,
  {
    readonly notify: (notice: WriterNotice) => Effect.Effect<void>;
    readonly buildIndex: (input: {
      orgId: KinOrgId;
      writer: string;
      recorded: string;
    }) => Effect.Effect<string | null, MemoryError>;
  }
>()("t3/kin/memory/MemoryWriter/MemoryWriterHooks") {}
export interface MemoryChange {
  readonly path: string;
  readonly content: string;
  readonly sourceEventId?: string;
  readonly supersedes?: string;
}
type Failure =
  | MemoryJournalError
  | MemoryConfigError
  | MemoryQueryDecodeError
  | MemoryNotFound
  | MemoryDuplicateId
  | MemoryError
  | MemoryCheckoutInvalid
  | MemorySyncConflict
  | MemoryWriteRejected
  | MemoryConflict
  | MemoryItemError
  | KinSecretScanError
  | MemorySecretBlocked;
export class MemoryWriter extends Context.Service<
  MemoryWriter,
  {
    readonly stage: (
      orgId: KinOrgId,
      wakeupId: string,
      change: MemoryChange,
    ) => Effect.Effect<void, Failure>;
    readonly appendJournal: (
      orgId: KinOrgId,
      wakeupId: string,
      lines: ReadonlyArray<string>,
    ) => Effect.Effect<void, Failure>;
    readonly discard: (orgId: KinOrgId, wakeupId: string) => Effect.Effect<void, Failure>;
    readonly commitWakeup: (
      orgId: KinOrgId,
      wakeupId: string,
      outcome: "completed" | "failed",
    ) => Effect.Effect<{ commit: string }, Failure>;
  }
>()("t3/kin/memory/MemoryWriter") {}
const folders = ["objectives", "commitments", "deferrals", "decisions", "people", "claims"];
const render = (fields: object, body: string) => `---\n${stringify(fields)}---\n${body}`;
const make = Effect.gen(function* () {
  const memory = yield* Memory;
  const authority = yield* MemoryWriterAuthority;
  const hooks = yield* MemoryWriterHooks;
  const scanner = yield* KinSecretScan;
  const fs = yield* FileSystem.FileSystem;
  const vcs = yield* VcsProcess;
  const memoryGit = (...args: Parameters<typeof runMemoryGit>) =>
    runMemoryGit(...args).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(VcsProcess, vcs),
    );
  const config = yield* MemoryConfig;
  const locked = memory.withWriterLock;
  const sessions = new Map<
    KinOrgId,
    { wakeupId: string; files: Map<string, string>; lines: string[] }
  >();
  const io = <A, E, R>(orgId: KinOrgId, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => new MemoryError({ orgId, operation: "writer", cause })));
  const git = Effect.fn("MemoryWriter.git")(function* (
    orgId: KinOrgId,
    cwd: string,
    args: ReadonlyArray<string>,
    identity: NodeJS.ProcessEnv = {},
    stdin?: string,
  ) {
    return (yield* io(orgId, memoryGit(cwd, args, stdin, identity))).trim();
  });
  const session = Effect.fn("MemoryWriter.session")(function* (orgId: KinOrgId, wakeupId: string) {
    const ctx = yield* authority.resolve(orgId, wakeupId);
    if (
      ctx.orgId !== orgId ||
      ctx.wakeupId !== wakeupId ||
      !/^[a-zA-Z0-9_-]+$/.test(ctx.agentId) ||
      !/^[a-zA-Z0-9_-]+$/.test(wakeupId) ||
      ctx.eventIds.some((id) => !/^[a-zA-Z0-9_-]+$/.test(id))
    )
      return yield* new MemoryWriteRejected({ reason: "Invalid server context" });
    const previous = sessions.get(orgId);
    if (previous && previous.wakeupId !== wakeupId)
      return yield* new MemoryWriteRejected({ reason: "Another wake-up owns the writer" });
    const state = previous ?? { wakeupId, files: new Map<string, string>(), lines: [] };
    sessions.set(orgId, state);
    return { ctx, state };
  });
  const safePath = Effect.fn("MemoryWriter.safePath")(function* (
    orgId: KinOrgId,
    writer: string,
    relative: string,
    generated = false,
  ) {
    const parts = relative.split("/");
    if (
      !relative.endsWith(".md") ||
      parts.some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          p.toLowerCase() === ".git" ||
          p.includes("\\") ||
          p.includes(":"),
      ) ||
      /[\x00-\x1f]/.test(relative) ||
      (!(generated && relative === "INDEX.md") && ![...folders, "journal"].includes(parts[0] ?? ""))
    )
      return yield* new MemoryWriteRejected({ reason: "Disallowed memory path" });
    let current = writer;
    for (const part of parts) {
      current += `/${part}`;
      const result = yield* fs.lstat(current).pipe(Effect.result);
      if (result._tag === "Failure") {
        if (result.failure.reason._tag !== "NotFound")
          return yield* new MemoryError({ orgId, operation: "path", cause: result.failure });
      } else if (
        result.success.type === "SymbolicLink" ||
        (result.success.type === "File" &&
          Option.isSome(result.success.nlink) &&
          result.success.nlink.value > 1) ||
        (current !== `${writer}/${relative}` && result.success.type !== "Directory")
      ) {
        return yield* new MemoryWriteRejected({ reason: "Symlink or invalid ancestor" });
      }
    }
  });
  const validate = Effect.fn("MemoryWriter.validate")(function* (orgId: KinOrgId) {
    const paths = yield* memory.ensureCheckouts(orgId);
    return paths;
  });
  const report = <A>(orgId: KinOrgId, wakeupId: string, effect: Effect.Effect<A, Failure>) =>
    effect.pipe(
      Effect.tapError((error) =>
        error._tag === "MemoryCheckoutInvalid" ||
        error._tag === "MemorySyncConflict" ||
        error._tag === "MemorySecretBlocked"
          ? hooks
              .notify({ orgId, wakeupId, error })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Memory writer notification failed", cause),
                ),
              )
          : Effect.void,
      ),
    );
  return MemoryWriter.of({
    stage: Effect.fn("MemoryWriter.stage")((orgId, wakeupId, change) =>
      report(
        orgId,
        wakeupId,
        locked(
          orgId,
          Effect.gen(function* () {
            const { ctx, state } = yield* session(orgId, wakeupId);
            const { writer } = yield* validate(orgId);
            yield* safePath(orgId, writer, change.path);
            if (change.path.startsWith("journal/"))
              return yield* new MemoryWriteRejected({
                reason: "Use appendJournal for journal additions",
              });
            const parsed = yield* parseFrontMatter(orgId, change.path, change.content);
            const source =
              change.sourceEventId === undefined
                ? { saidBy: ctx.agentId, trust: "agent", source: `wakeup:${wakeupId}` }
                : ctx.sources.get(change.sourceEventId);
            if (!source)
              return yield* new MemoryWriteRejected({
                reason: "Source is not in the current batch",
              });
            const fm = parsed.frontMatter;
            const folder = fm.kind === "person" ? "people" : `${fm.kind}s`;
            if (!change.path.startsWith(`${folder}/`))
              return yield* new MemoryWriteRejected({ reason: "Kind does not match path" });
            const branch =
              ctx.level === "L0" ? `kin/shadow/${ctx.agentId}` : (config.defaultBranch ?? "main");
            const anchored = yield* memory.anchor(orgId, branch).pipe(Effect.result);
            const local = yield* git(orgId, writer, [
              "rev-parse",
              "--verify",
              `refs/heads/${branch}`,
            ]).pipe(Effect.result);
            if (
              (anchored._tag === "Success" &&
                (local._tag === "Failure" || local.success !== anchored.success)) ||
              (anchored._tag === "Failure" && local._tag === "Success")
            )
              return yield* new MemoryCheckoutInvalid({
                orgId,
                operation: "stage",
                reason: "Unrecorded branch tip",
              });
            const recorded =
              anchored._tag === "Success"
                ? anchored.success
                : yield* memory.anchor(orgId, config.defaultBranch ?? "main");
            const tree = yield* git(orgId, writer, [
              "ls-tree",
              "-r",
              "--name-only",
              "-z",
              recorded,
              "--",
              ...folders,
            ]);
            const items = [];
            const bodies = new Map<string, string>();
            for (const file of tree.split("\0").filter(Boolean)) {
              const content = yield* io(
                orgId,
                memoryGit(writer, ["cat-file", "blob", `${recorded}:${file}`]),
              );
              const parsedItem = yield* parseFrontMatter(orgId, file, content).pipe(Effect.result);
              if (parsedItem._tag === "Failure") continue;
              items.push({
                ...parsedItem.success.frontMatter,
                orgId,
                path: file,
                duplicate: false,
              });
              bodies.set(file, parsedItem.success.body);
            }
            for (const [file, text] of state.files) {
              if (file.startsWith("journal/") || file === "INDEX.md") continue;
              const staged = yield* parseFrontMatter(orgId, file, text);
              const index = items.findIndex((item) => item.path === file);
              const head = { ...staged.frontMatter, orgId, path: file, duplicate: false };
              if (index < 0) items.push(head);
              else items[index] = head;
              bodies.set(file, staged.body);
            }
            const superseded =
              change.supersedes === undefined
                ? undefined
                : items.find((item) => item.id === change.supersedes);
            if (
              change.supersedes !== undefined &&
              (!superseded ||
                superseded.kind !== fm.kind ||
                superseded.source !== source.source ||
                Date.parse(fm.recorded_at) <= Date.parse(superseded.recorded_at) ||
                superseded.id === fm.id)
            )
              return yield* new MemoryWriteRejected({
                reason: "Supersession requires the same source and kind",
              });
            for (const item of items) {
              if (
                (item.id === fm.id || item.status === "open") &&
                item.kind === fm.kind &&
                (item.id === fm.id || item.links.some((link) => fm.links.includes(link))) &&
                item.id !== change.supersedes
              ) {
                const body = bodies.get(item.path) ?? (yield* memory.readItem(orgId, item.id)).body;
                const rank = (trust: string) =>
                  ["external", "agent", "member", "owner"].indexOf(trust);
                if (
                  item.id === fm.id &&
                  (rank(source.trust) < rank(item.trust) ||
                    (fm.status !== item.status &&
                      !(item.status === "open" && ["done", "cancelled"].includes(fm.status))))
                )
                  return yield* new MemoryConflict({ existingId: item.id });
                if (body !== parsed.body || item.title !== fm.title)
                  return yield* new MemoryConflict({ existingId: item.id });
                if (item.id === fm.id) {
                  const proposed = new Map(Object.entries(fm));
                  const mutable = new Set([
                    "orgId",
                    "path",
                    "duplicate",
                    "status",
                    "invalid_at",
                    "trust",
                    "said_by",
                    "source",
                  ]);
                  if (
                    Object.entries(item).some(
                      ([key, value]) =>
                        !mutable.has(key) &&
                        JSON.stringify(value) !== JSON.stringify(proposed.get(key)),
                    )
                  )
                    return yield* new MemoryConflict({ existingId: item.id });
                }
              }
              if (
                (item.path === change.path && item.id !== fm.id) ||
                (item.id === fm.id && item.path !== change.path)
              )
                return yield* new MemoryWriteRejected({
                  reason: "Cannot replace a different item",
                });
            }
            const review =
              fm.review_by !== undefined
                ? fm.review_by
                : fm.kind === "decision"
                  ? null
                  : fm.kind === "commitment" || fm.kind === "deferral"
                    ? fm.due
                    : DateTime.formatIso(
                        DateTime.makeUnsafe(
                          Date.parse(ctx.startedAt) + (fm.kind === "person" ? 90 : 30) * 86400000,
                        ),
                      );
            const fields = {
              ...fm,
              said_by: source.saidBy,
              source: source.source,
              trust:
                fm.trust === "external" ||
                (fm.trust === "agent" && source.trust !== "external") ||
                (fm.trust === "member" && source.trust === "owner")
                  ? fm.trust
                  : source.trust,
              review_by: review,
            };
            const existing = items.find((item) => item.id === fm.id);
            const text = render(
              existing
                ? {
                    ...fields,
                    trust: existing.trust,
                    said_by: existing.said_by,
                    source: existing.source,
                  }
                : fields,
              parsed.body,
            );
            yield* parseFrontMatter(orgId, change.path, text);
            if (superseded) {
              const oldBody =
                bodies.get(superseded.path) ?? (yield* memory.readItem(orgId, superseded.id)).body;
              const {
                orgId: _org,
                path: oldPath,
                duplicate: _duplicate,
                ...oldFields
              } = superseded;
              const oldText = render(
                { ...oldFields, status: "superseded", superseded_by: fm.id },
                oldBody,
              );
              state.files.set(oldPath, oldText);
            }
            state.files.set(change.path, text);
          }),
        ),
      ),
    ),
    appendJournal: Effect.fn("MemoryWriter.appendJournal")((orgId, wakeupId, lines) =>
      locked(
        orgId,
        Effect.gen(function* () {
          const { state } = yield* session(orgId, wakeupId);
          state.lines.push(...lines);
        }),
      ),
    ),
    discard: Effect.fn("MemoryWriter.discard")((orgId, wakeupId) =>
      locked(
        orgId,
        Effect.gen(function* () {
          const state = sessions.get(orgId);
          if (state && state.wakeupId !== wakeupId)
            return yield* new MemoryWriteRejected({ reason: "Another wake-up owns the writer" });
          sessions.delete(orgId);
        }),
      ),
    ),
    commitWakeup: Effect.fn("MemoryWriter.commitWakeup")((orgId, wakeupId, outcome) =>
      locked(
        orgId,
        report(
          orgId,
          wakeupId,
          Effect.gen(function* () {
            const { ctx, state } = yield* session(orgId, wakeupId);
            const { writer } = yield* validate(orgId);
            const repo = config.repositories.find((entry) => entry.orgId === orgId);
            if (!repo)
              return yield* new MemoryConfigError({
                orgId,
                operation: "writer",
                reason: "Unknown org",
              });
            const branch =
              ctx.level === "L0" ? `kin/shadow/${ctx.agentId}` : (config.defaultBranch ?? "main");
            const main = yield* memory.anchor(orgId, config.defaultBranch ?? "main");
            const anchored = yield* memory.anchor(orgId, branch).pipe(Effect.result);
            let recorded: string;
            if (anchored._tag === "Failure") {
              const exists = yield* git(orgId, writer, [
                "rev-parse",
                "--verify",
                `refs/heads/${branch}`,
              ]).pipe(Effect.result);
              if (exists._tag === "Success")
                return yield* new MemoryCheckoutInvalid({
                  orgId,
                  operation: "branch",
                  reason: "Unanchored local branch",
                });
              const fresh = yield* git(orgId, writer, [
                "fetch",
                "--",
                repo.repoUrl,
                `refs/heads/${config.defaultBranch ?? "main"}`,
              ]);
              if (fresh !== main)
                return yield* new MemoryCheckoutInvalid({
                  orgId,
                  operation: "bootstrap",
                  reason: "Prepare required before branch creation",
                });
              recorded = yield* memory.anchor(orgId, branch, fresh);
              yield* git(orgId, writer, [
                "update-ref",
                `refs/heads/${branch}`,
                recorded,
                "0000000000000000000000000000000000000000",
              ]);
            } else recorded = anchored.success;
            const tip = yield* git(orgId, writer, ["rev-parse", `refs/heads/${branch}`]);
            if (tip !== recorded)
              return yield* new MemoryCheckoutInvalid({
                orgId,
                operation: "branch",
                reason: "Unrecorded branch tip",
              });
            const push = (sha: string) =>
              git(orgId, writer, ["push", "--", repo.repoUrl, `${sha}:refs/heads/${branch}`]).pipe(
                Effect.mapError(
                  (cause) =>
                    new MemorySyncConflict({
                      orgId,
                      operation: "push",
                      reason: "Push rejected; retry or reconcile remote",
                      cause,
                    }),
                ),
              );
            return yield* Effect.gen(function* () {
              const subject = `kin(${ctx.agentId}): wake-up ${wakeupId}`;
              const fingerprint = yield* git(
                orgId,
                writer,
                ["hash-object", "--no-filters", "--stdin"],
                {},
                stringify({
                  outcome,
                  files: [...state.files].sort(([a], [b]) => a.localeCompare(b)),
                  lines: state.lines,
                }),
              );
              const body = yield* git(orgId, writer, [
                "show",
                "--format=%B",
                "--no-patch",
                recorded,
              ]);
              if (body.split("\n")[0] === subject) {
                if (
                  !body.includes(`Kin-Outcome: ${outcome}`) ||
                  (state.files.size + state.lines.length > 0 &&
                    !body.includes(`Kin-Request: ${fingerprint}`))
                )
                  return yield* new MemoryWriteRejected({ reason: "Different wake-up retry" });
                yield* push(recorded);
                return { commit: recorded };
              }
              if (outcome === "failed") state.files.clear();
              const entry = yield* journalEntry(ctx, outcome, state.lines);
              yield* safePath(orgId, writer, entry.path);
              const oldResult = yield* git(orgId, writer, [
                "cat-file",
                "blob",
                `${recorded}:${entry.path}`,
              ]).pipe(Effect.result);
              // Preserve journal bytes; the general git wrapper trims command output.
              const old =
                oldResult._tag === "Success"
                  ? yield* io(
                      orgId,
                      memoryGit(writer, ["cat-file", "blob", `${recorded}:${entry.path}`]),
                    )
                  : "";
              state.files.set(entry.path, old + entry.text);
              const index = yield* hooks.buildIndex({ orgId, writer, recorded });
              if (index !== null) state.files.set("INDEX.md", index);
              const findings = yield* scanner.scan({
                orgId,
                files: [...state.files].map(([path, content]) => ({
                  path,
                  content: new TextEncoder().encode(content),
                })),
              });
              if (findings.length) return yield* new MemorySecretBlocked({ orgId, findings });
              return yield* Effect.scoped(
                Effect.gen(function* () {
                  const temporary = yield* io(orgId, fs.makeTempDirectoryScoped());
                  const env = {
                    GIT_INDEX_FILE: `${temporary}/index`,
                    GIT_AUTHOR_NAME: config.botName ?? "Kin Memory Bot",
                    GIT_AUTHOR_EMAIL: config.botEmail ?? "kin-memory@localhost",
                    GIT_COMMITTER_NAME: config.botName ?? "Kin Memory Bot",
                    GIT_COMMITTER_EMAIL: config.botEmail ?? "kin-memory@localhost",
                  };
                  yield* git(orgId, writer, ["read-tree", recorded], env);
                  for (const [file, text] of state.files) {
                    yield* safePath(orgId, writer, file, true);
                    const blob = yield* git(
                      orgId,
                      writer,
                      ["hash-object", "-w", "--no-filters", "--stdin"],
                      env,
                      text,
                    );
                    yield* git(
                      orgId,
                      writer,
                      ["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`],
                      env,
                    );
                  }
                  const tree = yield* git(orgId, writer, ["write-tree"], env);
                  const message = `${subject}\n\nEvents: ${ctx.eventIds.join(", ")}\nKin-Outcome: ${outcome}\nKin-Request: ${fingerprint}\n`;
                  const commit = yield* git(
                    orgId,
                    writer,
                    ["commit-tree", tree, "-p", recorded],
                    env,
                    message,
                  );
                  yield* git(orgId, writer, [
                    "update-ref",
                    `refs/heads/${branch}`,
                    commit,
                    recorded,
                  ]);
                  yield* memory.record(orgId, branch, recorded, commit);
                  yield* push(commit);
                  return { commit };
                }),
              );
            }).pipe(Effect.ensuring(Effect.sync(() => sessions.delete(orgId))));
          }),
        ),
      ),
    ),
  });
});
export const layer = Layer.effect(MemoryWriter, make);
