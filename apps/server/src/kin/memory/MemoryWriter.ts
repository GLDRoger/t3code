import * as DateTime from "effect/DateTime";
import type { KinAgentId, KinOrgId, MemoryTrust } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { stringify } from "yaml";
import { VcsProcess } from "../../vcs/VcsProcess.ts";
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
import { journalEntry, type JournalContext } from "./journal.ts";
import { KinSecretScan, KinSecretScanError, type SecretFinding } from "./secretScan.ts";

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
  const locks = new Map<KinOrgId, Semaphore.Semaphore>();
  const locked = <A, E>(orgId: KinOrgId, effect: Effect.Effect<A, E>) => {
    let lock = locks.get(orgId);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(orgId, lock);
    }
    return lock.withPermits(1)(effect);
  };
  const sessions = new Map<
    KinOrgId,
    { wakeupId: string; files: Map<string, string>; lines: string[] }
  >();
  const io = <A, E>(orgId: KinOrgId, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError((cause) => new MemoryError({ orgId, operation: "writer", cause })));
  const git = Effect.fn("MemoryWriter.git")(function* (
    orgId: KinOrgId,
    cwd: string,
    args: ReadonlyArray<string>,
    identity: NodeJS.ProcessEnv = {},
    stdin?: string,
  ) {
    const result = yield* io(
      orgId,
      vcs.run({
        ...(stdin === undefined ? {} : { stdin }),
        operation: "MemoryWriter.git",
        command: "git",
        cwd,
        args: ["-c", "core.hooksPath=/dev/null", ...args],
        env: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", ...identity },
      }),
    );
    return result.stdout.trim();
  });
  const session = Effect.fn("MemoryWriter.session")(function* (orgId: KinOrgId, wakeupId: string) {
    const ctx = yield* authority.resolve(orgId, wakeupId);
    if (
      ctx.orgId !== orgId ||
      ctx.wakeupId !== wakeupId ||
      !/^[a-zA-Z0-9_-]+$/.test(ctx.agentId) ||
      !/^[a-zA-Z0-9_-]+$/.test(wakeupId)
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
        (current !== `${writer}/${relative}` && result.success.type !== "Directory")
      ) {
        return yield* new MemoryWriteRejected({ reason: "Symlink or invalid ancestor" });
      }
    }
  });
  const validate = Effect.fn("MemoryWriter.validate")(function* (orgId: KinOrgId) {
    const paths = yield* memory.ensureCheckouts(orgId);
    const head = yield* git(orgId, paths.writer, ["rev-parse", "HEAD"]);
    const anchor = `${paths.writer}/../writer-head`;
    const expected = (yield* io(orgId, fs.exists(anchor)))
      ? (yield* io(orgId, fs.readFileString(anchor))).trim()
      : yield* git(orgId, paths.writer, ["rev-parse", "refs/remotes/origin/HEAD"]);
    if (expected !== head)
      return yield* new MemoryCheckoutInvalid({
        orgId,
        operation: "writer",
        reason: "Unrecorded writer HEAD",
      });
    return paths;
  });
  const write = Effect.fn("MemoryWriter.write")(function* (
    orgId: KinOrgId,
    writer: string,
    relative: string,
    text: string,
  ) {
    yield* safePath(orgId, writer, relative, true);
    const target = `${writer}/${relative}`;
    yield* io(
      orgId,
      fs.makeDirectory(target.slice(0, target.lastIndexOf("/")), { recursive: true }),
    );
    yield* io(orgId, fs.writeFileString(target, text));
  });
  const clean = Effect.fn("MemoryWriter.clean")(function* (orgId: KinOrgId, writer: string) {
    yield* git(orgId, writer, ["reset", "--hard", "HEAD"]);
    yield* git(orgId, writer, ["clean", "-fd", "--", ...folders, "journal", "INDEX.md"]);
  });
  const report = (
    orgId: KinOrgId,
    wakeupId: string,
    effect: Effect.Effect<{ commit: string }, Failure>,
  ) =>
    effect.pipe(
      Effect.tapError((error) =>
        error._tag === "MemoryCheckoutInvalid" ||
        error._tag === "MemorySyncConflict" ||
        error._tag === "MemorySecretBlocked"
          ? hooks.notify({ orgId, wakeupId, error })
          : Effect.void,
      ),
    );
  return MemoryWriter.of({
    stage: Effect.fn("MemoryWriter.stage")((orgId, wakeupId, change) =>
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
            return yield* new MemoryWriteRejected({ reason: "Source is not in the current batch" });
          const fm = parsed.frontMatter;
          const folder = fm.kind === "person" ? "people" : `${fm.kind}s`;
          if (!change.path.startsWith(`${folder}/`))
            return yield* new MemoryWriteRejected({ reason: "Kind does not match path" });
          const items = [...(yield* memory.query(orgId, {}))];
          const bodies = new Map<string, string>();
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
              item.status === "open" &&
              item.kind === fm.kind &&
              (item.id === fm.id || item.links.some((link) => fm.links.includes(link))) &&
              item.id !== change.supersedes
            ) {
              const body = bodies.get(item.path) ?? (yield* memory.readItem(orgId, item.id)).body;
              if (body !== parsed.body || item.title !== fm.title)
                return yield* new MemoryConflict({ existingId: item.id });
            }
            if (
              (item.path === change.path && item.id !== fm.id) ||
              (item.id === fm.id && item.path !== change.path)
            )
              return yield* new MemoryWriteRejected({ reason: "Cannot replace a different item" });
          }
          const review =
            fm.review_by ??
            (fm.kind === "decision"
              ? null
              : fm.kind === "commitment" || fm.kind === "deferral"
                ? fm.due
                : DateTime.formatIso(
                    DateTime.makeUnsafe(
                      Date.parse(ctx.startedAt) + (fm.kind === "person" ? 90 : 30) * 86400000,
                    ),
                  ));
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
          const text = render(fields, parsed.body);
          yield* parseFrontMatter(orgId, change.path, text);
          if (superseded) {
            const oldBody =
              bodies.get(superseded.path) ?? (yield* memory.readItem(orgId, superseded.id)).body;
            const { orgId: _org, path: oldPath, duplicate: _duplicate, ...oldFields } = superseded;
            const oldText = render(
              { ...oldFields, status: "superseded", superseded_by: fm.id },
              oldBody,
            );
            yield* write(orgId, writer, oldPath, oldText);
            state.files.set(oldPath, oldText);
          }
          yield* write(orgId, writer, change.path, text);
          state.files.set(change.path, text);
        }),
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
          yield* session(orgId, wakeupId);
          const { writer } = yield* validate(orgId);
          yield* clean(orgId, writer);
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
            return yield* Effect.gen(function* () {
              const subject = `kin(${ctx.agentId}): wake-up ${wakeupId}`;
              const candidates = yield* git(orgId, writer, [
                "log",
                "--format=%H%x00%s",
                "--fixed-strings",
                `--grep=${subject}`,
              ]);
              const prior = candidates
                .split("\n")
                .map((line) => line.split("\0"))
                .find(([, title]) => title === subject)?.[0];
              const fingerprint = yield* git(
                orgId,
                writer,
                ["hash-object", "--stdin"],
                {},
                stringify({
                  outcome,
                  files: [...state.files].sort(([a], [b]) => a.localeCompare(b)),
                  lines: state.lines,
                }),
              );
              if (prior) {
                const body = yield* git(orgId, writer, [
                  "show",
                  "--format=%B",
                  "--no-patch",
                  prior,
                ]);
                if (
                  !body.includes(`Kin-Outcome: ${outcome}`) ||
                  (state.files.size + state.lines.length > 0 &&
                    !body.includes(`Kin-Request: ${fingerprint}`))
                )
                  return yield* new MemoryWriteRejected({
                    reason: "not_allowed: different wake-up retry",
                  });
                yield* clean(orgId, writer);
                return { commit: prior };
              }
              const defaultRef = yield* git(orgId, writer, [
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
              ]);
              const branch =
                ctx.level === "L0"
                  ? `kin/shadow/${ctx.agentId}`
                  : defaultRef.replace("refs/remotes/origin/", "");
              const current = yield* git(orgId, writer, ["branch", "--show-current"]);
              if (current !== branch) {
                if (yield* git(orgId, writer, ["status", "--porcelain"])) {
                  yield* clean(orgId, writer);
                }
                const exists = yield* git(orgId, writer, [
                  "show-ref",
                  "--verify",
                  `refs/heads/${branch}`,
                ]).pipe(Effect.result);
                yield* git(
                  orgId,
                  writer,
                  exists._tag === "Success" ? ["switch", "--", branch] : ["switch", "-c", branch],
                );
                yield* io(
                  orgId,
                  fs.writeFileString(
                    `${writer}/../writer-head`,
                    yield* git(orgId, writer, ["rev-parse", "HEAD"]),
                  ),
                );
                for (const [file, text] of state.files) yield* write(orgId, writer, file, text);
              }
              if (outcome === "failed") {
                yield* clean(orgId, writer);
                state.files.clear();
              }
              const entry = journalEntry(ctx, outcome, state.lines);
              yield* safePath(orgId, writer, entry.path);
              const old = (yield* io(orgId, fs.exists(`${writer}/${entry.path}`)))
                ? yield* io(orgId, fs.readFileString(`${writer}/${entry.path}`))
                : "";
              state.files.set(entry.path, old + entry.text);
              yield* write(orgId, writer, entry.path, old + entry.text);
              if (outcome === "completed") {
                const index = yield* hooks.buildIndex({ orgId, writer });
                if (index !== null) {
                  yield* write(orgId, writer, "INDEX.md", index);
                  state.files.set("INDEX.md", index);
                }
              }
              const findings: ReadonlyArray<SecretFinding> = yield* scanner.scan({
                orgId,
                files: [...state.files].map(([path, content]) => ({
                  path,
                  content: new TextEncoder().encode(content),
                })),
              });
              if (findings.length) return yield* new MemorySecretBlocked({ orgId, findings });
              // Commit only the server's reconstructed files, never ambient index entries or edits.
              yield* clean(orgId, writer);
              for (const [file, text] of state.files) yield* write(orgId, writer, file, text);
              yield* git(orgId, writer, ["add", "--", ...state.files.keys()]);
              const name = yield* git(orgId, writer, ["config", "--get", "user.name"]);
              const email = yield* git(orgId, writer, ["config", "--get", "user.email"]);
              if (!name || !email)
                return yield* new MemoryWriteRejected({
                  reason: "Server bot identity is required",
                });
              yield* git(
                orgId,
                writer,
                [
                  "-c",
                  `user.name=${name}`,
                  "-c",
                  `user.email=${email}`,
                  "-c",
                  `committer.name=${name}`,
                  "-c",
                  `committer.email=${email}`,
                  "commit",
                  `--author=${name} <${email}>`,
                  "-m",
                  subject,
                  "-m",
                  `Events: ${ctx.eventIds.join(", ")}\nKin-Outcome: ${outcome}\nKin-Request: ${fingerprint}`,
                ],
                {
                  GIT_AUTHOR_NAME: name,
                  GIT_AUTHOR_EMAIL: email,
                  GIT_COMMITTER_NAME: name,
                  GIT_COMMITTER_EMAIL: email,
                },
              );
              const record = Effect.fn("MemoryWriter.record")(function* () {
                const head = yield* git(orgId, writer, ["rev-parse", "HEAD"]);
                yield* io(orgId, fs.writeFileString(`${writer}/../writer-head`, head));
                return head;
              });
              yield* record();
              yield* git(orgId, writer, [
                "push",
                "--set-upstream",
                "--",
                "origin",
                `HEAD:refs/heads/${branch}`,
              ]).pipe(
                Effect.catch((pushError) =>
                  Effect.gen(function* () {
                    yield* git(orgId, writer, ["fetch", "origin"]);
                    const remote = yield* git(orgId, writer, [
                      "show-ref",
                      "--verify",
                      `refs/remotes/origin/${branch}`,
                    ]).pipe(Effect.result);
                    if (remote._tag === "Success")
                      yield* git(orgId, writer, ["rebase", `refs/remotes/origin/${branch}`]).pipe(
                        Effect.catch((cause) =>
                          Effect.gen(function* () {
                            yield* git(orgId, writer, ["rebase", "--abort"]);
                            return yield* new MemorySyncConflict({
                              orgId,
                              operation: "push",
                              reason: "Rebase conflicted; writer restored",
                              cause,
                            });
                          }),
                        ),
                      );
                    yield* record();
                    return yield* pushError;
                  }),
                ),
                Effect.retry({
                  schedule: Schedule.exponential("100 millis"),
                  times: 2,
                  while: (error) => error._tag !== "MemorySyncConflict",
                }),
              );
              return { commit: yield* record() };
            }).pipe(
              Effect.onError(() => clean(orgId, writer).pipe(Effect.orDie)),
              Effect.ensuring(Effect.sync(() => sessions.delete(orgId))),
            );
          }),
        ),
      ),
    ),
  });
});
export const layer = Layer.effect(MemoryWriter, make);
