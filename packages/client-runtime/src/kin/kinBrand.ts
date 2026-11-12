import {
  KIN_RECIPE_FONTS,
  type AssetResource,
  type KinCompanyBrand,
  type KinCompanyLogo,
  type KinCompanyProfile,
  type KinCompanyProfileSetInput,
  type KinOrgId,
} from "@t3tools/contracts";

export const KIN_BRAND = {
  title: "Brand",
  detail: "How the company's invoices and receipts look.",
  logo: "Logo",
  noLogo: "No logo yet.",
  addLogo: "To add one, send the image to an agent in a chat and ask it to use it as the logo.",
  changeLogo: "To change it, send the new image to an agent in a chat.",
  askLogo: "Send a logo",
  askLogoDraft: "Here is our company logo. Please use it on our invoices and receipts.",
  removeLogo: "Remove logo",
  removeTitle: "Remove the logo?",
  removeDetail:
    "New invoices and receipts are made without it. Send it to an agent again to add it back.",
  primary: "Main colour",
  secondary: "Second colour",
  colorPlaceholder: "#1F4E79",
  font: "Font",
  defaultFont: "The template's own",
  footer: "Footer line",
  footerPlaceholder: "Thank you for your business",
  sample: "Sample",
  edit: "Edit brand",
  save: "Save",
  cancel: "Cancel",
  saved: "Saved. New documents use it.",
  badColor: "Use a colour like #1F4E79.",
};

/** Colours a phone offers as taps beside the hex field; the field takes any. */
export const KIN_BRAND_SWATCHES = [
  "#1F4E79",
  "#0F766E",
  "#166534",
  "#7C2D12",
  "#B4532A",
  "#9F1239",
  "#5B21B6",
  "#1F2937",
] as const;

export const KIN_BRAND_FONTS: ReadonlyArray<KinCompanyBrand["font"] & string> = KIN_RECIPE_FONTS;

/** `#abc`, `abc` or `#AABBCC` as `#AABBCC`; `null` when empty; `undefined` when it isn't a colour. */
export function kinHexColor(text: string): string | null | undefined {
  const typed = text.trim().replace(/^#/, "");
  if (typed === "") return null;
  if (/^[0-9a-f]{3}$/i.test(typed))
    return `#${[...typed].map((digit) => digit + digit).join("")}`.toUpperCase();
  return /^[0-9a-f]{6}$/i.test(typed) ? `#${typed}`.toUpperCase() : undefined;
}

const channel = (hex: string, at: number) => {
  const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

/** WCAG contrast of the colour against white paper, 1 to 21. */
function kinContrastOnWhite(hex: string): number {
  const luminance = 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
  return 1.05 / (luminance + 0.05);
}

/** A line under a colour field: whether text in it reads on white paper. */
export function kinContrastHint(
  text: string,
): { readonly ok: boolean; readonly text: string } | null {
  const hex = kinHexColor(text);
  if (hex === null) return null;
  if (hex === undefined) return { ok: false, text: KIN_BRAND.badColor };
  const ratio = kinContrastOnWhite(hex);
  const shown = `${(Math.floor(ratio * 10) / 10).toFixed(1)}:1`;
  return ratio >= 4.5
    ? { ok: true, text: `Reads well on white (${shown}).` }
    : { ok: false, text: `Hard to read on white (${shown}). Fine for lines and fills, not text.` };
}

export interface KinBrandDraft {
  readonly primaryColor: string;
  readonly secondaryColor: string;
  readonly font: KinCompanyBrand["font"];
  readonly footer: string;
}

export const kinBrandDraftOf = (brand: KinCompanyBrand): KinBrandDraft => ({
  primaryColor: brand.primaryColor ?? "",
  secondaryColor: brand.secondaryColor ?? "",
  font: brand.font,
  footer: brand.footer ?? "",
});

export type KinBrandField = "primaryColor" | "secondaryColor" | "footer";

/** What Save sends: only what changed, `null` when nothing did, or why it can't be saved. */
export function kinBrandInput(
  orgId: KinOrgId,
  profile: Pick<KinCompanyProfile, "rev" | "brand">,
  draft: KinBrandDraft,
):
  | { readonly ok: true; readonly input: KinCompanyProfileSetInput | null }
  | { readonly ok: false; readonly problems: Partial<Record<KinBrandField, string>> } {
  const primaryColor = kinHexColor(draft.primaryColor);
  const secondaryColor = kinHexColor(draft.secondaryColor);
  const footer = draft.footer.trim().replace(/\s+/g, " ");
  const problems: Partial<Record<KinBrandField, string>> = {
    ...(primaryColor === undefined ? { primaryColor: KIN_BRAND.badColor } : {}),
    ...(secondaryColor === undefined ? { secondaryColor: KIN_BRAND.badColor } : {}),
    ...(footer.length > 300 ? { footer: "Keep the footer to 300 characters." } : {}),
  };
  if (primaryColor === undefined || secondaryColor === undefined || problems.footer !== undefined)
    return { ok: false, problems };
  const next: KinCompanyBrand = {
    primaryColor,
    secondaryColor,
    font: draft.font,
    footer: footer === "" ? null : footer,
  };
  const brand = Object.fromEntries(
    (Object.keys(next) as Array<keyof KinCompanyBrand>)
      .filter((key) => next[key] !== profile.brand[key])
      .map((key) => [key, next[key]]),
  );
  return Object.keys(brand).length === 0
    ? { ok: true, input: null }
    : { ok: true, input: { orgId, rev: profile.rev, brand } };
}

export const kinLogoRemoveInput = (
  orgId: KinOrgId,
  profile: Pick<KinCompanyProfile, "rev">,
): KinCompanyProfileSetInput => ({ orgId, rev: profile.rev, logo: null });

/** Kin's copy of the logo, as the asset the client reads to show it. */
export const kinLogoResource = (logo: KinCompanyLogo): AssetResource => ({
  _tag: "attachment",
  attachmentId: logo.attachmentId,
  fileName: logo.name,
  mimeType: logo.mimeType,
});

/** The sample header's look: what a template with no brand of its own falls back to. */
export function kinBrandSample(draft: KinBrandDraft) {
  const primary = kinHexColor(draft.primaryColor);
  const secondary = kinHexColor(draft.secondaryColor);
  return {
    primary: typeof primary === "string" ? primary : "#1F2937",
    secondary: typeof secondary === "string" ? secondary : "#6B7280",
    font: draft.font,
    footer: draft.footer.trim() === "" ? null : draft.footer.trim(),
  };
}
