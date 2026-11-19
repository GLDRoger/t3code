// @effect-diagnostics nodeBuiltinImport:off globalDate:off - preloaded into a look book instance's processes.
/**
 * A look book instance starts at a fixed moment with repeatable ids, so the same commit draws the
 * same pixels: dates on screen, and the pebbles drawn from agent, person and chat ids.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

export interface Freeze {
  /** The moment the instance's clock reads when the capture starts. */
  readonly epoch: number;
  /** The real time the capture started; every process measures from it. */
  readonly origin: number;
  /** A file counting each kind of process's starts, so a restarted server makes new ids. */
  readonly starts: string;
}

const ENV = {
  epoch: "KIN_LOOKBOOK_EPOCH",
  origin: "KIN_LOOKBOOK_ORIGIN",
  starts: "KIN_LOOKBOOK_STARTS",
} as const;

export const freezeEnv = (freeze: Freeze): Record<string, string> => ({
  [ENV.epoch]: String(freeze.epoch),
  [ENV.origin]: String(freeze.origin),
  [ENV.starts]: freeze.starts,
});

export function freezeFromEnv(env: NodeJS.ProcessEnv = process.env): Freeze | undefined {
  const epoch = Number(env[ENV.epoch]);
  const origin = Number(env[ENV.origin]);
  const starts = env[ENV.starts];
  if (!Number.isFinite(epoch) || !Number.isFinite(origin) || starts === undefined) return undefined;
  return { epoch, origin, starts };
}

/** Date starts at the fixed moment and runs at full speed, so Kin's own waits still pass. */
function installClock(freeze: Freeze) {
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  const now = () => freeze.epoch + (realNow() - freeze.origin);
  globalThis.Date = new Proxy(RealDate, {
    construct: (target, args, newTarget) =>
      args.length === 0 ? new target(now()) : Reflect.construct(target, args, newTarget),
    apply: () => new RealDate(now()).toString(),
    get: (target, key, receiver) => (key === "now" ? now : Reflect.get(target, key, receiver)),
  });
}

/**
 * The source file, under `marker`, that asked for randomness: ids made in the same file come out
 * in the same order every run, whatever other files ask meanwhile. Anything else stays random.
 */
function siteOf(marker: string): string | undefined {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = limit;
  for (const line of stack.split("\n").slice(1)) {
    const file = /(?:\(|at )(?:file:\/\/)?(\/[^():]+):\d+:\d+\)?$/.exec(line.trim())?.[1];
    if (file === undefined || file.includes("node_modules") || file.includes("/kin-lookbook/"))
      continue;
    const at = file.indexOf(marker);
    if (at >= 0) return file.slice(at + marker.length);
  }
  return undefined;
}

export function repeatableBytes(seed: string) {
  const counters = new Map<string, number>();
  return (site: string, size: number): Buffer => {
    const count = counters.get(site) ?? 0;
    counters.set(site, count + 1);
    const out: Array<Buffer> = [];
    for (let block = 0; out.length * 32 < size; block++)
      out.push(
        NodeCrypto.createHash("sha256").update(`${seed}|${site}|${count}|${block}`).digest(),
      );
    return Buffer.concat(out).subarray(0, size);
  };
}

export function uuidOf(bytes: Uint8Array): string {
  const b = Buffer.from(bytes.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** This process's kind (its command word, not its paths or flags) and how many came before. */
function startOf(file: string): string {
  const kind =
    process.argv.slice(2).find((arg) => !arg.startsWith("-") && !arg.includes("/")) ?? "";
  let counts: Record<string, number> = {};
  try {
    counts = JSON.parse(NodeFS.readFileSync(file, "utf8")) as Record<string, number>;
  } catch {}
  const count = (counts[kind] ?? 0) + 1;
  NodeFS.writeFileSync(file, JSON.stringify({ ...counts, [kind]: count }));
  return `${kind}#${count}`;
}

function installIds(freeze: Freeze, marker: string) {
  const next = repeatableBytes(`kin-lookbook|${startOf(freeze.starts)}`);
  const web = globalThis.crypto;
  const realFill = web.getRandomValues.bind(web) as (array: ArrayBufferView) => ArrayBufferView;
  const realWebUuid = web.randomUUID.bind(web);
  Object.defineProperty(web, "getRandomValues", {
    configurable: true,
    value: (array: ArrayBufferView) => {
      const site = siteOf(marker);
      if (site === undefined) return realFill(array);
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(
        next(site, array.byteLength),
      );
      return array;
    },
  });
  Object.defineProperty(web, "randomUUID", {
    configurable: true,
    value: () => {
      const site = siteOf(marker);
      return site === undefined ? realWebUuid() : uuidOf(next(site, 16));
    },
  });
  const nodeCrypto = NodeModule.createRequire(import.meta.url)("node:crypto") as {
    randomUUID: typeof NodeCrypto.randomUUID;
    randomBytes: typeof NodeCrypto.randomBytes;
  };
  const realUuid = nodeCrypto.randomUUID;
  const realBytes = nodeCrypto.randomBytes;
  nodeCrypto.randomUUID = (options) => {
    const site = siteOf(marker);
    return site === undefined
      ? realUuid(options)
      : (uuidOf(next(site, 16)) as `${string}-${string}-${string}-${string}-${string}`);
  };
  nodeCrypto.randomBytes = ((size: number, callback?: unknown) => {
    const site = callback === undefined ? siteOf(marker) : undefined;
    if (site === undefined)
      return (realBytes as (size: number, callback?: unknown) => Buffer)(size, callback);
    return next(site, size);
  }) as typeof NodeCrypto.randomBytes;
  NodeModule.syncBuiltinESMExports();
}

/** Freezes this process: its clock, and the ids made by source files under `marker`. */
export function install(freeze: Freeze, marker: string) {
  installClock(freeze);
  installIds(freeze, marker.endsWith(NodePath.sep) ? marker : `${marker}${NodePath.sep}`);
}
