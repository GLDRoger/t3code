// @effect-diagnostics nodeBuiltinImport:off -- the isolated reader process is an external runtime boundary.
import * as NodeBuffer from "node:buffer";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HostProcess from "@t3tools/shared/HostProcess";

import type { FileOutcome } from "./statementFiles.ts";
import type { Statement } from "./statementTable.ts";

/**
 * Reads a statement file in a process of its own, with a capped heap and a time limit. Not a
 * worker thread: the desktop server runs from app.asar, which workers can't load from, and
 * pdf.js keeps its buffers off the heap, which only a separate process bounds.
 */

export type ReaderLimits = { readonly heapMb: number; readonly timeoutMs: number };
// Measured on invented statements: a 300-page, 9,000-row PDF and a 20,000-row CSV each read in
// under a second within a 64 MB heap (under 290 MB resident). The caps leave room for real
// banks' PDFs, with their embedded fonts, on a slow machine.
const READER_LIMITS: ReaderLimits = { heapMb: 512, timeoutMs: 30_000 };
const OUTPUT_BYTES = 64 * 1024 * 1024;

const Outcome = Schema.Union([
  Schema.TaggedStruct("read", {
    statement: Schema.Unknown,
    format: Schema.Literals(["csv", "xlsx", "xls", "html", "pdf"]),
  }),
  Schema.TaggedStruct("needs_password", {}),
  Schema.TaggedStruct("wrong_password", {}),
  Schema.TaggedStruct("scanned", { pages: Schema.Number }),
  Schema.TaggedStruct("unreadable", { reason: Schema.String }),
]);
const decodeOutcome = Schema.decodeUnknownOption(Schema.fromJsonString(Outcome));

const DAMAGED =
  "Kin couldn't read this file; it may be damaged. Send the bank's PDF, CSV or Excel download again.";
const failed = (reason: string): FileOutcome => ({ _tag: "unreadable", reason });

type Ended = {
  readonly code: number | null;
  readonly stdout: string;
  readonly outOfMemory: boolean;
  readonly overflow: boolean;
};

// Two reads at once at most, so a burst of statements can't take the machine's memory.
const readers = Semaphore.makeUnsafe(2);

// In a bundle import.meta.url is a chunk beside bin.mjs; development and tests use the source.
const entry = NodeURL.fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "../../../bin.ts" : "./bin.mjs", import.meta.url),
);

export const readIsolated = Effect.fn("KinStatements.readIsolated")(function* (
  bytes: Uint8Array,
  password?: Redacted.Redacted<string>,
  limits: ReaderLimits = READER_LIMITS,
) {
  const executable = yield* HostProcess.ExecutablePath;
  const isExecutable = yield* HostProcess.IsExecutable;
  const environment = yield* HostProcess.Environment;
  const finished = yield* Effect.callback<Ended>((resume, signal) => {
    const child = NodeChildProcess.spawn(
      executable,
      [...(isExecutable ? [] : [entry]), "__kin-statement"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...environment,
          ELECTRON_RUN_AS_NODE: "1",
          NODE_OPTIONS: `${environment.NODE_OPTIONS ?? ""} --max-old-space-size=${limits.heapMb}`,
        },
      },
    );
    // Interrupted at the time limit or by its caller, the reader is killed at once.
    signal.addEventListener("abort", () => child.kill("SIGKILL"));
    const stdout: Array<NodeBuffer.Buffer> = [];
    let size = 0;
    let overflow = false;
    let stderr = "";
    child.stdout.on("data", (chunk: NodeBuffer.Buffer) => {
      size += chunk.byteLength;
      if (size > OUTPUT_BYTES) {
        overflow = true;
        child.kill("SIGKILL");
      } else stdout.push(chunk);
    });
    // Only enough of stderr to tell a heap exhausted; it is never logged.
    child.stderr.on("data", (chunk: NodeBuffer.Buffer) => {
      if (stderr.length < 16_384) stderr += chunk.toString("utf8");
    });
    child.stdin.on("error", () => undefined);
    child.on("error", () =>
      resume(Effect.succeed({ code: null, stdout: "", outOfMemory: false, overflow: false })),
    );
    child.on("close", (code) =>
      resume(
        Effect.succeed({
          code,
          stdout: NodeBuffer.Buffer.concat(stdout).toString("utf8"),
          outOfMemory: /heap out of memory|Allocation failed/i.test(stderr),
          overflow,
        }),
      ),
    );
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
  }).pipe(Effect.timeoutOption(Duration.millis(limits.timeoutMs)));
  if (Option.isNone(finished))
    return failed(
      `Kin stopped reading this file after ${Math.round(limits.timeoutMs / 1000)} seconds: it is too complex to read safely. Send a shorter period, or the bank's CSV or Excel download.`,
    );
  const ended = finished.value;
  if (ended.outOfMemory || ended.overflow)
    return failed(
      "Reading this file needed more memory than Kin gives one statement. Send a shorter period, or the bank's CSV or Excel download.",
    );
  if (ended.code !== 0) return failed(DAMAGED);
  return Option.match(decodeOutcome(ended.stdout), {
    onNone: () => failed(DAMAGED),
    onSome: (outcome): FileOutcome =>
      outcome._tag === "read" ? { ...outcome, statement: outcome.statement as Statement } : outcome,
  });
}, readers.withPermits(1));
