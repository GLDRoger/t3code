// @effect-diagnostics nodeBuiltinImport:off -- a local TCP listener stands in for a proxy, to count any connection Typst makes.
import * as NodeNet from "node:net";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { KinChatError, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import * as Vcs from "../../vcs/VcsProcess.ts";
import { sampleInputs } from "./DocJobs.ts";
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
    return { recipe, inputs };
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

it.layer(layerOf({ timeoutMs: 1500, pdfBytes: 64 * 1024, memory: "1G" }))(
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
