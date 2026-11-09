import { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { YAMLError } from "yaml";

import { parseFrontMatter, type MemoryItemError } from "./frontMatter.ts";
import { folders, maxBlobBytes } from "./Memory.ts";

export interface LintFailure {
  readonly path: string;
  readonly line: number;
  readonly reason: string;
}

const orgId = KinOrgId.make("memory-lint");
const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

export interface MemoryTreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly content?: Uint8Array;
}

const codeowners = ".github/CODEOWNERS";
const kinOnlyPaths = ["/commitments/", "/deferrals/", "/claims/", "/journal/", "/INDEX.md"];
const kinOnlyRoots = kinOnlyPaths.map((pattern) => pattern.slice(1).replace(/\/$/, ""));
const regularModes = ["100644", "100755"];
/** CODEOWNERS denies by default: every path outside Kin's own folders waits for owner review. */
export const isOwnerReviewedPath = (path: string) =>
  !kinOnlyRoots.includes(path.split("/")[0] ?? "");

export const isLintedPath = (path: string) =>
  path === "rules.md" ||
  path === codeowners ||
  path === "INDEX.md" ||
  (path.endsWith(".md") && folders.some((folder) => path.startsWith(`${folder}/`)));

// CODEOWNERS cannot negate a pattern, so nothing but Kin's own shapes may live under its paths.
// Agent instruction files would be loaded by any agent that reads the folder; keep this in step
// with the providers' nested context-file names. User-configured names are out of reach.
const agentFiles = /^(claude|agents?|gemini|grok|crush|qwen|warp|skill)$/i;
const itemPath = /^(?:commitments|deferrals|claims)\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,199})\.md$/;
const journalPath = /^journal\/\d{4}\/(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\.md$/;

/** The shape check alone, for Kin's writers: a path they write must also pass `memory-check`. */
export const kinShapeFailure = (path: string) => {
  const [root, ...rest] = path.split("/");
  if (!kinOnlyRoots.includes(root ?? "")) return undefined;
  if (root === "INDEX.md") return rest.length ? "INDEX.md must be a file" : undefined;
  if (rest.some((segment) => segment.startsWith(".")))
    return "Hidden paths are not allowed in Kin's unowned folders";
  const item = itemPath.exec(path)?.[1];
  if (journalPath.test(path) || (item !== undefined && !agentFiles.test(item))) return undefined;
  return "Kin's unowned folders only hold item and journal files";
};

const entryFailure = ({ path, mode }: MemoryTreeEntry) => {
  if (mode === "120000") return "Symlinks are not allowed";
  if (mode === "160000") return "Submodules are not allowed";
  if (!regularModes.includes(mode)) return "Not a regular file";
  return kinShapeFailure(path);
};

const keyLine = (text: string, key: string) => {
  const index = text.split("\n").findIndex((line) => line.startsWith(`${key}:`));
  return index === -1 ? 1 : index + 1;
};

// Deny by default: the owner owns everything but Kin's own paths, which is exactly the template.
const codeownersFailures = (text: string) => {
  const failures: Array<{ line: number; reason: string }> = [];
  const rules = text.split(/\r?\n/).flatMap((raw, index) => {
    const tokens = raw.trim().split(/\s+/);
    const end = tokens.findIndex((token) => token.startsWith("#"));
    const [pattern, ...owners] = end === -1 ? tokens : tokens.slice(0, end);
    return pattern ? [{ line: index + 1, pattern, owners }] : [];
  });
  for (const rule of rules)
    if (rule.owners.some((owner) => owner.toLowerCase() === "@owner"))
      failures.push({ line: rule.line, reason: "CODEOWNERS still names the @OWNER placeholder" });
  const [first, ...rest] = rules;
  if (first?.pattern !== "*" || first.owners.length === 0)
    failures.push({ line: first?.line ?? 1, reason: "CODEOWNERS must start with * and the owner" });
  for (const rule of rest)
    if (!kinOnlyPaths.includes(rule.pattern) || rule.owners.length > 0)
      failures.push({
        line: rule.line,
        reason: "CODEOWNERS may only leave Kin's own paths unowned after the * line",
      });
  for (const path of kinOnlyPaths)
    if (!rest.some((rule) => rule.pattern === path))
      failures.push({ line: 1, reason: `CODEOWNERS lacks the ${path} line` });
  return failures;
};

const dateField =
  /^Invalid (recorded_at|valid_from|invalid_at|review_by|due); date-times require an explicit offset$/;

// Reasons never quote the file: YAML and schema messages embed the offending source.
const describe = (error: MemoryItemError, text: string): { line: number; reason: string } => {
  const field = dateField.exec(error.reason)?.[1];
  if (field) return { line: keyLine(text, field), reason: error.reason };
  if (error.reason === "Unknown field in on condition")
    return { line: keyLine(text, "on"), reason: error.reason };
  if (error.reason === "Invalid front matter schema" && Schema.isSchemaError(error.cause)) {
    const issue = formatIssue(error.cause.issue).issues[0];
    const key = issue?.path?.map(String).join(".") ?? "";
    const top = key.split(".")[0] ?? "";
    if (!top) return { line: 1, reason: error.reason };
    return issue?.message === "Missing key"
      ? { line: 1, reason: `Missing required key ${key}` }
      : { line: keyLine(text, top), reason: `Invalid value for key ${key}` };
  }
  if (error.reason.startsWith("Malformed YAML")) {
    const problem = error.cause instanceof Error ? error.cause.cause : undefined;
    const line = problem instanceof YAMLError ? (problem.linePos?.[0].line ?? 0) + 1 : 1;
    return {
      line,
      reason:
        error.reason === "Malformed YAML; links containing # must be quoted"
          ? error.reason
          : "Malformed YAML",
    };
  }
  return {
    line: 1,
    reason:
      error.reason === "Missing front matter delimiters" ? error.reason : "Malformed memory item",
  };
};

// Paths come from the checkout: a newline could forge a log line or a workflow command.
export const formatLintFailure = (failure: LintFailure) =>
  `${failure.path.replace(/[\p{Cc}\p{Cf}\u2028\u2029\\]/gu, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`)}:${failure.line} ${failure.reason}`;

/** Checks the whole tree: Kin's unowned paths against an allowlist, memory files the way `Memory.load` reads them. */
export const lintMemoryFiles = Effect.fn("MemoryLint.lint")(function* (
  files: ReadonlyArray<MemoryTreeEntry>,
) {
  const failures: Array<LintFailure> = [];
  const ids = new Map<string, string>();
  if (!files.some((file) => file.path === "rules.md"))
    failures.push({ path: "rules.md", line: 1, reason: "Missing rules.md" });
  if (!files.some((file) => file.path === codeowners))
    failures.push({ path: codeowners, line: 1, reason: `Missing ${codeowners}` });
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const shape = entryFailure(file);
    if (shape !== undefined) {
      failures.push({ path: file.path, line: 1, reason: shape });
      continue;
    }
    if (!isLintedPath(file.path)) continue;
    if (file.content === undefined) {
      failures.push({ path: file.path, line: 1, reason: "Unreadable file" });
      continue;
    }
    if (file.content.byteLength > maxBlobBytes) {
      failures.push({ path: file.path, line: 1, reason: `Larger than ${maxBlobBytes} bytes` });
      continue;
    }
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(file.content),
      catch: () => "Not valid UTF-8",
    }).pipe(Effect.result);
    if (text._tag === "Failure") {
      failures.push({ path: file.path, line: 1, reason: text.failure });
      continue;
    }
    if (file.path === codeowners) {
      failures.push(...codeownersFailures(text.success).map((f) => ({ path: file.path, ...f })));
      continue;
    }
    if (!folders.some((folder) => file.path.startsWith(`${folder}/`))) continue;
    const parsed = yield* parseFrontMatter(orgId, file.path, text.success).pipe(Effect.result);
    if (parsed._tag === "Failure") {
      failures.push({ path: file.path, ...describe(parsed.failure, text.success) });
      continue;
    }
    const { kind, id } = parsed.success.frontMatter;
    const folder = kind === "person" ? "people" : `${kind}s`;
    if (!file.path.startsWith(`${folder}/`)) {
      failures.push({
        path: file.path,
        line: keyLine(text.success, "kind"),
        reason: "Memory kind does not match folder",
      });
      continue;
    }
    const first = ids.get(id);
    if (first !== undefined)
      failures.push({
        path: file.path,
        line: keyLine(text.success, "id"),
        reason: `Duplicate id, also in ${first}`,
      });
    else ids.set(id, file.path);
  }
  return failures;
});
