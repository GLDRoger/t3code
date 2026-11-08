import { assert, describe, it } from "@effect/vitest";

import {
  brandSource,
  isAllowedLeak,
  isTestPath,
  matchesGlob,
  rawLeaks,
  type BrandRules,
} from "./kinBrandEngine.ts";
import { applyGuards } from "./kinBrandGuards.ts";
import { brandMobileConfig } from "./kinBrandMobileConfig.ts";

const rules = (
  text: BrandRules["text"],
  ignore: BrandRules["ignore"] = [],
  allow: BrandRules["leaks"]["allow"] = [],
): BrandRules => ({ text, ignore, leaks: { allow } });

const brand = (source: string, rule: Omit<BrandRules["text"][number], "files">, file = "a.ts") =>
  brandSource(rules([{ ...rule, files: [file] }]), file, source).output;

describe("brandSource", () => {
  it("rewrites literal text and leaves identifiers, keys and comments alone", () => {
    const source = [
      'const T3Code = { "T3 Code": "T3 Code", title: `Open T3 Code ${T3Code}` };',
      'const view = <p title="T3 Code">Welcome to T3 Code</p>;',
      "// T3 Code in a comment",
    ].join("\n");
    const result = brandSource(
      rules([{ files: ["apps/**/*.tsx"], from: "T3 Code", to: "Kin" }]),
      "apps/web/src/a.tsx",
      source,
    );
    assert.strictEqual(
      result.output,
      [
        'const T3Code = { "T3 Code": "Kin", title: `Open Kin ${T3Code}` };',
        'const view = <p title="Kin">Welcome to Kin</p>;',
        "// T3 Code in a comment",
      ].join("\n"),
    );
    assert.strictEqual(result.matches.get(0), 4);
    assert.deepStrictEqual(result.uncovered, []);
  });

  // Strings that are code, not text: no rule, exact or not, may touch them.
  const codeStrings = [
    'import a from "t3code";',
    'export * from "t3code";',
    'export { x } from "t3code";',
    'const r = require("t3code");',
    'const i = import("t3code");',
    'type T = "t3code" | Foo<"t3code">;',
    'o["t3code"];',
    'if ("t3code" in o) {}',
    'const p = { "t3code": 1 };',
    'const p = { ["t3code"]: 1 };',
    'const p = { "t3code"() {} };',
    'class C { "t3code" = 1; }',
    'class C { "t3code"() {} }',
    'class C { get "t3code"() { return 1; } }',
    'class C { set "t3code"(v) {} }',
    'enum E { "t3code" = 1 }',
    'enum E { "t3code" }',
    'declare module "t3code" {}',
    'interface I { "t3code": string }',
    "const i = import(`t3code`);",
    "const r = require(`t3code`);",
    "const p = { [`t3code`]: 1 };",
    "o[`t3code`];",
    "const { [`t3code`]: d } = o;",
    "const i = import(`./${x}/t3code`);",
    'const r = require.resolve("t3code");',
    "const r = require.resolve(`t3code`);",
    'const u = import.meta.resolve("t3code");',
    'const u = new URL("./t3code.js", import.meta.url);',
    "const u = new URL(`./t3code.js`, import.meta.url);",
  ];
  it.each(codeStrings)("never rewrites code strings: %s", (source) => {
    assert.strictEqual(brand(source, { from: "t3code", to: "kin" }), source);
    assert.strictEqual(brand(source, { from: "t3code", to: "kin", exact: true }), source);
  });

  it.each([
    ["`t3code${x}`", "a template with substitutions"],
    ['"t3code\\n"', "a literal with more after an escape"],
    ['"t3code-x"', "a longer literal"],
  ])("exact rules compare whole literals: %s (%s)", (literal) => {
    const source = `const s = ${literal};`;
    assert.strictEqual(brand(source, { from: "t3code", to: "kin", exact: true }), source);
  });

  it.each([
    ['const s = "t3code";', 'const s = "kin";', true],
    ["const s = 't3code';", "const s = 'kin';", true],
    ["const t = `t3code`;", "const t = `kin`;", true],
    ['const p = { k: "t3code" };', 'const p = { k: "kin" };', true],
    ['class C { f = "t3code"; }', 'class C { f = "kin"; }', true],
    ['enum E { A = "t3code" }', 'enum E { A = "kin" }', true],
    ['call("t3code");', 'call("kin");', true],
    ['o["t3code" + k];', 'o["kin" + k];', false],
    ['const x = c ? "t3code" : "t3code-dev";', 'const x = c ? "kin" : "kin-dev";', false],
    ['const u = new URL("t3code", base);', 'const u = new URL("kin", base);', true],
    ['const u = new URL(p, "t3code");', 'const u = new URL(p, "kin");', true],
  ] as const)("rewrites text strings: %s", (source, expected, exact) => {
    const rule = { from: "t3code", to: "kin", ...(exact ? { exact } : {}) };
    assert.strictEqual(brand(source, rule), expected);
  });

  it("rewrites template text around substitutions, regex literals and trimmed JSX text", () => {
    assert.strictEqual(
      brand("const u = `t3code://pair?${q}`;", { from: "t3code://", to: "kin://" }),
      "const u = `kin://pair?${q}`;",
    );
    assert.strictEqual(
      brand("const re = /^t3code(-dev)?:$/;", { from: "^t3code(", to: "^kin(" }),
      "const re = /^kin(-dev)?:$/;",
    );
    assert.strictEqual(
      brand("const v = <b>\n  T3 Code\n</b>;", { from: "T3 Code", to: "Kin" }, "a.tsx"),
      "const v = <b>\n  Kin\n</b>;",
    );
  });

  it("removes an element whose only text a rule empties, so a gap row gets no empty item", () => {
    const source =
      '<span className="gap-1">\n  <Mark />\n  <span className="x">\n    Code\n  </span>\n</span>';
    assert.strictEqual(
      brand(`const v = ${source};`, { from: "Code", to: "", exact: true }, "a.tsx"),
      'const v = <span className="gap-1">\n  <Mark />\n  \n</span>;',
    );
    assert.throws(
      () => brand("const v = <b>Code</b>;", { from: "Code", to: "", exact: true }, "a.tsx"),
      /empty element/,
    );
    assert.throws(
      () => brand("const v = <p><b>Code<i /></b></p>;", { from: "Code", to: "" }, "a.tsx"),
      /empty element/,
    );
  });

  it.each([
    ["<p>Code {name}</p>", "text split by {expr}"],
    ["<p>{name} Code</p>", "text after {expr}"],
    ["<p>Code<b>x</b></p>", "text split by an element"],
  ])("exact rules skip JSX text pieces: %s (%s)", (jsx) => {
    const source = `const v = ${jsx};`;
    assert.strictEqual(brand(source, { from: "Code", to: "Kin", exact: true }, "a.tsx"), source);
  });

  it.each(["<b>", "a > b", "{x}", "}"])("refuses JSX text that would change markup: %s", (to) => {
    assert.throws(
      () => brand("const v = <p>T3 Code</p>;", { from: "T3 Code", to }, "a.tsx"),
      /would change the markup/,
    );
  });

  it("refuses a rewrite that would end its literal early", () => {
    assert.throws(() => brand('const s = "a";', { from: "a", to: 'b"' }));
    assert.throws(() => brand("const s = `a${x}`;", { from: "a", to: "${y}" }));
  });

  it("rewrites literals that hold escaped delimiters", () => {
    assert.strictEqual(
      brand('const s = `cd "$HOME/.t3" && echo \\${X:-}`;', {
        from: "$HOME/.t3",
        to: "$HOME/.kin",
      }),
      'const s = `cd "$HOME/.kin" && echo \\${X:-}`;',
    );
    assert.strictEqual(
      brand('const s = "say \\"t3code\\"";', { from: "t3code", to: "kin" }),
      'const s = "say \\"kin\\"";',
    );
  });

  it("rewrites quoted strings in files it can't parse, and finds their leaks", () => {
    const kotlin =
      'val scheme = prefs.getString("scheme", "t3code") ?: "t3code"\nval t = "t3code-x"';
    const result = brandSource(
      rules([{ files: ["a.kt"], from: "t3code", to: "kin", exact: true }]),
      "a.kt",
      kotlin,
    );
    assert.strictEqual(
      result.output,
      'val scheme = prefs.getString("scheme", "kin") ?: "kin"\nval t = "t3code-x"',
    );
    assert.strictEqual(result.matches.get(0), 2);
    assert.deepStrictEqual(result.leaks, []);
    assert.deepStrictEqual(
      brandSource(rules([]), "a.kt", kotlin).leaks.map((entry) => entry.leak),
      ["scheme-name"],
    );
  });

  it("matches exact rules in rule order", () => {
    const source = 'const ids = ["t3code", "t3code-dev", "t3code:drafts", `t3code://${path}`];';
    const result = brandSource(
      rules([
        { files: ["a.ts"], from: "t3code", to: "kin", exact: true },
        { files: ["a.ts"], from: "t3code-dev", to: "kin-dev", exact: true },
        { files: ["a.ts"], from: "t3code://", to: "kin://" },
      ]),
      "a.ts",
      source,
    );
    assert.strictEqual(
      result.output,
      'const ids = ["kin", "kin-dev", "t3code:drafts", `kin://${path}`];',
    );
    assert.deepStrictEqual(
      [...result.matches.entries()],
      [
        [0, 1],
        [1, 1],
        [2, 1],
      ],
    );
  });

  it("never rewrites protected literals and reports what is left", () => {
    const source = 'const a = "T3 Code";\nconst b = "Welcome to T3 Code";';
    const ignore = [{ reason: "client id", text: "^T3 Code$" }];
    const branded = brandSource(
      rules([{ files: ["a.ts"], from: "T3 Code", to: "Kin" }], ignore),
      "a.ts",
      source,
    );
    assert.strictEqual(branded.output, 'const a = "T3 Code";\nconst b = "Welcome to Kin";');
    assert.deepStrictEqual(branded.uncovered, []);

    const unbranded = brandSource(rules([], ignore), "b.ts", source);
    assert.strictEqual(unbranded.changed, false);
    assert.deepStrictEqual(unbranded.uncovered, [{ line: 2, text: "Welcome to T3 Code" }]);
  });

  it("rewrites HTML text and attributes, and JSON values but not keys", () => {
    const html = brandSource(
      rules([{ files: ["index.html"], from: "T3 Code", to: "Kin" }]),
      "index.html",
      '<title>T3 Code (Beta)</title><img alt="T3 Code" />',
    );
    assert.strictEqual(html.output, '<title>Kin (Beta)</title><img alt="Kin" />');

    const json = brandSource(
      rules([{ files: ["package.json"], from: "T3 Code", to: "Kin" }]),
      "package.json",
      '{"T3 Code": "x", "productName": "T3 Code (Beta)"}',
    );
    assert.strictEqual(json.output, '{\n  "T3 Code": "x",\n  "productName": "Kin (Beta)"\n}\n');
  });
});

describe("leaks", () => {
  it.each([
    ['"t3code://pair"', "scheme-link"],
    ['"t3code-dev"', "scheme-name"],
    ['"t3code:"', "scheme-name"],
    ["/^t3code(-dev)?:$/", "scheme-name"],
    ['"com.t3tools.t3code.dev"', "bundle-id"],
    ['join(home, ".t3")', "t3-home"],
    ['"$HOME/.t3/wsl-runtime"', "t3-home"],
    ['"pingdotgg"', "expo-owner"],
    ['"ARK85ZXQ4Z"', "apple-team"],
    ['"https://u.expo.dev/d763fcb8-d37c-41ea-a773-b54a0ab4a454"', "eas-project"],
    ['"applinks:clerk.t3.codes"', "clerk-domain"],
    ['"https://app.t3.codes"', "t3-domain"],
    ['"noreply@t3.codes"', "t3-domain"],
    ['"phc_XOWci4oZP4VvLiEyrFqkFjP4CZn55mjYYBMREK5Wd6m"', "posthog-key"],
    // Strings that are code are scanned, though never rewritten.
    ['{ "com.t3tools.t3code": 1 }', "bundle-id"],
  ])("finds %s as %s", (literal, leak) => {
    const { leaks } = brandSource(rules([]), "a.ts", `f(${literal});`);
    assert.include(
      leaks.map((entry) => entry.leak),
      leak,
    );
  });

  it("leaves storage keys, worktree folders and env names out", () => {
    const source = 'f("t3code:drafts:v1", ".t3-capture", "T3CODE_HOME", "my.t3x");';
    assert.deepStrictEqual(brandSource(rules([]), "a.ts", source).leaks, []);
  });

  it("allows only what an entry's leak, files and text all cover", () => {
    const allow = rules(
      [],
      [],
      [{ reason: "r", leak: "t3-home", files: ["a/**"], text: "^\\.t3$" }],
    );
    assert.isTrue(isAllowedLeak(allow, "a/x.ts", "t3-home", ".t3"));
    assert.isFalse(isAllowedLeak(allow, "b/x.ts", "t3-home", ".t3"));
    assert.isFalse(isAllowedLeak(allow, "a/x.ts", "expo-owner", ".t3"));
    assert.isFalse(isAllowedLeak(allow, "a/x.ts", "t3-home", "~/.t3/x"));
  });

  it.each([
    ["  <id>com.t3tools.t3code</id>", "com.t3tools.t3code", "bundle-id"],
    ['prefs.getString("scheme", "t3code")', "t3code", "scheme-name"],
    ["let scheme = 't3code-dev'", "t3code-dev", "scheme-name"],
    ["<string>t3code</string>", "t3code", "scheme-name"],
    ['STATE="$HOME/.t3/ssh"', "$HOME/.t3/ssh", "t3-home"],
  ])("reads files it can't parse line by line: %s", (line, text, leak) => {
    assert.deepStrictEqual(rawLeaks(`a\n${line}\n`), [{ line: 2, text, leak }]);
  });
});

describe("brandMobileConfig", () => {
  const config = [
    'const VARIANT_CONFIG = { production: { relyingParty: "clerk.t3.codes" }, a: { relyingParty: "x" }, b: { relyingParty: "y" } };',
    "const config = {",
    '  slug: "t3-code",',
    '  updates: { enabled: on !== "0", url: "https://u.expo.dev/d763fcb8" },',
    '  ios: { appleTeamId: "ARK85ZXQ4Z", associatedDomains: [`applinks:${host}`] },',
    "  android: { intentFilters: [{ autoVerify: true }] },",
    '  extra: { eas: { projectId: "d763fcb8", observe: {} } },',
    '  owner: "pingdotgg",',
    "};",
  ].join("\n");

  it("takes T3's account ids out and reads Kin's from the environment", () => {
    const { output, problems } = brandMobileConfig(config);
    assert.deepStrictEqual(problems, []);
    assert.notInclude(output, "pingdotgg");
    assert.notInclude(output, "ARK85ZXQ4Z");
    assert.notInclude(output, "d763fcb8");
    assert.notInclude(output, "clerk.t3.codes");
    assert.notInclude(output, "autoVerify");
    assert.include(output, 'slug: "kin"');
    assert.include(output, "owner: process.env.KIN_EXPO_OWNER");
    assert.include(output, "appleTeamId: process.env.KIN_APPLE_TEAM_ID");
    assert.include(output, "projectId: process.env.KIN_EAS_PROJECT_ID");
    assert.include(output, 'enabled: Boolean(process.env.KIN_EAS_PROJECT_ID) && on !== "0"');
  });

  it("reports a key upstream moved instead of guessing", () => {
    const { output, problems } = brandMobileConfig(config.replace('  owner: "pingdotgg",\n', ""));
    assert.deepStrictEqual(problems, ["expected 1 `owner:` in apps/mobile/app.config.ts, found 0"]);
    assert.strictEqual(output, config.replace('  owner: "pingdotgg",\n', ""));
  });
});

describe("applyGuards", () => {
  const update = [
    'export const runUpdate = Effect.fn("cli.update.run")(function* (input: { a: string }) {',
    "  return input.a;",
    "});",
  ].join("\n");

  it("fails an Effect.fn ahead of its body and keeps the body", () => {
    const { output, applied, problems } = applyGuards("apps/server/src/cli/update.ts", update);
    assert.deepStrictEqual(problems, []);
    assert.strictEqual(applied, 1);
    assert.strictEqual(
      output,
      update.replace(
        /\}\);$/,
        `}, (effect) => Effect.andThen(Effect.fail(new CliUpdateError({ reason: "Kin doesn't publish releases yet; run Kin from source." })), effect));`,
      ),
    );
  });

  it("returns null first from a plain function", () => {
    const { output } = applyGuards(
      "apps/web/src/components/settings/MobileAppSettingsRow.tsx",
      "export function MobileAppSettingsRow() {\n  return <div />;\n}",
    );
    assert.strictEqual(
      output,
      "export function MobileAppSettingsRow() {\n  return null;\n  return <div />;\n}",
    );
  });

  it("reports a target upstream renamed instead of skipping it", () => {
    const renamed = update.replace("cli.update.run", "cli.update.execute");
    const { output, problems } = applyGuards("apps/server/src/cli/update.ts", renamed);
    assert.deepStrictEqual(problems, [
      'guard expected one Effect.fn("cli.update.run") in apps/server/src/cli/update.ts, found 0',
    ]);
    assert.strictEqual(output, renamed);
  });

  it("replaces a pattern found once and refuses a second match", () => {
    const file = "apps/server/src/telemetry/AnalyticsService.ts";
    const config =
      'Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(\n    Config.withDefault(true),\n  )';
    const once = applyGuards(file, `const a = { enabled: ${config} };`);
    assert.deepStrictEqual(once.problems, []);
    assert.strictEqual(
      once.output,
      'const a = { enabled: Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(false)) };',
    );
    const twice = applyGuards(file, `const a = ${config};\nconst b = ${config};`);
    assert.strictEqual(twice.problems.length, 1);
    assert.strictEqual(twice.applied, 0);
  });
});

describe("paths", () => {
  it("skips tests and matches globs", () => {
    assert.isTrue(isTestPath("apps/web/src/a.test.ts"));
    assert.isTrue(isTestPath("apps/web/src/a.browser.test.tsx"));
    assert.isTrue(isTestPath("apps/server/src/peer/PeerLinks.testkit.ts"));
    assert.isTrue(isTestPath("apps/server/test/helpers.ts"));
    assert.isFalse(isTestPath("apps/web/src/testing.ts"));

    assert.isTrue(
      matchesGlob(
        "apps/server/src/mcp/toolkits/device/handlers.ts",
        "apps/server/src/mcp/toolkits/**",
      ),
    );
    assert.isTrue(
      matchesGlob("scripts/mobile-showcase-environment.ts", "scripts/mobile-showcase*.ts"),
    );
    assert.isFalse(matchesGlob("scripts/mobile/showcase.ts", "scripts/mobile*.ts"));
    assert.isFalse(matchesGlob("apps/webx/a.ts", "apps/web/**"));
  });
});
