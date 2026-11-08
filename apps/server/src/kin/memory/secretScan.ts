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
  ["jwt", /eyJ[A-Za-z0-9_-]{5,1024}\.[A-Za-z0-9_-]{8,1024}\.[A-Za-z0-9_-]{16,1024}/],
  ["url-password", /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]{1,512}:([^\s/@]{1,512})@/i],
  [
    "secret-assignment",
    /\b[A-Za-z0-9_]{0,64}(?:password|secret|token|api[_-]?key|access[_-]?key)[A-Za-z0-9_]{0,64}\s{0,32}[:=]\s{0,32}["']?([^\s"';#]{20,512})/i,
  ],
] as const;
// Every rule sees bounded windows; overlap exceeds the longest possible match (a JWT).
export const ruleWindows = function* (value: string) {
  for (let offset = 0; offset < value.length; offset += 4096)
    yield { text: value.slice(offset, offset + 8192), offset };
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
    let budget = 32 * 1024 * 1024;
    for (const file of input.files) {
      const text = normalize(Buffer.from(file.content).toString("utf8"));
      const pathFindingStart = findings.length;
      let pathHit = true;
      let redactPath = false;
      const inspect = (
        value: string,
        baseLine: number,
        depth: number,
        lineAt?: Uint32Array,
      ): void => {
        budget -= value.length;
        if (budget < 0 || findings.length > 1024) return;
        for (const [ruleId, pattern] of rules) {
          for (const window of ruleWindows(value)) {
            const bounded = new RegExp(
              `(?<![A-Za-z0-9_-])(?:${pattern.source})${ruleId === "url-password" ? "" : "(?![A-Za-z0-9_-])"}`,
              `${pattern.flags}g`,
            );
            for (const match of window.text.matchAll(bounded)) {
              const index = window.offset + match.index;
              const secret = match[1] ?? match[0];
              if (
                ruleId === "openai-key" &&
                !((/[A-Z]/.test(secret) && /[a-z]/.test(secret)) || /[0-9]/.test(secret))
              )
                continue;
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
              const line =
                lineAt?.[index] ?? baseLine + (value.slice(0, index).match(/\n/g)?.length ?? 0);
              const key = JSON.stringify([file.path, ruleId, line, pathHit]);
              if (!seen.has(key)) {
                seen.add(key);
                findings.push({
                  path: pathHit || redactPath ? "[redacted]" : file.path,
                  ruleId,
                  line,
                  ...(pathHit ? { pathHit: true } : {}),
                });
              }
              break;
            }
          }
        }
        if (depth === 2) return;
        let cursor = 0;
        let decodedLine = baseLine;
        for (const match of value.matchAll(/(?:%[0-9a-fA-F]{2}|[A-Za-z0-9_+/-]){24,}={0,2}/g)) {
          decodedLine += value.slice(cursor, match.index).match(/\n/g)?.length ?? 0;
          cursor = match.index;
          const encoded = match[0];
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
            if (decoded !== encoded)
              inspect(decoded, lineAt?.[match.index] ?? decodedLine, depth + 1);
          }
        }
      };
      inspect(normalize(file.path), 1, 0);
      redactPath = findings.length > pathFindingStart;
      pathHit = false;
      inspect(text, 1, 0);
      const lineAt = new Uint32Array(text.length);
      let line = 1;
      let offset = 0;
      const starts = new Set<number>();
      const compact = text.replace(/\\?\r?\n[\t ]*|[^\r\n\\]+|./g, (chunk) => {
        if (chunk.includes("\n")) {
          line++;
          starts.add(offset);
          return "";
        }
        lineAt.fill(line, offset, offset + chunk.length);
        offset += chunk.length;
        return chunk;
      });
      inspect(compact, 1, 0, lineAt);
      // A wrapped token may start after prose that compacting joined to its left boundary.
      for (const start of starts) {
        if (budget < 0 || findings.length > 1024) break;
        inspect(compact.slice(start, start + 8192), lineAt[start] ?? 1, 0, lineAt.subarray(start));
      }
    }
    if (budget < 0 || findings.length > 1024)
      return yield* new KinSecretScanError({ reason: "Scan work limit exceeded" });
    return findings;
  });
  return KinSecretScan.of({ scan });
});
export const layer = Layer.effect(KinSecretScan, make);
