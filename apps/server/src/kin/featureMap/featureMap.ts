// @effect-diagnostics nodeBuiltinImport:off - reads the repo's own sources to check the map.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { KinRpcs } from "@t3tools/contracts";
import { parse as parseYaml } from "yaml";

import { SHARED_TOOLS } from "../lead/SharedTools.ts";
import { TASKS_KEY_TOOLS } from "../tasksKey/mcp.ts";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..", "..", "..", "..", "..");
const FEATURE_MAP_PATH = NodePath.join(import.meta.dirname, "feature-map.yaml");

export const DOCK_TABS = ["chats", "tasks", "money", "clients", "docs"] as const;
const ROLES = ["owner", "co_owner", "lead", "member"] as const;
const REACH = ["both", "web", "phone", "none"] as const;
/** Steps inside a screen that add no depth: a menu, a card in a chat, a section of a page. */
const INLINE = ["menu", "card", "section", "button"] as const;
/** Web panes that open over the place as a sheet; `?open` is Search or New task. */
const SHEET_PANES = new Set(["task", "history", "open"]);

type Role = (typeof ROLES)[number];
type Reach = (typeof REACH)[number];
export type StepKind = "start" | "page" | "record" | "sheet" | "inline";

export interface Feature {
  readonly id: string;
  readonly name: string;
  readonly tab: string;
  readonly web?: ReadonlyArray<string> | undefined;
  readonly phone?: ReadonlyArray<string> | undefined;
  readonly roles: Record<Role, Reach>;
  readonly note?: string;
  readonly tools?: ReadonlyArray<string>;
  readonly form?: boolean;
  readonly proof: ReadonlyArray<string> | "none";
  /** Why a path may break the depth rule. Required exactly when it does. */
  readonly depth_reason?: string;
}

export interface FeatureMap {
  readonly features: ReadonlyArray<Feature>;
  /** Inventory entries no feature needs to list, each with its reason. */
  readonly unlisted?: Record<string, string>;
}

export interface Inventory {
  /** Web route ids (`tasks`, `settings/check-ins`) to the file that defines them. */
  readonly webRoutes: ReadonlyMap<string, string>;
  /** The record panes a place opens from its search params. */
  readonly webParams: ReadonlySet<string>;
  /** Phone screens to whether they open as a page or a sheet. */
  readonly phoneScreens: ReadonlyMap<string, "page" | "sheet">;
  readonly tools: ReadonlySet<string>;
  /** Every Kin RPC, and the ones a web, phone or client-runtime source file names. */
  readonly rpcs: ReadonlySet<string>;
  readonly calledRpcs: ReadonlySet<string>;
}

const read = (root: string, path: string) => NodeFS.readFileSync(NodePath.join(root, path), "utf8");

const CLIENT_DIRS = ["packages/client-runtime/src", "apps/web/src", "apps/mobile/src"];

function clientSources(root: string): string {
  const texts: Array<string> = [];
  const walk = (dir: string) => {
    for (const entry of NodeFS.readdirSync(NodePath.join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(path);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
        texts.push(read(root, path));
    }
  };
  for (const dir of CLIENT_DIRS) walk(dir);
  return texts.join("\n");
}

/** The RPCs a client names, as a string or through a contracts `*_WS_METHODS` constant. */
function calledRpcsIn(root: string, rpcs: ReadonlySet<string>): Set<string> {
  const viaConstant = new Map<string, string>();
  const contracts = "packages/contracts/src";
  for (const file of NodeFS.readdirSync(NodePath.join(root, contracts)))
    if (file.endsWith(".ts"))
      for (const block of read(root, `${contracts}/${file}`).matchAll(
        /export const (\w+_WS_METHODS) = \{([\s\S]*?)\n\}/g,
      ))
        for (const entry of block[2]!.matchAll(/(\w+): "(kin\.[\w.]+)"/g))
          viaConstant.set(entry[2]!, `${block[1]}.${entry[1]}`);
  const text = clientSources(root);
  const escape = (name: string) => name.replace(/\./g, "\\.");
  return new Set(
    [...rpcs].filter((rpc) => {
      if (new RegExp(`["'\`]${escape(rpc)}["'\`]`).test(text)) return true;
      const constant = viaConstant.get(rpc);
      return constant !== undefined && new RegExp(`\\b${escape(constant)}\\b`).test(text);
    }),
  );
}

/** What exists in the code: web routes and panes, phone screens, agent tools. */
export function readInventory(root = REPO_ROOT): Inventory {
  const routesDir = "apps/web/src/routes";
  const webRoutes = new Map<string, string>();
  for (const file of NodeFS.readdirSync(NodePath.join(root, routesDir)).sort()) {
    const path = `${routesDir}/${file}`;
    const kin = /^_chat\.kin\.\$environmentId\.\$orgId\.(?:_places\.)?([\w$-]+)\.tsx$/.exec(file);
    if (kin !== null) {
      if (kin[1] !== "_places") webRoutes.set(kin[1] === "$chatId" ? "chat" : kin[1]!, path);
      continue;
    }
    if (file === "_chat.kin.index.tsx") webRoutes.set("home", path);
    else if (file === "kin.invite.tsx") webRoutes.set("invite", path);
    else {
      const settings = /^_chat\.settings\.([\w-]+)\.tsx$/.exec(file);
      if (settings !== null && /from "[^"]*\/kin(?:\/|")/.test(read(root, path)))
        webRoutes.set(`settings/${settings[1]}`, path);
    }
  }
  const places = read(root, "apps/web/src/kin/kinPlaces.ts");
  const validator = places.slice(places.indexOf("export function validateKinPlaceSearch"));
  const webParams = new Set(
    [...validator.slice(0, validator.indexOf("\n}")).matchAll(/\{ (\w+)(?::|\s*\})/g)].map(
      (match) => match[1]!,
    ),
  );
  const routes = read(root, "apps/mobile/src/features/chats/routes.tsx");
  const screens = routes.slice(routes.indexOf("export const KIN_SCREENS"));
  const phoneScreens = new Map<string, "page" | "sheet">();
  for (const match of screens
    .slice(0, screens.indexOf("\n};"))
    .matchAll(/\n {2}(\w+): createNativeStackScreen\(\{([\s\S]*?)\n {2}\}\),/g))
    phoneScreens.set(match[1]!, /sheetRoute/.test(match[2]!) ? "sheet" : "page");
  const rpcs = new Set<string>(KinRpcs.map((rpc) => rpc._tag));
  return {
    webRoutes,
    webParams,
    phoneScreens,
    tools: new Set([...Object.keys(SHARED_TOOLS), ...TASKS_KEY_TOOLS]),
    rpcs,
    calledRpcs: calledRpcsIn(root, rpcs),
  };
}

export function loadFeatureMap(path = FEATURE_MAP_PATH): FeatureMap {
  return parseYaml(NodeFS.readFileSync(path, "utf8")) as FeatureMap;
}

/** A path step's kind, or an error naming what it doesn't match. */
function stepKind(
  surface: "web" | "phone",
  step: string,
  index: number,
  inventory: Inventory,
): StepKind | string {
  const prefixed = /^(\w+):(.+)$/.exec(step);
  if (prefixed !== null && (INLINE as ReadonlyArray<string>).includes(prefixed[1]!))
    return "inline";
  if (surface === "web") {
    if (prefixed?.[1] === "sheet" || prefixed?.[1] === "dialog") return "sheet";
    if (step.startsWith("?")) {
      if (!inventory.webParams.has(step.slice(1))) return `no web pane "${step}"`;
      return SHEET_PANES.has(step.slice(1)) ? "sheet" : "record";
    }
    if (!inventory.webRoutes.has(step)) return `no web route "${step}"`;
    return index === 0 ? "start" : "page";
  }
  if (prefixed?.[1] === "tab")
    return index === 0 && (DOCK_TABS as ReadonlyArray<string>).includes(prefixed[2]!)
      ? "start"
      : `"${step}" is not a dock tab at the start`;
  const kind = inventory.phoneScreens.get(step);
  if (kind === undefined) return `no phone screen "${step}"`;
  return index === 0 ? "start" : kind;
}

/**
 * The owner's rule: from where you start, a list opens a record, and a form is a sheet. So past
 * the start at most three levels, nothing opens a page from a sheet, and a form ends on a sheet.
 */
function depthProblems(kinds: ReadonlyArray<StepKind>, form: boolean): Array<string> {
  const levels = kinds.slice(1).filter((kind) => kind !== "inline");
  const problems: Array<string> = [];
  if (levels.length > 3) problems.push(`${levels.length} levels deep (at most 3)`);
  const firstSheet = levels.indexOf("sheet");
  if (firstSheet !== -1 && levels.slice(firstSheet).some((kind) => kind !== "sheet"))
    problems.push("opens a page from a sheet");
  if (form && levels.at(-1) !== "sheet") problems.push("a form that is not a sheet");
  return problems;
}

export interface FeatureFacts {
  readonly depth: Partial<Record<"web" | "phone", number>>;
  readonly kinds: Partial<Record<"web" | "phone", ReadonlyArray<StepKind>>>;
}

export function factsOf(feature: Feature, inventory: Inventory): FeatureFacts {
  const depth: Partial<Record<"web" | "phone", number>> = {};
  const kinds: Partial<Record<"web" | "phone", ReadonlyArray<StepKind>>> = {};
  for (const surface of ["web", "phone"] as const) {
    const path = feature[surface];
    if (path === undefined) continue;
    const surfaceKinds = path
      .map((step, index) => stepKind(surface, step, index, inventory))
      .filter((kind): kind is StepKind =>
        ["start", "page", "record", "sheet", "inline"].includes(kind),
      );
    kinds[surface] = surfaceKinds;
    depth[surface] = surfaceKinds.slice(1).filter((kind) => kind !== "inline").length;
  }
  return { depth, kinds };
}

/** Every way the map and the code disagree, one line each. Empty means the map holds. */
export function checkFeatureMap(
  map: FeatureMap,
  inventory: Inventory,
  exists: (path: string) => boolean = (path) => NodeFS.existsSync(NodePath.join(REPO_ROOT, path)),
): Array<string> {
  const problems: Array<string> = [];
  const ids = new Set<string>();
  const listed = { web: new Set<string>(), phone: new Set<string>(), tools: new Set<string>() };
  for (const feature of map.features) {
    const where = `feature ${feature.id ?? "(no id)"}`;
    if (!/^[a-z0-9-]+$/.test(feature.id ?? "")) problems.push(`${where}: id must be kebab-case`);
    if (ids.has(feature.id)) problems.push(`${where}: duplicate id`);
    ids.add(feature.id);
    if (!feature.name) problems.push(`${where}: no name`);
    if (![...DOCK_TABS, "settings", "join"].includes(feature.tab))
      problems.push(`${where}: tab "${feature.tab}" is not a dock tab, settings or join`);
    // A lead is a member who leads a project, so a lead reaches everything a member does.
    for (const surface of ["web", "phone"] as const)
      if (reaches(feature.roles?.member, surface) && !reaches(feature.roles?.lead, surface))
        problems.push(`${where}: member reaches it on ${surface}, but lead doesn't`);
    for (const role of ROLES) {
      const reach = feature.roles?.[role];
      if (!(REACH as ReadonlyArray<string>).includes(reach))
        problems.push(`${where}: roles.${role} must be one of ${REACH.join(", ")}`);
      else if ((reach === "both" || reach === "web") && feature.web === undefined)
        problems.push(`${where}: ${role} reaches it on web, but it has no web path`);
      else if ((reach === "both" || reach === "phone") && feature.phone === undefined)
        problems.push(`${where}: ${role} reaches it on phone, but it has no phone path`);
    }
    const depth: Array<string> = [];
    for (const surface of ["web", "phone"] as const) {
      const path = feature[surface];
      if (path === undefined) continue;
      if (path.length === 0) problems.push(`${where}: empty ${surface} path`);
      const kinds = path.map((step, index) => {
        const kind = stepKind(surface, step, index, inventory);
        if (!["start", "page", "record", "sheet", "inline"].includes(kind))
          problems.push(`${where}: ${surface}: ${kind}`);
        if (surface === "web") {
          if (step.startsWith("?")) listed.web.add(step);
          else if (inventory.webRoutes.has(step)) listed.web.add(step);
        } else listed.phone.add(step);
        return kind as StepKind;
      });
      depth.push(...depthProblems(kinds, feature.form === true).map((one) => `${surface}: ${one}`));
    }
    if (depth.length > 0 && !feature.depth_reason)
      problems.push(`${where}: breaks the depth rule without a depth_reason (${depth.join("; ")})`);
    if (depth.length === 0 && feature.depth_reason)
      problems.push(`${where}: depth_reason given, but its paths keep the rule; remove it`);
    for (const tool of feature.tools ?? []) {
      if (!inventory.tools.has(tool)) problems.push(`${where}: no agent tool "${tool}"`);
      listed.tools.add(tool);
    }
    if (feature.proof !== "none") {
      if (!Array.isArray(feature.proof) || feature.proof.length === 0)
        problems.push(`${where}: proof must be a list of files or "none"`);
      else
        for (const file of feature.proof)
          if (!exists(file)) problems.push(`${where}: proof file ${file} is missing`);
    }
  }
  const unlisted = map.unlisted ?? {};
  const unlistedOk = (key: string) => key in unlisted;
  for (const key of Object.keys(unlisted))
    if (
      !inventory.webRoutes.has(key.replace(/^web:/, "")) &&
      !inventory.webParams.has(key.replace(/^web:\?/, "")) &&
      !inventory.phoneScreens.has(key.replace(/^phone:/, "")) &&
      !inventory.tools.has(key.replace(/^tool:/, "")) &&
      !inventory.rpcs.has(key.replace(/^rpc:/, ""))
    )
      problems.push(`unlisted: "${key}" is not in the code; remove it`);
    else if (key.startsWith("rpc:") && inventory.calledRpcs.has(key.slice(4)))
      problems.push(`unlisted: a client calls "${key.slice(4)}" now; remove it`);
  for (const route of inventory.webRoutes.keys())
    if (!listed.web.has(route) && !unlistedOk(`web:${route}`))
      problems.push(`web route "${route}" (${inventory.webRoutes.get(route)}) is in no feature`);
  for (const param of inventory.webParams)
    if (!listed.web.has(`?${param}`) && !unlistedOk(`web:?${param}`))
      problems.push(`web pane "?${param}" is in no feature`);
  for (const screen of inventory.phoneScreens.keys())
    if (!listed.phone.has(screen) && !unlistedOk(`phone:${screen}`))
      problems.push(`phone screen "${screen}" is in no feature`);
  for (const tool of inventory.tools)
    if (!listed.tools.has(tool) && !unlistedOk(`tool:${tool}`))
      problems.push(`agent tool "${tool}" is in no feature`);
  for (const rpc of inventory.rpcs)
    if (!inventory.calledRpcs.has(rpc) && !unlistedOk(`rpc:${rpc}`))
      problems.push(`RPC "${rpc}" has no client caller; list it under unlisted with why`);
  return problems;
}

const reaches = (reach: Reach | undefined, surface: "web" | "phone") =>
  reach === "both" || reach === surface;

/**
 * Features some role reaches on the phone that name no proof under apps/mobile. A coverage count,
 * not a check of the role cells: the test pins it so it can only fall.
 */
export const phoneProofGap = (map: FeatureMap) =>
  map.features.filter(
    (feature) =>
      ROLES.some((role) => reaches(feature.roles[role], "phone")) &&
      (feature.proof === "none" || !feature.proof.some((file) => file.startsWith("apps/mobile/"))),
  );
