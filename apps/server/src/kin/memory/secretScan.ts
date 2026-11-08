// @effect-diagnostics-next-line nodeBuiltinImport:off -- Bounded synchronous fingerprint hashing shares the scan loop.
import * as NodeCrypto from "node:crypto";
import * as SqlClient from "effect/sql/SqlClient";
import type { KinOrgId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";

export class KinSecretScanError extends Schema.TaggedError<KinSecretScanError>()(
  "KinSecretScanError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
export interface SecretFinding {
  readonly path: string;
  readonly ruleId: string;
  readonly line: number;
  readonly pathHit?: boolean;
  readonly itemPath?: string;
}
export class KinSecretScan extends Context.Service<
  KinSecretScan,
  {
    readonly scan: (input: {
      orgId: KinOrgId;
      files: ReadonlyArray<{ path: string; content: Uint8Array }>;
    }) => Effect.Effect<ReadonlyArray<SecretFinding>, KinSecretScanError>;
  }
>()("t3/kin/memory/secretScan/KinSecretScan") {}

const rules = [
  ["github-token", /(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82})/],
  ["anthropic-key", /sk-ant-[A-Za-z0-9_-]{40,200}/],
  [
    "openai-key",
    /sk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{32,200}|[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})/,
  ],
  ["aws-access-key", /(?:AKIA|ASIA)[A-Z0-9]{16}/],
  ["slack-token", /xox[abposr]-[A-Za-z0-9-]{20,200}/],
  ["stripe-key", /[rs]k_live_[A-Za-z0-9]{24,200}/],
  ["google-key", /AIza[A-Za-z0-9_-]{35}/],
  ["pem-private-key", /-----BEGIN (?:[A-Z0-9]+ ){0,8}PRIVATE KEY(?: BLOCK)?-----/],
  ["jwt", /eyJ[A-Za-z0-9_-]{5,2048}\.eyJ[A-Za-z0-9_-]{8,1024}/],
  ["url-password", /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]{1,512}:([^\s/@]{1,512})@/i],
  [
    "secret-assignment",
    /\b[A-Za-z0-9_]{0,64}(?:password|secret|token|api[_-]?key|access[_-]?key)[A-Za-z0-9_]{0,64}["']?\s{0,32}[:=]\s{0,32}["']?([^\s"';#]{20,512})/i,
  ],
] as const;
const compiledRules = rules.map(([id, pattern]) => {
  const alphabet =
    id === "github-token" || id === "aws-access-key" || id === "stripe-key" || id === "google-key"
      ? "A-Za-z0-9"
      : id === "slack-token"
        ? "A-Za-z0-9-"
        : "A-Za-z0-9_-";
  const right = ["url-password", "secret-assignment", "jwt"].includes(id)
    ? ""
    : `(?![${alphabet}])`;
  return [
    id,
    new RegExp(`(?<![A-Za-z0-9])(?:${pattern.source})${right}`, `${pattern.flags}g`),
  ] as const;
});
const anchors = /gh[pousr]_|github_pat_|sk-|AKIA|ASIA|xox|_live_|AIza|-----BEGIN|eyJ|:\/\/|[:=]/i;
// The 4096-character overlap exceeds the longest match (the 3080-character JWT prefix).
export const ruleWindows = function* (value: string) {
  for (let offset = 0; offset < value.length; offset += 4096)
    yield {
      text: value.slice(Math.max(0, offset - 1), offset + 8193),
      offset: Math.max(0, offset - 1),
      leftContext: offset > 0 ? 1 : 0,
      rightContext: offset + 8192 < value.length ? 1 : 0,
    };
};
const entropy = (value: string) => {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
};
// NFKC covers fullwidth forms; common Cyrillic/Greek confusables are normalized as well.
const lookalikes: Readonly<Record<string, string>> = {
  ѕ: "s",
  һ: "h",
  ο: "o",
  ɡ: "g",
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  х: "x",
  у: "y",
  і: "i",
  ј: "j",
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  Х: "X",
  Α: "A",
  Β: "B",
  Ε: "E",
  Ι: "I",
  Κ: "K",
  Μ: "M",
  Ν: "N",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Χ: "X",
};
const normalize = (text: string) =>
  text
    .normalize("NFKC")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .replace(/[ѕһοɡаеорсхуіјАВЕКМНОРСТХΑΒΕΙΚΜΝΟΡΤΧ]/g, (c) => lookalikes[c] ?? c);
const fingerprint = (ruleId: string, value: string) =>
  NodeCrypto.createHash("sha256").update(ruleId).update("\0").update(value).digest("hex");
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const scan = Effect.fn("KinSecretScan.scan")(function* (input: {
    orgId: KinOrgId;
    files: ReadonlyArray<{ path: string; content: Uint8Array }>;
  }) {
    if (
      input.files.length > 1024 ||
      input.files.some((f) => f.content.byteLength + Buffer.byteLength(f.path) > 1024 * 1024) ||
      input.files.reduce((sum, f) => sum + f.content.byteLength + Buffer.byteLength(f.path), 0) >
        8 * 1024 * 1024
    )
      return yield* new KinSecretScanError({ reason: "Scan size limit exceeded" });
    // No mutation API: the owner-signed action executor owns allowlist insertion.
    const allowed = yield* sql<{ path: string; rule_id: string; fingerprint: string }>`
      SELECT path, rule_id, fingerprint FROM kin_secret_allow WHERE org_id = ${input.orgId} LIMIT 4097
    `.pipe(
      Effect.mapError(toPersistenceSqlError("KinSecretScan.allowlist")),
      Effect.mapError(
        (cause) => new KinSecretScanError({ reason: "Allowlist unavailable", cause }),
      ),
    );
    if (allowed.length > 4096)
      return yield* new KinSecretScanError({ reason: "Allowlist size limit exceeded" });
    const allow = new Set(allowed.map((r) => JSON.stringify([r.path, r.rule_id, r.fingerprint])));
    const findings: SecretFinding[] = [];
    const seen = new Set<string>();
    let budget = 64 * 1024 * 1024;
    for (const file of input.files) {
      const text = normalize(Buffer.from(file.content).toString("utf8"));
      const lines = text.split("\n");
      const pathFindingStart = findings.length;
      let pathHit = true;
      let redactPath = false;
      const inspect = function* (value: string, baseLine: number, depth: number): Generator<void> {
        budget -= value.length;
        if (budget < 0 || findings.length > 1024) return;
        for (const window of ruleWindows(value)) {
          budget -= window.text.length;
          if (budget < 0) return;
          yield;
          if (!anchors.test(window.text)) continue;
          for (const [ruleId, bounded] of compiledRules) {
            bounded.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = bounded.exec(window.text)) !== null) {
              budget -= 64;
              if (budget < 0) return;
              if (
                match.index < window.leftContext ||
                match.index + match[0].length > window.text.length - window.rightContext
              )
                continue;
              const index = window.offset + match.index;
              const secret = match[1] ?? match[0];
              if (ruleId === "openai-key" && !/[A-Z]/.test(secret)) continue;
              if (ruleId === "url-password" && /^\$\{[^}]+\}$/.test(secret)) continue;
              if (
                ruleId === "secret-assignment" &&
                (entropy(secret) < 3.5 ||
                  /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(secret) ||
                  /^https?:\/\//i.test(secret) ||
                  /^projects\/[^/]+\/(?:locations\/[^/]+\/)?secrets\//.test(secret) ||
                  /^[^:=]*token_scopes\s*[:=]/i.test(match[0]))
              )
                continue;
              if (allow.has(JSON.stringify([file.path, ruleId, fingerprint(ruleId, secret)])))
                continue;
              const line = baseLine + (value.slice(0, index).match(/\n/g)?.length ?? 0);
              const key = JSON.stringify([file.path, ruleId, line, pathHit]);
              if (!seen.has(key)) {
                const indexLine = file.path === "INDEX.md" ? lines[line - 1] : undefined;
                const itemPath = Array.from(indexLine?.matchAll(/\(([^()]+\.md)\)/g) ?? []).at(
                  -1,
                )?.[1];
                seen.add(key);
                findings.push({
                  path: pathHit || redactPath ? "[redacted]" : file.path,
                  ruleId,
                  line,
                  ...(pathHit ? { pathHit: true } : {}),
                  ...(itemPath && input.files.some((f) => f.path === itemPath) ? { itemPath } : {}),
                });
              }
              break;
            }
          }
        }
        if (depth === 2) return;
        let cursor = 0;
        let decodedLine = baseLine;
        for (const match of value.matchAll(/(?:%[0-9a-fA-F]{2}|[A-Za-z0-9_+/-]){20,}={0,2}/g)) {
          const encoded = match[0];
          // Mixed percent/plain encodings can represent 20 bytes in fewer than 60 characters.
          if (!encoded.includes("%") && encoded.length < 27) continue;
          decodedLine += value.slice(cursor, match.index).match(/\n/g)?.length ?? 0;
          cursor = match.index;
          yield;
          budget -= encoded.length;
          if (budget < 0) return;
          const candidates = encoded.includes("%")
            ? [
                Buffer.from(
                  encoded.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
                    String.fromCharCode(Number.parseInt(hex, 16)),
                  ),
                  "latin1",
                ).toString("utf8"),
              ]
            : Array.from({ length: 4 }, (_, alignment) =>
                Buffer.from(encoded.slice(alignment), "base64url").toString("utf8"),
              );
          for (const candidate of candidates) {
            if (budget < 0 || findings.length > 1024) return;
            const decoded = normalize(candidate).replace(/[^\x09\x0a\x0d\x20-\x7e]/g, " ");
            if (decoded !== encoded) yield* inspect(decoded, decodedLine, depth + 1);
          }
        }
      };
      for (const _ of inspect(normalize(file.path), 1, 0)) yield* Effect.yieldNow;
      redactPath = findings.length > pathFindingStart;
      pathHit = false;
      for (const _ of inspect(text, 1, 0)) yield* Effect.yieldNow;
      let run: { text: string; line: number }[] = [];
      const append = function* (text: string, line: number): Generator<void> {
        run.push({ text, line });
        while (run.length > 8 || run.reduce((sum, part) => sum + part.text.length, 0) > 4096)
          run.shift();
        if (run.length > 1) yield* inspect(run.map((part) => part.text).join(""), run[0]!.line, 0);
      };
      for (const [index, raw] of lines.entries()) {
        const words = raw
          .replace(/\\?\r$/, "")
          .replace(/\\$/, "")
          .trim()
          .split(/\s+/);
        const first = words[0]!;
        if (!first) {
          run = [];
          continue;
        }
        for (const _ of append(first, index + 1)) yield* Effect.yieldNow;
        if (words.length > 1) run = [{ text: words.at(-1)!, line: index + 1 }];
      }
    }
    if (budget < 0 || findings.length > 1024)
      return yield* new KinSecretScanError({ reason: "Scan work limit exceeded" });
    const unsafePaths = findings.some((f) => f.pathHit);
    return findings.map(({ itemPath, ...finding }) => ({
      ...finding,
      ...(itemPath && !unsafePaths ? { itemPath } : {}),
    }));
  });
  return KinSecretScan.of({ scan });
});
export const layer = Layer.effect(KinSecretScan, make);
