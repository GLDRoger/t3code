/**
 * What a company's country decides for it: the currency it keeps its books in, the month its
 * financial year starts, the tax it charges and what its tax id is called, the filings its Dates
 * list starts with, and the locale Kin's text is written in where Kin has one. One row per
 * country, by ISO 3166 code; a country with no row has none of them.
 */

export interface CompanyRegion {
  readonly currency: string;
  readonly financialYearStartMonth: number;
  /** The tax a company here charges, as its invoices name it. */
  readonly tax: string;
  readonly taxIdLabel: string;
  /** The Dates list's first categories: the filings this country asks of a company. */
  readonly filings: ReadonlyArray<readonly [key: string, label: string]>;
  /** The locale server text for a company here is written in; it picks the clock. */
  readonly locale?: string;
  /** A client here pays an invoice less tax it withholds at source (TDS). */
  readonly withholdsAtSource?: true;
  /** Company details keep the company's tax number here (the profile's `gstin`). */
  readonly keepsTaxNumber?: true;
  /** What a document says in place of its tax lines when the company is not registered for it. */
  readonly notRegistered?: string;
}

const vat = (currency: string, financialYearStartMonth = 1): CompanyRegion => ({
  currency,
  financialYearStartMonth,
  tax: "VAT",
  taxIdLabel: "VAT number",
  filings: [["vat", "VAT"]],
});

const REGIONS: Readonly<Record<string, CompanyRegion>> = {
  IN: {
    // oxlint-disable-next-line t3code/kin-one-format -- the region table is where India's currency lives.
    currency: "INR",
    financialYearStartMonth: 4,
    tax: "GST",
    taxIdLabel: "GSTIN",
    filings: [
      ["gst", "GST"],
      ["tds", "TDS"],
    ],
    withholdsAtSource: true,
    keepsTaxNumber: true,
    notRegistered: "GST not charged: the supplier is not registered under GST.",
    // oxlint-disable-next-line t3code/kin-one-format -- the region table is where India's locale lives.
    locale: "en-IN",
  },
  GB: {
    ...vat("GBP", 4),
    filings: [
      ["vat", "VAT"],
      ["paye", "PAYE"],
    ],
    // oxlint-disable-next-line t3code/kin-one-format -- the region table is where the UK's locale lives.
    locale: "en-GB",
  },
  US: {
    currency: "USD",
    financialYearStartMonth: 1,
    tax: "Sales tax",
    taxIdLabel: "EIN",
    filings: [["sales tax", "Sales tax"]],
    // oxlint-disable-next-line t3code/kin-one-format -- the region table is where the US locale lives.
    locale: "en-US",
  },
  AU: {
    currency: "AUD",
    financialYearStartMonth: 7,
    tax: "GST",
    taxIdLabel: "ABN",
    filings: [
      ["bas", "BAS"],
      ["payg", "PAYG"],
    ],
  },
  NZ: {
    currency: "NZD",
    financialYearStartMonth: 4,
    tax: "GST",
    taxIdLabel: "GST number",
    filings: [["gst", "GST"]],
  },
  CA: {
    currency: "CAD",
    financialYearStartMonth: 1,
    tax: "GST",
    taxIdLabel: "Business number",
    filings: [["gst", "GST/HST"]],
  },
  SG: {
    currency: "SGD",
    financialYearStartMonth: 1,
    tax: "GST",
    taxIdLabel: "GST registration number",
    filings: [["gst", "GST"]],
  },
  AE: { ...vat("AED"), taxIdLabel: "TRN" },
  IE: vat("EUR"),
  DE: vat("EUR"),
  FR: vat("EUR"),
  NL: vat("EUR"),
  ES: vat("EUR"),
  IT: vat("EUR"),
};

/** The country's row; none for a country with no row, or none at all. */
export const regionOf = (country: string | null | undefined): CompanyRegion | undefined =>
  country == null || !Object.hasOwn(REGIONS, country) ? undefined : REGIONS[country];

/** The tax a company here charges and what its documents say when it is not registered for it. */
export const unregisteredTax = (country: string | null, ownTax: string | undefined) => {
  const region = regionOf(country);
  const tax = region?.tax ?? ownTax ?? "Tax";
  return {
    tax,
    taxIdLabel: region?.taxIdLabel ?? "tax number",
    line: region?.notRegistered ?? `${tax} not charged: the supplier is not registered for ${tax}.`,
  };
};

/**
 * The locale Kin writes a company's text in: its country's, or for a company in no country, that
 * of the country whose currency it keeps, as before countries were set.
 */
export const localeOf = (country: string | null, currency: string): string | undefined =>
  country !== null
    ? regionOf(country)?.locale
    : Object.values(REGIONS).find((one) => one.locale !== undefined && one.currency === currency)
        ?.locale;
