// @effect-diagnostics-next-line nodeBuiltinImport:off -- Runs the real gitleaks binary when it is installed.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse } from "yaml";

import { gitleaksToml } from "./gitleaksConfig.ts";
import { secretRules } from "./secretScan.ts";

const body = "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iL3oR6";
// Split so this public file never holds a literal token.
const plants: Record<(typeof secretRules)[number][0], string> = {
  "github-token": ["gh", "p_"].join("") + body,
  "anthropic-key": ["sk-", "ant-"].join("") + body + body,
  "openai-key": ["sk-", "proj-"].join("") + body,
  "aws-access-key": ["AK", "IA"].join("") + "QWERTYUIOPASDFGH",
  "slack-token": ["xo", "xb-"].join("") + body,
  "stripe-key": ["sk_", "live_"].join("") + body,
  "google-key": ["AI", "za"].join("") + "X".repeat(35),
  "pem-private-key": ["-----BEGIN ", "RSA PRIVATE KEY-----"].join(""),
  jwt: ["ey", "J"].join("") + "a".repeat(40) + "." + ["ey", "J"].join("") + "b".repeat(40),
  "url-password": "postgres://demo:Hunter2Hunter2xyz@db.example.invalid",
  "secret-assignment": "api_key = " + body,
};
const nearMisses = [
  ["gh", "p_short"].join(""),
  ["sk-", "proj-"].join("") + "lowercase".repeat(5),
  "password = " + "a".repeat(24),
  "postgres://demo:${DB_PASS}@db.example.invalid",
  "token_scopes: " + body,
];
const Step = Schema.Struct({
  name: Schema.String,
  uses: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
  with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const Workflow = Schema.Struct({
  on: Schema.Record(
    Schema.String,
    Schema.NullOr(Schema.Struct({ branches: Schema.optional(Schema.Array(Schema.String)) })),
  ),
  permissions: Schema.Record(Schema.String, Schema.String),
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      name: Schema.String,
      permissions: Schema.optional(Schema.Unknown),
      env: Schema.Record(Schema.String, Schema.String),
      steps: Schema.Array(Step),
    }),
  ),
});
const decodeWorkflow = Schema.decodeUnknownEffect(Workflow);
const decodeReport = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ File: Schema.String, RuleID: Schema.String })),
  ),
);
const gitleaks = NodeChildProcess.spawnSync("gitleaks", ["version"]).status === 0;

const opsFile = (name: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const here = yield* path.fromFileUrl(new URL(".", import.meta.url));
    return path.join(here, "../../../../../ops/kin/memory-repo", name);
  });

it.effect("the committed gitleaks config is generated from the scanner rules", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    expect(yield* fs.readFileString(yield* opsFile("gitleaks.toml"))).toBe(`${gitleaksToml}\n`);
    expect(Object.keys(plants).sort()).toEqual(secretRules.map(([id]) => id).sort());
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live.skipIf(!gitleaks)("gitleaks flags each planted token and no near miss", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(`${root}/memory/decisions`, { recursive: true });
    for (const [id, token] of Object.entries(plants))
      yield* fs.writeFileString(`${root}/memory/decisions/${id}.md`, `note ${token} end\n`);
    yield* fs.writeFileString(`${root}/memory/decisions/near.md`, `${nearMisses.join("\n")}\n`);
    yield* fs.writeFileString(`${root}/no-ignores`, "");
    const result = NodeChildProcess.spawnSync("gitleaks", [
      "dir",
      "--config",
      yield* opsFile("gitleaks.toml"),
      "--gitleaks-ignore-path",
      `${root}/no-ignores`,
      "--ignore-gitleaks-allow",
      "--redact",
      "--no-banner",
      "--report-format",
      "json",
      "--report-path",
      `${root}/report.json`,
      `${root}/memory`,
    ]);
    expect(result.status).toBe(1);
    const report = yield* decodeReport(yield* fs.readFileString(`${root}/report.json`));
    expect(report.map((f) => `${f.File.split("/").at(-1)} ${f.RuleID}`).sort()).toEqual(
      Object.keys(plants)
        .map((id) => `${id}.md ${id}`)
        .sort(),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("memory-check only reads the memory repo and pins what it runs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(yield* opsFile("memory-check.yml"));
    const workflow = yield* decodeWorkflow(parse(text));
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "push"]);
    expect(workflow.on.push?.branches).toEqual(["main"]);
    expect(text).not.toContain("pull_request_target");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.jobs)).toEqual(["memory-check"]);
    const job = workflow.jobs["memory-check"];
    expect(job?.name).toBe("memory-check");
    expect(job?.permissions).toBeUndefined();
    const steps = job?.steps ?? [];
    for (const step of steps.filter((s) => s.uses !== undefined))
      expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    for (const step of steps.filter((s) => s.uses?.startsWith("actions/checkout@")))
      expect(step.with?.["persist-credentials"]).toBe(false);
    const runs = steps.flatMap((s) => (s.run === undefined ? [] : [s.run])).join("\n");
    expect(runs).not.toContain("${{");
    expect(runs).toMatch(/echo "\$\{GITLEAKS_SHA256\} {2}\S+" \| sha256sum --check --strict/);
    expect(job?.env.GITLEAKS_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(runs).toContain("--ignore-gitleaks-allow");
    expect(runs).toContain("--config t3code/ops/kin/memory-repo/gitleaks.toml");
    expect(runs).toContain("node t3code/apps/server/src/kin/memory/lintCli.ts memory");
    expect(runs).toMatch(/\^\[0-9a-f\]\{40\}\$/);
    const t3code = steps.find((s) => s.with?.repository === "GLDRoger/t3code");
    expect(t3code?.with?.ref).toBe("${{ env.T3CODE_REF }}");
  }).pipe(Effect.provide(NodeServices.layer)),
);
