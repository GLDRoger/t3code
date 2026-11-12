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
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    // Browsers do not enforce this yet, so a page can still reach a STUN server: docs/kin/specs/chat.md.
    "webrtc 'block'",
    SANDBOX,
  ].join("; ");
}

const SIZE_CHANGED_METHOD = "ui/notifications/size-changed";
const OPEN_LINK_METHOD = "ui/open-link";
const HOST_CONTEXT_CHANGED_METHOD = "ui/notifications/host-context-changed";
const BLOCKED_METHOD = "kin/notifications/blocked";
const MESSAGE_KEY = "kinVisual";

// Relays three reports up (height, a tapped link, a blocked host) and the theme down. Nothing
// else crosses, whatever the page posts.
const OUTER_SCRIPT = `(function(){var f=document.createElement("iframe"),up=window.parent!==window?window.parent:null,rn=window.ReactNativeWebView;f.setAttribute("sandbox","allow-scripts allow-downloads");f.setAttribute("title","Visual");f.src=location.pathname+"?${KIN_VISUAL_PAGE_QUERY}=1"+location.hash;document.body.appendChild(f);function send(m){m.${MESSAGE_KEY}=true;if(rn)rn.postMessage(JSON.stringify(m));else if(up)up.postMessage(m,"*");}window.addEventListener("message",function(e){var d=e.data,p;if(!d||d.jsonrpc!=="2.0")return;p=d.params;if(e.source===f.contentWindow){if(!p)return;if(d.method===${JSON.stringify(SIZE_CHANGED_METHOD)}&&typeof p.height==="number")send({type:"height",height:p.height});else if(d.method===${JSON.stringify(OPEN_LINK_METHOD)}&&typeof p.url==="string")send({type:"link",url:p.url});else if(d.method===${JSON.stringify(BLOCKED_METHOD)}&&typeof p.host==="string")send({type:"blocked",host:p.host});}else if(d.method===${JSON.stringify(HOST_CONTEXT_CHANGED_METHOD)}&&f.contentWindow){f.contentWindow.postMessage(d,"*");}});})();`;

export const KIN_VISUAL_OUTER_DOCUMENT = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><script>${OUTER_SCRIPT}</script></body></html>`;

export type KinVisualMessage =
  | { readonly type: "height"; readonly height: number }
  | { readonly type: "link"; readonly url: string }
  | { readonly type: "blocked"; readonly host: string };

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
const KIN_SCRIPT = `(function(){var root=document.documentElement,subs=[],sheet=document.getElementById("t3-theme");function token(n){return getComputedStyle(root).getPropertyValue(n).trim();}function dark(){return getComputedStyle(root).colorScheme!=="light";}function still(){return window.matchMedia("(prefers-reduced-motion: reduce)").matches;}var kin=window.kin={token:token,dark:dark,reducedMotion:still,colors:function(){return [1,2,3,4,5,6].map(function(i){return token("--chart-"+i);});},onTheme:function(fn){subs.push(fn);},echarts:function(el,option){if(typeof el==="string")el=document.querySelector(el);var chart;function draw(){if(chart)chart.dispose();chart=window.echarts.init(el,dark()?"dark":null);var o=typeof option==="function"?option(kin):option,base={backgroundColor:"transparent",color:kin.colors(),textStyle:{fontFamily:token("--font-sans")},animation:!still()};for(var k in o)base[k]=o[k];chart.setOption(base);}draw();subs.push(draw);if(window.ResizeObserver)new ResizeObserver(function(){chart.resize();}).observe(el);return {get chart(){return chart;},redraw:draw};},mermaid:function(selector){var nodes=[].slice.call(document.querySelectorAll(selector||".mermaid")),source=nodes.map(function(n){return n.textContent;});function draw(){nodes.forEach(function(n,i){n.removeAttribute("data-processed");n.textContent=source[i];});window.mermaid.initialize({startOnLoad:false,securityLevel:"strict",theme:"base",themeVariables:{darkMode:dark(),background:token("--card"),primaryColor:token("--secondary"),primaryTextColor:token("--foreground"),primaryBorderColor:token("--border"),lineColor:token("--muted-foreground"),secondaryColor:token("--muted"),tertiaryColor:token("--card"),textColor:token("--foreground"),fontFamily:token("--font-sans"),fontSize:"14px"}});return window.mermaid.run({nodes:nodes});}subs.push(draw);return draw();}};if(sheet&&window.MutationObserver)new MutationObserver(function(){subs.slice().forEach(function(fn){try{fn();}catch(e){}});}).observe(sheet,{childList:true,characterData:true,subtree:true});document.addEventListener("securitypolicyviolation",function(e){var u;if(!/^(?:img|font|style|media|connect)-src/.test(e.effectiveDirective||""))return;try{u=new URL(e.blockedURI);}catch(x){return;}if(/^https?:$/.test(u.protocol)&&window.parent!==window)window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(BLOCKED_METHOD)},params:{host:u.hostname}},"*");});})();`;

const KIN_MARKUP = `<style id="kin-visual">${KIN_CSS}</style><script>${KIN_SCRIPT}</script>`;
const THEME_SHEET = '<style id="t3-theme">';

/** T3's theme bootstrap, then Kin's tokens and helper, ahead of anything the agent wrote. */
export function kinVisualPageDocument(html: string): string {
  const page = injectHtmlRenderBootstrap(html);
  const sheet = page.indexOf(THEME_SHEET);
  const close = sheet === -1 ? -1 : page.indexOf("</script>", sheet);
  if (close === -1) return page;
  const at = close + "</script>".length;
  return page.slice(0, at) + KIN_MARKUP + page.slice(at);
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
    `<div id="c" style="height:320px"></div><script>kin.echarts("#c",{series:[{type:"sankey",data:[{name:"Visits"},{name:"Signups"},{name:"Paid"}],links:[{source:"Visits",target:"Signups",value:420},{source:"Signups",target:"Paid",value:96}]}]})</script>. kin.echarts(element, option) applies the app's colours and font, follows light and dark, and resizes; give the element a fixed pixel height.`,
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
  "A link opens only when the reader taps it and confirms the address. A download the page makes from its own data (a CSV, a PNG of a chart) works.",
].join("\n");
