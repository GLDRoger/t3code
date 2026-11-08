// Detaches the branded apps/mobile/app.config.ts from T3 Code's Apple, Expo and Clerk accounts.
// A structural edit of named config keys, not text rules: each key must be found exactly as
// often as expected, so an upstream reshuffle fails the run instead of leaving T3's ids behind.
import { Lang, parse, type Edit, type SgNode } from "@ast-grep/napi";

export const MOBILE_CONFIG_FILE = "apps/mobile/app.config.ts";

/** Ops values the owner supplies; unset ones leave the build without that capability. */
export const MOBILE_OPS_ENV = {
  KIN_APPLE_TEAM_ID: "iOS signing team (appleTeamId)",
  KIN_EAS_PROJECT_ID: "EAS project for builds and OTA updates (extra.eas.projectId, updates.url)",
  KIN_EXPO_OWNER: "Expo account that owns the EAS project (owner)",
} as const;

const env = (name: keyof typeof MOBILE_OPS_ENV) => `process.env.${name}`;

const pairsNamed = (scope: SgNode, key: string) =>
  scope.findAll({
    rule: {
      kind: "pair",
      has: { field: "key", regex: `^${key}$`, kind: "property_identifier" },
    },
  });

/** Replaces the value of each `key:` pair inside `scope`, expecting exactly `count` of them. */
function setValue(
  scope: SgNode,
  edits: Array<Edit>,
  problems: Array<string>,
  key: string,
  count: number,
  value: (current: SgNode) => string,
) {
  const pairs = pairsNamed(scope, key);
  if (pairs.length !== count) {
    problems.push(`expected ${count} \`${key}:\` in ${MOBILE_CONFIG_FILE}, found ${pairs.length}`);
    return;
  }
  for (const pair of pairs) {
    const current = pair.field("value")!;
    edits.push(current.replace(value(current)));
  }
}

function within(root: SgNode, problems: Array<string>, key: string): SgNode | undefined {
  const pairs = pairsNamed(root, key);
  if (pairs.length !== 1) {
    problems.push(`expected one \`${key}:\` in ${MOBILE_CONFIG_FILE}, found ${pairs.length}`);
    return undefined;
  }
  return pairs[0]!.field("value") ?? undefined;
}

export function brandMobileConfig(source: string): {
  readonly output: string;
  readonly problems: ReadonlyArray<string>;
} {
  const root = parse(Lang.TypeScript, source).root();
  const edits: Array<Edit> = [];
  const problems: Array<string> = [];
  const set = (scope: SgNode, key: string, count: number, value: (c: SgNode) => string) =>
    setValue(scope, edits, problems, key, count, value);

  set(root, "slug", 1, () => `"kin"`);
  set(root, "owner", 1, () => env("KIN_EXPO_OWNER"));
  set(root, "appleTeamId", 1, () => env("KIN_APPLE_TEAM_ID"));
  // T3's Clerk passkey domain and app.t3.codes universal links verify only T3's apps.
  set(root, "relyingParty", 3, () => "undefined");
  set(root, "associatedDomains", 1, () => "[]");
  set(root, "intentFilters", 1, () => "[]");

  const updates = within(root, problems, "updates");
  if (updates) {
    const projectId = env("KIN_EAS_PROJECT_ID");
    set(
      updates,
      "url",
      1,
      () => `${projectId} ? \`https://u.expo.dev/\${${projectId}}\` : undefined`,
    );
    set(updates, "enabled", 1, (current) => `Boolean(${projectId}) && ${current.text()}`);
  }
  const eas = within(root, problems, "eas");
  if (eas) set(eas, "projectId", 1, () => env("KIN_EAS_PROJECT_ID"));

  return { output: problems.length > 0 ? source : root.commitEdits(edits), problems };
}
