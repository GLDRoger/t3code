// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Brings upstream pingdotgg/t3code into the Kin trunk.
//
//   node scripts/kin-sync.ts
//
// 1. Fetches upstream and fast-forwards local `main` to `upstream/main`.
//    `main` is a pure mirror; it never carries Kin commits.
// 2. Merges `main` into the checked-out `kin` branch with diff3 conflicts.
// 3. Resolves every conflict hunk where Kin's only change was the product
//    rename (T3 Code -> Kin): it takes upstream's text and renames it again.
// 4. Commits when nothing is left, otherwise lists the hunks that need a person.
//    rerere is turned on, so a hunk resolved by hand once is replayed next time.
//
// It runs `vp i` but never pushes. Run `vp run check:changed upstream/main` next.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const UPSTREAM_URL = "https://github.com/pingdotgg/t3code.git";
const TRUNK = "kin";

const HUNK =
  /<<<<<<< [^\n]*\n([\s\S]*?)\|\|\|\|\|\|\| [^\n]*\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> [^\n]*\n/g;
const toKin = (text: string) => text.replace(/\bT3 Code\b/g, "Kin");
const toT3 = (text: string) => text.replace(/\bKin\b/g, "T3 Code");

/**
 * Resolves the diff3 hunks that differ only by the rename and returns the
 * new text plus the number of hunks still left for a person.
 */
export function resolveRenameHunks(text: string): { readonly text: string; readonly left: number } {
  let left = 0;
  const resolved = text.replace(HUNK, (hunk, ours: string, base: string, theirs: string) => {
    if (toT3(ours) === base) return toKin(theirs);
    if (theirs === base || toKin(theirs) === ours) return ours;
    left += 1;
    return hunk;
  });
  return { text: resolved, left };
}

function main() {
  const root = NodePath.resolve(import.meta.dirname, "..");
  const run = (...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", ["-c", "core.quotePath=false", ...args], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  const tryRun = (...args: Array<string>) =>
    NodeChildProcess.spawnSync("git", args, { cwd: root, encoding: "utf8" }).status === 0;

  if (run("branch", "--show-current") !== TRUNK) throw new Error(`Check out ${TRUNK} first.`);
  if (run("status", "--porcelain") !== "") throw new Error("Commit or stash your changes first.");
  if (run("rev-parse", "--is-shallow-repository") === "true") run("fetch", "--unshallow", "origin");
  if (!tryRun("remote", "get-url", "upstream")) run("remote", "add", "upstream", UPSTREAM_URL);
  run("fetch", "upstream", "main");
  // rerere replays hand resolutions when the same conflict comes back next sync.
  run("config", "rerere.enabled", "true");

  if (!tryRun("merge-base", "--is-ancestor", "main", "upstream/main")) {
    throw new Error("main has commits upstream does not. Move them to kin, then reset main.");
  }
  run("branch", "-f", "main", "upstream/main");
  const incoming = run("rev-list", "--count", "HEAD..main");
  if (incoming === "0") {
    console.log("kin already has everything on upstream main.");
    return;
  }
  console.log(`Merging ${incoming} upstream commits into ${TRUNK}.`);

  tryRun("-c", "merge.conflictStyle=diff3", "merge", "--no-ff", "--no-commit", "main");
  // A textually merged lockfile can still be broken. Start from upstream's and
  // let pnpm add the Kin packages back.
  run("checkout", "main", "--", "pnpm-lock.yaml");
  const conflicted = run("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
  const remaining: Array<string> = [];
  for (const file of conflicted) {
    const path = NodePath.join(root, file);
    if (!NodeFS.existsSync(path)) {
      remaining.push(`${file} (deleted on one side)`);
      continue;
    }
    const { text, left } = resolveRenameHunks(NodeFS.readFileSync(path, "utf8"));
    NodeFS.writeFileSync(path, text);
    if (left === 0) run("add", "--", file);
    else remaining.push(`${file} (${left} hunk${left === 1 ? "" : "s"})`);
  }
  const install = NodeChildProcess.spawnSync("vp", ["i"], { cwd: root, stdio: "inherit" });
  if (install.status !== 0) remaining.push("pnpm-lock.yaml (vp i failed)");
  else run("add", "--", "pnpm-lock.yaml");
  if (remaining.length === 0) {
    run("commit", "--no-edit", "--no-verify");
    console.log("Merged and committed. Next: vp run check:changed upstream/main");
    return;
  }
  console.log(
    `Resolved ${conflicted.length - remaining.length} of ${conflicted.length}. Still left:`,
  );
  for (const line of remaining) console.log(`  ${line}`);
  console.log("Fix these, `git add` them, run `vp i`, then `git commit --no-edit`.");
  process.exitCode = 1;
}

if (process.argv[1] === import.meta.filename) main();
