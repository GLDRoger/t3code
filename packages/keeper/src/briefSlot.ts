import type * as DateTime from "effect/DateTime";

import {
  CHRONICLE_MAX_AGE_HOURS,
  CHRONICLE_MAX_BYTES,
  readChronicle,
  renderVerbatimWills,
  type KeeperEntry,
} from "./chronicle.ts";
import { noteToEntry, renderNotesBoard, type Note } from "./notesBoard.ts";

/**
 * Keeper's brief section. Everything before `## Task` (owner rules, house map,
 * chronicle) stays stable between keeper passes; newer wills and live notes
 * follow it, then the task. No current time is written, so the prefix caches.
 */
export interface BriefSlotInput {
  readonly house: string;
  readonly ownerRules: string;
  readonly houseMap: string;
  readonly chronicleText: string;
  readonly now: DateTime.DateTime;
  readonly entries: readonly KeeperEntry[];
  readonly notes: readonly Note[];
  readonly task: string;
  readonly maxAgeHours?: number;
  readonly maxBytes?: number;
}

const startHere = (house: string): string =>
  [
    "## Start here",
    "",
    "Read these before the task, in order:",
    "",
    "- `AGENTS.md` (project rules; `CLAUDE.md` is `@AGENTS.md`)",
    `- \`docs/agent-maps/${house}.md\``,
    `- the notes board for \`${house}\` (\`lineage_read\`)`,
    "- `.kin/owner-rules.md`",
    "",
  ].join("\n");

export const renderBriefSlot = (input: BriefSlotInput): string => {
  const parts = [startHere(input.house)];
  const rules = input.ownerRules.trim();
  if (rules.length > 0) {
    parts.push(rules.startsWith("## Owner rules") ? `${rules}\n` : `## Owner rules\n\n${rules}\n`);
  }
  const houseMap = input.houseMap.trim();
  if (houseMap.length > 0) parts.push(`## House map\n\n${houseMap}\n`);

  const verdict = readChronicle(input.chronicleText, input.now, {
    maxAgeHours: input.maxAgeHours ?? CHRONICLE_MAX_AGE_HOURS,
    maxBytes: input.maxBytes ?? CHRONICLE_MAX_BYTES,
  });
  if (verdict.status === "fresh") {
    parts.push(
      `## Chronicle\n\n${verdict.text.endsWith("\n") ? verdict.text : `${verdict.text}\n`}`,
    );
    const wills = renderVerbatimWills(input.entries, verdict.asOf);
    if (wills.length > 0) parts.push(wills);
  } else {
    parts.push(`## Chronicle\n\nNo fresh chronicle (${verdict.reason}).\n`);
  }

  const notes = renderNotesBoard(input.notes);
  if (notes.length > 0) parts.push(notes);
  parts.push(`## Task\n\n${input.task}`);
  return parts.join("\n");
};

/** Notes the keeper can summarize, in board order. */
export const noteEntries = (notes: readonly Note[]): readonly KeeperEntry[] =>
  notes.map(noteToEntry);
