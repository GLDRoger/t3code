import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import { AgentScope, agentScopeLauncherScript } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  KIN_VISUAL_FILE_ROUTE,
  KIN_VISUAL_LIBRARIES,
  KIN_VISUAL_LIBRARY_ROUTE,
  kinVisualContentSecurityPolicy,
  kinVisualPageDocument,
  resolveKinVisualFileReferences,
} from "@t3tools/shared/kinVisual";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { BrowserContext, Route } from "playwright-core";

import { ServerConfig } from "../../config.ts";
import { PreviewBrowser } from "../../preview/PreviewBrowser.ts";
import { loadPlaywright } from "../../preview/ServerBrowserContexts.ts";
import { kinVisualLibraryPath } from "../visualLibraries.ts";
import {
  type Confinement,
  confinedArgs,
  killGroup,
  networkFilter,
  probeConfinement,
  confinedArch,
} from "./confine.ts";
import { KIN_PICTURE_SCALE, KIN_PICTURE_SIZES, type KinPictureSize } from "./sizes.ts";

export const PICTURE_LIMITS = {
  /** From the page's first byte to its picture. */
  pageMs: 15_000,
  launchMs: 15_000,
  /** How long the page must stay unchanged before it is shot. */
  stillMs: 500,
  /** Pictures that may wait behind the one being drawn. */
  waiting: 4,
  memory: "1G",
  pngBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
};
export type PictureLimits = typeof PICTURE_LIMITS;

/** The only origin a picture's page has; nothing under it exists outside this renderer. */
const ORIGIN = "https://kin.picture";
/** Under the files route, the one place the seal lets a page load images and fonts from. */
const FILE_PATH = `${KIN_VISUAL_FILE_ROUTE}/kin-file/`;

export type PictureFile = {
  readonly id: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
};
export type PictureRequest = {
  readonly html: string;
  readonly size: KinPictureSize;
  /** Chat files the page names as `kin-file:<id>`, already checked to be the turn's to show. */
  readonly files: ReadonlyArray<PictureFile>;
};

export type PictureDrawn =
  | {
      readonly _tag: "drawn";
      readonly png: Uint8Array;
      readonly width: number;
      readonly height: number;
    }
  /** The page's own doing: the reason says what to change, and the agent can call again. */
  | { readonly _tag: "refused"; readonly reason: string }
  /** The server's: nothing the agent changes makes this work now. */
  | { readonly _tag: "cannotDraw"; readonly reason: string };

type Shot =
  | { readonly _tag: "shot"; readonly png: Uint8Array }
  | { readonly _tag: "slow" }
  | { readonly _tag: "crashed" };

const MB = 1024 * 1024;
export const PICTURE_SENTENCES = {
  busy: "Kin is drawing other pictures, so nothing was made. Try again in a minute.",
  slow: (seconds: number) =>
    `The picture took more than ${seconds} seconds to draw, so Kin stopped it and nothing was made. Draw everything as the page loads, with no loop or timer that keeps going.`,
  large: (bytes: number) =>
    `This picture would be over ${Math.round(bytes / MB)} MB, so nothing was made. Use fewer or smaller photos.`,
  outside: (host: string) =>
    `The page tried to load ${host}, and a picture can't load anything from outside Kin, so nothing was made. Put images in as data: URLs or kin-file ids, and use Kin's fonts or the system's.`,
  crashed:
    "The page stopped while Kin drew it, most likely out of memory, so nothing was made. Draw it with less: fewer or smaller photos and shapes.",
  fetching:
    "Kin is still fetching the browser it draws pictures with, so nothing was made. Try again in a minute.",
  cannotDraw: "Kin can't draw pictures on this server right now, so nothing was made.",
} as const;

/** Playwright's own failure: a launch that didn't start, or a page that stopped under it. */
class PictureBrowserError extends Schema.TaggedError<PictureBrowserError>()(
  "KinPictureBrowserError",
  { stage: Schema.Literals(["launch", "page"]), crashed: Schema.Boolean, cause: Schema.Defect() },
) {}
const browserError = (stage: "launch" | "page") => (cause: unknown) =>
  new PictureBrowserError({ stage, crashed: /crash/i.test(String(cause)), cause });

export class KinPictureRenderer extends Context.Service<
  KinPictureRenderer,
  {
    /** One page drawn to a PNG at its size, once it has loaded, its fonts are in and it is still. */
    readonly render: (request: PictureRequest) => Effect.Effect<PictureDrawn>;
  }
>()("t3/kin/pictures/renderer/KinPictureRenderer") {}

/** One at a time; past `waiting` in line, `busy` at once instead of a longer wait. */
export const pictureQueue = Effect.fn("KinPictureRenderer.queue")(function* (waiting: number) {
  const permit = yield* Semaphore.make(1);
  let inLine = 0;
  return <A, E, R>(work: Effect.Effect<A, E, R>, busy: A): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      if (inLine > waiting) return Effect.succeed(busy);
      inLine++;
      return permit
        .withPermits(1)(work)
        .pipe(Effect.ensuring(Effect.sync(() => inLine--)));
    });
});

/** Resolves once the document has gone `stillMs` with no change; run inside the page. */
const settleScript = (stillMs: number) =>
  `new Promise(function(done){document.fonts.ready.then(function(){var t=setTimeout(done,${stillMs});new MutationObserver(function(){clearTimeout(t);t=setTimeout(done,${stillMs});}).observe(document,{subtree:true,childList:true,attributes:true,characterData:true});});})`;

const pngSize = (png: Uint8Array) => {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return png.length >= 24 ? { width: view.getUint32(16), height: view.getUint32(20) } : undefined;
};

/** The page's own requests that aren't Kin's, from the browser's log or its network. */
const outsideHost = (url: string) => {
  try {
    const parsed = new URL(url);
    return parsed.origin === ORIGIN || parsed.protocol === "data:" || parsed.protocol === "blob:"
      ? undefined
      : parsed.protocol === "file:"
        ? "a file on the server"
        : parsed.host || parsed.protocol.replace(/:$/, "");
  } catch {
    return undefined;
  }
};
// Chrome's words for a load its policy stopped: "Loading the image '…' violates …", once "Refused to …".
const REFUSED_LOG = /(?:Loading the [a-z -]+|Refused to [a-z ]+?) '([^']+)'/i;

export const makeLayer = (limits: PictureLimits = PICTURE_LIMITS) =>
  Layer.effect(
    KinPictureRenderer,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const browser = yield* PreviewBrowser;
      const scopes = yield* AgentScope;
      const platform = yield* HostProcess.Platform;
      const arch = yield* HostProcess.Architecture;
      const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
      const picturesDir = path.join(config.stateDir, "kin", "pictures");
      const queue = yield* pictureQueue(limits.waiting);
      const confinement = yield* Ref.make<Option.Option<Confinement>>(Option.none());
      const libraries = new Map<string, string>();
      for (const library of KIN_VISUAL_LIBRARIES) {
        const file = yield* kinVisualLibraryPath(library);
        if (file !== null)
          libraries.set(`${KIN_VISUAL_LIBRARY_ROUTE}/${library.version}/${library.name}.js`, file);
      }

      /** Probed once: whether this host can hold the browser has no reason to change while it runs. */
      const confined = Effect.gen(function* () {
        const known = yield* Ref.get(confinement);
        if (Option.isSome(known)) return known.value;
        yield* fs.makeDirectory(picturesDir, { recursive: true, mode: 0o700 });
        const probed = yield* Effect.acquireUseRelease(
          fs.makeTempDirectory({ directory: picturesDir, prefix: "probe-" }),
          (scratch) =>
            probeConfinement({ platform, arch, scratch }).pipe(Effect.provideContext(services)),
          (scratch) => fs.remove(scratch, { recursive: true, force: true }).pipe(Effect.ignore),
        );
        if (probed._tag === "missing")
          yield* Effect.logWarning("Kin can't draw pictures: this host can't confine its browser", {
            reason: probed.reason,
          });
        yield* Ref.set(confinement, Option.some(probed));
        return probed;
      });

      /** A launcher that records its pid (the group's number) and execs into the held browser. */
      const launcherFor = Effect.fn("KinPictureRenderer.launcher")(function* (
        executable: string,
        scratch: string,
        held: Confinement,
      ) {
        const filter = path.join(scratch, "filter.bpf");
        const confinedArchitecture = confinedArch(arch);
        if (held._tag === "confined" && confinedArchitecture !== undefined)
          yield* fs.writeFile(filter, networkFilter(confinedArchitecture));
        const launch = yield* scopes.wrap({
          ...(held._tag === "confined"
            ? {
                command: held.setpriv,
                args: [
                  ...confinedArgs({
                    system: held.system,
                    browserDir: path.dirname(executable),
                    scratch,
                    filter,
                  }),
                  executable,
                ],
              }
            : { command: executable, args: [] }),
          name: "kin-picture",
          properties: [`MemoryMax=${limits.memory}`, "MemorySwapMax=0", "TasksMax=256"],
        });
        const launcher = path.join(scratch, "launch");
        const leader = path.join(scratch, "leader");
        yield* fs.writeFileString(
          launcher,
          agentScopeLauncherScript(launch).replace(
            "#!/bin/sh\n",
            `#!/bin/sh\necho $$ > '${leader.replaceAll("'", `'\\''`)}'\n`,
          ),
          { mode: 0o700 },
        );
        return { launcher, leader, unit: launch.unit };
      });

      const serve =
        (request: PictureRequest, page: string, blocked: Array<string>) => async (route: Route) => {
          const url = route.request().url();
          const outside = outsideHost(url);
          if (outside !== undefined) {
            blocked.push(outside);
            return route.abort("blockedbyclient");
          }
          const { pathname } = new URL(url);
          if (pathname === "/")
            return route.fulfill({
              status: 200,
              headers: {
                "content-type": "text/html; charset=utf-8",
                "content-security-policy": kinVisualContentSecurityPolicy("page"),
              },
              body: page,
            });
          const library = libraries.get(pathname);
          if (library !== undefined)
            return route.fulfill({
              status: 200,
              contentType: "text/javascript; charset=utf-8",
              body: Buffer.from(await Effect.runPromiseWith(services)(fs.readFile(library))),
            });
          const file = pathname.startsWith(FILE_PATH)
            ? request.files.find((one) => one.id === pathname.slice(FILE_PATH.length))
            : undefined;
          if (file !== undefined)
            return route.fulfill({
              status: 200,
              contentType: file.mimeType,
              body: Buffer.from(file.bytes),
            });
          return route.fulfill({ status: 404, body: "" });
        };

      const shoot = (context: BrowserContext, request: PictureRequest, blocked: Array<string>) =>
        Effect.tryPromise({
          catch: browserError("page"),
          try: async () => {
            const size = KIN_PICTURE_SIZES[request.size];
            const tab = context.pages()[0] ?? (await context.newPage());
            // The policy stops most outside loads before the network; the browser's own log names them.
            const log = await context.newCDPSession(tab);
            log.on("Log.entryAdded", ({ entry }) => {
              const refused = REFUSED_LOG.exec(entry.text)?.[1];
              const host = refused === undefined ? undefined : outsideHost(refused);
              if (host !== undefined) blocked.push(host);
            });
            await log.send("Log.enable");
            const page = kinVisualPageDocument(
              resolveKinVisualFileReferences(
                request.html,
                Object.fromEntries(
                  request.files.map((file) => [file.id, `${FILE_PATH}${file.id}`]),
                ),
              ),
            );
            await tab.route("**/*", serve(request, page, blocked));
            // The page's own limit is the caller's; these only stop Playwright waiting forever.
            await tab.goto(`${ORIGIN}/`, { waitUntil: "load", timeout: limits.pageMs * 2 });
            await tab.evaluate(settleScript(limits.stillMs));
            return new Uint8Array(
              await tab.screenshot({
                type: "png",
                clip: { x: 0, y: 0, width: size.width, height: size.height },
                animations: "disabled",
                timeout: limits.pageMs * 2,
              }),
            );
          },
        });

      const draw = Effect.fn("KinPictureRenderer.draw")(function* (request: PictureRequest) {
        const executable = yield* browser.executable.pipe(
          Effect.map((path) => ({ _tag: "ready" as const, path })),
          Effect.catchTags({
            PreviewBrowserInstallingError: () => Effect.succeed({ _tag: "fetching" as const }),
          }),
          Effect.catch((error) =>
            Effect.logWarning("Kin can't draw pictures: no drawing browser", { error }).pipe(
              Effect.as({ _tag: "missing" as const }),
            ),
          ),
        );
        if (executable._tag === "fetching")
          return { _tag: "cannotDraw", reason: PICTURE_SENTENCES.fetching } satisfies PictureDrawn;
        if (executable._tag === "missing")
          return {
            _tag: "cannotDraw",
            reason: PICTURE_SENTENCES.cannotDraw,
          } satisfies PictureDrawn;
        const held = yield* confined;
        if (held._tag === "missing")
          return {
            _tag: "cannotDraw",
            reason: PICTURE_SENTENCES.cannotDraw,
          } satisfies PictureDrawn;
        yield* fs.makeDirectory(picturesDir, { recursive: true, mode: 0o700 });
        return yield* Effect.acquireUseRelease(
          fs.makeTempDirectory({ directory: picturesDir, prefix: "p-" }),
          (made) =>
            Effect.gen(function* () {
              const scratch = yield* fs.realPath(made);
              const launch = yield* launcherFor(executable.path, scratch, held);
              const size = KIN_PICTURE_SIZES[request.size];
              const blocked: Array<string> = [];
              const stop = Effect.gen(function* () {
                const leader = Number(
                  (yield* fs
                    .readFileString(launch.leader)
                    .pipe(Effect.orElseSucceed(() => ""))).trim(),
                );
                if (Number.isInteger(leader) && leader > 1) killGroup(leader);
                if (launch.unit !== undefined) yield* scopes.stop(launch.unit);
              });
              const context = yield* Effect.tryPromise({
                catch: browserError("launch"),
                try: () =>
                  loadPlaywright().chromium.launchPersistentContext(path.join(scratch, "profile"), {
                    executablePath: launch.launcher,
                    headless: true,
                    // Off only where the scope above holds it instead; Chrome's own needs namespaces.
                    chromiumSandbox: held._tag === "sandboxed",
                    env: { HOME: scratch, TMPDIR: scratch, PATH: "/usr/bin:/bin" },
                    args: [
                      "--disable-gpu",
                      "--disable-dev-shm-usage",
                      "--host-resolver-rules=MAP * ~NOTFOUND",
                    ],
                    viewport: size,
                    deviceScaleFactor: KIN_PICTURE_SCALE,
                    colorScheme: "light",
                    reducedMotion: "reduce",
                    acceptDownloads: false,
                    serviceWorkers: "block",
                    handleSIGINT: false,
                    handleSIGTERM: false,
                    handleSIGHUP: false,
                    timeout: limits.launchMs,
                  }),
              }).pipe(Effect.onError(() => stop));
              const shot = yield* shoot(context, request, blocked).pipe(
                Effect.map((png): Shot => ({ _tag: "shot", png })),
                Effect.timeoutOption(limits.pageMs),
                Effect.map(Option.getOrElse((): Shot => ({ _tag: "slow" }))),
                Effect.catchTags({
                  KinPictureBrowserError: (error) =>
                    error.crashed ? Effect.succeed<Shot>({ _tag: "crashed" }) : Effect.fail(error),
                }),
                Effect.ensuring(
                  Effect.promise(() => context.close().catch(() => undefined)).pipe(
                    Effect.timeoutOption(5_000),
                    Effect.andThen(stop),
                  ),
                ),
              );
              if (blocked.length > 0)
                return {
                  _tag: "refused",
                  reason: PICTURE_SENTENCES.outside(blocked[0]!),
                } satisfies PictureDrawn;
              if (shot._tag === "slow")
                return {
                  _tag: "refused",
                  reason: PICTURE_SENTENCES.slow(Math.round(limits.pageMs / 1000)),
                } satisfies PictureDrawn;
              if (shot._tag === "crashed")
                return {
                  _tag: "refused",
                  reason: PICTURE_SENTENCES.crashed,
                } satisfies PictureDrawn;
              const png = shot.png;
              if (png.length > limits.pngBytes)
                return {
                  _tag: "refused",
                  reason: PICTURE_SENTENCES.large(limits.pngBytes),
                } satisfies PictureDrawn;
              const drawn = pngSize(png);
              return {
                _tag: "drawn",
                png,
                width: drawn?.width ?? 0,
                height: drawn?.height ?? 0,
              } satisfies PictureDrawn;
            }),
          (made) => fs.remove(made, { recursive: true, force: true }).pipe(Effect.ignore),
        );
      });

      return KinPictureRenderer.of({
        render: Effect.fn("KinPictureRenderer.render")((request) =>
          queue(
            draw(request).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Kin couldn't draw a picture", { cause }).pipe(
                  Effect.as({
                    _tag: "cannotDraw",
                    reason: PICTURE_SENTENCES.cannotDraw,
                  } satisfies PictureDrawn),
                ),
              ),
            ),
            { _tag: "refused", reason: PICTURE_SENTENCES.busy },
          ),
        ),
      });
    }),
  );

export const layer = makeLayer();
