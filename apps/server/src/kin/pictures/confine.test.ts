// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeDgram from "node:dgram";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import {
  confinedArch,
  confinedArgs,
  killGroup,
  networkFilter,
  probeConfinement,
} from "./confine.ts";

describe("networkFilter", () => {
  // Each program ends allow then deny, and every denied call jumps to that last line.
  it.each([
    ["x64", 14],
    ["arm64", 13],
  ] as const)("%s denies its listed calls and kills other architectures", (arch, length) => {
    const bytes = networkFilter(arch);
    const view = new DataView(bytes.buffer);
    const op = (index: number) => ({
      code: view.getUint16(index * 8, true),
      jt: view.getUint8(index * 8 + 2),
      jf: view.getUint8(index * 8 + 3),
      k: view.getUint32(index * 8 + 4, true),
    });
    assert.strictEqual(bytes.length, length * 8);
    assert.deepStrictEqual(op(1).jt, 1);
    assert.deepStrictEqual(op(2), { code: 0x06, jt: 0, jf: 0, k: 0x80000000 });
    assert.deepStrictEqual(op(length - 2), { code: 0x06, jt: 0, jf: 0, k: 0x7fff0000 });
    assert.deepStrictEqual(op(length - 1), { code: 0x06, jt: 0, jf: 0, k: 0x00050001 });
    for (let index = 4; index < length - 2; index++)
      assert.strictEqual(index + 1 + op(index).jt, length - 1);
  });
});

/** Runs `script` in bash under the picture browser's confinement, in its own process group. */
const confined = (
  arch: NodeJS.Architecture,
  setpriv: string,
  system: ReadonlyArray<string>,
  scratch: string,
  script: string,
) => {
  const filter = NodePath.join(scratch, "filter.bpf");
  NodeFS.writeFileSync(filter, networkFilter(confinedArch(arch)!));
  return NodeChildProcess.spawn(
    setpriv,
    [
      ...confinedArgs({ system, browserDir: NodePath.join(scratch, "browser"), scratch, filter }),
      "/bin/bash",
      "-c",
      script,
    ],
    {
      cwd: scratch,
      env: { PATH: "/usr/bin:/bin" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
};

/** Exit code, output and errors once every process holding the output has let it go. */
const finished = (child: NodeChildProcess.ChildProcess) =>
  Effect.callback<{ code: number | null; stdout: string; stderr: string }>((resume) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (code) => resume(Effect.succeed({ code, stdout, stderr })));
  });

const firstLine = (child: NodeChildProcess.ChildProcess) =>
  Effect.callback<string>((resume) => {
    child.stdout?.once("data", (chunk: Buffer) => resume(Effect.succeed(chunk.toString().trim())));
  });

const canaries = Effect.acquireRelease(
  Effect.callback<{
    readonly tcpPort: number;
    readonly udpPort: number;
    readonly reached: Array<string>;
    readonly tcp: Deferred.Deferred<void>;
    readonly close: () => void;
  }>((resume) => {
    const reached: Array<string> = [];
    const tcpSeen = Deferred.makeUnsafe<void>();
    const udp = NodeDgram.createSocket("udp4");
    udp.on("message", () => reached.push("udp"));
    const tcp = NodeNet.createServer((socket) => {
      reached.push("tcp");
      Deferred.doneUnsafe(tcpSeen, Effect.void);
      socket.destroy();
    });
    udp.bind(0, "127.0.0.1", () =>
      tcp.listen(0, "127.0.0.1", () =>
        resume(
          Effect.succeed({
            tcpPort: (tcp.address() as NodeNet.AddressInfo).port,
            udpPort: udp.address().port,
            reached,
            tcp: tcpSeen,
            close: () => {
              udp.close();
              tcp.close();
            },
          }),
        ),
      ),
    );
  }),
  ({ close }) => Effect.sync(close),
);

it.live(
  "a confined browser process reaches no socket, no file outside its folder and no later life",
  (ctx) =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-confine-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
      );
      const scratch = NodePath.join(root, "scratch");
      const home = NodePath.join(root, "home");
      NodeFS.mkdirSync(NodePath.join(scratch, "browser"), { recursive: true });
      NodeFS.mkdirSync(home);
      const platform = yield* HostProcess.Platform;
      const arch = yield* HostProcess.Architecture;
      const confinement = yield* probeConfinement({
        platform,
        arch,
        scratch: NodePath.join(root, "probe"),
      }).pipe(Effect.provide(NodeServices.layer));
      if (confinement._tag !== "confined")
        return ctx.skip(
          confinement._tag === "sandboxed"
            ? "Linux only: elsewhere Chrome's own sandbox holds the page."
            : `This host can't confine: ${confinement.reason}.`,
        );
      const run = (script: string) =>
        confined(arch, confinement.setpriv, confinement.system, scratch, script);

      // No socket: the same line reaches the TCP canary unconfined, so silence below is not a blind canary.
      const canary = yield* canaries;
      const tcp = `exec 3<>/dev/tcp/127.0.0.1/${canary.tcpPort}`;
      const udp = `echo leak >/dev/udp/127.0.0.1/${canary.udpPort}`;
      const blocked = yield* finished(
        run(`${tcp} && echo tcp-open; ${udp} && echo udp-sent; true`),
      );
      assert.notInclude(blocked.stdout, "open");
      assert.notInclude(blocked.stdout, "sent");
      assert.match(blocked.stderr, /not permitted/);
      assert.deepStrictEqual(canary.reached, []);
      const control = NodeChildProcess.spawn("/bin/bash", ["-c", tcp], { stdio: "ignore" });
      yield* Deferred.await(canary.tcp);
      yield* finished(control);
      assert.deepStrictEqual(canary.reached, ["tcp"]);

      // Files: only its own folder, read and written; a home's file is neither.
      NodeFS.writeFileSync(NodePath.join(home, "secret"), "Q3 revenue 4,812,000");
      NodeFS.writeFileSync(NodePath.join(scratch, "own"), "mine");
      const files = yield* finished(
        run(
          `cat ${home}/secret; echo x >${home}/planted; cat ${scratch}/own; echo y >${scratch}/written && echo wrote`,
        ),
      );
      assert.notInclude(files.stdout, "4,812,000");
      assert.include(files.stdout, "mine");
      assert.include(files.stdout, "wrote");
      assert.isFalse(NodeFS.existsSync(NodePath.join(home, "planted")));

      // Nothing leaves the group, so killing the group at the time limit ends every process:
      // the output closes only once the last holder of it is gone.
      const escape = yield* finished(run("setsid sleep 60 || echo no-setsid"));
      assert.include(escape.stdout, "no-setsid");
      const held = run("sleep 60 & echo $!; wait");
      const done = finished(held);
      const child = Number(yield* firstLine(held));
      assert.isAbove(child, 1);
      killGroup(held.pid!);
      const ended = yield* done;
      assert.strictEqual(ended.code, null);
      const left = NodeFS.existsSync(`/proc/${child}/stat`)
        ? NodeFS.readFileSync(`/proc/${child}/stat`, "utf8").split(") ")[1]?.[0]
        : "gone";
      assert.include(["gone", "Z"], left);
    }).pipe(Effect.scoped),
);
