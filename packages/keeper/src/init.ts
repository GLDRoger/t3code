import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { generateHouseMaps } from "./agentMap.ts";
import {
  LEGACY_PROJECT_OWNER_RULES,
  OWNER_RULES_STUB,
  PROJECT_OWNER_RULES_PATH,
} from "./ownerRules.ts";

/**
 * Lane 1 owns the `kin` binary (the upstream command is still `t3`).
 * `kin init` should call `initKinProject` and not grow a second initializer.
 */
export const KIN_CLI_NAME = "kin";
export const KIN_INIT_COMMAND = "init";
export const KIN_INIT_USAGE = "kin init";

/** One-line Claude import of the shared agent rules. */
export const CLAUDE_MD_IMPORT = "@AGENTS.md\n";

export const AGENTS_MD_STUB = `# Agent rules

Project rules for agents live in this file. \`CLAUDE.md\` imports it with \`@AGENTS.md\`.

Also read:

- \`docs/agent-maps/<house>.md\` for the house you are editing
- the notes board (\`lineage_read\`)
- \`.kin/owner-rules.md\`
`;

export interface KinInitResult {
  readonly created: readonly string[];
  readonly skipped: readonly string[];
  readonly imported: readonly string[];
  readonly houseMapsWritten: readonly string[];
  readonly claudeMd: "created" | "already-import" | "left-in-place";
}

const readOptional = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(filePath))) return null;
    return yield* fs.readFileString(filePath);
  });

const claudeImportSatisfied = (text: string): boolean =>
  text.replace(/\r\n/gu, "\n").trim() === "@AGENTS.md";

/**
 * Sets up the three context-layer files in a target repo.
 * Existing `AGENTS.md` and a non-import `CLAUDE.md` are left in place.
 * A legacy owner-rules file is copied into `.kin/owner-rules.md` when the
 * canonical file is missing. The legacy file is not deleted.
 */
export const initKinProject = Effect.fn("KinInit.initKinProject")(function* (input: {
  readonly projectRoot: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const created: string[] = [];
  const skipped: string[] = [];
  const imported: string[] = [];

  const agentsPath = path.join(input.projectRoot, "AGENTS.md");
  const agents = yield* readOptional(agentsPath);
  if (agents === null) {
    yield* fs.writeFileString(agentsPath, AGENTS_MD_STUB);
    created.push("AGENTS.md");
  } else {
    skipped.push("AGENTS.md");
  }

  const claudePath = path.join(input.projectRoot, "CLAUDE.md");
  const claude = yield* readOptional(claudePath);
  let claudeMd: KinInitResult["claudeMd"];
  if (claude === null) {
    yield* fs.writeFileString(claudePath, CLAUDE_MD_IMPORT);
    created.push("CLAUDE.md");
    claudeMd = "created";
  } else if (claudeImportSatisfied(claude)) {
    skipped.push("CLAUDE.md");
    claudeMd = "already-import";
  } else {
    skipped.push("CLAUDE.md");
    claudeMd = "left-in-place";
  }

  const rulesPath = path.join(input.projectRoot, PROJECT_OWNER_RULES_PATH);
  const rules = yield* readOptional(rulesPath);
  if (rules === null) {
    yield* fs.makeDirectory(path.dirname(rulesPath), { recursive: true });
    let body = OWNER_RULES_STUB;
    for (const relative of LEGACY_PROJECT_OWNER_RULES) {
      const legacyPath = path.join(input.projectRoot, relative);
      const legacy = yield* readOptional(legacyPath);
      if (legacy === null) continue;
      body = `# Owner rules\n\nImported from \`${relative}\`.\n\n${legacy.trim()}\n`;
      imported.push(relative);
      break;
    }
    yield* fs.writeFileString(rulesPath, body);
    created.push(PROJECT_OWNER_RULES_PATH);
  } else {
    skipped.push(PROJECT_OWNER_RULES_PATH);
  }

  const maps = yield* generateHouseMaps({ projectRoot: input.projectRoot });
  return {
    created,
    skipped,
    imported,
    houseMapsWritten: maps.written,
    claudeMd,
  } satisfies KinInitResult;
});
