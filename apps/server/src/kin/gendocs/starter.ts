/** The files a new workspace starts with, as they are copied into it: its README and three recipes. */
export const STARTER_FILES: Readonly<Record<string, string>> = {
  "README.md": String.raw`# Kin workspace

This repository holds the company's recipes: how its documents are made. Kin keeps it on the
host, never pushes it anywhere, and runs every recipe inside a worker's sandbox.

## A recipe

A folder recipes/<name>/ with RECIPE.md and whatever the recipe uses: a script, a Typst
template, a config file, a logo. <name> is lowercase letters, digits and dashes.

RECIPE.md starts with front matter between --- lines:

- name: the folder's name.
- title: what the document is called, such as Quote. Shown in chats others can read, so never a
  client's name or an amount.
- description: one line on what it makes and when to use it.
- list (optional): the list whose entry it is made for, such as invoices. Jobs then name an entry.
- numbered (optional): the document carries the number Kin issues for the entry.
- sensitive (optional): its inputs or the result are for the owner alone.
- tools (optional): [typst] when it makes a PDF with Typst.
- inputs: each input's type (text, integer, decimal, money, date, month,
  boolean or table with columns), whether it is required, a description, and from:
  - nothing, for a value the agent gives;
  - entry.key, entry.title, entry.state, entry.amount, entry.tax, entry.date, entry.due,
    entry.notes, entry.number or entry.fields.<field>: the entry the job is for;
  - client.name, client.gstin, client.placeOfSupply, client.terms: that entry's client;
  - company.legalName, company.tradeName, company.address, company.gstin, company.pan,
    company.placeOfSupply, company.sac, company.bank.<accountName|accountNumber|ifsc|bankName|branch|upi>;
  - rows.<list> (a table, with period: naming a month input): that list's entries dated in the
    month, with columns from key, title, state, amount, tax, date, due, client,
    category, number and field_<field>;
  - payments (a table, with period:): payments received in the month, with columns invoice,
    client, amount, paidOn;
  - system.number, system.draft, system.today.
- outputs: the file names it writes in out/, * for a part that varies.

The body says how to make it: the command to run and anything the worker must check.

## How a job runs

Kin writes the inputs to in/inputs.json in a fresh worktree: exactly the inputs the recipe
declares, money as { "minor": 11800000, "currency": "INR" } (paise), days as 2026-11-12.
The worker follows the recipe and writes its files to out/, then names each one in its report.
Kin takes back only those files, and only PDF, PNG, JPEG, WebP, SVG, CSV, XLSX, DOCX, PPTX,
Markdown, text and JSON.

Scripts do all the arithmetic, in whole minor units. The worker and the agent never add up money.

Scripts run on the Node that runs Kin (no packages needed; node: built-ins only), and Typst
0.15 with its own fonts (--ignore-system-fonts). A recipe may install packages from the
registries the worker can reach, inside its worktree.

in/, out/ and build/ are never committed.
`,
  ".gitignore": String.raw`in/
out/
build/
node_modules/
`,
  "recipes/invoice/RECIPE.md": String.raw`---
name: invoice
title: Invoice
description: An Indian invoice for one invoice entry as a PDF. GST lines follow the company's and the client's state; a plain Invoice when the company has no GSTIN.
list: invoices
numbered: true
sensitive: true
tools: [typst]
inputs:
  invoiceKey: { type: text, from: entry.key }
  title: { type: text, from: entry.title }
  total: { type: money, from: entry.amount, required: false, description: "The entry's amount, tax included" }
  taxRecorded: { type: money, from: entry.tax, required: false }
  issuedOn: { type: date, from: entry.date, required: false }
  dueOn: { type: date, from: entry.due, required: false }
  number: { type: text, from: system.number, required: false }
  draft: { type: boolean, from: system.draft }
  today: { type: date, from: system.today }
  client: { type: text, from: client.name }
  clientGstin: { type: text, from: client.gstin, required: false }
  clientPlace: { type: text, from: client.placeOfSupply, required: false }
  supplier: { type: text, from: company.legalName }
  supplierTrade: { type: text, from: company.tradeName, required: false }
  supplierAddress: { type: text, from: company.address, required: false }
  supplierGstin: { type: text, from: company.gstin, required: false }
  supplierPan: { type: text, from: company.pan, required: false }
  supplierPlace: { type: text, from: company.placeOfSupply, required: false }
  sac: { type: text, from: company.sac, required: false }
  bankAccountName: { type: text, from: company.bank.accountName, required: false }
  bankAccountNumber: { type: text, from: company.bank.accountNumber, required: false }
  bankIfsc: { type: text, from: company.bank.ifsc, required: false }
  bankName: { type: text, from: company.bank.bankName, required: false }
  bankBranch: { type: text, from: company.bank.branch, required: false }
  bankUpi: { type: text, from: company.bank.upi, required: false }
  billTo: { type: text, required: false, description: "The client's billing address, as the owner gave it" }
  lines:
    type: table
    required: false
    description: "What was supplied, one row each, as the owner said it: quantity times rate is the taxable value. Leave out to bill the entry's amount as one line."
    columns: { description: text, sac: text, quantity: decimal, unit: text, rate: money }
  gstRate: { type: decimal, required: false, description: "GST percent; the recipe's default (18) unless the owner said otherwise" }
  exportUnderLut: { type: boolean, required: false, description: "For an export: false only when the owner said IGST is paid on it" }
  notes: { type: text, required: false }
outputs: [invoice.pdf]
---

Makes one invoice PDF from the entry, its client and the company profile.

Run, from the worktree root:

    node recipes/invoice/build.mjs in/inputs.json out

The script decides everything with money in it: each line's value (quantity times rate), the tax
lines (CGST and SGST, or UTGST, in the same state; IGST between states; none for an export under
a letter of undertaking, with the endorsement and the country), the total and the amount in
words. If the entry's amount and the lines don't agree, it stops and says by how much: report
that, don't change any figure. A draft (no number yet) carries a DRAFT mark.

Defaults the owner can change by asking are in config.json: the GST rate, the export
endorsements and the footer.
`,
  "recipes/invoice/build.mjs": String.raw`// Builds an Indian invoice from in/inputs.json. All arithmetic is here, in exact integers (paise).
// Usage, from the worktree root: node recipes/invoice/build.mjs in/inputs.json out
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

export const STATES = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh",
  "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh",
  "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur",
  "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal",
  "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka",
  "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
  "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
};
// Union territories without a legislature charge UTGST in place of SGST.
const UT_WITHOUT_LEGISLATURE = new Set(["04", "26", "31", "35", "38"]);

const fail = (message) => {
  throw new Error(message);
};

const norm = (text) => String(text).toLowerCase().replace(/[^a-z]/g, "");
/** A state code from a GSTIN, or from a place written as a state's name or code. */
export const stateOf = (gstin, place) => {
  if (gstin) return gstin.slice(0, 2);
  if (!place) return null;
  const code = /^\s*(\d{2})\b/.exec(place);
  if (code && STATES[code[1]]) return code[1];
  const wanted = norm(place);
  for (const [key, name] of Object.entries(STATES)) if (norm(name) === wanted) return key;
  if (wanted === "orissa") return "21";
  if (wanted === "pondicherry") return "34";
  return undefined;
};

/** A decimal string as an exact fraction: "1.5" is 15/10. */
const fraction = (text) => {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(text).trim());
  if (!match) fail("not a number: " + text);
  const digits = match[3] ?? "";
  const num = BigInt((match[1] === "-" ? "-" : "") + match[2] + digits);
  return { num, den: 10n ** BigInt(digits.length) };
};
/** Rounds num/den to the nearest integer, halves away from zero. */
const roundDiv = (num, den) => {
  const negative = num < 0n !== den < 0n;
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  const q = (2n * a + b) / (2n * b);
  return negative ? -q : q;
};
/** Paise of minor times a decimal factor, rounded once. */
export const times = (minor, factor) => {
  const f = fraction(factor);
  return roundDiv(BigInt(minor) * f.num, f.den);
};
/** Paise of minor times percent/100, rounded once. */
export const percentOf = (minor, percent) => {
  const f = fraction(percent);
  return roundDiv(BigInt(minor) * f.num, f.den * 100n);
};

const CURRENCIES = {
  INR: { symbol: "₹", major: "Rupees", minor: "Paise", indian: true },
  USD: { symbol: "US$", major: "US Dollars", minor: "Cents", indian: false },
  EUR: { symbol: "€", major: "Euros", minor: "Cents", indian: false },
  GBP: { symbol: "£", major: "Pounds", minor: "Pence", indian: false },
  AED: { symbol: "AED ", major: "Dirhams", minor: "Fils", indian: false },
  SGD: { symbol: "S$", major: "Singapore Dollars", minor: "Cents", indian: false },
};
const currencyOf = (code) => CURRENCIES[code] ?? { symbol: code + " ", major: code, minor: "cents", indian: false };

const group = (digits, indian) => {
  if (!indian || digits.length <= 3) return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const last = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return rest + "," + last;
};
/** "₹1,18,000.00" from paise. */
export const formatMoney = (minor, code) => {
  const value = BigInt(minor);
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const c = currencyOf(code);
  const major = (abs / 100n).toString();
  const cents = (abs % 100n).toString().padStart(2, "0");
  return sign + c.symbol + group(major, c.indian) + "." + cents;
};

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
const belowHundred = (n) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : ""));
const belowThousand = (n) => {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [hundreds ? ONES[hundreds] + " Hundred" : "", rest ? belowHundred(rest) : ""].filter(Boolean).join(" ");
};
/** Whole number in words: lakh and crore for Indian, million and billion otherwise. */
export const inWords = (value, indian) => {
  let n = BigInt(value);
  if (n === 0n) return "Zero";
  const parts = [];
  if (indian) {
    const crore = n / 10000000n;
    n %= 10000000n;
    if (crore > 0n) parts.push(inWords(crore, true) + " Crore");
    const lakh = Number(n / 100000n);
    n %= 100000n;
    if (lakh) parts.push(belowHundred(lakh) + " Lakh");
    const thousand = Number(n / 1000n);
    n %= 1000n;
    if (thousand) parts.push(belowHundred(thousand) + " Thousand");
    if (n > 0n) parts.push(belowThousand(Number(n)));
  } else {
    const scales = [[1000000000n, "Billion"], [1000000n, "Million"], [1000n, "Thousand"]];
    for (const [size, name] of scales) {
      const count = n / size;
      n %= size;
      if (count > 0n) parts.push(inWords(count, false) + " " + name);
    }
    if (n > 0n) parts.push(belowThousand(Number(n)));
  }
  return parts.join(" ");
};
export const amountInWords = (minor, code) => {
  const c = currencyOf(code);
  const value = BigInt(minor);
  const major = value / 100n;
  const cents = value % 100n;
  const words = c.major + " " + inWords(major, c.indian);
  return (cents > 0n ? words + " and " + inWords(cents, c.indian) + " " + c.minor : words) + " Only";
};

const formatDay = (day) => {
  if (!day) return null;
  const [y, m, d] = day.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return d + " " + months[m - 1] + " " + y;
};

/** The invoice as the template shows it: every figure computed here, as text. */
export const computeInvoice = (input, config) => {
  const supplierCode = stateOf(input.supplierGstin, input.supplierPlace);
  const registered = Boolean(input.supplierGstin);
  const clientCode = stateOf(input.clientGstin, input.clientPlace);
  const exported = clientCode === undefined;
  if (registered && clientCode === null)
    fail("there's no place of supply for " + input.client + ": give the client a GSTIN or a place of supply");
  if (registered && !supplierCode) fail("the company's state isn't known: set its GSTIN or place of supply");
  const rate = input.gstRate ?? config.defaultGstRate;
  const total = input.total;
  const currency = total?.currency ?? (input.lines?.find((line) => line.rate)?.rate?.currency ?? "INR");

  let lines = (input.lines ?? []).map((line, index) => {
    if (!line.description || !line.rate) fail("line " + (index + 1) + " needs a description and a rate");
    if (line.rate.currency !== currency) fail("every amount must be in " + currency);
    const quantity = line.quantity ?? "1";
    return { ...line, quantity, amount: times(line.rate.minor, quantity) };
  });
  const lut = input.exportUnderLut ?? true;
  const components = !registered
    ? []
    : exported
      ? lut ? [] : [{ name: "IGST", rate }]
      : supplierCode === clientCode
        ? [
            { name: "CGST", rate: half(rate) },
            { name: UT_WITHOUT_LEGISLATURE.has(clientCode) ? "UTGST" : "SGST", rate: half(rate) },
          ]
        : [{ name: "IGST", rate }];

  let taxable;
  let taxes;
  if (lines.length > 0) {
    taxable = lines.reduce((sum, line) => sum + line.amount, 0n);
    taxes = components.map((component) => ({ ...component, amount: percentOf(taxable, component.rate) }));
    const grand = taxable + taxes.reduce((sum, tax) => sum + tax.amount, 0n);
    if (total && BigInt(total.minor) !== grand)
      fail("the lines come to " + formatMoney(grand, currency) + " with tax, but " + input.invoiceKey +
        " is recorded at " + formatMoney(total.minor, currency) + ": correct the lines or the entry's amount");
  } else {
    if (!total) fail(input.invoiceKey + " has no amount and no lines were given");
    const whole = BigInt(total.minor);
    const allRates = components.reduce((sum, component) => addPercent(sum, component.rate), "0");
    if (input.taxRecorded && components.length === 0 && BigInt(input.taxRecorded.minor) !== 0n)
      fail(input.invoiceKey + " records tax, but this invoice carries none (" + (registered ? "export" : "no GSTIN") + ")");
    taxable = input.taxRecorded && components.length > 0
      ? whole - BigInt(input.taxRecorded.minor)
      : roundDiv(whole * 100n * fraction(allRates).den, 100n * fraction(allRates).den + fraction(allRates).num);
    const tax = whole - taxable;
    // Split so the parts add up to the recorded tax exactly.
    taxes = components.map((component, index) => ({
      ...component,
      amount: index === 0 && components.length === 2 ? tax / 2n : components.length === 2 ? tax - tax / 2n : tax,
    }));
    lines = [{ description: input.title, sac: input.sac, quantity: "1", unit: null, rate: { minor: Number(taxable), currency }, amount: taxable }];
  }
  const taxTotal = taxes.reduce((sum, tax) => sum + tax.amount, 0n);
  const grand = taxable + taxTotal;
  const money = (minor) => formatMoney(minor, currency);
  const endorsement = !exported
    ? null
    : registered && lut
      ? config.lutEndorsement
      : registered
        ? config.paidExportEndorsement
        : null;
  return {
    heading: registered ? "Tax Invoice" : "Invoice",
    draft: input.draft !== false || !input.number,
    number: input.number ?? null,
    key: input.invoiceKey,
    issuedOn: formatDay(input.issuedOn ?? input.today),
    dueOn: formatDay(input.dueOn),
    supplier: {
      name: input.supplier,
      trade: input.supplierTrade ?? null,
      address: input.supplierAddress ?? null,
      gstin: input.supplierGstin ?? null,
      pan: input.supplierPan ?? null,
      state: supplierCode ? STATES[supplierCode] + " (" + supplierCode + ")" : null,
    },
    recipient: {
      name: input.client,
      address: input.billTo ?? null,
      gstin: input.clientGstin ?? null,
      placeOfSupply: exported ? null : STATES[clientCode] + " (" + clientCode + ")",
      country: exported ? input.clientPlace : null,
    },
    lines: lines.map((line, index) => ({
      n: String(index + 1),
      description: line.description,
      sac: line.sac ?? input.sac ?? "",
      quantity: line.unit ? line.quantity + " " + line.unit : line.quantity,
      rate: money(line.rate.minor),
      amount: money(line.amount),
    })),
    taxable: money(taxable),
    taxes: taxes.map((tax) => ({ name: tax.name, rate: tax.rate + "%", amount: money(tax.amount) })),
    total: money(grand),
    totalMinor: Number(grand),
    taxMinor: Number(taxTotal),
    currency,
    words: amountInWords(grand, currency),
    reverseCharge: registered ? "No" : null,
    endorsement,
    bank: input.bankAccountNumber
      ? {
          name: input.bankAccountName ?? input.supplier,
          number: input.bankAccountNumber,
          ifsc: input.bankIfsc ?? null,
          bank: [input.bankName, input.bankBranch].filter(Boolean).join(", ") || null,
          upi: input.bankUpi ?? null,
        }
      : null,
    notes: input.notes ?? null,
    footer: config.footer,
  };
};
function half(rate) {
  const f = fraction(rate);
  const num = f.num * 10n;
  const den = f.den * 20n;
  // As a short decimal: 18 -> 9, 5 -> 2.5, 0.25 -> 0.125.
  let scale = 1n;
  let digits = 0;
  while ((num * scale) % den !== 0n && digits < 6) {
    scale *= 10n;
    digits += 1;
  }
  const whole = (num * scale) / den;
  const text = whole.toString().padStart(digits + 1, "0");
  return digits === 0 ? text : text.slice(0, -digits) + "." + text.slice(-digits);
}
function addPercent(a, b) {
  const x = fraction(a);
  const y = fraction(b);
  const den = x.den > y.den ? x.den : y.den;
  const sum = x.num * (den / x.den) + y.num * (den / y.den);
  const digits = den.toString().length - 1;
  const text = sum.toString().padStart(digits + 1, "0");
  return digits === 0 ? text : text.slice(0, -digits) + "." + text.slice(-digits);
}

const main = () => {
  const [inputsPath, outDir] = process.argv.slice(2);
  if (!inputsPath || !outDir) fail("usage: node recipes/invoice/build.mjs in/inputs.json out");
  const input = JSON.parse(readFileSync(resolve(root, inputsPath), "utf8"));
  const config = JSON.parse(readFileSync(join(here, "config.json"), "utf8"));
  const invoice = computeInvoice(input, config);
  mkdirSync(join(root, "build"), { recursive: true });
  mkdirSync(resolve(root, outDir), { recursive: true });
  writeFileSync(join(root, "build", "invoice.json"), JSON.stringify(invoice, null, 2));
  const pdf = resolve(root, outDir, "invoice.pdf");
  const typst = spawnSync(
    "typst",
    ["compile", "--root", root, "--ignore-system-fonts", "--input", "data=/build/invoice.json",
      join(here, "invoice.typ"), pdf],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (typst.error) fail("typst isn't on PATH: " + typst.error.message);
  if (typst.status !== 0) fail("typst failed");
  process.stdout.write(JSON.stringify({ file: "out/invoice.pdf", total: invoice.total, draft: invoice.draft, number: invoice.number }) + "\n");
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write("invoice: " + error.message + "\n");
    process.exit(2);
  }
}
`,
  "recipes/invoice/config.json": String.raw`{
  "defaultGstRate": "18",
  "lutEndorsement": "SUPPLY MEANT FOR EXPORT UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX",
  "paidExportEndorsement": "SUPPLY MEANT FOR EXPORT ON PAYMENT OF INTEGRATED TAX",
  "footer": "This is a computer-generated invoice and needs no signature."
}
`,
  "recipes/invoice/invoice.typ": String.raw`// Lays out what build.mjs computed; no arithmetic here.
#let d = json(sys.inputs.data)
#let ink = rgb("#1f2933")
#let soft = rgb("#6b7280")
#let rule = rgb("#d1d5db")

#set document(title: d.heading + if d.number != none { " " + d.number } else { "" })
#set page(
  paper: "a4",
  margin: (x: 18mm, top: 18mm, bottom: 20mm),
  background: if d.draft {
    rotate(-35deg, text(size: 96pt, fill: rgb(220, 38, 38, 28), weight: "bold")[DRAFT])
  },
  footer: align(center, text(size: 7.5pt, fill: soft, d.footer)),
)
#set text(font: "Libertinus Serif", size: 9.5pt, fill: ink)
#set par(leading: 0.55em)

#let label(body) = text(size: 7.5pt, fill: soft, upper(body))
#let field(name, value) = if value != none and value != "" [#label(name) \ #value]

#grid(
  columns: (1fr, auto),
  align: (left + top, right + top),
  [
    #text(size: 15pt, weight: "bold", d.supplier.name)
    #if d.supplier.trade != none [ \ #text(fill: soft, d.supplier.trade)]
    #if d.supplier.address != none [ \ #d.supplier.address]
    #if d.supplier.gstin != none [ \ GSTIN #d.supplier.gstin]
    #if d.supplier.pan != none [ · PAN #d.supplier.pan]
    #if d.supplier.state != none [ \ State: #d.supplier.state]
  ],
  [
    #text(size: 17pt, weight: "bold", d.heading)
    \ #if d.number != none [No. #d.number] else [#text(fill: rgb("#dc2626"), weight: "bold")[DRAFT · not numbered]]
    \ Date: #d.issuedOn
    #if d.dueOn != none [ \ Due: #d.dueOn]
  ],
)

#v(6mm)
#line(length: 100%, stroke: 0.6pt + rule)
#v(3mm)

#grid(
  columns: (1fr, 1fr),
  gutter: 8mm,
  [
    #label[Billed to] \
    #text(weight: "bold", d.recipient.name)
    #if d.recipient.address != none [ \ #d.recipient.address]
    #if d.recipient.gstin != none [ \ GSTIN #d.recipient.gstin]
  ],
  [
    #if d.recipient.placeOfSupply != none [#field("Place of supply", d.recipient.placeOfSupply)]
    #if d.recipient.country != none [#field("Country of destination", d.recipient.country)]
    #if d.reverseCharge != none [ \ #field("Tax payable on reverse charge", d.reverseCharge)]
  ],
)

#v(6mm)

#table(
  columns: (auto, 1fr, auto, auto, auto, auto),
  stroke: (x, y) => if y == 0 { (bottom: 0.8pt + ink) } else { (bottom: 0.4pt + rule) },
  inset: (x: 5pt, y: 6pt),
  align: (x, y) => if x >= 3 { right } else { left },
  table.header(..("#", "Description", "SAC", "Qty", "Rate", "Taxable value").map(h => text(weight: "bold", h))),
  ..d.lines.map(l => (l.n, l.description, l.sac, l.quantity, l.rate, l.amount)).flatten(),
)

#v(2mm)
#align(right, box(width: 72mm, table(
  columns: (1fr, auto),
  stroke: none,
  inset: (x: 5pt, y: 4pt),
  align: (left, right),
  [Taxable value], [#d.taxable],
  ..d.taxes.map(t => ([#t.name at #t.rate], [#t.amount])).flatten(),
  table.hline(stroke: 0.8pt + ink),
  text(weight: "bold")[Total], text(weight: "bold", d.total),
)))

#v(2mm)
#label[Amount in words] \
#d.words

#if d.endorsement != none [
  #v(4mm)
  #block(stroke: 0.6pt + ink, inset: 6pt, width: 100%, text(weight: "bold", d.endorsement))
]

#if d.bank != none [
  #v(6mm)
  #label[Pay to] \
  #d.bank.name · A/c #d.bank.number
  #if d.bank.ifsc != none [ · IFSC #d.bank.ifsc]
  #if d.bank.bank != none [ \ #d.bank.bank]
  #if d.bank.upi != none [ \ UPI #d.bank.upi]
]

#if d.notes != none [
  #v(4mm)
  #label[Notes] \
  #d.notes
]
`,
  "recipes/accountant-pack/RECIPE.md": String.raw`---
name: accountant-pack
title: Accountant's monthly pack
description: One month's invoices, payments received and expenses as a workbook and a CSV per sheet, with exact totals per currency, for the accountant.
sensitive: true
inputs:
  month: { type: month, description: "The month, such as 2026-10" }
  company: { type: text, from: company.legalName, required: false }
  companyGstin: { type: text, from: company.gstin, required: false }
  invoices:
    type: table
    from: rows.invoices
    period: month
    columns: { key: text, number: text, date: date, client: text, state: text, tax: money, amount: money }
  payments:
    type: table
    from: payments
    period: month
    columns: { invoice: text, client: text, amount: money, paidOn: date }
  expenses:
    type: table
    from: rows.expenses
    period: month
    columns: { key: text, title: text, date: date, category: text, field_vendor: text, tax: money, amount: money }
outputs: ["accounts-*.xlsx", "invoices-*.csv", "payments-*.csv", "expenses-*.csv"]
---

Makes the month's pack for the accountant.

Run, from the worktree root:

    node recipes/accountant-pack/build.mjs in/inputs.json out

The rows come from Kin as they are stored; the script adds the totals in exact amounts, one per
currency, and leaves Void and Draft invoices out of them. Report every file it wrote.

The sheets and their columns are in config.json. When the owner wants other columns, change
config.json (each column is a header and a field the inputs have; add the field to the input's
columns here too) and nothing else.
`,
  "recipes/accountant-pack/build.mjs": String.raw`// Builds the month's pack for the accountant: one workbook and a CSV per sheet, columns from
// config.json. Totals are added here in exact integers (paise); nothing is converted.
// Usage, from the worktree root: node recipes/accountant-pack/build.mjs in/inputs.json out
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

const fail = (message) => {
  throw new Error(message);
};

const isMoney = (value) => typeof value === "object" && value !== null && "minor" in value && "currency" in value;
/** Paise as an exact decimal string: 11800050 is "118000.50". */
export const decimal = (minor) => {
  const value = BigInt(minor);
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  return sign + (abs / 100n).toString() + "." + (abs % 100n).toString().padStart(2, "0");
};

/** One sheet's rows as cells, with a total per currency under each money column; skip rows aren't added. */
export const sheetOf = (rows, columns, skip) => {
  const counted = (row) => !skip || !skip.values.includes(row[skip.field]);
  const header = columns.map((column) => ({ text: column.header }));
  const body = rows.map((row) =>
    columns.map((column) => {
      const [field, part] = column.field.split(".");
      const value = part === "currency" ? (isMoney(row[field]) ? row[field].currency : null) : row[field];
      if (value === null || value === undefined) return { text: "" };
      if (isMoney(value)) return { number: decimal(value.minor), currency: value.currency };
      return { text: String(value) };
    }),
  );
  const moneyColumns = columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => rows.some((row) => isMoney(row[column.field])));
  const currencies = [...new Set(moneyColumns.flatMap(({ column }) =>
    rows.map((row) => row[column.field]).filter(isMoney).map((money) => money.currency)))].sort();
  const totals = currencies.map((currency) =>
    columns.map((column, index) => {
      if (index === 0) return { text: currencies.length > 1 ? "Total " + currency : "Total" };
      if (!moneyColumns.some((money) => money.index === index)) return { text: "" };
      const sum = rows.reduce((total, row) => {
        const value = row[column.field];
        return counted(row) && isMoney(value) && value.currency === currency ? total + BigInt(value.minor) : total;
      }, 0n);
      return { number: decimal(sum), currency };
    }),
  );
  return [header, ...body, ...totals];
};

// Text a spreadsheet would run as a formula gets a leading ' so it opens as text; numbers don't.
const PLAIN_NUMBER = /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;
const neutralise = (text) =>
  /^ *[=+\-@\t\r]/.test(text) && !PLAIN_NUMBER.test(text.trim()) ? "'" + text : text;
const csvCell = (cell) => {
  const text = cell.number ?? neutralise(cell.text);
  return /[",\n\r]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
};
export const toCsv = (cells) => cells.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";

const xml = (text) =>
  String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const columnName = (index) => {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};
const sheetXml = (cells) => {
  const rows = cells.map((row, r) => {
    const values = row.map((cell, c) => {
      const ref = columnName(c) + (r + 1);
      if (cell.number !== undefined) return '<c r="' + ref + '" s="1"><v>' + cell.number + "</v></c>";
      if (cell.text === "") return "";
      return '<c r="' + ref + '" t="inlineStr"' + (r === 0 ? ' s="2"' : "") + "><is><t>" + xml(cell.text) + "</t></is></c>";
    });
    return '<row r="' + (r + 1) + '">' + values.join("") + "</row>";
  });
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    "<sheetData>" + rows.join("") + "</sheetData></worksheet>";
};

/** A minimal XLSX: a zip of the parts Excel, Numbers, Sheets and LibreOffice all read. */
export const toXlsx = (sheets) => {
  const files = [
    ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map((_, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join("") +
      "</Types>"],
    ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      "</Relationships>"],
    ["xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      sheets.map((sheet, i) => '<sheet name="' + xml(sheet.name.slice(0, 31)) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join("") +
      "</sheets></workbook>"],
    ["xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((_, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join("") +
      '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      "</Relationships>"],
    ["xl/styles.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs>' +
      '<cellXfs count="3"><xf/><xf numFmtId="4" applyNumberFormat="1"/><xf fontId="1" applyFont="1"/></cellXfs>' +
      "</styleSheet>"],
    ...sheets.map((sheet, i) => ["xl/worksheets/sheet" + (i + 1) + ".xml", sheetXml(sheet.cells)]),
  ];
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, "utf8");
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(0x00210000, 10);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0x00210000, 12);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(header, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += header.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

const main = () => {
  const [inputsPath, outDir] = process.argv.slice(2);
  if (!inputsPath || !outDir) fail("usage: node recipes/accountant-pack/build.mjs in/inputs.json out");
  const input = JSON.parse(readFileSync(resolve(root, inputsPath), "utf8"));
  const config = JSON.parse(readFileSync(join(here, "config.json"), "utf8"));
  if (!/^\d{4}-\d{2}$/.test(input.month ?? "")) fail("month must be like 2026-11");
  const sheets = config.sheets.map((sheet) => {
    const rows = input[sheet.input];
    if (!Array.isArray(rows)) fail("no input " + sheet.input + " for sheet " + sheet.name);
    return { name: sheet.name, file: sheet.file, cells: sheetOf(rows, sheet.columns, sheet.leaveOutOfTotals) };
  });
  const out = resolve(root, outDir);
  mkdirSync(out, { recursive: true });
  const written = [];
  for (const sheet of sheets) {
    const name = sheet.file.replace("{month}", input.month);
    writeFileSync(join(out, name), toCsv(sheet.cells));
    written.push("out/" + name);
  }
  const book = config.workbook.replace("{month}", input.month);
  writeFileSync(join(out, book), toXlsx(sheets));
  written.unshift("out/" + book);
  process.stdout.write(JSON.stringify({ files: written, rows: sheets.map((sheet) => [sheet.name, sheet.cells.length - 1]) }) + "\n");
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write("accountant-pack: " + error.message + "\n");
    process.exit(2);
  }
}
`,
  "recipes/accountant-pack/config.json": String.raw`{
  "workbook": "accounts-{month}.xlsx",
  "sheets": [
    {
      "name": "Invoices",
      "input": "invoices",
      "file": "invoices-{month}.csv",
      "columns": [
        {
          "header": "Invoice no.",
          "field": "number"
        },
        {
          "header": "Entry",
          "field": "key"
        },
        {
          "header": "Date",
          "field": "date"
        },
        {
          "header": "Client",
          "field": "client"
        },
        {
          "header": "Status",
          "field": "state"
        },
        {
          "header": "Tax",
          "field": "tax"
        },
        {
          "header": "Amount incl. tax",
          "field": "amount"
        },
        {
          "header": "Currency",
          "field": "amount.currency"
        }
      ],
      "leaveOutOfTotals": {
        "field": "state",
        "values": [
          "Void",
          "Draft"
        ]
      }
    },
    {
      "name": "Payments received",
      "input": "payments",
      "file": "payments-{month}.csv",
      "columns": [
        {
          "header": "Received on",
          "field": "paidOn"
        },
        {
          "header": "Invoice",
          "field": "invoice"
        },
        {
          "header": "Client",
          "field": "client"
        },
        {
          "header": "Amount",
          "field": "amount"
        },
        {
          "header": "Currency",
          "field": "amount.currency"
        }
      ]
    },
    {
      "name": "Expenses",
      "input": "expenses",
      "file": "expenses-{month}.csv",
      "columns": [
        {
          "header": "Date",
          "field": "date"
        },
        {
          "header": "Entry",
          "field": "key"
        },
        {
          "header": "What",
          "field": "title"
        },
        {
          "header": "Vendor",
          "field": "field_vendor"
        },
        {
          "header": "Category",
          "field": "category"
        },
        {
          "header": "Tax paid",
          "field": "tax"
        },
        {
          "header": "Amount",
          "field": "amount"
        },
        {
          "header": "Currency",
          "field": "amount.currency"
        }
      ]
    }
  ]
}
`,
  "recipes/report/RECIPE.md": String.raw`---
name: report
title: Report
description: A report as a PDF from Markdown, with tables and bar or line charts drawn from figures the agent gives.
tools: [typst]
inputs:
  title: { type: text }
  subtitle: { type: text, required: false }
  organisation: { type: text, required: false }
  date: { type: text, required: false, description: "As it should read, such as 12 Nov 2026" }
  body: { type: text, required: false, description: "Markdown: headings, paragraphs, lists, tables, and a line [chart: name] where a chart goes. Leave out to have the worker write it." }
  charts:
    type: table
    required: false
    description: "One row per bar or point: chart (its name), kind (bar or line), label, value, and series to compare"
    columns: { chart: text, kind: text, label: text, value: decimal, series: text }
outputs: [report.pdf]
---

Makes a report PDF.

If the inputs have no body, write it yourself in build/body.md from the brief: Markdown with
headings, short paragraphs, lists and tables, and a line [chart: name] for each chart in the
inputs. Use only figures from the brief and the inputs; never work out a new one.

Then run, from the worktree root:

    node recipes/report/build.mjs in/inputs.json out

Check the PDF reads well (render a page to PNG with typst compile --format png if you need to
look at it) and report out/report.pdf.
`,
  "recipes/report/build.mjs": String.raw`// Builds a report PDF from Markdown and chart data. Text reaches Typst only as string literals,
// so nothing in it can become markup or code. Chart values are drawn as given, never summed.
// Usage, from the worktree root: node recipes/report/build.mjs in/inputs.json out
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

const fail = (message) => {
  throw new Error(message);
};

const str = (text) => '"' + String(text).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", " ") + '"';

/** Inline Markdown (bold, italic, code, links) as Typst calls on string literals. */
export const inline = (text) => {
  const parts = [];
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\x60[^\x60]+\x60|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push("#" + str(text.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith("**") || token.startsWith("__")) parts.push("#strong(" + str(token.slice(2, -2)) + ")");
    else if (token.startsWith("\x60")) parts.push("#raw(" + str(token.slice(1, -1)) + ")");
    else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      parts.push(/^https?:\/\//.test(link[2]) ? "#link(" + str(link[2]) + ")[#" + str(link[1]) + "]" : "#" + str(link[1]));
    } else parts.push("#emph(" + str(token.slice(1, -1)) + ")");
    last = match.index + token.length;
  }
  if (last < text.length) parts.push("#" + str(text.slice(last)));
  return parts.join("");
};

const cells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());

/** A Markdown subset as Typst: headings, paragraphs, lists, quotes, tables and chart lines. */
export const toTypst = (markdown, charts) => {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const out = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length > 0) out.push(inline(paragraph.join(" ")), "");
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const chart = /^\s*\[chart:\s*([a-z0-9-]+)\s*\]\s*$/i.exec(line);
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (line.trim() === "") flush();
    else if (heading) {
      flush();
      out.push("#heading(level: " + heading[1].length + ", " + str(heading[2]) + ")", "");
    } else if (chart) {
      flush();
      const name = chart[1].toLowerCase();
      if (!charts.has(name)) fail("the body asks for chart " + name + ", which the inputs don't have");
      out.push("#figure(image(" + str("/build/charts/" + name + ".svg") + ", width: 100%))", "");
    } else if (line.startsWith("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      flush();
      const header = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      i -= 1;
      const numeric = header.map((_, c) => rows.length > 0 && rows.every((row) => /^[-+]?[₹$€£]?[\d,]+(\.\d+)?%?$/.test(row[c] ?? "")));
      out.push(
        "#table(columns: " + header.length + ", align: (" + numeric.map((n) => (n ? "right" : "left")).join(", ") + ",), " +
          "stroke: (x, y) => if y == 0 { (bottom: 0.8pt) } else { (bottom: 0.3pt + luma(200)) }, " +
          header.map((cell) => "strong(" + str(cell) + ")").join(", ") + ", " +
          rows.map((row) => header.map((_, c) => "[" + inline(row[c] ?? "") + "]").join(", ")).join(", ") + ")",
        "",
      );
    } else if (item) {
      flush();
      const ordered = /\d/.test(item[1]);
      const items = [item[2]];
      while (i + 1 < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i + 1]))
        items.push(lines[++i].replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
      out.push((ordered ? "#enum(" : "#list(") + items.map((text) => "[" + inline(text) + "]").join(", ") + ")", "");
    } else if (line.startsWith(">")) {
      flush();
      out.push("#quote(block: true)[" + inline(line.replace(/^>\s?/, "")) + "]", "");
    } else paragraph.push(line.trim());
  }
  flush();
  return out.join("\n");
};

const PALETTE = ["#2563eb", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#0891b2"];
const esc = (text) => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
/** A bar or line chart as SVG; positions are layout, the labels show the values as given. */
export const chartSvg = (rows) => {
  const kind = rows[0].kind === "line" ? "line" : "bar";
  const labels = [...new Set(rows.map((row) => row.label))];
  const series = [...new Set(rows.map((row) => row.series ?? ""))];
  const value = (label, name) => rows.find((row) => row.label === label && (row.series ?? "") === name)?.value;
  const numbers = rows.map((row) => Number(row.value));
  const raw = (Math.max(0, ...numbers) - Math.min(0, ...numbers)) / 4 || 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((m) => m >= raw);
  const top = Math.ceil(Math.max(0, ...numbers) / step) * step;
  const bottom = Math.floor(Math.min(0, ...numbers) / step) * step;
  const span = top - bottom || 1;
  const ticks = Math.round(span / step);
  const width = 640;
  const height = 300;
  const left = 56;
  const plot = { x: left, y: 16, w: width - left - 16, h: height - 70 };
  const y = (v) => plot.y + plot.h - ((Number(v) - bottom) / span) * plot.h;
  const parts = [];
  for (let t = 0; t <= ticks; t++) {
    const v = bottom + step * t;
    const ty = y(v);
    parts.push('<line x1="' + plot.x + '" x2="' + (plot.x + plot.w) + '" y1="' + ty + '" y2="' + ty + '" stroke="#e5e7eb"/>');
    parts.push('<text x="' + (plot.x - 6) + '" y="' + (ty + 4) + '" font-size="11" text-anchor="end" fill="#6b7280">' + esc(Number(v.toPrecision(4))) + "</text>");
  }
  const band = plot.w / labels.length;
  labels.forEach((label, i) => {
    const cx = plot.x + band * i + band / 2;
    parts.push('<text x="' + cx + '" y="' + (plot.y + plot.h + 16) + '" font-size="11" text-anchor="middle" fill="#374151">' + esc(label) + "</text>");
  });
  series.forEach((name, s) => {
    const color = PALETTE[s % PALETTE.length];
    if (kind === "bar") {
      const barWidth = (band * 0.7) / series.length;
      labels.forEach((label, i) => {
        const v = value(label, name);
        if (v === undefined) return;
        const x = plot.x + band * i + band * 0.15 + barWidth * s;
        const y0 = y(Math.max(0, Number(v)));
        const y1 = y(Math.min(0, Number(v)));
        parts.push('<rect x="' + x + '" y="' + y0 + '" width="' + barWidth + '" height="' + Math.max(0.5, y1 - y0) + '" fill="' + color + '"/>');
      });
    } else {
      const points = labels
        .map((label, i) => [plot.x + band * i + band / 2, value(label, name)])
        .filter(([, v]) => v !== undefined)
        .map(([x, v]) => x + "," + y(v));
      parts.push('<polyline fill="none" stroke="' + color + '" stroke-width="2.5" points="' + points.join(" ") + '"/>');
      for (const point of points) {
        const [px, py] = point.split(",");
        parts.push('<circle cx="' + px + '" cy="' + py + '" r="3.5" fill="' + color + '"/>');
      }
    }
    if (name !== "")
      parts.push('<rect x="' + (plot.x + s * 130) + '" y="' + (height - 22) + '" width="10" height="10" fill="' + color + '"/>' +
        '<text x="' + (plot.x + s * 130 + 16) + '" y="' + (height - 13) + '" font-size="11" fill="#374151">' + esc(name) + "</text>");
  });
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + " " + height + '" font-family="Libertinus Serif">' + parts.join("") + "</svg>";
};

const main = () => {
  const [inputsPath, outDir] = process.argv.slice(2);
  if (!inputsPath || !outDir) fail("usage: node recipes/report/build.mjs in/inputs.json out");
  const input = JSON.parse(readFileSync(resolve(root, inputsPath), "utf8"));
  const bodyFile = join(root, "build", "body.md");
  const body = input.body ?? (existsSync(bodyFile) ? readFileSync(bodyFile, "utf8") : null);
  if (!body) fail("no body: give one in the inputs or write build/body.md");
  const groups = new Map();
  for (const row of input.charts ?? []) {
    const name = String(row.chart ?? "").toLowerCase();
    if (!/^[a-z0-9-]+$/.test(name)) fail("chart names are lowercase letters, digits and dashes");
    if (!/^-?\d+(\.\d+)?$/.test(String(row.value ?? ""))) fail("chart " + name + " has a value that isn't a number");
    groups.set(name, [...(groups.get(name) ?? []), row]);
  }
  mkdirSync(join(root, "build", "charts"), { recursive: true });
  for (const [name, rows] of groups) writeFileSync(join(root, "build", "charts", name + ".svg"), chartSvg(rows));
  const document = [
    '#set document(title: ' + str(input.title) + ")",
    '#set page(paper: "a4", margin: (x: 20mm, y: 20mm), footer: context align(center, text(size: 8pt, fill: luma(120), counter(page).display("1"))))',
    '#set text(font: "Libertinus Serif", size: 10.5pt)',
    "#set par(justify: true, leading: 0.6em)",
    '#set heading(numbering: none)',
    "#show heading.where(level: 1): set text(size: 15pt)",
    "#text(size: 22pt, weight: \"bold\", " + str(input.title) + ")",
    input.subtitle ? "\\\n#text(size: 12pt, fill: luma(90), " + str(input.subtitle) + ")" : "",
    input.organisation || input.date
      ? "\\\n#text(size: 9pt, fill: luma(120), " + str([input.organisation, input.date].filter(Boolean).join(" · ")) + ")"
      : "",
    "#v(6mm)",
    toTypst(body, new Set(groups.keys())),
  ].join("\n");
  writeFileSync(join(root, "build", "report.typ"), document);
  const pdf = resolve(root, outDir, "report.pdf");
  mkdirSync(resolve(root, outDir), { recursive: true });
  const typst = spawnSync("typst", ["compile", "--root", root, "--ignore-system-fonts", join(root, "build", "report.typ"), pdf], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (typst.error) fail("typst isn't on PATH: " + typst.error.message);
  if (typst.status !== 0) fail("typst failed");
  process.stdout.write(JSON.stringify({ file: "out/report.pdf", charts: [...groups.keys()] }) + "\n");
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write("report: " + error.message + "\n");
    process.exit(2);
  }
}
`,
};
