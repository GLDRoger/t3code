// @effect-diagnostics nodeBuiltinImport:off -- a process group is signalled by number, which Effect's process API can't name.
import * as NodeChildProcess from "node:child_process";
import * as NodeDiagnosticsChannel from "node:diagnostics_channel";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Predicate from "effect/Predicate";

import { runCapped } from "../gendocs/render.ts";

// Linux, no root: setpriv's Landlock (read the system and the browser, write one folder, no home)
// and seccomp (no socket, no leaving the group) hold every process, so Chrome's sandbox, which
// needs the namespaces Ubuntu's AppArmor withholds, stays off. Children can't drop either. Signals
// aren't filtered: a compromised browser could signal the Kin user's other processes.

const SETPRIV_PATHS = ["/usr/bin/setpriv", "/bin/setpriv"] as const;

const AUDIT_ARCH = { x64: 0xc000003e, arm64: 0xc00000b7 } as const;
/** socket, setsid, setpgid, ptrace, process_vm_readv, process_vm_writev, io_uring_setup. */
const DENIED_SYSCALLS = {
  x64: [41, 112, 109, 101, 310, 311, 425],
  arm64: [198, 157, 154, 117, 270, 271, 425],
} as const;
const X32_SYSCALL_BIT = 0x40000000;

const BPF_LD_W_ABS = 0x20;
const BPF_JEQ_K = 0x15;
const BPF_JGE_K = 0x35;
const BPF_RET_K = 0x06;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ERRNO = 0x00050000;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const EPERM = 1;
const SECCOMP_DATA_NR = 0;
const SECCOMP_DATA_ARCH = 4;

export type ConfinedArch = keyof typeof AUDIT_ARCH;

export const confinedArch = (arch: NodeJS.Architecture): ConfinedArch | undefined =>
  arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : undefined;

/**
 * A classic BPF program for `setpriv --seccomp-filter`: another architecture's calls kill the
 * process, and the denied calls fail with EPERM. Pipes and socket pairs Chrome inherits still work.
 */
export const networkFilter = (arch: ConfinedArch): Uint8Array => {
  const denied = DENIED_SYSCALLS[arch];
  type Op = { code: number; k: number; deny?: true; jt?: number };
  const ops: Array<Op> = [
    { code: BPF_LD_W_ABS, k: SECCOMP_DATA_ARCH },
    { code: BPF_JEQ_K, k: AUDIT_ARCH[arch], jt: 1 },
    { code: BPF_RET_K, k: SECCOMP_RET_KILL_PROCESS },
    { code: BPF_LD_W_ABS, k: SECCOMP_DATA_NR },
    // x32 calls share the x86-64 architecture word and would bypass every number below.
    ...(arch === "x64" ? [{ code: BPF_JGE_K, k: X32_SYSCALL_BIT, deny: true as const }] : []),
    ...denied.map((nr) => ({ code: BPF_JEQ_K, k: nr, deny: true as const })),
    { code: BPF_RET_K, k: SECCOMP_RET_ALLOW },
    { code: BPF_RET_K, k: SECCOMP_RET_ERRNO | EPERM },
  ];
  const deny = ops.length - 1;
  const bytes = new Uint8Array(ops.length * 8);
  const view = new DataView(bytes.buffer);
  ops.forEach((op, index) => {
    const at = index * 8;
    view.setUint16(at, op.code, true);
    // A denied call jumps to the last line; the architecture check jumps over the kill.
    view.setUint8(at + 2, op.deny === true ? deny - index - 1 : (op.jt ?? 0));
    view.setUint8(at + 3, 0);
    view.setUint32(at + 4, op.k >>> 0, true);
  });
  return bytes;
};

const READ = "read-file,read-dir";
const RUN = "execute,read-file,read-dir";
const WRITE =
  "read-file,read-dir,write-file,remove-dir,remove-file,make-dir,make-reg,make-sock,make-fifo,make-sym,truncate";
/** What Chrome reads of the system: libraries, its config, and its own process details. */
const SYSTEM_RUN = ["/usr", "/lib", "/lib64", "/bin"];
const SYSTEM_READ = ["/etc", "/proc", "/sys"];

const rule = (access: string, path: string) => [
  "--landlock-rule",
  `path-beneath:${access}:${path}`,
];

/** `setpriv`'s arguments up to the command: every path it grants, and nothing under any home. */
export const confinedArgs = (input: {
  /** System folders that exist here; a missing one would fail the whole launch. */
  readonly system: ReadonlyArray<string>;
  readonly browserDir: string;
  readonly scratch: string;
  readonly filter: string;
}) => [
  "--no-new-privs",
  "--landlock-access",
  "fs",
  ...input.system.flatMap((path) => rule(SYSTEM_READ.includes(path) ? READ : RUN, path)),
  ...rule("read-file", "/dev"),
  ...rule("read-file,write-file", "/dev/null"),
  ...rule(RUN, input.browserDir),
  ...rule(WRITE, input.scratch),
  "--seccomp-filter",
  input.filter,
  "--",
];

export type Confinement =
  | { readonly _tag: "confined"; readonly setpriv: string; readonly system: ReadonlyArray<string> }
  /** macOS and Windows: Chrome's own sandbox holds the page. */
  | { readonly _tag: "sandboxed" }
  | { readonly _tag: "missing"; readonly reason: string };

const SANE_ENV = { PATH: "/usr/bin:/bin" };

/**
 * Whether this host can hold a picture's browser: on Linux, a `setpriv` that applies Landlock and
 * seccomp, and a kernel that enforces Landlock (a file outside the grant can't be read).
 */
export const probeConfinement = Effect.fn("KinPictureConfine.probe")(function* (input: {
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly scratch: string;
}) {
  if (input.platform !== "linux") return { _tag: "sandboxed" } satisfies Confinement;
  const arch = confinedArch(input.arch);
  if (arch === undefined)
    return {
      _tag: "missing",
      reason: `no filter is written for ${input.arch}`,
    } satisfies Confinement;
  const fs = yield* FileSystem.FileSystem;
  const found = yield* Effect.findFirst(SETPRIV_PATHS, (path) =>
    fs.exists(path).pipe(Effect.orElseSucceed(() => false)),
  );
  if (found._tag === "None")
    return {
      _tag: "missing",
      reason: "util-linux setpriv isn't installed",
    } satisfies Confinement;
  const setpriv = found.value;
  const system = yield* Effect.filter([...SYSTEM_RUN, ...SYSTEM_READ], (path) =>
    fs.exists(path).pipe(Effect.orElseSucceed(() => false)),
  );
  const inside = `${input.scratch}/inside`;
  const outside = `${input.scratch}-outside`;
  const filter = `${input.scratch}/filter.bpf`;
  yield* fs.makeDirectory(inside, { recursive: true });
  yield* fs.writeFileString(outside, "x");
  yield* fs.writeFile(filter, networkFilter(arch));
  const run = yield* runCapped({
    command: setpriv,
    args: [
      "--no-new-privs",
      "--landlock-access",
      "fs",
      ...system.flatMap((path) => rule(RUN, path)),
      ...rule(READ, inside),
      "--seccomp-filter",
      filter,
      "--",
      "/bin/sh",
      "-c",
      'cat "$1" 2>/dev/null && exit 3; exit 0',
      "kin-probe",
      outside,
    ],
    env: SANE_ENV,
    cwd: inside,
    timeoutMs: 10_000,
    maxStdout: 1024,
  }).pipe(Effect.ensuring(fs.remove(outside, { force: true }).pipe(Effect.ignore)));
  if (run._tag !== "exited" || run.code !== 0)
    return {
      _tag: "missing",
      reason:
        run._tag === "exited" && run.code === 3
          ? "this kernel doesn't enforce Landlock"
          : `setpriv can't apply Landlock here${run._tag === "exited" && run.stderr !== "" ? ` (${run.stderr.trim().slice(0, 200)})` : ""}`,
    } satisfies Confinement;
  return { _tag: "confined", setpriv, system } satisfies Confinement;
});

/**
 * Ends everything a confined launch started: its process group, which nothing inside can leave
 * because setsid and setpgid are denied. The leader's pid is the group's number.
 */
export const killGroup = (leader: number) => {
  try {
    process.kill(-leader, "SIGKILL");
  } catch {
    // The group is already gone.
  }
};

/**
 * The process Node spawns for `file`, caught as Node makes it, until `close`. Playwright starts
 * it detached, so its pid is its group's number; nothing the browser writes can change which.
 */
export const spawnedFor = (file: string) => {
  const made: Array<NodeChildProcess.ChildProcess> = [];
  const take = (message: unknown) => {
    const child = Predicate.hasProperty(message, "process") ? message.process : undefined;
    if (child instanceof NodeChildProcess.ChildProcess) made.push(child);
  };
  NodeDiagnosticsChannel.subscribe("child_process", take);
  return {
    close: () => {
      NodeDiagnosticsChannel.unsubscribe("child_process", take);
    },
    /** Ends the group it leads, if it was spawned. */
    stop: () => {
      const leader = made.find((child) => child.spawnfile === file)?.pid;
      if (leader !== undefined && leader > 1) killGroup(leader);
    },
  };
};
