// @effect-diagnostics-next-line nodeBuiltinImport:off -- Bounded synchronous fingerprint hashing shares the scan loop.
import * as NodeCrypto from "node:crypto";
import * as SqlClient from "effect/sql/SqlClient";
import type { KinOrgId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class KinSecretScanError extends Schema.TaggedError<KinSecretScanError>()(
  "KinSecretScanError",
  {
    reason: Schema.String,
  },
) {}
export interface SecretFinding {
  readonly path: string;
  readonly ruleId: string;
  readonly line: number;
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
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82})\b/],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{40,200}\b/],
  ["openai-key", /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,200}\b/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{20,200}\b/],
  ["stripe-key", /\b[rs]k_live_[A-Za-z0-9]{24,200}\b/],
  ["google-key", /\bAIza[A-Za-z0-9_-]{35}\b/],
  ["pem-private-key", /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{5,8192}\.[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{16,8192}\b/],
  ["url-password", /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]{1,512}:([^\s/@]{1,512})@/i],
  [
    "secret-assignment",
    /\b[A-Za-z0-9_]{0,64}(?:password|secret|token|api[_-]?key|access[_-]?key)[A-Za-z0-9_]{0,64}\s*[:=]\s*["']?([^\s"';#]{20,512})/i,
  ],
] as const;
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
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFFD]/g, "")
    .replace(/[аеорсхуіјАВЕКМНОРСТХΑΒΕΙΚΜΝΟΡΤΧ]/g, (c) => lookalikes[c] ?? c);
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
      input.files.some((f) => f.content.byteLength > 1024 * 1024) ||
      input.files.reduce((sum, f) => sum + f.content.byteLength, 0) > 8 * 1024 * 1024
    )
      return yield* new KinSecretScanError({ reason: "Scan size limit exceeded" });
    // No mutation API: the owner-signed action executor owns allowlist insertion.
    const allowed = yield* sql<{ path: string; rule_id: string; fingerprint: string }>`
      SELECT path, rule_id, fingerprint FROM kin_secret_allow WHERE org_id = ${input.orgId} LIMIT 4097
    `.pipe(Effect.mapError(() => new KinSecretScanError({ reason: "Allowlist unavailable" })));
    if (allowed.length > 4096)
      return yield* new KinSecretScanError({ reason: "Allowlist size limit exceeded" });
    const allow = new Set(allowed.map((r) => JSON.stringify([r.path, r.rule_id, r.fingerprint])));
    const findings: SecretFinding[] = [];
    const seen = new Set<string>();
    let budget = 32 * 1024 * 1024;
    for (const file of input.files) {
      const text = normalize(Buffer.from(file.content).toString("utf8"));
      const inspect = (
        value: string,
        baseLine: number,
        depth: number,
        compact = false,
        lineAt?: Uint32Array,
      ): void => {
        budget -= value.length;
        if (budget < 0 || findings.length > 1024) return;
        for (const [ruleId, pattern] of rules) {
          for (const match of value.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))) {
            const secret = match[1] ?? match[0];
            if (ruleId === "secret-assignment" && entropy(secret) < 3.5) continue;
            if (allow.has(JSON.stringify([file.path, ruleId, fingerprint(ruleId, secret)])))
              continue;
            const line =
              lineAt?.[match.index] ??
              baseLine + (value.slice(0, match.index).match(/\n/g)?.length ?? 0);
            const key = JSON.stringify([file.path, ruleId, line]);
            if (!seen.has(key)) {
              seen.add(key);
              findings.push({ path: file.path, ruleId, line });
            }
            break;
          }
        }
        if (depth === 2 || compact) return;
        let cursor = 0;
        let decodedLine = baseLine;
        for (const match of value.matchAll(/(?:%[0-9a-fA-F]{2}|[A-Za-z0-9_+/-]){24,}={0,2}/g)) {
          decodedLine += value.slice(cursor, match.index).match(/\n/g)?.length ?? 0;
          cursor = match.index;
          const encoded = match[0];
          let decoded: string;
          if (encoded.includes("%")) {
            try {
              decoded = decodeURIComponent(encoded);
            } catch {
              continue;
            }
          } else {
            decoded = Buffer.from(encoded, "base64url").toString("utf8");
            if (!/^[\x09\x0a\x0d\x20-\x7e]+$/.test(decoded)) continue;
          }
          if (decoded === encoded) continue;
          inspect(normalize(decoded), decodedLine, depth + 1);
        }
      };
      inspect(text, 1, 0);
      const lineAt = new Uint32Array(text.length);
      let line = 1;
      let offset = 0;
      const compact = text.replace(/\\?\r?\n[\t ]*|[^\r\n\\]+|./g, (chunk) => {
        if (chunk.includes("\n")) {
          line++;
          return "";
        }
        lineAt.fill(line, offset, offset + chunk.length);
        offset += chunk.length;
        return chunk;
      });
      inspect(compact, 1, 2, true, lineAt);
    }
    if (budget < 0 || findings.length > 1024)
      return yield* new KinSecretScanError({ reason: "Scan work limit exceeded" });
    return findings;
  });
  return KinSecretScan.of({ scan });
});
export const layer = Layer.effect(KinSecretScan, make);
