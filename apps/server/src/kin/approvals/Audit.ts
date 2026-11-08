// @effect-diagnostics nodeBuiltinImport:off -- a synchronous SHA-256 for the hash chain.
import * as NodeCrypto from "node:crypto";

import {
  KinAuditEntry,
  type KinAuditListInput,
  type KinAuditListResult,
  type KinAuditVerifyResult,
  type KinOrgId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";

import {
  PersistenceDecodeError,
  type PersistenceSqlError,
  toPersistenceSqlError,
} from "../../persistence/Errors.ts";

/** `prevHash` of each org's first entry. */
const KIN_AUDIT_GENESIS_HASH = "0".repeat(64);
const VERIFY_PAGE = 500;

export type KinAuditAppendInput = Omit<KinAuditEntry, "id" | "seq" | "at" | "prevHash" | "hash">;
type Errors = PersistenceSqlError | PersistenceDecodeError;

const { hash: _hash, ...unhashedFields } = KinAuditEntry.fields;
const encodeUnhashed = Schema.encodeEffect(Schema.Struct(unhashedFields));
const decodeEntry = Schema.decodeUnknownEffect(KinAuditEntry);
const decodeEntryOption = Schema.decodeUnknownOption(KinAuditEntry);

/** Spec section 11: sha256(prevHash ‖ stableStringify(entry without hash)). */
export const kinAuditHash = (unhashed: { readonly prevHash: string }): string =>
  NodeCrypto.createHash("sha256")
    .update(unhashed.prevHash + stableStringify(unhashed))
    .digest("hex");

type AuditRow = {
  readonly id: string;
  readonly org_id: string;
  readonly seq: number;
  readonly at: number;
  readonly event: string;
  readonly entry_json: string;
  readonly prev_hash: string;
  readonly hash: string;
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

// One row against its predecessor: canonical bytes, columns, position and both hashes.
const rowIsIntact = (row: AuditRow, expectedSeq: number, prevHash: string): boolean => {
  const parsed = parseJson(row.entry_json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  if (stableStringify(parsed) !== row.entry_json) return false;
  const decoded = decodeEntryOption(parsed);
  if (Option.isNone(decoded)) return false;
  const entry = decoded.value;
  const { hash, ...unhashed } = parsed as typeof KinAuditEntry.Encoded;
  return (
    row.seq === expectedSeq &&
    entry.seq === row.seq &&
    entry.id === row.id &&
    entry.orgId === row.org_id &&
    entry.event === row.event &&
    entry.at.epochMilliseconds === row.at &&
    entry.prevHash === prevHash &&
    row.prev_hash === prevHash &&
    hash === row.hash &&
    kinAuditHash(unhashed) === row.hash
  );
};

export class KinAudit extends Context.Service<
  KinAudit,
  {
    /**
     * Appends one entry to the org's chain. Joins the caller's transaction when there is one,
     * so a transition and its entry commit or roll back together. Server code only: no RPC or
     * MCP tool reaches it.
     */
    readonly append: (input: KinAuditAppendInput) => Effect.Effect<KinAuditEntry, Errors>;
    readonly list: (input: KinAuditListInput) => Effect.Effect<KinAuditListResult, Errors>;
    /** Recomputes the chain from seq 1 and reports the first entry that doesn't hold. */
    readonly verify: (input: {
      readonly orgId: KinOrgId;
    }) => Effect.Effect<KinAuditVerifyResult, Errors>;
  }
>()("t3/kin/approvals/Audit/KinAudit") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const append = Effect.fn("KinAudit.append")(
    function* (input: KinAuditAppendInput) {
      // The writer runs BEGIN IMMEDIATE behind one permit, so reading the head and inserting
      // the next seq can't interleave with another append; UNIQUE(org_id, seq) backs that up.
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const [head] = yield* sql<{ seq: number; hash: string }>`
            SELECT seq, hash FROM kin_audit WHERE org_id = ${input.orgId}
            ORDER BY seq DESC LIMIT 1`;
          const prevHash = head?.hash ?? KIN_AUDIT_GENESIS_HASH;
          const unhashed = yield* encodeUnhashed({
            ...input,
            id: `aud_${SecureRandom.ulidUnsafe()}`,
            seq: (head?.seq ?? 0) + 1,
            at: DateTime.makeUnsafe(now),
            prevHash,
          });
          const hash = kinAuditHash(unhashed);
          const encoded = { ...unhashed, hash };
          yield* sql`INSERT INTO kin_audit ${sql.insert({
            id: encoded.id,
            org_id: encoded.orgId,
            seq: encoded.seq,
            at: now,
            event: encoded.event,
            entry_json: stableStringify(encoded),
            prev_hash: prevHash,
            hash,
          })}`;
          return yield* decodeEntry(encoded);
        }),
      );
    },
    Effect.mapError(toError("KinAudit.append")),
  );

  const list = Effect.fn("KinAudit.list")(
    function* (input: KinAuditListInput) {
      const rows = yield* sql<{ entry_json: string }>`
        SELECT entry_json FROM kin_audit
        WHERE org_id = ${input.orgId} AND seq > ${input.afterSeq ?? 0}
        ORDER BY seq LIMIT ${input.limit + 1}`;
      const entries = yield* Effect.forEach(rows.slice(0, input.limit), (row) =>
        decodeEntry(parseJson(row.entry_json)),
      );
      return { entries, hasMore: rows.length > input.limit };
    },
    Effect.mapError(toError("KinAudit.list")),
  );

  const verify = Effect.fn("KinAudit.verify")(
    function* (input: { readonly orgId: KinOrgId }) {
      let checked = 0;
      let prevHash = KIN_AUDIT_GENESIS_HASH;
      while (true) {
        // Every verified row has seq === checked, so this resumes right after the last one.
        const rows = yield* sql<AuditRow>`SELECT * FROM kin_audit
          WHERE org_id = ${input.orgId} AND seq > ${checked}
          ORDER BY seq LIMIT ${VERIFY_PAGE}`;
        if (rows.length === 0) return { ok: true, checked, firstBadSeq: null };
        for (const row of rows) {
          if (!rowIsIntact(row, checked + 1, prevHash)) {
            return { ok: false, checked, firstBadSeq: checked + 1 };
          }
          checked += 1;
          prevHash = row.hash;
        }
      }
    },
    Effect.mapError(toError("KinAudit.verify")),
  );

  return KinAudit.of({ append, list, verify });
});

const isDecodeError = Schema.is(PersistenceDecodeError);
function toError(operation: string) {
  return (cause: unknown): Errors =>
    isDecodeError(cause)
      ? cause
      : Schema.isSchemaError(cause)
        ? PersistenceDecodeError.fromSchemaError(operation, cause)
        : toPersistenceSqlError(operation)(cause);
}

export const layer = Layer.effect(KinAudit, make);
