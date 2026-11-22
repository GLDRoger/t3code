import {
  KIN_EXPORT_HOLDS,
  KIN_EXPORT_LEAVES,
  KinCompanyBank,
  KinCompanyProfileData,
  KinCompanyTax,
  KinCountryCode,
  type KinCompanyProfile,
  type KinCompanyProfileSetInput,
  type KinOrgId,
} from "@t3tools/contracts";
import { kinRateDay } from "./kinCurrency.ts";
import * as Schema from "effect/Schema";

/** The company's legal and bank details, as the owner reads and edits them in Settings. */

export const KIN_COMPANY = {
  loading: "Loading company details",
  title: "Company details",
  summary: "Legal name, tax ids and bank details",
  private:
    "Private. Only the owner and co-owners see these. Agents read them only when asked for something that needs them, like an invoice.",
  loadFailed: "Couldn't load your company details",
  edit: "Edit",
  save: "Save",
  cancel: "Cancel",
  saved: "Saved.",
  notSet: "Not set",
  notRegistered: "Not registered for GST",
  timeZone: "Time zone",
  timeZoneUse: "Check-ins, due days and your agents' times follow it.",
  /** How it changes: the owner's device sets it once per app run (`createKinOwnerTimeZoneSync`). */
  timeZoneFollows:
    "It follows the time zone of the phone or computer the owner last opened Kin on.",
  timeZoneFromHost:
    "None set yet, so Kin uses the computer's. Open Kin on your phone to set yours.",
  empty: "Nothing here yet. Add what goes on your invoices.",
  /** The phone reads these; they are changed on the computer. */
  onComputer: "Change these, the brand and the templates in Kin on your computer.",
  /** A new company's suggested country, the device's, which it takes only with a tap. */
  useCountry: (name: string) => `Use ${name}?`,
  changed:
    "These changed while you were editing. What you typed is still here. Check what's new, then save again.",
  onlyOwner: {
    title: "Not available",
    detail: "Company details are kept by whoever runs this Kin.",
  },
  noKin: {
    title: "No company here",
    detail: "Connect to the computer that runs your Kin to see its company details.",
  },
  export: {
    title: "Your data",
    detail: KIN_EXPORT_HOLDS,
    leaves: KIN_EXPORT_LEAVES,
    action: "Download everything",
    preparing: "Preparing…",
    started: "Your download has started.",
    failed: "Couldn't start the download.",
    share: "Download and share",
  },
};

/** Web Settings → Company details, said to whoever runs the company. */
export const KIN_COMPANY_SETTINGS = {
  purpose:
    "Your company on paper, as invoices and receipts show it, seen only by you and your co-owners.",
  company: "Company",
  companyDetail: "Agents read these only for work that needs them, like an invoice.",
  bank: "Bank account",
  bankNeeded: "Invoices need it",
  legalName: "Name and address",
  notSet: "Not set",
  editTitle: "Edit company details",
  save: "Save details",
  countryHelp: "Its two-letter code, like IN, GB or US.",
  exportRow: "Download everything",
  exportDetail: "A copy of your company's work in Kin, in one zip",
  exportSubmit: "Download",
  timeAndLimits: "Time and limits",
  timeZoneDetail: (zone: string) => `${zone} · check-ins and due days follow it`,
  timeZoneFromHost: (zone: string) => `${zone}, this computer's · none set yet`,
  timeZoneFailed: "Couldn't change the time zone.",
  takeZone: (zone: string) => `Use ${zone}`,
};

export type KinCompanyFieldId =
  | "legalName"
  | "tradeName"
  | "address"
  | "country"
  | "financialYearStartMonth"
  | "taxName"
  | "taxRate"
  | "gstin"
  | "notRegistered"
  | "pan"
  | "placeOfSupply"
  | "sac"
  | "lutNumber"
  | "lutDate"
  | "accountName"
  | "accountNumber"
  | "ifsc"
  | "bankName"
  | "branch"
  | "upi";

export type KinCompanyDraft = Readonly<Record<KinCompanyFieldId, string>>;

interface FieldSpec {
  readonly id: KinCompanyFieldId;
  readonly label: string;
  readonly placeholder?: string;
  readonly multiline?: true;
  /** Ids written in capitals with no spaces. */
  readonly code?: true;
  /** A calendar day, picked rather than typed. */
  readonly day?: true;
  readonly problem?: string;
  /** Shown only for a company in India, or only for one elsewhere. */
  readonly india?: boolean;
  /** An invoice needs it: read as "Not set" while empty, so a gap is seen. */
  readonly invoice?: true;
  /** A yes-or-no choice: the draft holds "yes" or "". */
  readonly choice?: true;
}

/** The form in the order an invoice needs it. */
const KIN_COMPANY_SECTIONS: ReadonlyArray<{
  readonly title: string;
  readonly fields: ReadonlyArray<FieldSpec>;
}> = [
  {
    title: "Company",
    fields: [
      { id: "legalName", label: "Legal name", invoice: true },
      { id: "tradeName", label: "Trading name" },
      {
        id: "address",
        label: "Registered address",
        placeholder: "Street, city and postal code",
        multiline: true,
        invoice: true,
      },
    ],
  },
  {
    title: "Tax",
    fields: [
      {
        id: "country",
        label: "Country",
        placeholder: "Two-letter code",
        code: true,
        invoice: true,
        problem: "A country is its two-letter code, like GB, US or IN.",
      },
      {
        id: "financialYearStartMonth",
        label: "Financial year starts in",
        placeholder: "Month",
        problem: "Name the month the year starts in, like January or April.",
      },
      {
        id: "taxName",
        label: "Tax charged",
        placeholder: "Name of the tax",
        india: false,
        problem: "Name the tax in 40 characters or fewer, like VAT.",
      },
      {
        id: "taxRate",
        label: "Tax rate, in percent",
        india: false,
        problem: "Write the rate as a percent from 0 to 100, like 20 or 7.5.",
      },
      {
        id: "gstin",
        label: "GSTIN",
        india: true,
        code: true,
        invoice: true,
        problem: "A GSTIN is 15 characters, like 29ABCDE1234F1Z5.",
      },
      { id: "notRegistered", label: "Not registered for GST", india: true, choice: true },
      {
        id: "pan",
        india: true,
        label: "PAN",
        code: true,
        problem: "A PAN is 10 characters, like ABCDE1234F.",
      },
      { id: "placeOfSupply", india: true, label: "Place of supply", invoice: true },
      {
        id: "sac",
        india: true,
        label: "Usual SAC code",
        problem: "A SAC code is 4 to 8 digits.",
      },
      {
        id: "lutNumber",
        india: true,
        label: "LUT ARN, for exports",
        code: true,
        problem: "An LUT ARN is 8 to 20 letters and digits.",
      },
      {
        id: "lutDate",
        india: true,
        label: "LUT filed on",
        day: true,
        problem: "Write the day as YYYY-MM-DD, like 2026-04-01.",
      },
    ],
  },
  {
    title: "Bank",
    fields: [
      { id: "accountName", label: "Account name", invoice: true },
      {
        id: "accountNumber",
        label: "Account number",
        code: true,
        invoice: true,
        problem: "An account number is 6 to 34 letters and digits.",
      },
      {
        id: "ifsc",
        india: true,
        label: "IFSC",
        code: true,
        invoice: true,
        problem: "An IFSC is 11 characters, like HDFC0001234.",
      },
      { id: "bankName", label: "Bank", invoice: true },
      { id: "branch", label: "Branch" },
      {
        id: "upi",
        india: true,
        label: "UPI ID",
        placeholder: "name@bank",
        problem: "A UPI ID looks like name@bank.",
      },
    ],
  },
];

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
/** A month typed as its name, its first three letters or its number. */
const monthOf = (text: string): number | null => {
  const typed = text.trim().toLowerCase();
  if (/^\d{1,2}$/.test(typed))
    return Number(typed) >= 1 && Number(typed) <= 12 ? Number(typed) : null;
  const index = MONTHS.findIndex(
    (name) => typed.length >= 3 && name.toLowerCase().startsWith(typed),
  );
  return index === -1 ? null : index + 1;
};
const MONEY_FIELDS = ["country", "financialYearStartMonth", "taxName", "taxRate"] as const;
const isMoneyField = (id: KinCompanyFieldId): id is (typeof MONEY_FIELDS)[number] =>
  (MONEY_FIELDS as ReadonlyArray<string>).includes(id);

const BANK = ["accountName", "accountNumber", "ifsc", "bankName", "branch", "upi"] as const;
const isBank = (id: KinCompanyFieldId): id is (typeof BANK)[number] =>
  (BANK as ReadonlyArray<string>).includes(id);

const valid: Record<KinCompanyFieldId, (value: string | null) => boolean> = {
  country: Schema.is(Schema.NullOr(KinCountryCode)),
  financialYearStartMonth: (value) => value !== null && monthOf(value) !== null,
  taxName: Schema.is(Schema.NullOr(KinCompanyTax.fields.name)),
  taxRate: Schema.is(KinCompanyTax.fields.rate),
  legalName: Schema.is(KinCompanyProfileData.fields.legalName),
  tradeName: Schema.is(KinCompanyProfileData.fields.tradeName),
  address: Schema.is(KinCompanyProfileData.fields.address),
  gstin: Schema.is(KinCompanyProfileData.fields.gstin),
  notRegistered: () => true,
  pan: Schema.is(KinCompanyProfileData.fields.pan),
  placeOfSupply: Schema.is(KinCompanyProfileData.fields.placeOfSupply),
  sac: Schema.is(KinCompanyProfileData.fields.sac),
  lutNumber: Schema.is(KinCompanyProfileData.fields.lutNumber),
  lutDate: Schema.is(KinCompanyProfileData.fields.lutDate),
  accountName: Schema.is(KinCompanyBank.fields.accountName),
  accountNumber: Schema.is(KinCompanyBank.fields.accountNumber),
  ifsc: Schema.is(KinCompanyBank.fields.ifsc),
  bankName: Schema.is(KinCompanyBank.fields.bankName),
  branch: Schema.is(KinCompanyBank.fields.branch),
  upi: Schema.is(KinCompanyBank.fields.upi),
};

const YES = "yes";
const stored = (profile: KinCompanyProfile, id: KinCompanyFieldId): string | null => {
  if (isBank(id)) return profile.bank[id];
  switch (id) {
    case "country":
      return profile.country ?? null;
    case "financialYearStartMonth":
      return MONTHS[(profile.financialYearStartMonth ?? 4) - 1] ?? null;
    case "taxName":
      return profile.tax?.name ?? null;
    case "taxRate":
      return profile.tax?.rate ?? null;
    case "notRegistered":
      return profile.taxRegistered === false ? YES : null;
    default:
      return profile[id] ?? null;
  }
};

/** This device's region, such as GB from en-GB; null where its locale names none. */
export function kinDeviceRegion(): string | null {
  try {
    const locale =
      (typeof navigator === "undefined" ? undefined : navigator.language) ??
      Intl.DateTimeFormat().resolvedOptions().locale;
    return /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?-([A-Z]{2})\b/.exec(locale)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The form as the profile reads. A company that never saved its details is offered `region`, the
 * device's, as its country: saving it brings that country's currency, year and tax. A new company
 * still `waiting` on its country gets it only as a suggestion (`kinCompanyCountrySuggestion`).
 */
export const kinCompanyDraftOf = (
  profile: KinCompanyProfile,
  region: string | null = null,
  waiting = false,
): KinCompanyDraft => {
  const draft = Object.fromEntries(
    KIN_COMPANY_SECTIONS.flatMap((section) =>
      section.fields.map((field) => [field.id, stored(profile, field.id) ?? ""]),
    ),
  ) as KinCompanyDraft;
  return !waiting && profile.rev === 0 && region !== null ? { ...draft, country: region } : draft;
};

/** "India" for IN, or the code where this device can't name it. */
export const kinCountryName = (code: string): string => {
  try {
    return new Intl.DisplayNames(undefined, { type: "region", fallback: "none" }).of(code) ?? code;
  } catch {
    return code;
  }
};

/**
 * The device's country offered to a company still waiting on its own, while none is typed: it is
 * in the draft only once accepted, so a save that didn't choose a country never sets one.
 */
export const kinCompanyCountrySuggestion = (
  draft: KinCompanyDraft,
  region: string | null,
  waiting: boolean,
): { readonly label: string; readonly accept: () => KinCompanyDraft } | null =>
  !waiting || region === null || draft.country.trim() !== "" || !valid.country(region)
    ? null
    : {
        label: KIN_COMPANY.useCountry(kinCountryName(region)),
        accept: () => ({ ...draft, country: region }),
      };

/**
 * The form's sections for a company in `country`: India's tax ids only for India, and for a host
 * too old to say; the company's own tax everywhere else.
 */
const kinCompanySections = (country: string | null | undefined) => {
  const india = country === undefined || country === "IN";
  return KIN_COMPANY_SECTIONS.map((section) => ({
    ...section,
    fields: section.fields.filter((field) => field.india === undefined || field.india === india),
  }));
};

/**
 * The draft after a tap on a choice: saying the company isn't registered clears its tax number,
 * and typing a number unsays it.
 */
export const kinCompanyDraftEdit = (
  draft: KinCompanyDraft,
  id: KinCompanyFieldId,
  value: string | boolean,
): KinCompanyDraft => {
  if (id === "notRegistered")
    return value === true
      ? { ...draft, notRegistered: YES, gstin: "" }
      : { ...draft, notRegistered: "" };
  const next = { ...draft, [id]: typeof value === "string" ? value : "" };
  return id === "gstin" && String(value).trim() !== "" ? { ...next, notRegistered: "" } : next;
};

/** The sections while editing: they follow the country typed, once it is a whole code. */
export const kinCompanyEditSections = (profile: KinCompanyProfile, draft: KinCompanyDraft) => {
  const typed = draft.country.trim().toUpperCase();
  return kinCompanySections(
    profile.country === undefined
      ? undefined
      : typed === ""
        ? null
        : /^[A-Z]{2}$/.test(typed)
          ? typed
          : profile.country,
  );
};

/** Nothing has been filled in yet. */
export const kinCompanyEmpty = (profile: KinCompanyProfile) =>
  Object.entries(kinCompanyDraftOf(profile)).every(
    ([id, value]) => isMoneyField(id as KinCompanyFieldId) || value === "",
  );

/** What was typed as the host keeps it: trimmed, ids in capitals without spaces, empty as none. */
const cleaned = (field: FieldSpec, text: string): string | null => {
  const value = field.code ? text.replace(/[\s-]/g, "").toUpperCase() : text.trim();
  return value === "" ? null : value;
};

/**
 * The edit as the host takes it: only what changed, with `null` clearing a field. `input` is null
 * when nothing changed; `problems` names each field that can't be saved as typed.
 */
export function kinCompanyInput(
  orgId: KinOrgId,
  profile: KinCompanyProfile,
  draft: KinCompanyDraft,
):
  | { readonly ok: true; readonly input: KinCompanyProfileSetInput | null }
  | {
      readonly ok: false;
      readonly problems: Readonly<Partial<Record<KinCompanyFieldId, string>>>;
    } {
  const problems: Partial<Record<KinCompanyFieldId, string>> = {};
  const top: Record<string, unknown> = {};
  const bank: Record<string, string | null> = {};
  const money: Partial<Record<(typeof MONEY_FIELDS)[number], string | null>> = {};
  for (const field of KIN_COMPANY_SECTIONS.flatMap((section) => section.fields)) {
    const value = cleaned(field, draft[field.id]);
    if (value === stored(profile, field.id)) continue;
    if (!valid[field.id](value)) {
      problems[field.id] = field.problem ?? `${field.label} is too long.`;
      continue;
    }
    if (isMoneyField(field.id)) money[field.id] = value;
    else if (field.id === "notRegistered") top.taxRegistered = value === null ? null : false;
    else (isBank(field.id) ? bank : top)[field.id] = value;
  }
  if (money.country !== undefined) top.country = money.country;
  if (money.financialYearStartMonth != null)
    top.financialYearStartMonth = monthOf(money.financialYearStartMonth);
  if (money.taxName !== undefined || money.taxRate !== undefined) {
    const name = money.taxName === undefined ? (profile.tax?.name ?? null) : money.taxName;
    const rate = money.taxRate === undefined ? (profile.tax?.rate ?? null) : money.taxRate;
    if (name === null && rate !== null)
      problems.taxName = "Name the tax this rate is for, like VAT.";
    else
      top.tax =
        name === null ? null : { name, rate, pricesInclude: profile.tax?.pricesInclude ?? null };
  }
  if (Object.keys(problems).length > 0) return { ok: false, problems };
  if (Object.keys(top).length === 0 && Object.keys(bank).length === 0)
    return { ok: true, input: null };
  return {
    ok: true,
    input: {
      orgId,
      rev: profile.rev,
      ...top,
      ...(Object.keys(bank).length === 0 ? {} : { bank }),
    } as KinCompanyProfileSetInput,
  };
}

/** "Apr 1, 2026" for a stored `YYYY-MM-DD`; anything else as it was written. */
const readDay = (day: string) => (/^\d{4}-\d{2}-\d{2}$/.test(day) ? kinRateDay(day) : day);

/** The filled-in fields of a section, to read. */
export function kinCompanyRead(profile: KinCompanyProfile): ReadonlyArray<{
  readonly title: string;
  readonly rows: ReadonlyArray<{
    readonly id: KinCompanyFieldId;
    readonly label: string;
    readonly value: string;
    /** Empty, and an invoice needs it: `value` is "Not set". */
    readonly missing: boolean;
  }>;
}> {
  // A UPI id is a way to be paid too: with one, the account's details are no gap.
  const paid = profile.bank.accountNumber !== null || profile.bank.upi !== null;
  return kinCompanySections(profile.country).map((section) => ({
    title: section.title,
    rows: section.fields.flatMap((field) => {
      if (field.choice) return [];
      // A company not registered has no tax number to set: that is no gap.
      if (field.id === "gstin" && profile.taxRegistered === false)
        return [
          { id: field.id, label: field.label, value: KIN_COMPANY.notRegistered, missing: false },
        ];
      const value = stored(profile, field.id);
      const missing = value === null && field.invoice === true && !(paid && isBank(field.id));
      if (value === null && !missing) return [];
      const shown = value === null ? KIN_COMPANY.notSet : field.day ? readDay(value) : value;
      return [{ id: field.id, label: field.label, value: shown, missing }];
    }),
  }));
}

/**
 * The phone's one screen to read: the country in words and the tax as one line ("VAT at 20%");
 * the year's first month stays on the computer's page.
 */
export function kinCompanyGlance(profile: KinCompanyProfile): ReturnType<typeof kinCompanyRead> {
  const rate = profile.tax?.rate ?? null;
  return kinCompanyRead(profile)
    .map((section) => ({
      ...section,
      rows: section.rows.flatMap((row) => {
        if (row.id === "financialYearStartMonth" || row.id === "taxRate") return [];
        if (row.missing) return [row];
        if (row.id === "country") return [{ ...row, value: kinCountryName(row.value) }];
        if (row.id === "taxName" && rate !== null)
          return [{ ...row, value: `${row.value} at ${rate}%` }];
        return [row];
      }),
    }))
    .filter((section) => section.rows.length > 0);
}
