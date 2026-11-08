// Guards stop paths Kin can't support yet in the branded copy with a clear message. An Effect.fn
// gets a last combinator that fails first (an early return would make the body unreachable and
// break type narrowing); a plain function returns null first. A target found other than once
// fails the run, so an upstream rename can't silently drop a guard.
import { Lang, parse, type Edit, type SgNode } from "@ast-grep/napi";

const NO_RELEASES = "Kin doesn't publish releases yet; run Kin from source.";

export type Guard = {
  readonly file: string;
  readonly reason: string;
} & (
  | /** `Effect.fn("<span>")(function* …)`, which fails with `error` instead. */
    { readonly span: string; readonly error: string }
  /** `function <name>(…)`, which returns `null` first. */
  | { readonly function: string }
  /** An ast-grep `pattern` (whitespace-insensitive) that is replaced with `replace`. */
  | { readonly pattern: string; readonly replace: string }
);

export const GUARDS: ReadonlyArray<Guard> = [
  {
    file: "apps/server/src/cli/update.ts",
    reason: "`t3 update` would find, download and switch this machine to T3 Code's latest release.",
    span: "cli.update.run",
    error: `new CliUpdateError({ reason: ${JSON.stringify(NO_RELEASES)} })`,
  },
  {
    file: "apps/server/src/cloud/pinnedRuntime.ts",
    reason:
      "Every published runtime install goes through here: `t3 service install` and `t3 up` " +
      "(the boot service), `t3 update`, and the server's self-update. Each would download and " +
      "run T3 Code's release.",
    span: "cloud.pinned_runtime.ensure_installed",
    error: `new PinnedRuntimeInstallError({ step: ${JSON.stringify(`installing a published runtime (${NO_RELEASES.replace(/\.$/, "")})`)} })`,
  },
  {
    file: "apps/server/src/telemetry/AnalyticsService.ts",
    reason:
      "Its default key and host are T3 Code's PostHog project, so a Kin server would report " +
      "usage, including install owners, to T3's account. Off unless T3CODE_TELEMETRY_ENABLED=true.",
    pattern: 'Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(true))',
    replace: 'Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(false))',
  },
  {
    file: "apps/web/src/components/settings/MobileAppSettingsRow.tsx",
    reason:
      "Its store links install T3 Code's mobile app, which can't open Kin's kin:// pairing links.",
    function: "MobileAppSettingsRow",
  },
];

/** Where the guard goes: after a function body's `{`, or after an Effect.fn's last argument. */
const insertionPoints = (
  root: SgNode,
  guard: Exclude<Guard, { readonly pattern: string }>,
): ReadonlyArray<number> => {
  if ("function" in guard) {
    return root
      .findAll({ rule: { kind: "function_declaration" } })
      .filter((node) => node.field("name")?.text() === guard.function)
      .flatMap((node) => node.field("body") ?? [])
      .map((body) => body.range().start.index + 1);
  }
  // Effect.fn("span")(function* (…) { … }): the inner call names the span, the outer takes the body.
  return root
    .findAll({ rule: { kind: "call_expression" } })
    .filter((outer) => {
      const inner = outer.field("function");
      return (
        inner?.kind() === "call_expression" &&
        inner.field("function")?.text() === "Effect.fn" &&
        inner.field("arguments")?.child(1)?.text() === JSON.stringify(guard.span)
      );
    })
    .flatMap(
      (outer) =>
        outer
          .field("arguments")
          ?.children()
          .filter((arg) => arg.isNamed())
          .at(-1) ?? [],
    )
    .map((last) => last.range().end.index);
};

const label = (guard: Guard) =>
  "span" in guard
    ? `Effect.fn("${guard.span}")`
    : "pattern" in guard
      ? `match for ${guard.pattern}`
      : `function ${guard.function}`;

const insertion = (guard: Exclude<Guard, { readonly pattern: string }>) =>
  // Failing ahead of the body keeps the function's success type, so callers still typecheck.
  "span" in guard
    ? `, (effect) => Effect.andThen(Effect.fail(${guard.error}), effect)`
    : "\n  return null;";

/** Applies the guards for `file`; a target that isn't found exactly once is a problem. */
export function applyGuards(
  file: string,
  source: string,
  all: ReadonlyArray<Guard> = GUARDS,
): { readonly output: string; readonly applied: number; readonly problems: ReadonlyArray<string> } {
  const guards = all.filter((guard) => guard.file === file);
  if (guards.length === 0) return { output: source, applied: 0, problems: [] };
  const root = parse(file.endsWith(".tsx") ? Lang.Tsx : Lang.TypeScript, source).root();
  const edits: Array<Edit> = [];
  const problems: Array<string> = [];
  for (const guard of guards) {
    if ("pattern" in guard) {
      const matches = root.findAll(guard.pattern);
      if (matches.length !== 1) {
        problems.push(`guard expected one ${label(guard)} in ${file}, found ${matches.length}`);
        continue;
      }
      edits.push(matches[0]!.replace(guard.replace));
      continue;
    }
    const points = insertionPoints(root, guard);
    if (points.length !== 1) {
      problems.push(`guard expected one ${label(guard)} in ${file}, found ${points.length}`);
      continue;
    }
    edits.push({ startPos: points[0]!, endPos: points[0]!, insertedText: insertion(guard) });
  }
  if (problems.length > 0) return { output: source, applied: 0, problems };
  return { output: root.commitEdits(edits), applied: edits.length, problems };
}
