// @effect-diagnostics-next-line nodeBuiltinImport:off -- Fixtures need authentic Git object identities.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ChildProcessSpawner } from "effect/process";
import { VcsProcess } from "../../vcs/VcsProcess.ts";
import { ancestors, verifyTree } from "./objects.ts";

it.effect(
  "batches a 200-commit frontier and stops at a verified ancestor; rejects a substituted tree",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped();
      const objects = new Map<string, { type: string; bytes: Buffer }>();
      const object = (type: string, text: string) => {
        const bytes = Buffer.from(text);
        const sha = NodeCrypto.createHash("sha1")
          .update(`${type} ${bytes.length}\0`)
          .update(bytes)
          .digest("hex");
        objects.set(sha, { type, bytes });
        return sha;
      };
      const tree = object("tree", "");
      const root = object("commit", `tree ${tree}\n\nroot\n`);
      const frontier = Array.from({ length: 200 }, (_, n) =>
        object("commit", `tree ${tree}\nparent ${root}\n\ncommit ${n}\n`),
      );
      const tip = object(
        "commit",
        `tree ${tree}\n${frontier.map((sha) => `parent ${sha}\n`).join("")}\nmerge\n`,
      );
      let calls = 0;
      const vcs = VcsProcess.of({
        run: Effect.fn("Test.batch")((input) =>
          Effect.sync(() => {
            calls++;
            const chunks = input
              .stdin!.trim()
              .split("\n")
              .map((sha) => {
                const entry = objects.get(sha)!;
                return Buffer.concat([
                  Buffer.from(`${sha} ${entry.type} ${entry.bytes.length}\n`),
                  entry.bytes,
                  Buffer.from("\n"),
                ]);
              });
            input.onStdoutChunk?.(Buffer.concat(chunks));
            return {
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }),
        ),
      });
      const org = KinOrgId.make("fixture");
      yield* Effect.gen(function* () {
        expect((yield* ancestors(org, cwd, tip)).size).toBe(202);
        expect(calls).toBe(3);
        calls = 0;
        expect((yield* ancestors(org, cwd, tip, frontier[0])).size).toBe(201);
        expect(calls).toBe(2);
        yield* verifyTree(org, cwd, tree, new Map());
        const rejected = yield* verifyTree(
          org,
          cwd,
          tree,
          new Map([["rules.md", { mode: "100644", sha: "0".repeat(40) }]]),
        ).pipe(Effect.result);
        expect(rejected._tag).toBe("Failure");
      }).pipe(Effect.provideService(VcsProcess, vcs));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
