import { assert, it } from "@effect/vitest";
import { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { QUOTE_MISSING, quoteRefusal } from "./keeping.ts";
import {
  MEMORY_WRITE_FAILURE_WORDS,
  memoryWriteFailure,
  observeMemoryWrite,
  savedMemoryWriteFailure,
  saveMemoryWriteFailure,
  type MemoryWriteFailure,
} from "./writeFailure.ts";

const rejections = [
  ["Invalid server context", "which turn"],
  ["Invalid writer authority", "which turn"],
  ["Unknown source person", "couldn't identify who said it"],
  [
    "Disallowed memory path: names are ASCII letters, digits, . _ -, and agent config or Windows device names are reserved",
    "file name",
  ],
  ["INDEX.md must be a file", "memory index where a file"],
  ["Hidden paths are not allowed in Kin's unowned folders", "hidden file"],
  [
    "Kin's unowned folders only hold item and journal files",
    "only holds notes and journal entries",
  ],
  ["Symlink or invalid ancestor", "unsafe location"],
  ["Use appendJournal for journal additions", "wrong way to add a journal entry"],
  ["Source is not in the current batch", "source was outside"],
  ["Kind does not match path", "wrong folder"],
  ["Cannot overwrite malformed recorded item", "existing note couldn't be read"],
  ["Cannot change recorded item kind", "change the type of a note"],
  ["Only the owner lets the team know an item", "only the owner can share"],
  ["Supersession requires the same source and kind", "same source and type"],
  ["besides names only open items of the same kind that share a link with it", "unrelated notes"],
  ["Cannot replace a different item", "another note's place"],
  [QUOTE_MISSING, "needed an exact quote"],
  [quoteRefusal("x".repeat(1000), "Tidewater Freight"), "quote was too long"],
  [quoteRefusal("Tidewater Freight", undefined), "source had no words"],
  [quoteRefusal("Juniper Cold Chain", "Tidewater Freight"), "quote wasn't in the source"],
  [quoteRefusal("Tide", "Tidewater Freight"), "quote was too short"],
  ["Different wake-up retry", "retry differed"],
  ["Invalid dream branch", "temporary location for the nightly update"],
  ["INDEX.md is built by code", "index automatically"],
  ["Invalid undo target", "couldn't identify the change to undo"],
] as const;

const syncConflicts = [
  [
    "Memory history was rewritten during this wake-up; its staged changes were dropped",
    "history was rewritten",
  ],
  [
    "A memory purge is in flight; old history must not be pushed",
    "older information was being removed",
  ],
  ["The memory repo is not on GitHub, so Kin cannot open its PR", "online copy isn't on GitHub"],
  [
    "Memory writes to the default branch land through a pull request, which isn't set up here (TRIG-15); this one was not committed",
    "set up to accept",
  ],
  ["Push rejected; retry or reconcile remote", "online copy"],
  [
    "Memory changed since this wake-up staged claims/tidewater.md; its change no longer applies cleanly and was not committed",
    "memory changed while",
  ],
  ["The dream's base is no longer in memory history", "earlier version"],
  ["Dream branch push rejected", "send the nightly memory update"],
  ["Memory writes to the default branch are refused", "set up to accept"],
  ["Memory changed since the dream read it, so it did not land", "memory changed while it ran"],
] as const;

const taggedFailures = [
  ["MemoryCheckoutInvalid", "copy of memory on this server"],
  ["MemoryConfigError", "set up to accept"],
  ["MemorySecretBlocked", "password or key"],
  ["KinSecretScanError", "check for passwords and keys"],
  ["MemoryItemError", "memory note couldn't be read"],
  ["MemoryNotFound", "couldn't find the memory note"],
  ["MemoryJournalError", "date or time zone"],
  ["MemoryConflict", "conflicted with an existing note"],
  ["MemoryError", "read or write"],
  ["PersistenceSqlError", "read or write"],
  ["MemoryQueryDecodeError", "read or write"],
] as const;

const cases = [
  ...rejections.map(([reason, phrase]) => ["MemoryWriteRejected", reason, phrase] as const),
  ...syncConflicts.map(([reason, phrase]) => ["MemorySyncConflict", reason, phrase] as const),
  ...taggedFailures.map(([_tag, phrase]) => [_tag, "fixture diagnostic", phrase] as const),
  ["MemoryConfigError", "Unknown org", "set up to accept"],
  [
    "MemoryCheckoutInvalid",
    "Writer .git is missing or not a directory",
    "copy of memory on this server",
  ],
  ["MemoryCheckoutInvalid", "Missing recorded branch", "part of memory is missing"],
  [
    "MemoryCheckoutInvalid",
    "Invalid remote advertisement",
    "unexpected result from the online copy",
  ],
];

const orgId = KinOrgId.make("org-tidewater-freight");

it.effect.each(cases)("reports %s: %s in plain words", ([_tag, reason, phrase]) =>
  Effect.gen(function* () {
    assert.isString(reason);
    const failure = { _tag, reason };
    const kind = memoryWriteFailure(failure);
    if (kind === undefined) return assert.fail("Missing owner notice");
    assert.include(MEMORY_WRITE_FAILURE_WORDS[kind], phrase);
    assert.strictEqual(savedMemoryWriteFailure(saveMemoryWriteFailure(kind)), kind);
    assert.strictEqual(savedMemoryWriteFailure(`${_tag}: ${reason}`), kind);
    const seen: Array<MemoryWriteFailure | undefined> = [];
    yield* observeMemoryWrite(
      (_org, _operation, observed) => Effect.sync(() => void seen.push(observed)),
      orgId,
      "wake-up",
      Effect.fail(failure),
    ).pipe(Effect.result);
    assert.deepStrictEqual(seen, [kind]);
  }),
);

it.effect.each([
  ["MemoryDuplicateId", "fixture diagnostic"],
  ["MemoryWriteRejected", "Wake-up is not running"],
  ["KinChatError", "not_allowed"],
] as const)("%s: %s needs no owner notice", ([_tag, reason]) =>
  Effect.gen(function* () {
    const failure = { _tag, reason };
    const seen: Array<MemoryWriteFailure | undefined> = [];
    yield* observeMemoryWrite(
      (_org, _operation, observed) => Effect.sync(() => void seen.push(observed)),
      orgId,
      "wake-up",
      Effect.fail(failure),
    ).pipe(Effect.result);
    assert.deepStrictEqual(seen, []);
    assert.isUndefined(memoryWriteFailure(failure));
    assert.isUndefined(savedMemoryWriteFailure(`${_tag}: ${reason}`));
  }),
);

// The agent's own memory_write gets these refusals as its tool result and can fix them itself.
it.effect.each([
  ["stage-note", "MemoryWriteRejected", QUOTE_MISSING, undefined],
  ["stage-note", "MemoryWriteRejected", "Kind does not match path", undefined],
  ["stage-note", "MemorySecretBlocked", "fixture diagnostic", undefined],
  ["stage-journal", "MemoryJournalError", "fixture diagnostic", undefined],
  ["stage-note", "MemoryCheckoutInvalid", "fixture diagnostic", "checkout"],
  ["wake-up", "MemoryWriteRejected", QUOTE_MISSING, "quote-missing"],
] as const)("%s refused by %s (%s) tells the owner %s", ([operation, _tag, reason, told]) =>
  Effect.gen(function* () {
    const seen: Array<MemoryWriteFailure | undefined> = [];
    yield* observeMemoryWrite(
      (_org, _operation, observed) => Effect.sync(() => void seen.push(observed)),
      orgId,
      operation,
      Effect.fail({ _tag, reason }),
    ).pipe(Effect.result);
    assert.deepStrictEqual(seen, told === undefined ? [] : [told]);
  }),
);
