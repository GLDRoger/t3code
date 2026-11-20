// @effect-diagnostics nodeBuiltinImport:off
import * as NodeDgram from "node:dgram";
import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { chromium } from "playwright-core";

import { ServerConfig } from "../../config.ts";
import { PreviewBrowser } from "../../preview/PreviewBrowser.ts";
import { hostilePage } from "../visualSeal.testkit.ts";
import {
  KinPictureRenderer,
  makeLayer,
  PICTURE_LIMITS,
  PICTURE_SENTENCES,
  pictureQueue,
  type PictureLimits,
} from "./renderer.ts";
import { KIN_PICTURE_SCALE, KIN_PICTURE_SIZES, type KinPictureSize } from "./sizes.ts";

const TEST_BROWSER_ENV = "T3CODE_TEST_HEADLESS_SHELL";

describe("pictureQueue", () => {
  it.effect("draws one at a time and turns away what won't fit in line", () =>
    Effect.gen(function* () {
      const queue = yield* pictureQueue(1);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const order: Array<string> = [];
      const held = Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(release));
      const first = yield* Effect.forkChild(
        queue(
          held.pipe(
            Effect.as("first"),
            Effect.tap(() => Effect.sync(() => order.push("first"))),
          ),
          "busy",
        ),
        { startImmediately: true },
      );
      yield* Deferred.await(entered);
      const second = yield* Effect.forkChild(
        queue(Effect.sync(() => order.push("second")).pipe(Effect.as("second")), "busy"),
        { startImmediately: true },
      );
      assert.strictEqual(yield* queue(Effect.succeed("third"), "busy"), "busy");
      yield* Deferred.succeed(release, undefined);
      assert.strictEqual(yield* Fiber.join(first), "first");
      assert.strictEqual(yield* Fiber.join(second), "second");
      assert.deepStrictEqual(order, ["first", "second"]);
      // The line is free again once both are done.
      assert.strictEqual(yield* queue(Effect.succeed("fourth"), "busy"), "fourth");
    }),
  );
});

const renderer = (executable: string, limits: PictureLimits) =>
  makeLayer(limits).pipe(
    Layer.provide(
      Layer.succeed(PreviewBrowser, {
        executable: Effect.succeed(executable),
        installed: Effect.succeedSome(executable),
      }),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-picture-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const withRenderer = <A, E>(
  limits: Partial<PictureLimits>,
  use: (render: KinPictureRenderer["Service"]["render"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const executable = (yield* HostProcess.Environment)[TEST_BROWSER_ENV];
    if (!executable) return Option.none<A>();
    const service = yield* KinPictureRenderer.pipe(
      Effect.provide(renderer(executable, { ...PICTURE_LIMITS, ...limits })),
    );
    return Option.some(yield* use(service.render));
  });

const skipped = `Set ${TEST_BROWSER_ENV} to run this test.`;
/** A 1x1 PNG, served from memory as a chat's file or the company's logo. */
const PIXEL = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const plain = (body: string) =>
  `<!doctype html><html><head><style>html,body{margin:0}</style></head><body>${body}</body></html>`;

it.live("a picture is drawn at twice each named size", (ctx) =>
  Effect.gen(function* () {
    const sizes = Object.keys(KIN_PICTURE_SIZES) as ReadonlyArray<KinPictureSize>;
    const drawn = yield* withRenderer({}, (render) =>
      Effect.forEach(sizes, (size) =>
        render({
          html: plain(
            `<div style="width:100vw;height:100vh;background:#1f6f5c;color:#fff;font:bold 40px sans-serif">Launch day</div>`,
          ),
          size,
          files: [],
        }),
      ),
    );
    if (Option.isNone(drawn)) return ctx.skip(skipped);
    drawn.value.forEach((result, index) => {
      const size = KIN_PICTURE_SIZES[sizes[index]!];
      assert.strictEqual(result._tag, "drawn");
      if (result._tag !== "drawn") return;
      assert.deepStrictEqual(
        { width: result.width, height: result.height },
        { width: size.width * KIN_PICTURE_SCALE, height: size.height * KIN_PICTURE_SCALE },
      );
    });
  }),
);

it.live("a picture draws with Kin's libraries and the chat's own file", (ctx) =>
  Effect.gen(function* () {
    const drawn = yield* withRenderer({}, (render) =>
      render({
        html: plain(
          // Should the file or the library fail to load, the page reaches outside and is refused.
          `<img id="i" src="kin-file:kin-photo" width="40" height="40"><script src="/api/kin/visual-lib/6.1.0/echarts.js"></script><div id="c" style="width:500px;height:300px"></div><script>kin.echarts("#c",{xAxis:{data:["Q1","Q2","Q3"]},yAxis:{},series:[{type:"bar",data:[12,30,18]}]});window.addEventListener("load",function(){if(!document.getElementById("i").naturalWidth||!window.echarts)document.body.insertAdjacentHTML("beforeend",'<img src="https://broken.example.com/x.png">')})</script>`,
        ),
        size: "square",
        files: [{ id: "kin-photo", mimeType: "image/png", bytes: PIXEL }],
      }),
    );
    if (Option.isNone(drawn)) return ctx.skip(skipped);
    assert.strictEqual(drawn.value._tag, "drawn");
  }),
);

// Any TrueType file stands in for Kin's fetched Poppins: the route serving it is what is tested.
const STAND_IN_FONTS = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
];

it.live("a picture draws in the company's colours, font and logo", (ctx) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const fonts = yield* fs.makeTempDirectoryScoped({ prefix: "kin-picture-fonts-" });
    const font = yield* Effect.findFirst(STAND_IN_FONTS, (file) =>
      fs.exists(file).pipe(Effect.orElseSucceed(() => false)),
    );
    if (Option.isNone(font)) return ctx.skip("No TrueType font on this host to stand in.");
    yield* fs.copyFile(font.value, `${fonts}/Poppins-Bold.ttf`);
    const drawn = yield* withRenderer({}, (render) =>
      render({
        html: plain(
          // Should the colour, the font or the logo not arrive, the page reaches outside and is refused.
          `<img id="l" src="kin-brand:logo" width="40" height="40"><p style="font:700 40px var(--brand-font)">Ambermill</p><div id="b" style="height:20px;background:var(--brand-primary)"></div><script>document.fonts.ready.then(function(){var ok=document.getElementById("l").naturalWidth>0&&getComputedStyle(document.getElementById("b")).backgroundColor==="rgb(31, 111, 92)"&&document.fonts.check("700 40px Poppins");if(!ok)document.body.insertAdjacentHTML("beforeend",'<img src="https://broken.example.com/x.png">')})</script>`,
        ),
        size: "square",
        files: [],
        fonts,
        brand: {
          primary: "#1F6F5C",
          secondary: null,
          font: "Poppins",
          logo: { mimeType: "image/png", bytes: PIXEL },
        },
      }),
    );
    if (Option.isNone(drawn)) return ctx.skip(skipped);
    assert.strictEqual(drawn.value._tag, "drawn");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("a page that loads from outside is refused, and one that never settles is stopped", (ctx) =>
  Effect.gen(function* () {
    const results = yield* withRenderer({ pageMs: 2_000 }, (render) =>
      Effect.all([
        render({
          html: plain(`<img src="https://images.example.com/team.png">Hello`),
          size: "square",
          files: [],
        }),
        render({
          html: plain(
            `<p id="t"></p><script>setInterval(function(){t.textContent=Math.random()},100)</script>`,
          ),
          size: "square",
          files: [],
        }),
        render({ html: plain(`<script>for(;;){}</script>`), size: "square", files: [] }),
      ]),
    );
    if (Option.isNone(results)) return ctx.skip(skipped);
    const [outside, restless, spinning] = results.value;
    assert.deepStrictEqual(outside, {
      _tag: "refused",
      reason: PICTURE_SENTENCES.outside("images.example.com"),
    });
    assert.deepStrictEqual(restless, { _tag: "refused", reason: PICTURE_SENTENCES.slow(2) });
    assert.deepStrictEqual(spinning, { _tag: "refused", reason: PICTURE_SENTENCES.slow(2) });
  }),
);

it.live("a picture over the chat's image limit is refused", (ctx) =>
  Effect.gen(function* () {
    const result = yield* withRenderer({ pngBytes: 1_000 }, (render) =>
      render({
        html: plain(
          `<div style="width:540px;height:540px;background:linear-gradient(90deg,red,blue)"></div>`,
        ),
        size: "square",
        files: [],
      }),
    );
    if (Option.isNone(result)) return ctx.skip(skipped);
    assert.deepStrictEqual(result.value, {
      _tag: "refused",
      reason: PICTURE_SENTENCES.large(1_000),
    });
  }),
);

const canaries = Effect.acquireRelease(
  Effect.callback<{
    readonly udpPort: number;
    readonly tcpPort: number;
    readonly reached: Array<string>;
    readonly tcp: Deferred.Deferred<void>;
    readonly close: () => void;
  }>((resume) => {
    const reached: Array<string> = [];
    const tcpSeen = Deferred.makeUnsafe<void>();
    const udp = NodeDgram.createSocket("udp4");
    udp.on("message", () => reached.push("udp"));
    const tcp = NodeNet.createServer((socket) => {
      reached.push("tcp");
      Deferred.doneUnsafe(tcpSeen, Effect.void);
      socket.on("error", () => {});
      socket.destroy();
    });
    udp.bind(0, "127.0.0.1", () =>
      tcp.listen(0, "127.0.0.1", () =>
        resume(
          Effect.succeed({
            udpPort: udp.address().port,
            tcpPort: (tcp.address() as NodeNet.AddressInfo).port,
            reached,
            tcp: tcpSeen,
            close: () => {
              udp.close();
              tcp.close();
            },
          }),
        ),
      ),
    );
  }),
  ({ close }) => Effect.sync(close),
);

it.live("the seal test's hostile page, drawn as a picture, reaches nothing", (ctx) =>
  Effect.gen(function* () {
    const executable = (yield* HostProcess.Environment)[TEST_BROWSER_ENV];
    if (!executable) return ctx.skip(skipped);
    const canary = yield* canaries;
    const http = `http://127.0.0.1:${canary.tcpPort}`;
    const page = hostilePage(`127.0.0.1:${canary.udpPort}`, http, canary.tcpPort);
    // Still long enough for the page's last attempts, which navigate away after 2.5 seconds.
    const result = yield* withRenderer({ stillMs: 3_500 }, (render) =>
      render({ html: page, size: "square", files: [] }),
    );
    assert.deepStrictEqual(canary.reached, []);
    assert.strictEqual(Option.getOrUndefined(result)?._tag, "refused");
    // The control: the same page in a plain browser reaches the canary, so silence is no blind canary.
    const browser = yield* Effect.acquireRelease(
      Effect.promise(() => chromium.launch({ executablePath: executable, headless: true })),
      (open) => Effect.promise(() => open.close()),
    );
    const tab = yield* Effect.promise(() => browser.newPage());
    yield* Effect.promise(() => tab.setContent(page));
    yield* Deferred.await(canary.tcp);
  }).pipe(Effect.scoped),
);
