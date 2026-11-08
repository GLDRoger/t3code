import { leftBoundary, rightBoundary, secretExceptions, secretRules } from "./secretScan.ts";

// RE2 caps counted repeats at 1000 and has no lookarounds, so bounds widen and boundaries become groups.
const re2 = (pattern: RegExp) => {
  const source = pattern.source.replace(/\{(\d+),(\d+)\}/g, (all, min: string, max: string) =>
    Number(max) > 1000 ? `{${min},}` : all,
  );
  return pattern.flags.includes("i") ? `(?i:${source})` : source;
};

const literal = (value: string) => {
  if (value.includes("'''")) throw new Error(`Pattern cannot be a TOML literal: ${value}`);
  return `'''${value}'''`;
};

const rule = ([id, pattern]: (typeof secretRules)[number]) => {
  const groups = (new RegExp(`${pattern.source}|`).exec("")?.length ?? 1) - 1;
  const right = rightBoundary(id);
  const exception = secretExceptions[id];
  return [
    "[[rules]]",
    `id = "${id}"`,
    `description = "KinSecretScan ${id}"`,
    `regex = ${literal(`(?:^|[^${leftBoundary}])(${re2(pattern)})${right === undefined ? "" : `(?:[^${right}]|$)`}`)}`,
    `secretGroup = ${groups > 0 ? 2 : 1}`,
    ...(exception?.minEntropy === undefined ? [] : [`entropy = ${exception.minEntropy}`]),
    ...(["secret", "match"] as const).flatMap((target) => {
      const patterns = exception?.[target]?.map((p) => literal(re2(p)));
      if (patterns === undefined) return [];
      // Wrapped the way the repo formatter wraps TOML arrays past 100 columns.
      const inline = `regexes = [${patterns.join(", ")}]`;
      return [
        "",
        "[[rules.allowlists]]",
        `regexTarget = "${target}"`,
        ...(inline.length <= 100
          ? [inline]
          : ["regexes = [", ...patterns.map((p) => `  ${p},`), "]"]),
      ];
    }),
  ].join("\n");
};

export const gitleaksToml = [
  [
    "# Generated from apps/server/src/kin/memory/secretScan.ts; do not edit.",
    "# Regenerate: node apps/server/src/kin/memory/gitleaksConfig.ts > ops/kin/memory-repo/gitleaks.toml",
    'title = "kin-memory"',
  ].join("\n"),
  ...secretRules.map(rule),
].join("\n\n");

if (import.meta.main) process.stdout.write(`${gitleaksToml}\n`);
