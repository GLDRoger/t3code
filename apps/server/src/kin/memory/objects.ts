// @effect-diagnostics-next-line nodeBuiltinImport:off -- Git object identity uses the native byte-oriented hash API.
import * as NodeCrypto from "node:crypto";
import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { memoryGit } from "./git.ts";
import { MemoryCheckoutInvalid } from "./Memory.ts";

// Object batches share the enclosing operation span, including per-commit ancestry reads.
export const readObjects = Effect.fnUntraced(function* (
  orgId: KinOrgId,
  cwd: string,
  requests: ReadonlyArray<{ sha: string; type: "blob" | "tree" | "commit" | "tag" }>,
) {
  const invalid = () =>
    new MemoryCheckoutInvalid({
      orgId,
      operation: "object",
      reason: "Object hash or framing mismatch",
    });
  if (requests.some(({ sha }) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)))
    return yield* invalid();
  if (!requests.length) return [];
  const chunks: Uint8Array[] = [];
  yield* memoryGit(
    cwd,
    ["cat-file", "--batch"],
    requests.map(({ sha }) => sha).join("\n") + "\n",
    {},
    (chunk) => chunks.push(chunk),
  ).pipe(Effect.mapError(invalid));
  const buffer = Buffer.concat(chunks);
  const result: Buffer[] = [];
  let offset = 0;
  for (const { sha, type } of requests) {
    const end = buffer.indexOf(10, offset);
    const header = buffer.subarray(offset, end).toString("ascii");
    const match = /^(\w+) (blob|tree|commit|tag) (\d+)$/.exec(header);
    if (end < 0 || !match || match[1] !== sha || match[2] !== type) return yield* invalid();
    const length = Number(match[3]);
    offset = end + 1;
    const bytes = buffer.subarray(offset, offset + length);
    if (
      bytes.length !== length ||
      buffer[offset + length] !== 10 ||
      NodeCrypto.createHash(sha.length === 40 ? "sha1" : "sha256")
        .update(`${type} ${length}\0`)
        .update(bytes)
        .digest("hex") !== sha
    )
      return yield* invalid();
    result.push(bytes);
    offset += length + 1;
  }
  if (offset !== buffer.length) return yield* invalid();
  return result;
});

// Per-commit reads share the enclosing operation span.
export const readCommit = Effect.fnUntraced(function* (orgId: KinOrgId, cwd: string, sha: string) {
  const objects = yield* readObjects(orgId, cwd, [{ sha, type: "commit" }]);
  const text = objects[0]?.toString("utf8") ?? "";
  const tree = /^tree ([a-f0-9]+)\n/.exec(text)?.[1];
  if (!tree)
    return yield* new MemoryCheckoutInvalid({
      orgId,
      operation: "commit",
      reason: "Missing commit tree",
    });
  return {
    tree,
    message: text.slice(text.indexOf("\n\n") + 2),
    parent: /^parent ([a-f0-9]+)$/m.exec(text.split("\n\n")[0] ?? "")?.[1],
    parents: [...(text.split("\n\n")[0] ?? "").matchAll(/^parent ([a-f0-9]+)$/gm)]
      .map((match) => match[1])
      .filter((sha): sha is string => sha !== undefined),
  };
});

export const readTree = Effect.fn("Memory.readTree")(function* (
  orgId: KinOrgId,
  cwd: string,
  commit: string,
  isTree = false,
) {
  const tree = isTree ? commit : (yield* readCommit(orgId, cwd, commit)).tree;
  const entries: Array<{ sha: string; relative: string; mode: string }> = [];
  const pending = [{ sha: tree, prefix: "" }];
  while (pending.length) {
    const batch = pending.splice(0, 32);
    const objects = yield* readObjects(
      orgId,
      cwd,
      batch.map(({ sha }) => ({ sha, type: "tree" })),
    );
    for (const [index, object] of objects.entries()) {
      const request = batch[index];
      if (!request) continue;
      let offset = 0;
      while (offset < object.length) {
        const space = object.indexOf(32, offset);
        const nul = object.indexOf(0, space);
        const width = request.sha.length / 2;
        if (space < offset || nul < space || nul + 1 + width > object.length)
          return yield* new MemoryCheckoutInvalid({
            orgId,
            operation: "tree",
            reason: "Invalid tree framing",
          });
        const mode = object.subarray(offset, space).toString("ascii");
        const name = object.subarray(space + 1, nul).toString("utf8");
        const sha = object.subarray(nul + 1, nul + 1 + width).toString("hex");
        const relative = request.prefix + name;
        if (mode === "40000") pending.push({ sha, prefix: `${relative}/` });
        else if (["100644", "100755", "120000", "160000"].includes(mode))
          entries.push({ sha, relative, mode });
        else
          return yield* new MemoryCheckoutInvalid({
            orgId,
            operation: "tree",
            reason: "Unknown tree entry mode",
          });
        offset = nul + 1 + width;
      }
    }
  }
  return entries;
});

export const readFiles = Effect.fn("Memory.readFiles")(function* (
  orgId: KinOrgId,
  cwd: string,
  commit: string,
) {
  const all = yield* readTree(orgId, cwd, commit);
  const entries = all.filter((entry) => entry.mode !== "160000");
  const files = new Map<string, Buffer>();
  for (let index = 0; index < entries.length; index += 32) {
    const batch = entries.slice(index, index + 32);
    const objects = yield* readObjects(
      orgId,
      cwd,
      batch.map(({ sha }) => ({ sha, type: "blob" })),
    );
    for (const [index, entry] of batch.entries()) {
      const bytes = objects[index];
      if (bytes) files.set(entry.relative, bytes);
    }
  }
  for (const entry of all)
    if (entry.mode === "160000") files.set(entry.relative, Buffer.from(entry.sha, "ascii"));
  return files;
});

export const objectHash = (bytes: Buffer, width: number) =>
  NodeCrypto.createHash(width === 40 ? "sha1" : "sha256")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");

export const verifyTree = Effect.fn("Memory.verifyTree")(function* (
  orgId: KinOrgId,
  cwd: string,
  tree: string,
  expected: ReadonlyMap<string, { mode: string; sha: string }>,
) {
  const entries = yield* readTree(orgId, cwd, tree, true);
  if (
    entries.length !== expected.size ||
    entries.some((entry) => {
      const wanted = expected.get(entry.relative);
      return wanted?.mode !== entry.mode || wanted.sha !== entry.sha;
    })
  )
    return yield* new MemoryCheckoutInvalid({
      orgId,
      operation: "writeTree",
      reason: "Written tree differs from validated bytes",
    });
});

export const ancestors = Effect.fn("Memory.ancestors")(function* (
  orgId: KinOrgId,
  writer: string,
  tip: string,
  stop?: string,
) {
  const seen = new Map<string, ReadonlyArray<string>>();
  let pending = [tip];
  while (pending.length) {
    const batch = [...new Set(pending)].filter((sha) => !seen.has(sha));
    if (!batch.length) break;
    const objects = yield* readObjects(
      orgId,
      writer,
      batch.map((sha) => ({ sha, type: "commit" as const })),
    );
    pending = [];
    for (const [index, bytes] of objects.entries()) {
      const sha = batch[index]!;
      const parents = [
        ...(bytes.toString("utf8").split("\n\n")[0] ?? "").matchAll(/^parent ([a-f0-9]+)$/gm),
      ].map((m) => m[1]!);
      seen.set(sha, parents);
      pending.push(...parents);
    }
    if (stop && seen.has(stop)) break;
  }
  return seen;
});
