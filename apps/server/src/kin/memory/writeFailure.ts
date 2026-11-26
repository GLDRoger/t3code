import type { KinOrgId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

export const MEMORY_WRITE_FAILURE_WORDS = {
  checkout: "Kin could not open the saved copy of memory. Ask whoever looks after Kin to check it.",
  setup: "Kin could not save changes because memory is not set up for writing.",
  purge: "Kin could not save changes while older information was being removed from memory.",
  changed: "Kin could not save a memory update because memory changed while Kin was working.",
  remote: "Kin could not send the memory changes to the online copy.",
  review: "GitHub did not accept the memory changes.",
  "online-conflict":
    "Kin could not combine the changes made on GitHub with the changes saved here.",
  "review-needed":
    "GitHub requires a review before accepting Kin's memory changes. Check the memory repository's review rules on GitHub. Kin tries again once the rules change or the server restarts.",
  secret: "Kin stopped a memory update because it may contain a password or key.",
  scanner: "Kin paused a memory update because the check for passwords and keys could not finish.",
  note: "Kin could not save a memory update because a note could not be read.",
  journal: "Kin could not save a journal entry because its date or time zone could not be read.",
  storage: "Kin could not read or write the information needed for a memory update.",
  refused:
    "Kin could not save a memory update because the proposed changes did not meet the rules for memory.",
} as const;

export type MemoryWriteFailure = keyof typeof MEMORY_WRITE_FAILURE_WORDS;

const byTag: Readonly<Record<string, MemoryWriteFailure>> = {
  MemoryCheckoutInvalid: "checkout",
  MemoryConfigError: "setup",
  MemorySyncConflict: "changed",
  MemorySecretBlocked: "secret",
  KinSecretScanError: "scanner",
  MemoryItemError: "note",
  MemoryNotFound: "note",
  MemoryDuplicateId: "note",
  MemoryJournalError: "journal",
  MemoryWriteRejected: "refused",
  MemoryConflict: "changed",
  MemoryError: "storage",
  PersistenceSqlError: "storage",
  MemoryQueryDecodeError: "storage",
};

const syncReason = (reason: unknown): MemoryWriteFailure => {
  switch (reason) {
    case "A memory purge is in flight; old history must not be pushed":
      return "purge";
    case "The memory repo is not on GitHub, so Kin cannot open its PR":
    case "Memory writes to the default branch are refused":
    case "Memory writes to the default branch land through a pull request, which isn't set up here (TRIG-15); this one was not committed":
      return "setup";
    case "Dream branch push rejected":
    case "Push rejected; retry or reconcile remote":
      return "remote";
    default:
      return "changed";
  }
};

export const memoryWriteFailure = (error: unknown): MemoryWriteFailure | undefined => {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return;
  if (error._tag === "MemorySyncConflict")
    return syncReason("reason" in error ? error.reason : undefined);
  if (typeof error._tag === "string" && Object.hasOwn(byTag, error._tag)) return byTag[error._tag];
};

const isMemoryWriteFailure = (kind: string): kind is MemoryWriteFailure =>
  Object.hasOwn(MEMORY_WRITE_FAILURE_WORDS, kind);

const FAILURE_PREFIX = "memory-write:";

export const saveMemoryWriteFailure = (failure: MemoryWriteFailure) =>
  `${FAILURE_PREFIX}${failure}`;

export const savedMemoryWriteFailure = (failure: string): MemoryWriteFailure | undefined => {
  const kind = failure.slice(FAILURE_PREFIX.length);
  if (failure.startsWith(FAILURE_PREFIX) && isMemoryWriteFailure(kind)) return kind;
  const tag = failure.split(":", 1)[0];
  if (tag !== undefined && Object.hasOwn(byTag, tag)) return byTag[tag];
};

export const MEMORY_WRITE_OPERATION_WORDS = {
  "wake-up": "Kin could not finish saving memory from an agent's turn.",
  "dream-cleanup": "Kin could not remove a temporary copy of the nightly memory update.",
  "spent-notes": "Kin could not put away notes that are no longer current.",
  "retired-sharing": "Kin could not finish updating who can read retired notes.",
  "deleted-quotes": "Kin could not finish removing quotes from deleted messages.",
  decision: "Kin could not save a decision in memory.",
  "online-copy": "The latest memory changes are saved on this server. The online copy is behind.",
} as const;

export type MemoryWriteOperation = keyof typeof MEMORY_WRITE_OPERATION_WORDS;

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
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : tell(orgId, operation, memoryWriteFailure(Cause.squash(cause)) ?? "storage"),
        ),
      );
