import { secretExceptions, secretRules } from "./secretScan.ts";

const space = String.raw`\s\v\p{Z}\x{feff}`;

// RE2 caps counted repeats at 1000, has no lookarounds and its \s misses \v and Unicode spaces.
// Boundaries are dropped rather than emulated: a consuming boundary would hide an adjacent match.
const re2 = (pattern: RegExp) => {
  let source = "";
  let inClass = false;
  for (let index = 0; index < pattern.source.length; index++) {
    const char = pattern.source[index]!;
    if (char === "\\") {
      const next = pattern.source[++index]!;
      if (next === "S") throw new Error(`\\S has no RE2 translation: ${pattern.source}`);
      source += next === "s" ? (inClass ? space : `[${space}]`) : `\\${next}`;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    source += char;
  }
  source = source.replace(/\{(\d+),(\d+)\}/g, (all, min: string, max: string) =>
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
  const exception = secretExceptions[id];
  return [
    "[[rules]]",
    `id = "${id}"`,
    `description = "KinSecretScan ${id}"`,
    `regex = ${literal(re2(pattern))}`,
    ...(groups > 0 ? ["secretGroup = 1"] : []),
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
