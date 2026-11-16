// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - kin-bench's browser measurements.
/**
 * The web client measured in each person's headless Chrome from kin-verify: timings from the
 * action to the first frame that shows its result, WebSocket frames through CDP, page metrics.
 */
import * as NodeZlib from "node:zlib";

import type { CDPSession, Page } from "playwright-core";

import { sleep } from "../kin-verify/instance.ts";
import type { WireRow } from "./stats.ts";

interface Frame {
  readonly dir: "in" | "out";
  readonly bytes: number;
  /** Server-to-client frames: about what crossed the link (`deflatedSize`). */
  readonly deflated: number;
  readonly at: number;
  readonly request: boolean;
  /** The RPC a request frame calls, such as kin.work.list. */
  readonly method?: string;
}

/** permessage-deflate keeps its 32 KB window across a socket's messages (`server.ts`). */
const DEFLATE_WINDOW = 32 * 1024;

/**
 * About the bytes one message costs on a socket that compresses with context takeover: deflated
 * with the socket's previous 32 KB as its dictionary, less the 4-byte tail the extension drops.
 * Chrome's log only has the inflated text.
 */
export function deflatedSize(payload: string, window: Buffer): number {
  const raw = Buffer.from(payload);
  const out = NodeZlib.deflateRawSync(raw, {
    windowBits: 15,
    ...(window.length === 0 ? {} : { dictionary: window }),
  });
  return Math.max(1, out.length - 4);
}

const methodOf = (payload: string) => {
  const tag = /"_tag":"Request".*?"tag":"([^"]+)"/.exec(payload)?.[1];
  return tag === undefined ? {} : { method: tag };
};

/** Every WebSocket frame and script/style byte this page moves, from Chrome's own network log. */
export class Probe {
  readonly frames: Array<Frame> = [];
  readonly assets = new Map<string, { type: string; bytes: number; url: string }>();
  readonly page: Page;
  readonly cdp: CDPSession;
  private constructor(page: Page, cdp: CDPSession) {
    this.page = page;
    this.cdp = cdp;
  }

  static async attach(page: Page): Promise<Probe> {
    const cdp = await page.context().newCDPSession(page);
    const probe = new Probe(page, cdp);
    await cdp.send("Network.enable");
    await cdp.send("Performance.enable");
    const types = new Map<string, { type: string; url: string }>();
    cdp.on("Network.responseReceived", (event) =>
      types.set(event.requestId, { type: event.type, url: event.response.url }),
    );
    cdp.on("Network.loadingFinished", (event) => {
      const seen = types.get(event.requestId);
      if (seen?.type === "Script" || seen?.type === "Stylesheet")
        probe.assets.set(event.requestId, {
          type: seen.type,
          url: seen.url,
          bytes: event.encodedDataLength,
        });
    });
    const windows = new Map<string, Buffer>();
    cdp.on("Network.webSocketFrameReceived", (event) => {
      const payload = event.response.payloadData;
      const window = windows.get(event.requestId) ?? Buffer.alloc(0);
      const deflated = deflatedSize(payload, window);
      windows.set(
        event.requestId,
        Buffer.concat([window, Buffer.from(payload)]).subarray(-DEFLATE_WINDOW),
      );
      probe.frames.push({
        dir: "in",
        bytes: Buffer.byteLength(payload),
        deflated,
        at: performance.now(),
        request: false,
      });
    });
    cdp.on("Network.webSocketFrameSent", (event) =>
      probe.frames.push({
        dir: "out",
        bytes: Buffer.byteLength(event.response.payloadData),
        deflated: 0,
        at: performance.now(),
        request: event.response.payloadData.includes('"_tag":"Request"'),
        ...methodOf(event.response.payloadData),
      }),
    );
    return probe;
  }

  mark() {
    return this.frames.length;
  }

  wire(action: string, from: number): WireRow {
    const frames = this.frames.slice(from);
    const sum = (dir: "in" | "out") =>
      frames.filter((one) => one.dir === dir).reduce((total, one) => total + one.bytes, 0);
    return {
      action,
      framesIn: frames.filter((one) => one.dir === "in").length,
      bytesIn: sum("in"),
      deflatedIn: frames.reduce((total, one) => total + one.deflated, 0),
      framesOut: frames.filter((one) => one.dir === "out" && one.bytes > 20).length,
      bytesOut: sum("out"),
      largest: Math.max(0, ...frames.filter((one) => one.dir === "in").map((one) => one.bytes)),
      methods: frames.reduce<Record<string, number>>((count, one) => {
        if (one.method !== undefined) count[one.method] = (count[one.method] ?? 0) + 1;
        return count;
      }, {}),
    };
  }

  async metrics(): Promise<Record<string, number>> {
    const { metrics } = await this.cdp.send("Performance.getMetrics");
    return Object.fromEntries(metrics.map((one) => [one.name, one.value]));
  }
}

/** True once text containing `text` is laid out inside the viewport. */
const VISIBLE = ({ text, scope }: { text: string; scope: string }) => {
  const doc = (globalThis as unknown as { document: any; innerHeight: number }).document;
  const height = (globalThis as unknown as { innerHeight: number }).innerHeight;
  const root = doc.querySelector(scope);
  if (root === null) return false;
  const walker = doc.createTreeWalker(root, 4);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    // A message's names are links, so its text can span several nodes in one paragraph.
    const piece = node.data.trim();
    const inBlock =
      piece !== "" &&
      text.includes(piece) &&
      node.parentElement?.closest("p, li, td, h1, h2, h3, h4")?.textContent?.includes(text);
    if (!node.data.includes(text) && !inBlock) continue;
    const box = node.parentElement?.getBoundingClientRect();
    if (box !== undefined && box.height > 0 && box.bottom > 0 && box.top < height) return true;
  }
  return false;
};

/** `scope` is `main` for what a screen shows, `nav` for the chat list beside it. */
export async function untilVisible(page: Page, text: string, scope = "main", timeoutMs = 30_000) {
  await page.waitForFunction(VISIBLE, { text, scope }, { polling: "raf", timeout: timeoutMs });
}

/** Milliseconds from `act` to the first frame where `text` is on screen. */
export async function timed(
  page: Page,
  act: () => Promise<unknown>,
  text: string,
  scope = "main",
): Promise<number> {
  const started = performance.now();
  await act();
  await untilVisible(page, text, scope);
  return performance.now() - started;
}

/** Per keystroke: keydown to the next frame after it, measured in the page. */
export async function typingLatency(page: Page, text: string): Promise<Array<number>> {
  await page.evaluate(() => {
    const scope = globalThis as unknown as {
      __kinBenchKeys: Array<number>;
      addEventListener: Function;
      requestAnimationFrame: Function;
      MessageChannel: any;
    };
    scope.__kinBenchKeys = [];
    scope.addEventListener(
      "keydown",
      () => {
        const started = performance.now();
        scope.requestAnimationFrame(() => {
          const channel = new scope.MessageChannel();
          channel.port1.onmessage = () => scope.__kinBenchKeys.push(performance.now() - started);
          channel.port2.postMessage(0);
        });
      },
      true,
    );
  });
  await page.keyboard.type(text, { delay: 60 });
  await sleep(300);
  return page.evaluate(
    () => (globalThis as unknown as { __kinBenchKeys: Array<number> }).__kinBenchKeys,
  );
}

/** Scrolls the page's tallest scroll area step by step; counts slow frames and long tasks. */
export async function scrollJank(page: Page, direction: "up" | "down", steps = 60) {
  return page.evaluate(
    async ({ direction, steps }) => {
      const scope = globalThis as unknown as {
        document: any;
        requestAnimationFrame: (fn: (t: number) => void) => void;
        PerformanceObserver: any;
        getComputedStyle: (el: unknown) => { overflowY: string };
      };
      const all = [...scope.document.querySelectorAll("main *, [role=main] *")] as Array<any>;
      const scroller = all
        .filter(
          (el) =>
            el.scrollHeight > el.clientHeight + 200 &&
            /auto|scroll/.test(scope.getComputedStyle(el).overflowY),
        )
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      if (scroller === undefined)
        return { frames: 0, slow: 0, longTasks: 0, longTaskMs: 0, worst: 0, found: false };
      let longTasks = 0;
      let longTaskMs = 0;
      const observer = new scope.PerformanceObserver((list: any) => {
        for (const entry of list.getEntries()) {
          longTasks++;
          longTaskMs += entry.duration;
        }
      });
      observer.observe({ type: "longtask" });
      const deltas: Array<number> = [];
      let last = await new Promise<number>((resolve) => scope.requestAnimationFrame(resolve));
      for (let step = 0; step < steps; step++) {
        scroller.scrollTop += direction === "up" ? -500 : 500;
        const now = await new Promise<number>((resolve) => scope.requestAnimationFrame(resolve));
        deltas.push(now - last);
        last = now;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      observer.disconnect();
      return {
        frames: deltas.length,
        slow: deltas.filter((delta) => delta > 34).length,
        longTasks,
        longTaskMs,
        worst: Math.max(...deltas),
        found: true,
      };
    },
    { direction, steps },
  );
}

/** Main-thread busy time and frame work over `seconds` of doing nothing. */
export async function idle(probe: Probe, seconds: number) {
  const before = await probe.metrics();
  const from = probe.mark();
  await sleep(seconds * 1000);
  const after = await probe.metrics();
  const delta = (name: string) => (after[name] ?? 0) - (before[name] ?? 0);
  return {
    cpuPercent: (delta("TaskDuration") / seconds) * 100,
    scriptMs: delta("ScriptDuration") * 1000,
    layouts: delta("LayoutCount"),
    styleRecalcs: delta("RecalcStyleCount"),
    wire: probe.wire("idle", from),
  };
}
