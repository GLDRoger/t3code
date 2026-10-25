import {
  KinError,
  type KinAgentProfile,
  type KinInlineProfile,
  type KinMdFile,
  type KinPromptPreview,
  type KinPromptProviderKind,
} from "@t3tools/contracts";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as AgentProfileService from "./AgentProfileService.ts";
import { KinBriefProvider, layerEmptyBrief, type KinBriefInput } from "./brief.ts";
import { KIN_BASE_PROMPT } from "./defaults.ts";
import { isCliLoadedMarkdown } from "./nativeMd.ts";
import { composePrompt } from "./PromptComposer.ts";

const fail = (detail: string) => new KinError({ detail });
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const MD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.md$/;

const BindingsFile = Schema.Struct({
  bindings: Schema.Array(
    Schema.Struct({
      threadId: Schema.String,
      profileName: Schema.String,
      projectRoot: Schema.optional(Schema.String),
      houseId: Schema.optional(Schema.String),
      parentThreadId: Schema.optional(Schema.String),
    }),
  ),
});

const decodeBindings = Schema.decodeUnknownEffect(BindingsFile);

const HARNESS: Record<KinPromptProviderKind, string> = {
  codex: "Codex",
  claudeAgent: "Claude Code",
  pi: "Pi",
  grok: "Grok",
  openrouter: "OpenRouter",
  other: "Kin",
};

/** Global model and budget preferences, written by the user or by an agent the user asked. */
const KIN_MODELS_MD = "models.md";

export class KinService extends Context.Service<
  KinService,
  {
    readonly listProfiles: AgentProfileService.AgentProfileService["Service"]["list"];
    readonly readProfile: AgentProfileService.AgentProfileService["Service"]["readSource"];
    readonly writeProfile: AgentProfileService.AgentProfileService["Service"]["writeSource"];
    readonly getBasePrompt: () => Effect.Effect<string, KinError>;
    readonly setBasePrompt: (text: string) => Effect.Effect<string, KinError>;
    readonly listMd: (projectRoot?: string) => Effect.Effect<ReadonlyArray<KinMdFile>, KinError>;
    readonly readMd: (input: {
      readonly scope: "project" | "user";
      readonly name: string;
      readonly projectRoot?: string | undefined;
    }) => Effect.Effect<string, KinError>;
    readonly writeMd: (input: {
      readonly scope: "project" | "user";
      readonly name: string;
      readonly text: string;
      readonly projectRoot?: string | undefined;
    }) => Effect.Effect<KinMdFile, KinError>;
    readonly deleteMd: (input: {
      readonly scope: "project" | "user";
      readonly name: string;
      readonly projectRoot?: string | undefined;
    }) => Effect.Effect<void, KinError>;
    readonly preview: (input: {
      readonly profile: string;
      readonly provider: KinPromptProviderKind;
      readonly projectRoot?: string | undefined;
      readonly houseId?: string | undefined;
      readonly brief?: string | undefined;
    }) => Effect.Effect<KinPromptPreview, KinError>;
    readonly resolveDelegationProfile: (input: {
      readonly profile: string | KinInlineProfile;
      readonly projectRoot?: string | undefined;
    }) => Effect.Effect<KinAgentProfile, KinError>;
    readonly bindThread: (input: {
      readonly threadId: string;
      readonly profileName: string;
      readonly projectRoot?: string | undefined;
      readonly houseId?: string | undefined;
      readonly parentThreadId?: string | undefined;
    }) => Effect.Effect<void, KinError>;
    readonly promptForTurn: (input: {
      readonly threadId: string;
      readonly projectRoot?: string | undefined;
      readonly provider: KinPromptProviderKind;
    }) => Effect.Effect<string | undefined, KinError>;
  }
>()("t3/kin/KinService") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const profiles = yield* AgentProfileService.AgentProfileService;
  const briefs = yield* KinBriefProvider;

  const homeDirectoryValue = yield* HostProcess.HomeDirectory;
  const home = () => Effect.succeed(homeDirectoryValue);
  const kinHome = Effect.fnUntraced(function* () {
    return path.join(yield* home(), ".kin");
  });

  const readOptional = (filePath: string) =>
    fs.readFileString(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)));

  const writeText = (filePath: string, text: string) =>
    fs.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(filePath, text.endsWith("\n") ? text : `${text}\n`)),
      Effect.mapError((cause) => fail(`Could not write ${filePath}: ${cause.message}`)),
    );

  const exists = (target: string) =>
    fs
      .exists(target)
      .pipe(Effect.mapError((cause) => fail(`Could not read ${target}: ${cause.message}`)));

  const readJson = <A>(
    filePath: string,
    decode: (value: unknown) => Effect.Effect<A, KinError>,
    fallback: A,
  ) =>
    readOptional(filePath).pipe(
      Effect.flatMap((text) => {
        if (text === undefined || text.trim().length === 0) return Effect.succeed(fallback);
        return decodeJson(text).pipe(
          Effect.mapError((cause) => fail(`Could not parse ${filePath}: ${cause.message}`)),
          Effect.flatMap(decode),
        );
      }),
    );

  const writeJson = (filePath: string, value: unknown) =>
    encodeJson(value).pipe(
      Effect.mapError((cause) => fail(`Could not encode ${filePath}: ${cause.message}`)),
      Effect.flatMap((text) => writeText(filePath, text)),
    );

  const getBasePrompt = Effect.fn("KinService.getBasePrompt")(function* () {
    const filePath = path.join(yield* kinHome(), "base-prompt.md");
    const text = yield* readOptional(filePath);
    return text === undefined || text.trim().length === 0 ? KIN_BASE_PROMPT : text.trim();
  });

  const setBasePrompt = Effect.fn("KinService.setBasePrompt")(function* (text: string) {
    const trimmed = text.trim();
    if (trimmed.length === 0) return yield* fail("The Kin base prompt cannot be empty.");
    yield* writeText(path.join(yield* kinHome(), "base-prompt.md"), trimmed);
    return trimmed;
  });

  const mdDirectory = Effect.fn("KinService.mdDirectory")(function* (input: {
    readonly scope: "project" | "user";
    readonly projectRoot?: string | undefined;
  }) {
    if (input.scope === "project") {
      if (input.projectRoot === undefined) {
        return yield* fail("Choose a project before editing its markdown files.");
      }
      return path.join(input.projectRoot, ".kin", "md");
    }
    return path.join(yield* home(), ".kin", "md");
  });

  const checkMdName = (name: string) =>
    MD_NAME.test(name)
      ? Effect.succeed(name)
      : fail(`Markdown file name must look like notes.md, not ${name}.`);

  const listMd = Effect.fn("KinService.listMd")(function* (projectRoot?: string) {
    const scopes: Array<{ readonly scope: "project" | "user"; readonly projectRoot?: string }> = [
      { scope: "user" },
    ];
    if (projectRoot !== undefined) scopes.unshift({ scope: "project", projectRoot });
    const files: Array<KinMdFile> = [];
    for (const scope of scopes) {
      const directory = yield* mdDirectory(scope);
      if (!(yield* exists(directory))) continue;
      const names = yield* fs
        .readDirectory(directory)
        .pipe(Effect.mapError((cause) => fail(`Could not read ${directory}: ${cause.message}`)));
      for (const name of names) {
        if (!name.endsWith(".md")) continue;
        files.push({ scope: scope.scope, name, path: path.join(directory, name) });
      }
    }
    return files.sort((left, right) => left.name.localeCompare(right.name));
  });

  const readMd = Effect.fn("KinService.readMd")(function* (input: {
    readonly scope: "project" | "user";
    readonly name: string;
    readonly projectRoot?: string | undefined;
  }) {
    yield* checkMdName(input.name);
    const filePath = path.join(yield* mdDirectory(input), input.name);
    return yield* fs
      .readFileString(filePath)
      .pipe(Effect.mapError(() => fail(`No markdown file named ${input.name}.`)));
  });

  const writeMd = Effect.fn("KinService.writeMd")(function* (input: {
    readonly scope: "project" | "user";
    readonly name: string;
    readonly text: string;
    readonly projectRoot?: string | undefined;
  }) {
    yield* checkMdName(input.name);
    const filePath = path.join(yield* mdDirectory(input), input.name);
    yield* writeText(filePath, input.text);
    return { scope: input.scope, name: input.name, path: filePath };
  });

  const deleteMd = Effect.fn("KinService.deleteMd")(function* (input: {
    readonly scope: "project" | "user";
    readonly name: string;
    readonly projectRoot?: string | undefined;
  }) {
    yield* checkMdName(input.name);
    const filePath = path.join(yield* mdDirectory(input), input.name);
    yield* fs.remove(filePath).pipe(Effect.mapError(() => fail(`Could not delete ${input.name}.`)));
  });

  const loadUserMd = Effect.fn("KinService.loadUserMd")(function* (input: {
    readonly profile: KinAgentProfile;
    readonly provider: KinPromptProviderKind;
    readonly projectRoot?: string | undefined;
  }) {
    const homeDirectory = yield* home();
    const texts: Array<string> = [];
    for (const entry of input.profile.userMd) {
      const expanded = expandHomePath(entry, homeDirectory);
      const filePath = path.isAbsolute(expanded)
        ? expanded
        : path.resolve(input.projectRoot ?? homeDirectory, expanded);
      if (isCliLoadedMarkdown({ provider: input.provider, filePath, homeDirectory })) continue;
      const text = yield* fs
        .readFileString(filePath)
        .pipe(Effect.mapError(() => fail(`Profile ${input.profile.name} is missing ${entry}.`)));
      texts.push(text);
    }
    const models = yield* readOptional(path.join(yield* kinHome(), "md", KIN_MODELS_MD));
    if (models !== undefined && models.trim().length > 0) {
      texts.push(`## Model preferences (~/.kin/md/${KIN_MODELS_MD})\n\n${models.trim()}`);
    }
    return texts;
  });

  const composeFor = Effect.fn("KinService.composeFor")(function* (input: {
    readonly profile: KinAgentProfile;
    readonly provider: KinPromptProviderKind;
    readonly projectRoot?: string | undefined;
    readonly houseId?: string | undefined;
    readonly task?: string | undefined;
    readonly threadId?: string | undefined;
    readonly brief?: string | undefined;
  }) {
    const briefInput: KinBriefInput = {
      houseId: input.houseId,
      profileName: input.profile.name,
      projectRoot: input.projectRoot,
      task: input.task,
      threadId: input.threadId,
    };
    const stableHouseContext = yield* briefs.stableContext(briefInput);
    const providedBrief = input.brief ?? (yield* briefs.brief(briefInput));
    const userMdTexts = yield* loadUserMd(input);
    const runtimeInstructions = [
      buildRuntimeInstructions({ harness: HARNESS[input.provider] }),
      T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
    ].join("\n\n");
    return composePrompt({
      runtimeInstructions,
      kinBasePrompt: yield* getBasePrompt(),
      profileBody: input.profile.body,
      userMdTexts,
      stableHouseContext,
      brief: providedBrief,
    });
  });

  const preview = Effect.fn("KinService.preview")(function* (input: {
    readonly profile: string;
    readonly provider: KinPromptProviderKind;
    readonly projectRoot?: string | undefined;
    readonly houseId?: string | undefined;
    readonly brief?: string | undefined;
  }) {
    const profile = yield* profiles.resolve({
      name: input.profile,
      projectRoot: input.projectRoot,
    });
    return yield* composeFor({
      profile,
      provider: input.provider,
      projectRoot: input.projectRoot,
      houseId: input.houseId,
      brief: input.brief,
      task: input.brief,
    });
  });

  const bindingsPath = Effect.fnUntraced(function* () {
    return path.join(yield* kinHome(), "thread-bindings.json");
  });

  const readBindings = Effect.fn("KinService.readBindings")(function* () {
    return yield* readJson(
      yield* bindingsPath(),
      (value) => decodeBindings(value).pipe(Effect.mapError((cause) => fail(cause.message))),
      { bindings: [] },
    );
  });

  const bindThread = Effect.fn("KinService.bindThread")(function* (input: {
    readonly threadId: string;
    readonly profileName: string;
    readonly projectRoot?: string | undefined;
    readonly houseId?: string | undefined;
    readonly parentThreadId?: string | undefined;
  }) {
    const current = yield* readBindings();
    const next = [
      ...current.bindings.filter((binding) => binding.threadId !== input.threadId),
      input,
    ];
    yield* writeJson(yield* bindingsPath(), { bindings: next });
  });

  const resolveDelegationProfile = Effect.fn("KinService.resolveDelegationProfile")(
    function* (input: {
      readonly profile: string | KinInlineProfile;
      readonly projectRoot?: string | undefined;
    }) {
      return typeof input.profile === "string"
        ? yield* profiles.resolve({ name: input.profile, projectRoot: input.projectRoot })
        : yield* profiles.saveAdhoc({ inline: input.profile, projectRoot: input.projectRoot });
    },
  );

  const promptForTurn = Effect.fn("KinService.promptForTurn")(function* (input: {
    readonly threadId: string;
    readonly projectRoot?: string | undefined;
    readonly provider: KinPromptProviderKind;
  }) {
    const bindings = yield* readBindings();
    const binding = bindings.bindings.find((entry) => entry.threadId === input.threadId);
    const profile = yield* profiles.resolve({
      name: binding?.profileName ?? "main",
      projectRoot: binding?.projectRoot ?? input.projectRoot,
    });
    const composed = yield* composeFor({
      profile,
      provider: input.provider,
      projectRoot: binding?.projectRoot ?? input.projectRoot,
      houseId: binding?.houseId,
      threadId: input.threadId,
    });
    return composed.suffix.length === 0 ? undefined : composed.suffix;
  });

  return KinService.of({
    listProfiles: profiles.list,
    readProfile: profiles.readSource,
    writeProfile: profiles.writeSource,
    getBasePrompt,
    setBasePrompt,
    listMd,
    readMd,
    writeMd,
    deleteMd,
    preview,
    resolveDelegationProfile,
    bindThread,
    promptForTurn,
  });
});

/** Profiles only. Callers provide `KinBriefProvider` (the empty stub, until lineage replaces it). */
export const layer = Layer.effect(KinService, make).pipe(Layer.provide(AgentProfileService.layer));

export const layerLive = layer.pipe(Layer.provide(layerEmptyBrief));

/**
 * Reads the turn suffix when Kin is in the server context. Missing Kin, or a
 * profile that cannot be loaded, leaves the provider prompt unchanged.
 */
export const readKinTurnPrompt = Effect.fn("KinService.readKinTurnPrompt")(function* (input: {
  readonly threadId: string;
  readonly projectRoot?: string | undefined;
  readonly provider: KinPromptProviderKind;
}) {
  const context = yield* Effect.context<never>();
  const kin = Context.getOption(context, KinService);
  if (Option.isNone(kin)) return undefined;
  return yield* kin.value.promptForTurn(input).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("kin.prompt-for-turn-failed", { detail: error.message }),
    ),
    Effect.orElseSucceed(() => undefined),
  );
});
