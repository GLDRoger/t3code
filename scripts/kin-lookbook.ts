#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - a maintainer CLI.
/**
 * kin-lookbook: every main Kin screen captured on the invented company at a frozen moment, and
 * compared with the set the owner last accepted. See docs/operations/kin-lookbook.md.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { capture } from "./kin-lookbook/capture.ts";
import { anythingChanged, compareSets } from "./kin-lookbook/compare.ts";
import { readManifest } from "./kin-lookbook/manifest.ts";
import { ROOT } from "./kin-verify/instance.ts";
import { RpcFailure, VerifyError } from "./kin-verify/rpc.ts";

const HOME = NodePath.join(NodeOS.homedir(), ".kin-lookbook");
const ACCEPTED = NodePath.join(HOME, "accepted");

const HELP = `kin-lookbook <command>
  capture [--out <dir>] [--only a,b] [--keep]   every main screen, wide and narrow, into <dir>
                                                (default ~/.kin-lookbook/<short commit>); --keep
                                                leaves the instance up for kin-verify --instance lookbook
  compare [--accepted <dir>] --new <dir> --out <dir>
                                                index.html: what changed, side by side; exit 1 if anything did
                                                (--accepted defaults to ${ACCEPTED})
  accept --new <dir>                            makes <dir> the accepted set; the owner's call only`;

function flags(argv: ReadonlyArray<string>) {
  const found = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) throw new VerifyError(`unexpected "${arg}"; see kin-lookbook help`);
    const name = arg.slice(2);
    if (name === "keep") found.set(name, true);
    else {
      const value = argv[++index];
      if (value === undefined) throw new VerifyError(`--${name} needs a value`);
      found.set(name, value);
    }
  }
  return {
    get: (name: string) => {
      const value = found.get(name);
      return typeof value === "string" ? value : undefined;
    },
    has: (name: string) => found.has(name),
  };
}

const shortCommit = () =>
  NodeChildProcess.spawnSync("git", ["rev-parse", "--short=10", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).stdout.trim();

const required = (value: string | undefined, name: string) => {
  if (value === undefined) throw new VerifyError(`--${name} is required; see kin-lookbook help`);
  return NodePath.resolve(value);
};

/** Copies a set's own files: its manifest and its images. */
function copySet(from: string, to: string) {
  NodeFS.mkdirSync(to, { recursive: true });
  for (const file of NodeFS.readdirSync(from))
    if (file === "manifest.json" || file.endsWith(".png"))
      NodeFS.copyFileSync(NodePath.join(from, file), NodePath.join(to, file));
}

function accept(next: string) {
  const manifest = readManifest(next);
  if (NodePath.resolve(next) === ACCEPTED) throw new VerifyError(`${next} is already accepted`);
  let kept: string | undefined;
  if (NodeFS.existsSync(NodePath.join(ACCEPTED, "manifest.json"))) {
    const previous = readManifest(ACCEPTED);
    const base = NodePath.join(HOME, `accepted-before-${previous.shortCommit}`);
    kept = base;
    for (let n = 2; NodeFS.existsSync(kept); n++) kept = `${base}-${n}`;
    NodeFS.renameSync(ACCEPTED, kept);
  } else NodeFS.rmSync(ACCEPTED, { recursive: true, force: true });
  copySet(next, ACCEPTED);
  console.log(
    `accepted ${manifest.shortCommit} (${manifest.screens.length} screens) at ${ACCEPTED}${kept === undefined ? "" : `; the previous set is at ${kept}`}`,
  );
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = flags(rest);
  switch (command) {
    case "capture": {
      const out = NodePath.resolve(args.get("out") ?? NodePath.join(HOME, shortCommit()));
      const only = args.get("only");
      const started = performance.now();
      const manifest = await capture({
        out,
        ...(only === undefined ? {} : { only: new Set(only.split(",")) }),
        keep: args.has("keep"),
        log: (line) => console.log(line),
      });
      console.log(
        `captured ${manifest.screens.length} screens of ${manifest.shortCommit} in ${Math.round((performance.now() - started) / 1000)} s at ${out}`,
      );
      for (const failure of manifest.failed)
        console.log(`could not capture ${failure.name} (${failure.size}): ${failure.error}`);
      if (manifest.failed.length > 0) process.exitCode = 2;
      return;
    }
    case "compare": {
      const accepted = NodePath.resolve(args.get("accepted") ?? ACCEPTED);
      const next = required(args.get("new"), "new");
      const out = required(args.get("out"), "out");
      const comparison = compareSets(accepted, next, out);
      const { counts } = comparison;
      console.log(
        `same ${counts.same} · changed ${counts.changed} · new ${counts.new} · missing ${counts.missing} · ${NodePath.join(out, "index.html")}`,
      );
      for (const screen of comparison.screens)
        if (screen.verdict !== "same") console.log(`${screen.verdict}\t${screen.file}`);
      for (const tab of comparison.tabs) console.log(`changed\ttab (${tab.person})`);
      if (anythingChanged(comparison)) process.exitCode = 1;
      return;
    }
    case "accept":
      return accept(required(args.get("new"), "new"));
    case undefined:
    case "help":
      return console.log(HELP);
    default:
      throw new VerifyError(`unknown command "${command}"; run \`kin-lookbook help\``);
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    const message =
      error instanceof VerifyError || error instanceof RpcFailure
        ? error.message
        : ((error as Error).message.split("\n")[0] ?? String(error));
    console.error(`kin-lookbook: ${message}`);
    process.exit(3);
  },
);
