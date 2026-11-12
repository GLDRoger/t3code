// @effect-diagnostics nodeBuiltinImport:off -- Typst's PDF is binary on stdout, read with a running byte cap and an environment built from nothing, which ProcessRunner can't express.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";

import { KinChatError, type KinOrgId } from "@t3tools/contracts";
import { AgentScope } from "@t3tools/shared/AgentScope";
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
import { fileName, tableFiles } from "./tables.ts";
import { KinToolchain } from "./toolchain.ts";
import { KinWorkspace } from "./workspace.ts";

// Makes a recipe's files on the server, with no worker and no model. The template is agent-written,
// so it runs as untrusted code: a fresh root holding only a copy of the recipe and the inputs, no
// packages or network, an empty environment, and caps on time, output and (under systemd) memory.

export const RENDER_LIMITS: {
  readonly timeoutMs: number;
  readonly pdfBytes: number;
  readonly memory: string;
} = { timeoutMs: 20_000, pdfBytes: 50 * 1024 * 1024, memory: "1G" };
const STDERR_BYTES = 64 * 1024;

export type Rendered =
  | { readonly _tag: "made"; readonly files: ReadonlyArray<Taken> }
  /** The recipe, its inputs or its template didn't make a file; the reason is data to show. */
  | { readonly _tag: "failed"; readonly reason: string };

export type RenderRequest = {
  readonly orgId: KinOrgId;
  readonly recipe: Recipe;
  readonly commit: string;
  readonly inputs: Readonly<Record<string, Value>>;
  /** For the PDF's creation date and `datetime.today()`: the day as of 00:00 UTC. */
  readonly day: string;
};

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
  "--package-path",
  `${input.root}/.no-packages`,
  "--package-cache-path",
  `${input.root}/.no-packages`,
  "--creation-timestamp",
  String(input.creationTimestamp),
  "--diagnostic-format",
  "short",
  "--format",
  "pdf",
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
      readonly stdout: Uint8Array;
      readonly stderr: string;
    }
  | { readonly _tag: "timedOut" }
  | { readonly _tag: "tooLarge" }
  | { readonly _tag: "notStarted"; readonly message: string };

/** One child, killed at the time or output cap, or when the caller is interrupted. */
export const runCapped = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxStdout: number;
}) =>
  Effect.callback<Run>((resume) => {
    const child = NodeChildProcess.spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: { ...input.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Array<Buffer> = [];
    let size = 0;
    let stderr = "";
    let settled: Run | undefined;
    const settle = (run: Run) => {
      if (settled !== undefined) return;
      settled = run;
      if (run._tag !== "exited") child.kill("SIGKILL");
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
    child.on("close", (code) => {
      clearTimeout(timer);
      settle({
        _tag: "exited",
        code: code ?? -1,
        stdout: new Uint8Array(Buffer.concat(chunks, Math.min(size, input.maxStdout))),
        stderr,
      });
      resume(Effect.succeed(settled!));
    });
    return Effect.sync(() => {
      clearTimeout(timer);
      child.kill("SIGKILL");
    });
  });

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
  const extension = name.endsWith(".xlsx") ? "xlsx" : name.endsWith(".csv") ? "csv" : "pdf";
  return {
    name,
    extension,
    mimeType:
      extension === "xlsx"
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : extension === "csv"
          ? "text/csv"
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

      /** Every file checked as the return path checks a worker's: type by its bytes. */
      const checked = Effect.fn("KinDocRenderer.check")(function* (files: ReadonlyArray<Taken>) {
        for (const file of files) {
          const problem = yield* Effect.promise(() => typeMismatch(file.extension, file.bytes));
          if (problem !== undefined) return failed(`${file.name}: ${problem}`);
        }
        return { _tag: "made", files } satisfies Rendered;
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
              yield* fs.writeFileString(path.join(root, "inputs.json"), yield* encodeJson(data));
              const made: Array<Taken> = [];
              for (const output of request.recipe.outputs) {
                const command = yield* scopes.wrap({
                  command: binary,
                  args: typstArgs({
                    root,
                    output,
                    creationTimestamp: Math.floor(Date.parse(`${request.day}T00:00:00Z`) / 1000),
                  }),
                  name: "kin-render",
                  env: typstEnv(),
                  properties: [`MemoryMax=${limits.memory}`, "MemorySwapMax=0", "TasksMax=64"],
                });
                const run = yield* runCapped({
                  command: command.command,
                  args: command.args,
                  env: typstEnv(),
                  cwd: root,
                  timeoutMs: limits.timeoutMs,
                  maxStdout: limits.pdfBytes,
                });
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
                    if (run.code !== 0)
                      return failed(
                        /package not found|@preview\//.test(run.stderr)
                          ? `${output}: the template imports a package, and Kin renders with no packages. ${plainError(run.stderr, root)}`
                          : `${output}: ${plainError(run.stderr, root)}`,
                      );
                    made.push(taken(output, run.stdout));
                }
              }
              return yield* checked(made);
            }),
          (scratch) => fs.remove(scratch, { recursive: true, force: true }).pipe(Effect.ignore),
        );
      });

      const render: KinDocRenderer["Service"]["render"] = Effect.fn("KinDocRenderer.render")(
        function* (request) {
          if (request.recipe.kind === "table") {
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
