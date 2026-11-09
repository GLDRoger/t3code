// @effect-diagnostics-next-line nodeBuiltinImport:off -- Git object identity uses the native byte-oriented hash API.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";

/** An in-memory git remote: `files` is the tree, `commit()` makes a new head. */
export const fakeRepository = (fs: FileSystem.FileSystem) => {
  const files = new Map<string, string>();
  const objects = new Map<string, { type: string; bytes: Buffer }>();
  const object = (type: string, bytes: Buffer) => {
    const sha = NodeCrypto.createHash("sha1")
      .update(`${type} ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    objects.set(sha, { type, bytes });
    return sha;
  };
  const head = () => {
    const tree = (prefix: string): string => {
      const names = [
        ...new Set(
          [...files.keys()]
            .filter((name) => name.startsWith(prefix))
            .map((name) => name.slice(prefix.length).split("/")[0] ?? ""),
        ),
      ].sort();
      return object(
        "tree",
        Buffer.concat(
          names.map((name) => {
            const text = files.get(prefix + name);
            const sha =
              text === undefined ? tree(prefix + name + "/") : object("blob", Buffer.from(text));
            return Buffer.concat([
              Buffer.from(`${text === undefined ? "40000" : "100644"} ${name}\0`),
              Buffer.from(sha, "hex"),
            ]);
          }),
        ),
      );
    };
    return object("commit", Buffer.from(`tree ${tree("")}\n\nfixture ${revision}\n`));
  };
  let validations = 0;
  let treeReads = 0;
  let blobReads = 0;
  let revision = 0;
  let corruptNextBatch = false;
  const layer = Layer.succeed(
    VcsProcess.VcsProcess,
    VcsProcess.VcsProcess.of({
      run: Effect.fn("Test.git")(({ args: rawArgs, stdin, cwd, onStdoutChunk }) => {
        const args: string[] = [];
        for (let i = 0; i < rawArgs.length; i++) {
          const arg = rawArgs[i];
          if (arg === "-c") {
            i++;
            continue;
          }
          if (
            arg &&
            !arg.startsWith("--git-dir=") &&
            !arg.startsWith("--work-tree=") &&
            arg !== "--no-replace-objects"
          )
            args.push(arg);
        }
        let stdout = "";
        switch (args[0]) {
          case "fetch":
          case "rev-parse":
            if (args.includes("refs/heads/main")) validations++;
            stdout = args.includes("--show-toplevel")
              ? cwd
              : args.includes("--git-common-dir")
                ? cwd.replace(/memory-read$/, "memory/.git")
                : head();
            break;
          case "ls-remote":
            stdout = `${head()}\trefs/heads/main\n`;
            break;
          case "cat-file": {
            const chunks = (stdin?.trim().split("\n") ?? []).map((sha) => {
              const entry = objects.get(sha);
              if (!entry) return Buffer.from(`${sha} missing\n`);
              if (args.includes("--batch-check"))
                return Buffer.from(`${sha} ${entry.type} ${entry.bytes.length}\n`);
              if (entry.type === "blob") blobReads++;
              if (entry.type === "tree") treeReads++;
              return Buffer.concat([
                Buffer.from(`${sha} ${entry.type} ${entry.bytes.length}\n`),
                entry.bytes,
                Buffer.from("\n"),
              ]);
            });
            if (corruptNextBatch) {
              chunks.unshift(Buffer.from("invalid header\n"));
              corruptNextBatch = false;
            }
            if (args.includes("--batch-check")) stdout = Buffer.concat(chunks).toString("utf8");
            else onStdoutChunk?.(Buffer.concat(chunks));
            break;
          }
        }
        onStdoutChunk?.(Buffer.from(stdout));
        return Effect.gen(function* () {
          if (args[0] === "clone" || args[0] === "clone-snapshot") {
            yield* fs
              .makeDirectory(`${args.at(-1)}/.git/objects`, { recursive: true })
              .pipe(Effect.orDie);
          }
          return {
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout,
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        });
      }),
    }),
  );
  return {
    files,
    head,
    layer,
    commit: () => {
      revision++;
      return head();
    },
    counts: () => ({ treeReads, blobReads, validations }),
    corruptBatch: () => {
      corruptNextBatch = true;
    },
  };
};
