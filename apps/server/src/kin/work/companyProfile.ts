import {
  KinChatError,
  type KinCompanyProfile,
  KinCompanyProfileData,
  type KinCompanyProfileSetInput,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { iso } from "./recordRows.ts";

/**
 * The company profile: legal name, address, tax ids and bank details, one sensitive record per
 * org. The owner reads and sets it from a client; an agent only in a turn only the owner reads.
 */

const ProfileJson = Schema.fromJsonString(KinCompanyProfileData);
const decodeProfile = Schema.decodeUnknownOption(ProfileJson);
const encodeProfile = Schema.encodeEffect(ProfileJson);
const EMPTY: KinCompanyProfileData = {
  legalName: null,
  tradeName: null,
  address: null,
  gstin: null,
  pan: null,
  placeOfSupply: null,
  sac: null,
  bank: {
    accountName: null,
    accountNumber: null,
    ifsc: null,
    bankName: null,
    branch: null,
    upi: null,
  },
};
export type ProfilePatch = Omit<KinCompanyProfileSetInput, "orgId" | "rev">;
export type ProfileWriter =
  | { readonly _tag: "person"; readonly personId: string }
  | { readonly _tag: "agent"; readonly agentId: string };

export const readProfile = Effect.fn("KinCompanyProfile.read")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ json: string; rev: number; updatedAt: number }>`
    SELECT profile_json AS json, rev, updated_at AS "updatedAt" FROM kin_company_profile
    WHERE org_id = ${orgId}`;
  if (row === undefined) return { ...EMPTY, rev: 0, updatedAt: null } satisfies KinCompanyProfile;
  return {
    ...Option.getOrElse(decodeProfile(row.json), () => EMPTY),
    rev: row.rev,
    updatedAt: iso(row.updatedAt),
  } satisfies KinCompanyProfile;
});

/** Only the fields given change. A `rev` other than the stored one is refused unless nothing would change. */
export const setProfile = Effect.fn("KinCompanyProfile.set")(function* (
  orgId: KinOrgId,
  writer: ProfileWriter,
  patch: ProfilePatch,
  rev: number | undefined,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const current = yield* readProfile(orgId);
      const { rev: _rev, updatedAt: _at, ...data } = current;
      const { bank, ...rest } = patch;
      const next: KinCompanyProfileData = {
        ...data,
        ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
        bank: {
          ...data.bank,
          ...Object.fromEntries(
            Object.entries(bank ?? {}).filter(([, value]) => value !== undefined),
          ),
        },
      };
      const json = yield* encodeProfile(next);
      if (json === (yield* encodeProfile(data))) return current;
      if (rev !== undefined && rev !== current.rev)
        return yield* new KinChatError({
          reason: "conflict",
          message: `The company profile changed since you read it; it is at revision ${current.rev} now.`,
        });
      const now = yield* Clock.currentTimeMillis;
      const by = writer._tag === "person" ? writer.personId : writer.agentId;
      yield* sql`INSERT INTO kin_company_profile (org_id, profile_json, rev, updated_at,
          updated_by_kind, updated_by_id)
        VALUES (${orgId}, ${json}, 1, ${now}, ${writer._tag}, ${by})
        ON CONFLICT (org_id) DO UPDATE SET profile_json = excluded.profile_json,
          rev = kin_company_profile.rev + 1, updated_at = excluded.updated_at,
          updated_by_kind = excluded.updated_by_kind, updated_by_id = excluded.updated_by_id`;
      return yield* readProfile(orgId);
    }),
  );
});
