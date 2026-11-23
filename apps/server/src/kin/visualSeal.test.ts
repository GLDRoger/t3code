// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeDgram from "node:dgram";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  KIN_VISUAL_FILE_ROUTE,
  KIN_VISUAL_LIBRARIES,
  KIN_VISUAL_LIBRARY_ROUTE,
  KIN_VISUAL_OUTER_DOCUMENT,
  KIN_VISUAL_PRELUDE,
  kinVisualContentSecurityPolicy,
  kinVisualPageDocument,
} from "@t3tools/shared/kinVisual";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { chromium, type Browser } from "playwright-core";

import { ASSET_ROUTE_PREFIX } from "../assets/AssetAccess.ts";
import { ignoresBrowserCookie } from "../auth/EnvironmentAuth.ts";
import { DESKTOP_RENDERER_ORIGINS } from "../httpCors.ts";
import { hostilePage, OUTSIDE, REPORT } from "./visualSeal.testkit.ts";

const TEST_BROWSER_ENV = "T3CODE_TEST_HEADLESS_SHELL";
// What T3 sends with a coding thread's page, which leaves the network open: the control.
const OPEN_POLICY = "sandbox allow-scripts allow-forms allow-popups allow-downloads";
const LIBRARY = (library: (typeof KIN_VISUAL_LIBRARIES)[number]) =>
  `${KIN_VISUAL_LIBRARY_ROUTE}/${library.version}/${library.name}.js`;

interface Canaries {
  readonly stun: string;
  readonly tcpPort: number;
  /** What reached the canaries: `udp` packets and `tcp` connections. */
  readonly reached: Array<string>;
  readonly udp: Deferred.Deferred<void>;
  readonly tcp: Deferred.Deferred<void>;
}

const canaries = Effect.acquireRelease(
  Effect.callback<Canaries & { readonly close: () => void }>((resume) => {
    const reached: Array<string> = [];
    const seen = { udp: Deferred.makeUnsafe<void>(), tcp: Deferred.makeUnsafe<void>() };
    const hit = (kind: "udp" | "tcp") => {
      reached.push(kind);
      Deferred.doneUnsafe(seen[kind], Effect.void);
    };
    const udp = NodeDgram.createSocket("udp4");
    udp.on("message", () => hit("udp"));
    const tcp = NodeNet.createServer((socket) => {
      hit("tcp");
      socket.on("error", () => {});
      socket.destroy();
    });
    udp.bind(0, "127.0.0.1", () => {
      tcp.listen(0, "127.0.0.1", () => {
        resume(
          Effect.succeed({
            stun: `127.0.0.1:${udp.address().port}`,
            tcpPort: (tcp.address() as NodeNet.AddressInfo).port,
            reached,
            ...seen,
            close: () => {
              udp.close();
              tcp.close();
            },
          }),
        );
      });
    });
  }),
  ({ close }) => Effect.sync(close),
);

/** Serves the visual as the asset route does: the page only to a frame's own request. */
const visualHost = (
  page: string,
  sealed: boolean,
  reports: {
    readonly attempted: Deferred.Deferred<string>;
    readonly late: Deferred.Deferred<string>;
  },
) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly port: number; readonly server: NodeHttp.Server }>((resume) => {
      const server = NodeHttp.createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://kin.test");
        if (url.pathname === `${REPORT}/attempted`)
          Deferred.doneUnsafe(
            reports.attempted,
            Effect.succeed(url.searchParams.get("connected") ?? ""),
          );
        if (url.pathname === `${REPORT}/late`)
          Deferred.doneUnsafe(
            reports.late,
            Effect.succeed(url.searchParams.get("connected") ?? ""),
          );
        if (url.pathname !== "/visual") {
          response.writeHead(200, { "content-type": "image/gif" }).end();
          return;
        }
        const inner =
          url.searchParams.has("frame") && request.headers["sec-fetch-dest"] === "iframe";
        response
          .writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": sealed
              ? kinVisualContentSecurityPolicy(inner ? "page" : "outer")
              : OPEN_POLICY,
          })
          .end(inner ? page : KIN_VISUAL_OUTER_DOCUMENT);
      });
      server.listen(0, "127.0.0.1", () => {
        resume(Effect.succeed({ port: (server.address() as NodeNet.AddressInfo).port, server }));
      });
    }),
    ({ server }) =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      }),
  );

const launch = (executable: string, tcpPort: number, netLog?: string) =>
  Effect.acquireRelease(
    Effect.promise(() =>
      chromium.launch({
        executablePath: executable,
        headless: true,
        args: [
          `--host-resolver-rules=MAP *.canary 127.0.0.1:${tcpPort}`,
          ...(netLog === undefined
            ? []
            : [`--log-net-log=${netLog}`, "--net-log-capture-mode=Everything"]),
        ],
      }),
    ),
    (browser: Browser) => Effect.promise(() => browser.close()),
  );

const sendsFrom = (sealed: boolean, canary: Canaries, http: string) => {
  // The control is the raw page, as a coding thread serves it: no prelude, no Kin policy.
  const page = hostilePage(canary.stun, http, canary.tcpPort);
  return sealed ? kinVisualPageDocument(page) : page;
};

/** Opens the hostile visual in Chromium and resolves once its page has run every attempt. */
const openInChromium = Effect.fn("test.openInChromium")(function* (
  executable: string,
  sealed: boolean,
  directory: string,
) {
  const canary = yield* canaries;
  const reports = {
    attempted: yield* Deferred.make<string>(),
    late: yield* Deferred.make<string>(),
  };
  const host = yield* visualHost(sendsFrom(sealed, canary, `http://${OUTSIDE}`), sealed, reports);
  const netLog = NodePath.join(directory, `${sealed ? "sealed" : "open"}.json`);
  const browser = yield* launch(executable, canary.tcpPort, netLog);
  const tab = yield* Effect.promise(() => browser.newPage());
  yield* Effect.promise(() => tab.goto(`http://127.0.0.1:${host.port}/visual`));
  /** Attempts after which a `<link>`, frame or http-equiv meta was in the document, even for a moment. */
  const connected = yield* Deferred.await(reports.attempted);
  const late = yield* Deferred.await(reports.late);
  return { canary, browser, netLog, page: tab, connected, late };
});

it.live("a hostile page in a Kin visual reaches nothing off its own host", (ctx) =>
  Effect.gen(function* () {
    const executable = (yield* HostProcess.Environment)[TEST_BROWSER_ENV];
    if (!executable) return ctx.skip(`Set ${TEST_BROWSER_ENV} to run this test.`);
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-visual-seal-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    );

    // The sealed page runs first. Then the same page under T3's open policy: its exits reaching
    // the canaries mark the time by which the sealed page's would have arrived too.
    const sealed = yield* openInChromium(executable, true, directory);
    const open = yield* openInChromium(executable, false, directory);
    // STUN and a socket both reach the open canary, so silence below is not a blind canary.
    yield* Deferred.await(open.canary.udp);
    yield* Deferred.await(open.canary.tcp);

    // The sealed frame's top document is still the outer one: nothing navigated it away.
    const outer = yield* Effect.promise(() => sealed.page.content());
    assert.include(outer, "<iframe");
    assert.notInclude(outer, "hostile");
    yield* Effect.promise(() => sealed.browser.close());
    yield* Effect.promise(() => open.browser.close());

    assert.deepStrictEqual(sealed.canary.reached, []);
    assert.strictEqual(sealed.connected, "");
    assert.strictEqual(sealed.late, "");
    assert.notStrictEqual(open.connected, "");
    // The browser's own resolver log: the sealed page never even looked an outside name up.
    const sealedLog = NodeFS.readFileSync(sealed.netLog, "utf8");
    assert.notInclude(sealedLog, OUTSIDE);
    assert.notInclude(sealedLog, "kin-secret");
    assert.include(NodeFS.readFileSync(open.netLog, "utf8"), OUTSIDE);
  }).pipe(Effect.scoped),
);

/**
 * A WKWebView runner built from `visualSeal.webkit.swift`: Safari's engine, and the iPhone app's.
 * Only macOS with Xcode's `swiftc` can build it; CI cannot, so there the WebKit tests skip.
 */
const webkitRunner = (() => {
  let built: Promise<string | undefined> | undefined;
  return () =>
    Effect.flatMap(HostProcess.Platform, (platform) =>
      Effect.promise(() => {
        built ??= new Promise<string | undefined>((resolve) => {
          if (platform !== "darwin") return resolve(undefined);
          const directory = NodeFS.mkdtempSync(
            NodePath.join(NodeOS.tmpdir(), "kin-visual-webkit-"),
          );
          const binary = NodePath.join(directory, "runner");
          NodeChildProcess.execFile(
            "swiftc",
            [
              "-O",
              NodeURL.fileURLToPath(new URL("./visualSeal.webkit.swift", import.meta.url)),
              "-o",
              binary,
            ],
            (error) => resolve(error ? undefined : binary),
          );
        });
        return built;
      }),
    );
})();
const WEBKIT_SKIP = "WebKit runs only on macOS with Xcode's swiftc; CI does not run this.";

/** One WKWebView on `url` until the scope closes; `injected` runs first in every inner frame. */
const openInWebKit = (runner: string, url: string, injected?: string) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      NodeChildProcess.spawn(runner, injected === undefined ? [url] : [url, injected], {
        stdio: "ignore",
      }),
    ),
    (child) => Effect.sync(() => child.kill()),
  );

it.live("the same hostile page reaches nothing off its own host in WebKit", (ctx) =>
  Effect.gen(function* () {
    const runner = yield* webkitRunner();
    if (runner === undefined) return ctx.skip(WEBKIT_SKIP);
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-visual-webkit-page-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    );
    // As the iPhone app runs it: the prelude injected in the frame, and again in the page.
    const prelude = NodePath.join(directory, "prelude.js");
    NodeFS.writeFileSync(prelude, KIN_VISUAL_PRELUDE);
    const run = Effect.fn("test.runInWebKit")(function* (sealed: boolean, injected?: string) {
      const canary = yield* canaries;
      const reports = {
        attempted: yield* Deferred.make<string>(),
        late: yield* Deferred.make<string>(),
      };
      // Kin is `localhost`; the canary's 127.0.0.1 is another site its policy does not allow.
      const page = sendsFrom(sealed, canary, `http://127.0.0.1:${canary.tcpPort}`);
      const host = yield* visualHost(page, sealed, reports);
      yield* openInWebKit(runner, `http://localhost:${host.port}/visual`, injected);
      const connected = yield* Deferred.await(reports.attempted);
      const late = yield* Deferred.await(reports.late);
      return { canary, connected, late };
    });
    const sealed = yield* run(true);
    const injected = yield* run(true, prelude);
    const open = yield* run(false);
    yield* Deferred.await(open.canary.tcp);

    assert.deepStrictEqual(sealed.canary.reached, []);
    assert.deepStrictEqual(injected.canary.reached, []);
    for (const page of [sealed, injected]) {
      assert.strictEqual(page.connected, "");
      assert.strictEqual(page.late, "");
    }
    assert.notStrictEqual(open.connected, "");
  }).pipe(Effect.scoped),
);

const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/** A page drawing with all three libraries, served the way the asset route and library route do. */
const librariesHost = Effect.gen(function* () {
  assert.strictEqual(ASSET_ROUTE_PREFIX, KIN_VISUAL_FILE_ROUTE);
  const files = Object.fromEntries(
    KIN_VISUAL_LIBRARIES.map((library) => {
      const entry = import.meta.resolve(library.name);
      const marker = `/node_modules/${library.name}/`;
      const root = new URL(entry).pathname;
      return [
        LIBRARY(library),
        NodeFS.readFileSync(root.slice(0, root.lastIndexOf(marker) + marker.length) + library.file),
      ];
    }),
  );
  const drawn = yield* Deferred.make<string>();
  const page = `<!doctype html><html><head>${KIN_VISUAL_LIBRARIES.map((library) => `<script src="${LIBRARY(library)}"></script>`).join("")}</head><body>
<script src="/elsewhere.js"></script>
<div id="c" style="height:200px"></div><pre class="mermaid">flowchart LR; A-->B</pre><svg id="s"></svg>
<img id="away" src="/elsewhere.gif">
<script>
document.write("<p id='written'>written <b>whole</b></p>");
kin.echarts("#c", { series: [{ type: "treemap", data: [{ name: "a", value: 3 }, { name: "b", value: 5 }] }] });
d3.select("#s").selectAll("circle").data([1, 2, 3]).join("circle").attr("r", 4);
kin.mermaid().then(function () {
  var away = document.getElementById("away");
  function done() {
    // Kin paths other than the libraries and files stay closed to the page.
    var report = [!!document.querySelector("#c canvas"), document.querySelectorAll("#s circle").length, !!document.querySelector(".mermaid svg"), !!document.querySelector("#written b"), window.elsewhere === true, away.naturalWidth > 0].join(",");
    new Image().src = "${REPORT}/drawn?" + report;
  }
  if (away.complete) done(); else away.onload = away.onerror = done;
});
</script></body></html>`;
  const server = NodeHttp.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://kin.test");
    if (url.pathname === `${REPORT}/drawn`) Deferred.doneUnsafe(drawn, Effect.succeed(url.search));
    const file = files[url.pathname];
    if (file !== undefined || url.pathname === "/elsewhere.js") {
      response
        .writeHead(200, { "content-type": "text/javascript" })
        .end(file ?? "window.elsewhere = true;");
      return;
    }
    if (url.pathname === "/elsewhere.gif") {
      response.writeHead(200, { "content-type": "image/gif" }).end(PIXEL);
      return;
    }
    if (url.pathname !== "/visual") {
      response.writeHead(204).end();
      return;
    }
    const inner = url.searchParams.has("frame") && request.headers["sec-fetch-dest"] === "iframe";
    response
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": kinVisualContentSecurityPolicy(inner ? "page" : "outer"),
      })
      .end(inner ? kinVisualPageDocument(page) : KIN_VISUAL_OUTER_DOCUMENT);
  });
  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.sync(() => {
        server.close();
      }),
  );
  return { port: (server.address() as NodeNet.AddressInfo).port, drawn };
});

it.live("the three libraries still draw inside the seal", (ctx) =>
  Effect.gen(function* () {
    const executable = (yield* HostProcess.Environment)[TEST_BROWSER_ENV];
    if (!executable) return ctx.skip(`Set ${TEST_BROWSER_ENV} to run this test.`);
    const { port, drawn } = yield* librariesHost;
    const browser = yield* Effect.acquireRelease(
      Effect.promise(() => chromium.launch({ executablePath: executable, headless: true })),
      (opened) => Effect.promise(() => opened.close()),
    );
    const tab = yield* Effect.promise(() => browser.newPage());
    yield* Effect.promise(() => tab.goto(`http://127.0.0.1:${port}/visual`));
    assert.strictEqual(yield* Deferred.await(drawn), "?true,3,true,true,false,false");
  }).pipe(Effect.scoped),
);

it.live("the three libraries still draw inside the seal in WebKit", (ctx) =>
  Effect.gen(function* () {
    const runner = yield* webkitRunner();
    if (runner === undefined) return ctx.skip(WEBKIT_SKIP);
    const { port, drawn } = yield* librariesHost;
    yield* openInWebKit(runner, `http://localhost:${port}/visual`);
    assert.strictEqual(yield* Deferred.await(drawn), "?true,3,true,true,false,false");
  }).pipe(Effect.scoped),
);

/**
 * The app's session cookie and a visual that loads from Kin all it can: a script, a picture, a
 * font, a video with a track, and its own frame. Each request that still carries the cookie is
 * one the auth layer reads as carrying none.
 */
const cookieHost = Effect.gen(function* () {
  const requests: Array<{ readonly path: string; readonly headers: NodeHttp.IncomingHttpHeaders }> =
    [];
  const loaded = { app: yield* Deferred.make<void>(), page: yield* Deferred.make<void>() };
  const file = (name: string) => `${KIN_VISUAL_FILE_ROUTE}/token/${name}`;
  const page = `<!doctype html><html><head><script src="${LIBRARY(KIN_VISUAL_LIBRARIES[0])}"></script>
<style>@font-face{font-family:k;src:url("${file("font")}")}body{font-family:k}</style></head><body>
<img src="${file("image")}"><video src="${file("video")}" preload="auto"><track default kind="captions" src="${file("track")}"></video>
<p>text in the font</p>
<script>setTimeout(function () { new Image().src = "${file("last")}"; }, 300);</script></body></html>`;
  const server = NodeHttp.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://kin.test");
    requests.push({ path: url.pathname + url.search, headers: request.headers });
    if (url.pathname === "/app") {
      // The session cookie T3 sets, and the frame the web client puts a visual in.
      response
        .writeHead(200, {
          "content-type": "text/html",
          "set-cookie": "t3_session=secret; Path=/; HttpOnly; SameSite=Lax",
        })
        .end(
          `<!doctype html><script>new Image().src = "/app-image";</script><iframe sandbox="allow-scripts" src="/visual"></iframe>`,
        );
      return;
    }
    if (url.pathname === "/app-image") Deferred.doneUnsafe(loaded.app, Effect.void);
    if (url.pathname === file("last")) Deferred.doneUnsafe(loaded.page, Effect.void);
    if (url.pathname !== "/visual") {
      response.writeHead(200, { "content-type": "text/javascript" }).end("");
      return;
    }
    const inner = url.searchParams.has("frame") && request.headers["sec-fetch-dest"] === "iframe";
    response
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": kinVisualContentSecurityPolicy(inner ? "page" : "outer"),
      })
      .end(inner ? kinVisualPageDocument(page) : KIN_VISUAL_OUTER_DOCUMENT);
  });
  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      }),
  );
  return { port: (server.address() as NodeNet.AddressInfo).port, requests, loaded };
});

const assertNoSessionReaches = (
  requests: ReadonlyArray<{
    readonly path: string;
    readonly headers: NodeHttp.IncomingHttpHeaders;
  }>,
) => {
  const trusted = new Set<string>(DESKTOP_RENDERER_ORIGINS);
  const headers = (path: string) => {
    const found = requests.find((request) => request.path === path)?.headers ?? {};
    return Object.fromEntries(
      Object.entries(found).map(([name, value]) => [name, Array.isArray(value) ? value[0] : value]),
    );
  };
  // The control: the app's own request carries the session and the server reads it.
  assert.strictEqual(headers("/app-image").cookie, "t3_session=secret");
  assert.isFalse(ignoresBrowserCookie(headers("/app-image"), trusted));
  // The outer document is the app's own frame request; the visual's start with its frame.
  const visual = requests.filter(
    (request) => !["/app", "/app-image", "/visual"].includes(request.path),
  );
  assert.isAbove(visual.length, 3);
  for (const request of visual) {
    const sent = headers(request.path);
    if (sent.cookie !== undefined)
      assert.isTrue(ignoresBrowserCookie(sent, trusted), `${request.path} carried the session`);
  }
};

it.live("no cookie of the app's rides along on what the page loads from Kin", (ctx) =>
  Effect.gen(function* () {
    const executable = (yield* HostProcess.Environment)[TEST_BROWSER_ENV];
    if (!executable) return ctx.skip(`Set ${TEST_BROWSER_ENV} to run this test.`);
    const { port, requests, loaded } = yield* cookieHost;
    const browser = yield* Effect.acquireRelease(
      Effect.promise(() => chromium.launch({ executablePath: executable, headless: true })),
      (opened) => Effect.promise(() => opened.close()),
    );
    const tab = yield* Effect.promise(() => browser.newPage());
    yield* Effect.promise(() => tab.goto(`http://127.0.0.1:${port}/app`));
    yield* Deferred.await(loaded.app);
    yield* Deferred.await(loaded.page);
    assertNoSessionReaches(requests);
  }).pipe(Effect.scoped),
);

it.live("no session rides along on what the page loads from Kin in WebKit", (ctx) =>
  Effect.gen(function* () {
    const runner = yield* webkitRunner();
    if (runner === undefined) return ctx.skip(WEBKIT_SKIP);
    const { port, requests, loaded } = yield* cookieHost;
    yield* openInWebKit(runner, `http://localhost:${port}/app`);
    yield* Deferred.await(loaded.app);
    yield* Deferred.await(loaded.page);
    assertNoSessionReaches(requests);
  }).pipe(Effect.scoped),
);
