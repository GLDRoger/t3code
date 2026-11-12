import { injectHtmlRenderBootstrap } from "./htmlRender.ts";

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

// Names that mean this machine or its local network, never a host on the internet.
const LOCAL_HOST = /(?:^|\.)(?:localhost|localdomain|local|internal|lan|home\.arpa)$/;

/**
 * A bare DNS name on the internet: no scheme, port, path, wildcard, address, single-label or
 * local-network host.
 */
export function kinVisualHost(input: string): string | null {
  const host = input
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, "")
    .replace(/\/.*$/, "");
  return host.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host) &&
    !LOCAL_HOST.test(host)
    ? host
    : null;
}

/** RFC 3492: one `xn--` label's Unicode, or null when it does not decode. */
function decodePunycodeLabel(input: string): string | null {
  const base = 36;
  const split = input.lastIndexOf("-");
  const output = Array.from(split > 0 ? input.slice(0, split) : "", (char) => char.codePointAt(0)!);
  let n = 128;
  let bias = 72;
  let i = 0;
  for (let index = split > 0 ? split + 1 : 0; index < input.length;) {
    const oldi = i;
    for (let w = 1, k = base; ; k += base) {
      if (index >= input.length) return null;
      const code = input.charCodeAt(index++);
      const digit =
        code >= 48 && code < 58
          ? code - 22
          : code >= 97 && code < 123
            ? code - 97
            : code >= 65 && code < 91
              ? code - 65
              : base;
      if (digit >= base) return null;
      i += digit * w;
      const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
      if (digit < t) break;
      w *= base - t;
      if (i > 0x10ffff * 64) return null;
    }
    const length = output.length + 1;
    let delta = oldi === 0 ? Math.floor((i - oldi) / 700) : (i - oldi) >> 1;
    delta += Math.floor(delta / length);
    let k = 0;
    for (; delta > 455; k += base) delta = Math.floor(delta / 35);
    bias = Math.floor(k + (36 * delta) / (delta + 38));
    n += Math.floor(i / length);
    i %= length;
    if (n > 0x10ffff) return null;
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}

/** How a host reads to a person, when any label is punycode; null when it is plain ASCII. */
export function kinVisualHostUnicode(host: string): string | null {
  const labels = host.split(".");
  if (!labels.some((label) => label.startsWith("xn--"))) return null;
  const decoded = labels.map((label) =>
    label.startsWith("xn--") ? decodePunycodeLabel(label.slice(4)) : label,
  );
  return decoded.every((label) => label !== null) ? decoded.join(".") : null;
}

// What a visual may hand the reader to keep. HTML is refused: opened from disk it runs as a page
// of its own, outside the seal.
const KIN_VISUAL_SAVE_TYPES: Readonly<Record<string, string>> = {
  "text/csv": "csv",
  "text/plain": "txt",
  "application/json": "json",
  "application/pdf": "pdf",
  "image/png": "png",
  "image/svg+xml": "svg",
};

/**
 * The file a visual's save becomes: the extension comes from the type, never the page's name,
 * and the name loses path, control and direction characters. Null for a type it may not save.
 */
export function kinVisualSaveFile(
  name: string,
  mimeType: string,
): { readonly name: string; readonly mimeType: string } | null {
  const type = mimeType.split(";", 1)[0]!.trim().toLowerCase();
  if (!Object.hasOwn(KIN_VISUAL_SAVE_TYPES, type)) return null;
  const extension = KIN_VISUAL_SAVE_TYPES[type]!;
  const base = name
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/^[\s.-]+|[\s.]+$/g, "")
    .slice(0, 120);
  const bare = base.toLowerCase().endsWith(`.${extension}`)
    ? base.slice(0, -extension.length - 1).replace(/[\s.]+$/, "")
    : base;
  return { name: `${bare === "" ? "visual" : bare}.${extension}`, mimeType: type };
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

// No allow-same-origin, allow-popups, allow-top-navigation, allow-forms or allow-downloads: a file
// leaves only through the app, after the reader's tap.
const SANDBOX = "sandbox allow-scripts";

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
    // Every HTML string meets the prelude's policy, and the page cannot make one of its own.
    "require-trusted-types-for 'script'",
    "trusted-types default kin",
    SANDBOX,
  ].join("; ");
}

const SIZE_CHANGED_METHOD = "ui/notifications/size-changed";
const OPEN_LINK_METHOD = "ui/open-link";
const HOST_CONTEXT_CHANGED_METHOD = "ui/notifications/host-context-changed";
const BLOCKED_METHOD = "kin/notifications/blocked";
const SAVE_METHOD = "kin/save";
/** A file a visual hands the app to save. Base64 grows it by a third on the way. */
const KIN_VISUAL_MAX_SAVE_BYTES = 8 * 1024 * 1024;
const MAX_SAVE_BASE64 = Math.ceil(KIN_VISUAL_MAX_SAVE_BYTES / 3) * 4;
const MESSAGE_KEY = "kinVisual";

// Relays four reports up (height, a tapped link, a blocked host, a file to save) and the theme
// down. Nothing else crosses, whatever the page posts.
const OUTER_SCRIPT = `(function(){var f=document.createElement("iframe"),up=window.parent!==window?window.parent:null,rn=window.ReactNativeWebView;f.setAttribute("sandbox","allow-scripts");f.setAttribute("title","Visual");f.src=location.pathname+"?${KIN_VISUAL_PAGE_QUERY}=1"+location.hash;document.body.appendChild(f);function send(m){m.${MESSAGE_KEY}=true;if(rn)rn.postMessage(JSON.stringify(m));else if(up)up.postMessage(m,"*");}window.addEventListener("message",function(e){var d=e.data,p;if(!d||d.jsonrpc!=="2.0")return;p=d.params;if(e.source===f.contentWindow){if(!p)return;if(d.method===${JSON.stringify(SIZE_CHANGED_METHOD)}&&typeof p.height==="number")send({type:"height",height:p.height});else if(d.method===${JSON.stringify(OPEN_LINK_METHOD)}&&typeof p.url==="string")send({type:"link",url:p.url});else if(d.method===${JSON.stringify(BLOCKED_METHOD)}&&typeof p.host==="string")send({type:"blocked",host:p.host});else if(d.method===${JSON.stringify(SAVE_METHOD)}&&typeof p.name==="string"&&typeof p.mimeType==="string"&&typeof p.data==="string")send({type:"save",name:p.name,mimeType:p.mimeType,data:p.data});}else if(d.method===${JSON.stringify(HOST_CONTEXT_CHANGED_METHOD)}&&f.contentWindow){f.contentWindow.postMessage(d,"*");}});})();`;

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
const KIN_SCRIPT = `(function(){var root=document.documentElement,subs=[],sheet=document.getElementById("t3-theme");function token(n){return getComputedStyle(root).getPropertyValue(n).trim();}function dark(){return getComputedStyle(root).colorScheme!=="light";}function still(){return window.matchMedia("(prefers-reduced-motion: reduce)").matches;}var kin=window.kin={token:token,dark:dark,reducedMotion:still,colors:function(){return [1,2,3,4,5,6].map(function(i){return token("--chart-"+i);});},onTheme:function(fn){subs.push(fn);},echartsTheme:function(){var fg=token("--foreground"),muted=token("--muted-foreground"),line=token("--border"),surface=token("--card"),font=token("--font-sans"),text={color:fg,fontFamily:font},label={color:fg,textBorderWidth:0},axis={axisLine:{lineStyle:{color:line}},axisTick:{lineStyle:{color:line}},axisLabel:{color:muted},splitLine:{lineStyle:{color:line}},nameTextStyle:{color:muted}};return {darkMode:dark(),color:kin.colors(),backgroundColor:"transparent",textStyle:text,title:{textStyle:{color:fg},subtextStyle:{color:muted}},legend:{textStyle:{color:muted},pageTextStyle:{color:muted}},tooltip:{backgroundColor:token("--popover")||surface,borderColor:line,textStyle:{color:token("--popover-foreground")||fg}},categoryAxis:axis,valueAxis:axis,logAxis:axis,timeAxis:axis,radar:{axisName:{color:muted},axisLine:{lineStyle:{color:line}},splitLine:{lineStyle:{color:line}},splitArea:{show:false}},visualMap:{textStyle:{color:muted}},dataZoom:{textStyle:{color:muted},borderColor:line},calendar:{dayLabel:{color:muted},monthLabel:{color:muted},yearLabel:{color:muted},itemStyle:{color:surface,borderColor:line}},treemap:{itemStyle:{borderColor:surface},label:label,upperLabel:{color:fg},breadcrumb:{itemStyle:{color:token("--muted"),borderColor:line,textStyle:{color:fg}},emphasis:{itemStyle:{color:token("--accent")}}}},sunburst:{label:label,itemStyle:{borderColor:surface}},sankey:{label:label,lineStyle:{color:"gradient",opacity:0.35}},graph:{label:label,lineStyle:{color:line}},tree:{label:label,lineStyle:{color:line}},funnel:{label:label,itemStyle:{borderColor:surface}},pie:{label:label,itemStyle:{borderColor:surface}},gauge:{axisLabel:{color:muted},title:{color:muted},detail:{color:fg}},heatmap:{label:label}};},echarts:function(el,option){if(typeof el==="string")el=document.querySelector(el);var chart;function draw(){if(chart)chart.dispose();window.echarts.registerTheme("kin",kin.echartsTheme());chart=window.echarts.init(el,"kin");var o=typeof option==="function"?option(kin):option,base={animation:!still()};for(var k in o)base[k]=o[k];chart.setOption(base);}draw();subs.push(draw);if(window.ResizeObserver)new ResizeObserver(function(){chart.resize();}).observe(el);return {get chart(){return chart;},redraw:draw};},mermaid:function(selector){var nodes=[].slice.call(document.querySelectorAll(selector||".mermaid")),source=nodes.map(function(n){return n.textContent;});function draw(){nodes.forEach(function(n,i){n.removeAttribute("data-processed");n.textContent=source[i];});window.mermaid.initialize({startOnLoad:false,securityLevel:"strict",theme:"base",themeVariables:{darkMode:dark(),background:token("--card"),primaryColor:token("--secondary"),primaryTextColor:token("--foreground"),primaryBorderColor:token("--border"),lineColor:token("--muted-foreground"),secondaryColor:token("--muted"),tertiaryColor:token("--card"),textColor:token("--foreground"),fontFamily:token("--font-sans"),fontSize:"14px"}});return window.mermaid.run({nodes:nodes});}subs.push(draw);return draw();}};if(sheet&&window.MutationObserver)new MutationObserver(function(){subs.slice().forEach(function(fn){try{fn();}catch(e){}});}).observe(sheet,{childList:true,characterData:true,subtree:true});document.addEventListener("securitypolicyviolation",function(e){var u;if(!/^(?:img|font|style|media|connect)-src/.test(e.effectiveDirective||""))return;try{u=new URL(e.blockedURI);}catch(x){return;}if(/^https?:$/.test(u.protocol)&&window.parent!==window)window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(BLOCKED_METHOD)},params:{host:u.hostname}},"*");});var blobs=new Map(),mk=URL.createObjectURL,ac=HTMLAnchorElement.prototype.click;URL.createObjectURL=function(o){var u=mk.call(URL,o);if(o instanceof Blob)blobs.set(u,o);return u;};function blobOf(href){var m,t;if(blobs.has(href))return blobs.get(href);m=/^data:([^,]*?)(;base64)?,([\\s\\S]*)$/.exec(href);if(!m)return null;try{t=m[2]?atob(m[3]):decodeURIComponent(m[3]);}catch(x){return null;}return new Blob([Uint8Array.from(t,function(c){return c.charCodeAt(0)&255;})],{type:m[1].split(";")[0]||"application/octet-stream"});}function hand(name,blob){var r;if(blob.size>${KIN_VISUAL_MAX_SAVE_BYTES})return;r=new FileReader();r.onload=function(){var v=String(r.result);window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(SAVE_METHOD)},params:{name:String(name||"download").slice(0,200),mimeType:blob.type||"application/octet-stream",data:v.slice(v.indexOf(",")+1)}},"*");};r.readAsDataURL(blob);}function caught(a){var b;if(!a.hasAttribute("download"))return false;b=blobOf(a.getAttribute("href")||"");if(!b)return false;hand(a.getAttribute("download")||"download",b);return true;}document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[download]"):null;if(a&&caught(a))e.preventDefault();},true);HTMLAnchorElement.prototype.click=function(){if(!this.isConnected&&caught(this))return;return ac.call(this);};kin.save=function(name,data,type){hand(name,data instanceof Blob?data:new Blob([data],{type:type||"text/plain"}));};})();`;

const KIN_MARKUP = `<style id="kin-visual">${KIN_CSS}</style><script>${KIN_SCRIPT}</script>`;

const SEALED_GLOBALS = [
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
  // Its output is markup no string check sees.
  "XSLTProcessor",
];

// WebKit preconnects a <link> the moment it is inserted, with no policy check, so none may exist.
// Frames would be a second realm with the globals above. A `meta` counts when it has http-equiv.
const SEALED_ELEMENTS = ["link", "iframe", "frame", "object", "embed", "fencedframe", "portal"];
const RAW_TEXT_ELEMENTS = [
  "script",
  "style",
  "xmp",
  "noembed",
  "noframes",
  "noscript",
  "textarea",
  "title",
  "plaintext",
];
/** The page loads Kin's own files from these paths and nowhere else on Kin. */
export const KIN_VISUAL_FILE_ROUTE = "/api/assets";
// Sinks and creators the prelude knows; any other method whose name says HTML is closed.
const KNOWN_HTML_METHODS = [
  "innerHTML",
  "outerHTML",
  "insertAdjacentHTML",
  "setHTMLUnsafe",
  "setHTML",
  "getHTML",
  "parseHTMLUnsafe",
  "parseHTML",
];

/**
 * The page's first script. It removes WebRTC and keeps every `<link>`, frame and http-equiv `<meta>`
 * unconnected: markup reaches a parser only scrubbed, and each insertion checks its node. Only the
 * page document's own `document.write` reaches the parser, so no tag is assembled across calls.
 * It takes its natives before any other script runs, so a page cannot blind it.
 */
export const KIN_VISUAL_PRELUDE = `(function(){"use strict";
var W=window,D=document,O=Object,A=Reflect.apply,DP=O.defineProperty,GD=O.getOwnPropertyDescriptor,S=String,TE=TypeError,WM=WeakMap,
X="http://www.w3.org/1999/xhtml",SEALED=${JSON.stringify(SEALED_ELEMENTS)},RAW=${JSON.stringify(RAW_TEXT_ELEMENTS)},KNOWN=${JSON.stringify(KNOWN_HTML_METHODS)},
SP=S.prototype,lower=SP.toLowerCase,code=SP.charCodeAt,cut=SP.slice,find=SP.indexOf,last=SP.lastIndexOf,test=RegExp.prototype.test,AP=Array.prototype,pos=AP.indexOf,join=AP.join,names=O.getOwnPropertyNames,
LOC=W.location,proto=LOC.protocol,host=LOC.host,hostname=LOC.hostname;
function call(f,t,a){return A(f,t,a||[]);}
function low(v){return call(lower,S(v));}
function one(list,v){return call(pos,list,[v])!==-1;}
function acc(p,n){return (p&&GD(p,n))||{};}
function gone(o,n){try{DP(o,n,{configurable:false,enumerable:false,get:function(){return undefined;},set:function(){}});}catch(e){}}
${JSON.stringify(SEALED_GLOBALS)}.forEach(function(n){gone(W,n);});
["mediaDevices","getUserMedia","webkitGetUserMedia","mozGetUserMedia"].forEach(function(n){gone(Navigator.prototype,n);});
var NP=Node.prototype,EP=Element.prototype,DcP=Document.prototype,FP=DocumentFragment.prototype,
gType=acc(NP,"nodeType").get,gFirst=acc(NP,"firstChild").get,gLastChild=acc(NP,"lastChild").get,gNext=acc(NP,"nextSibling").get,gParent=acc(NP,"parentNode").get,gConnected=acc(NP,"isConnected").get,rm=NP.removeChild,ins=NP.insertBefore,swap=NP.replaceChild,
gLocal=acc(EP,"localName").get,gNs=acc(EP,"namespaceURI").get,gAttrs=acc(EP,"attributes").get,gShadow=acc(EP,"shadowRoot").get,setAttr=EP.setAttribute,
gMapLen=acc(NamedNodeMap.prototype,"length").get,mapItem=NamedNodeMap.prototype.item,gAttrLocal=acc(Attr.prototype,"localName").get,gAttrValue=acc(Attr.prototype,"value").get,
gContent=acc(HTMLTemplateElement.prototype,"content").get,gRoot=acc(DcP,"documentElement").get,gBody=acc(DcP,"body").get,gHead=acc(DcP,"head").get,gCurrent=acc(DcP,"currentScript").get,
gText=acc(NP,"textContent").get,setText=acc(NP,"textContent").set,setAsync=acc(HTMLScriptElement.prototype,"async").set,
IH=GD(EP,"innerHTML")||acc(HTMLElement.prototype,"innerHTML"),OH=GD(EP,"outerHTML")||acc(HTMLElement.prototype,"outerHTML"),
mkEl=DcP.createElement,Parser=W.DOMParser,pfs=Parser.prototype.parseFromString,parser=new Parser(),queryAll=FP.querySelectorAll,listLen=acc(NodeList.prototype,"length").get,item=NodeList.prototype.item,
MO=W.MutationObserver,watch=MO.prototype.observe,gAdded=acc(MutationRecord.prototype,"addedNodes").get,
marks=new WM(),markGet=WM.prototype.get,markSet=WM.prototype.set,
TT=W.trustedTypes,kin=null,kinHTML=null;
function trusted(s){return kin?call(kinHTML,kin,[s]):s;}
function html(n){return call(gType,n)===1&&call(gNs,n)===X;}
function equiv(n){var m=call(gAttrs,n),i,l=m?call(gMapLen,m):0;for(i=0;i<l;i++)if(low(call(gAttrLocal,call(mapItem,m,[i])))==="http-equiv")return true;return false;}
function sealed(n){var name;if(!html(n))return false;name=call(gLocal,n);return one(SEALED,name)||(name==="meta"&&equiv(n));}
function after(n,root){var s;while(n&&n!==root){s=call(gNext,n);if(s)return s;n=call(gParent,n);}return null;}
function clean(root){var n=call(gFirst,root),c,r;while(n){if(sealed(n)){c=after(n,root);call(rm,call(gParent,n),[n]);n=c;}else{if(call(gType,n)===1){if(html(n)&&call(gLocal,n)==="template")clean(call(gContent,n));r=call(gShadow,n);if(r)clean(r);}c=call(gFirst,n);n=c||after(n,root);}}return root;}
function ws(c){return c===9||c===10||c===12||c===13||c===32;}
function ends(c){return c!==c||ws(c)||c===47||c===62;}
function named(s,i,name){var j,c;for(j=0;j<name.length;j++){c=call(code,s,[i+1+j]);if(c>=65&&c<=90)c+=32;if(c!==call(code,name,[j]))return false;}return ends(call(code,s,[i+1+j]));}
// The tokenizer's own reading of a start tag's attributes, from just past its name.
function equivTag(s,j){var n=s.length,c,k,from;for(;;){while(j<n&&(ws(c=call(code,s,[j]))||c===47))j++;if(j>=n||c===62)return false;from=j++;while(j<n&&!(ws(c=call(code,s,[j]))||c===47||c===62||c===61))j++;if(low(call(cut,s,[from,j]))==="http-equiv")return true;while(j<n&&ws(call(code,s,[j])))j++;if(j<n&&call(code,s,[j])===61){j++;while(j<n&&ws(call(code,s,[j])))j++;c=call(code,s,[j]);if(c===34||c===39){k=call(find,s,[c===34?'"':"'",j+1]);if(k===-1)return false;j=k+1;}else if(c===62)return false;else while(j<n&&!(ws(c=call(code,s,[j]))||c===62))j++;}}}
function opens(s,i){var k;for(k=0;k<SEALED.length;k++)if(named(s,i,SEALED[k]))return true;return named(s,i,"meta")&&equivTag(s,i+5);}
function risky(s){var i=-1;for(;;){i=call(find,s,["<",i+1]);if(i===-1)return false;if(opens(s,i))return true;}}
function neutral(s){var out="",from=0,i=-1;for(;;){i=call(find,s,["<",i+1]);if(i===-1)break;if(opens(s,i)){out+=call(cut,s,[from,i])+"&lt;";from=i+1;}}return out+call(cut,s,[from]);}
function scrub(v,whole){var s=S(v),d,t;if(!risky(s))return s;
if(whole){d=call(pfs,parser,[trusted(s),"text/html"]);clean(d);s=call(OH.get,call(gRoot,d));}
else{t=call(mkEl,D,["template"]);call(IH.set,t,[trusted(s)]);clean(call(gContent,t));s=call(IH.get,t);}
return neutral(s);}
// Checked before a node joins any tree: a sealed one is left out, anything else loses its sealed nodes.
function admit(n){var t;if(n===null||typeof n!=="object")return true;try{t=call(gType,n);}catch(e){return true;}if(sealed(n))return false;if(t===1||t===11||t===9)clean(n);return true;}
function lock(p,n,d){try{d.configurable=false;d.enumerable=true;if("value" in d)d.writable=false;DP(p,n,d);}catch(e){}}
function wrap(p,n,make){var f=p&&GD(p,n);if(f&&typeof f.value==="function")lock(p,n,{value:make(f.value)});}
function first(p,n,miss){wrap(p,n,function(f){return function(node){var a=[],i;for(i=0;i<arguments.length;i++)a[i]=arguments[i];if(!admit(node))return miss?a[1]:node;return call(f,this,a);};});}
function every(p,n){wrap(p,n,function(f){return function(){var a=[],i;for(i=0;i<arguments.length;i++)if(admit(arguments[i]))a[a.length]=arguments[i];return call(f,this,a);};});}
function sink(p,n){var d=p&&GD(p,n),set=d&&d.set;if(set)lock(p,n,{get:d.get,set:function(v){var s=S(v);call(set,this,[trusted(html(this)&&one(RAW,call(gLocal,this))?neutral(s):scrub(s,false))]);}});}
function local(q){var s=S(q);return low(call(cut,s,[call(last,s,[":"])+1]));}
if(TT&&typeof TT.createPolicy==="function"){try{kin=TT.createPolicy("kin",{createHTML:function(s){return s;}});kinHTML=kin.createHTML;}catch(e){kin=null;}
if(kin)try{TT.createPolicy("default",{createHTML:function(s,t,where){var k=low(where);return scrub(s,call(find,k,["write"])!==-1||call(find,k,["parse"])!==-1);},createScript:function(s){return s;},createScriptURL:function(s){return s;}});}catch(e){}}
sink(EP,"innerHTML");sink(HTMLElement.prototype,"innerHTML");sink(EP,"outerHTML");sink(HTMLElement.prototype,"outerHTML");sink(W.ShadowRoot&&ShadowRoot.prototype,"innerHTML");
wrap(EP,"insertAdjacentHTML",function(f){return function(where,v){return call(f,this,[where,trusted(scrub(v,false))]);};});
wrap(Range.prototype,"createContextualFragment",function(f){return function(v){return clean(call(f,this,[trusted(scrub(v,false))]));};});
[EP,W.ShadowRoot&&ShadowRoot.prototype].forEach(function(p){wrap(p,"setHTMLUnsafe",function(f){return function(v,o){return call(f,this,[trusted(scrub(v,false)),o]);};});wrap(p,"setHTML",function(f){return function(v,o){return call(f,this,[scrub(v,false),o]);};});});
["parseHTMLUnsafe","parseHTML"].forEach(function(n){wrap(Document,n,function(f){return function(v,o){return clean(call(f,this,[trusted(scrub(v,true)),o]));};});});
wrap(Parser.prototype,"parseFromString",function(f){return function(v,type){return clean(call(f,this,[trusted(S(v)),S(type)]));};});
wrap(DcP,"execCommand",function(f){return function(c,ui,v){var n=S(c);return call(f,this,low(n)==="inserthtml"?[n,ui,scrub(v,false)]:[n,ui,v]);};});
[EP,HTMLElement.prototype,W.ShadowRoot&&ShadowRoot.prototype,DcP,Document,FP,HTMLTemplateElement.prototype,Range.prototype].forEach(function(p){if(p)names(p).forEach(function(n){var d=GD(p,n);if(d&&typeof d.value==="function"&&call(test,/html/i,[n])&&!one(KNOWN,n))lock(p,n,{value:function(){throw new TE("kin: not here");}});});});
// A page's own writes: each call alone, scrubbed and placed after the script that made it.
function revive(f){var l=call(queryAll,f,["script"]),i,old,n,m,j,a;for(i=call(listLen,l)-1;i>=0;i--){old=call(item,l,[i]);if(!html(old))continue;n=call(mkEl,D,["script"]);m=call(gAttrs,old);for(j=0;j<call(gMapLen,m);j++){a=call(mapItem,m,[j]);call(setAttr,n,[call(gAttrLocal,a),call(gAttrValue,a)]);}call(setAsync,n,[false]);call(setText,n,[call(gText,old)]);call(swap,call(gParent,old),[n,old]);}return f;}
function place(doc,s){var t=call(mkEl,D,["template"]),f,cur=doc===D?call(gCurrent,D):null,at,parent,end;call(IH.set,t,[trusted(scrub(s,false))]);f=revive(clean(call(gContent,t)));end=call(gLastChild,f);
if(cur&&call(gConnected,cur)){at=call(markGet,marks,[cur]);if(!at||!call(gParent,at))at=cur;parent=call(gParent,at);if(parent){call(ins,parent,[f,call(gNext,at)]);if(end)call(markSet,marks,[cur,end]);return;}}
parent=call(gBody,doc)||call(gRoot,doc);if(parent)call(ins,parent,[f,null]);}
function policy(extra){var self=proto+"//"+host,files=self+${JSON.stringify(KIN_VISUAL_FILE_ROUTE)}+"/",more=call(test,/^(?:https:\\/\\/[a-z0-9.-]+ ?)*$/,[extra])?" "+extra:"";
return "script-src 'unsafe-inline' 'unsafe-eval' "+self+${JSON.stringify(KIN_VISUAL_LIBRARY_ROUTE)}+"/; img-src data: blob: "+files+more+"; font-src data: "+files+more+"; media-src data: blob: "+files+more;}
var own=true;
[DcP,W.HTMLDocument&&HTMLDocument.prototype].forEach(function(p){["write","writeln"].forEach(function(n){wrap(p,n,function(f){return function(){var a=[],i,m;for(i=0;i<arguments.length;i++)a[a.length]=S(arguments[i]);
if(own&&this===D&&n==="write"){own=false;
// 'self' as the paths the page needs, from the address it was loaded from; IPv6 hosts cannot be written in a policy.
if(call(test,/^https?:$/,[proto])&&!call(test,/[\\[:]/,[hostname])){call(f,D,[trusted('<meta http-equiv="Content-Security-Policy" content="'+policy(a.length>1?a[1]:"")+'">')]);m=call(gHead,D);clean(m||D);}
return call(f,D,[trusted(scrub(a[0]===undefined?"":a[0],true))]);}
place(this,call(join,a,[""])+(n==="writeln"?"\\n":""));};});});});
[DcP,W.HTMLDocument&&HTMLDocument.prototype].forEach(function(p){wrap(p,"open",function(){return function(u,name,features){return arguments.length>2?null:this;};});wrap(p,"close",function(){return function(){};});});
wrap(DcP,"createElement",function(f){return function(n,o){var s=S(n);return call(f,this,[one(SEALED,low(s))?"kin-blocked":s,o]);};});
wrap(DcP,"createElementNS",function(f){return function(ns,q,o){var u=ns==null?ns:S(ns),s=S(q);return call(f,this,[u,u===X&&one(SEALED,local(s))?"kin-blocked":s,o]);};});
wrap(DOMImplementation.prototype,"createDocument",function(f){return function(ns,q,t){var u=ns==null?ns:S(ns),s=q==null?q:S(q);return call(f,this,[u,u===X&&s&&one(SEALED,local(s))?"kin-blocked":s,t]);};});
wrap(W.CustomElementRegistry&&CustomElementRegistry.prototype,"define",function(f){return function(n,c,o){var e=o==null?undefined:o.extends;if(e!==undefined&&(one(SEALED,low(e))||low(e)==="meta"))throw new TE("kin: not here");return call(f,this,[n,c,e===undefined?o:{extends:S(e)}]);};});
first(NP,"appendChild");first(NP,"insertBefore");first(NP,"replaceChild",true);
[EP,DcP,FP].forEach(function(p){every(p,"append");every(p,"prepend");every(p,"replaceChildren");first(p,"moveBefore");});
[EP,W.CharacterData&&CharacterData.prototype,W.DocumentType&&DocumentType.prototype].forEach(function(p){every(p,"before");every(p,"after");every(p,"replaceWith");});
wrap(EP,"insertAdjacentElement",function(f){return function(where,n){return admit(n)?call(f,this,[where,n]):null;};});
first(Range.prototype,"insertNode");first(Range.prototype,"surroundContents");
(function(){var d=GD(DcP,"body");if(d&&d.set)lock(DcP,"body",{get:d.get,set:function(n){if(admit(n))call(d.set,this,[n]);}});})();
// An http-equiv attribute is never set; a meta is only ever inserted without one.
function attr(q){return low(local(q))==="http-equiv";}
wrap(EP,"setAttribute",function(f){return function(q,v){if(attr(q))return;return call(f,this,[q,v]);};});
wrap(EP,"setAttributeNS",function(f){return function(ns,q,v){if(attr(q))return;return call(f,this,[ns,q,v]);};});
wrap(EP,"toggleAttribute",function(f){return function(q,force){if(attr(q))return false;return call(f,this,arguments.length>1?[q,force]:[q]);};});
[[EP,"setAttributeNode"],[EP,"setAttributeNodeNS"],[NamedNodeMap.prototype,"setNamedItem"],[NamedNodeMap.prototype,"setNamedItemNS"]].forEach(function(e){wrap(e[0],e[1],function(f){return function(a){if(a&&attr(call(gAttrLocal,a)))return null;return call(f,this,[a]);};});});
(function(){var d=GD(HTMLMetaElement.prototype,"httpEquiv");if(d&&d.set)lock(HTMLMetaElement.prototype,"httpEquiv",{get:d.get,set:function(){}});})();
// What the reader pastes or drops arrives as text or through the scrubbed insertHTML path.
(function(){var EvP=Event.prototype,prevent=EvP.preventDefault,gPrevented=acc(EvP,"defaultPrevented").get,gClip=acc(W.ClipboardEvent&&ClipboardEvent.prototype,"clipboardData").get,gDrag=acc(W.DragEvent&&DragEvent.prototype,"dataTransfer").get,getData=W.DataTransfer&&DataTransfer.prototype.getData,exec=GD(DcP,"execCommand").value;
["paste","drop"].forEach(function(type){W.addEventListener(type,function(e){var t,h;if(!getData||call(gPrevented,e))return;try{t=type==="paste"?gClip&&call(gClip,e):gDrag&&call(gDrag,e);h=t?call(getData,t,["text/html"]):"";}catch(x){return;}if(!h)return;call(prevent,e);if(type==="paste")call(exec,D,["insertHTML",false,h]);},true);});})();
call(watch,new MO(function(m){var i,j,l,n,p;for(i=0;i<m.length;i++){l=call(gAdded,m[i]);for(j=call(listLen,l)-1;j>=0;j--){n=call(item,l,[j]);if(sealed(n)){p=call(gParent,n);if(p)call(rm,p,[n]);}else if(call(gType,n)===1)clean(n);}}}),[D,{childList:true,subtree:true}]);
})();`;

const LEADING_DOCTYPE = /^\uFEFF?\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>/i;
const THEME_SHEET = '<style id="t3-theme">';

/**
 * T3's theme bootstrap, then Kin's tokens and helper, ahead of anything the agent wrote. The
 * agent's markup reaches the parser only through the prelude's `document.write`, which takes out
 * what must not exist with the browser's own parser, so no string reading of ours can disagree.
 * `hosts` are the ones the response's policy allows; the page's own policy repeats them.
 */
export function kinVisualPageDocument(html: string, hosts: ReadonlyArray<string> = []): string {
  const page = injectHtmlRenderBootstrap(html);
  const sheet = page.indexOf(THEME_SHEET);
  const close = sheet === -1 ? -1 : page.indexOf("</script>", sheet);
  const themed =
    close === -1
      ? page
      : page.slice(0, close + "</script>".length) +
        KIN_MARKUP +
        page.slice(close + "</script>".length);
  const doctype = LEADING_DOCTYPE.exec(themed);
  const at = doctype === null ? 0 : doctype[0].length;
  const markup = JSON.stringify(themed.slice(at)).replace(/</g, "\\u003c");
  const allowed = hosts.flatMap((host) =>
    kinVisualHost(host) === host ? [`https://${host}`] : [],
  );
  return `${themed.slice(0, at)}<script>${KIN_VISUAL_PRELUDE}</script><script>document.write(${markup},${JSON.stringify(allowed.join(" "))})</script>`;
}

const example = (library: KinVisualLibrary, body: string) =>
  `${library.name} ${library.version} (${library.draws}): ${kinVisualLibraryTag(library)} then ${body}`;

/** The agent-facing account of the page: what it may hold, the libraries and the theme. */
export const KIN_VISUAL_PAGE_GUIDE = [
  "The page is yours to design: any HTML, CSS and JavaScript, any chart kind or layout.",
  "It runs sealed. It cannot reach the network, so put the data in the page itself: no fetch, no CDN script, no remote image, font or stylesheet. Those are blocked, and the owner is told which host the page wanted. Put CSS in a <style> element: <link>, <iframe>, <object> and <embed> elements are taken out of the page.",
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
  "A link opens only when the reader taps it and confirms the address. To let the reader save something the page made (a CSV, a PNG of a chart), call kin.save(fileName, data, mimeType) from their tap, with data a string or Blob; an <a download> link to a blob: or data: URL also works. It saves CSV, plain text, JSON, PDF, PNG and SVG, named by the type; on a phone it opens the share sheet.",
].join("\n");
