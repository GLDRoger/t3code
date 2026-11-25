/** The files a new workspace starts with, as they are copied into it: its README and its recipes. */
export const STARTER_FILES: Readonly<Record<string, string>> = {
  "README.md": String.raw`# Kin workspace

This repository holds the company's recipes: how its documents are made. Kin keeps it on the
host and never pushes it anywhere. Kin renders every document itself, from the recipe as it is
committed here, with no worker and no model.

## A recipe

A folder recipes/<name>/ with RECIPE.md, and for a PDF a Typst template.typ plus anything it
shows (a logo, a font). <name> is lowercase letters, digits and dashes.

RECIPE.md starts with front matter between --- lines:

- name: the folder's name.
- kind: typst (template.typ makes each PDF in outputs; the default) or table (Kin writes the
  sheets below as CSVs and a workbook).
- title: what the document is called, such as Quote. Shown in chats others can read, so never a
  client's name or an amount.
- description: one line on what it makes and when to use it.
- list (optional): the list whose entry it is made for, such as invoices. Requests then name an entry.
- numbered (optional): the document carries the number Kin issues for the entry.
- sensitive (optional): Kin labels a document confidential by where its inputs come from; true
  labels it so anyway.
- inputs: each input's type (text, integer, decimal, money, date, month, boolean, code for a
  SAC or HSN code of 4 to 8 digits, or table with columns), whether it is required, a
  description, and from:
  - nothing, for a value the agent gives;
  - entry.key, entry.title, entry.state, entry.amount, entry.tax, entry.date, entry.due,
    entry.notes, entry.number or entry.fields.<field>: the entry it is for;
  - client.name, client.address, client.gstin, client.placeOfSupply, client.terms: that entry's client;
  - company.legalName, company.tradeName, company.address, company.gstin, company.pan,
    company.placeOfSupply, company.sac, company.lutNumber, company.lutDate,
    company.bank.<accountName|accountNumber|ifsc|bankName|branch|upi>;
  - company.logo: the logo's path in the render folder, such as /brand/logo.png, or null;
    company.brand.<primaryColor|secondaryColor|font|footer>: the company's look, each may be null;
  - entry.payments (a table): every payment on the entry not taken back, with columns receipt,
    amount, paidOn and kind: advance (received before its date, or set against it from an
    advance's receipt), tds (tax the client deducted) or received; entry.advances is only the
    advances;
  - rows.<list> (a table, with period: naming a month input): that list's entries dated in the
    month (states: narrows it to Kin's own states open, doing, waiting, done, dropped), with
    columns from key, title, state, stateKey (that own state), amount, tax, taxable, date,
    due, client, clientGstin, placeOfSupply, category, number, matched (what a bank row was
    confirmed as) and field_<field>;
  - payments (a table, with period:): payments received in the month, with columns invoice,
    client, amount, paidOn, receipt; tds the same, for tax clients deducted;
  - reimbursements (a table, with period:): paid expenses a partner funded that the company still
    owed them at the month's end or paid back in it, with columns key, title, date, partner,
    state (owed or repaid), repaidOn and amount;
  - system.number, system.draft, system.today.
- computed (typst): fields Kin works out, in order, each one function: times [amount, factor],
  percent [amount, rate] (round: half-up, half-even, down or up), sum [amounts or table.column],
  minus [a, b], first [values], each { rows, set: { column: field } } (one value per row in
  each column it sets, never a table), words amount,
  date [day, format], gst { taxable, total, recordedTax, rate, supplierGstin, supplierPlace,
  clientGstin, clientPlace, exportUnderLut } and markdown text.
- amount (numbered): which figure is the amount the document asks for, its tax and its tax
  lines, such as { total: tax.total, tax: tax.tax, taxes: tax.taxes }. Issuing an entry records
  that total, and refuses when the entry already holds another. A numbered recipe without it
  can't issue.
- sheets and workbook (table): each sheet's name, the table input it shows, its CSV file name,
  its columns (header and field), the states left out of totals, and totalsBy, a field to
  total per value of.
- outputs: the file names it makes, {month} for an input's value.

The body is notes for the agent.

## How a document is made

Kin reads the declared inputs, works out the computed fields in exact integers, and writes them
to /inputs.json beside a copy of the recipe: money as { "minor": 11800000, "currency": "INR",
"text": "₹1,18,000.00" }, days as 2026-11-12. template.typ reads json("/inputs.json") and lays
it out; sys.inputs.output names the PDF being made. It never adds up money itself.

Typst 0.15 runs with only this recipe's files, the inputs and the company logo when an input
reads it, no packages and no network, for at most 20 seconds. Fonts: Typst's own (Libertinus
Serif, New Computer Modern, DejaVu Sans Mono), Poppins and Mukta (fetched by Kin, SIL OFL), and
any font in the folder. sample.json holds invented inputs: Kin renders it before it keeps a
change to the recipe.
`,
  "recipes/invoice/RECIPE.md": String.raw`---
name: invoice
title: Invoice
description: An Indian invoice for one invoice entry as a PDF. GST lines follow the company's and the client's state; a plain Invoice when the company has no GSTIN.
kind: typst
list: invoices
numbered: true
sensitive: true
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
  clientAddress: { type: text, from: client.address, required: false }
  clientGstin: { type: text, from: client.gstin, required: false }
  clientPlace: { type: text, from: client.placeOfSupply, required: false }
  supplier: { type: text, from: company.legalName }
  supplierTrade: { type: text, from: company.tradeName, required: false }
  supplierAddress: { type: text, from: company.address, required: false }
  supplierGstin: { type: text, from: company.gstin, required: false }
  supplierPan: { type: text, from: company.pan, required: false }
  supplierPlace: { type: text, from: company.placeOfSupply, required: false }
  sac: { type: text, from: company.sac, required: false }
  lutNumber: { type: text, from: company.lutNumber, required: false }
  lutDate: { type: date, from: company.lutDate, required: false }
  bankAccountName: { type: text, from: company.bank.accountName, required: false }
  bankAccountNumber: { type: text, from: company.bank.accountNumber, required: false }
  bankIfsc: { type: text, from: company.bank.ifsc, required: false }
  bankName: { type: text, from: company.bank.bankName, required: false }
  bankBranch: { type: text, from: company.bank.branch, required: false }
  bankUpi: { type: text, from: company.bank.upi, required: false }
  logo: { type: text, from: company.logo, required: false }
  brandPrimary: { type: text, from: company.brand.primaryColor, required: false }
  brandSecondary: { type: text, from: company.brand.secondaryColor, required: false }
  brandFont: { type: text, from: company.brand.font, required: false }
  brandFooter: { type: text, from: company.brand.footer, required: false }
  paid:
    type: table
    from: entry.payments
    required: false
    columns: { receipt: text, amount: money, paidOn: date, kind: text }
  billTo: { type: text, required: false, description: "A billing address for this invoice only, when the owner gives one other than the client's" }
  lines:
    type: table
    required: false
    description: "What was supplied, one row each, as the owner said it: quantity times rate is the taxable value; sac is the line's SAC or HSN code when the owner gave one, else the company's prints. Leave out to bill the entry's amount as one line."
    columns: { description: text, sac: code, quantity: decimal, unit: text, rate: money }
  gstRate: { type: decimal, required: false, description: "GST percent; 18 unless the owner said otherwise" }
  exportUnderLut: { type: boolean, required: false, description: "For an export: false only when the owner said IGST is paid on it" }
  notes: { type: text, required: false }
computed:
  gstPercent: { first: [gstRate, "18"] }
  items:
    each:
      rows: lines
      set:
        quantity: { first: [quantity, "1"] }
        amount: { times: [rate, quantity] }
  linesTaxable: { sum: items.amount }
  tax:
    gst:
      taxable: linesTaxable
      total: total
      recordedTax: taxRecorded
      rate: gstPercent
      supplierGstin: supplierGstin
      supplierPlace: supplierPlace
      clientGstin: clientGstin
      clientPlace: clientPlace
      exportUnderLut: exportUnderLut
  words: { words: tax.total }
  issuedDay: { first: [issuedOn, today] }
  issuedText: { date: [issuedDay, "D MMM YYYY"] }
  dueText: { date: [dueOn, "D MMM YYYY"] }
  lutText: { date: [lutDate, "D MMM YYYY"] }
  billedAt: { first: [billTo, clientAddress] }
  paidLines:
    each:
      rows: paid
      set:
        paidText: { date: [paidOn, "D MMM YYYY"] }
  paidTotal: { sum: paid.amount }
  balance: { minus: [tax.total, paidTotal] }
amount: { total: tax.total, tax: tax.tax, taxes: tax.taxes }
default: true
outputs: [invoice.pdf]
---

One invoice PDF from the entry, its client and the company profile. Kin works out every figure:
each line's value (quantity times rate), the tax lines (CGST and SGST, or UTGST, in the same
state; IGST between states; none for an export under a letter of undertaking, with the
endorsement, the LUT's number and date from the company profile, and the country), the total
and the amount in words. Each line shows its SAC or HSN code, else the company's SAC; none is
made up. If the entry's amount and the
lines don't agree, nothing is made and the reason says by how much: tell the owner, don't change
a figure. A draft (no number yet) carries a DRAFT mark. Each payment on it shows as a line, "Less advance
received" (received before it was issued, or set against it from an advance's receipt), "Less TDS
deducted" or "Less received", then the balance due.

It shows the company logo and brand colours, font and footer line from the company profile when
they are set, and looks right without them. The wording the owner may change (the export
endorsements and the footer) is at the top of template.typ.
`,
  "recipes/invoice/template.typ": String.raw`// Lays out what Kin computed; no arithmetic here.
#let d = json("/inputs.json")
#let lut-endorsement = "SUPPLY MEANT FOR EXPORT UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX"
#let paid-export-endorsement = "SUPPLY MEANT FOR EXPORT ON PAYMENT OF INTEGRATED TAX"
#let footer-text = "This is a computer-generated invoice and needs no signature."
#let paid-labels = (advance: "Less advance received", tds: "Less TDS deducted", received: "Less received")

#let ink = rgb("#1f2933")
#let soft = rgb("#6b7280")
#let accent = if d.brandPrimary != none { rgb(d.brandPrimary) } else { ink }
#let rule = if d.brandSecondary != none { rgb(d.brandSecondary) } else { rgb("#d1d5db") }
#let body-font = if d.brandFont != none { (d.brandFont, "Libertinus Serif") } else { "Libertinus Serif" }
#let t = d.tax
#let draft = d.draft != false or d.number == none
#let heading-text = if t.registered { "Tax Invoice" } else { "Invoice" }
#let endorsement = if not t.exported or not t.registered { none } else if t.exportUnderLut { lut-endorsement } else { paid-export-endorsement }
#let lines = if d.items != none and d.items.len() > 0 {
  d.items.map(l => (
    str(l.n),
    l.description,
    if l.sac != none { l.sac } else if d.sac != none { d.sac } else { "" },
    if l.unit != none { l.quantity + " " + l.unit } else { l.quantity },
    l.rate.text,
    l.amount.text,
  ))
} else {
  ((
    "1",
    d.title,
    if d.sac != none { d.sac } else { "" },
    "1",
    t.taxable.text,
    t.taxable.text,
  ),)
}

#set document(title: heading-text + if d.number != none { " " + d.number } else { "" })
#set page(
  paper: "a4",
  margin: (x: 18mm, top: 18mm, bottom: 20mm),
  background: if draft {
    rotate(-35deg, text(size: 96pt, fill: rgb(220, 38, 38, 28), weight: "bold")[DRAFT])
  },
  footer: align(center, text(size: 7.5pt, fill: soft)[
    #if d.brandFooter != none [#d.brandFooter \ ]
    #footer-text
  ]),
)
#set text(font: body-font, size: 9.5pt, fill: ink)
#set par(leading: 0.55em)

#let label(body) = text(size: 7.5pt, fill: soft, upper(body))
#let field(name, value) = if value != none and value != "" [#label(name) \ #value]

#grid(
  columns: (1fr, auto),
  align: (left + top, right + top),
  [
    #if d.logo != none [#image(d.logo, height: 14mm) \ #v(1mm)]
    #text(size: 15pt, weight: "bold", d.supplier)
    #if d.supplierTrade != none [ \ #text(fill: soft, d.supplierTrade)]
    #if d.supplierAddress != none [ \ #d.supplierAddress]
    #if d.supplierGstin != none [ \ GSTIN #d.supplierGstin]
    #if d.supplierPan != none [ · PAN #d.supplierPan]
    #if t.supplierState != none [ \ State: #t.supplierState]
  ],
  [
    #text(size: 17pt, weight: "bold", fill: accent, heading-text)
    \ #if d.number != none and not draft [No. #d.number] else [#text(fill: rgb("#dc2626"), weight: "bold")[DRAFT · not numbered]]
    \ Date: #d.issuedText
    #if d.dueText != none [ \ Due: #d.dueText]
  ],
)

#v(6mm)
#line(length: 100%, stroke: 0.8pt + accent)
#v(3mm)

#grid(
  columns: (1fr, 1fr),
  gutter: 8mm,
  [
    #label[Billed to] \
    #text(weight: "bold", d.client)
    #if d.billedAt != none [ \ #d.billedAt]
    #if d.clientGstin != none [ \ GSTIN #d.clientGstin]
  ],
  [
    #if t.placeOfSupply != none [#field("Place of supply", t.placeOfSupply)]
    #if t.country != none [#field("Country of destination", t.country)]
    #if t.registered [ \ #field("Tax payable on reverse charge", "No")]
  ],
)

#v(6mm)

#table(
  columns: (auto, 1fr, auto, auto, auto, auto),
  stroke: (x, y) => if y == 0 { (bottom: 0.8pt + accent) } else { (bottom: 0.4pt + rule) },
  inset: (x: 5pt, y: 6pt),
  align: (x, y) => if x >= 3 { right } else { left },
  table.header(..("#", "Description", "HSN/SAC", "Qty", "Rate", "Taxable value").map(h => text(weight: "bold", h))),
  ..lines.flatten(),
)

#v(2mm)
#align(right, box(width: 72mm, table(
  columns: (1fr, auto),
  stroke: none,
  inset: (x: 5pt, y: 4pt),
  align: (left, right),
  [Taxable value], [#t.taxable.text],
  ..t.taxes.map(x => ([#x.name at #x.rate%], [#x.amount.text])).flatten(),
  ..if t.at("notCharged", default: none) != none { (table.cell(colspan: 2, align: left, text(fill: soft, t.notCharged)),) } else { () },
  table.hline(stroke: 0.8pt + accent),
  text(weight: "bold")[Total], text(weight: "bold", t.total.text),
  ..if d.paidLines != none and d.paidLines.len() > 0 {
    (
      ..d.paidLines.map(a => (
        [#paid-labels.at(a.kind, default: "Less received")#if a.receipt != none [ (#a.receipt)], #a.paidText],
        [−#a.amount.text],
      )).flatten(),
      table.hline(stroke: 0.8pt + accent),
      text(weight: "bold")[Balance due], text(weight: "bold", d.balance.text),
    )
  } else { () },
)))

#v(2mm)
#label[Amount in words] \
#d.words

#if endorsement != none [
  #v(4mm)
  #block(stroke: 0.6pt + ink, inset: 6pt, width: 100%)[
    #text(weight: "bold", endorsement)
    #if t.exportUnderLut and d.lutNumber != none [ \ LUT ARN #d.lutNumber#if d.lutText != none [, dated #d.lutText]]
  ]
]

#if d.bankAccountNumber != none [
  #v(6mm)
  #label[Pay to] \
  #(if d.bankAccountName != none { d.bankAccountName } else { d.supplier }) · A/c #d.bankAccountNumber
  #if d.bankIfsc != none [ · IFSC #d.bankIfsc]
  #let bank = (d.bankName, d.bankBranch).filter(x => x != none)
  #if bank.len() > 0 [ \ #bank.join(", ")]
  #if d.bankUpi != none [ \ UPI #d.bankUpi]
]

#if d.notes != none [
  #v(4mm)
  #label[Notes] \
  #d.notes
]
`,
  "recipes/invoice/sample.json": String.raw`{
  "invoiceKey": "INV-9",
  "title": "Consulting, October",
  "total": null,
  "taxRecorded": null,
  "issuedOn": "2026-11-02",
  "dueOn": "2026-11-16",
  "number": null,
  "draft": true,
  "today": "2026-11-02",
  "client": "Example Client Pvt Ltd",
  "clientAddress": "12 Sample Road, Pune 411001",
  "clientGstin": "27BBBBB2222B1Z5",
  "clientPlace": null,
  "supplier": "Sample Studio Pvt Ltd",
  "supplierTrade": null,
  "supplierAddress": "4 Example Lane, Bengaluru 560001",
  "supplierGstin": "29AAAAA1111A1Z5",
  "supplierPan": "AAAAA1111A",
  "supplierPlace": "Karnataka",
  "sac": "998314",
  "lutNumber": null,
  "lutDate": null,
  "bankAccountName": null,
  "bankAccountNumber": "000111222333",
  "bankIfsc": "SMPL0000001",
  "bankName": "Sample Bank",
  "bankBranch": "Indiranagar",
  "bankUpi": null,
  "logo": "logo",
  "brandPrimary": null,
  "brandSecondary": null,
  "brandFont": null,
  "brandFooter": null,
  "paid": [{ "receipt": "RCT/26-27/001", "amount": { "minor": 2500000, "currency": "INR" }, "paidOn": "2026-10-20", "kind": "advance" }],
  "billTo": null,
  "lines": [{ "description": "Advisory", "sac": null, "quantity": "3", "unit": "days", "rate": { "minor": 3333300, "currency": "INR" } }],
  "gstRate": null,
  "exportUnderLut": null,
  "notes": null
}
`,
  "recipes/quotation/RECIPE.md": String.raw`---
name: quotation
title: Quotation
description: A quotation or estimate for one quotes entry as a PDF, numbered in its own series, valid until the entry's due day, with GST worked out as an invoice would charge it. Not a tax invoice.
kind: typst
list: quotes
numbered: true
sensitive: true
default: true
inputs:
  quoteKey: { type: text, from: entry.key }
  title: { type: text, from: entry.title }
  total: { type: money, from: entry.amount, required: false, description: "The entry's amount, tax included" }
  taxRecorded: { type: money, from: entry.tax, required: false }
  datedOn: { type: date, from: entry.date, required: false }
  validUntil: { type: date, from: entry.due, required: false }
  number: { type: text, from: system.number, required: false }
  draft: { type: boolean, from: system.draft }
  today: { type: date, from: system.today }
  client: { type: text, from: client.name }
  clientAddress: { type: text, from: client.address, required: false }
  clientGstin: { type: text, from: client.gstin, required: false }
  clientPlace: { type: text, from: client.placeOfSupply, required: false }
  supplier: { type: text, from: company.legalName }
  supplierTrade: { type: text, from: company.tradeName, required: false }
  supplierAddress: { type: text, from: company.address, required: false }
  supplierGstin: { type: text, from: company.gstin, required: false }
  supplierPlace: { type: text, from: company.placeOfSupply, required: false }
  sac: { type: text, from: company.sac, required: false }
  logo: { type: text, from: company.logo, required: false }
  brandPrimary: { type: text, from: company.brand.primaryColor, required: false }
  brandSecondary: { type: text, from: company.brand.secondaryColor, required: false }
  brandFont: { type: text, from: company.brand.font, required: false }
  brandFooter: { type: text, from: company.brand.footer, required: false }
  billTo: { type: text, required: false, description: "An address for this quote only, when the owner gives one other than the client's" }
  lines:
    type: table
    required: false
    description: "What is offered, one row each, as the owner said it: quantity times rate is the value before tax; sac is the line's SAC or HSN code when the owner gave one. Leave out to quote the entry's amount as one line."
    columns: { description: text, sac: code, quantity: decimal, unit: text, rate: money }
  gstRate: { type: decimal, required: false, description: "GST percent; 18 unless the owner said otherwise" }
  exportUnderLut: { type: boolean, required: false, description: "For an export: false only when the owner said IGST will be paid on it" }
  terms: { type: text, required: false, description: "Payment terms or conditions, as the owner gave them" }
  notes: { type: text, required: false }
computed:
  gstPercent: { first: [gstRate, "18"] }
  items:
    each:
      rows: lines
      set:
        quantity: { first: [quantity, "1"] }
        amount: { times: [rate, quantity] }
  linesTaxable: { sum: items.amount }
  tax:
    gst:
      taxable: linesTaxable
      total: total
      recordedTax: taxRecorded
      rate: gstPercent
      supplierGstin: supplierGstin
      supplierPlace: supplierPlace
      clientGstin: clientGstin
      clientPlace: clientPlace
      exportUnderLut: exportUnderLut
  words: { words: tax.total }
  datedDay: { first: [datedOn, today] }
  datedText: { date: [datedDay, "D MMM YYYY"] }
  validText: { date: [validUntil, "D MMM YYYY"] }
  billedAt: { first: [billTo, clientAddress] }
amount: { total: tax.total, tax: tax.tax, taxes: tax.taxes }
outputs: [quotation.pdf]
---

One quotation PDF for a quotes entry: what is offered line by line, the GST it will carry (CGST and
SGST in the same state, IGST between states, none for an export under a letter of undertaking),
the total in figures and words, and the day it is valid until (the entry's due day). Kin works out
every figure. A draft (no number yet) carries a DRAFT mark; issuing it (kin_issue) numbers it in
the quotes series and records its total.

To invoice it once the client agrees, make the invoice with from: the quote's key. Kin makes a
draft invoice for the same client with the same lines.

It is never a tax invoice: the heading says Quotation and nothing on it claims tax was charged.
The wording the owner may change is at the top of template.typ.
`,
  "recipes/quotation/template.typ": String.raw`// Lays out what Kin computed; no arithmetic here.
#let d = json("/inputs.json")
#let heading-text = "Quotation"
#let footer-text = "This is a quotation, not a tax invoice. Prices hold until the date above."

#let ink = rgb("#1f2933")
#let soft = rgb("#6b7280")
#let accent = if d.brandPrimary != none { rgb(d.brandPrimary) } else { ink }
#let rule = if d.brandSecondary != none { rgb(d.brandSecondary) } else { rgb("#d1d5db") }
#let body-font = if d.brandFont != none { (d.brandFont, "Libertinus Serif") } else { "Libertinus Serif" }
#let t = d.tax
#let draft = d.draft != false or d.number == none
#let lines = if d.items != none and d.items.len() > 0 {
  d.items.map(l => (
    str(l.n),
    l.description,
    if l.sac != none { l.sac } else if d.sac != none { d.sac } else { "" },
    if l.unit != none { l.quantity + " " + l.unit } else { l.quantity },
    l.rate.text,
    l.amount.text,
  ))
} else {
  ((
    "1",
    d.title,
    if d.sac != none { d.sac } else { "" },
    "1",
    t.taxable.text,
    t.taxable.text,
  ),)
}

#set document(title: heading-text + if d.number != none { " " + d.number } else { "" })
#set page(
  paper: "a4",
  margin: (x: 18mm, top: 18mm, bottom: 20mm),
  background: if draft {
    rotate(-35deg, text(size: 96pt, fill: rgb(220, 38, 38, 28), weight: "bold")[DRAFT])
  },
  footer: align(center, text(size: 7.5pt, fill: soft)[
    #if d.brandFooter != none [#d.brandFooter \ ]
    #footer-text
  ]),
)
#set text(font: body-font, size: 9.5pt, fill: ink)
#set par(leading: 0.55em)

#let label(body) = text(size: 7.5pt, fill: soft, upper(body))

#grid(
  columns: (1fr, auto),
  align: (left + top, right + top),
  [
    #if d.logo != none [#image(d.logo, height: 14mm) \ #v(1mm)]
    #text(size: 15pt, weight: "bold", d.supplier)
    #if d.supplierTrade != none [ \ #text(fill: soft, d.supplierTrade)]
    #if d.supplierAddress != none [ \ #d.supplierAddress]
    #if d.supplierGstin != none [ \ GSTIN #d.supplierGstin]
  ],
  [
    #text(size: 17pt, weight: "bold", fill: accent, heading-text)
    \ #if d.number != none and not draft [No. #d.number] else [#text(fill: rgb("#dc2626"), weight: "bold")[DRAFT · not numbered]]
    \ Date: #d.datedText
    #if d.validText != none [ \ Valid until: #text(weight: "bold", d.validText)]
  ],
)

#v(6mm)
#line(length: 100%, stroke: 0.8pt + accent)
#v(3mm)

#grid(
  columns: (1fr, 1fr),
  gutter: 8mm,
  [
    #label[Prepared for] \
    #text(weight: "bold", d.client)
    #if d.billedAt != none [ \ #d.billedAt]
    #if d.clientGstin != none [ \ GSTIN #d.clientGstin]
  ],
  [
    #if t.placeOfSupply != none [#label[Place of supply] \ #t.placeOfSupply]
    #if t.country != none [#label[Country] \ #t.country]
  ],
)

#v(6mm)

#table(
  columns: (auto, 1fr, auto, auto, auto, auto),
  stroke: (x, y) => if y == 0 { (bottom: 0.8pt + accent) } else { (bottom: 0.4pt + rule) },
  inset: (x: 5pt, y: 6pt),
  align: (x, y) => if x >= 3 { right } else { left },
  table.header(..("#", "Description", "HSN/SAC", "Qty", "Rate", "Value").map(h => text(weight: "bold", h))),
  ..lines.flatten(),
)

#v(2mm)
#align(right, box(width: 72mm, table(
  columns: (1fr, auto),
  stroke: none,
  inset: (x: 5pt, y: 4pt),
  align: (left, right),
  [Value before tax], [#t.taxable.text],
  ..t.taxes.map(x => ([#x.name at #x.rate%], [#x.amount.text])).flatten(),
  ..if t.at("notCharged", default: none) != none { (table.cell(colspan: 2, align: left, text(fill: soft, t.notCharged)),) } else { () },
  table.hline(stroke: 0.8pt + accent),
  text(weight: "bold")[#if t.taxes.len() > 0 [Total with GST] else [Total]], text(weight: "bold", t.total.text),
)))

#v(2mm)
#label[Amount in words] \
#d.words

#if t.exportUnderLut [
  #v(3mm)
  #text(fill: soft)[An export: invoiced under a letter of undertaking, without IGST.]
]

#if d.terms != none [
  #v(5mm)
  #label[Terms] \
  #d.terms
]

#if d.notes != none [
  #v(4mm)
  #label[Notes] \
  #d.notes
]
`,
  "recipes/quotation/sample.json": String.raw`{
  "quoteKey": "QT-2",
  "title": "Website refresh",
  "total": null,
  "taxRecorded": null,
  "datedOn": "2026-11-02",
  "validUntil": "2026-12-02",
  "number": null,
  "draft": true,
  "today": "2026-11-02",
  "client": "Example Client Pvt Ltd",
  "clientAddress": "12 Sample Road, Pune 411001",
  "clientGstin": "27BBBBB2222B1Z5",
  "clientPlace": null,
  "supplier": "Sample Studio Pvt Ltd",
  "supplierTrade": null,
  "supplierAddress": "4 Example Lane, Bengaluru 560001",
  "supplierGstin": "29AAAAA1111A1Z5",
  "supplierPlace": "Karnataka",
  "sac": "998314",
  "logo": "logo",
  "brandPrimary": null,
  "brandSecondary": null,
  "brandFont": null,
  "brandFooter": null,
  "billTo": null,
  "lines": [{ "description": "Design", "sac": "998391", "quantity": "5", "unit": "days", "rate": { "minor": 2000000, "currency": "INR" } }],
  "gstRate": null,
  "exportUnderLut": null,
  "terms": "50% on acceptance, the rest on delivery.",
  "notes": null
}
`,
  "recipes/receipt/RECIPE.md": String.raw`---
name: receipt
title: Receipt
description: A receipt for money received, for one receipts entry, against an invoice or as an advance, numbered in its own series, with the amount in words.
kind: typst
list: receipts
numbered: true
sensitive: true
default: true
inputs:
  receiptKey: { type: text, from: entry.key }
  amount: { type: money, from: entry.amount }
  receivedOn: { type: date, from: entry.date, required: false }
  number: { type: text, from: system.number, required: false }
  draft: { type: boolean, from: system.draft }
  today: { type: date, from: system.today }
  client: { type: text, from: client.name, required: false }
  clientAddress: { type: text, from: client.address, required: false }
  clientGstin: { type: text, from: client.gstin, required: false }
  towards: { type: text, from: entry.fields.towards, required: false }
  mode: { type: text, from: entry.fields.mode, required: false }
  reference: { type: text, from: entry.fields.reference, required: false }
  supplier: { type: text, from: company.legalName }
  supplierTrade: { type: text, from: company.tradeName, required: false }
  supplierAddress: { type: text, from: company.address, required: false }
  supplierGstin: { type: text, from: company.gstin, required: false }
  supplierPan: { type: text, from: company.pan, required: false }
  logo: { type: text, from: company.logo, required: false }
  brandPrimary: { type: text, from: company.brand.primaryColor, required: false }
  brandSecondary: { type: text, from: company.brand.secondaryColor, required: false }
  brandFont: { type: text, from: company.brand.font, required: false }
  brandFooter: { type: text, from: company.brand.footer, required: false }
  receivedFrom: { type: text, required: false, description: "Who paid, only when the owner names someone other than the entry's client" }
computed:
  words: { words: amount }
  day: { first: [receivedOn, today] }
  dayText: { date: [day, "D MMM YYYY"] }
  payer: { first: [receivedFrom, client] }
amount: { total: amount }
outputs: [receipt.pdf]
---

One receipt PDF for a receipts entry: who it was received from, towards what (an invoice's number
or an advance), the amount in figures and words, the mode and its reference, numbered in the
receipts series. Make it with kin_receipt, which numbers it first; asked again it is the same
receipt. A receipt Kin hasn't numbered yet carries a DRAFT mark.

It shows the company logo and brand colours, font and footer line when they are set. The wording
the owner may change is at the top of template.typ.
`,
  "recipes/receipt/template.typ": String.raw`// Lays out what Kin computed; no arithmetic here.
#let d = json("/inputs.json")
#let heading-text = "Receipt"
#let footer-text = "This is a computer-generated receipt and needs no signature."

#let ink = rgb("#1f2933")
#let soft = rgb("#6b7280")
#let accent = if d.brandPrimary != none { rgb(d.brandPrimary) } else { ink }
#let rule = if d.brandSecondary != none { rgb(d.brandSecondary) } else { rgb("#d1d5db") }
#let body-font = if d.brandFont != none { (d.brandFont, "Libertinus Serif") } else { "Libertinus Serif" }
#let draft = d.draft != false or d.number == none

#set document(title: heading-text + if d.number != none { " " + d.number } else { "" })
#set page(
  paper: "a5",
  flipped: true,
  margin: (x: 16mm, top: 14mm, bottom: 16mm),
  background: if draft {
    rotate(-30deg, text(size: 72pt, fill: rgb(220, 38, 38, 28), weight: "bold")[DRAFT])
  },
  footer: align(center, text(size: 7pt, fill: soft)[
    #if d.brandFooter != none [#d.brandFooter \ ]
    #footer-text
  ]),
)
#set text(font: body-font, size: 9.5pt, fill: ink)
#set par(leading: 0.55em)

#let label(body) = text(size: 7pt, fill: soft, upper(body))

#grid(
  columns: (1fr, auto),
  align: (left + top, right + top),
  [
    #if d.logo != none [#image(d.logo, height: 12mm) \ #v(1mm)]
    #text(size: 13pt, weight: "bold", d.supplier)
    #if d.supplierTrade != none [ \ #text(fill: soft, d.supplierTrade)]
    #if d.supplierAddress != none [ \ #d.supplierAddress]
    #if d.supplierGstin != none [ \ GSTIN #d.supplierGstin]
    #if d.supplierPan != none [ · PAN #d.supplierPan]
  ],
  [
    #text(size: 16pt, weight: "bold", fill: accent, heading-text)
    \ #if d.number != none and not draft [No. #d.number] else [#text(fill: rgb("#dc2626"), weight: "bold")[DRAFT · not numbered]]
    \ Date: #d.dayText
  ],
)

#v(4mm)
#line(length: 100%, stroke: 0.8pt + accent)
#v(4mm)

#let row(name, value) = if value != none and value != "" { ([#label(name)], [#value]) } else { () }
#grid(
  columns: (32mm, 1fr),
  row-gutter: 3.5mm,
  ..row("Received from", if d.payer != none [#text(weight: "bold", d.payer)#if d.clientAddress != none [ \ #d.clientAddress]#if d.clientGstin != none [ \ GSTIN #d.clientGstin]]),
  ..row("The sum of", d.words),
  ..row("Towards", d.towards),
  ..row("Mode", if d.mode != none { upper(d.mode.slice(0, 1)) + d.mode.slice(1) }),
  ..row("Reference", d.reference),
)

#v(6mm)
#align(right, box(stroke: 0.8pt + accent, inset: (x: 10pt, y: 7pt), text(size: 14pt, weight: "bold", d.amount.text)))
`,
  "recipes/receipt/sample.json": String.raw`{
  "receiptKey": "RCT-1",
  "amount": { "minor": 2500000, "currency": "INR" },
  "receivedOn": "2026-10-20",
  "number": "RCT/26-27/001",
  "draft": false,
  "today": "2026-10-20",
  "client": "Example Client Pvt Ltd",
  "clientAddress": "12 Sample Road, Pune 411001",
  "clientGstin": "27BBBBB2222B1Z5",
  "towards": "Advance for the website redesign",
  "mode": "bank transfer",
  "reference": "UTR 000123456789",
  "supplier": "Sample Studio Pvt Ltd",
  "supplierTrade": null,
  "supplierAddress": "4 Example Lane, Bengaluru 560001",
  "supplierGstin": "29AAAAA1111A1Z5",
  "supplierPan": "AAAAA1111A",
  "logo": "logo",
  "brandPrimary": null,
  "brandSecondary": null,
  "brandFont": null,
  "brandFooter": null,
  "receivedFrom": null
}
`,
  "recipes/accountant-pack/RECIPE.md": String.raw`---
name: accountant-pack
title: Accountant's monthly pack
description: One month's sales register, receipts, TDS deducted, expenses, what partners are owed back and bank transactions as a workbook and a CSV per sheet, with exact totals per currency, for the accountant.
kind: table
sensitive: true
inputs:
  month: { type: month, description: "The month, such as 2026-10" }
  invoices:
    type: table
    from: rows.invoices
    period: month
    columns: { key: text, number: text, date: date, client: text, clientGstin: text, placeOfSupply: text, state: text, stateKey: text, taxable: money, tax: money, amount: money }
  payments:
    type: table
    from: payments
    period: month
    columns: { invoice: text, receipt: text, client: text, amount: money, paidOn: date }
  tds:
    type: table
    from: tds
    period: month
    columns: { invoice: text, client: text, amount: money, paidOn: date }
  expenses:
    type: table
    from: rows.expenses
    period: month
    states: [done]
    columns: { key: text, title: text, date: date, category: text, field_vendor: text, tax: money, amount: money }
  unpaidExpenses:
    type: table
    from: rows.expenses
    period: month
    states: [open, doing, waiting]
    columns: { key: text, title: text, date: date, category: text, state: text, field_vendor: text, amount: money }
  partners:
    type: table
    from: reimbursements
    period: month
    columns: { key: text, title: text, date: date, partner: text, state: text, repaidOn: date, amount: money }
  bank:
    type: table
    from: rows.bank_transactions
    period: month
    columns: { key: text, title: text, date: date, state: text, stateKey: text, field_direction: text, field_reference: text, field_account: text, matched: text, amount: money }
workbook: "accounts-{month}.xlsx"
sheets:
  - name: Sales register
    input: invoices
    file: "sales-register-{month}.csv"
    columns:
      - { header: "Invoice no.", field: number }
      - { header: Date, field: date }
      - { header: Client, field: client }
      - { header: "Client GSTIN", field: clientGstin }
      - { header: "Place of supply", field: placeOfSupply }
      - { header: "Taxable value", field: taxable }
      - { header: "Tax as recorded", field: tax }
      - { header: "Total", field: amount }
      - { header: Currency, field: amount.currency }
      - { header: Status, field: state }
      - { header: Entry, field: key }
    leaveOutOfTotals: { field: stateKey, values: [dropped, open] }
  - name: Receipts
    input: payments
    file: "receipts-{month}.csv"
    columns:
      - { header: "Received on", field: paidOn }
      - { header: Receipt, field: receipt }
      - { header: Invoice, field: invoice }
      - { header: Client, field: client }
      - { header: Amount, field: amount }
      - { header: Currency, field: amount.currency }
  - name: TDS deducted
    input: tds
    file: "tds-{month}.csv"
    columns:
      - { header: "Recorded on", field: paidOn }
      - { header: Invoice, field: invoice }
      - { header: Client, field: client }
      - { header: "TDS deducted", field: amount }
      - { header: Currency, field: amount.currency }
  - name: Expenses
    input: expenses
    file: "expenses-{month}.csv"
    columns:
      - { header: Category, field: category }
      - { header: Date, field: date }
      - { header: Entry, field: key }
      - { header: What, field: title }
      - { header: Vendor, field: field_vendor }
      - { header: "Tax paid", field: tax }
      - { header: Amount, field: amount }
      - { header: Currency, field: amount.currency }
    totalsBy: category
  - name: Unpaid expenses
    input: unpaidExpenses
    file: "unpaid-expenses-{month}.csv"
    columns:
      - { header: Category, field: category }
      - { header: Date, field: date }
      - { header: Entry, field: key }
      - { header: What, field: title }
      - { header: Vendor, field: field_vendor }
      - { header: Status, field: state }
      - { header: Amount, field: amount }
      - { header: Currency, field: amount.currency }
  - name: Owed to partners
    input: partners
    file: "owed-to-partners-{month}.csv"
    columns:
      - { header: Partner, field: partner }
      - { header: Date, field: date }
      - { header: Entry, field: key }
      - { header: What, field: title }
      - { header: Status, field: state }
      - { header: "Repaid on", field: repaidOn }
      - { header: Amount, field: amount }
      - { header: Currency, field: amount.currency }
    totalsBy: state
  - name: Bank transactions
    input: bank
    file: "bank-{month}.csv"
    columns:
      - { header: Date, field: date }
      - { header: Entry, field: key }
      - { header: Narration, field: title }
      - { header: Direction, field: field_direction }
      - { header: Reference, field: field_reference }
      - { header: Account, field: field_account }
      - { header: Amount, field: amount }
      - { header: Currency, field: amount.currency }
      - { header: Status, field: state }
      - { header: "Matched to", field: matched }
    leaveOutOfTotals: { field: stateKey, values: [dropped] }
    totalsBy: field_direction
outputs: ["accounts-{month}.xlsx", "sales-register-{month}.csv", "receipts-{month}.csv", "tds-{month}.csv", "expenses-{month}.csv", "unpaid-expenses-{month}.csv", "owed-to-partners-{month}.csv", "bank-{month}.csv"]
---

The month's pack for the accountant. Kin writes the rows as they are stored and adds the totals
in exact amounts, one per currency, leaving void and draft invoices and void bank rows out of
them. Expenses are the paid ones, as Money counts them, totalled per category; unpaid ones are on
their own sheet with their state and one subtotal; void ones are in neither. Bank rows total per
direction. A bank row still Unexplained has nothing in Matched to.

Tax is the invoice's tax as recorded, one figure: Kin holds no CGST, SGST or IGST split, so the
pack has none. Taxable value is the total less that tax, blank when no tax was recorded. TDS is
tax a client deducted: it settles the invoice but is no money received, so Receipts leave it out.

When the owner wants other columns, change a sheet's columns here (each a header and a field the
input has; add the field to the input's columns too) and nothing else.
`,
  "recipes/accountant-pack/sample.json": String.raw`{
  "month": "2026-10",
  "invoices": [
    { "key": "INV-1", "number": "INV/26-27/001", "date": "2026-10-03", "client": "Example Client Pvt Ltd", "clientGstin": "29BBBBB2222B1Z5", "placeOfSupply": "Karnataka", "state": "Paid", "stateKey": "done", "taxable": { "minor": 10000000, "currency": "INR" }, "tax": { "minor": 1800000, "currency": "INR" }, "amount": { "minor": 11800000, "currency": "INR" } }
  ],
  "payments": [
    { "invoice": "INV/26-27/001", "receipt": "RCT/26-27/001", "client": "Example Client Pvt Ltd", "amount": { "minor": 11600000, "currency": "INR" }, "paidOn": "2026-10-20" }
  ],
  "tds": [
    { "invoice": "INV/26-27/001", "client": "Example Client Pvt Ltd", "amount": { "minor": 200000, "currency": "INR" }, "paidOn": "2026-10-20" }
  ],
  "expenses": [
    { "key": "EXP-1", "title": "Hosting", "date": "2026-10-05", "category": "software", "field_vendor": "Sample Cloud", "tax": null, "amount": { "minor": 450000, "currency": "INR" } }
  ],
  "unpaidExpenses": [
    { "key": "EXP-2", "title": "Office rent", "date": "2026-10-28", "category": "rent", "state": "To pay", "field_vendor": "Sample Estates", "amount": { "minor": 2000000, "currency": "INR" } }
  ],
  "bank": [
    { "key": "BNK-1", "title": "NEFT EXAMPLE CLIENT", "date": "2026-10-20", "state": "Explained", "stateKey": "done", "field_direction": "credit", "field_reference": "N000000001", "field_account": "0000", "matched": "payment on INV-1", "amount": { "minor": 11600000, "currency": "INR" } },
    { "key": "BNK-2", "title": "CARD SAMPLE CLOUD", "date": "2026-10-05", "state": "Unexplained", "stateKey": "open", "field_direction": "debit", "field_reference": null, "field_account": "0000", "matched": null, "amount": { "minor": 450000, "currency": "INR" } }
  ]
}
`,
  "recipes/report/RECIPE.md": String.raw`---
name: report
title: Report
description: A report as a PDF from Markdown the agent writes, with tables and bar or line charts drawn from figures the agent gives.
kind: typst
inputs:
  title: { type: text }
  subtitle: { type: text, required: false }
  organisation: { type: text, required: false }
  date: { type: text, required: false, description: "As it should read, such as 12 Nov 2026" }
  body: { type: text, required: true, description: "Markdown: headings, paragraphs, lists, tables, and a line [chart: name] where a chart goes. Only figures the owner gave or Kin showed you; never work one out." }
  logo: { type: text, from: company.logo, required: false }
  brandPrimary: { type: text, from: company.brand.primaryColor, required: false }
  brandFont: { type: text, from: company.brand.font, required: false }
  charts:
    type: table
    required: false
    description: "One row per bar or point: chart (its name), kind (bar or line), label, value, and series to compare"
    columns: { chart: text, kind: text, label: text, value: decimal, series: text }
computed:
  blocks: { markdown: body }
outputs: [report.pdf]
---

A report PDF, with the company logo and brand colour when they are set. Write the body as Markdown with headings, short paragraphs, lists and tables, and
a line [chart: name] for each chart in charts. Values are drawn as given, never summed.
`,
  "recipes/report/template.typ": String.raw`// Lays out the body Kin parsed and draws the charts from their rows; text is data, never markup.
#let d = json("/inputs.json")
#let accent = if d.brandPrimary != none { rgb(d.brandPrimary) } else { rgb("#2563eb") }
#let palette = (accent, rgb("#f59e0b"), rgb("#10b981"), rgb("#ef4444"), rgb("#8b5cf6"), rgb("#0891b2"))

#set document(title: d.title)
#set page(paper: "a4", margin: (x: 20mm, y: 20mm), footer: context align(center, text(size: 8pt, fill: luma(120), counter(page).display("1"))))
#set text(font: if d.brandFont != none { (d.brandFont, "Libertinus Serif") } else { "Libertinus Serif" }, size: 10.5pt)
#set par(justify: true, leading: 0.6em)
#show heading.where(level: 1): set text(size: 15pt)

#let spans(parts) = parts.map(s => {
  if s.style == "strong" { strong(s.text) }
  else if s.style == "emph" { emph(s.text) }
  else if s.style == "code" { raw(s.text) }
  else if s.style == "link" { link(s.url, s.text) }
  else { s.text }
}).join()

#let rows-of(name) = if d.charts == none { () } else { d.charts.filter(r => r.chart != none and lower(r.chart) == name) }

// Layout only: positions come from the values as given; no figure is added up.
#let chart(name) = {
  let rows = rows-of(name)
  if rows.len() == 0 { panic("the body asks for chart " + name + ", which charts doesn't have") }
  let kind = if rows.first().kind == "line" { "line" } else { "bar" }
  let labels = ()
  for r in rows { if r.label not in labels { labels.push(r.label) } }
  let series = ()
  for r in rows {
    let s = if r.series == none { "" } else { r.series }
    if s not in series { series.push(s) }
  }
  let values = rows.map(r => float(r.value))
  let hi = calc.max(0, ..values)
  let lo = calc.min(0, ..values)
  let span = if hi - lo == 0 { 1 } else { hi - lo }
  let w = 150mm
  let h = 60mm
  let band = w / labels.len()
  let pad = 5mm
  let y(v) = pad + h - (v - lo) / span * h
  let row(label, s) = {
    let found = rows.filter(r => r.label == label and (if r.series == none { "" } else { r.series }) == s)
    if found.len() == 0 { none } else { found.first() }
  }
  let value(label, s) = { let r = row(label, s); if r == none { none } else { float(r.value) } }
  // Each value as the agent gave it, beside its bar or point.
  let tag(x, width, at, label, s) = place(top + left, dx: x, dy: at, box(width: width, align(center, text(size: 7pt, fill: luma(80), str(row(label, s).value)))))
  figure(box(width: w, height: pad + h + 22mm, {
    place(top + left, line(start: (0pt, y(0)), end: (w, y(0)), stroke: 0.5pt + luma(160)))
    for (i, label) in labels.enumerate() {
      place(top + left, dx: band * i, dy: pad + h + 2mm, box(width: band, align(center, text(size: 8pt, label))))
    }
    for (s, name) in series.enumerate() {
      let color = palette.at(calc.rem(s, palette.len()))
      if kind == "bar" {
        let bw = band * 0.7 / series.len()
        for (i, label) in labels.enumerate() {
          let v = value(label, name)
          if v != none {
            let y0 = y(calc.max(0, v))
            let y1 = y(calc.min(0, v))
            place(top + left, dx: band * i + band * 0.15 + bw * s, dy: y0, rect(width: bw, height: calc.max(0.5pt, y1 - y0), fill: color))
            tag(band * i + band * 0.15 + bw * s, bw, if v >= 0 { y0 - 3.5mm } else { y1 + 1mm }, label, name)
          }
        }
      } else {
        let points = labels.enumerate().map(((i, label)) => (i, value(label, name))).filter(p => p.at(1) != none).map(((i, v)) => (band * i + band / 2, y(v)))
        if points.len() > 1 { place(top + left, path(stroke: 1.5pt + color, ..points)) }
        for p in points { place(top + left, dx: p.at(0) - 2pt, dy: p.at(1) - 2pt, circle(radius: 2pt, fill: color)) }
        for (i, label) in labels.enumerate() {
          let v = value(label, name)
          if v != none { tag(band * i, band, y(v) - 4.5mm, label, name) }
        }
      }
      if name != "" {
        place(top + left, dx: s * 40mm, dy: pad + h + 10mm, box[#box(width: 3mm, height: 3mm, fill: color) #text(size: 8pt, name)])
      }
    }
  }))
}

#if d.logo != none { place(top + right, image(d.logo, height: 12mm)) }
#text(size: 22pt, weight: "bold", fill: accent, d.title)
#if d.subtitle != none [ \ #text(size: 12pt, fill: luma(90), d.subtitle)]
#let byline = (d.organisation, d.date).filter(x => x != none)
#if byline.len() > 0 [ \ #text(size: 9pt, fill: luma(120), byline.join(" · "))]
#v(6mm)

#for b in d.blocks {
  if b.kind == "heading" { heading(level: b.level, spans(b.spans)) }
  else if b.kind == "paragraph" { par(spans(b.spans)) }
  else if b.kind == "quote" { quote(block: true, spans(b.spans)) }
  else if b.kind == "list" {
    if b.ordered { enum(..b.items.map(spans)) } else { list(..b.items.map(spans)) }
  }
  else if b.kind == "table" {
    table(
      columns: b.header.len(),
      align: b.numeric.map(n => if n { right } else { left }),
      stroke: (x, y) => if y == 0 { (bottom: 0.8pt) } else { (bottom: 0.3pt + luma(200)) },
      ..b.header.map(h => strong(h)),
      ..b.rows.map(row => row.map(spans)).flatten(),
    )
  }
  else if b.kind == "chart" { chart(b.name) }
}
`,
  "recipes/report/sample.json": String.raw`{
  "title": "Quarterly review",
  "subtitle": "July to September 2026",
  "organisation": "Sample Studio Pvt Ltd",
  "date": "2 Oct 2026",
  "body": "# Summary\n\nRevenue grew across the quarter. **Two** new clients signed.\n\n- Steady retainers\n- One _large_ project\n\n| Month | Revenue |\n| --- | --- |\n| July | ₹4,00,000 |\n| August | ₹5,50,000 |\n\n[chart: revenue]\n",
  "charts": [
    { "chart": "revenue", "kind": "bar", "label": "Jul", "value": "4", "series": null },
    { "chart": "revenue", "kind": "bar", "label": "Aug", "value": "5.5", "series": null },
    { "chart": "revenue", "kind": "bar", "label": "Sep", "value": "6", "series": null }
  ],
  "logo": "logo",
  "brandPrimary": null,
  "brandFont": null
}
`,
};
