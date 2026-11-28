import type { KinOrgId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import {
  QUOTE_MISSING,
  QUOTE_NO_WORDS,
  QUOTE_NOT_SAID,
  QUOTE_TOO_LONG,
  QUOTE_TOO_SHORT,
} from "./keeping.ts";

export const MEMORY_WRITE_FAILURE_WORDS = {
  checkout:
    "Kin couldn't open the copy of memory on this server. Ask whoever looks after Kin to check it.",
  setup:
    "Kin couldn't save memory changes because memory isn't set up to accept them here. Ask whoever looks after Kin to check it.",
  purge: "Kin couldn't save memory changes while older information was being removed from memory.",
  changed: "Kin couldn't save a memory update because memory changed while Kin was working on it.",
  remote:
    "Kin couldn't send the memory changes to the online copy. What is already saved on this server goes up with the next memory change; if this stays, ask whoever looks after Kin to check the memory repository's access.",
  review:
    "GitHub didn't accept Kin's memory changes. They are kept on this server; ask whoever looks after Kin to check the memory repository's rules on GitHub.",
  "online-conflict":
    "Kin couldn't combine the memory changes made on GitHub with the ones saved here, so both are kept apart. Ask whoever looks after Kin to settle the two in the memory repository.",
  "review-needed":
    "GitHub requires a review before it accepts Kin's memory changes. Check the memory repository's review rules on GitHub; Kin tries again once the rules change or the server restarts.",
  secret: "Kin didn't save a memory update because it may contain a password or key.",
  scanner:
    "Kin didn't save a memory update because the check for passwords and keys couldn't finish, and it saves nothing unchecked. If this stays, ask whoever looks after Kin to check it.",
  note: "Kin couldn't save a memory update because a memory note couldn't be read.",
  journal: "Kin couldn't save a journal entry because its date or time zone couldn't be read.",
  storage:
    "Kin couldn't read or write what a memory update needed. Ask whoever looks after Kin to check it.",
  refused: "Kin couldn't save a memory update because the changes didn't meet memory's rules.",
  context: "Kin couldn't tell which turn the memory update belonged to.",
  "file-name":
    "Kin couldn't save a memory update because its file name is reserved or contains unsupported characters.",
  "index-folder": "Kin found a folder for the memory index where a file should be.",
  hidden: "Kin couldn't save a memory update in a hidden file or folder.",
  "file-shape": "Kin couldn't save the file in a folder that only holds notes and journal entries.",
  "unsafe-location": "Kin couldn't save a memory update because it pointed to an unsafe location.",
  "journal-method": "Kin used the wrong way to add a journal entry.",
  "source-outside-turn":
    "Kin couldn't save a note because its source was outside the material for this turn.",
  "wrong-folder": "Kin tried to save a memory note in the wrong folder for its type.",
  "unreadable-existing-note":
    "Kin couldn't update a note because the existing note couldn't be read.",
  "note-type-changed": "Kin couldn't change the type of a note already saved.",
  "share-owner-only":
    "Kin kept a memory note private because only the owner can share it with the team.",
  "different-source-or-type":
    "Kin couldn't replace an older note because the new note needs the same source and type.",
  "unrelated-notes":
    "Kin couldn't save a note that referred to unrelated notes as covering the same subject.",
  "different-item": "Kin couldn't save a memory note in another note's place.",
  "quote-missing":
    "Kin couldn't save a note about what someone said because it needed an exact quote.",
  "quote-too-long": "Kin couldn't save a note because its quote was too long.",
  "quote-no-words": "Kin couldn't save a quote because its source had no words to quote.",
  "quote-not-said": "Kin couldn't save a note because its quote wasn't in the source.",
  "quote-too-short":
    "Kin couldn't save a note because its quote was too short to show where it came from.",
  "retry-different":
    "Kin couldn't save a memory update again because the retry differed from the original.",
  "dream-location": "Kin couldn't use the temporary location for the nightly update.",
  "index-generated":
    "Kin builds the memory index automatically, so the nightly update couldn't write it directly.",
  "undo-target": "Kin couldn't identify the change to undo in memory.",
  "purged-history":
    "Kin dropped a pending memory update because memory history was rewritten. If it mattered, tell the agent again.",
  "off-github":
    "Kin couldn't open a review for the memory update because the online copy isn't on GitHub.",
  "dream-base":
    "Kin couldn't finish the nightly memory update because the earlier version it read is gone.",
  "dream-remote":
    "Kin couldn't send the nightly memory update to the online copy. Nothing Kin already remembered was lost, and tonight it reads the same days again; if this stays, ask whoever looks after Kin to check the memory repository's access.",
  "dream-changed":
    "Kin couldn't save the nightly memory update because memory changed while it ran.",
  "missing-note": "Kin couldn't find the memory note it needed to update.",
  "note-conflict": "Kin couldn't save a memory update because it conflicted with an existing note.",
  "unknown-source-person": "Kin couldn't save a note because it couldn't identify who said it.",
  "missing-history":
    "Kin couldn't save an update because part of memory is missing from this server. Ask whoever looks after Kin to check it.",
  "unexpected-online-copy":
    "Kin couldn't open memory for an update because it got an unexpected result from the online copy. Ask whoever looks after Kin to check it.",
} as const;

export type MemoryWriteFailure = keyof typeof MEMORY_WRITE_FAILURE_WORDS;

const byTag: Readonly<Record<string, MemoryWriteFailure>> = {
  MemoryCheckoutInvalid: "checkout",
  MemoryConfigError: "setup",
  MemorySyncConflict: "changed",
  MemorySecretBlocked: "secret",
  KinSecretScanError: "scanner",
  MemoryItemError: "note",
  MemoryNotFound: "missing-note",
  MemoryJournalError: "journal",
  MemoryWriteRejected: "refused",
  MemoryConflict: "note-conflict",
  MemoryError: "storage",
  PersistenceSqlError: "storage",
  MemoryQueryDecodeError: "storage",
};

const rejectionReasons: Readonly<Record<string, MemoryWriteFailure>> = {
  "Invalid server context": "context",
  "Invalid writer authority": "context",
  "Unknown source person": "unknown-source-person",
  "Disallowed memory path: names are ASCII letters, digits, . _ -, and agent config or Windows device names are reserved":
    "file-name",
  "INDEX.md must be a file": "index-folder",
  "Hidden paths are not allowed in Kin's unowned folders": "hidden",
  "Kin's unowned folders only hold item and journal files": "file-shape",
  "Symlink or invalid ancestor": "unsafe-location",
  "Use appendJournal for journal additions": "journal-method",
  "Source is not in the current batch": "source-outside-turn",
  "Kind does not match path": "wrong-folder",
  "Cannot overwrite malformed recorded item": "unreadable-existing-note",
  "Cannot change recorded item kind": "note-type-changed",
  "Only the owner lets the team know an item": "share-owner-only",
  "Supersession requires the same source and kind": "different-source-or-type",
  "besides names only open items of the same kind that share a link with it": "unrelated-notes",
  "Cannot replace a different item": "different-item",
  [QUOTE_MISSING]: "quote-missing",
  [QUOTE_TOO_LONG]: "quote-too-long",
  [QUOTE_NO_WORDS]: "quote-no-words",
  [QUOTE_NOT_SAID]: "quote-not-said",
  [QUOTE_TOO_SHORT]: "quote-too-short",
  "Different wake-up retry": "retry-different",
  "Invalid dream branch": "dream-location",
  "INDEX.md is built by code": "index-generated",
  "Invalid undo target": "undo-target",
};

const syncReason = (reason: unknown): MemoryWriteFailure => {
  switch (reason) {
    case "Memory history was rewritten during this wake-up; its staged changes were dropped":
      return "purged-history";
    case "A memory purge is in flight; old history must not be pushed":
      return "purge";
    case "The memory repo is not on GitHub, so Kin cannot open its PR":
      return "off-github";
    case "Memory writes to the default branch are refused":
    case "Memory writes to the default branch land through a pull request, which isn't set up here (TRIG-15); this one was not committed":
      return "setup";
    case "Dream branch push rejected":
      return "dream-remote";
    case "Push rejected; retry or reconcile remote":
      return "remote";
    case "The dream's base is no longer in memory history":
      return "dream-base";
    case "Memory changed since the dream read it, so it did not land":
      return "dream-changed";
    default:
      return "changed";
  }
};

const writeError = (error: unknown) => ({
  tag:
    typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
      ? error._tag
      : undefined,
  reason:
    typeof error === "object" && error !== null && "reason" in error ? error.reason : undefined,
});

const isSilent = ({ tag, reason }: ReturnType<typeof writeError>) =>
  tag === "MemoryDuplicateId" ||
  (tag === "MemoryWriteRejected" && reason === "Wake-up is not running") ||
  (tag === "KinChatError" && reason === "not_allowed");

export const memoryWriteFailure = (error: unknown): MemoryWriteFailure | undefined => {
  const details = writeError(error);
  if (isSilent(details)) return;
  const { tag, reason } = details;
  if (tag === "MemorySyncConflict") return syncReason(reason);
  if (tag === "MemoryCheckoutInvalid") {
    if (reason === "Missing recorded branch") return "missing-history";
    if (reason === "Invalid remote advertisement") return "unexpected-online-copy";
  }
  if (
    tag === "MemoryWriteRejected" &&
    typeof reason === "string" &&
    Object.hasOwn(rejectionReasons, reason)
  )
    return rejectionReasons[reason];
  if (tag !== undefined && Object.hasOwn(byTag, tag)) return byTag[tag];
};

const isMemoryWriteFailure = (kind: string): kind is MemoryWriteFailure =>
  Object.hasOwn(MEMORY_WRITE_FAILURE_WORDS, kind);

const FAILURE_PREFIX = "memory-write:";

export const saveMemoryWriteFailure = (failure: MemoryWriteFailure) =>
  `${FAILURE_PREFIX}${failure}`;

const legacyFailure = (failure: string) => {
  const [tag, ...reason] = failure.split(":");
  return { _tag: tag, reason: reason.join(":").trimStart() };
};

export const savedMemoryWriteFailure = (failure: string): MemoryWriteFailure | undefined => {
  const kind = failure.slice(FAILURE_PREFIX.length);
  if (failure.startsWith(FAILURE_PREFIX) && isMemoryWriteFailure(kind)) return kind;
  return memoryWriteFailure(legacyFailure(failure));
};

export const savedSilentMemoryWriteFailure = (failure: string) =>
  isSilent(writeError(legacyFailure(failure)));

export const MEMORY_WRITE_OPERATION_WORDS = {
  "stage-note": "Kin couldn't prepare a note from an agent's turn.",
  "stage-journal": "Kin couldn't prepare a journal entry from an agent's turn.",
  undo: "Kin couldn't undo a memory change.",
  sharing: "Kin couldn't change who can read a memory note.",
  forget: "Kin couldn't put away a memory note.",
  restore: "Kin couldn't bring back a memory note.",
  "wake-up": "Kin couldn't finish saving to memory what an agent's turn left.",
  "dream-cleanup": "Kin couldn't remove a temporary copy left by the nightly memory update.",
  "spent-notes": "Kin couldn't put away memory notes that are no longer current.",
  "retired-sharing": "Kin couldn't finish changing who can read retired memory notes.",
  "deleted-quotes": "Kin couldn't finish removing quotes of deleted messages from memory.",
  decision: "Kin couldn't save a decision to memory.",
  "online-copy": "Memory is saved on this server, but the online copy is behind.",
} as const;

export type MemoryWriteOperation = keyof typeof MEMORY_WRITE_OPERATION_WORDS;

// An agent's own memory_write gets these as its tool result and fixes or reports them itself.
const toldToCaller: ReadonlySet<MemoryWriteFailure> = new Set([
  ...Object.values(rejectionReasons),
  "refused",
  "secret",
  "note",
  "note-conflict",
  "missing-note",
  "journal",
]);
const callerOperations: ReadonlySet<MemoryWriteOperation> = new Set([
  "stage-note",
  "stage-journal",
]);

export type WriteEpisode = (
  orgId: KinOrgId,
  operation: MemoryWriteOperation,
  failure: MemoryWriteFailure | undefined,
  link?: string,
) => Effect.Effect<void>;

export const observeMemoryWrite = <A, E, R>(
  tell: WriteEpisode | undefined,
  orgId: KinOrgId,
  operation: MemoryWriteOperation,
  effect: Effect.Effect<A, E, R>,
) =>
  tell === undefined
    ? effect
    : effect.pipe(
        Effect.tap(() => tell(orgId, operation, undefined)),
        Effect.tapCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.void;
          const error = Cause.squash(cause);
          if (isSilent(writeError(error))) return Effect.void;
          const failure = memoryWriteFailure(error) ?? "storage";
          if (callerOperations.has(operation) && toldToCaller.has(failure)) return Effect.void;
          return tell(orgId, operation, failure);
        }),
      );
