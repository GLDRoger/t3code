#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * `pnpm kin:changed --baseline <run> --out <dir> --model <id> [--plan]` runs only the Kin cases
 * whose input changed since the baseline, plus a seeded tripwire of the rest, through run.ts as
 * `kin:candidate` would. The baseline needs a surface.json from `pnpm kin:surface`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { RunManifest } from "../gate.ts";
import { compareChanged, reportChanged, select, surfaceRefusals } from "./select.ts";
import { readCases, REVIEWED_RUNNER, Surface, surfaceOf } from "./surface.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    baseline: { type: "string" },
    out: { type: "string" },
    cases: { type: "string", multiple: true },
    model: { type: "string", default: "claude-sonnet-5-5" },
    effort: { type: "string" },
    concurrency: { type: "string", default: "8" },
    "shell-model": { type: "string", default: "claude-haiku-5-5" },
    // Reused cases rerun to check the selection: about 3 minutes and $0.50 on Haiku.
    tripwire: { type: "string", default: "24" },
    seed: { type: "string" },
    plan: { type: "boolean", default: false },
    // When the baseline folder is read-only: its surface.json kept elsewhere.
    "baseline-surface": { type: "string" },
  },
});
const { baseline, out, cases: caseFiles } = values;
if (baseline === undefined || out === undefined || caseFiles === undefined) {
  console.error(
    "Usage: pnpm kin:changed --baseline <run folder> --out <dir> --model <id> [--tripwire 24] [--plan]",
  );
  process.exit(2);
}
const tripwire = Number(values.tripwire);
if (!Number.isInteger(tripwire) || tripwire < 1) {
  console.error(
    "--tripwire must be a whole number of at least 1: something must check the selection.",
  );
  process.exit(2);
}
const read = (file: string) => NodeFS.readFileSync(file, "utf8");
const manifest = Schema.decodeSync(Schema.fromJsonString(RunManifest))(
  read(NodePath.join(baseline, "run.json")),
);
const surfaceFile = values["baseline-surface"] ?? NodePath.join(baseline, "surface.json");
if (!NodeFS.existsSync(surfaceFile)) {
  console.error(
    `${surfaceFile} is missing. On a checkout of the baseline's commit ${manifest.commit}, run: pnpm kin:surface --run ${baseline} [--out <file>]`,
  );
  process.exit(2);
}
const before = Schema.decodeSync(Schema.fromJsonString(Surface))(read(surfaceFile));
const rows = read(NodePath.join(baseline, "results.jsonl"))
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => {
    const row = JSON.parse(line) as { id: string; pass: boolean; error?: string };
    return { id: row.id, pass: row.pass, ...(row.error === undefined ? {} : { error: row.error }) };
  });
const effort = values.effort ?? "high";
const after = await Effect.runPromise(
  surfaceOf({
    cases: readCases(caseFiles),
    model: values.model as Parameters<typeof surfaceOf>[0]["model"],
    effort,
    shellModel: values["shell-model"],
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, PlatformNodeCrypto.layer))),
);
const refused = surfaceRefusals(before, after, REVIEWED_RUNNER);
if (refused.length > 0) {
  console.error(["Refused:", ...refused.map((line) => `- ${line}`)].join("\n"));
  process.exit(2);
}
const commit = NodeChildProcess.execFileSync("git", ["describe", "--always", "--dirty"], {
  encoding: "utf8",
}).trim();
// Fixed per baseline and checkout, so a rerun picks the same tripwire; a new commit picks anew.
const seed =
  values.seed ??
  NodeCrypto.createHash("sha256")
    .update(`${manifest.commit}\0${commit}`)
    .digest("hex")
    .slice(0, 12);
const selection = select({
  baseline: before,
  candidate: after,
  run: { manifest, rows },
  tripwire,
  seed,
});
NodeFS.mkdirSync(out, { recursive: true });
NodeFS.writeFileSync(NodePath.join(out, "selection.json"), `${JSON.stringify(selection)}\n`);
NodeFS.writeFileSync(
  NodePath.join(out, "surface.json"),
  `${JSON.stringify({ commit, ...after })}\n`,
);
const toRun = [...selection.rerun.map(({ id }) => id), ...selection.tripwire];
console.log(
  [
    `${selection.rerun.length} cases rerun because their input changed, ${selection.reused.length} reused from the baseline, ${selection.tripwire.length} of those rerun as the tripwire (seed ${seed}).`,
    ...selection.rerun.map(({ id, why }) => `- ${id}: ${why.join("; ")}`),
    ...(selection.added.length > 0
      ? [`Not in the baseline, run them as new cases: ${selection.added.join(", ")}`]
      : []),
  ].join("\n"),
);
if (values.plan || toRun.length === 0) process.exit(0);

const run = NodeChildProcess.spawnSync(
  process.execPath,
  [
    NodePath.join(import.meta.dirname, "../run.ts"),
    "--no-step-limit",
    ...caseFiles.flatMap((file) => ["--cases", file]),
    "--model",
    values.model,
    ...(values.effort === undefined ? [] : ["--effort", values.effort]),
    "--shell-model",
    values["shell-model"],
    "--samples",
    "3",
    "--top-up",
    String(manifest.topUp),
    "--concurrency",
    values.concurrency,
    "--baseline",
    baseline,
    "--out",
    out,
    "--case",
    toRun.join(","),
  ],
  { stdio: "inherit" },
);
if (run.status !== 0) {
  console.error(`run.ts exited ${run.status ?? run.signal}.`);
  process.exit(2);
}
const decodeManifest = Schema.decodeSync(Schema.fromJsonString(RunManifest));
const candidateRows = read(NodePath.join(out, "results.jsonl"))
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as { id: string; pass: boolean; error?: string });
const result = compareChanged({
  baseline: { manifest, rows },
  candidates: [
    { manifest: decodeManifest(read(NodePath.join(out, "run.json"))), rows: candidateRows },
  ],
  selection,
});
console.log(reportChanged(result));
process.exitCode = result.refused.length > 0 ? 2 : result.pass ? 0 : 1;
