// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off - captures every main Kin screen for the look book.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type { Page } from "playwright-core";

import { agentOf, database, deviceInvite, personIdOf, rpcAs } from "../kin-verify/actors.ts";
import {
  gitHead,
  type Instance,
  instanceOf,
  isInside,
  LIVE_T3,
  mintPairing,
  ORG,
  readSeed,
  readState,
  ROOT,
  sleep,
  startServer,
  stopTree,
  writeSeed,
  writeState,
} from "../kin-verify/instance.ts";
import { VerifyError } from "../kin-verify/rpc.ts";
import { seed, seedTurns } from "../kin-verify/seed.ts";
import * as Web from "../kin-verify/web.ts";
import { type Freeze, freezeEnv, install } from "./freeze.ts";
import {
  fileOf,
  type Manifest,
  type ManifestScreen,
  SIZES,
  type SizeName,
  writeManifest,
} from "./manifest.ts";

export const INSTANCE = "lookbook";
/**
 * Tuesday 4 June 2030, 08:05 in Kolkata: a working morning before the default check-ins (the
 * weekly brief is Mondays), and after the session expiry the browser checks against real time.
 */
export const FROZEN_AT = Date.parse("2030-06-04T02:35:00.000Z");
/** What the browser's clock reads on every screen. */
const SCREEN_AT = FROZEN_AT + 30 * 60_000;
export const TIME_ZONE = "Asia/Kolkata";

const PHONE_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

interface Context {
  readonly web: string;
  readonly base: string;
  readonly chiefChat: string;
  readonly financeChat: string;
  readonly groupChat: string;
  readonly briefMessage: string;
  readonly chiefId: string;
  readonly financeId: string;
  readonly zoyaId: string;
  readonly docKey: string;
  readonly inviteSecret: string;
}

interface Screen {
  readonly name: string;
  readonly person: "owner" | "zoya" | "invitee";
  readonly url: (context: Context) => string;
  /** Text that shows once the screen has what it is for. */
  readonly shows: string;
  /** What a person does on the page before it is captured. */
  readonly act?: (page: Page) => Promise<void>;
}

const place = (path: string) => (context: Context) => `${context.base}/${path}`;

export const SCREENS: ReadonlyArray<Screen> = [
  { name: "chats-list", person: "owner", url: (c) => `${c.web}/kin`, shows: "Chief of staff" },
  {
    name: "chat-agent",
    person: "owner",
    url: (c) => `${c.base}/${c.chiefChat}`,
    shows: "I'll look again on Friday",
  },
  {
    name: "morning-brief",
    person: "owner",
    url: (c) => `${c.base}/${c.chiefChat}?message=${c.briefMessage}`,
    shows: "Coming up",
  },
  {
    name: "chat-cards",
    person: "owner",
    url: (c) => `${c.base}/${c.financeChat}`,
    shows: "ready to send",
  },
  { name: "tasks", person: "owner", url: place("tasks"), shows: "Waiting on others" },
  { name: "task", person: "owner", url: place("tasks?task=W-1"), shows: "Design the booking flow" },
  {
    name: "new-task",
    person: "owner",
    url: place("tasks"),
    shows: "Waiting on others",
    act: async (page) => {
      await page.getByRole("button", { name: "New task", exact: true }).click({ timeout: 10_000 });
      await page.getByRole("dialog", { name: "New task" }).waitFor({ timeout: 10_000 });
    },
  },
  { name: "projects", person: "owner", url: place("clients?tab=projects"), shows: "On track" },
  {
    name: "project",
    person: "owner",
    url: place("clients?project=P-1"),
    shows: "Lumen Grove patient booking app",
  },
  { name: "money", person: "owner", url: place("money"), shows: "Who owes us" },
  { name: "clients", person: "owner", url: place("clients"), shows: "Harbourline Logistics" },
  {
    name: "client",
    person: "owner",
    url: place("clients?client=C-1"),
    shows: "Lumen Grove Clinics",
  },
  { name: "docs", person: "owner", url: place("docs"), shows: "Playbooks" },
  {
    name: "doc",
    person: "owner",
    url: (c) => `${c.base}/docs?doc=${c.docKey}`,
    shows: "Patients book, move and cancel",
  },
  {
    name: "agent-page",
    person: "owner",
    url: (c) => `${c.base}/${c.financeChat}?agent=${c.financeId}`,
    shows: "Finance",
  },
  {
    name: "person-page",
    person: "owner",
    url: (c) => `${c.base}/tasks?person=${c.zoyaId}`,
    shows: "Zoya Sheikh",
  },
  {
    name: "group-chat",
    person: "owner",
    url: (c) => `${c.base}/${c.groupChat}`,
    shows: "the second draft is ready",
  },
  {
    name: "settings-agents",
    person: "owner",
    url: (c) => `${c.web}/kin?settings=agents`,
    shows: "Chief of staff",
  },
  {
    name: "settings-agent",
    person: "owner",
    url: (c) => `${c.web}/kin?settings=agents`,
    shows: "Chief of staff",
    act: async (page) => {
      await page
        .getByRole("dialog")
        .getByRole("link", { name: /Chief of staff/ })
        .first()
        .click({ timeout: 10_000 });
      await page.getByText("Chief of staff").first().waitFor({ timeout: 10_000 });
    },
  },
  {
    name: "settings-team",
    person: "owner",
    url: (c) => `${c.web}/kin?settings=team`,
    shows: "Zoya Sheikh",
  },
  {
    name: "settings-company",
    person: "owner",
    url: (c) => `${c.web}/kin?settings=company`,
    shows: "Ambermill",
  },
  {
    name: "settings-check-ins",
    person: "owner",
    url: (c) => `${c.web}/kin?settings=check-ins`,
    shows: "Morning brief",
  },
  {
    name: "settings-profile",
    person: "owner",
    url: (c) => `${c.web}/kin?settings=profile`,
    shows: "Rhea Kapoor",
  },
  {
    name: "invite",
    person: "invitee",
    url: (c) => `${c.web}/kin/invite#${c.inviteSecret}`,
    shows: "Join your team",
  },
  { name: "zoya-chats-list", person: "zoya", url: (c) => `${c.web}/kin`, shows: "Chief of staff" },
  { name: "zoya-tasks", person: "zoya", url: place("tasks"), shows: "Design the booking flow" },
  { name: "zoya-money", person: "zoya", url: place("money"), shows: "Money" },
];

/** No animation, transition or caret, and no scrollbar that comes and goes. */
const STILL_CSS = `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}
::-webkit-scrollbar{display:none!important}*{scrollbar-width:none!important}`;

const STILL_SCRIPT = `(() => {
  const add = () => {
    if (document.getElementById("kin-lookbook-still")) return;
    const style = document.createElement("style");
    style.id = "kin-lookbook-still";
    style.textContent = ${JSON.stringify(STILL_CSS)};
    (document.head ?? document.documentElement).append(style);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add();
})()`;

/** Every font loaded, every image decoded, no "Loading…" left. */
const READY_SCRIPT = `(async () => {
  await document.fonts.ready;
  await Promise.all([...document.images].map((img) => img.complete ? null : img.decode().catch(() => null)));
  return !/Loading…|Loading\\.\\.\\./.test(document.body.innerText);
})()`;

/**
 * Times the run itself stamped (a message's "8:07 AM", "3 minutes ago") depend on how fast it ran,
 * so they read "hh:mm" and "n". Clock times outside the run, such as a check-in's hour, stay.
 */
const MASK_SCRIPT = (from: number, to: number) => `(() => {
  const clock = /\\b(\\d{1,2}):(\\d{2})(\\s?[AaPp]\\.?[Mm]\\.?)?/g;
  const ago = /\\b\\d+(\\s?(?:s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)\\s+ago)\\b/g;
  const counts = { clock: 0, ago: 0 };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const before = node.data;
    const after = before
      .replace(clock, (match, h, m, half) => {
        let hour = Number(h) % 12;
        if (half === undefined) hour = Number(h);
        else if (/p/i.test(half)) hour += 12;
        const minute = hour * 60 + Number(m);
        if (minute < ${from} || minute >= ${to}) return match;
        counts.clock++;
        return "hh:mm";
      })
      .replace(ago, (_match, rest) => { counts.ago++; return "n" + rest; });
    if (after !== before) node.data = after;
  }
  return counts;
})()`;

const minuteOfDay = (at: number) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((one) => one.type === type)!.value);
  return part("hour") * 60 + part("minute");
};

const MASK = MASK_SCRIPT(minuteOfDay(FROZEN_AT), minuteOfDay(SCREEN_AT));

async function settled(
  page: Page,
  timeoutMs = 20_000,
): Promise<{ shot: Buffer; settled: boolean; masked: Array<string> }> {
  const deadline = performance.now() + timeoutMs;
  let previous: Buffer | undefined;
  let shot: Buffer = Buffer.alloc(0);
  let counts = { clock: 0, ago: 0 };
  const masked = () => [
    ...(counts.clock > 0 ? [`${counts.clock} clock time(s) the run stamped, shown as hh:mm`] : []),
    ...(counts.ago > 0 ? [`${counts.ago} "… ago" count(s), shown as n`] : []),
  ];
  // No hover: a pointer left over a row by the last click shows that row's time or menu.
  const size = page.viewportSize();
  await page.mouse.move((size?.width ?? 1) - 1, 0);
  while (performance.now() < deadline) {
    const ready = (await page.evaluate(READY_SCRIPT).catch(() => false)) === true;
    counts = ((await page.evaluate(MASK).catch(() => null)) as typeof counts | null) ?? counts;
    shot = await page.screenshot({ animations: "disabled", caret: "hide", scale: "css" });
    if (ready && previous !== undefined && previous.equals(shot))
      return { shot, settled: true, masked: masked() };
    previous = ready ? shot : undefined;
    await sleep(400);
  }
  return { shot, settled: false, masked: masked() };
}

async function prepare(page: Page) {
  const context = page.context();
  await context.addInitScript(STILL_SCRIPT);
  await context.clock.setFixedTime(SCREEN_AT);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setLocaleOverride", { locale: "en-US" }).catch(() => undefined);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
}

async function stop(instance: Instance, wipe: boolean) {
  const state = readState(instance);
  if (state !== undefined) {
    for (const pid of [...Object.values(state.chrome ?? {}), state.metro, state.pid])
      await stopTree(pid);
    writeState(instance, { ...state, chrome: {}, metro: undefined });
  }
  if (wipe) NodeFS.rmSync(instance.home, { recursive: true, force: true });
}

/** A fresh instance on the frozen clock, seeded with the look book's company. */
async function bringUp(instance: Instance, log: (line: string) => void) {
  await stop(instance, true);
  let state = await startServer(instance);
  const environmentId = NodeFS.readFileSync(
    NodePath.join(instance.userdata, "environment-id"),
    "utf8",
  ).trim();
  log("seeding Ambermill");
  writeSeed(instance, await seed(instance, "lookbook", environmentId));
  // The lead runner finds a company's first agents on its next scan; a restart is sooner.
  await stopTree(state.pid);
  state = await startServer(instance);
  log("staging the brief, cards and group");
  await seedTurns(instance, "lookbook");
  return state;
}

function contextOf(instance: Instance, web: string, inviteSecret: string): Context {
  const seeded = readSeed(instance)!;
  const db = database(instance);
  try {
    const one = <A>(sql: string, ...params: Array<string>) => {
      const row = db.prepare(sql).get(...params) as A | undefined;
      if (row === undefined) throw new VerifyError(`look book: nothing for ${sql}`);
      return row;
    };
    const chief = agentOf(instance, "chief");
    const finance = agentOf(instance, "finance");
    const chiefChat = seeded.agents.chief!.ownerChatId;
    return {
      web,
      base: `${web}/kin/${seeded.environmentId}/${ORG}`,
      chiefChat,
      financeChat: seeded.agents.finance!.ownerChatId,
      groupChat: one<{ id: string }>(
        "SELECT chat_id AS id FROM kin_chats WHERE title = 'Orbit launch' ORDER BY chat_id LIMIT 1",
      ).id,
      briefMessage: one<{ id: string }>(
        "SELECT message_id AS id FROM kin_messages WHERE chat_id = ? AND form = 'brief' ORDER BY seq DESC LIMIT 1",
        chiefChat,
      ).id,
      chiefId: chief.agentId,
      financeId: finance.agentId,
      zoyaId: personIdOf(instance, "zoya"),
      docKey: one<{ key: string }>(
        "SELECT key FROM kin_records WHERE title = 'Lumen Grove booking app: brief' ORDER BY key LIMIT 1",
      ).key,
      inviteSecret,
    };
  } finally {
    db.close();
  }
}

async function tabOf(page: Page) {
  const title = await page.title();
  const href = (await page.evaluate(
    `document.querySelector('link[rel~="icon"]')?.getAttribute("href") ?? ""`,
  )) as string;
  let iconSha256: string | null = null;
  if (href !== "") {
    const response = await fetch(new URL(href, page.url())).catch(() => null);
    if (response?.ok)
      iconSha256 = NodeCrypto.createHash("sha256")
        .update(new Uint8Array(await response.arrayBuffer()))
        .digest("hex");
  }
  return { title, icon: href, iconSha256 };
}

function freeDiskGb(): number {
  const out = NodeChildProcess.spawnSync("df", ["-g", "/"], { encoding: "utf8" }).stdout;
  return Number(out.trim().split("\n").at(-1)?.split(/\s+/)[3] ?? "0");
}

export interface CaptureOptions {
  readonly out: string;
  readonly only?: ReadonlySet<string>;
  /** Leave the instance running afterwards, to look at it. */
  readonly keep?: boolean;
  readonly log: (line: string) => void;
}

export async function capture(options: CaptureOptions): Promise<Manifest> {
  const out = NodePath.resolve(options.out);
  if (isInside(out, LIVE_T3) || isInside(out, ROOT))
    throw new VerifyError(`--out ${out}: captures live outside the repo and outside ${LIVE_T3}`);
  const free = freeDiskGb();
  if (free < 15)
    throw new VerifyError(`only ${free} GB free on /; the look book stops under 15 GB`);
  NodeFS.mkdirSync(out, { recursive: true });
  for (const file of NodeFS.readdirSync(out))
    if (file.endsWith(".png") || file === "manifest.json") NodeFS.rmSync(NodePath.join(out, file));

  const started = Date.now();
  const instance = instanceOf(INSTANCE);
  const server: Freeze = {
    epoch: FROZEN_AT,
    origin: started,
    starts: NodePath.join(NodeOS.tmpdir(), `kin-lookbook-starts-${process.pid}.json`),
  };
  NodeFS.rmSync(server.starts, { force: true });
  process.env.TZ = TIME_ZONE;
  process.env.KIN_VERIFY_HEADLESS = "1";
  Object.assign(process.env, freezeEnv(server));
  const preload = NodeURL.pathToFileURL(NodePath.join(import.meta.dirname, "preload.ts")).href;
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import ${preload}`.trim();
  // This process seeds dates and turn markers on the server's clock.
  install(server, "/scripts/kin-verify");

  const commit = gitHead();
  const screens: Array<ManifestScreen> = [];
  const failed: Array<Manifest["failed"][number]> = [];
  const tab: Record<string, Manifest["tab"][string]> = {};
  try {
    options.log(`starting instance ${INSTANCE}`);
    const state = await bringUp(instance, options.log);
    const web = state.web!;
    const owner = await rpcAs(instance, "owner");
    let inviteSecret: string;
    try {
      inviteSecret = (
        (await owner.call("kin.people.createInvite", {
          orgId: ORG,
          displayName: "Kabir Shah",
        })) as { secret: string }
      ).secret;
    } finally {
      owner.close();
    }
    const context = contextOf(instance, web, inviteSecret);
    const signIn = (person: string) => ({
      pairingUrl: () => `${web}/pair#token=${mintPairing(instance, "kin-lookbook web").token}`,
      inviteSecret: () => deviceInvite(instance, person),
    });
    const pages = new Map<string, Page>();
    const pageOf = async (person: Screen["person"]) => {
      const found = pages.get(person);
      if (found !== undefined) return found;
      let page: Page;
      if (person === "invitee") {
        // Someone who has never signed in, on a phone's browser: the page that asks before it
        // spends the link (a desktop browser joins at once and moves on to the chats).
        const browser = (await pageOf("owner")).context().browser()!;
        page = await (await browser.newContext({ userAgent: PHONE_AGENT })).newPage();
      } else {
        NodeFS.mkdirSync(NodePath.join(instance.meta, "chrome", person), { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(instance.meta, "chrome", person, "kin-verify-zone"),
          TIME_ZONE,
        );
        page = (await Web.openWeb(instance, person, signIn(person))).page;
      }
      await prepare(page);
      pages.set(person, page);
      return page;
    };
    const wanted = SCREENS.filter((screen) => options.only?.has(screen.name) ?? true);
    for (const size of SIZES) {
      for (const screen of wanted) {
        const file = fileOf(screen.name, size.name);
        try {
          const page = await pageOf(screen.person);
          await page.setViewportSize({ width: size.width, height: size.height });
          // A dev server's first load of a route can outlast one wait; a reload gets the second.
          for (let attempt = 1; ; attempt++) {
            await page.goto(screen.url(context));
            const shown = await page
              .getByText(screen.shows)
              .first()
              .waitFor({ timeout: 20_000 })
              .then(
                () => null,
                (error: Error) => error,
              );
            if (shown === null) break;
            if (attempt === 2) throw shown;
          }
          await screen.act?.(page);
          const shot = await settled(page);
          NodeFS.writeFileSync(NodePath.join(out, file), shot.shot);
          screens.push({
            name: screen.name,
            size: size.name as SizeName,
            file,
            person: screen.person,
            masked: shot.masked,
            ...(shot.settled ? {} : { unsettled: true }),
          });
          if (screen.name === "chats-list" || screen.name === "zoya-chats-list")
            tab[screen.person] ??= await tabOf(page);
          options.log(`${file}${shot.settled ? "" : " (still moving after 20 s)"}`);
        } catch (error) {
          const message = (error as Error).message.split("\n")[0] ?? String(error);
          failed.push({ name: screen.name, size: size.name as SizeName, error: message });
          options.log(`${file} FAILED: ${message}`);
        }
      }
    }
  } finally {
    if (options.keep !== true) await stop(instance, true);
    NodeFS.rmSync(server.starts, { force: true });
  }
  const manifest: Manifest = {
    version: 1,
    surface: "web",
    commit,
    shortCommit: commit.slice(0, 10),
    capturedAt: new Date(started).toISOString(),
    frozenAt: new Date(FROZEN_AT).toISOString(),
    timeZone: TIME_ZONE,
    sizes: SIZES.map(({ name, width, height }) => ({ name, width, height })),
    screens,
    tab,
    failed,
  };
  writeManifest(out, manifest);
  return manifest;
}
