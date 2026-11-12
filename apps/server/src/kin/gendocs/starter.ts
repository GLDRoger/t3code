/** The files a new workspace starts with, as they are copied into it: its README and three recipes. */
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
- inputs: each input's type (text, integer, decimal, money, date, month, boolean or table with
  columns), whether it is required, a description, and from:
  - nothing, for a value the agent gives;
  - entry.key, entry.title, entry.state, entry.amount, entry.tax, entry.date, entry.due,
    entry.notes, entry.number or entry.fields.<field>: the entry it is for;
  - client.name, client.address, client.gstin, client.placeOfSupply, client.terms: that entry's client;
  - company.legalName, company.tradeName, company.address, company.gstin, company.pan,
    company.placeOfSupply, company.sac, company.bank.<accountName|accountNumber|ifsc|bankName|branch|upi>;
  - rows.<list> (a table, with period: naming a month input): that list's entries dated in the
    month, with columns from key, title, state, amount, tax, date, due, client,
    category, number and field_<field>;
  - payments (a table, with period:): payments received in the month, with columns invoice,
    client, amount, paidOn;
  - system.number, system.draft, system.today.
- computed (typst): fields Kin works out, in order, each one function: times [amount, factor],
  percent [amount, rate] (round: half-up, half-even, down or up), sum [amounts or table.column],
  minus [a, b], first [values], each { rows, set: { column: field } }, words amount,
  date [day, format], gst { taxable, total, recordedTax, rate, supplierGstin, supplierPlace,
  clientGstin, clientPlace, exportUnderLut } and markdown text.
- sheets and workbook (table): each sheet's name, the table input it shows, its CSV file name,
  its columns (header and field) and the states left out of totals.
- outputs: the file names it makes, {month} for an input's value.

The body is notes for the agent.

## How a document is made

Kin reads the declared inputs, works out the computed fields in exact integers, and writes them
to /inputs.json beside a copy of the recipe: money as { "minor": 11800000, "currency": "INR",
"text": "₹1,18,000.00" }, days as 2026-11-12. template.typ reads json("/inputs.json") and lays
it out; sys.inputs.output names the PDF being made. It never adds up money itself.

Typst 0.15 runs with only this recipe's files and the inputs, its own fonts and any font in the
folder, no packages and no network, for at most 20 seconds. sample.json holds invented inputs:
Kin renders it before it keeps a change to the recipe.
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
  bankAccountName: { type: text, from: company.bank.accountName, required: false }
  bankAccountNumber: { type: text, from: company.bank.accountNumber, required: false }
  bankIfsc: { type: text, from: company.bank.ifsc, required: false }
  bankName: { type: text, from: company.bank.bankName, required: false }
  bankBranch: { type: text, from: company.bank.branch, required: false }
  bankUpi: { type: text, from: company.bank.upi, required: false }
  billTo: { type: text, required: false, description: "A billing address for this invoice only, when the owner gives one other than the client's" }
  lines:
    type: table
    required: false
    description: "What was supplied, one row each, as the owner said it: quantity times rate is the taxable value. Leave out to bill the entry's amount as one line."
    columns: { description: text, sac: text, quantity: decimal, unit: text, rate: money }
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
  billedAt: { first: [billTo, clientAddress] }
outputs: [invoice.pdf]
---

One invoice PDF from the entry, its client and the company profile. Kin works out every figure:
each line's value (quantity times rate), the tax lines (CGST and SGST, or UTGST, in the same
state; IGST between states; none for an export under a letter of undertaking, with the
endorsement and the country), the total and the amount in words. If the entry's amount and the
lines don't agree, nothing is made and the reason says by how much: tell the owner, don't change
a figure. A draft (no number yet) carries a DRAFT mark.

The wording the owner may change (the export endorsements and the footer) is at the top of
template.typ.
`,
  "recipes/invoice/template.typ": String.raw`// Lays out what Kin computed; no arithmetic here.
#let d = json("/inputs.json")
#let lut-endorsement = "SUPPLY MEANT FOR EXPORT UNDER BOND OR LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX"
#let paid-export-endorsement = "SUPPLY MEANT FOR EXPORT ON PAYMENT OF INTEGRATED TAX"
#let footer-text = "This is a computer-generated invoice and needs no signature."

#let ink = rgb("#1f2933")
#let soft = rgb("#6b7280")
#let rule = rgb("#d1d5db")
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
  footer: align(center, text(size: 7.5pt, fill: soft, footer-text)),
)
#set text(font: "Libertinus Serif", size: 9.5pt, fill: ink)
#set par(leading: 0.55em)

#let label(body) = text(size: 7.5pt, fill: soft, upper(body))
#let field(name, value) = if value != none and value != "" [#label(name) \ #value]

#grid(
  columns: (1fr, auto),
  align: (left + top, right + top),
  [
    #text(size: 15pt, weight: "bold", d.supplier)
    #if d.supplierTrade != none [ \ #text(fill: soft, d.supplierTrade)]
    #if d.supplierAddress != none [ \ #d.supplierAddress]
    #if d.supplierGstin != none [ \ GSTIN #d.supplierGstin]
    #if d.supplierPan != none [ · PAN #d.supplierPan]
    #if t.supplierState != none [ \ State: #t.supplierState]
  ],
  [
    #text(size: 17pt, weight: "bold", heading-text)
    \ #if d.number != none and not draft [No. #d.number] else [#text(fill: rgb("#dc2626"), weight: "bold")[DRAFT · not numbered]]
    \ Date: #d.issuedText
    #if d.dueText != none [ \ Due: #d.dueText]
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
  stroke: (x, y) => if y == 0 { (bottom: 0.8pt + ink) } else { (bottom: 0.4pt + rule) },
  inset: (x: 5pt, y: 6pt),
  align: (x, y) => if x >= 3 { right } else { left },
  table.header(..("#", "Description", "SAC", "Qty", "Rate", "Taxable value").map(h => text(weight: "bold", h))),
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
  table.hline(stroke: 0.8pt + ink),
  text(weight: "bold")[Total], text(weight: "bold", t.total.text),
)))

#v(2mm)
#label[Amount in words] \
#d.words

#if endorsement != none [
  #v(4mm)
  #block(stroke: 0.6pt + ink, inset: 6pt, width: 100%, text(weight: "bold", endorsement))
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
  "bankAccountName": null,
  "bankAccountNumber": "000111222333",
  "bankIfsc": "SMPL0000001",
  "bankName": "Sample Bank",
  "bankBranch": "Indiranagar",
  "bankUpi": null,
  "billTo": null,
  "lines": [{ "description": "Advisory", "sac": null, "quantity": "3", "unit": "days", "rate": { "minor": 3333300, "currency": "INR" } }],
  "gstRate": null,
  "exportUnderLut": null,
  "notes": null
}
`,
  "recipes/accountant-pack/RECIPE.md": String.raw`---
name: accountant-pack
title: Accountant's monthly pack
description: One month's invoices, payments received and expenses as a workbook and a CSV per sheet, with exact totals per currency, for the accountant.
kind: table
sensitive: true
inputs:
  month: { type: month, description: "The month, such as 2026-10" }
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
workbook: "accounts-{month}.xlsx"
sheets:
  - name: Invoices
    input: invoices
    file: "invoices-{month}.csv"
    columns:
      - { header: "Invoice no.", field: number }
      - { header: Entry, field: key }
      - { header: Date, field: date }
      - { header: Client, field: client }
      - { header: Status, field: state }
      - { header: Tax, field: tax }
      - { header: "Amount incl. tax", field: amount }
      - { header: Currency, field: amount.currency }
    leaveOutOfTotals: { field: state, values: [Void, Draft] }
  - name: Payments received
    input: payments
    file: "payments-{month}.csv"
    columns:
      - { header: "Received on", field: paidOn }
      - { header: Invoice, field: invoice }
      - { header: Client, field: client }
      - { header: Amount, field: amount }
      - { header: Currency, field: amount.currency }
  - name: Expenses
    input: expenses
    file: "expenses-{month}.csv"
    columns:
      - { header: Date, field: date }
      - { header: Entry, field: key }
      - { header: What, field: title }
      - { header: Vendor, field: field_vendor }
      - { header: Category, field: category }
      - { header: "Tax paid", field: tax }
      - { header: Amount, field: amount }
      - { header: Currency, field: amount.currency }
outputs: ["accounts-{month}.xlsx", "invoices-{month}.csv", "payments-{month}.csv", "expenses-{month}.csv"]
---

The month's pack for the accountant. Kin writes the rows as they are stored and adds the totals
in exact amounts, one per currency, leaving Void and Draft invoices out of them.

When the owner wants other columns, change a sheet's columns here (each a header and a field the
input has; add the field to the input's columns too) and nothing else.
`,
  "recipes/accountant-pack/sample.json": String.raw`{
  "month": "2026-10",
  "invoices": [
    { "key": "INV-1", "number": "INV/26-27/001", "date": "2026-10-03", "client": "Example Client Pvt Ltd", "state": "Paid", "tax": { "minor": 1800000, "currency": "INR" }, "amount": { "minor": 11800000, "currency": "INR" } }
  ],
  "payments": [
    { "invoice": "INV/26-27/001", "client": "Example Client Pvt Ltd", "amount": { "minor": 11800000, "currency": "INR" }, "paidOn": "2026-10-20" }
  ],
  "expenses": [
    { "key": "EXP-1", "title": "Hosting", "date": "2026-10-05", "category": "Software", "field_vendor": "Sample Cloud", "tax": null, "amount": { "minor": 450000, "currency": "INR" } }
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
  charts:
    type: table
    required: false
    description: "One row per bar or point: chart (its name), kind (bar or line), label, value, and series to compare"
    columns: { chart: text, kind: text, label: text, value: decimal, series: text }
computed:
  blocks: { markdown: body }
outputs: [report.pdf]
---

A report PDF. Write the body as Markdown with headings, short paragraphs, lists and tables, and
a line [chart: name] for each chart in charts. Values are drawn as given, never summed.
`,
  "recipes/report/template.typ": String.raw`// Lays out the body Kin parsed and draws the charts from their rows; text is data, never markup.
#let d = json("/inputs.json")
#let palette = (rgb("#2563eb"), rgb("#f59e0b"), rgb("#10b981"), rgb("#ef4444"), rgb("#8b5cf6"), rgb("#0891b2"))

#set document(title: d.title)
#set page(paper: "a4", margin: (x: 20mm, y: 20mm), footer: context align(center, text(size: 8pt, fill: luma(120), counter(page).display("1"))))
#set text(font: "Libertinus Serif", size: 10.5pt)
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

#text(size: 22pt, weight: "bold", d.title)
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
  ]
}
`,
};
