# Moving your records into Kin

Kin can take in what you kept in another system: clients, projects, Work entries, entries of your
lists (expenses, invoices, dates or any list you define) and payments received. Everything comes
in as yours, with its original dates. There is no screen for this: you run one command on the
machine that hosts Kin.

## The import file

An import is one text file with one JSON object per line. The first line names the import and
the lists it needs. Each line after it is a client, a project or an entry, and may refer only to
lines above it:

```jsonl
{"format":"kin-import","version":1,"batch":"oldbooks","source":"Old Books","asOf":"2026-08-10","lists":[{"list":"invoices","template":"invoices"}]}
{"client":{"source":"c1","name":"Acme","createdAt":"2026-04-02"}}
{"entry":{"source":"i1","list":"invoices","title":"April retainer","state":"waiting","client":"c1","date":"2026-04-30","amount":"50000.00","number":"INV/26-27/004","payments":[{"source":"p1","amount":"50000.00","paidOn":"2026-05-20"}]}}
{"entry":{"source":"t1","list":"work","title":"Renew the domain","due":"2026-07-01"}}
```

- Every row has a `source` id: what the old system called it. Kin uses it to know a row it has
  imported before.
- A list named in the first line is made if you don't have it yet, from a template or with your
  own fields, states and categories. A list you already have only gains new fields and categories.
- Amounts are plain decimals in the list's currency unless a row names another. Dates are days
  (`2026-04-30`) or times with an offset.
- An invoice keeps the number it was issued. Kin's own numbering carries on after the highest
  imported number in that year's series.
- Payments are recorded as **Record payment** records them: an invoice paid in full becomes Paid,
  on the day of its last payment.
- `asOf` is the last day the old system was kept up. Entries still open from before it get a note
  saying so, so nobody takes an old to-do for current.

## Plan first, then apply

On the host, run a plan. It changes nothing. It reports what it would make, what was imported
before, every line it can't take and why, and money totals per list to check against the old
system:

```sh
t3 kin import --file ./oldbooks.jsonl
```

When the plan reads right, apply it:

```sh
t3 kin import --file ./oldbooks.jsonl --apply
```

Running it again is safe. Rows imported before are skipped, and anything you or a lead changed in
Kin since is left alone and listed. If an import stops part way, run it again to finish it. A file
takes up to 200,000 rows; for more, split it into files with the same `batch` and import them in
order. Open Kin screens show the imported records after a refresh.

## Undoing an import

If the result is wrong, take the batch away. As with importing, see the plan first:

```sh
t3 kin import --undo oldbooks
t3 kin import --undo oldbooks --apply
```

Undo removes the clients, projects, entries and payments the batch made, and lists it made that
hold nothing else. It leaves alone, and lists, entries someone changed since the import (add
`--include-changed` to remove those too), and anything still used by a record that stays, such as
a client you've since added work for. Invoice numbering doesn't go back, so no number is ever
issued twice. You can apply the same file again afterwards.

## What an import doesn't do

- It brings no files. Put links to where your documents live in a text field instead.
- It sends nothing: no notifications, reminders or messages, and no lead is woken, however old or
  overdue the entries are.
- It doesn't fill your company profile or bank details. Set those in Kin yourself.
