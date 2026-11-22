#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * `pnpm kin:surface --run <run folder> [--out <file>]` writes what every Kin case can receive from
 * this checkout (`surface.ts`) to `<file>`, by default `<run folder>/surface.json`. No model call.
 * Run it on the checkout a run was made from: it refuses when a case or first request it builds
 * differs from what that run's run.json recorded, so the file always describes the run.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { RunManifest } from "../gate.ts";
import { readCases, surfaceOf } from "./surface.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    run: { type: "string" },
    out: { type: "string" },
    cases: { type: "string", multiple: true },
  },
});
if (values.run === undefined || values.cases === undefined) {
  console.error("Usage: pnpm kin:surface --run <run folder> [--out <file>]");
  process.exit(2);
}
const manifest = Schema.decodeSync(Schema.fromJsonString(RunManifest))(
  NodeFS.readFileSync(NodePath.join(values.run, "run.json"), "utf8"),
);
const cases = readCases(values.cases).filter((one) => manifest.cases[one.id] !== undefined);
const surface = await Effect.runPromise(
  surfaceOf({
    cases,
    model: manifest.model as Parameters<typeof surfaceOf>[0]["model"],
    effort: manifest.effort,
    shellModel: manifest.shellModel,
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, PlatformNodeCrypto.layer))),
);
const mismatched = Object.entries(manifest.cases).flatMap(([id, recorded]) => {
  const built = surface.cases[id];
  if (built === undefined) return [`${id}: not in this checkout's cases`];
  return [
    ...(built.case === recorded.case ? [] : [`${id}: case differs from the run's`]),
    ...(built.request === recorded.request ? [] : [`${id}: first request differs from the run's`]),
  ];
});
if (mismatched.length > 0) {
  console.error(
    [
      `This checkout does not build what ${values.run} ran (commit ${manifest.commit}):`,
      ...mismatched.slice(0, 20),
      ...(mismatched.length > 20 ? [`and ${mismatched.length - 20} more`] : []),
    ].join("\n"),
  );
  process.exit(2);
}
const out = values.out ?? NodePath.join(values.run, "surface.json");
NodeFS.writeFileSync(out, `${JSON.stringify({ commit: manifest.commit, ...surface })}\n`);
console.log(`Wrote the surface of ${Object.keys(surface.cases).length} cases to ${out}.`);
