import {
  KIN_DEFAULT_HOME_CURRENCY,
  KIN_TEXT_LOCALE,
  KinChatError,
  KinCompanyLogo,
  type KinCompanyProfile,
  KinCompanyProfileData,
  KinCompanyProfileSetInput,
  type KinCompanyTax,
  type KinOrgId,
  KinPersonId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { accessSql, ownerLevel } from "../people/KinAccess.ts";
import { iso } from "./recordRows.ts";
import { localeOf, regionOf } from "./region.ts";

/**
 * The company profile: legal name, address, tax ids, bank details, logo and brand, one sensitive
 * record per org. The owner reads and sets it from a client. An agent reads it in a turn only the
 * owner reads, and changes it only by a card the owner confirms.
 */

// `countryPending` is written only when a company is created, and dropped by the first save that
// sets a country; a profile stored before it existed never has it, so no older company gets it.
const ProfileJson = Schema.fromJsonString(
  Schema.Struct({
    ...KinCompanyProfileData.fields,
    countryPending: Schema.optional(Schema.Literal(true)),
  }),
);
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
  homeCurrency: KIN_DEFAULT_HOME_CURRENCY,
  rates: [],
};
/** A client only clears the logo; a new one is Kin's copy of a file, from an agent's card. */
export type ProfilePatch = Omit<KinCompanyProfileSetInput, "orgId" | "rev" | "logo"> & {
  readonly logo?: KinCompanyLogo | null | undefined;
};
export type ProfileWriter =
  | { readonly _tag: "person"; readonly personId: string }
  | { readonly _tag: "agent"; readonly agentId: string };

/** How the company's money works: its currency, its country, its year's first month and its tax. */
export interface CompanyMoney {
  readonly homeCurrency: string;
  readonly country: string | null;
  readonly financialYearStartMonth: number;
  /** Null for India, whose GST the invoice recipe works out, and for a company with none. */
  readonly tax: KinCompanyTax | null;
}

/** The country of a profile stored before countries: India's for rupees, else none. */
export const countryBefore = (home: string) => (home === KIN_DEFAULT_HOME_CURRENCY ? "IN" : null);

/**
 * The profile as it reads: one stored before countries is in India when it keeps rupees, else in
 * no country; a country's row fills the year and tax the company never set.
 */
const moneyOf = (profile: KinCompanyProfileData): CompanyMoney => {
  const country =
    profile.country !== undefined ? profile.country : countryBefore(profile.homeCurrency);
  const region = regionOf(country);
  return {
    homeCurrency: profile.homeCurrency,
    country,
    financialYearStartMonth:
      profile.financialYearStartMonth ?? region?.financialYearStartMonth ?? 1,
    tax:
      country === "IN"
        ? null
        : profile.tax !== undefined
          ? profile.tax
          : region === undefined
            ? null
            : { name: region.tax, rate: null, pricesInclude: null },
  };
};

/**
 * The row a company created now starts with: its country not chosen. A company with no row was
 * made before countries and keeps reading as India (`countryBefore`).
 */
export const newCompanyProfileJson = encodeProfile({
  ...EMPTY,
  country: null,
  countryPending: true,
});

const storedProfile = Effect.fn("KinCompanyProfile.stored")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ json: string; rev: number; updatedAt: number }>`
    SELECT profile_json AS json, rev, updated_at AS "updatedAt" FROM kin_company_profile
    WHERE org_id = ${orgId}`;
  if (row === undefined) return { data: EMPTY, pending: false, rev: 0, updatedAt: null };
  const { countryPending, ...data } = Option.getOrElse(decodeProfile(row.json), () => ({
    ...EMPTY,
    countryPending: undefined,
  }));
  const pending = countryPending === true;
  // The new company's row (updated_at 0) was never saved: its forms still offer the device's country.
  return row.updatedAt === 0
    ? { data, pending, rev: 0, updatedAt: null }
    : { data, pending, rev: row.rev, updatedAt: iso(row.updatedAt) };
});

/**
 * True while a company created now has no country chosen: Kin records no money for it until one
 * is saved. Never true for a company made before, saved with a country or not.
 */
export const countryNeeded = Effect.fn("KinCompanyProfile.countryNeeded")(function* (
  orgId: KinOrgId,
) {
  return (yield* storedProfile(orgId)).pending;
});

const NOT_CHOSEN = "this company's country isn't chosen yet";
/** How the agent's call reads it: a batch or a change saved nothing; a teammate's turn asks no one. */
export interface CountryAsk {
  readonly saved?: boolean;
  readonly forTeammate?: boolean;
}
export const countryFirstMessage = (owner: string, ask: CountryAsk = {}) =>
  `Nothing was ${ask.saved === true ? "saved" : "created"}: ${NOT_CHOSEN}, ${
    ask.forTeammate === true
      ? `and Kin records no money until ${owner} chooses it in Settings, Company details.`
      : `so Kin can't tell its currency or tax. Ask ${owner} to choose it in Settings, Company details.`
  }`;
/** A refusal no fix to the call itself answers: the company's country comes first. */
export const isCountryFirst = (error: { readonly message: string }) =>
  error.message.startsWith("Nothing was ") && error.message.includes(NOT_CHOSEN);
/** What a person's own request says instead: no name in it (an older phone hides names). */
export const countryFirstForPerson = (ownerLevel: boolean) =>
  ownerLevel
    ? "Nothing was saved: choose your company's country first, in Settings, Company details."
    : "Nothing was saved: an owner needs to choose the company's country first.";

/** The refusal naming the owner, whoever saved the profile last. */
export const countryRefusal = Effect.fn("KinCompanyProfile.countryRefusal")(function* (
  orgId: KinOrgId,
  ask: CountryAsk = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const [owner] = yield* sql<{ name: string }>`SELECT p.display_name AS name FROM kin_people p
    WHERE p.org_id = ${orgId} AND ${sql.literal(accessSql("p"))} = 'owner'
    ORDER BY p.created_at, p.person_id LIMIT 1`.pipe(Effect.orElseSucceed(() => []));
  return new KinChatError({
    reason: "invalid_state",
    message: countryFirstMessage(owner?.name.trim() || "the owner", ask),
  });
});

// Orgs read as not waiting on a country, per database. The state only ever ends, so a committed
// read stays true; a read inside a transaction counts only once that transaction commits.
const settled = new WeakMap<SqlClient.SqlClient, Set<string>>();
const settledIn = (sql: SqlClient.SqlClient) => {
  const known = settled.get(sql) ?? new Set<string>();
  settled.set(sql, known);
  return known;
};
const markSettled = (sql: SqlClient.SqlClient, orgId: KinOrgId) =>
  sql.afterCommit(Effect.sync(() => settledIn(sql).add(orgId)));

/** The company's money as it reads, and whether it still waits on its country, in one read. */
export const companyMoneyState = Effect.fn("KinCompanyProfile.moneyState")(function* (
  orgId: KinOrgId,
) {
  const sql = yield* SqlClient.SqlClient;
  const stored = yield* storedProfile(orgId);
  if (!stored.pending) yield* markSettled(sql, orgId);
  return { ...moneyOf(stored.data), pending: stored.pending };
});

/** Refuses anything that records money while the company's country is not chosen. */
export const countryFirst = Effect.fn("KinCompanyProfile.countryFirst")(function* (
  orgId: KinOrgId,
  ask?: CountryAsk,
) {
  const sql = yield* SqlClient.SqlClient;
  if (settledIn(sql).has(orgId)) return;
  if (yield* countryNeeded(orgId)) return yield* yield* countryRefusal(orgId, ask);
  yield* markSettled(sql, orgId);
});

/**
 * The company's money for a write that turns a bare amount into money or keeps the currency it
 * reads: refused while the country is not chosen, read with that state in one query.
 */
const recordingMoney = Effect.fn("KinCompanyProfile.recordingMoney")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const stored = yield* storedProfile(orgId);
  if (stored.pending) return yield* yield* countryRefusal(orgId);
  yield* markSettled(sql, orgId);
  return moneyOf(stored.data);
});

/** The currency a bare amount in a write is in: refused while the country is not chosen. */
export const recordingCurrency = Effect.fn("KinCompanyProfile.recordingCurrency")(function* (
  orgId: KinOrgId,
) {
  return (yield* recordingMoney(orgId)).homeCurrency;
});

/** The profile with its country, year and tax as they read, set or not. */
export const readProfile = Effect.fn("KinCompanyProfile.read")(function* (orgId: KinOrgId) {
  const stored = yield* storedProfile(orgId);
  const { homeCurrency: _home, ...money } = moneyOf(stored.data);
  return {
    ...stored.data,
    ...money,
    rev: stored.rev,
    updatedAt: stored.updatedAt,
  } satisfies KinCompanyProfile;
});

/** The company's money as it reads; a company that never set one, or can't be read, is the default. */
export const companyMoney = Effect.fn("KinCompanyProfile.money")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ json: string }>`SELECT profile_json AS json
    FROM kin_company_profile WHERE org_id = ${orgId}`.pipe(Effect.orElseSucceed(() => []));
  return moneyOf(
    row === undefined ? EMPTY : Option.getOrElse(decodeProfile(row.json), () => EMPTY),
  );
});

/** What the company keeps its books in: an amount that names no currency is in it. */
export const homeCurrency = Effect.fn("KinCompanyProfile.homeCurrency")(function* (
  orgId: KinOrgId,
) {
  return (yield* companyMoney(orgId)).homeCurrency;
});

/** The zone a person reads a time in and the locale the company's text is written in. */
export interface TextClock {
  readonly zone: string;
  readonly locale: string;
}

/**
 * The locale of what the server writes for this company's people: its country's (en-IN and a
 * 12-hour clock in India, en-GB in the UK, en-US in the US), `KIN_TEXT_LOCALE` where it has none.
 * Agent-facing text stays in `KIN_TEXT_LOCALE` so prompts don't move.
 */
export const textLocale = Effect.fn("KinCompanyProfile.textLocale")(function* (orgId: KinOrgId) {
  const money = yield* companyMoney(orgId);
  return localeOf(money.country, money.homeCurrency) ?? KIN_TEXT_LOCALE;
});

/**
 * A change of country brings that country's currency, year and tax for whichever of them the
 * same change doesn't give; a country with no row keeps the currency and has no tax.
 */
const followCountry = (data: KinCompanyProfileData, patch: ProfilePatch) => {
  if (patch.country === undefined || patch.country === moneyOf(data).country) return {};
  const region = regionOf(patch.country);
  return {
    ...(region === undefined ? {} : { homeCurrency: region.currency }),
    financialYearStartMonth: region?.financialYearStartMonth ?? 1,
    tax:
      region === undefined || patch.country === "IN"
        ? null
        : { name: region.tax, rate: null, pricesInclude: null },
  };
};

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
      const { data, pending, rev: storedRev } = yield* storedProfile(orgId);
      const { bank, brand, ...rest } = patch;
      const given = <A extends object>(value: A | undefined) =>
        Object.fromEntries(Object.entries(value ?? {}).filter(([, one]) => one !== undefined));
      const next: KinCompanyProfileData = {
        ...data,
        ...followCountry(data, patch),
        ...given(rest),
        bank: { ...data.bank, ...given(bank) },
        brand: { ...data.brand, ...given(brand) },
      };
      // Only a saved country ends the wait; a logo, a name or "no country" keeps it.
      const stillPending = pending && (next.country ?? null) === null;
      const json = yield* encodeProfile(stillPending ? { ...next, countryPending: true } : next);
      if (json === (yield* encodeProfile(pending ? { ...data, countryPending: true } : data)))
        return yield* readProfile(orgId);
      if (rev !== undefined && rev !== storedRev)
        return yield* new KinChatError({
          reason: "conflict",
          message: `The company profile changed since you read it; it is at revision ${storedRev} now.`,
        });
      const now = yield* Clock.currentTimeMillis;
      const by = writer._tag === "person" ? writer.personId : writer.agentId;
      yield* sql`INSERT INTO kin_company_profile (org_id, profile_json, rev, updated_at,
          updated_by_kind, updated_by_id)
        VALUES (${orgId}, ${json}, 1, ${now}, ${writer._tag}, ${by})
        ON CONFLICT (org_id) DO UPDATE SET profile_json = excluded.profile_json,
          rev = kin_company_profile.rev + 1, updated_at = excluded.updated_at,
          updated_by_kind = excluded.updated_by_kind, updated_by_id = excluded.updated_by_id`;
      // Lists made while waiting took no currency of their own (`registers.ts` `listCurrency`).
      if (pending && !stillPending)
        yield* sql`UPDATE kin_registers SET definition_json = json_remove(
            json_set(definition_json, '$.currency', ${next.homeCurrency}), '$.currencyPending'),
            rev = rev + 1
          WHERE org_id = ${orgId} AND json_extract(definition_json, '$.currencyPending') = 1`;
      yield* (yield* KinRefreshObserver).touch(orgId, "company");
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
// Home currency, rates, country, year and tax are the owner's own settings; no agent card proposes them.
const LABELS: Record<
  Exclude<
    keyof ProfilePatch,
    | "bank"
    | "brand"
    | "logo"
    | "homeCurrency"
    | "rates"
    | "country"
    | "financialYearStartMonth"
    | "tax"
  >,
  string
> = {
  gstin: "GSTIN",
  pan: "PAN",
  placeOfSupply: "Place of supply",
  sac: "SAC",
  lutNumber: "LUT number",
  lutDate: "LUT date",
  legalName: "Legal name",
  tradeName: "Trade name",
  address: "Address",
};
const BANK_LABELS: Record<keyof KinCompanyProfileData["bank"], string> = {
  accountName: "Bank account name",
  accountNumber: "Bank account number",
  ifsc: "Bank IFSC",
  bankName: "Bank name",
  branch: "Bank branch",
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
      line(BANK_LABELS[key], current.bank[key], patch.bank?.[key]),
    ),
    ...(Object.keys(LABELS) as Array<keyof typeof LABELS>).flatMap((key) =>
      line(LABELS[key], current[key] ?? null, patch[key]),
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

/**
 * A newer change card replaces every older one still unanswered: they can never be confirmed, so
 * an emptier, older card can't overwrite what the newer one shows. Returns their cards to close.
 */
export const replaceOlderChanges = Effect.fn("KinCompanyProfile.replaceOlderChanges")(function* (
  orgId: KinOrgId,
  changeId: string,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const older = yield* sql<{ changeId: string; widgetId: string }>`
    SELECT change_id AS "changeId", widget_id AS "widgetId" FROM kin_profile_changes
    WHERE org_id = ${orgId} AND change_id != ${changeId} AND widget_id IS NOT NULL
      AND applied_at IS NULL AND declined_at IS NULL
    ORDER BY change_id`;
  if (older.length === 0) return [];
  yield* sql`UPDATE kin_profile_changes SET declined_at = ${now}
    WHERE org_id = ${orgId} AND change_id IN ${sql.in(older.map((row) => row.changeId))}`;
  return older.map((row) => row.widgetId);
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
  }>`SELECT c.change_id AS "changeId", c.patch_json AS patch, c.base_rev AS "baseRev",
      (c.applied_at IS NOT NULL OR c.declined_at IS NOT NULL) AS done
    FROM kin_profile_changes c
    WHERE c.org_id = ${input.orgId} AND c.widget_id = ${input.widgetId}`;
  if (row === undefined) return;
  if (!(yield* ownerLevel(input.orgId, KinPersonId.make(input.personId)).pipe(Effect.orDie)))
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Only the owner or a co-owner changes the company profile.",
    });
  if (input.via === "reaction")
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Tap Confirm or Cancel on the card to answer a company profile change.",
    });
  if (row.done === 1)
    return yield* new KinChatError({
      reason: "widget_changed",
      message: "This change was already answered or replaced by a newer one.",
    });
  if (!input.confirmed) {
    yield* sql`UPDATE kin_profile_changes SET declined_at = ${input.now}
      WHERE org_id = ${input.orgId} AND change_id = ${row.changeId}`;
    return { title: "Not changed", text: "You said no, so the company details stay as they were." };
  }
  const patch = yield* decodePatch(row.patch);
  const current = yield* readProfile(input.orgId);
  if (current.rev !== row.baseRev)
    return yield* new KinChatError({
      reason: "conflict",
      message:
        "The company profile changed since this card was made, so nothing was changed. Ask for the change again.",
    });
  yield* setProfile(input.orgId, { _tag: "person", personId: input.personId }, patch, row.baseRev);
  yield* sql`UPDATE kin_profile_changes SET applied_at = ${input.now}
    WHERE org_id = ${input.orgId} AND change_id = ${row.changeId}`;
  // The card above already lists each change, old beside new.
  return {
    title: "Company details changed",
    text:
      changeLines(current, patch).length === 0
        ? "Saved; nothing in the details was different."
        : "Saved. Documents made from now on use these details.",
  };
});
