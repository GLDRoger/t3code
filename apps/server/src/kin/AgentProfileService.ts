import {
  KinError,
  type KinAgentProfile,
  type KinInlineProfile,
  type KinProfileSource,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { defaultKinProfile, DEFAULT_KIN_PROFILES } from "./defaults.ts";
import {
  parseProfileDocument,
  profileFromInline,
  serializeProfileDocument,
} from "./profileDocument.ts";

const fail = (detail: string) => new KinError({ detail });
const isKinError = Schema.is(KinError);

const asKinError = (cause: unknown, detail: string) =>
  isKinError(cause) ? cause : fail(cause instanceof Error ? `${detail}: ${cause.message}` : detail);

export class AgentProfileService extends Context.Service<
  AgentProfileService,
  {
    readonly list: (input: {
      readonly projectRoot?: string | undefined;
    }) => Effect.Effect<ReadonlyArray<KinAgentProfile>, KinError>;
    readonly readSource: (input: {
      readonly name: string;
      readonly projectRoot?: string | undefined;
    }) => Effect.Effect<{ readonly profile: KinAgentProfile; readonly text: string }, KinError>;
    readonly writeSource: (input: {
      readonly scope: "project" | "user";
      readonly text: string;
      readonly projectRoot?: string | undefined;
    }) => Effect.Effect<KinAgentProfile, KinError>;
    readonly resolve: (input: {
      readonly name: string;
      readonly projectRoot?: string | undefined;
    }) => Effect.Effect<KinAgentProfile, KinError>;
    readonly saveAdhoc: (input: {
      readonly inline: KinInlineProfile;
      readonly projectRoot?: string | undefined;
    }) => Effect.Effect<KinAgentProfile, KinError>;
    /** Emits after a Kin write, and when a watched agents directory changes. */
    readonly changes: (projectRoot?: string) => Stream.Stream<string, KinError>;
  }
>()("t3/kin/AgentProfileService") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const published = yield* PubSub.unbounded<string>();
  const homeDirectoryValue = yield* HostProcess.HomeDirectory;
  const homeDirectory = () => Effect.succeed(homeDirectoryValue);

  const agentsDirectory = (root: string) => path.join(root, ".kin", "agents");
  const adhocDirectory = (root: string) => path.join(root, ".kin", "agents", "_adhoc");

  const exists = (target: string) =>
    fs
      .exists(target)
      .pipe(Effect.mapError((cause) => asKinError(cause, `Could not read ${target}`)));

  const readProfiles = Effect.fn("AgentProfileService.readProfiles")(function* (
    directory: string,
    source: KinProfileSource,
  ) {
    if (!(yield* exists(directory))) return [];
    const names = yield* fs
      .readDirectory(directory)
      .pipe(Effect.mapError((cause) => asKinError(cause, `Could not read ${directory}`)));
    const profiles: Array<KinAgentProfile> = [];
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const filePath = path.join(directory, name);
      const info = yield* fs.stat(filePath).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File") continue;
      const text = yield* fs
        .readFileString(filePath)
        .pipe(Effect.mapError((cause) => asKinError(cause, `Could not read ${filePath}`)));
      let parsed: ReturnType<typeof parseProfileDocument>;
      try {
        parsed = parseProfileDocument(text, source, filePath);
      } catch (cause) {
        return yield* fail(asKinError(cause, filePath).message);
      }
      const expected = name.slice(0, -".md".length);
      if (parsed.profile.name !== expected) {
        return yield* fail(
          `${filePath} is named ${expected}, but its frontmatter name is ${parsed.profile.name}.`,
        );
      }
      profiles.push(parsed.profile);
    }
    return profiles;
  });

  const list = Effect.fn("AgentProfileService.list")(function* (input: {
    readonly projectRoot?: string | undefined;
  }) {
    const home = yield* homeDirectory();
    const layers: Array<readonly [string, KinProfileSource]> = [[home, "user"]];
    if (input.projectRoot !== undefined) layers.push([input.projectRoot, "project"]);
    const byName = new Map<string, KinAgentProfile>(
      DEFAULT_KIN_PROFILES.map((profile) => [profile.name, profile]),
    );
    const adhoc: Array<KinAgentProfile> = [];
    for (const [root, source] of layers) {
      for (const profile of yield* readProfiles(agentsDirectory(root), source)) {
        byName.set(profile.name, profile);
      }
      adhoc.push(...(yield* readProfiles(adhocDirectory(root), "adhoc")));
    }
    return [...byName.values(), ...adhoc].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  });

  const resolve = Effect.fn("AgentProfileService.resolve")(function* (input: {
    readonly name: string;
    readonly projectRoot?: string | undefined;
  }) {
    const profiles = yield* list({ projectRoot: input.projectRoot });
    const found = profiles.find((profile) => profile.name === input.name);
    if (found !== undefined) return found;
    const shipped = defaultKinProfile(input.name);
    if (shipped !== undefined) return shipped;
    return yield* fail(`No agent profile named ${input.name}.`);
  });

  const readSource = Effect.fn("AgentProfileService.readSource")(function* (input: {
    readonly name: string;
    readonly projectRoot?: string | undefined;
  }) {
    const profile = yield* resolve(input);
    return { profile, text: serializeProfileDocument(profile) };
  });

  const writeFile = (filePath: string, text: string) =>
    fs.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(filePath, text)),
      Effect.mapError((cause) => asKinError(cause, `Could not write ${filePath}`)),
    );

  const writeSource = Effect.fn("AgentProfileService.writeSource")(function* (input: {
    readonly scope: "project" | "user";
    readonly text: string;
    readonly projectRoot?: string | undefined;
  }) {
    if (input.scope === "project" && input.projectRoot === undefined) {
      return yield* fail("Choose a project before saving a project profile.");
    }
    const root =
      input.scope === "project" && input.projectRoot !== undefined
        ? input.projectRoot
        : yield* homeDirectory();
    let parsed: ReturnType<typeof parseProfileDocument>;
    try {
      parsed = parseProfileDocument(input.text, input.scope);
    } catch (cause) {
      return yield* fail(asKinError(cause, "Profile").message);
    }
    const filePath = path.join(agentsDirectory(root), `${parsed.profile.name}.md`);
    const text = serializeProfileDocument(parsed.profile);
    yield* writeFile(filePath, text);
    yield* PubSub.publish(published, parsed.profile.name);
    return { ...parsed.profile, source: input.scope, path: filePath };
  });

  const saveAdhoc = Effect.fn("AgentProfileService.saveAdhoc")(function* (input: {
    readonly inline: KinInlineProfile;
    readonly projectRoot?: string | undefined;
  }) {
    let built: ReturnType<typeof profileFromInline>;
    try {
      built = profileFromInline(input.inline);
    } catch (cause) {
      return yield* fail(asKinError(cause, "Inline profile").message);
    }
    const root = input.projectRoot ?? (yield* homeDirectory());
    const filePath = path.join(adhocDirectory(root), `${built.fileName}.md`);
    const text = serializeProfileDocument(built.profile);
    if (!(yield* exists(filePath))) {
      yield* writeFile(filePath, text);
      yield* PubSub.publish(published, built.profile.name);
    }
    return { ...built.profile, path: filePath };
  });

  const changes = (projectRoot?: string) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before the directories exist so a write that follows the
        // directory's appearance is not dropped.
        const subscription = yield* PubSub.subscribe(published);
        const home = yield* homeDirectory();
        const directories = [agentsDirectory(home), adhocDirectory(home)];
        if (projectRoot !== undefined) {
          directories.push(agentsDirectory(projectRoot), adhocDirectory(projectRoot));
        }
        yield* Effect.forEach(directories, (directory) =>
          fs.makeDirectory(directory, { recursive: true }).pipe(Effect.ignore),
        );
        const watched = directories.map((directory) =>
          fs.watch(directory).pipe(
            Stream.map(() => directory),
            Stream.catchCause(() => Stream.empty),
          ),
        );
        return Stream.merge(
          Stream.fromSubscription(subscription),
          Stream.mergeAll(watched, { concurrency: "unbounded" }),
        );
      }),
    );

  return AgentProfileService.of({ list, readSource, writeSource, resolve, saveAdhoc, changes });
});

export const layer = Layer.effect(AgentProfileService, make);
