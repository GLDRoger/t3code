import {
  KinChatError,
  KinCompanyLogo,
  type KinCompanyProfile,
  KinCompanyProfileData,
  KinCompanyProfileSetInput,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { iso } from "./recordRows.ts";

/**
 * The company profile: legal name, address, tax ids, bank details, logo and brand, one sensitive
 * record per org. The owner reads and sets it from a client. An agent reads it in a turn only the
 * owner reads, and changes it only by a card the owner confirms.
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
  logo: null,
  brand: { primaryColor: null, secondaryColor: null, font: null, footer: null },
};
/** A client only clears the logo; a new one is Kin's copy of a file, from an agent's card. */
export type ProfilePatch = Omit<KinCompanyProfileSetInput, "orgId" | "rev" | "logo"> & {
  readonly logo?: KinCompanyLogo | null | undefined;
};
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
      const { bank, brand, ...rest } = patch;
      const given = <A extends object>(value: A | undefined) =>
        Object.fromEntries(Object.entries(value ?? {}).filter(([, one]) => one !== undefined));
      const next: KinCompanyProfileData = {
        ...data,
        ...given(rest),
        bank: { ...data.bank, ...given(bank) },
        brand: { ...data.brand, ...given(brand) },
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

const { orgId: _orgId, rev: _rev, logo: _logo, ...patchFields } = KinCompanyProfileSetInput.fields;
const PatchJson = Schema.fromJsonString(
  Schema.Struct({ ...patchFields, logo: Schema.optional(Schema.NullOr(KinCompanyLogo)) }),
);
const encodePatch = Schema.encodeEffect(PatchJson);
const decodePatch = Schema.decodeUnknownEffect(PatchJson);
const LABELS: Record<Exclude<keyof ProfilePatch, "bank" | "brand" | "logo">, string> = {
  gstin: "GSTIN",
  pan: "PAN",
  placeOfSupply: "Place of supply",
  sac: "SAC",
  legalName: "Legal name",
  tradeName: "Trade name",
  address: "Address",
};
const BANK_LABELS: Record<keyof KinCompanyProfileData["bank"], string> = {
  accountName: "Account name",
  accountNumber: "Account number",
  ifsc: "IFSC",
  bankName: "Bank",
  branch: "Branch",
  upi: "UPI",
};
const BRAND_LABELS: Record<keyof KinCompanyProfileData["brand"], string> = {
  primaryColor: "Brand colour",
  secondaryColor: "Second brand colour",
  font: "Document font",
  footer: "Document footer",
};
const logoLine = (logo: KinCompanyLogo | null) =>
  logo === null
    ? "none"
    : `${logo.name} (${logo.mimeType === "image/svg+xml" ? "SVG" : logo.mimeType === "image/png" ? "PNG" : "JPEG"}${logo.width === null || logo.height === null ? "" : `, ${logo.width} × ${logo.height} px`}, ${Math.max(1, Math.round(logo.bytes / 1024))} KB)`;

/**
 * Each field the patch changes, old value beside new, as the owner's card shows it: bank details
 * and tax ids first, since they go on invoices.
 */
export const changeLines = (current: KinCompanyProfileData, patch: ProfilePatch) => {
  const line = (label: string, from: string | null, to: string | null | undefined) =>
    to === undefined || to === from ? [] : [`${label}: ${from ?? "none"} → ${to ?? "cleared"}`];
  return [
    ...(Object.keys(BANK_LABELS) as Array<keyof typeof BANK_LABELS>).flatMap((key) =>
      line(`Bank ${BANK_LABELS[key].toLowerCase()}`, current.bank[key], patch.bank?.[key]),
    ),
    ...(Object.keys(LABELS) as Array<keyof typeof LABELS>).flatMap((key) =>
      line(LABELS[key], current[key], patch[key]),
    ),
    ...(patch.logo === undefined || patch.logo?.sha256 === current.logo?.sha256
      ? []
      : [
          `Logo: ${logoLine(current.logo)} → ${patch.logo === null ? "cleared" : logoLine(patch.logo)}`,
        ]),
    ...(Object.keys(BRAND_LABELS) as Array<keyof typeof BRAND_LABELS>).flatMap((key) =>
      line(BRAND_LABELS[key], current.brand[key], patch.brand?.[key]),
    ),
  ];
};

/** An agent's change, stored as asked against the profile at `baseRev`; the same one twice is one. */
export const proposeChange = Effect.fn("KinCompanyProfile.proposeChange")(function* (input: {
  readonly orgId: KinOrgId;
  readonly changeId: string;
  readonly agentId: string;
  readonly wakeupId: string;
  readonly patch: ProfilePatch;
  readonly baseRev: number;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_profile_changes (org_id, change_id, agent_id, wakeup_id, patch_json,
      base_rev, proposed_at)
    VALUES (${input.orgId}, ${input.changeId}, ${input.agentId}, ${input.wakeupId},
      ${yield* encodePatch(input.patch)}, ${input.baseRev}, ${input.now})
    ON CONFLICT (org_id, change_id) DO NOTHING`;
});

export const attachChangeCard = Effect.fn("KinCompanyProfile.attachChangeCard")(function* (
  orgId: KinOrgId,
  changeId: string,
  widgetId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_profile_changes SET widget_id = ${widgetId}
    WHERE org_id = ${orgId} AND change_id = ${changeId} AND widget_id IS NULL`;
});

/**
 * The owner's answer on a profile change card: a tap on Confirm applies exactly the stored patch,
 * once, and only to the profile revision the card showed. A reaction answers nothing here. Any
 * other card is not this one's business.
 */
export const answerChange = Effect.fn("KinCompanyProfile.answerChange")(function* (input: {
  readonly orgId: KinOrgId;
  readonly widgetId: string;
  readonly personId: string;
  readonly confirmed: boolean;
  readonly via: "tap" | "reaction";
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    changeId: string;
    patch: string;
    baseRev: number;
    done: number;
    owner: string;
  }>`SELECT c.change_id AS "changeId", c.patch_json AS patch, c.base_rev AS "baseRev",
      (c.applied_at IS NOT NULL OR c.declined_at IS NOT NULL) AS done, a.owner_person_id AS owner
    FROM kin_profile_changes c JOIN kin_agents a ON a.org_id = c.org_id AND a.agent_id = c.agent_id
    WHERE c.org_id = ${input.orgId} AND c.widget_id = ${input.widgetId}`;
  if (row === undefined) return;
  if (row.owner !== input.personId)
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Only the owner changes the company profile.",
    });
  if (input.via === "reaction")
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Tap Confirm or Cancel on the card to answer a company profile change.",
    });
  if (row.done === 1)
    return yield* new KinChatError({
      reason: "widget_changed",
      message: "This change was already answered.",
    });
  if (!input.confirmed) {
    yield* sql`UPDATE kin_profile_changes SET declined_at = ${input.now}
      WHERE org_id = ${input.orgId} AND change_id = ${row.changeId}`;
    return;
  }
  const patch = yield* decodePatch(row.patch);
  if ((yield* readProfile(input.orgId)).rev !== row.baseRev)
    return yield* new KinChatError({
      reason: "conflict",
      message:
        "The company profile changed since this card was made, so nothing was changed. Ask for the change again.",
    });
  yield* setProfile(input.orgId, { _tag: "person", personId: input.personId }, patch, row.baseRev);
  yield* sql`UPDATE kin_profile_changes SET applied_at = ${input.now}
    WHERE org_id = ${input.orgId} AND change_id = ${row.changeId}`;
});
