// Guards stop paths Kin can't support yet in the branded copy with a clear message. An Effect.fn
// gets a last combinator that fails first (an early return would make the body unreachable and
// break type narrowing); a plain function returns null first. A target found other than once
// fails the run, so an upstream rename can't silently drop a guard.
import { Lang, parse, type Edit, type NapiConfig, type SgNode } from "@ast-grep/napi";

const NO_RELEASES = "Kin doesn't publish releases yet; run Kin from source.";
const NO_TRIAGE =
  "Kin has no triage yet: this flow files issues into T3 Code's repository. Report Kin problems to Kin's maintainers.";
const NO_MOBILE_DEV_CLIENT =
  "Kin has no prebuilt mobile dev client yet; this installs T3 Code's. Build Kin's with Expo prebuild (apps/mobile).";

export type Guard = {
  readonly file: string;
  readonly reason: string;
} & (
  | /** `Effect.fn("<span>")(function* …)`, which fails with `error` instead. */
    { readonly span: string; readonly error: string }
  /** `function <name>(…)`, which returns `null` first. */
  | { readonly function: string }
  /**
   * An ast-grep `pattern` (whitespace-insensitive) that is replaced with `replace`. A fragment
   * that isn't a statement, such as an object property, takes a `context` and a `selector`.
   */
  | {
      readonly pattern: string | { readonly context: string; readonly selector: string };
      readonly replace: string;
    }
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
    file: "apps/server/src/cli/triage.ts",
    reason:
      "`t3 triage` investigates T3 Code's source and helps file the issue in pingdotgg/t3code, " +
      "which is the wrong tracker for Kin.",
    pattern: "const explicitBaseDir = Option.getOrUndefined(flags.baseDir);",
    // Stops the handler while its success type stays intact, so the rest keeps its types. A
    // UserError prints as a plain message, not a stack trace.
    replace:
      'const explicitBaseDir = yield* Effect.fail(new CliError.UserError({ cause: "triage", ' +
      `userMessage: ${JSON.stringify(NO_TRIAGE)} })).pipe(` +
      "Effect.as(Option.getOrUndefined(flags.baseDir)));",
  },
  {
    file: "apps/server/src/cli/triage.ts",
    reason: "The `t3 triage` guard above fails with the CLI's own user error.",
    pattern: 'import { Command, Flag } from "effect/cli";',
    replace: 'import { CliError, Command, Flag } from "effect/cli";',
  },
  {
    file: "apps/server/src/environment/ServerEnvironment.ts",
    reason:
      "Every Report issue entry point (the web and mobile command palettes) shows only for a " +
      "server that reports triage, so a Kin server hides them; triage files into T3 Code's " +
      "repository and its fallback suggests `npx t3 triage`, T3's published CLI on ~/.t3.",
    pattern: { context: "({ triage: true })", selector: "pair" },
    replace: "triage: false",
  },
  {
    file: "apps/web/src/components/chat/TriageDraftHero.tsx",
    reason: "The triage draft's hero suggests `npx t3 triage`; Kin opens no triage drafts.",
    function: "TriageDraftHero",
  },
  {
    file: "apps/web/src/lib/bootError.ts",
    reason:
      "The startup error page suggests `npx t3 triage` (or the desktop's `t3 triage`), which " +
      "runs T3 Code's triage and files into its repository.",
    pattern:
      'element("div", {}, [element("p", { textContent: $TEXT }), ' +
      'element("div", { id: "boot-error-command" }, [command, copyCommand])])',
    replace: "...[]",
  },
  {
    file: "apps/web/src/lib/bootError.ts",
    reason:
      "Nothing shows the triage command once its block is gone; don't ask the desktop for it.",
    pattern: "void resolveTriageCommand(bridge).then((value) => (command.textContent = value));",
    replace: "",
  },
  {
    file: "apps/desktop/src/app/DesktopStartupRecovery.ts",
    reason:
      "Startup recovery's reinstall offer opens a release tag of T3 Code's; Kin publishes no " +
      "releases, so it opens Kin's source instead (see the rules for its text).",
    pattern: "electronShell.openExternal(`${RELEASES_URL}/tag/v${current.version}`)",
    replace: "electronShell.openExternal(RELEASES_URL)",
  },
  {
    file: "apps/server/src/triage/TriageService.ts",
    reason: "The app's Report issue flow: the same triage, aimed at T3 Code's repository.",
    span: "TriageService.prepare",
    error: `new ServerPrepareTriageError({ cause: new Error(${JSON.stringify(NO_TRIAGE)}) })`,
  },
  {
    file: "scripts/mobile-native-client.ts",
    reason:
      "`vp run mobile:install` installs T3's prebuilt dev client (com.t3tools.t3code.dev) from " +
      "T3's shared build cache and opens it with t3code-dev://, so it would run T3 Code's app.",
    span: "nativeClient.main",
    error: `new NativeClientError({ message: ${JSON.stringify(NO_MOBILE_DEV_CLIENT)} })`,
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
  guard: Exclude<Guard, { readonly replace: string }>,
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
      ? `match for ${typeof guard.pattern === "string" ? guard.pattern : guard.pattern.context}`
      : `function ${guard.function}`;

const insertion = (guard: Exclude<Guard, { readonly replace: string }>) =>
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
      const matcher: string | NapiConfig =
        typeof guard.pattern === "string" ? guard.pattern : { rule: { pattern: guard.pattern } };
      const matches = root.findAll(matcher);
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
