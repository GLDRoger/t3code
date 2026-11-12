// @effect-diagnostics nodeBuiltinImport:off -- Typst's PDF is binary on stdout, read with a running byte cap and an environment built from nothing, which ProcessRunner can't express.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";

import { KinChatError, type KinOrgId } from "@t3tools/contracts";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { createDeterministicAttachmentId } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { computeData } from "./compute.ts";
import type { Recipe, Value } from "./recipe.ts";
import { type Taken, typeMismatch } from "./returnPath.ts";
import { fileName, tableFiles, tableTooLarge } from "./tables.ts";
import { KinToolchain } from "./toolchain.ts";
import { KinWorkspace } from "./workspace.ts";

// Makes a recipe's files on the server, with no worker and no model. The template is agent-written,
// so it runs as untrusted code: a fresh root holding only a copy of the recipe and the inputs, no
// packages or network, an empty environment, its own process group, and caps on time, output and
// processor time everywhere, memory under systemd, and address space where Linux has no systemd.

export const RENDER_LIMITS: {
  readonly timeoutMs: number;
  readonly pdfBytes: number;
  readonly memory: string;
  readonly cpuSeconds: number;
  readonly addressSpaceKiB: number;
} = {
  timeoutMs: 20_000,
  pdfBytes: 50 * 1024 * 1024,
  memory: "1G",
  cpuSeconds: 60,
  addressSpaceKiB: 4 * 1024 * 1024,
};
const STDERR_BYTES = 64 * 1024;

export type Rendered =
  | {
      readonly _tag: "made";
      readonly files: ReadonlyArray<Taken>;
      /** The first PDF's first page as a PNG, when asked for. */
      readonly page?: Taken;
    }
  /** The recipe, its inputs or its template didn't make a file; the reason is data to show. */
  | { readonly _tag: "failed"; readonly reason: string };

export type RenderRequest = {
  readonly orgId: KinOrgId;
  readonly recipe: Recipe;
  readonly commit: string;
  readonly inputs: Readonly<Record<string, Value>>;
  /** For the PDF's creation date and `datetime.today()`: the day as of 00:00 UTC. */
  readonly day: string;
  /** The company logo, placed at `/brand/logo.<extension>` when an input reads `company.logo`. */
  readonly logo?: { readonly bytes: Uint8Array; readonly extension: string } | null;
  /** Also make the first page as a PNG, for a look at it in a chat. */
  readonly page?: boolean;
};

/** Pixels per inch of a page preview: an A4 page about 900 pixels wide. */
const PAGE_PPI = 110;

export class KinDocRenderer extends Context.Service<
  KinDocRenderer,
  {
    readonly render: (request: RenderRequest) => Effect.Effect<Rendered, KinChatError>;
    /** A file stored by its content: the same bytes again are the same attachment, written once. */
    readonly store: (
      orgId: KinOrgId,
      jobId: string,
      file: { readonly sha256: string; readonly extension: string; readonly bytes: Uint8Array },
    ) => Effect.Effect<string, KinChatError>;
  }
>()("t3/kin/gendocs/render/KinDocRenderer") {}

/** Typst's arguments: everything it may touch is inside `root`, and nothing can be fetched. */
export const typstArgs = (input: {
  readonly root: string;
  readonly output: string;
  readonly creationTimestamp: number;
  /** Kin's pinned fonts, outside the root: fonts are read, never shown as files. */
  readonly fonts?: string | undefined;
  /** The first page as a PNG instead of the PDF. */
  readonly page?: boolean;
}) => [
  // A certificate that isn't there fails any download before it connects (typst-kit downloader).
  "--cert",
  `${input.root}/.no-certificate`,
  "compile",
  "--root",
  input.root,
  "--ignore-system-fonts",
  "--font-path",
  `${input.root}/recipe`,
  ...(input.fonts === undefined ? [] : ["--font-path", input.fonts]),
  "--package-path",
  `${input.root}/.no-packages`,
  "--package-cache-path",
  `${input.root}/.no-packages`,
  "--creation-timestamp",
  String(input.creationTimestamp),
  "--diagnostic-format",
  "short",
  ...(input.page === true
    ? ["--format", "png", "--pages", "1", "--ppi", String(PAGE_PPI)]
    : ["--format", "pdf"]),
  "--input",
  `output=${input.output}`,
  `${input.root}/recipe/template.typ`,
  "-",
];
/** Nothing from the server's environment; a proxy that refuses, should anything try to fetch. */
export const typstEnv = (proxy = "http://127.0.0.1:9"): Readonly<Record<string, string>> => ({
  HTTPS_PROXY: proxy,
  HTTP_PROXY: proxy,
  ALL_PROXY: proxy,
  https_proxy: proxy,
  http_proxy: proxy,
  all_proxy: proxy,
});

type Run =
  | {
      readonly _tag: "exited";
      readonly code: number;
      readonly signal: NodeJS.Signals | null;
      readonly stdout: Uint8Array;
      readonly stderr: string;
    }
  | { readonly _tag: "timedOut" }
  | { readonly _tag: "tooLarge" }
  | { readonly _tag: "notStarted"; readonly message: string };

/**
 * Runs `command` with processor time capped, and, with no systemd scope to hold its memory, its
 * address space too. Each is the host's to refuse: macOS refuses an address-space limit, so there
 * the wall-clock and output caps and the processor-time limit are all that bound a render.
 */
export const limitedCommand = (
  command: string,
  args: ReadonlyArray<string>,
  limits: { readonly cpuSeconds: number; readonly addressSpaceKiB: number | undefined },
) => ({
  command: "/bin/sh",
  args: [
    "-c",
    `ulimit -t ${limits.cpuSeconds} 2>/dev/null; ${limits.addressSpaceKiB === undefined ? "" : `ulimit -v ${limits.addressSpaceKiB} 2>/dev/null; `}exec "$@"`,
    "kin-render",
    command,
    ...args,
  ],
});

/**
 * One child in its own process group, the whole group killed at the time or output cap, or when the
 * caller is interrupted, so nothing it started outlives it holding its output open.
 */
export const runCapped = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxStdout: number;
}) =>
  Effect.flatMap(HostProcess.Platform, (platform) =>
    Effect.callback<Run>((resume) => {
      const grouped = platform !== "win32";
      const child = NodeChildProcess.spawn(input.command, [...input.args], {
        cwd: input.cwd,
        env: { ...input.env },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: grouped,
      });
      const killGroup = () => {
        try {
          if (child.pid !== undefined && grouped) process.kill(-child.pid, "SIGKILL");
        } catch {
          // The group is already gone.
        }
        child.kill("SIGKILL");
      };
      const chunks: Array<Buffer> = [];
      let size = 0;
      let stderr = "";
      let settled: Run | undefined;
      const settle = (run: Run) => {
        if (settled !== undefined) return;
        settled = run;
        if (run._tag !== "exited") killGroup();
      };
      // @effect-diagnostics-next-line globalTimersInEffect:off -- a plain callback around a Node child, outside any fiber.
      const timer = setTimeout(() => settle({ _tag: "timedOut" }), input.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > input.maxStdout) return settle({ _tag: "tooLarge" });
        chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < STDERR_BYTES) stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        settle({ _tag: "notStarted", message: error.message });
        resume(Effect.succeed(settled!));
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        settle({
          _tag: "exited",
          code: code ?? -1,
          signal,
          stdout: new Uint8Array(Buffer.concat(chunks, Math.min(size, input.maxStdout))),
          stderr,
        });
        resume(Effect.succeed(settled!));
      });
      return Effect.sync(() => {
        clearTimeout(timer);
        killGroup();
      });
    }),
  );

/** Typst's error text without the folder it ran in, for the agent and the owner. */
const plainError = (stderr: string, root: string) =>
  stderr
    .replaceAll(`${root}/recipe/`, "")
    .replaceAll(root, "")
    .replace(/(^|\s)recipe\//gm, "$1")
    .trim()
    .slice(0, 2000) || "Typst stopped without saying why";

const pdfPages = (bytes: Uint8Array) => {
  const count =
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      .toString("latin1")
      .match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
  return count > 0 ? count : null;
};
const taken = (name: string, bytes: Uint8Array): Taken => {
  const extension = name.endsWith(".xlsx")
    ? "xlsx"
    : name.endsWith(".csv")
      ? "csv"
      : name.endsWith(".png")
        ? "png"
        : "pdf";
  return {
    name,
    extension,
    mimeType:
      extension === "xlsx"
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : extension === "csv"
          ? "text/csv"
          : extension === "png"
            ? "image/png"
            : "application/pdf",
    bytes,
    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    pages: extension === "pdf" ? pdfPages(bytes) : null,
  };
};

const failed = (reason: string): Rendered => ({ _tag: "failed", reason });
const isChatError = Schema.is(KinChatError);
const unavailable = new KinChatError({
  reason: "unavailable",
  message: "Kin couldn't store this document right now. Nothing was made.",
});
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const makeLayer = (limits: typeof RENDER_LIMITS = RENDER_LIMITS) =>
  Layer.effect(
    KinDocRenderer,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const toolchain = yield* KinToolchain;
      const workspace = yield* KinWorkspace;
      const scopes = yield* AgentScope;
      const rendersDir = path.join(config.stateDir, "kin", "renders");
      // A crash leaves its scratch folders, inputs and all; none is in use before this layer is.
      // Only the folder's own entries go, and only when it is itself, not a link, in its place.
      yield* Effect.gen(function* () {
        if (!(yield* fs.exists(rendersDir))) return;
        const linked = yield* fs.readLink(rendersDir).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        const own = path.join(yield* fs.realPath(config.stateDir), "kin", "renders");
        if (linked || (yield* fs.realPath(rendersDir)) !== own)
          return yield* Effect.logWarning(
            "Kin left its render folder: it isn't a plain folder in its own place",
          );
        for (const entry of yield* fs.readDirectory(rendersDir))
          yield* fs.remove(path.join(rendersDir, entry), { recursive: true, force: true });
      }).pipe(Effect.ignoreCause({ log: true }));

      /** Every file checked as the return path checks a worker's: type by its bytes. */
      const checked = Effect.fn("KinDocRenderer.check")(function* (
        files: ReadonlyArray<Taken>,
        page?: Taken,
      ) {
        for (const file of page === undefined ? files : [...files, page]) {
          const problem = yield* Effect.promise(() => typeMismatch(file.extension, file.bytes));
          if (problem !== undefined) return failed(`${file.name}: ${problem}`);
        }
        return { _tag: "made", files, ...(page === undefined ? {} : { page }) } satisfies Rendered;
      });

      const typst = Effect.fn("KinDocRenderer.typst")(function* (
        request: RenderRequest,
        data: unknown,
      ) {
        yield* fs.makeDirectory(rendersDir, { recursive: true, mode: 0o700 });
        return yield* Effect.acquireUseRelease(
          fs.makeTempDirectory({ directory: rendersDir, prefix: "r-" }),
          (scratch) =>
            Effect.gen(function* () {
              const root = yield* fs.realPath(scratch);
              const copied = yield* workspace.checkoutRecipe(
                request.orgId,
                request.recipe.name,
                request.commit,
                path.join(root, "recipe"),
              );
              if (copied._tag === "refused") return failed(copied.reason);
              if (!(yield* fs.exists(path.join(root, "recipe", "template.typ"))))
                return failed(
                  `the ${request.recipe.name} recipe has no template.typ, so Kin can't render it. Have it rewritten with writeRecipe`,
                );
              const binary = yield* toolchain.ensure();
              const fonts = yield* toolchain.fonts();
              yield* fs.writeFileString(path.join(root, "inputs.json"), yield* encodeJson(data));
              // Only a recipe that reads the logo gets its file, at the one place it names.
              if (
                request.logo != null &&
                request.recipe.inputs.some((input) => input.from === "company.logo")
              ) {
                yield* fs.makeDirectory(path.join(root, "brand"));
                yield* fs.writeFile(
                  path.join(root, `brand/logo.${request.logo.extension}`),
                  request.logo.bytes,
                );
              }
              const made: Array<Taken> = [];
              let page: Taken | undefined;
              const runs = request.recipe.outputs.map((output) => ({ output, page: false }));
              if (request.page === true && runs[0] !== undefined)
                runs.push({ output: runs[0].output, page: true });
              for (const { output, page: asPage } of runs) {
                const args = typstArgs({
                  root,
                  output,
                  creationTimestamp: Math.floor(Date.parse(`${request.day}T00:00:00Z`) / 1000),
                  fonts,
                  page: asPage,
                });
                const scoped = yield* scopes.wrap({
                  command: binary,
                  args,
                  name: "kin-render",
                  env: typstEnv(),
                  properties: [`MemoryMax=${limits.memory}`, "MemorySwapMax=0", "TasksMax=64"],
                });
                const limited = limitedCommand(scoped.command, scoped.args, {
                  cpuSeconds: limits.cpuSeconds,
                  addressSpaceKiB: scoped.unit === undefined ? limits.addressSpaceKiB : undefined,
                });
                const run = yield* runCapped({
                  command: limited.command,
                  args: limited.args,
                  env: typstEnv(),
                  cwd: root,
                  timeoutMs: limits.timeoutMs,
                  maxStdout: limits.pdfBytes,
                }).pipe(
                  Effect.ensuring(
                    scoped.unit === undefined ? Effect.void : scopes.stop(scoped.unit),
                  ),
                );
                switch (run._tag) {
                  case "notStarted":
                    return yield* new KinChatError({
                      reason: "unavailable",
                      message: "Kin couldn't run Typst on this host. Nothing was made.",
                    });
                  case "timedOut":
                    return failed(
                      `${output}: the template ran over ${limits.timeoutMs / 1000} seconds, so Kin stopped it`,
                    );
                  case "tooLarge":
                    return failed(
                      `${output}: the template made more than ${limits.pdfBytes / 1048576} MB, so Kin stopped it`,
                    );
                  case "exited":
                    if (run.signal === "SIGXCPU")
                      return failed(
                        `${output}: the template used over ${limits.cpuSeconds} seconds of processor time, so Kin stopped it`,
                      );
                    if (run.code !== 0)
                      return failed(
                        /package not found|@preview\//.test(run.stderr)
                          ? `${output}: the template imports a package, and Kin renders with no packages. ${plainError(run.stderr, root)}`
                          : `${output}: ${plainError(run.stderr, root)}`,
                      );
                    if (asPage) page = taken(output.replace(/\.pdf$/, "-page-1.png"), run.stdout);
                    else made.push(taken(output, run.stdout));
                }
              }
              return yield* checked(made, page);
            }),
          (scratch) => fs.remove(scratch, { recursive: true, force: true }).pipe(Effect.ignore),
        );
      });

      const render: KinDocRenderer["Service"]["render"] = Effect.fn("KinDocRenderer.render")(
        function* (request) {
          if (request.recipe.kind === "table") {
            const tooLarge = tableTooLarge(request.recipe, request.inputs);
            if (tooLarge !== undefined) return failed(tooLarge);
            const files = tableFiles(request.recipe, request.inputs);
            const declared = request.recipe.outputs.map((output) =>
              fileName(output, request.inputs),
            );
            const strange = files.find((file) => !declared.includes(file.name));
            if (strange !== undefined)
              return failed(
                `${strange.name} isn't one of the files the recipe declares in outputs`,
              );
            return yield* checked(files.map((file) => taken(file.name, file.bytes)));
          }
          const computed = computeData(request.inputs, request.recipe.computed);
          if ("error" in computed) return failed(computed.error);
          return yield* typst(request, computed.data);
        },
        Effect.catchIf(
          (cause) => !isChatError(cause),
          (cause) =>
            Effect.logWarning("Kin couldn't render a document", { cause }).pipe(
              Effect.andThen(
                Effect.fail(
                  new KinChatError({
                    reason: "unavailable",
                    message: "Kin couldn't render this document right now. Nothing was made.",
                  }),
                ),
              ),
            ),
        ),
      );
      const store: KinDocRenderer["Service"]["store"] = Effect.fn("KinDocRenderer.store")(
        function* (orgId, jobId, file) {
          const base = createDeterministicAttachmentId("kin-chat", `${orgId}:${file.sha256}`);
          if (base === null) return yield* unavailable;
          const attachmentId = `${base}-${file.extension}`;
          const target = path.join(config.attachmentsDir, `${attachmentId}.${file.extension}`);
          if (!(yield* fs.exists(target))) {
            yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
            const scratch = `${target}.${jobId}.tmp`;
            yield* fs.writeFile(scratch, file.bytes);
            yield* fs.rename(scratch, target);
          }
          return attachmentId;
        },
        Effect.catchIf(
          (cause) => !isChatError(cause),
          (cause) =>
            Effect.logWarning("Kin couldn't store a document", { cause }).pipe(
              Effect.andThen(Effect.fail(unavailable)),
            ),
        ),
      );
      return KinDocRenderer.of({ render, store });
    }),
  );

export const layer = makeLayer();
