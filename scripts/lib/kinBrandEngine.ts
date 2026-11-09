// The rewrite engine behind scripts/kin-brand.ts: rules, literal collection, matching and globbing.
import { Lang, parse, type Edit, type SgNode } from "@ast-grep/napi";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const UPSTREAM_NAME = "T3 Code";

export class KinBrandError extends Schema.TaggedError<KinBrandError>()("KinBrandError", {
  message: Schema.String,
}) {}

// Rewrites edit raw source text, so a rule's text must not need escaping; see `quoted`.
const RuleText = Schema.String.check(Schema.isPattern(/^[^\\]*$/));
const Globs = Schema.NonEmptyArray(Schema.String);

const TextRule = Schema.Struct({
  files: Globs,
  from: RuleText.check(Schema.isMinLength(1)),
  to: RuleText,
  exact: Schema.optional(Schema.Boolean),
});
const IgnoreRule = Schema.Struct({
  reason: Schema.NonEmptyString,
  files: Schema.optional(Globs),
  text: Schema.optional(Schema.NonEmptyString),
});
const LeakAllow = Schema.Struct({
  reason: Schema.NonEmptyString,
  leak: Schema.optional(Schema.NonEmptyString),
  files: Schema.optional(Globs),
  text: Schema.optional(Schema.NonEmptyString),
});
const RemoveEntry = Schema.Struct({ reason: Schema.NonEmptyString, files: Globs });
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const BrandRules = Schema.Struct({
  text: Schema.Array(TextRule),
  ignore: Schema.Array(IgnoreRule),
  leaks: Schema.Struct({ allow: Schema.Array(LeakAllow) }),
  remove: Schema.optional(Schema.Array(RemoveEntry)),
  sourceAssets: Schema.optional(Schema.Record(Schema.String, Sha256)),
});
export type BrandRules = typeof BrandRules.Type;
export type TextRule = typeof TextRule.Type;

const decodeBrandRules = Schema.decodeEffect(fromYaml(BrandRules));

export const parseBrandRules = (source: string) =>
  decodeBrandRules(source).pipe(
    Effect.flatMap((rules) => {
      const unknownLeak = rules.leaks.allow.find(
        (entry) => entry.leak !== undefined && !LEAK_PATTERNS.some(({ id }) => id === entry.leak),
      );
      const unscoped = rules.leaks.allow.find((entry) => !entry.files && !entry.text);
      if (unknownLeak) return Effect.fail(`unknown leak id ${JSON.stringify(unknownLeak.leak)}`);
      if (unscoped) return Effect.fail(`leak allow entry needs files or text: ${unscoped.reason}`);
      return Effect.succeed(rules);
    }),
    Effect.mapError(
      (cause) => new KinBrandError({ message: `invalid rules file: ${String(cause)}` }),
    ),
  );

/**
 * Identity strings that must be gone from the branded copy. A hit fails `--check` unless
 * `leaks.allow` in rules.yaml covers it, with a reason.
 */
export const LEAK_PATTERNS = [
  { id: "scheme-link", pattern: /\bt3code(?:-dev|-preview)?:\/\// },
  // A literal that is only the scheme or protocol, or a regex anchored on it.
  { id: "scheme-name", pattern: /^\^?t3code(?:-dev|-preview)?(?::?$|\()/ },
  { id: "bundle-id", pattern: /com\.t3tools\.t3code/ },
  { id: "t3-home", pattern: /(?:^|[~/'"]|\$HOME\/)\.t3(?:$|[/\\'"])/ },
  { id: "expo-owner", pattern: /pingdotgg/ },
  { id: "apple-team", pattern: /ARK85ZXQ4Z/ },
  // T3 Code's App Store Connect app id (eas.json submit.ascAppId).
  { id: "asc-app", pattern: /\b6787819824\b/ },
  { id: "eas-project", pattern: /d763fcb8-d37c-41ea-a773-b54a0ab4a454|u\.expo\.dev\/d763fcb8/ },
  { id: "clerk-domain", pattern: /clerk\.t3\.codes/ },
  // Any T3 domain: its hosted app, site, relay, telemetry ingest and mail.
  { id: "t3-domain", pattern: /\bt3\.codes\b/ },
  { id: "posthog-key", pattern: /\bphc_[A-Za-z0-9]{20,}/ },
] as const;

/** Upstream identity left in literals; new hits since the baseline fail `--check`. */
const DRIFT_PATTERN = /T3 Code|t3code|com\.t3tools|(?:^|[~/])\.t3(?:$|\/)/;

const TEST_PATH =
  /(^|\/)(test|tests|__tests__|testkit|fixtures)\/|\.(test|spec|testkit|fixture)\.[^/]+$/;
export const isTestPath = (file: string) => TEST_PATH.test(file);

type SourceKind = "script" | "html" | "json";
const SCRIPT_LANGS: Record<string, Lang> = {
  ".ts": Lang.TypeScript,
  ".mts": Lang.TypeScript,
  ".cts": Lang.TypeScript,
  ".tsx": Lang.Tsx,
  ".js": Lang.Tsx,
  ".jsx": Lang.Tsx,
  ".mjs": Lang.JavaScript,
  ".cjs": Lang.JavaScript,
};
const extensionOf = (file: string) => file.slice(file.lastIndexOf("."));
export const sourceKind = (file: string): SourceKind | undefined => {
  const extension = extensionOf(file);
  if (extension in SCRIPT_LANGS) return "script";
  if (extension === ".html") return "html";
  if (extension === ".json" || extension === ".webmanifest") return "json";
  return undefined;
};

const globCache = new Map<string, RegExp>();
export function matchesGlob(file: string, glob: string): boolean {
  let pattern = globCache.get(glob);
  if (!pattern) {
    const body = glob
      .split(/(\*\*\/|\*\*|\*)/)
      .map((part) =>
        part === "**/"
          ? "(?:.*/)?"
          : part === "**"
            ? ".*"
            : part === "*"
              ? "[^/]*"
              : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("");
    pattern = new RegExp(`^${body}$`);
    globCache.set(glob, pattern);
  }
  return pattern.test(file);
}
export const matchesAny = (file: string, globs: ReadonlyArray<string>) =>
  globs.some((glob) => matchesGlob(file, glob));

export const ruleLabel = (rule: TextRule) =>
  `${rule.files.join(", ")}: ${JSON.stringify(rule.from)} -> ${JSON.stringify(rule.to)}${rule.exact ? " (exact)" : ""}`;

/** Files nobody brands or scans: an ignore entry without `text` takes the whole file out. */
export const isIgnoredFile = (rules: BrandRules, file: string) =>
  rules.ignore.some(
    (entry) => entry.text === undefined && entry.files && matchesAny(file, entry.files),
  );

const isProtectedText = (rules: BrandRules, file: string, text: string) =>
  rules.ignore.some(
    (entry) =>
      entry.text !== undefined &&
      (!entry.files || matchesAny(file, entry.files)) &&
      new RegExp(entry.text).test(text),
  );

interface Literal {
  /** Raw source text inside the quotes (escapes kept), or trimmed JSX text. */
  readonly text: string;
  readonly line: number;
  /** False for a piece of a template with substitutions, which exact rules never match. */
  readonly whole: boolean;
  /** A string that is code (an import path, a key): only the leak scan reads it. */
  readonly code?: boolean;
  readonly replace: (text: string) => void;
}

/** Wraps rewritten raw text back in its delimiters, refusing text that would end it early. */
const quoted = (open: string, text: string, close = open) => {
  const unescaped = text.replace(/\\[\s\S]/g, "");
  if (unescaped.includes(close) || (open === "`" && unescaped.includes("${"))) {
    throw new Error(
      `rewritten text ${JSON.stringify(text)} would break its ${open}…${close} literal`,
    );
  }
  return `${open}${text}${close}`;
};

const sameNode = (a: SgNode | null | undefined, b: SgNode) =>
  a?.range().start.index === b.range().start.index && a.range().end.index === b.range().end.index;

// Names a module, a type or a member rather than holding text, so rewriting it changes code.
const ALWAYS_CODE_PARENTS = new Set([
  "import_statement",
  "import_require_clause",
  "import_specifier",
  "export_specifier",
  "namespace_export",
  "module",
  "literal_type",
  "computed_property_name",
  "enum_body",
]);
const NAME_FIELD: Record<string, string> = {
  export_statement: "source",
  pair: "key",
  pair_pattern: "key",
  method_definition: "name",
  method_signature: "name",
  abstract_method_signature: "name",
  public_field_definition: "name",
  property_signature: "name",
  enum_assignment: "name",
  subscript_expression: "index",
};

const MODULE_CALLEES = new Set(["require", "require.resolve", "import.meta.resolve"]);

export function isCodeString(node: SgNode): boolean {
  const parent = node.parent();
  if (!parent) return false;
  const kind = String(parent.kind());
  if (ALWAYS_CODE_PARENTS.has(kind)) return true;
  const field = NAME_FIELD[kind];
  if (field) return sameNode(parent.field(field), node);
  if (kind === "binary_expression") {
    return parent.field("operator")?.text() === "in" && sameNode(parent.field("left"), node);
  }
  if (kind === "arguments") {
    const call = parent.parent();
    if (call?.kind() === "new_expression") {
      // new URL("./file", import.meta.url) names a module-relative file.
      const [first, second] = parent.children().filter((child) => child.isNamed());
      return (
        call.field("constructor")?.text() === "URL" &&
        sameNode(first, node) &&
        second?.text() === "import.meta.url"
      );
    }
    const callee = call?.field("function");
    return callee?.kind() === "import" || MODULE_CALLEES.has(callee?.text() ?? "");
  }
  return false;
}

const JSX_SPLITTERS = new Set(["jsx_expression", "jsx_element", "jsx_self_closing_element"]);
const JSX_CONTAINERS = new Set(["jsx_element", "jsx_fragment"]);

/**
 * JSX text that branding empties: its element goes too, so no empty element is left behind
 * (an empty item in a `gap-*` row still adds a gap). Only an element that holds nothing else
 * and sits among other JSX children can go without leaving broken syntax.
 */
function removableJsxElement(text: SgNode): SgNode {
  const element = text.parent();
  const others = element
    ?.children()
    .filter(
      (child) =>
        !sameNode(child, text) &&
        !["jsx_opening_element", "jsx_closing_element"].includes(String(child.kind())) &&
        !(child.kind() === "jsx_text" && child.text().trim() === ""),
    );
  if (
    element?.kind() !== "jsx_element" ||
    others?.length !== 0 ||
    !JSX_CONTAINERS.has(String(element.parent()?.kind()))
  ) {
    throw new Error(
      `emptying ${JSON.stringify(text.text().trim())} would leave an empty element here; brand the text around it instead`,
    );
  }
  return element;
}

const neverRewrite = () => {
  throw new Error("a code string is never rewritten");
};

function scriptLiterals(root: SgNode, edits: Array<Edit>): ReadonlyArray<Literal> {
  const literals: Array<Literal> = [];
  const nodes = root.findAll({
    rule: {
      any: [
        { kind: "string" },
        { kind: "template_string" },
        { kind: "jsx_text" },
        { kind: "regex_pattern" },
      ],
    },
  });
  for (const node of nodes) {
    const line = node.range().start.line + 1;
    const kind = node.kind();
    if ((kind === "string" || kind === "template_string") && isCodeString(node)) {
      literals.push({
        text: node.text().slice(1, -1),
        line,
        whole: true,
        code: true,
        replace: neverRewrite,
      });
      continue;
    }
    if (kind === "string") {
      const raw = node.text();
      const quote = raw[0]!;
      literals.push({
        text: raw.slice(1, -1),
        line,
        whole: true,
        replace: (text) => edits.push(node.replace(quoted(quote, text))),
      });
    } else if (kind === "template_string") {
      const substituted = node.children().some((child) => child.kind() === "template_substitution");
      if (!substituted) {
        literals.push({
          text: node.text().slice(1, -1),
          line,
          whole: true,
          replace: (text) => edits.push(node.replace(quoted("`", text))),
        });
        continue;
      }
      for (const fragment of node.children().filter((c) => c.kind() === "string_fragment")) {
        literals.push({
          text: fragment.text(),
          line: fragment.range().start.line + 1,
          whole: false,
          replace: (text) => edits.push(fragment.replace(quoted("`", text).slice(1, -1))),
        });
      }
    } else if (kind === "jsx_text") {
      const raw = node.text();
      const text = raw.trim();
      if (!text) continue;
      const start = raw.indexOf(text);
      // Text that {expr} or a child element splits is a piece of a sentence, like a template's.
      const whole = !node
        .parent()
        ?.children()
        .some((child) => JSX_SPLITTERS.has(String(child.kind())));
      literals.push({
        text,
        line,
        whole,
        replace: (next) => {
          if (/[<>{}]/.test(next)) {
            throw new Error(`rewritten JSX text ${JSON.stringify(next)} would change the markup`);
          }
          if (next.trim() === "") {
            edits.push(removableJsxElement(node).replace(""));
            return;
          }
          edits.push(node.replace(raw.slice(0, start) + next + raw.slice(start + text.length)));
        },
      });
    } else {
      literals.push({
        text: node.text(),
        line,
        whole: true,
        replace: (t) => edits.push(node.replace(t)),
      });
    }
  }
  return literals;
}

function htmlLiterals(root: SgNode, edits: Array<Edit>): ReadonlyArray<Literal> {
  return root
    .findAll({ rule: { any: [{ kind: "text" }, { kind: "attribute_value" }] } })
    .map((node) => ({
      text: node.text(),
      line: node.range().start.line + 1,
      whole: true,
      replace: (text) => edits.push(node.replace(text)),
    }));
}

// JSON has no ast-grep grammar built in; string values are its literals, and keys stay put.
function jsonLiterals(value: unknown, out: Array<Literal>, set: (next: unknown) => void) {
  if (typeof value === "string") {
    out.push({ text: value, line: 0, whole: true, replace: set });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) =>
      jsonLiterals(item, out, (next) => {
        value[index] = next;
      }),
    );
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      jsonLiterals(record[key], out, (next) => {
        record[key] = next;
      });
    }
  }
}

// In files the engine can't parse, a quoted string on one line is a literal.
const RAW_STRING = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g;
// Plus XML element text, such as <string>t3code</string>, for the leak scan only.
const XML_TEXT = />([^<>\n]+)</g;

function rawLiterals(source: string, edits: Array<RawEdit>): ReadonlyArray<Literal> {
  const literals: Array<Literal> = [];
  let lineStart = 0;
  source.split("\n").forEach((lineText, index) => {
    for (const match of lineText.matchAll(RAW_STRING)) {
      const quote = match[0][0]!;
      const start = lineStart + match.index + 1;
      const text = match[1] ?? match[2] ?? "";
      literals.push({
        text,
        line: index + 1,
        whole: true,
        replace: (next) =>
          edits.push({ start, end: start + text.length, text: quoted(quote, next).slice(1, -1) }),
      });
    }
    lineStart += lineText.length + 1;
  });
  return literals;
}

interface RawEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const commitRawEdits = (source: string, edits: ReadonlyArray<RawEdit>) =>
  edits
    .toSorted((a, b) => b.start - a.start)
    .reduce((out, edit) => out.slice(0, edit.start) + edit.text + out.slice(edit.end), source);

/** Drops edits inside another edit's range, such as text inside a removed element. */
const outermostEdits = (edits: ReadonlyArray<Edit>) =>
  edits.filter(
    (edit) =>
      !edits.some(
        (other) =>
          other !== edit &&
          other.startPos <= edit.startPos &&
          other.endPos >= edit.endPos &&
          (other.startPos < edit.startPos || other.endPos > edit.endPos),
      ),
  );

export interface Finding {
  readonly line: number;
  readonly text: string;
}

export interface FileResult {
  readonly output: string;
  readonly changed: boolean;
  /** Matches per rule index. */
  readonly matches: ReadonlyMap<number, number>;
  /** Literals that still carry upstream identity after branding and that no ignore entry covers. */
  readonly uncovered: ReadonlyArray<Finding>;
  /** Literals after branding that hit a leak pattern, before the allowlist. */
  readonly leaks: ReadonlyArray<Finding & { readonly leak: string }>;
}

/** Brands one file's literals. Rules apply in order; protected literals are never rewritten. */
export function brandSource(rules: BrandRules, file: string, source: string): FileResult {
  const kind = sourceKind(file);
  const matches = new Map<number, number>();
  const edits: Array<Edit> = [];
  const rawEdits: Array<RawEdit> = [];
  let json: { value: unknown } | undefined;
  let root: SgNode | undefined;
  let literals: ReadonlyArray<Literal>;
  if (kind === "script") {
    root = parse(SCRIPT_LANGS[extensionOf(file)]!, source).root();
    literals = scriptLiterals(root, edits);
  } else if (kind === "html") {
    root = parse(Lang.Html, source).root();
    literals = htmlLiterals(root, edits);
  } else if (kind === undefined) {
    literals = rawLiterals(source, rawEdits);
  } else {
    const holder = { value: JSON.parse(source) as unknown };
    const out: Array<Literal> = [];
    jsonLiterals(holder.value, out, (next) => {
      holder.value = next;
    });
    json = holder;
    literals = out;
  }

  const applicable = rules.text
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => matchesAny(file, rule.files));
  const uncovered: Array<Finding> = [];
  const leaks: Array<Finding & { leak: string }> = [];
  let changed = false;
  for (const literal of literals) {
    const isProtected = literal.code || isProtectedText(rules, file, literal.text);
    let text = literal.text;
    if (!isProtected) {
      for (const { rule, index } of applicable) {
        const hit = rule.exact ? literal.whole && text === rule.from : text.includes(rule.from);
        if (!hit) continue;
        matches.set(index, (matches.get(index) ?? 0) + 1);
        text = rule.exact ? rule.to : text.replaceAll(rule.from, rule.to);
      }
      if (text !== literal.text) {
        literal.replace(text);
        changed = true;
      }
      // Unparsed files feed the leak scan, not the drift list.
      if (kind && DRIFT_PATTERN.test(text)) uncovered.push({ line: literal.line, text });
    }
    if (!kind) continue;
    for (const { id, pattern } of LEAK_PATTERNS) {
      if (pattern.test(text)) leaks.push({ line: literal.line, text, leak: id });
    }
  }

  const output = !changed
    ? source
    : kind === undefined
      ? commitRawEdits(source, rawEdits)
      : root
        ? root.commitEdits(outermostEdits(edits))
        : `${JSON.stringify(json!.value, null, 2)}\n`;
  return { output, changed, matches, uncovered, leaks: kind ? leaks : rawLeaks(output) };
}

/**
 * Leak hits in a file the engine can't parse, read line by line. Each quoted string and XML text
 * is tested on its own, so anchored patterns see `"t3code"` in `getString("scheme", "t3code")`,
 * and then the whole line.
 */
export function rawLeaks(source: string): ReadonlyArray<Finding & { readonly leak: string }> {
  const out: Array<Finding & { leak: string }> = [];
  source.split("\n").forEach((lineText, index) => {
    const line = lineText.trim();
    // The narrowest piece first, so an allow entry's `text` sees just the string.
    const pieces = [
      ...[...line.matchAll(RAW_STRING)].map((match) => match[1] ?? match[2] ?? ""),
      ...[...line.matchAll(XML_TEXT)].map((match) => match[1]!.trim()),
      line,
    ];
    for (const { id, pattern } of LEAK_PATTERNS) {
      const text = pieces.find((piece) => pattern.test(piece));
      if (text !== undefined) out.push({ line: index + 1, text, leak: id });
    }
  });
  return out;
}

export const mightNeedScan = (source: string) =>
  DRIFT_PATTERN.test(source) || LEAK_PATTERNS.some(({ pattern }) => pattern.test(source));

export const isAllowedLeak = (rules: BrandRules, file: string, leak: string, text: string) =>
  rules.leaks.allow.some(
    (entry) =>
      (entry.leak === undefined || entry.leak === leak) &&
      (!entry.files || matchesAny(file, entry.files)) &&
      (!entry.text || new RegExp(entry.text).test(text)),
  );

/** A short, stable excerpt around the first upstream match, for reports and the drift baseline. */
export const excerpt = (text: string) => {
  const at = Math.max(0, text.search(DRIFT_PATTERN));
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, at + 50);
  return JSON.stringify(
    `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
  );
};
