// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  KIN_VISUAL_OUTER_DOCUMENT,
  kinVisualContentSecurityPolicy,
  kinVisualPageDocument,
} from "@t3tools/shared/kinVisual";
import * as Effect from "effect/Effect";

const TEST_BROWSER_ENV = "T3CODE_TEST_HEADLESS_SHELL";
// What T3 sends with a coding thread's page, which leaves the network open: the control.
const OPEN_POLICY = "sandbox allow-scripts allow-forms allow-popups allow-downloads";

/** Every way out a page has, each aimed at `canary`. `/ran` on the page's own host says it ran. */
const hostilePage = (canary: string) => `<!doctype html><html><head>
<meta http-equiv="refresh" content="1;url=${canary}/meta-refresh">
<link rel="stylesheet" href="${canary}/stylesheet">
<link rel="prefetch" href="${canary}/prefetch">
<link rel="preload" as="image" href="${canary}/preload">
<link rel="modulepreload" href="${canary}/modulepreload">
<script src="${canary}/script"></script>
<style>@import url("${canary}/css-import");@font-face{font-family:x;src:url("${canary}/font")}body{font-family:x;background:url("${canary}/css-image")}</style>
</head><body>
<img src="${canary}/img"><video src="${canary}/video"></video><audio src="${canary}/audio"></audio>
<iframe src="${canary}/iframe"></iframe><object data="${canary}/object"></object><embed src="${canary}/embed">
<a id="link" href="${canary}/link-click" ping="${canary}/ping">x</a>
<form id="form" action="${canary}/form" method="post"><input name="a" value="b"></form>
<script>
var attempts = [
  function () { new Image().src = new URL("/ran", location.href).href; },
  function () { fetch("${canary}/fetch", { mode: "no-cors" }).catch(function () {}); },
  function () { var x = new XMLHttpRequest(); x.open("GET", "${canary}/xhr"); x.send(); },
  function () { new WebSocket("${canary.replace("http", "ws")}/websocket"); },
  function () { navigator.sendBeacon("${canary}/beacon", "x"); },
  function () { new EventSource("${canary}/event-source"); },
  function () { new Worker("${canary}/worker"); },
  function () { import("${canary}/dynamic-import").catch(function () {}); },
  function () { window.open("${canary}/window-open"); },
  function () { window.top.location = "${canary}/top-navigation"; },
  function () { window.parent.location = "${canary}/parent-navigation"; },
  function () { document.getElementById("form").submit(); },
  function () { document.getElementById("link").click(); },
  function () { var s = document.createElement("script"); s.src = "${canary}/script-dynamic"; document.head.appendChild(s); },
  function () { var l = document.createElement("link"); l.rel = "prefetch"; l.href = "${canary}/prefetch-dynamic"; document.head.appendChild(l); },
  function () { var b = document.createElement("base"); b.href = "${canary}/"; document.head.appendChild(b); new Image().src = "base-relative"; },
  function () { var f = document.createElement("iframe"); f.srcdoc = '<img src="${canary}/srcdoc-img"><script>fetch("${canary}/srcdoc-fetch")<\\/script>'; document.body.appendChild(f); },
  function () { setTimeout(function () { location.href = "${canary}/self-navigation"; }, 300); },
];
attempts.forEach(function (attempt) { try { attempt(); } catch (error) {} });
</script></body></html>`;

const listen = (handler: NodeHttp.RequestListener) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly server: NodeHttp.Server; readonly origin: string }>((resume) => {
      const server = NodeHttp.createServer(handler);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as NodeNet.AddressInfo;
        resume(Effect.succeed({ server, origin: `http://127.0.0.1:${port}` }));
      });
    }),
    ({ server }) =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      }),
  );

const visit = (executable: string, url: string) =>
  Effect.callback<string>((resume) => {
    NodeChildProcess.execFile(
      executable,
      ["--headless", "--disable-gpu", "--virtual-time-budget=6000", "--dump-dom", url],
      { maxBuffer: 16 * 1024 * 1024 },
      (_error, stdout) => resume(Effect.succeed(stdout)),
    );
  });

/** Loads the hostile page under `policy` and reports what reached the canary and the page's host. */
const run = Effect.fn("test.runHostilePage")(function* (executable: string, sealed: boolean) {
  const reached: Array<string> = [];
  const own: Array<string> = [];
  let connections = 0;
  const canary = yield* listen((request, response) => {
    reached.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "content-type": "text/plain" }).end("x");
  });
  canary.server.on("connection", () => {
    connections += 1;
  });
  const page = kinVisualPageDocument(hostilePage(canary.origin));
  const host = yield* listen((request, response) => {
    const url = new URL(request.url ?? "/", "http://kin.test");
    own.push(url.pathname);
    if (url.pathname !== "/visual") {
      response.writeHead(200, { "content-type": "image/gif" }).end();
      return;
    }
    // As the asset route answers: the page only for a frame's request, each with its policy.
    const inner = url.searchParams.has("frame") && request.headers["sec-fetch-dest"] === "iframe";
    response
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": sealed
          ? kinVisualContentSecurityPolicy(inner ? "page" : "outer")
          : OPEN_POLICY,
      })
      .end(inner ? page : KIN_VISUAL_OUTER_DOCUMENT);
  });
  const dom = yield* visit(executable, `${host.origin}/visual`);
  return { reached: reached.toSorted(), connections, ran: own.includes("/ran"), dom };
});

it.live("a hostile page in a Kin visual reaches nothing but its own host", (ctx) =>
  Effect.gen(function* () {
    const executable = (yield* HostProcess.Environment)[TEST_BROWSER_ENV];
    if (!executable) return ctx.skip(`Set ${TEST_BROWSER_ENV} to run this test.`);
    // The control: under T3's open policy the same page gets out, so the canary does see exits.
    const open = yield* Effect.scoped(run(executable, false));
    // Which exits land first varies, since the open page navigates itself away: many always do.
    assert.isAbove(open.reached.length, 5);
    assert.isAbove(open.connections, 0);

    const sealed = yield* Effect.scoped(run(executable, true));
    // The page ran to its last line and loaded from its own host, so silence is not a blank page.
    assert.isTrue(sealed.ran);
    assert.deepStrictEqual(sealed.reached, []);
    assert.strictEqual(sealed.connections, 0);
    // The top document is still the outer one: nothing navigated it away.
    assert.include(sealed.dom, "<iframe");
    assert.notInclude(sealed.dom, "hostile");
  }),
);
