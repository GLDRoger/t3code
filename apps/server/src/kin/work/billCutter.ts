// @effect-diagnostics nodeBuiltinImport:off -- the raster decoder is a separate OS process.
import * as NodeBuffer from "node:buffer";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeV8 from "node:v8";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import {
  BILL_CUTTER_OUTPUT_BYTES,
  BILL_CUTTER_TIMEOUT_MS,
  MAX_BILL_BOXES,
  refuseBillPage,
  type BillCutterReply,
  type BillPageInput,
} from "./billCutterProtocol.ts";

const pages = Semaphore.makeUnsafe(1);
const entry = NodeURL.fileURLToPath(
  new URL(import.meta.url.endsWith(".ts") ? "../../bin.ts" : "./bin.mjs", import.meta.url),
);

type BillCutterRun = BillCutterReply & { readonly signal: NodeJS.Signals | null };

const failed = (reason: Parameters<typeof refuseBillPage>[0], signal: NodeJS.Signals | null) => ({
  outcome: refuseBillPage(reason),
  peakKib: 0,
  signal,
});

export const cutBillPage = Effect.fn("KinBills.cutBillPage")(function* (
  input: BillPageInput,
  { timeoutMs = BILL_CUTTER_TIMEOUT_MS }: { readonly timeoutMs?: number } = {},
) {
  const executable = yield* HostProcess.ExecutablePath;
  const isExecutable = yield* HostProcess.IsExecutable;
  const environment = yield* HostProcess.Environment;
  const { bytes, ...page } = input;
  if (page.boxes.length > MAX_BILL_BOXES) return failed("box", null);
  return yield* Effect.callback<BillCutterRun>((resume) => {
    // @effect-diagnostics-next-line globalJsonInEffect:off -- The worker arguments only contain page numbers and boxes.
    const args = [...(isExecutable ? [] : [entry]), "__kin-bill-cutter", JSON.stringify(page)];
    const child = NodeChildProcess.spawn(executable, args, {
      env: {
        PATH: environment.PATH,
        SystemRoot: environment.SystemRoot,
        windir: environment.windir,
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let timedOut = false;
    // @effect-diagnostics-next-line globalTimersInEffect:off -- The deadline kills and reaps the OS process even under TestClock.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const chunks: Array<NodeBuffer.Buffer> = [];
    let length = 0;
    const closed = new Promise<void>((resolve) => {
      child.on("error", () => undefined);
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve();
        if (timedOut) return resume(Effect.succeed(failed("time", signal)));
        if (code !== 0 || length > BILL_CUTTER_OUTPUT_BYTES)
          return resume(Effect.succeed(failed("damaged", signal)));
        try {
          const reply = NodeV8.deserialize(
            NodeBuffer.Buffer.concat(chunks, length),
          ) as BillCutterReply;
          resume(Effect.succeed({ ...reply, signal }));
        } catch {
          resume(Effect.succeed(failed("damaged", signal)));
        }
      });
    });
    child.stdout.on("data", (chunk: NodeBuffer.Buffer) => {
      length += chunk.byteLength;
      if (length > BILL_CUTTER_OUTPUT_BYTES) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(bytes);
    return Effect.promise(() => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      return closed;
    });
  });
}, pages.withPermit);
