// @effect-diagnostics-next-line nodeBuiltinImport:off -- a random id for a held file; SecureRandom would add a service.
import * as NodeCrypto from "node:crypto";

import type { KinImportUpload, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

/**
 * A file the import wizard sent once, held in this process's memory for the import under way, so
 * later checks and the import name it instead of sending it again. Never written to disk: a
 * restart or an hour unused loses it, and the wizard sends the file again.
 */
const HOLD_MS = 60 * 60_000;
const HOLD_BYTES = 64 * 1024 * 1024;

interface Held {
  readonly orgId: KinOrgId;
  readonly personId: KinPersonId;
  readonly hash: string;
  readonly bytes: Uint8Array;
  readonly usedAt: number;
}
// Least recently used first: a use moves an entry to the end.
const held = new Map<string, Held>();

const touch = (id: string, one: Held, now: number) => {
  held.delete(id);
  held.set(id, { ...one, usedAt: now });
};
const sweep = (now: number) => {
  for (const [id, one] of held) if (now - one.usedAt >= HOLD_MS) held.delete(id);
};

/** Holds `bytes` for one person of one org; the same file again keeps its id. */
export const holdImportFile = Effect.fn("KinImportUploads.hold")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  bytes: Uint8Array,
  hash: string,
) {
  const now = yield* Clock.currentTimeMillis;
  sweep(now);
  for (const [id, one] of held)
    if (one.orgId === orgId && one.personId === personId && one.hash === hash) {
      touch(id, one, now);
      return { id, hash } satisfies KinImportUpload;
    }
  let total = bytes.byteLength;
  for (const one of held.values()) total += one.bytes.byteLength;
  for (const [id, one] of held) {
    if (total <= HOLD_BYTES) break;
    held.delete(id);
    total -= one.bytes.byteLength;
  }
  const id = NodeCrypto.randomUUID();
  held.set(id, { orgId, personId, hash, bytes, usedAt: now });
  return { id, hash } satisfies KinImportUpload;
});

/**
 * The bytes held under `upload` for this person: `gone` when it isn't held for them (expired, a
 * restart, or someone else's id), `changed` when the hash isn't the held file's.
 */
export const heldImportFile = Effect.fn("KinImportUploads.held")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  upload: KinImportUpload,
) {
  const now = yield* Clock.currentTimeMillis;
  sweep(now);
  const one = held.get(upload.id);
  if (one === undefined || one.orgId !== orgId || one.personId !== personId) return "gone";
  if (one.hash !== upload.hash) return "changed";
  touch(upload.id, one, now);
  return one.bytes;
});

/** Lets a held file go once its import is done. */
export const releaseImportFile = (upload: KinImportUpload) =>
  Effect.sync(() => {
    held.delete(upload.id);
  });
