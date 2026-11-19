// The web app a packaged Kin server serves says Kin before any script runs: the <title> of its
// <head>, the names in the install manifest it links, and every icon either links, byte for byte
// Kin's (branding/assets/apps/web/public). ops/kin/host/update.sh runs it on the build's client.
//   node scripts/kin-served-brand.ts <client dir>
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command } from "effect/cli";

const NAME = "Kin";

interface Head {
  readonly titles: ReadonlyArray<string>;
  readonly links: ReadonlyArray<ReadonlyMap<string, string>>;
  readonly bases: number;
}

const TAG_NAME = /<([a-zA-Z][a-zA-Z0-9-]*)/y;
const ATTRIBUTE = /[\s/]*(?:(>)|([^\s/>="'<]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?)/y;

/** The start tag at `at`: its name, attributes (first wins, as in HTML) and where it ends. */
const readStartTag = (html: string, at: number) => {
  TAG_NAME.lastIndex = at;
  const name = TAG_NAME.exec(html)?.[1]?.toLowerCase();
  if (name === undefined) return undefined;
  const attributes = new Map<string, string>();
  let index = TAG_NAME.lastIndex;
  for (;;) {
    ATTRIBUTE.lastIndex = index;
    const match = ATTRIBUTE.exec(html);
    if (!match) return undefined;
    index = ATTRIBUTE.lastIndex;
    if (match[1]) return { name, attributes, end: index };
    const key = match[2]!.toLowerCase();
    if (!attributes.has(key)) attributes.set(key, match[3] ?? match[4] ?? match[5] ?? "");
  }
};

/** Where the raw text of `<name>` ends and its end tag closes, or -1 when it never does. */
const endOfRawText = (html: string, from: number, name: string) => {
  const close = new RegExp(`</${name}[\\s/>]`, "gi");
  close.lastIndex = from;
  const match = close.exec(html);
  const end = match ? html.indexOf(">", match.index) : -1;
  return match && end !== -1 ? { text: html.slice(from, match.index), end: end + 1 } : undefined;
};

/**
 * The <head> of a Vite-built index.html as a browser with scripts on reads it: the titles and
 * links that count, not text inside noscript, script, template, style or comments. Anything it
 * can't read for certain is a problem, never a guess.
 */
export const readHead = (html: string): Head | string => {
  const titles: Array<string> = [];
  const links: Array<ReadonlyMap<string, string>> = [];
  let bases = 0;
  let inHead = false;
  let index = 0;
  const unreadable = () =>
    `index.html: the check can't read ${JSON.stringify(html.slice(index, index + 40))} ${inHead ? "in <head>" : "before <head>"}`;
  for (;;) {
    while (/\s/.test(html[index] ?? "")) index++;
    if (index >= html.length) return "index.html has no </head>";
    if (html.startsWith("<!--", index)) {
      const end = html.indexOf("-->", index + 4);
      if (end === -1) return unreadable();
      index = end + 3;
      continue;
    }
    if (!inHead && /^<!doctype\s/i.test(html.slice(index, index + 10))) {
      const end = html.indexOf(">", index);
      if (end === -1) return unreadable();
      index = end + 1;
      continue;
    }
    if (inHead && /^<\/head[\s>]/i.test(html.slice(index, index + 7))) {
      return { titles, links, bases };
    }
    const tag = readStartTag(html, index);
    if (tag === undefined) return unreadable();
    if (!inHead) {
      if (tag.name === "head") inHead = true;
      else if (tag.name !== "html") return "index.html has no <head> before its content";
      index = tag.end;
      continue;
    }
    if (tag.name === "meta" || tag.name === "link" || tag.name === "base") {
      if (tag.name === "link") links.push(tag.attributes);
      if (tag.name === "base") bases++;
      index = tag.end;
      continue;
    }
    if (!["title", "script", "style", "noscript", "template"].includes(tag.name)) {
      return unreadable();
    }
    const raw = endOfRawText(html, tag.end, tag.name);
    // A comment opener in a script and a nested template change where the element ends.
    if (
      raw === undefined ||
      (tag.name === "script" && raw.text.includes("<!--")) ||
      (tag.name === "template" && /<template[\s>/]/i.test(raw.text))
    ) {
      return unreadable();
    }
    if (tag.name === "title") titles.push(raw.text);
    index = raw.end;
  }
};

const ROOT_RELATIVE = /^\/(?![/\\])([A-Za-z0-9._~!$'()*+,;=:@%/-]+)(\?[A-Za-z0-9._~=%-]*)?$/;

/** The client file a server answers `href` with, as its static handler looks it up (no decoding). */
const servedPath = (href: string): { readonly file: string } | { readonly problem: string } => {
  const path = ROOT_RELATIVE.exec(href)?.[1];
  if (path === undefined)
    return {
      problem: `names ${JSON.stringify(href)}; only a root-relative path such as "/favicon.ico" (a ?query allowed) reaches the same file from every page`,
    };
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || /^(?:\.|%2e){1,2}$/i.test(segment)))
    return { problem: `names ${JSON.stringify(href)}, which has an empty or dot segment` };
  if (!segments.at(-1)!.includes("."))
    return { problem: `names ${JSON.stringify(href)}, which the server answers with index.html` };
  return { file: path };
};

const decodeManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.optional(Schema.Unknown),
      short_name: Schema.optional(Schema.Unknown),
      icons: Schema.optional(Schema.Array(Schema.Struct({ src: Schema.String }))),
    }),
  ),
);

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

const quoted = (value: unknown) => (typeof value === "string" ? `"${value}"` : "missing");

const relTokens = (link: ReadonlyMap<string, string>) =>
  (link.get("rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean);

/** Problems with the client at `clientDir`; none means it is Kin's. */
export const checkServedBrand = Effect.fn("checkServedBrand")(function* (
  clientDir: string,
  kinIconsDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Exactly the name asked for, even on a case-insensitive disk, and a file, as the server opens.
  const servedBytes = Effect.fn("checkServedBrand.servedBytes")(function* (file: string) {
    const names = yield* fs
      .readDirectory(path.join(clientDir, path.dirname(file)))
      .pipe(Effect.orElseSucceed(() => []));
    if (!names.includes(path.basename(file))) return Option.none<Uint8Array>();
    return yield* fs.readFile(path.join(clientDir, file)).pipe(Effect.option);
  });
  const problems: Array<string> = [];

  const html = yield* fs.readFileString(path.join(clientDir, "index.html")).pipe(Effect.option);
  if (Option.isNone(html)) return [`${clientDir} has no index.html`];
  const head = readHead(html.value);
  if (typeof head === "string") return [head];

  if (head.titles.length !== 1)
    problems.push(`index.html: <head> has ${head.titles.length} <title> elements, not one`);
  const title = head.titles[0]?.replace(/\s+/g, " ").trim();
  if (title !== undefined && title !== NAME)
    problems.push(`index.html: <title> is ${quoted(title)}, not "${NAME}"`);
  if (head.bases > 0)
    problems.push("index.html has a <base> element, which moves where a browser fetches icons");

  const required = [
    ["icon", 'favicon (<link rel="icon">)'],
    ["apple-touch-icon", 'apple-touch icon (<link rel="apple-touch-icon">)'],
    ["manifest", 'install manifest (<link rel="manifest">)'],
  ] as const;
  for (const [rel, what] of required)
    if (!head.links.some((link) => relTokens(link).includes(rel)))
      problems.push(`index.html links no ${what}`);

  // Every file the page links as an icon or manifest, from where it is named.
  const icons = new Map<string, string>();
  const reach = (href: string | undefined, from: string) => {
    const served = servedPath(href ?? "");
    if ("problem" in served) {
      problems.push(`${from} ${served.problem}`);
      return undefined;
    }
    return served.file;
  };
  for (const link of head.links.filter((link) =>
    relTokens(link).some((rel) => rel.endsWith("icon")),
  )) {
    const file = reach(link.get("href"), "index.html: an icon link");
    if (file !== undefined) icons.set(file, "index.html");
  }

  const manifests = head.links.filter((link) => relTokens(link).includes("manifest"));
  if (manifests.length > 1)
    problems.push(`index.html links ${manifests.length} manifests, not one`);
  const manifestFile =
    manifests.length === 1
      ? reach(manifests[0]!.get("href"), "index.html: the manifest link")
      : undefined;
  if (manifestFile !== undefined) {
    const bytes = yield* servedBytes(manifestFile);
    const manifest = Option.isNone(bytes)
      ? undefined
      : decodeManifest(new TextDecoder().decode(bytes.value));
    if (manifest === undefined)
      problems.push(
        `index.html links the manifest /${manifestFile}, which the client doesn't have`,
      );
    else if (Option.isNone(manifest)) problems.push(`${manifestFile} is not a readable manifest`);
    else {
      for (const key of ["name", "short_name"] as const)
        if (manifest.value[key] !== NAME)
          problems.push(`${manifestFile}: ${key} is ${quoted(manifest.value[key])}, not "${NAME}"`);
      if ((manifest.value.icons ?? []).length === 0)
        problems.push(`${manifestFile} lists no install icons`);
      for (const icon of manifest.value.icons ?? []) {
        const file = reach(icon.src, `${manifestFile}: an icon`);
        if (file !== undefined) icons.set(file, manifestFile);
      }
    }
  }

  // Kin's own icons too, so an icon nothing links yet still has Kin's bytes.
  for (const file of yield* fs.readDirectory(kinIconsDir))
    if (!icons.has(file)) icons.set(file, "branding");

  for (const [file, from] of [...icons].toSorted(([a], [b]) => a.localeCompare(b))) {
    const served = yield* servedBytes(file);
    const kin = yield* fs.readFile(path.join(kinIconsDir, file)).pipe(Effect.option);
    if (Option.isNone(served))
      problems.push(
        `${file} (linked from ${from}) is missing from the client, so the server answers it with index.html`,
      );
    else if (Option.isNone(kin))
      problems.push(`${file} (linked from ${from}) has no Kin icon in ${kinIconsDir}`);
    else if (!sameBytes(served.value, kin.value))
      problems.push(`${file} is not Kin's icon (${kinIconsDir}/${file})`);
  }
  return problems;
});

export const kinServedBrandCommand = Command.make(
  "kin-served-brand",
  {
    client: Argument.String("client").pipe(
      Argument.withDescription("The client directory the server serves."),
    ),
  },
  (input) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL("..", import.meta.url));
      const client = path.resolve(input.client);
      const problems = yield* checkServedBrand(
        client,
        path.join(root, "branding/assets/apps/web/public"),
      );
      if (problems.length === 0)
        return yield* Console.log(
          `kin-served-brand: ${client} is named ${NAME} and has Kin's icons`,
        );
      for (const problem of problems) yield* Console.error(`kin-served-brand: ${problem}`);
      yield* Effect.sync(() => {
        process.exitCode = 1;
      });
    }),
).pipe(Command.withDescription("Fail unless a packaged web client is named Kin with Kin's icons."));

if (import.meta.main) {
  Command.run(kinServedBrandCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
