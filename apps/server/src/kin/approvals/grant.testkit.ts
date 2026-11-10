// @effect-diagnostics nodeBuiltinImport:off -- node:crypto makes and signs with keys like the phone.
import * as NodeCrypto from "node:crypto";

import { KinKeyThumbprint, type KinGrantHeader, type KinGrantPayload } from "@t3tools/contracts";
import { computeDpopJwkThumbprint } from "@t3tools/shared/dpop";
import { encodeGrantSigningInput } from "@t3tools/shared/kinGrant";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { KinKeySeal } from "./KeySeal.ts";

const P256_N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

/** A P-256 approver key, as the phone makes one. */
export const makeApprovalKey = () => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const { x, y } = publicKey.export({ format: "jwk" });
  const publicJwk = { kty: "EC", crv: "P-256", x: x!, y: y! } as const;
  return {
    privateKey,
    publicJwkJson: stableStringify(publicJwk),
    kid: KinKeyThumbprint.make(computeDpopJwkThumbprint(publicJwk)),
  };
};
export type ApprovalKey = ReturnType<typeof makeApprovalKey>;

/** ES256 over the canonical parts with low S, the r‖s form the phone sends. */
export const signCompact = (key: ApprovalKey, header: KinGrantHeader, payload: KinGrantPayload) => {
  const input = encodeGrantSigningInput(header, payload);
  const raw = NodeCrypto.sign("sha256", Buffer.from(input), {
    key: key.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  const s = BigInt(`0x${raw.subarray(32).toString("hex")}`);
  const low = s > P256_N / 2n ? P256_N - s : s;
  const signature = Buffer.concat([
    raw.subarray(0, 32),
    Buffer.from(low.toString(16).padStart(64, "0"), "hex"),
  ]);
  return `${input}.${signature.toString("base64url")}`;
};

/** The active key row the server writes when it activates a key, its seal included unless not. */
export const insertActiveKey = Effect.fn("grant.testkit.insertActiveKey")(function* (input: {
  readonly key: ApprovalKey;
  readonly orgId: string;
  readonly humanId: string;
  readonly sealed?: boolean;
}) {
  const sql = yield* SqlClient.SqlClient;
  const fields = {
    orgId: input.orgId,
    thumbprint: input.key.kid,
    publicJwkJson: input.key.publicJwkJson,
    humanId: input.humanId,
    hardware: "tee",
    createdAt: 0,
  };
  const seal = input.sealed === false ? null : (yield* KinKeySeal).seal(fields);
  yield* sql`INSERT INTO kin_approver_keys (thumbprint, org_id, public_jwk_json, human_id,
      device_label, platform, hardware, attested, state, created_at, seal)
    VALUES (${fields.thumbprint}, ${fields.orgId}, ${fields.publicJwkJson}, ${fields.humanId},
      'Pixel 9', 'android', 'tee', 1, 'active', 0, ${seal})`;
});

/** A pending attested key as registration writes it, its pending seal included unless not. */
export const insertPendingKey = Effect.fn("grant.testkit.insertPendingKey")(function* (input: {
  readonly key: ApprovalKey;
  readonly orgId: string;
  readonly humanId: string;
  readonly sealed?: boolean;
}) {
  const sql = yield* SqlClient.SqlClient;
  const fields = {
    orgId: input.orgId,
    thumbprint: input.key.kid,
    publicJwkJson: input.key.publicJwkJson,
    humanId: input.humanId,
    hardware: "tee",
    createdAt: 0,
    deviceLabel: "Pixel 9",
    platform: "android",
    attested: 1,
    sessionId: null,
    proofKeyThumbprint: null,
  };
  const pendingSeal = input.sealed === false ? null : (yield* KinKeySeal).pendingSeal(fields);
  yield* sql`INSERT INTO kin_approver_keys (thumbprint, org_id, public_jwk_json, human_id,
      device_label, platform, hardware, attested, state, created_at, pending_seal)
    VALUES (${fields.thumbprint}, ${fields.orgId}, ${fields.publicJwkJson}, ${fields.humanId},
      'Pixel 9', 'android', 'tee', 1, 'pending', 0, ${pendingSeal})`;
});
