import {
  KinCompanyBank,
  KinCompanyProfileData,
  type KinCompanyProfile,
  type KinCompanyProfileSetInput,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** The company's legal and bank details, as the owner reads and edits them in Settings. */

export const KIN_COMPANY = {
  title: "Company details",
  summary: "Legal name, tax ids and bank details",
  private:
    "Private. Only you see these. Your agents read them only when you ask for something that needs them, like an invoice.",
  loadFailed: "Couldn't load your company details",
  edit: "Edit",
  save: "Save",
  cancel: "Cancel",
  saved: "Saved.",
  notSet: "Not set",
  empty: "Nothing here yet. Add what goes on your invoices.",
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
};

export type KinCompanyFieldId =
  | "legalName"
  | "tradeName"
  | "address"
  | "gstin"
  | "pan"
  | "placeOfSupply"
  | "sac"
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
  readonly placeholder: string;
  readonly multiline?: true;
  /** Ids written in capitals with no spaces. */
  readonly code?: true;
  readonly problem?: string;
}

/** The form in the order an invoice needs it. */
export const KIN_COMPANY_SECTIONS: ReadonlyArray<{
  readonly title: string;
  readonly fields: ReadonlyArray<FieldSpec>;
}> = [
  {
    title: "Company",
    fields: [
      { id: "legalName", label: "Legal name", placeholder: "Acme Studio Private Limited" },
      { id: "tradeName", label: "Trading name", placeholder: "Acme Studio" },
      {
        id: "address",
        label: "Registered address",
        placeholder: "Street, city, state and PIN code",
        multiline: true,
      },
    ],
  },
  {
    title: "Tax",
    fields: [
      {
        id: "gstin",
        label: "GSTIN",
        placeholder: "29ABCDE1234F1Z5",
        code: true,
        problem: "A GSTIN is 15 characters, like 29ABCDE1234F1Z5.",
      },
      {
        id: "pan",
        label: "PAN",
        placeholder: "ABCDE1234F",
        code: true,
        problem: "A PAN is 10 characters, like ABCDE1234F.",
      },
      { id: "placeOfSupply", label: "Place of supply", placeholder: "Karnataka" },
      {
        id: "sac",
        label: "Usual SAC code",
        placeholder: "998314",
        problem: "A SAC code is 4 to 8 digits.",
      },
    ],
  },
  {
    title: "Bank",
    fields: [
      { id: "accountName", label: "Account name", placeholder: "Acme Studio Private Limited" },
      {
        id: "accountNumber",
        label: "Account number",
        placeholder: "50200012345678",
        code: true,
        problem: "An account number is 6 to 34 letters and digits.",
      },
      {
        id: "ifsc",
        label: "IFSC",
        placeholder: "HDFC0001234",
        code: true,
        problem: "An IFSC is 11 characters, like HDFC0001234.",
      },
      { id: "bankName", label: "Bank", placeholder: "HDFC Bank" },
      { id: "branch", label: "Branch", placeholder: "Indiranagar, Bengaluru" },
      {
        id: "upi",
        label: "UPI ID",
        placeholder: "acme@hdfcbank",
        problem: "A UPI ID looks like name@bank.",
      },
    ],
  },
];

const BANK = ["accountName", "accountNumber", "ifsc", "bankName", "branch", "upi"] as const;
const isBank = (id: KinCompanyFieldId): id is (typeof BANK)[number] =>
  (BANK as ReadonlyArray<string>).includes(id);

const valid: Record<KinCompanyFieldId, (value: string | null) => boolean> = {
  legalName: Schema.is(KinCompanyProfileData.fields.legalName),
  tradeName: Schema.is(KinCompanyProfileData.fields.tradeName),
  address: Schema.is(KinCompanyProfileData.fields.address),
  gstin: Schema.is(KinCompanyProfileData.fields.gstin),
  pan: Schema.is(KinCompanyProfileData.fields.pan),
  placeOfSupply: Schema.is(KinCompanyProfileData.fields.placeOfSupply),
  sac: Schema.is(KinCompanyProfileData.fields.sac),
  accountName: Schema.is(KinCompanyBank.fields.accountName),
  accountNumber: Schema.is(KinCompanyBank.fields.accountNumber),
  ifsc: Schema.is(KinCompanyBank.fields.ifsc),
  bankName: Schema.is(KinCompanyBank.fields.bankName),
  branch: Schema.is(KinCompanyBank.fields.branch),
  upi: Schema.is(KinCompanyBank.fields.upi),
};

const stored = (profile: KinCompanyProfile, id: KinCompanyFieldId): string | null =>
  isBank(id) ? profile.bank[id] : profile[id];

export const kinCompanyDraftOf = (profile: KinCompanyProfile): KinCompanyDraft =>
  Object.fromEntries(
    KIN_COMPANY_SECTIONS.flatMap((section) =>
      section.fields.map((field) => [field.id, stored(profile, field.id) ?? ""]),
    ),
  ) as KinCompanyDraft;

/** Nothing has been filled in yet. */
export const kinCompanyEmpty = (profile: KinCompanyProfile) =>
  Object.values(kinCompanyDraftOf(profile)).every((value) => value === "");

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
  const top: Record<string, string | null> = {};
  const bank: Record<string, string | null> = {};
  for (const field of KIN_COMPANY_SECTIONS.flatMap((section) => section.fields)) {
    const value = cleaned(field, draft[field.id]);
    if (value === stored(profile, field.id)) continue;
    if (!valid[field.id](value)) {
      problems[field.id] = field.problem ?? `${field.label} is too long.`;
      continue;
    }
    (isBank(field.id) ? bank : top)[field.id] = value;
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

/** The filled-in fields of a section, to read. */
export function kinCompanyRead(profile: KinCompanyProfile): ReadonlyArray<{
  readonly title: string;
  readonly rows: ReadonlyArray<{
    readonly id: KinCompanyFieldId;
    readonly label: string;
    readonly value: string;
  }>;
}> {
  return KIN_COMPANY_SECTIONS.map((section) => ({
    title: section.title,
    rows: section.fields.flatMap((field) => {
      const value = stored(profile, field.id);
      return value === null ? [] : [{ id: field.id, label: field.label, value }];
    }),
  }));
}
