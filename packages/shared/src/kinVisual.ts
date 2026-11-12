import { blankNonMarkup, injectHtmlRenderBootstrap } from "./htmlRender.ts";

export const KIN_VISUAL_TOOL_NAME = "kin_visual";
export const KIN_VISUAL_CARD_TYPE = "visual";
// The cap T3 already puts on an MCP app's page. A hand-written dashboard is tens of kilobytes,
// so this leaves room for thousands of data rows or a few inlined images.
export const KIN_VISUAL_MAX_BYTES = 5 * 1024 * 1024;
export const KIN_VISUAL_MAX_TITLE_LENGTH = 120;
export const KIN_VISUAL_DEFAULT_HEIGHT = 360;
export const KIN_VISUAL_MAX_HOSTS = 50;
export const KIN_VISUAL_LIBRARY_ROUTE = "/api/kin/visual-lib";
/** The outer document frames the same URL with this query; only that request gets the page. */
export const KIN_VISUAL_PAGE_QUERY = "frame";
/** `kin-file:<attachment id>` in a page becomes that chat file's URL when the page is served. */
export const KIN_VISUAL_FILE_SCHEME = "kin-file:";
const KIN_VISUAL_FILE_REFERENCE = /kin-file:([A-Za-z0-9_-]{1,200})/g;

/** Pinned in `apps/server/package.json`; a test there fails when the two drift. */
export const KIN_VISUAL_LIBRARIES = [
  {
    name: "echarts",
    version: "6.1.0",
    license: "Apache-2.0",
    file: "dist/echarts.min.js",
    draws:
      "any chart: sankey, treemap, sunburst, heatmap, funnel, gauge, radar, scatter and bubble, network graph, candlestick, boxplot, parallel, calendar, pie, bar and line",
  },
  {
    name: "mermaid",
    version: "12.2.0",
    license: "MIT",
    file: "dist/mermaid.min.js",
    draws:
      "diagrams from text: flowchart, sequence, gantt, timeline, state, class, entity-relationship, mindmap, quadrant, git graph",
  },
  {
    name: "d3",
    version: "7.9.0",
    license: "ISC",
    file: "dist/d3.min.js",
    draws: "anything custom in SVG, and map shapes from GeoJSON you put in the page",
  },
] as const;
export type KinVisualLibrary = (typeof KIN_VISUAL_LIBRARIES)[number];

/** The version is in the path so a cached file never outlives an upgrade. */
const kinVisualLibraryUrl = (library: KinVisualLibrary) =>
  `${KIN_VISUAL_LIBRARY_ROUTE}/${library.version}/${library.name}.js`;

const kinVisualLibraryTag = (library: KinVisualLibrary) =>
  `<script src="${kinVisualLibraryUrl(library)}"></script>`;

/** A bare DNS name: no scheme, port, path, wildcard, address or single-label host. */
export function kinVisualHost(input: string): string | null {
  const host = input
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, "")
    .replace(/\/.*$/, "");
  return host.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)
    ? host
    : null;
}

export function kinVisualFileReferences(html: string): ReadonlyArray<string> {
  return [...new Set(Array.from(html.matchAll(KIN_VISUAL_FILE_REFERENCE), (match) => match[1]!))];
}

/** A reference with no URL is left as written, so it fails to load and nothing else changes. */
export function resolveKinVisualFileReferences(
  html: string,
  urls: Readonly<Record<string, string>>,
): string {
  return html.replace(KIN_VISUAL_FILE_REFERENCE, (reference, id: string) =>
    Object.hasOwn(urls, id) ? urls[id]! : reference,
  );
}

// No allow-same-origin, allow-popups, allow-top-navigation or allow-forms.
const SANDBOX = "sandbox allow-scripts allow-downloads";

/**
 * Two documents share one URL. The outer one holds no agent content and frames the page, so the
 * page's own navigation is checked against the outer `frame-src`: a page cannot send itself to
 * another host. 'self' is this Kin server. `hosts` are the ones the owner allowed, over https.
 */
export function kinVisualContentSecurityPolicy(
  part: "outer" | "page",
  hosts: ReadonlyArray<string> = [],
): string {
  if (part === "outer") {
    return [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      "frame-src 'self'",
      "worker-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      SANDBOX,
    ].join("; ");
  }
  const allowed = hosts.flatMap((host) =>
    kinVisualHost(host) === host ? [`https://${host}`] : [],
  );
  const sources = (...fixed: ReadonlyArray<string>) => [...fixed, ...allowed].join(" ");
  return [
    "default-src 'none'",
    // Eval adds nothing inline script lacks, and d3's CSV parser needs it. Never an outside host.
    "script-src 'unsafe-inline' 'unsafe-eval' 'self'",
    `style-src ${sources("'unsafe-inline'")}`,
    `img-src ${sources("data:", "blob:", "'self'")}`,
    `font-src ${sources("data:", "'self'")}`,
    `media-src ${sources("data:", "blob:", "'self'")}`,
    `connect-src ${allowed.length === 0 ? "'none'" : allowed.join(" ")}`,
    // No library needs a worker, and a blob or data worker would be a second realm.
    "worker-src 'none'",
    "child-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    // Chromium ignores this; KIN_VISUAL_PRELUDE is what removes WebRTC. Kept for engines that honour it.
    "webrtc 'block'",
    SANDBOX,
  ].join("; ");
}

const SIZE_CHANGED_METHOD = "ui/notifications/size-changed";
const OPEN_LINK_METHOD = "ui/open-link";
const HOST_CONTEXT_CHANGED_METHOD = "ui/notifications/host-context-changed";
const BLOCKED_METHOD = "kin/notifications/blocked";
const SAVE_METHOD = "kin/save";
const HOST_METHOD = "kin/notifications/host";
/** A file a visual hands the app to save. Base64 grows it by a third on the way. */
const KIN_VISUAL_MAX_SAVE_BYTES = 8 * 1024 * 1024;
const MAX_SAVE_BASE64 = Math.ceil(KIN_VISUAL_MAX_SAVE_BYTES / 3) * 4;
const MESSAGE_KEY = "kinVisual";

// Relays three reports up (height, a tapped link, a blocked host) and the theme down. Nothing
// else crosses, whatever the page posts.
const OUTER_SCRIPT = `(function(){var f=document.createElement("iframe"),up=window.parent!==window?window.parent:null,rn=window.ReactNativeWebView;f.setAttribute("sandbox","allow-scripts allow-downloads");f.setAttribute("title","Visual");f.src=location.pathname+"?${KIN_VISUAL_PAGE_QUERY}=1"+location.hash;if(rn)f.addEventListener("load",function(){if(f.contentWindow)f.contentWindow.postMessage({jsonrpc:"2.0",method:${JSON.stringify(HOST_METHOD)},params:{native:true}},"*");});document.body.appendChild(f);function send(m){m.${MESSAGE_KEY}=true;if(rn)rn.postMessage(JSON.stringify(m));else if(up)up.postMessage(m,"*");}window.addEventListener("message",function(e){var d=e.data,p;if(!d||d.jsonrpc!=="2.0")return;p=d.params;if(e.source===f.contentWindow){if(!p)return;if(d.method===${JSON.stringify(SIZE_CHANGED_METHOD)}&&typeof p.height==="number")send({type:"height",height:p.height});else if(d.method===${JSON.stringify(OPEN_LINK_METHOD)}&&typeof p.url==="string")send({type:"link",url:p.url});else if(d.method===${JSON.stringify(BLOCKED_METHOD)}&&typeof p.host==="string")send({type:"blocked",host:p.host});else if(rn&&d.method===${JSON.stringify(SAVE_METHOD)}&&typeof p.name==="string"&&typeof p.mimeType==="string"&&typeof p.data==="string")send({type:"save",name:p.name,mimeType:p.mimeType,data:p.data});}else if(d.method===${JSON.stringify(HOST_CONTEXT_CHANGED_METHOD)}&&f.contentWindow){f.contentWindow.postMessage(d,"*");}});})();`;

export const KIN_VISUAL_OUTER_DOCUMENT = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><script>${OUTER_SCRIPT}</script></body></html>`;

export type KinVisualMessage =
  | { readonly type: "height"; readonly height: number }
  | { readonly type: "link"; readonly url: string }
  | { readonly type: "blocked"; readonly host: string }
  | {
      readonly type: "save";
      readonly name: string;
      readonly mimeType: string;
      readonly data: string;
    };

/** What the outer document reports. A page can forge any of these, so none of them acts alone. */
export function readKinVisualMessage(data: unknown): KinVisualMessage | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const message = data as Record<string, unknown>;
  if (message[MESSAGE_KEY] !== true) return undefined;
  if (message.type === "height") {
    const { height } = message;
    return typeof height === "number" && Number.isFinite(height) && height > 0
      ? { type: "height", height }
      : undefined;
  }
  if (message.type === "link") {
    const { url } = message;
    return typeof url === "string" && url.length <= 2048 && /^https?:\/\//i.test(url)
      ? { type: "link", url }
      : undefined;
  }
  if (message.type === "save") {
    const { name, mimeType, data } = message;
    return typeof name === "string" &&
      name.length > 0 &&
      name.length <= 200 &&
      typeof mimeType === "string" &&
      /^[\w.+-]+\/[\w.+-]+$/.test(mimeType) &&
      typeof data === "string" &&
      data.length <= MAX_SAVE_BASE64 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(data)
      ? { type: "save", name, mimeType, data }
      : undefined;
  }
  if (message.type === "blocked" && typeof message.host === "string") {
    const host = kinVisualHost(message.host);
    return host === null ? undefined : { type: "blocked", host };
  }
  return undefined;
}

const KIN_CSS =
  ":root{--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-6:24px;--text-xs:12px;--text-sm:13px;--text-base:14px;--text-lg:18px;--text-xl:24px}" +
  // The page sits on the card's own surface, inside the card's padding.
  "html{background:transparent;padding:2px}table{border-collapse:collapse}" +
  "@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation-duration:0s!important;animation-iteration-count:1!important;transition-duration:0s!important;scroll-behavior:auto!important}}";

// `kin` is a convenience for the page, never a control: the policy holds without it.
const KIN_SCRIPT = `(function(){var root=document.documentElement,subs=[],sheet=document.getElementById("t3-theme");function token(n){return getComputedStyle(root).getPropertyValue(n).trim();}function dark(){return getComputedStyle(root).colorScheme!=="light";}function still(){return window.matchMedia("(prefers-reduced-motion: reduce)").matches;}var kin=window.kin={token:token,dark:dark,reducedMotion:still,colors:function(){return [1,2,3,4,5,6].map(function(i){return token("--chart-"+i);});},onTheme:function(fn){subs.push(fn);},echartsTheme:function(){var fg=token("--foreground"),muted=token("--muted-foreground"),line=token("--border"),surface=token("--card"),font=token("--font-sans"),text={color:fg,fontFamily:font},label={color:fg,textBorderWidth:0},axis={axisLine:{lineStyle:{color:line}},axisTick:{lineStyle:{color:line}},axisLabel:{color:muted},splitLine:{lineStyle:{color:line}},nameTextStyle:{color:muted}};return {darkMode:dark(),color:kin.colors(),backgroundColor:"transparent",textStyle:text,title:{textStyle:{color:fg},subtextStyle:{color:muted}},legend:{textStyle:{color:muted},pageTextStyle:{color:muted}},tooltip:{backgroundColor:token("--popover")||surface,borderColor:line,textStyle:{color:token("--popover-foreground")||fg}},categoryAxis:axis,valueAxis:axis,logAxis:axis,timeAxis:axis,radar:{axisName:{color:muted},axisLine:{lineStyle:{color:line}},splitLine:{lineStyle:{color:line}},splitArea:{show:false}},visualMap:{textStyle:{color:muted}},dataZoom:{textStyle:{color:muted},borderColor:line},calendar:{dayLabel:{color:muted},monthLabel:{color:muted},yearLabel:{color:muted},itemStyle:{color:surface,borderColor:line}},treemap:{itemStyle:{borderColor:surface},label:label,upperLabel:{color:fg},breadcrumb:{itemStyle:{color:token("--muted"),borderColor:line,textStyle:{color:fg}},emphasis:{itemStyle:{color:token("--accent")}}}},sunburst:{label:label,itemStyle:{borderColor:surface}},sankey:{label:label,lineStyle:{color:"gradient",opacity:0.35}},graph:{label:label,lineStyle:{color:line}},tree:{label:label,lineStyle:{color:line}},funnel:{label:label,itemStyle:{borderColor:surface}},pie:{label:label,itemStyle:{borderColor:surface}},gauge:{axisLabel:{color:muted},title:{color:muted},detail:{color:fg}},heatmap:{label:label}};},echarts:function(el,option){if(typeof el==="string")el=document.querySelector(el);var chart;function draw(){if(chart)chart.dispose();window.echarts.registerTheme("kin",kin.echartsTheme());chart=window.echarts.init(el,"kin");var o=typeof option==="function"?option(kin):option,base={animation:!still()};for(var k in o)base[k]=o[k];chart.setOption(base);}draw();subs.push(draw);if(window.ResizeObserver)new ResizeObserver(function(){chart.resize();}).observe(el);return {get chart(){return chart;},redraw:draw};},mermaid:function(selector){var nodes=[].slice.call(document.querySelectorAll(selector||".mermaid")),source=nodes.map(function(n){return n.textContent;});function draw(){nodes.forEach(function(n,i){n.removeAttribute("data-processed");n.textContent=source[i];});window.mermaid.initialize({startOnLoad:false,securityLevel:"strict",theme:"base",themeVariables:{darkMode:dark(),background:token("--card"),primaryColor:token("--secondary"),primaryTextColor:token("--foreground"),primaryBorderColor:token("--border"),lineColor:token("--muted-foreground"),secondaryColor:token("--muted"),tertiaryColor:token("--card"),textColor:token("--foreground"),fontFamily:token("--font-sans"),fontSize:"14px"}});return window.mermaid.run({nodes:nodes});}subs.push(draw);return draw();}};if(sheet&&window.MutationObserver)new MutationObserver(function(){subs.slice().forEach(function(fn){try{fn();}catch(e){}});}).observe(sheet,{childList:true,characterData:true,subtree:true});document.addEventListener("securitypolicyviolation",function(e){var u;if(!/^(?:img|font|style|media|connect)-src/.test(e.effectiveDirective||""))return;try{u=new URL(e.blockedURI);}catch(x){return;}if(/^https?:$/.test(u.protocol)&&window.parent!==window)window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(BLOCKED_METHOD)},params:{host:u.hostname}},"*");});var native=false,blobs=new Map(),mk=URL.createObjectURL,ac=HTMLAnchorElement.prototype.click;URL.createObjectURL=function(o){var u=mk.call(URL,o);if(o instanceof Blob)blobs.set(u,o);return u;};window.addEventListener("message",function(e){var d=e.data;if(e.source===window.parent&&d&&d.jsonrpc==="2.0"&&d.method===${JSON.stringify(HOST_METHOD)}&&d.params&&d.params.native===true)native=true;});function blobOf(href){var m,t;if(blobs.has(href))return blobs.get(href);m=/^data:([^,]*?)(;base64)?,([\\s\\S]*)$/.exec(href);if(!m)return null;try{t=m[2]?atob(m[3]):decodeURIComponent(m[3]);}catch(x){return null;}return new Blob([Uint8Array.from(t,function(c){return c.charCodeAt(0)&255;})],{type:m[1].split(";")[0]||"application/octet-stream"});}function hand(name,blob){var r;if(blob.size>${KIN_VISUAL_MAX_SAVE_BYTES})return;r=new FileReader();r.onload=function(){var v=String(r.result);window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(SAVE_METHOD)},params:{name:String(name||"download").slice(0,200),mimeType:blob.type||"application/octet-stream",data:v.slice(v.indexOf(",")+1)}},"*");};r.readAsDataURL(blob);}function caught(a){var b;if(!native||!a.hasAttribute("download"))return false;b=blobOf(a.getAttribute("href")||"");if(!b)return false;hand(a.getAttribute("download")||"download",b);return true;}document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[download]"):null;if(a&&caught(a))e.preventDefault();},true);HTMLAnchorElement.prototype.click=function(){if(!this.isConnected&&caught(this))return;return ac.call(this);};kin.save=function(name,data,type){var b=data instanceof Blob?data:new Blob([data],{type:type||"text/plain"}),a;if(native){hand(name,b);return;}a=document.createElement("a");a.href=URL.createObjectURL(b);a.download=name;ac.call(a);};})();`;

const KIN_MARKUP = `<style id="kin-visual">${KIN_CSS}</style><script>${KIN_SCRIPT}</script>`;

// Hints that open a connection or look a name up before any policy check on a fetch.
const RESOURCE_HINT =
  /(?:^|\s)(?:preconnect|dns-prefetch|prefetch|prerender|preload|modulepreload|next)(?:\s|$)/i;
const LINK_TAG = /<link\b[^>]*>/gi;
const REL_ATTRIBUTE = /\srel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/** Hint links in the markup go before the preload scanner can read them. Offsets match `scan`. */
function withoutResourceHints(html: string): string {
  const scan = blankNonMarkup(html);
  let out = "";
  let at = 0;
  for (const tag of scan.matchAll(LINK_TAG)) {
    const rel = REL_ATTRIBUTE.exec(tag[0]);
    if (rel === null || !RESOURCE_HINT.test(rel[1] ?? rel[2] ?? rel[3] ?? "")) continue;
    out += html.slice(at, tag.index);
    at = tag.index + tag[0].length;
  }
  return out + html.slice(at);
}

const WEBRTC_GLOBALS = [
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
  "mozRTCPeerConnection",
  "RTCDataChannel",
  "RTCSessionDescription",
  "RTCIceCandidate",
  "RTCRtpSender",
  "RTCRtpReceiver",
  "RTCRtpTransceiver",
  "RTCCertificate",
  "RTCDtlsTransport",
  "RTCIceTransport",
  "RTCSctpTransport",
  "RTCPeerConnectionIceEvent",
  "RTCEncodedAudioFrame",
  "RTCEncodedVideoFrame",
];

/**
 * The page's first script. No policy closes WebRTC in Chromium, so it removes every peer-connection
 * entry point for good, and stops the page from making a second realm that still has them: a
 * srcdoc or javascript: frame is the only one CSP lets run (a sandboxed parent cannot reach a
 * blank child's globals, and data, blob, object and worker realms are refused by the policy).
 */
export const KIN_VISUAL_PRELUDE = `(function(){"use strict";var W=window,G=${JSON.stringify(WEBRTC_GLOBALS)},F=/^(?:IFRAME|FRAME|OBJECT|EMBED|FENCEDFRAME|PORTAL)$/i,U=/^\\s*(?:javascript|vbscript|data|blob):/i,H=${RESOURCE_HINT.toString()};function gone(o,n){try{Object.defineProperty(o,n,{configurable:false,enumerable:false,get:function(){return undefined;},set:function(){}});}catch(e){}}G.forEach(function(n){gone(W,n);});["mediaDevices","getUserMedia","webkitGetUserMedia","mozGetUserMedia"].forEach(function(n){gone(Navigator.prototype,n);});function fix(o,k,v){try{Object.defineProperty(o,k,{configurable:false,writable:false,value:v});}catch(e){}}function framing(el,name,value){var n;if(!F.test(el.tagName))return false;n=(""+name).toLowerCase();return n==="srcdoc"||n==="data"||(n==="src"&&U.test(""+value));}var E=Element.prototype,sa=E.setAttribute,sn=E.setAttributeNS;fix(E,"setAttribute",function(name,value){if(framing(this,name,value))return;return sa.call(this,name,value);});fix(E,"setAttributeNS",function(ns,name,value){if(framing(this,(""+name).replace(/^.*:/,""),value))return;return sn.call(this,ns,name,value);});[W.HTMLIFrameElement,W.HTMLFrameElement].forEach(function(C){var p=C&&C.prototype,s=p&&Object.getOwnPropertyDescriptor(p,"src");if(!p)return;try{Object.defineProperty(p,"srcdoc",{configurable:false,get:function(){return "";},set:function(){}});}catch(e){}if(s&&s.set)try{Object.defineProperty(p,"src",{configurable:false,get:s.get,set:function(v){if(!U.test(""+v))s.set.call(this,v);}});}catch(e){}});function bad(n){return F.test(n.tagName)||(n.tagName==="LINK"&&H.test(n.getAttribute("rel")||""));}function drop(n){var q,i;if(!n||n.nodeType!==1)return;if(bad(n)){n.remove();return;}q=n.getElementsByTagName("*");for(i=q.length-1;i>=0;i--)if(bad(q[i]))q[i].remove();}new MutationObserver(function(m){for(var i=0;i<m.length;i++){if(m[i].type==="attributes")drop(m[i].target);else for(var j=0;j<m[i].addedNodes.length;j++)drop(m[i].addedNodes[j]);}}).observe(document,{childList:true,subtree:true,attributes:true,attributeFilter:["srcdoc","src","data","rel","href"]});})();`;

const LEADING_DOCTYPE = /^\uFEFF?\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>/i;
const THEME_SHEET = '<style id="t3-theme">';

/** T3's theme bootstrap, then Kin's tokens and helper, ahead of anything the agent wrote. */
export function kinVisualPageDocument(html: string): string {
  const page = injectHtmlRenderBootstrap(withoutResourceHints(html));
  const sheet = page.indexOf(THEME_SHEET);
  const close = sheet === -1 ? -1 : page.indexOf("</script>", sheet);
  const themed =
    close === -1
      ? page
      : page.slice(0, close + "</script>".length) +
        KIN_MARKUP +
        page.slice(close + "</script>".length);
  // Ahead of every byte the agent wrote, since a script before its <head> would otherwise run first.
  const doctype = LEADING_DOCTYPE.exec(themed);
  const at = doctype === null ? 0 : doctype[0].length;
  return `${themed.slice(0, at)}<script>${KIN_VISUAL_PRELUDE}</script>${themed.slice(at)}`;
}

const example = (library: KinVisualLibrary, body: string) =>
  `${library.name} ${library.version} (${library.draws}): ${kinVisualLibraryTag(library)} then ${body}`;

/** The agent-facing account of the page: what it may hold, the libraries and the theme. */
export const KIN_VISUAL_PAGE_GUIDE = [
  "The page is yours to design: any HTML, CSS and JavaScript, any chart kind or layout.",
  "It runs sealed. It cannot reach the network, so put the data in the page itself: no fetch, no CDN script, no remote image, font or stylesheet. Those are blocked, and the owner is told which host the page wanted.",
  "Three libraries are served by Kin and are the only outside script. Use exactly these tags, and only the ones you need:",
  example(
    KIN_VISUAL_LIBRARIES[0],
    `<div id="c" style="height:320px"></div><script>kin.echarts("#c",{series:[{type:"sankey",data:[{name:"Visits"},{name:"Signups"},{name:"Paid"}],links:[{source:"Visits",target:"Signups",value:420},{source:"Signups",target:"Paid",value:96}]}]})</script>. kin.echarts(element, option) applies the app's colours, font and light or dark theme to every chart kind, and resizes; give the element a fixed pixel height and leave colours of text, axes and backgrounds unset.`,
  ),
  example(
    KIN_VISUAL_LIBRARIES[1],
    `<pre class="mermaid">flowchart LR; Visit-->Trial-->Paid</pre><script>kin.mermaid()</script>. kin.mermaid() themes and draws every .mermaid block.`,
  ),
  example(
    KIN_VISUAL_LIBRARIES[2],
    `<svg id="s" viewBox="0 0 320 120"></svg><script>d3.select("#s").selectAll("circle").data([12,30,18]).join("circle").attr("cx",(d,i)=>60+i*100).attr("cy",60).attr("r",d=>d).attr("fill",(d,i)=>kin.colors()[i])</script>.`,
  ),
  "Plain HTML and CSS need no library: a styled or sortable table, a grid of figures, a timeline.",
  'Look native with the theme variables instead of fixed colours: --background, --foreground, --muted, --muted-foreground, --card, --border, --primary, --accent, --destructive, --warning, --success, --info (most have a -foreground), --chart-1 to --chart-6, --radius, --font-sans, --font-mono, --space-1 to --space-6 and --text-xs to --text-xl. In script, kin.token("--border") reads one, kin.colors() is the six chart colours, kin.dark() says which theme is on and kin.onTheme(fn) runs fn when it changes. The base sheet already sets the text colour, font and size.',
  `An image, audio or video file already sent in this chat can be shown by its id: <img src="${KIN_VISUAL_FILE_SCHEME}ATTACHMENT_ID">. An image of your own goes in as a data: URL.`,
  "Write for a phone first: the frame is about 300px wide there and up to 680px on a desktop, inside a card that already shows the title. Leave html and body without a background, outer border, heading that repeats the title or side padding, use fluid widths, and let a wide table scroll sideways inside its own overflow-x:auto box.",
  "Let content set the height; do not use vh units or height:100% on html or body. Keep it still: no looping animation.",
  "A link opens only when the reader taps it and confirms the address. To let the reader save something the page made (a CSV, a PNG of a chart), call kin.save(fileName, data, mimeType) from their tap, with data a string or Blob; an <a download> link to a blob: or data: URL also works. On a phone it opens the share sheet.",
].join("\n");
