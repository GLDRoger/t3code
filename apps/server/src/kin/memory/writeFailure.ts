import type { KinOrgId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

export const MEMORY_WRITE_FAILURE_WORDS = {
  checkout:
    "Kin couldn't open the copy of memory on this server. Ask whoever looks after Kin to check it.",
  setup:
    "Kin couldn't save memory changes because memory isn't set up to accept them here. Ask whoever looks after Kin to check it.",
  purge: "Kin couldn't save memory changes while older information was being removed from memory.",
  changed: "Kin couldn't save a memory update because memory changed while Kin was working on it.",
  remote: "Kin couldn't send the memory changes to the online copy.",
  review: "GitHub didn't accept Kin's memory changes.",
  "online-conflict":
    "Kin couldn't combine the memory changes made on GitHub with the ones saved here.",
  "review-needed":
    "GitHub requires a review before it accepts Kin's memory changes. Check the memory repository's review rules on GitHub; Kin tries again once the rules change or the server restarts.",
  secret: "Kin didn't save a memory update because it may contain a password or key.",
  scanner:
    "Kin held a memory update back because the check for passwords and keys couldn't finish.",
  note: "Kin couldn't save a memory update because a memory note couldn't be read.",
  journal: "Kin couldn't save a journal entry because its date or time zone couldn't be read.",
  storage: "Kin couldn't read or write what a memory update needed.",
  refused: "Kin couldn't save a memory update because the changes didn't meet memory's rules.",
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
  "wake-up": "Kin couldn't finish saving to memory what an agent's turn left.",
  "dream-cleanup": "Kin couldn't remove a temporary copy left by the nightly memory update.",
  "spent-notes": "Kin couldn't put away memory notes that are no longer current.",
  "retired-sharing": "Kin couldn't finish changing who can read retired memory notes.",
  "deleted-quotes": "Kin couldn't finish removing quotes of deleted messages from memory.",
  decision: "Kin couldn't save a decision to memory.",
  "online-copy": "Memory is saved on this server, but the online copy is behind.",
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
