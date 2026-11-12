// @effect-diagnostics nodeBuiltinImport:off -- a local TCP listener stands in for a proxy, to count any connection Typst makes.
import * as NodeNet from "node:net";
import * as NodeZlib from "node:zlib";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { KinChatError, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import * as Vcs from "../../vcs/VcsProcess.ts";
import { decodeProblem } from "./brand.ts";
import { sampleInputs } from "./recipeLabels.ts";
import * as Render from "./render.ts";
import { STARTER_FILES } from "./starter.ts";
import { KinToolchain } from "./toolchain.ts";
import * as Workspace from "./workspace.ts";

// A Typst 0.15.1 binary on this machine, if the run names one; the cases needing it skip without.
const typst = process.env.KIN_TEST_TYPST;
const orgId = KinOrgId.make("org-render");
const toolchain = Layer.succeed(KinToolchain, {
  ensure: () =>
    typst === undefined
      ? Effect.fail(new KinChatError({ reason: "unavailable", message: "no Typst here" }))
      : Effect.succeed(typst),
  present: () => Effect.succeed(typst),
  fonts: () => Effect.undefined,
});
const layerOf = (limits = Render.RENDER_LIMITS) =>
  Render.makeLayer(limits).pipe(
    Layer.provideMerge(toolchain),
    Layer.provideMerge(Workspace.layer),
    Layer.provideMerge(Vcs.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-render-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

/** A recipe committed to the workspace as an agent's change would be. */
const commitRecipe = (name: string, files: Readonly<Record<string, string>>, link?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const vcs = yield* Vcs.VcsProcess;
    const workspace = yield* Workspace.KinWorkspace;
    yield* workspace.recipes(orgId);
    const root = yield* workspace.root(orgId);
    const git = (...args: ReadonlyArray<string>) =>
      vcs.run({
        operation: "KinRenderTest.git",
        command: "git",
        cwd: root,
        args: ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
        env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      });
    yield* fs.makeDirectory(`${root}/recipes/${name}`, { recursive: true });
    const markdown = `---\nname: ${name}\ntitle: Probe\ndescription: A probe.\noutputs: [probe.pdf]\ninputs:\n  note: { type: text }\n---\nProbe.\n`;
    for (const [file, text] of Object.entries({ "RECIPE.md": markdown, ...files }))
      yield* fs.writeFileString(`${root}/recipes/${name}/${file}`, text);
    if (link !== undefined) yield* fs.symlink(link, `${root}/recipes/${name}/linked.txt`);
    yield* git("add", "--all");
    yield* git("commit", "-qm", `Add ${name}`);
    return (yield* workspace.recipes(orgId)).find((one) => one.name === name)!;
  });
const starter = (name: string) =>
  Effect.gen(function* () {
    const recipes = yield* (yield* Workspace.KinWorkspace).recipes(orgId);
    const recipe = recipes.find((one) => one.name === name)!;
    const inputs = sampleInputs(recipe, STARTER_FILES[`recipes/${name}/sample.json`]);
    if (typeof inputs === "string") return yield* Effect.die(inputs);
    // Rendered with no logo: a sample's stand-in text is no file in the root.
    const logos = recipe.inputs.filter((input) => input.from === "company.logo");
    return {
      recipe,
      inputs: { ...inputs, ...Object.fromEntries(logos.map((input) => [input.name, null])) },
    };
  });
const render = (
  recipe: Workspace.StoredRecipe,
  inputs: Render.RenderRequest["inputs"] = { note: "hello" },
) =>
  Effect.flatMap(Render.KinDocRenderer, (renderer) =>
    renderer.render({ orgId, recipe, commit: recipe.commit, inputs, day: "2026-11-12" }),
  );
const reason = (rendered: Render.Rendered) =>
  rendered._tag === "failed" ? rendered.reason : "made a file";

it.live("stops a child at the time cap and at the output cap, and gives it no environment", () =>
  Effect.gen(function* () {
    const run = (script: string, timeoutMs = 10_000) =>
      Render.runCapped({
        command: "/bin/sh",
        args: ["-c", script],
        env: {},
        cwd: "/",
        timeoutMs,
        maxStdout: 1000,
      });
    assert.strictEqual((yield* run("sleep 30", 200))._tag, "timedOut");
    assert.strictEqual((yield* run("while :; do echo xxxxxxxxxxxxxxxx; done"))._tag, "tooLarge");
    // What the child started goes with it: a run ends only once nothing holds its output open, so
    // returning at all means the day-long sleep it left behind was stopped too.
    assert.strictEqual((yield* run("sleep 86400 & sleep 86400", 200))._tag, "timedOut");
    assert.strictEqual((yield* run("sleep 86400 & head -c 4000 /dev/zero; wait"))._tag, "tooLarge");
    // Processor time is capped too, wherever the host allows it.
    const limited = Render.limitedCommand("/bin/sh", ["-c", "while :; do :; done"], {
      cpuSeconds: 1,
      addressSpaceKiB: undefined,
    });
    const spun = yield* Render.runCapped({
      ...limited,
      env: {},
      cwd: "/",
      timeoutMs: 10_000,
      maxStdout: 1000,
    });
    assert.deepStrictEqual(spun._tag === "exited" ? spun.signal : spun._tag, "SIGXCPU");
    const exited = yield* run("printf '%s' \"$HOME$USER$T3CODE_HOME\"; echo broken >&2; exit 3");
    assert.deepStrictEqual(
      exited._tag === "exited"
        ? [exited.code, new TextDecoder().decode(exited.stdout), exited.stderr.trim()]
        : [],
      [3, "", "broken"],
    );
  }),
);

it.layer(layerOf())("KinDocRenderer", (it) => {
  it.effect("refuses a recipe whose folder holds a link, before anything runs", () =>
    Effect.gen(function* () {
      const recipe = yield* commitRecipe(
        "linked",
        { "template.typ": '#read("linked.txt")' },
        "/etc/hosts",
      );
      assert.match(reason(yield* render(recipe)), /linked\.txt is a link or a submodule/);
    }),
  );

  it.effect("removes the render folders a crash left, and follows no link out of them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { stateDir } = yield* ServerConfig;
      const renders = `${stateDir}/kin/renders`;
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "kin-outside-" });
      yield* fs.writeFileString(`${outside}/keep.txt`, "invented");
      yield* fs.makeDirectory(`${renders}/r-left`, { recursive: true });
      yield* fs.writeFileString(`${renders}/r-left/inputs.json`, "{}");
      yield* fs.symlink(outside, `${renders}/r-link`);
      yield* fs.symlink(outside, `${renders}/r-left/linked`);
      yield* Effect.provide(Effect.void, Layer.fresh(Render.layer));
      assert.deepStrictEqual(
        [
          yield* fs.exists(`${renders}/r-left`),
          yield* fs.exists(`${renders}/r-link`),
          yield* fs.readFileString(`${outside}/keep.txt`),
        ],
        [false, false, "invented"],
      );
      // A render folder that is itself a link is left alone, and so is what it points at.
      yield* fs.makeDirectory(`${outside}/r-elsewhere`);
      yield* fs.remove(renders, { recursive: true });
      yield* fs.symlink(outside, renders);
      yield* Effect.provide(Effect.void, Layer.fresh(Render.layer));
      assert.isTrue(yield* fs.exists(`${outside}/r-elsewhere`));
      yield* fs.remove(renders);
    }).pipe(Effect.scoped),
  );

  it.effect("writes a table recipe's files itself, with no Typst", () =>
    Effect.gen(function* () {
      const { recipe, inputs } = yield* starter("accountant-pack");
      const rendered = yield* render(recipe, inputs);
      assert.deepStrictEqual(
        rendered._tag === "made" ? rendered.files.map((file) => file.name) : reason(rendered),
        [
          "accounts-2026-10.xlsx",
          "invoices-2026-10.csv",
          "payments-2026-10.csv",
          "expenses-2026-10.csv",
        ],
      );
    }),
  );

  it.effect.skipIf(typst === undefined)(
    "draws a logo once as documents do, and says why one whose image data is garbage won't",
    () =>
      Effect.gen(function* () {
        const renderer = yield* Render.KinDocRenderer;
        const chunk = (type: string, data: Uint8Array) => {
          const out = new Uint8Array(12 + data.length);
          const view = new DataView(out.buffer);
          view.setUint32(0, data.length);
          out.set(new TextEncoder().encode(type), 4);
          out.set(data, 8);
          view.setUint32(8 + data.length, NodeZlib.crc32(out.subarray(4, 8 + data.length)));
          return out;
        };
        const header = new Uint8Array([0, 0, 0, 40, 0, 0, 0, 12, 8, 2, 0, 0, 0]);
        const png = new Uint8Array(
          [
            new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            chunk("IHDR", header),
            chunk("IDAT", NodeZlib.deflateSync(new Uint8Array((40 * 3 + 1) * 12))),
            chunk("IEND", new Uint8Array()),
          ].flatMap((part) => [...part]),
        );
        // Every marker in place, so the bytes check passes; only drawing it finds the garbage.
        const garbled = new Uint8Array([
          0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x0c, 0x00, 0x28, 0x03, 0x01, 0x22, 0x00,
          0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11,
          0x03, 0x11, 0x00, 0x3f, 0x00, 0xd2, 0xcf, 0x20, 0x8a, 0x28, 0xff, 0xd9,
        ]);
        assert.deepStrictEqual(
          [
            yield* decodeProblem(png, "image/png"),
            yield* decodeProblem(garbled, "image/jpeg"),
            yield* renderer.drawable({ bytes: png, extension: "png" }),
          ],
          [undefined, undefined, undefined],
        );
        assert.isString(yield* renderer.drawable({ bytes: garbled, extension: "jpg" }));
      }),
  );

  it.effect.skipIf(typst === undefined)(
    "renders the same bytes from the same inputs, recipe commit and day",
    () =>
      Effect.gen(function* () {
        const { recipe, inputs } = yield* starter("invoice");
        const first = yield* render(recipe, inputs);
        const second = yield* render(recipe, inputs);
        assert.deepStrictEqual(
          first._tag === "made" && second._tag === "made"
            ? [first.files[0]!.sha256 === second.files[0]!.sha256, first.files[0]!.pages]
            : [reason(first)],
          [true, 1],
        );
      }),
  );

  it.effect.skipIf(typst === undefined)(
    "lets a template read its own folder and inputs, and nothing outside its root",
    () =>
      Effect.gen(function* () {
        const own = yield* commitRecipe("own", {
          "template.typ": '#let d = json("/inputs.json")\n#read("/recipe/note.txt") #d.note',
          "note.txt": "own file",
        });
        assert.strictEqual(reason(yield* render(own)), "made a file");
        const climbing = yield* commitRecipe("climbing", {
          "template.typ": '#read("../../../../../../../../../etc/hosts")',
        });
        assert.match(reason(yield* render(climbing)), /escape|outside/i);
        // An absolute path means the render folder's own, where there is no /etc.
        const absolute = yield* commitRecipe("absolute", { "template.typ": '#read("/etc/hosts")' });
        assert.match(reason(yield* render(absolute)), /not found|does not exist/i);
        const broken = yield* commitRecipe("broken", { "template.typ": "#let x = (" });
        assert.match(reason(yield* render(broken)), /^probe\.pdf: template\.typ:1:/);
      }),
  );

  it.effect.skipIf(typst === undefined)(
    "puts the logo in the root only for a recipe that reads it, and shows the first page",
    () =>
      Effect.gen(function* () {
        const logo = {
          bytes: new TextEncoder().encode(
            '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#0A5C8F"/></svg>',
          ),
          extension: "svg",
        };
        const markdown = (name: string, reads: boolean) =>
          `---\nname: ${name}\ntitle: Probe\ndescription: A probe.\noutputs: [probe.pdf]\ninputs:\n  note: { type: text }\n${reads ? "  logo: { type: text, from: company.logo, required: false }\n" : ""}---\nProbe.\n`;
        const template = '#image("/brand/logo.svg", width: 2cm)\n#json("/inputs.json").note';
        const reads = yield* commitRecipe("branded", {
          "RECIPE.md": markdown("branded", true),
          "template.typ": template,
        });
        const shown = yield* Effect.flatMap(Render.KinDocRenderer, (renderer) =>
          renderer.render({
            orgId,
            recipe: reads,
            commit: reads.commit,
            inputs: { note: "hello", logo: "/brand/logo.svg" },
            day: "2026-11-12",
            logo,
            page: true,
          }),
        );
        assert.deepStrictEqual(
          shown._tag === "made"
            ? [shown.files.map((file) => file.name), shown.page?.name, shown.page?.mimeType]
            : [reason(shown)],
          [["probe.pdf"], "probe-page-1.png", "image/png"],
        );
        // A recipe that doesn't declare the logo finds no file there, though Kin was given one.
        const sneaks = yield* commitRecipe("sneaks", {
          "RECIPE.md": markdown("sneaks", false),
          "template.typ": template,
        });
        const refused = yield* Effect.flatMap(Render.KinDocRenderer, (renderer) =>
          renderer.render({
            orgId,
            recipe: sneaks,
            commit: sneaks.commit,
            inputs: { note: "hello" },
            day: "2026-11-12",
            logo,
          }),
        );
        assert.match(reason(refused), /not found|does not exist/i);
      }),
  );

  it.effect.skipIf(typst === undefined)(
    "imports no package and makes no connection to fetch one",
    () =>
      Effect.gen(function* () {
        const connections = { count: 0 };
        const server = NodeNet.createServer((socket) => {
          connections.count += 1;
          socket.destroy();
        });
        const port = yield* Effect.callback<number>((resume) => {
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            resume(
              Effect.succeed(typeof address === "object" && address !== null ? address.port : 0),
            );
          });
        });
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "kin-typst-" }),
        );
        yield* fs.makeDirectory(`${root}/recipe`);
        yield* fs.writeFileString(
          `${root}/recipe/template.typ`,
          '#import "@preview/cetz:0.3.0": *\nhello',
        );
        const run = yield* Render.runCapped({
          command: typst!,
          args: Render.typstArgs({ root, output: "probe.pdf", creationTimestamp: 0 }),
          env: Render.typstEnv(`http://127.0.0.1:${port}`),
          cwd: root,
          timeoutMs: 20_000,
          maxStdout: 1024 * 1024,
        });
        server.close();
        assert.deepStrictEqual(
          [run._tag, run._tag === "exited" ? run.code : null, connections.count],
          ["exited", 1, 0],
        );
        assert.isFalse(yield* fs.exists(`${root}/.no-packages`));
      }).pipe(Effect.scoped),
  );
});

it.layer(layerOf({ ...Render.RENDER_LIMITS, timeoutMs: 1500, pdfBytes: 64 * 1024 }))(
  "KinDocRenderer caps",
  (it) => {
    it.effect.skipIf(typst === undefined)(
      "stops a template that runs forever or makes too much, and makes nothing",
      () =>
        Effect.gen(function* () {
          const forever = yield* commitRecipe("forever", {
            "template.typ": "#for i in range(100000) { for j in range(100000) {} }",
          });
          assert.match(reason(yield* render(forever)), /ran over 1\.5 seconds/);
          const huge = yield* commitRecipe("huge", {
            "template.typ": "#for i in range(300) [#lorem(500) #pagebreak()]",
          });
          assert.match(reason(yield* render(huge)), /made more than/);
        }),
    );
  },
);
