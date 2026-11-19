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
  readJson,
  readSeed,
  readState,
  sleep,
  stopTree,
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
  const log = NodeFS.openSync(NodePath.join(instance.meta, "chrome", `${person}.log`), "a");
  const child = NodeChildProcess.spawn(
    chromePath(),
    [
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      // Chrome refuses to start as root with its sandbox on (a container or WSL runner).
      ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
      // A second machine someone else is using: no windows on its screen.
      ...(process.env.KIN_VERIFY_HEADLESS === "1" ? ["--headless=new"] : []),
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,900",
      "about:blank",
    ],
    { detached: true, stdio: ["ignore", log, log] },
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

/** Polls the URL: a client-side redirect aborts the navigation `waitForURL` would wait on. */
async function untilUrl(page: Page, done: (url: URL) => boolean, timeoutMs: number) {
  for (let waited = 0; waited < timeoutMs; waited += 100) {
    if (done(new URL(page.url()))) return;
    await sleep(100);
  }
  throw new VerifyError(
    `sign-in stuck on ${new URL(page.url()).pathname}; try \`kin-verify down\` then again`,
  );
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
  /** Where `view --zone` keeps this person's clock zone. */
  readonly zoneFile: string;
  readonly instance: Instance;
}

// Chrome drops a zone override when the connection that set it closes, so each one sets it again.
async function applyZone(page: Page, zoneFile: string) {
  if (!NodeFS.existsSync(zoneFile)) return;
  const cdp = await page.context().newCDPSession(page);
  // An override already set on this connection must be cleared before another is set.
  await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "" });
  await cdp.send("Emulation.setTimezoneOverride", {
    timezoneId: NodeFS.readFileSync(zoneFile, "utf8"),
  });
}

/**
 * The dev web reads `kv clock`'s offset from local storage when it loads (`useKinClock.ts`), so
 * a page that holds another one loads again.
 */
async function applyClock(page: Page, instance: Instance, web: string) {
  if (!page.url().startsWith(web)) return;
  const offset = String(
    readJson<{ offsetMs: number }>(NodePath.join(instance.userdata, "kin-dev-clock.json"))
      ?.offsetMs ?? 0,
  );
  const held = await page.evaluate(() => localStorage.getItem("kin-dev-clock-offset") ?? "0");
  if (held === offset) return;
  await page.evaluate((value) => localStorage.setItem("kin-dev-clock-offset", value), offset);
  await page.reload();
  await settle(page);
}

async function livePage(instance: Instance, person: string): Promise<Page> {
  const { port } = await chromeFor(instance, person);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 8000 });
  const context = browser.contexts()[0]!;
  const page = context.pages().find((one) => !one.isClosed()) ?? (await context.newPage());
  const alive = await Promise.race([
    page.evaluate(() => true).catch(() => false),
    sleep(3000).then(() => false),
  ]);
  if (!alive) throw new VerifyError(`${person}'s browser page is not answering`);
  return page;
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
  const page = await livePage(instance, person).catch(async () => {
    // A page whose renderer died hangs every CDP call; a new Chrome on the same profile keeps the sign-in.
    await stopTree(readState(instance)?.chrome?.[person]);
    return livePage(instance, person);
  });
  const base = `${state.web}/kin/${seed.environmentId}/${ORG}`;
  const signedIn = NodePath.join(profileOf(instance, person), "kin-verify-signed-in");
  if (!NodeFS.existsSync(signedIn) || NodeFS.readFileSync(signedIn, "utf8") !== state.web) {
    if (person === "owner") {
      await page.goto(signIn.pairingUrl());
      await untilUrl(page, (url) => !url.pathname.startsWith("/pair"), 30_000);
    } else {
      await page.goto(`${state.web}/kin/invite#${await signIn.inviteSecret()}`);
      const browserButton = page.getByRole("button", { name: "Continue in the browser" });
      await browserButton.click({ timeout: 15_000 }).catch(() => undefined);
      await untilUrl(page, (url) => !url.pathname.startsWith("/kin/invite"), 30_000);
    }
    await settle(page);
    NodeFS.writeFileSync(signedIn, state.web);
  }
  const zoneFile = NodePath.join(profileOf(instance, person), "kin-verify-zone");
  await applyZone(page, zoneFile);
  await applyClock(page, instance, state.web);
  return { page, web: state.web, base, zoneFile, instance };
}

export function routeUrl(session: WebSession, route: string): string {
  if (/^https?:\/\//.test(route)) return route;
  if (route.startsWith("/")) return `${session.web}${route}`;
  // The feature map's `home`: Kin with no chat open, not a chat called "home".
  if (route === "home") return `${session.web}/kin`;
  return `${session.base}/${route}`;
}

export async function open(session: WebSession, route: string) {
  await session.page.goto(routeUrl(session, route));
  await settle(session.page);
  await applyClock(session.page, session.instance, session.web);
}

/** The browser's Back, as the person would press it. */
export async function back(session: WebSession) {
  await session.page.goBack();
  await settle(session.page);
}

/** The screen as an accessibility tree: an open dialog or sheet if any, else the main area. */
export async function snapshot(session: WebSession, full: boolean): Promise<string> {
  const { page } = session;
  const main = page.locator("main:visible").first();
  const front = await reachable(page);
  const root: Locator = full
    ? page.locator("body")
    : front !== page
      ? (front as Locator)
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

/** The little of the DOM `reachable` touches; these scripts don't compile against the DOM lib. */
interface DomElement {
  readonly offsetParent: unknown;
  closest(selector: string): DomElement | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** Where a person can act: the topmost open dialog or sheet (it blocks the rest), else the page. */
async function reachable(page: Page): Promise<Page | Locator> {
  // A dialog behind another is inert or aria-hidden; the one left is the one in front.
  const top = await page.evaluate(() => {
    const document = (
      globalThis as unknown as {
        document: { querySelectorAll(selector: string): Iterable<DomElement> };
      }
    ).document;
    for (const marked of document.querySelectorAll("[data-kin-verify-top]"))
      marked.removeAttribute("data-kin-verify-top");
    const open = [...document.querySelectorAll("[role=dialog], [role=alertdialog]")].filter(
      (element) =>
        element.offsetParent !== null &&
        element.closest('[aria-hidden="true"], [inert], [data-base-ui-inert]') === null,
    );
    open.at(-1)?.setAttribute("data-kin-verify-top", "");
    return open.length > 0;
  });
  return top ? page.locator("[data-kin-verify-top]") : page;
}

const CONTAINERS = ["region", "article", "listitem", "group", "dialog", "form", "row"] as const;

/** The last visible card, row or section whose accessible name contains `text`. */
async function within(page: Page, text: string): Promise<Locator> {
  const root = await reachable(page);
  for (const role of CONTAINERS) {
    const all = root.getByRole(role, { name: text });
    for (let index = (await all.count()) - 1; index >= 0; index--)
      if (await all.nth(index).isVisible()) return all.nth(index);
  }
  throw new VerifyError(`no card or section named like "${text}"; run \`snapshot\``);
}

async function byName(
  page: Page,
  name: string,
  roles: ReadonlyArray<string>,
  exact: boolean,
  inside?: string,
) {
  // An open menu or listbox renders in a portal outside the dialog, in front of it; so does a
  // toast, which a dialog doesn't block.
  const popups = page.locator(
    "[role=menu]:visible, [role=listbox]:visible, [role=region][aria-label=Notifications] [role=dialog]:visible",
  );
  const root = inside === undefined ? await reachable(page) : await within(page, inside);
  const scopes: Array<Page | Locator> =
    (await popups.count()) > 0 && inside === undefined ? [popups.last(), root] : [root];
  for (const scope of scopes) {
    const found: Array<{ role: string; locator: Locator }> = [];
    for (const role of roles) {
      const all = scope.getByRole(role as (typeof CLICKABLE)[number], { name, exact });
      const count = await all.count();
      for (let index = 0; index < count; index++) {
        const one = all.nth(index);
        if (await one.isVisible()) found.push({ role, locator: one });
      }
    }
    if (found.length > 0) return found;
  }
  return [];
}

/** Clicks the one visible control with this accessible name (`--role`/`--nth` when several). */
export async function click(
  session: WebSession,
  name: string,
  options: { readonly role?: string; readonly nth?: number; readonly within?: string },
) {
  const roles = options.role === undefined ? CLICKABLE : [options.role];
  let found = await byName(session.page, name, roles, true, options.within);
  if (found.length === 0) found = await byName(session.page, name, roles, false, options.within);
  if (found.length === 0)
    throw new VerifyError(`nothing clickable named "${name}"; run \`snapshot\` to see the names`);
  if (found.length > 1 && options.nth === undefined)
    throw new VerifyError(
      `${found.length} controls named "${name}" (${[...new Set(found.map((one) => one.role))].join(", ")}); add --role or --nth <1..${found.length}>`,
    );
  const target = found[(options.nth ?? 1) - 1];
  if (target === undefined) throw new VerifyError(`--nth ${options.nth} is past ${found.length}`);
  await target.locator.click({ timeout: 10_000 });
  await settle(session.page);
  return target.role;
}

/** Puts files in the composer, as the person picking them with "Attach files" would. */
export async function attach(session: WebSession, paths: ReadonlyArray<string>) {
  const { page } = session;
  const files = paths.map((path) => NodePath.resolve(path));
  for (const file of files)
    if (!NodeFS.existsSync(file)) throw new VerifyError(`no file at ${file}`);
  const button = page.getByRole("button", { name: "Attach files" });
  if ((await button.count()) === 0)
    throw new VerifyError("no Attach files button here; open a chat first");
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 10_000 }),
    button.first().click(),
  ]);
  await chooser.setFiles(files);
  await settle(page);
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

/** The window's size and light or dark, as a phone-width or wide screen would show the page. */
export async function view(
  session: WebSession,
  options: {
    readonly width: number;
    readonly height: number;
    readonly colorScheme: "dark" | "light" | null;
    /** The browser's own clock zone, as a person elsewhere has it; the page reloads to read it. */
    readonly zone?: string;
  },
) {
  await session.page.setViewportSize({ width: options.width, height: options.height });
  if (options.zone !== undefined) {
    NodeFS.writeFileSync(session.zoneFile, options.zone);
    await applyZone(session.page, session.zoneFile);
    await session.page.reload();
  }
  if (options.colorScheme !== null) {
    await session.page.emulateMedia({ colorScheme: options.colorScheme });
    // The app keeps its own appearance, read at load.
    await session.page.evaluate(
      (mode) =>
        (
          globalThis as unknown as { localStorage: { setItem(key: string, value: string): void } }
        ).localStorage.setItem("t3code:theme-appearance-mode", mode),
      options.colorScheme,
    );
    await session.page.reload();
  }
  await settle(session.page);
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
