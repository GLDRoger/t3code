// @effect-diagnostics nodeBuiltinImport:off -- the isolated reader process is an external runtime boundary.
import * as NodeBuffer from "node:buffer";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { limitedCommand } from "../../gendocs/render.ts";
import type { FileOutcome } from "./statementFiles.ts";

/**
 * Reads a statement file in a process of its own. Not a worker thread: the desktop server runs
 * from app.asar, which workers can't load from, and pdf.js decodes streams into buffers outside
 * the JS heap, which only a separate process bounds. The parent watches the reader's resident
 * memory itself on every platform; Linux adds a systemd scope or an address-space limit.
 */

export type ReaderLimits = {
  readonly heapMb: number;
  readonly timeoutMs: number;
  /** Resident memory past which the parent kills the reader. */
  readonly residentMb: number;
  /** Off only in tests, to prove the parent's own bound holds without the reader's stream check. */
  readonly precheck?: boolean;
};
// Measured on invented statements: a 300-page, 9,000-row PDF and a 20,000-row CSV each read in
// under a second, under 300 MB resident. The caps leave room for real banks' PDFs, with their
// embedded fonts, on a slow machine; two readers at once stay near 2 GB.
export const READER_LIMITS: ReaderLimits = { heapMb: 512, timeoutMs: 30_000, residentMb: 1024 };
const SAMPLE_MS = 250;
const CPU_SECONDS = 60;
// Only where no systemd scope holds it: V8 and the allocator reserve far more than they touch.
const ADDRESS_SPACE_KIB = 8 * 1024 * 1024;
// 20,000 rows of 500-character narrations is under 16 MB of JSON; a PDF's page text about as much again.
const OUTPUT_BYTES = 40 * 1024 * 1024;

const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));
const Minor = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(-Number.MAX_SAFE_INTEGER),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Short = Schema.String.check(Schema.isMaxLength(200));
/** The statement exactly as `statementTable.ts` makes it, bounded: nothing else is taken back. */
const StatementOut = Schema.Struct({
  kind: Schema.Literals(["account", "card"]),
  bank: Schema.NullOr(Short),
  account: Schema.NullOr(Short),
  currency: Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/)),
  from: Schema.NullOr(Day),
  to: Schema.NullOr(Day),
  openingMinor: Schema.NullOr(Minor),
  closingMinor: Schema.NullOr(Minor),
  rows: Schema.Array(
    Schema.Struct({
      index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      date: Day,
      description: Schema.String.check(Schema.isMaxLength(500)),
      reference: Schema.NullOr(Schema.String.check(Schema.isMaxLength(120))),
      amountMinor: Minor,
      direction: Schema.Literals(["debit", "credit"]),
      balanceMinor: Schema.NullOr(Minor),
      foreign: Schema.NullOr(
        Schema.Struct({ currency: Schema.String.check(Schema.isMaxLength(8)), amountMinor: Minor }),
      ),
    }),
  ).check(Schema.isMaxLength(20_000)),
  check: Schema.Struct({
    status: Schema.Literals(["adds_up", "off", "unchecked"]),
    line: Schema.String.check(Schema.isMaxLength(1_000)),
  }),
});
const Reason = Schema.String.check(Schema.isMaxLength(1_000));
// 300 pages of a dense statement's text is a few megabytes; a page past this is not a statement's.
const Pages = Schema.Array(
  Schema.Struct({
    text: Schema.String.check(Schema.isMaxLength(60_000)),
    dated: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
).check(Schema.isMaxLength(300));
const { rows: _rows, check: _check, currency: _currency, ...factFields } = StatementOut.fields;
const Outcome = Schema.Union([
  Schema.TaggedStruct("read", {
    statement: StatementOut,
    format: Schema.Literals(["csv", "xlsx", "xls", "html", "pdf"]),
    pages: Schema.optional(Pages),
  }),
  Schema.TaggedStruct("pages", { pages: Pages, facts: Schema.Struct(factFields) }),
  Schema.TaggedStruct("needs_password", {}),
  Schema.TaggedStruct("wrong_password", {}),
  Schema.TaggedStruct("scanned", { pages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
  Schema.TaggedStruct("unreadable", { reason: Reason }),
]);
const decodeOutcome = Schema.decodeUnknownOption(Schema.fromJsonString(Outcome));

const DAMAGED =
  "Kin couldn't read this file; it may be damaged. Send the bank's PDF, CSV or Excel download again.";
export const TOO_LARGE =
  "Kin couldn't read this file: it is too large to read safely. Send a shorter period, or the bank's CSV or Excel download.";
const failed = (reason: string): FileOutcome => ({ _tag: "unreadable", reason });

/** Why the parent stopped a reader, when it did. */
export type Stopped = "memory" | "time" | "output";
export type ReaderRun = {
  readonly outcome: FileOutcome;
  readonly stopped: Stopped | undefined;
  /** The highest resident memory the parent sampled, in KiB; 0 where it can't sample. */
  readonly peakKib: number;
};

type Ended = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly heapExhausted: boolean;
  readonly stopped: Stopped | undefined;
  readonly peakKib: number;
};

/** A process's resident memory in KiB, by its PID, or undefined once it is gone. */
const residentKib = (platform: NodeJS.Platform, pid: number) =>
  new Promise<number | undefined>((resolve) => {
    if (platform === "linux")
      return NodeFS.readFile(`/proc/${pid}/status`, "utf8", (error, text) =>
        resolve(error ? undefined : Number(/^VmRSS:\s+(\d+)/m.exec(text)?.[1] ?? Number.NaN)),
      );
    if (platform === "win32") return resolve(undefined);
    NodeChildProcess.execFile(
      "/bin/ps",
      ["-o", "rss=", "-p", String(pid)],
      { timeout: 2_000, windowsHide: true },
      (error, stdout) => resolve(error ? undefined : Number(stdout.trim())),
    );
  });

/** What Node, or Electron run as Node, needs to start: nothing of the server's own secrets. */
const readerEnv = (environment: NodeJS.ProcessEnv, temp: string, heapMb: number) => {
  const kept = (name: string) => {
    const value = environment[name];
    return value === undefined ? {} : { [name]: value };
  };
  return {
    ...kept("PATH"),
    ...kept("SystemRoot"),
    ...kept("windir"),
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_OPTIONS: `--max-old-space-size=${heapMb}`,
  };
};

// Two reads at once at most, so a burst of statements can't take the machine's memory.
const readers = Semaphore.makeUnsafe(2);

// In a bundle import.meta.url is a chunk beside bin.mjs; development and tests use the source.
const entry = NodeURL.fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "../../../bin.ts" : "./bin.mjs", import.meta.url),
);

/** One read in its own process, with why it was stopped and the most memory it was seen using. */
export const runReader = Effect.fn("KinStatements.runReader")(
  function* (
    bytes: Uint8Array,
    password?: Redacted.Redacted<string>,
    limits: ReaderLimits = READER_LIMITS,
  ) {
    const executable = yield* HostProcess.ExecutablePath;
    const isExecutable = yield* HostProcess.IsExecutable;
    const environment = yield* HostProcess.Environment;
    const platform = yield* HostProcess.Platform;
    const scopes = yield* AgentScope;
    const temp = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-statement-"))),
      (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
    );
    const env = readerEnv(environment, temp, limits.heapMb);
    const args = [
      ...(isExecutable ? [] : [entry]),
      "__kin-statement",
      ...(limits.precheck === false ? ["--no-precheck"] : []),
    ];
    const scoped =
      platform === "win32"
        ? { command: executable, args, unit: undefined }
        : yield* scopes.wrap({
            command: executable,
            args,
            name: "kin-statement",
            env,
            properties: [`MemoryMax=${limits.residentMb}M`, "MemorySwapMax=0", "TasksMax=64"],
          });
    const command =
      platform === "win32"
        ? scoped
        : limitedCommand(scoped.command, scoped.args, {
            cpuSeconds: CPU_SECONDS,
            addressSpaceKiB:
              scoped.unit === undefined && platform === "linux" ? ADDRESS_SPACE_KIB : undefined,
          });
    const finished = yield* Effect.callback<Ended>((resume, signal) => {
      const child = NodeChildProcess.spawn(command.command, [...command.args], {
        cwd: temp,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env,
      });
      let stopped: Stopped | undefined;
      let peakKib = 0;
      const stop = (why: Stopped) => {
        stopped ??= why;
        child.kill("SIGKILL");
      };
      // Interrupted at the time limit or by its caller, the reader is killed at once.
      signal.addEventListener("abort", () => stop("time"));
      let sampling = false;
      // @effect-diagnostics-next-line globalTimersInEffect:off -- a plain callback around a Node child, outside any fiber.
      const watch = setInterval(() => {
        if (sampling || child.pid === undefined) return;
        sampling = true;
        void residentKib(platform, child.pid).then((kib) => {
          sampling = false;
          if (kib === undefined || !Number.isFinite(kib)) return;
          peakKib = Math.max(peakKib, kib);
          if (kib > limits.residentMb * 1024) stop("memory");
        });
      }, SAMPLE_MS);
      const stdout: Array<NodeBuffer.Buffer> = [];
      let size = 0;
      let stderr = "";
      child.stdout.on("data", (chunk: NodeBuffer.Buffer) => {
        size += chunk.byteLength;
        if (size > OUTPUT_BYTES) stop("output");
        else stdout.push(chunk);
      });
      // Only enough of stderr to tell a heap exhausted; it is never logged.
      child.stderr.on("data", (chunk: NodeBuffer.Buffer) => {
        if (stderr.length < 16_384) stderr += chunk.toString("utf8");
      });
      child.stdin.on("error", () => undefined);
      let done = false;
      const ended = (code: number | null, exit: NodeJS.Signals | null) => {
        if (done) return;
        done = true;
        clearInterval(watch);
        resume(
          Effect.succeed({
            code,
            signal: exit,
            stdout: stopped === undefined ? NodeBuffer.Buffer.concat(stdout).toString("utf8") : "",
            heapExhausted: /heap out of memory|Allocation failed/i.test(stderr),
            stopped,
            peakKib,
          }),
        );
      };
      child.on("error", () => ended(null, null));
      child.on("close", ended);
      const secret = NodeBuffer.Buffer.from(
        password === undefined ? "" : Redacted.value(password),
        "utf8",
      );
      const head = NodeBuffer.Buffer.alloc(4 + secret.byteLength);
      head.writeUInt32LE(secret.byteLength, 0);
      secret.copy(head, 4);
      secret.fill(0);
      // A pipe write may hold the buffer until it drains, so it is wiped once the pipe closes.
      child.stdin.once("close", () => head.fill(0));
      child.stdin.write(head);
      child.stdin.end(bytes);
    }).pipe(
      Effect.timeoutOption(Duration.millis(limits.timeoutMs)),
      Effect.ensuring(scoped.unit === undefined ? Effect.void : scopes.stop(scoped.unit)),
    );
    if (Option.isNone(finished))
      return {
        outcome: failed(
          `Kin stopped reading this file after ${Math.round(limits.timeoutMs / 1000)} seconds: it is too complex to read safely. Send a shorter period, or the bank's CSV or Excel download.`,
        ),
        stopped: "time",
        peakKib: 0,
      } satisfies ReaderRun;
    const ended = finished.value;
    const run = (outcome: FileOutcome): ReaderRun => ({
      outcome,
      stopped: ended.stopped,
      peakKib: ended.peakKib,
    });
    // A kill nobody here sent is the kernel's: a scope's memory limit or the address-space cap.
    if (
      ended.stopped === "memory" ||
      ended.stopped === "output" ||
      ended.heapExhausted ||
      (ended.stopped === undefined && ended.signal === "SIGKILL")
    )
      return run(failed(TOO_LARGE));
    if (ended.code !== 0) return run(failed(DAMAGED));
    return run(
      Option.match(decodeOutcome(ended.stdout), {
        onNone: () => failed(DAMAGED),
        onSome: (outcome): FileOutcome => outcome,
      }),
    );
  },
  Effect.scoped,
  readers.withPermits(1),
);

export const readIsolated = (
  bytes: Uint8Array,
  password?: Redacted.Redacted<string>,
  limits: ReaderLimits = READER_LIMITS,
) => Effect.map(runReader(bytes, password, limits), (run) => run.outcome);
