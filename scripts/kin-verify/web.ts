// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - drives a headless Chrome for a dev CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";

import {
  type Instance,
  type InstanceState,
  isAlive,
  isInside,
  LIVE_T3,
  ORG,
  readSeed,
  readState,
  sleep,
  writeState,
} from "./instance.ts";
import { VerifyError } from "./rpc.ts";

/** Newest-first paths `<dir>/<child>/<grandchild>/<binary>`: Chrome caches nest by version, then platform. */
const binariesUnder = (dir: string, binary: string): Array<string> => {
  const list = (path: string) => {
    try {
      return NodeFS.readdirSync(path).sort().reverse();
    } catch {
      return [];
    }
  };
  return list(dir).flatMap((child) =>
    list(NodePath.join(dir, child)).map((grandchild) =>
      NodePath.join(dir, child, grandchild, binary),
    ),
  );
};

/** A Chrome already on this machine: one we were pointed at, Playwright's, or T3's preview one. */
function chromePath(): string {
  const found = [
    process.env.KIN_VERIFY_CHROME,
    ...binariesUnder(
      NodePath.join(NodeOS.homedir(), "Library", "Caches", "ms-playwright"),
      "chrome-headless-shell",
    ),
    ...binariesUnder(
      NodePath.join(NodeOS.homedir(), ".cache", "ms-playwright"),
      "chrome-headless-shell",
    ),
    // T3's preview browser keeps its download at <platform>/<version>/.
    ...binariesUnder(
      NodePath.join(LIVE_T3, "tools", "chrome-headless-shell"),
      "chrome-headless-shell",
    ),
  ].find((path) => path !== undefined && NodeFS.existsSync(path));
  if (found === undefined)
    throw new VerifyError(
      "no headless Chrome found. Set KIN_VERIFY_CHROME to a Chrome binary, or open T3's browser preview once so it downloads chrome-headless-shell",
    );
  return found;
}

const profileOf = (instance: Instance, person: string) =>
  NodePath.join(instance.meta, "chrome", person);

/** The person's own Chrome: started once, left running between commands, stopped by `down`. */
async function chromeFor(
  instance: Instance,
  person: string,
): Promise<{ port: number; fresh: boolean }> {
  const profile = profileOf(instance, person);
  const portFile = NodePath.join(profile, "DevToolsActivePort");
  const state = readState(instance)!;
  const pid = state.chrome?.[person];
  if (isAlive(pid) && NodeFS.existsSync(portFile))
    return { port: Number(NodeFS.readFileSync(portFile, "utf8").split("\n")[0]), fresh: false };
  NodeFS.mkdirSync(profile, { recursive: true });
  NodeFS.rmSync(portFile, { force: true });
  const child = NodeChildProcess.spawn(
    chromePath(),
    [
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,900",
      "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  const next: InstanceState = { ...state, chrome: { ...state.chrome, [person]: child.pid! } };
  writeState(instance, next);
  for (let waited = 0; waited < 15_000; waited += 100) {
    if (NodeFS.existsSync(portFile)) {
      const port = Number(NodeFS.readFileSync(portFile, "utf8").split("\n")[0]);
      if (port > 0) return { port, fresh: true };
    }
    await sleep(100);
  }
  throw new VerifyError(`Chrome for ${person} did not start; try \`kin-verify down\` then again`);
}

/** Settles after navigation or a click: network quiet, then a beat for React to paint. */
async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
  await sleep(400);
}

export interface WebSession {
  readonly page: Page;
  readonly web: string;
  readonly base: string;
}

/**
 * Connects to the person's Chrome, signing it in the way that person would on first use: the
 * owner opens a pairing link, anyone else an invite link made for their existing person.
 */
export async function openWeb(
  instance: Instance,
  person: string,
  signIn: { readonly pairingUrl: () => string; readonly inviteSecret: () => Promise<string> },
): Promise<WebSession> {
  const state = readState(instance);
  const seed = readSeed(instance);
  if (state?.web === undefined || seed === undefined)
    throw new VerifyError("no ready instance; run `kin-verify up`");
  const { port } = await chromeFor(instance, person);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0]!;
  const page = context.pages().find((one) => !one.isClosed()) ?? (await context.newPage());
  const base = `${state.web}/kin/${seed.environmentId}/${ORG}`;
  const signedIn = NodePath.join(profileOf(instance, person), "kin-verify-signed-in");
  if (!NodeFS.existsSync(signedIn) || NodeFS.readFileSync(signedIn, "utf8") !== state.web) {
    if (person === "owner") {
      await page.goto(signIn.pairingUrl());
      await page.waitForURL((url) => !url.pathname.startsWith("/pair"), { timeout: 30_000 });
    } else {
      await page.goto(`${state.web}/kin/invite#${await signIn.inviteSecret()}`);
      const browserButton = page.getByRole("button", { name: "Continue in the browser" });
      await Promise.race([
        browserButton.click({ timeout: 15_000 }).catch(() => undefined),
        page.waitForURL((url) => !url.pathname.startsWith("/kin/invite"), { timeout: 15_000 }),
      ]);
      await page.waitForURL((url) => !url.pathname.startsWith("/kin/invite"), { timeout: 30_000 });
    }
    await settle(page);
    NodeFS.writeFileSync(signedIn, state.web);
  }
  return { page, web: state.web, base };
}

export function routeUrl(session: WebSession, route: string): string {
  if (/^https?:\/\//.test(route)) return route;
  if (route.startsWith("/")) return `${session.web}${route}`;
  return `${session.base}/${route}`;
}

export async function open(session: WebSession, route: string) {
  await session.page.goto(routeUrl(session, route));
  await settle(session.page);
}

/** The screen as an accessibility tree: an open dialog or sheet if any, else the main area. */
export async function snapshot(session: WebSession, full: boolean): Promise<string> {
  const { page } = session;
  const dialogs = page.locator("[role=dialog]:visible, [role=alertdialog]:visible");
  const main = page.locator("main:visible").first();
  const root: Locator = full
    ? page.locator("body")
    : (await dialogs.count()) > 0
      ? dialogs.last()
      : (await main.count()) > 0
        ? main
        : page.locator("body");
  const url = new URL(page.url());
  const path = `${url.pathname.replace(session.base.replace(session.web, ""), "~")}${url.search}`;
  return `# ${path}\n${await root.ariaSnapshot({ timeout: 10_000 })}`;
}

const CLICKABLE = [
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "checkbox",
  "radio",
  "switch",
  "treeitem",
  "row",
  "combobox",
] as const;

async function byName(page: Page, name: string, roles: ReadonlyArray<string>, exact: boolean) {
  const found: Array<{ role: string; locator: Locator }> = [];
  for (const role of roles) {
    const all = page.getByRole(role as (typeof CLICKABLE)[number], { name, exact });
    const count = await all.count();
    for (let index = 0; index < count; index++) {
      const one = all.nth(index);
      if (await one.isVisible()) found.push({ role, locator: one });
    }
  }
  return found;
}

/** Clicks the one visible control with this accessible name (`--role`/`--nth` when several). */
export async function click(
  session: WebSession,
  name: string,
  options: { readonly role?: string; readonly nth?: number },
) {
  const roles = options.role === undefined ? CLICKABLE : [options.role];
  let found = await byName(session.page, name, roles, true);
  if (found.length === 0) found = await byName(session.page, name, roles, false);
  if (found.length === 0)
    throw new VerifyError(`nothing clickable named "${name}"; run \`snapshot\` to see the names`);
  if (found.length > 1 && options.nth === undefined)
    throw new VerifyError(
      `${found.length} controls named "${name}" (${[...new Set(found.map((one) => one.role))].join(", ")}); add --role or --nth <1..${found.length}>`,
    );
  const target = found[(options.nth ?? 1) - 1];
  if (target === undefined) throw new VerifyError(`--nth ${options.nth} is past ${found.length}`);
  await target.locator.click();
  await settle(session.page);
  return target.role;
}

/** Types into the named field, or the focused one, or the page's only text area. */
export async function type(
  session: WebSession,
  text: string,
  options: { readonly name?: string; readonly enter: boolean },
) {
  const { page } = session;
  let field: Locator;
  if (options.name !== undefined) {
    const found = await byName(
      page,
      options.name,
      ["textbox", "searchbox", "combobox", "spinbutton"],
      false,
    );
    if (found.length !== 1)
      throw new VerifyError(
        `${found.length} fields named "${options.name}"; run \`snapshot\` to see field names`,
      );
    field = found[0]!.locator;
  } else {
    const focused = page.locator("input:focus, textarea:focus, [contenteditable=true]:focus");
    const areas = page.locator("textarea:visible");
    if ((await focused.count()) === 1) field = focused;
    else if ((await areas.count()) === 1) field = areas;
    else throw new VerifyError('which field? pass --name "<field label>"');
  }
  await field.fill(text);
  if (options.enter) await field.press("Enter");
  await settle(page);
}

/** Waits until the screen's text has (or, with `gone`, no longer has) this text. */
export async function waitFor(
  session: WebSession,
  text: string,
  options: { readonly gone: boolean; readonly timeoutMs: number },
) {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const body = await session.page.locator("body").innerText();
    if (body.includes(text) !== options.gone) return;
    await sleep(300);
  }
  throw new VerifyError(
    `${options.gone ? "still showing" : "never showed"} "${text}" after ${options.timeoutMs / 1000}s; run \`snapshot\``,
  );
}

/** Screenshots only to an explicit path, never into the live install's tree. */
export async function screenshot(session: WebSession, path: string, full: boolean) {
  const target = NodePath.resolve(path);
  if (isInside(target, LIVE_T3) || isInside(NodePath.dirname(target), LIVE_T3))
    throw new VerifyError(
      `refusing to write under ${LIVE_T3}; pick a path outside it, such as /tmp/kin-proof/shot.png`,
    );
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  await session.page.screenshot({ path: target, fullPage: full });
  return target;
}

export async function stopChrome(instance: Instance, state: InstanceState) {
  for (const pid of Object.values(state.chrome ?? {}))
    if (isAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  for (let waited = 0; waited < 3000; waited += 100) {
    if (!Object.values(state.chrome ?? {}).some(isAlive)) break;
    await sleep(100);
  }
  for (const pid of Object.values(state.chrome ?? {}))
    if (isAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  void instance;
}
