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
const decoy = ["sk-", "proj-"].join("") + "a".repeat(40);
// Each hides a real token behind an allowed match or a space RE2's \s misses.
const hidden = [
  ["decoy-space", `${decoy} ${plants["openai-key"]}`, "openai-key"],
  ["decoy-newline", `${decoy}\n${plants["openai-key"]}`, "openai-key"],
  ["url-decoy", "postgres://a:${X}@postgres://u:Hunter2Hunter2xyz@db.invalid", "url-password"],
  ["nbsp-assignment", `api_key\u00a0=\u00a0${body}`, "secret-assignment"],
  ["vtab-assignment", `api_key\v=\v${body}`, "secret-assignment"],
] as const;
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
    Schema.Array(
      Schema.Struct({ File: Schema.String, RuleID: Schema.String, StartLine: Schema.Number }),
    ),
  ),
);
const gitleaks = NodeChildProcess.spawnSync("gitleaks", ["version"]).status === 0;
const needsGitleaks = (name: string) =>
  gitleaks
    ? name
    : `SKIPPED, gitleaks is not on PATH, so this proof did not run (CI never runs it): ${name}`;
const scanFlags = (config: string, root: string) => [
  "--config",
  config,
  "--gitleaks-ignore-path",
  `${root}/no-ignores`,
  "--ignore-gitleaks-allow",
  "--redact",
  "--no-banner",
  "--report-format",
  "json",
  "--report-path",
  `${root}/report.json`,
];

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

it.live.skipIf(!gitleaks)(needsGitleaks("gitleaks flags each planted token and no near miss"), () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(`${root}/memory/decisions`, { recursive: true });
    for (const [id, token] of Object.entries(plants))
      yield* fs.writeFileString(`${root}/memory/decisions/${id}.md`, `note ${token} end\n`);
    for (const [name, text] of hidden)
      yield* fs.writeFileString(`${root}/memory/decisions/${name}.md`, `note ${text} end\n`);
    yield* fs.writeFileString(`${root}/memory/decisions/near.md`, `${nearMisses.join("\n")}\n`);
    yield* fs.writeFileString(`${root}/no-ignores`, "");
    const result = NodeChildProcess.spawnSync("gitleaks", [
      "dir",
      ...scanFlags(yield* opsFile("gitleaks.toml"), root),
      `${root}/memory`,
    ]);
    expect(result.status).toBe(1);
    const report = yield* decodeReport(yield* fs.readFileString(`${root}/report.json`));
    expect(report.map((f) => `${f.File.split("/").at(-1)} ${f.RuleID}`).sort()).toEqual(
      [
        ...Object.keys(plants).map((id) => `${id}.md ${id}`),
        ...hidden.map(([name, , id]) => `${name}.md ${id}`),
      ].sort(),
    );
    const newline = report.find((f) => f.File.endsWith("decoy-newline.md"));
    expect(newline?.StartLine).toBe(2);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(!gitleaks)(
  needsGitleaks("memory-check's history scans see a token that only a merge resolution held"),
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const repo = `${root}/memory`;
      yield* fs.makeDirectory(`${repo}/decisions`, { recursive: true });
      yield* fs.writeFileString(`${root}/no-ignores`, "");
      const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
      const git = (...args: ReadonlyArray<string>) => {
        const run = NodeChildProcess.spawnSync(
          "git",
          ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", ...args],
          { env, encoding: "utf8" },
        );
        expect(run.status, run.stderr).toBe(0);
        return run.stdout.trim();
      };
      git("init", "-q", "-b", "main");
      yield* fs.writeFileString(`${repo}/decisions/base.md`, "base\n");
      git("add", "-A");
      git("commit", "-q", "-m", "base");
      const base = git("rev-parse", "HEAD");
      git("checkout", "-q", "-b", "side");
      yield* fs.writeFileString(`${repo}/decisions/side.md`, "side\n");
      git("add", "-A");
      git("commit", "-q", "-m", "side");
      git("checkout", "-q", "main");
      yield* fs.writeFileString(`${repo}/decisions/main.md`, "main\n");
      git("add", "-A");
      git("commit", "-q", "-m", "main");
      git("merge", "-q", "--no-ff", "--no-commit", "side");
      yield* fs.writeFileString(`${repo}/decisions/merge.md`, `note ${plants["github-token"]}\n`);
      git("add", "-A");
      git("commit", "-q", "-m", "merge");
      yield* fs.remove(`${repo}/decisions/merge.md`);
      git("add", "-A");
      git("commit", "-q", "-m", "remove");
      const head = git("rev-parse", "HEAD");
      const text = yield* fs.readFileString(yield* opsFile("memory-check.yml"));
      const scans = text.split("\n").filter((line) => line.includes(`"$bin/gitleaks" git`));
      expect(scans).toHaveLength(2);
      for (const scan of scans) {
        const logOpts = /--log-opts="([^"]+)"/.exec(scan)?.[1];
        const result = NodeChildProcess.spawnSync("gitleaks", [
          "git",
          ...scanFlags(yield* opsFile("gitleaks.toml"), root),
          ...(logOpts === undefined
            ? []
            : [`--log-opts=${logOpts.replace("$BASE", base).replace("$HEAD", head)}`]),
          repo,
        ]);
        expect(result.status, scan).toBe(1);
        const report = yield* decodeReport(yield* fs.readFileString(`${root}/report.json`));
        expect(report.map((f) => `${f.File} ${f.RuleID}`)).toContain(
          "decisions/merge.md github-token",
        );
      }
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
