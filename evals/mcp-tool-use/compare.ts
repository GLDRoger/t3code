#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * `pnpm kin:compare --baseline <run> --candidate <run> [--candidate <confirm>]` compares run folders
 * case by case and exits 1 when a case is worse, 2 when the runs were not made under the same
 * settings. Candidate folders are pooled.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";

import { compare, report, RunManifest } from "./gate.ts";

const { values } = NodeUtil.parseArgs({
  options: { baseline: { type: "string" }, candidate: { type: "string", multiple: true } },
});
if (values.baseline === undefined || values.candidate === undefined) {
  console.error(
    "Usage: pnpm kin:compare --baseline <run folder> --candidate <run folder> [--candidate <confirm folder>]",
  );
  process.exit(2);
}
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(RunManifest));
const Row = Schema.Struct({
  id: Schema.String,
  pass: Schema.Boolean,
  error: Schema.optional(Schema.String),
});
const decodeRow = Schema.decodeUnknownSync(Schema.fromJsonString(Row));
const read = (dir: string) => ({
  manifest: decodeManifest(NodeFS.readFileSync(NodePath.join(dir, "run.json"), "utf8")),
  rows: NodeFS.readFileSync(NodePath.join(dir, "results.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => decodeRow(line)),
});

const result = compare(read(values.baseline), values.candidate.map(read));
console.log(report(result));
process.exitCode = result.refused.length > 0 ? 2 : result.pass ? 0 : 1;
