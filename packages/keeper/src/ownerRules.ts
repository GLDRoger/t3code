import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/** Canonical project file. Injected into every brief so the rules survive compaction. */
export const PROJECT_OWNER_RULES_PATH = ".kin/owner-rules.md";
export const GLOBAL_OWNER_RULES_FILE = "owner-rules.md";

/**
 * Read when the canonical file is absent. `OWNER-RULES.md` is the design's
 * earlier casing. `OWNER-AUTHORIZATION.md` and `LEDGER.md` are the files it replaces.
 */
export const LEGACY_PROJECT_OWNER_RULES = [
  ".kin/OWNER-RULES.md",
  ".kin/OWNER-AUTHORIZATION.md",
  ".kin/LEDGER.md",
  "OWNER-AUTHORIZATION.md",
  "LEDGER.md",
] as const;

export const LEGACY_GLOBAL_OWNER_RULES = ["OWNER-RULES.md"] as const;

export const OWNER_RULES_STUB = `# Owner rules

Rules in this file are injected into every agent brief, including after context compaction.
`;

export interface LoadedOwnerRules {
  readonly projectText: string;
  readonly projectPath: string | null;
  readonly globalText: string;
  readonly globalPath: string | null;
  /** Set when the text came from a legacy file because the canonical one was absent. */
  readonly importedFrom: readonly string[];
}

const readIfPresent = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(filePath))) return Option.none<string>();
    return Option.some(yield* fs.readFileString(filePath));
  });

const firstPresent = (paths: readonly string[]) =>
  Effect.gen(function* () {
    for (const filePath of paths) {
      const text = yield* readIfPresent(filePath);
      if (Option.isSome(text)) return Option.some({ path: filePath, text: text.value });
    }
    return Option.none<{ readonly path: string; readonly text: string }>();
  });

/**
 * Project rules win as their own section. Global rules are added after them.
 * A missing canonical file falls through to the legacy names without moving them.
 */
export const loadOwnerRules = Effect.fn("OwnerRules.loadOwnerRules")(function* (input: {
  readonly projectRoot: string;
  readonly kinHome?: string;
}) {
  const path = yield* Path.Path;
  const importedFrom: string[] = [];
  const projectCandidates = [
    path.join(input.projectRoot, PROJECT_OWNER_RULES_PATH),
    ...LEGACY_PROJECT_OWNER_RULES.map((relative) => path.join(input.projectRoot, relative)),
  ];
  const project = yield* firstPresent(projectCandidates);
  let projectText = "";
  let projectPath: string | null = null;
  if (Option.isSome(project)) {
    projectText = project.value.text;
    projectPath = project.value.path;
    const canonical = projectCandidates[0];
    if (canonical !== undefined && project.value.path !== canonical) {
      importedFrom.push(path.relative(input.projectRoot, project.value.path));
    }
  }

  let globalText = "";
  let globalPath: string | null = null;
  const kinHome = input.kinHome;
  if (kinHome !== undefined) {
    const globalCandidates = [
      path.join(kinHome, GLOBAL_OWNER_RULES_FILE),
      ...LEGACY_GLOBAL_OWNER_RULES.map((file) => path.join(kinHome, file)),
    ];
    const global = yield* firstPresent(globalCandidates);
    if (Option.isSome(global)) {
      globalText = global.value.text;
      globalPath = global.value.path;
      const canonical = globalCandidates[0];
      if (canonical !== undefined && global.value.path !== canonical) {
        importedFrom.push(global.value.path);
      }
    }
  }

  return {
    projectText,
    projectPath,
    globalText,
    globalPath,
    importedFrom,
  } satisfies LoadedOwnerRules;
});

/** Stable brief section. Empty sides are omitted. The file text is not rewritten. */
export const renderOwnerRules = (loaded: {
  readonly projectText: string;
  readonly globalText: string;
}): string => {
  const parts: string[] = [];
  const project = loaded.projectText.trim();
  const global = loaded.globalText.trim();
  if (project.length > 0) parts.push(`### Project\n\n${project}`);
  if (global.length > 0) parts.push(`### Global\n\n${global}`);
  if (parts.length === 0) return "";
  return `## Owner rules\n\n${parts.join("\n\n")}\n`;
};

export const hashOwnerRules = Effect.fn("OwnerRules.hashOwnerRules")(function* (text: string) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(text));
  return Hex.encode(digest);
});
