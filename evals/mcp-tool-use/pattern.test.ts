// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";

import { casePattern } from "./pattern.ts";

/** Each call compiles afresh and tests three times: a grade must not depend on earlier calls. */
const results = (pattern: string, subject: string) =>
  [1, 2].flatMap(() => {
    const re = casePattern(pattern);
    return [re.test(subject), re.test(subject), re.test(subject)];
  });

it.each([
  ["(?i:(8 nov|8th))", "from 8 November", true],
  ["(?i:(8 nov|nov(ember)? 8))", "from 8 November", true],
  ["(?i:(8 nov|nov(ember)? 8|2026-11-08|08/11|8th))", "Statement from 8 November", true],
  ["(?i:(8 nov|8th))", "from 9 November", false],
] as const)("matches %s on %s the same way on every call", (pattern, subject, expected) => {
  assert.deepStrictEqual(results(pattern, subject), Array(6).fill(expected));
});

// Patterns with case-sensitive text outside their (?i:) groups, which the reference below can't
// judge, and flags beyond i.
it.each([
  ["(?i:rotate|revoke|regenerate) (?:this|the|that) key", "ROTATE this key", true],
  ["(?i:rotate|revoke|regenerate) (?:this|the|that) key", "rotate THIS key", false],
  ["/(?i:sign-?up)\\b", "/Sign-Up now", true],
  ["\\bgoto\\(\\s*'[^']*/(?i:sign-?up)", "GOTO('/signup", false],
  ["q(?i:[^a-c])", "qB", false],
  ["q(?i:[^a-c])", "qd", true],
  ["Q(?i:\\x41)", "Qa", true],
  ["Q(?i:\\x41)", "qa", false],
  ["(?m:^##\\s+(?i:needs you|money)\\s*$)", "x\n## MONEY\ny", true],
  ["(?m:^##\\s+\\S)", "intro\n## Work", true],
  ["^\\s*(?i:good morning|morning)\\b", "Good Morning, all", true],
  ["^\\s*(?i:good morning|morning)\\b", "Hi. Good morning", false],
] as const)("matches %s on %s as the flag means", (pattern, subject, expected) => {
  assert.deepStrictEqual(results(pattern, subject), Array(6).fill(expected));
});

it.each([
  ["a flag turned off", "(?i:a(?-i:b))"],
  ["m that cannot be hoisted", "(?m:^a)$"],
  ["a backreference under i", "(a)b(?i:\\1)"],
])("refuses %s", (_, pattern) => {
  assert.throws(() => casePattern(pattern));
});

// Every case pattern that uses (?i:), against a reference that lower-cases the pattern's letters
// and the subject. That is the i flag exactly when no letter sits outside an (?i:) group.
const CASES = NodePath.join(import.meta.dirname, "cases");
const strings = (value: unknown): ReadonlyArray<string> =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : typeof value === "object" && value !== null
        ? Object.values(value).flatMap(strings)
        : [];
const patterns = NodeFS.readdirSync(CASES)
  .filter((name) => name.endsWith(".ndjson"))
  .flatMap((name) =>
    NodeFS.readFileSync(NodePath.join(CASES, name), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        const testCase = JSON.parse(line) as { id: string; prompt: string; expect: unknown };
        return strings(testCase.expect)
          .filter((pattern) => pattern.includes("(?i:"))
          .map((pattern) => ({ id: testCase.id, pattern, prompt: testCase.prompt }));
      }),
  );

/** The pattern with each (?i:…) group's text removed, read by its own small scanner. */
const outsideGroups = (pattern: string) => {
  let out = "";
  let depth = 0;
  const opened: Array<boolean> = [];
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "\\") {
      if (depth === 0) out += pattern.slice(i, i + 2);
      i++;
    } else if (char === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (depth === 0) out += pattern.slice(i, end + 1);
      i = end;
    } else if (char === "(") {
      const group = pattern.startsWith("(?i:", i);
      opened.push(group);
      if (group) depth++;
      else if (depth === 0) out += char;
    } else if (char === ")") {
      if (opened.pop()) depth--;
      else if (depth === 0) out += char;
    } else if (depth === 0) out += char;
  }
  return out;
};
const lowered = (pattern: string) =>
  pattern
    .replaceAll("(?i:", "(?:")
    .replace(/\\[\s\S]|[A-Z]/g, (match) => (match.length === 2 ? match : match.toLowerCase()));
/** Text the pattern names, in several cases, and the case's own prompt. */
const subjects = (pattern: string, prompt: string) => {
  const words = [...pattern.replace(/\\[\s\S]/g, " ").matchAll(/[A-Za-z][A-Za-z' -]{2,}/g)].map(
    (match) => match[0].trim(),
  );
  const title = (word: string) => word.replace(/\b[a-z]/g, (char) => char.toUpperCase());
  return [
    prompt,
    words.join(" "),
    ...words.flatMap((word) => [
      word,
      word.toUpperCase(),
      title(word),
      `Note: ${title(word)} today.`,
      `- ${word.toUpperCase()}\n`,
    ]),
  ];
};

const judged = patterns.filter(({ pattern }) => !/(?<!\\)[A-Za-z]/.test(outsideGroups(pattern)));

it("finds the case patterns that use (?i:)", () => {
  assert.isAbove(patterns.length, 400);
  assert.isAbove(judged.length, patterns.length - 10);
});

it.each(judged.map(({ id, pattern, prompt }) => [id, pattern, prompt] as const))(
  "%s: %s matches as with the subject lower-cased",
  (_, pattern, prompt) => {
    const reference = new RegExp(lowered(pattern));
    for (const subject of subjects(pattern, prompt)) {
      const expected = reference.test(subject.toLowerCase());
      assert.deepStrictEqual(results(pattern, subject), Array(6).fill(expected), subject);
    }
  },
);
