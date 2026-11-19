// The web app a packaged Kin server serves says Kin before any script runs: its page title, the
// names in the install manifest it links, and every icon either links, byte for byte Kin's
// (branding/assets/apps/web/public). ops/kin/host/update.sh runs it on the build's client.
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
const ORIGIN = "http://kin.invalid/";

const attribute = (tag: string, name: string) => {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : undefined;
};

/** The client file a URL names, or undefined when the server doesn't serve it from the client. */
const servedFile = (href: string) => {
  const url = new URL(href, ORIGIN);
  return url.origin === new URL(ORIGIN).origin
    ? decodeURIComponent(url.pathname).replace(/^\/+/, "")
    : undefined;
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

/** Problems with the client at `clientDir`; none means it is Kin's. */
export const checkServedBrand = Effect.fn("checkServedBrand")(function* (
  clientDir: string,
  kinIconsDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const readText = (file: string) =>
    fs.readFileString(path.join(clientDir, file)).pipe(Effect.option);
  const problems: Array<string> = [];

  const html = yield* readText("index.html");
  if (Option.isNone(html)) return [`${clientDir} has no index.html`];
  const page = html.value.replace(/<!--[\s\S]*?-->/g, "");
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(page)?.[1]?.trim();
  if (title !== NAME) problems.push(`index.html: <title> is ${quoted(title)}, not "${NAME}"`);

  const links = [...page.matchAll(/<link\b[^>]*>/gi)].map(([tag]) => ({
    rel: (attribute(tag, "rel") ?? "").toLowerCase().split(/\s+/),
    href: attribute(tag, "href") ?? "",
  }));
  const icons = new Map<string, string>();
  for (const link of links.filter((link) => link.rel.some((rel) => rel.endsWith("icon"))))
    icons.set(link.href, "index.html");

  const manifestHref = links.find((link) => link.rel.includes("manifest"))?.href;
  const manifestFile = manifestHref === undefined ? undefined : servedFile(manifestHref);
  const manifestText = manifestFile === undefined ? Option.none() : yield* readText(manifestFile);
  if (Option.isNone(manifestText)) {
    problems.push(`index.html links no manifest the client has (${manifestHref ?? "no link"})`);
  } else {
    const manifest = decodeManifest(manifestText.value);
    if (Option.isNone(manifest)) problems.push(`${manifestFile} is not a readable manifest`);
    else {
      for (const key of ["name", "short_name"] as const)
        if (manifest.value[key] !== NAME)
          problems.push(`${manifestFile}: ${key} is ${quoted(manifest.value[key])}, not "${NAME}"`);
      for (const icon of manifest.value.icons ?? [])
        icons.set(new URL(icon.src, new URL(manifestHref ?? "", ORIGIN)).href, `${manifestFile}`);
    }
  }

  const files = new Map<string, string>();
  for (const [href, from] of icons) {
    const file = servedFile(href);
    if (file === undefined)
      problems.push(`${from} links the icon ${href}, which the client doesn't serve`);
    else files.set(file, from);
  }
  // Kin's own icons too, so an icon nothing links yet still has Kin's bytes.
  for (const file of yield* fs.readDirectory(kinIconsDir))
    if (!files.has(file)) files.set(file, "branding");

  for (const [file, from] of [...files].toSorted(([a], [b]) => a.localeCompare(b))) {
    const served = yield* fs.readFile(path.join(clientDir, file)).pipe(Effect.option);
    const kin = yield* fs.readFile(path.join(kinIconsDir, file)).pipe(Effect.option);
    if (Option.isNone(served))
      problems.push(`${file} (linked from ${from}) is missing from the client`);
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
