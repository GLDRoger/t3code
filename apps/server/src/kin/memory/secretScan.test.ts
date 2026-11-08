// @effect-diagnostics-next-line nodeBuiltinImport:off -- Bounded synchronous fingerprint hashing shares the scan loop.
import * as NodeCrypto from "node:crypto";
import { vi } from "vite-plus/test";
import { expect, it } from "@effect/vitest";
import { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Persistence from "../persistence/KinPersistence.ts";
import * as Scan from "./secretScan.ts";

const orgId = KinOrgId.make("fixture-org");
const database = Layer.provideMerge(Persistence.layer, Sqlite.layerMemory);
const layer = Scan.layer.pipe(Layer.provideMerge(database));
const body = "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iL3oR6";
const github = ["gh", "p_"].join("") + body;
const fixtures = [
  ...["X-Api-Key: ", "client-secret: ", '{"password": "', '"api_key":"'].map((prefix) => [
    "secret-assignment",
    prefix + body + '"',
    prefix + "short",
  ]),
  ...["_", "token_"].map((prefix) => [
    "github-token",
    prefix + github + "_rotated",
    "task-follow-up-with-design-team",
  ]),
  ["aws-access-key", ["AK", "IA"].join("") + "Q".repeat(16) + "_old", "ASIAPACIFICREGION2026"],
  [
    "jwt",
    ["ey", "J"].join("") + "a".repeat(100) + "." + "b".repeat(1800) + "." + "c".repeat(100),
    "eyJshort.two.parts",
  ],

  ...["p", "o", "u", "s", "r"].map((kind) => [
    "github-token",
    "gh" + kind + "_" + body,
    "gh" + kind + "_short",
  ]),
  [
    "github-token",
    ["github_", "pat_"].join("") + "a".repeat(82),
    ["github_", "pat_short"].join(""),
  ],
  ["anthropic-key", ["sk-", "ant-"].join("") + body.repeat(2), ["sk-", "ant-short"].join("")],
  ["openai-key", "sk-" + body.slice(0, 20) + "T3BlbkFJ" + body.slice(0, 20), "sk-short"],
  ...["proj", "svcacct", "admin"].map((kind) => [
    "openai-key",
    ["sk-", kind, "-", body.repeat(3)].join(""),
    ["sk-", kind, "-", "a".repeat(40)].join(""),
  ]),
  ...["AK", "AS"].map((kind) => [
    "aws-access-key",
    kind + "IA" + "X".repeat(16),
    kind + "IA" + "X".repeat(15),
  ]),
  ["slack-token", ["xo", "xb-"].join("") + body, ["xo", "xb-short"].join("")],
  ["stripe-key", ["sk_", "live_"].join("") + body, "sk_live_short"],
  ["google-key", ["AI", "za"].join("") + "X".repeat(35), ["AI", "za_short"].join("")],
  ["pem-private-key", "-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN PUBLIC KEY-----"],
  [
    "jwt",
    ["ey", "J"].join("") + "a".repeat(10) + "." + "b".repeat(12) + "." + "c".repeat(20),
    "eyJshort.two.parts",
  ],
  [
    "url-password",
    "https://fixture:fake-password@example.invalid",
    "https://fixture@example.invalid",
  ],
  ["secret-assignment", "password=" + body, "password=" + "a".repeat(40)],
  ["secret-assignment", "export API_KEY='" + body + "'", "export API_KEY='short'"],
  ["secret-assignment", "AWS_SECRET_ACCESS_KEY=" + body + "aB3d", "AWS_SECRET_ACCESS_KEY=example"],
];
it.effect.each(fixtures.map(([rule, hit, miss], i) => ({ rule, hit, miss, id: i })))(
  "rule fixture $id: $rule",
  ({ rule, hit, miss }) =>
    Effect.gen(function* () {
      const scanner = yield* Scan.KinSecretScan;
      const run = (content: string) =>
        scanner.scan({ orgId, files: [{ path: "claims/test.md", content: Buffer.from(content) }] });
      // Assert only metadata so a failed assertion never prints the synthetic matched token.
      expect((yield* run(hit!)).some((finding) => finding.ruleId === rule)).toBe(true);
      expect((yield* run(miss!)).length).toBe(0);
    }).pipe(Effect.provide(layer)),
);
it.effect("blocks encoded, wrapped and confusable tokens with safe findings", () =>
  Effect.gen(function* () {
    const scanner = yield* Scan.KinSecretScan;
    const values = [
      github,
      "%67" + github.slice(1),
      ...["/", "-", "_", "+", "word"].map(
        (prefix) => prefix + Buffer.from(github).toString("base64"),
      ),
      Buffer.from("é" + github + "é").toString("base64"),
      [...Buffer.from(github.slice(0, 5) + "\u034f" + github.slice(5))]
        .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
        .join(""),
      "%FF" + [...github].map((c) => `%${c.charCodeAt(0).toString(16)}`).join(""),
      ...["\u00ad", "\u034f", "\ufe0f", "\u{e0061}"].map(
        (separator) => github.slice(0, 5) + separator + github.slice(5),
      ),
      github.replace("g", "ɡ"),
      github.replace("h", "һ"),
      ["gh", "ѕ_", body].join(""),
      ["gh", "ο_", body].join(""),
      " ".repeat(8190) + github,
      Buffer.from(github).toString("base64"),
      Buffer.from(Buffer.from(github).toString("base64")).toString("base64"),
      [...github].map((c) => `%${c.charCodeAt(0).toString(16)}`).join(""),
      github.slice(0, 12) + "\n" + github.slice(12),
      ...["next word", " next word"].map(
        (suffix) => github.slice(0, 12) + "\n" + github.slice(12) + "\n" + suffix,
      ),
      github.slice(0, 12) + "\\\n " + github.slice(12),
      github.replace("p", "р"),
      [...github].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join(""),
      github.slice(0, 5) + "\u200b" + github.slice(5),
    ];
    for (const content of values) {
      const result = yield* scanner.scan({
        orgId,
        files: [{ path: "journal/test.md", content: Buffer.from(content) }],
      });
      expect(result.some((f) => f.ruleId === "github-token")).toBe(true);
      expect(JSON.stringify(result).includes(body)).toBe(false);
      expect(Object.keys(result[0]!).sort()).toEqual(["line", "path", "ruleId"]);
    }
  }).pipe(Effect.provide(layer)),
);
it.effect("reports source lines and blocks AWS credential pairs without leaking values", () =>
  Effect.gen(function* () {
    const scanner = yield* Scan.KinSecretScan;
    for (const content of [
      "safe\n\n" + github,
      "safe\n\n" + github.slice(0, 12) + "\n" + github.slice(12),
    ]) {
      const result = yield* scanner.scan({
        orgId,
        files: [{ path: "claims/test.md", content: Buffer.from(content) }],
      });
      expect(result.every((f) => f.line === 3)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    }
    const pair = [
      "AWS_ACCESS_KEY_ID=" + ["AK", "IA", "X".repeat(16)].join(""),
      "AWS_SECRET_ACCESS_KEY=" + body + "aB3d",
    ].join("\n");
    const findings = yield* scanner.scan({
      orgId,
      files: [{ path: ".env", content: Buffer.from(pair) }],
    });
    expect(findings.some((f) => f.ruleId === "aws-access-key")).toBe(true);
    expect(findings.some((f) => f.ruleId === "secret-assignment")).toBe(true);
  }).pipe(Effect.provide(layer)),
);
it.effect("allowlist is exact, org scoped, and read only to scanner callers", () =>
  Effect.gen(function* () {
    const scanner = yield* Scan.KinSecretScan;
    const sql = yield* SqlClient.SqlClient;
    const hash = NodeCrypto.createHash("sha256")
      .update("github-token\0")
      .update(github)
      .digest("hex");
    // Fixture stands in for the future APPR owner-signed executor; scanner has no write method.
    yield* sql`INSERT INTO kin_secret_allow VALUES (${orgId}, 'claims/test.md', 'github-token', ${hash}, 'signed-fixture', 0)`;
    const run = (org: KinOrgId, path: string, value = github) =>
      scanner.scan({ orgId: org, files: [{ path, content: Buffer.from(value) }] });
    expect((yield* run(orgId, "claims/test.md")).length).toBe(0);
    expect((yield* run(KinOrgId.make("other"), "claims/test.md")).length).toBeGreaterThan(0);
    expect((yield* run(orgId, "claims/other.md")).length).toBeGreaterThan(0);
    expect((yield* run(orgId, "claims/test.md", github.replace("a", "z"))).length).toBeGreaterThan(
      0,
    );
    expect(Object.keys(scanner)).toEqual(["scan"]);
    yield* sql`DROP TABLE kin_secret_allow`;
    expect((yield* run(orgId, "claims/test.md").pipe(Effect.result))._tag).toBe("Failure");
  }).pipe(Effect.provide(layer)),
);
it.effect("fails closed when decoded findings or the allowlist exceed their bounds", () =>
  Effect.gen(function* () {
    const scanner = yield* Scan.KinSecretScan;
    const content = Buffer.from(
      Array.from({ length: 1100 }, () => Buffer.from(github).toString("base64")).join("\n"),
    );
    expect(
      (yield* scanner
        .scan({ orgId, files: [{ path: "claims/many.md", content }] })
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    const sql = yield* SqlClient.SqlClient;
    yield* sql`WITH RECURSIVE entries(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM entries WHERE n < 4097)
    INSERT INTO kin_secret_allow SELECT ${orgId}, 'claims/' || n, 'github-token', ${"0".repeat(64)}, 'signed-fixture', 0 FROM entries`;
    expect((yield* scanner.scan({ orgId, files: [] }).pipe(Effect.result))._tag).toBe("Failure");
  }).pipe(Effect.provide(layer)),
);
it.effect("fails closed at file, batch and count limits", () =>
  Effect.gen(function* () {
    const scanner = yield* Scan.KinSecretScan;
    const scan = (files: { path: string; content: Uint8Array }[]) => scanner.scan({ orgId, files });
    for (const files of [
      [{ path: "huge", content: Buffer.alloc(1024 * 1024 + 1) }],
      Array.from({ length: 9 }, () => ({ path: "batch", content: Buffer.alloc(1024 * 1024) })),
      Array.from({ length: 1025 }, () => ({ path: "count", content: Buffer.alloc(0) })),
    ])
      expect((yield* scan(files).pipe(Effect.result))._tag).toBe("Failure");
    const content = Buffer.from(
      "a".repeat(1024 * 1024 - github.length - 1 - "large".length) + "\n" + github,
    );
    expect(
      (yield* scan([{ path: "large", content }])).some((f) => f.ruleId === "github-token"),
    ).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("near misses and private key headers", () =>
  Effect.gen(function* () {
    const scanner = yield* Scan.KinSecretScan;
    for (const content of [
      "task-follow-up-with-design-team-on-onboarding",
      "risk-follow-up-with-design-team-on-onboarding",
      "desk-follow-up-with-design-team-on-onboarding",
      "token: 0123456789abcdef0123456789abcdef01234567",
      "Password: https://vault.example.invalid/credentials/team",
      "secret: projects/example-project/secrets/database/versions/latest",
      "github_token_scopes: repo,workflow,admin:org,read:user",
      "postgres://user:${DB_PASSWORD}@example.invalid/db",
      "ASIAPACIFICREGION2026",
      ["sk-", "proj-2026-11-follow-up-with-design-team-on-onboarding"].join(""),
      ["sk-", "admin-rotation-plan-for-2026-q3-and-next-year"].join(""),
      "z".repeat(4096) + ["AK", "IA"].join("") + "Q".repeat(16),
      " ".repeat(8173) + ["AK", "IA"].join("") + "Q".repeat(16) + "z",
    ])
      expect(
        (yield* scanner.scan({
          orgId,
          files: [{ path: "claims/test.md", content: Buffer.from(content) }],
        })).length,
      ).toBe(0);
    for (const content of [
      "-----BEGIN PGP PRIVATE KEY BLOCK-----",
      "-----BEGIN CUSTOM PRIVATE KEY-----",
    ])
      expect(
        (yield* scanner.scan({
          orgId,
          files: [{ path: "claims/test.md", content: Buffer.from(content) }],
        })).some((f) => f.ruleId === "pem-private-key"),
      ).toBe(true);
  }).pipe(Effect.provide(layer)),
);
it.effect("scans paths without exposing them", () =>
  Effect.gen(function* () {
    const scanner = yield* Scan.KinSecretScan;
    const findings = yield* scanner.scan({
      orgId,
      files: [{ path: `claims/${github}.md`, content: Buffer.from("clean") }],
    });
    expect(findings.some((f) => f.ruleId === "github-token")).toBe(true);
    expect(JSON.stringify(findings).includes(github)).toBe(false);
    const indexFindings = yield* scanner.scan({
      orgId,
      files: [
        { path: "claims/item.md", content: Buffer.from("clean") },
        { path: "INDEX.md", content: Buffer.from("- [claim] " + github + " (claims/item.md)") },
      ],
    });
    expect(indexFindings.some((f) => f.itemPath === "claims/item.md")).toBe(true);
  }).pipe(Effect.provide(layer)),
);
it.effect("bounds adversarial rule inputs structurally", () =>
  Effect.gen(function* () {
    const scanner = yield* Scan.KinSecretScan;
    for (const prefix of ["eyJ", "sk-", "AKIA"]) {
      const content = prefix.repeat(Math.floor((1024 * 1024 - 100) / prefix.length));
      let examined = 0;
      for (const window of Scan.ruleWindows(content)) {
        expect(window.text.length).toBeLessThanOrEqual(8194);
        examined += window.text.length;
      }
      expect(examined).toBeLessThanOrEqual(
        content.length * 2 + Math.ceil(content.length / 4096) * 2,
      );
      expect(
        (yield* scanner.scan({
          orgId,
          files: [{ path: "claims/test.md", content: Buffer.from(content) }],
        })).length,
      ).toBe(0);
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("scans ordinary journals and multi-file batches without exhausting work", () =>
  Effect.gen(function* () {
    const scanner = yield* Scan.KinSecretScan;
    const journal = "Discussed the next steps with the team. Follow up tomorrow.\n";
    for (const files of [
      [
        {
          path: "journal/test.md",
          content: Buffer.from(journal.repeat(Math.ceil((256 * 1024) / journal.length))),
        },
      ],
      Array.from({ length: 30 }, (_, i) => ({
        path: `journal/${i}.md`,
        content: Buffer.from(journal.repeat(Math.ceil((60 * 1024) / journal.length))),
      })),
    ])
      expect((yield* scanner.scan({ orgId, files })).length).toBe(0);
  }).pipe(Effect.provide(layer)),
);

it.effect("bounds rule executions for random runs, word lines and multi-file inputs", () =>
  Effect.gen(function* () {
    const scanner = yield* Scan.KinSecretScan;
    let seed = 42;
    const random = (length: number) =>
      Array.from({ length }, () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[seed % 62];
      }).join("");
    const runs = Array.from({ length: Math.floor((1024 * 1024 - 100) / 25) }, () =>
      random(24),
    ).join(" ");
    const words = (Array.from({ length: 10 }, () => random(7)).join(" ") + "\n").repeat(13000);
    for (const files of [
      [{ path: "runs", content: Buffer.from(runs) }],
      [{ path: "words", content: Buffer.from(words) }],
      Array.from({ length: 8 }, (_, i) => ({ path: `runs-${i}`, content: Buffer.from(runs) })),
    ]) {
      let executions = 0;
      const exec = RegExp.prototype.exec;
      using _spy = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (
        this: RegExp,
        value: string,
      ) {
        if (this.source.startsWith("(?<![")) executions++;
        return exec.call(this, value);
      });
      const result = yield* scanner.scan({ orgId, files }).pipe(Effect.result);
      expect(result._tag).toBe("Success");
      expect(executions).toBeLessThanOrEqual(40000);
    }
  }).pipe(Effect.provide(layer)),
);
