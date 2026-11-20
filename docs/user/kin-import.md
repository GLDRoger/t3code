# Moving your records into Kin

Kin can take in what you kept in another system. Clients, prospects, their contacts and deals come
in from a spreadsheet, in Kin itself. Projects, Work entries, entries of your lists (expenses,
invoices, dates or any list you define) and payments received come in through one command on the
machine that hosts Kin. Only the owner and co-owners import.

## Clients, contacts and deals from a spreadsheet

In Clients, choose **Add**, then **Import a file** (on the phone, the import button beside Add; on
the web, also "Import a file" in the command palette). Choose a CSV file: a spreadsheet saved as
CSV, or the export of the CRM you use now. Kin reads UTF-8 and UTF-16, separated by commas,
semicolons or tabs, up to 50,000 rows and 10 MB. Nothing is added until you import.

1. **Columns.** Kin proposes where each column goes from its header: Company, Contact name,
   E-mail, Phone, Opportunity, Amount, Stage, Close date, Owner and the like. Change any that are
   wrong, or leave a column out. A contact may have several emails and phones: give each its own
   column, or put several in one cell, separated by `;` (emails also by `,`).
2. **Check.** Kin shows what it will add, which rows match clients you already have and how it
   knows (a contact's email, the web domain of an email, or the same name), and what needs a
   look. Rows of one company in the file become one client the same way.
3. **Decide.** A name only close to one you have, such as "Lumen Grove (Oslo)" beside Lumen
   Grove, is never merged by itself: it is marked **Decide**, and you pick the client it is, a new
   one, or leave its rows out. A deal stage that isn't one of yours is never made up: pick which
   of your stages those deals go in. Kin also asks the currency of amounts written without one,
   and whether days like 03/04/2026 are written day first or month first.
4. **Import.** A client or contact you already have only gains what it lacks; nothing you typed
   changes. Deals arrive open, with no next step, and nobody is pinged about them. Importing the
   same file again changes nothing.

**Earlier imports** lists each file with who brought it in, when and what it added. **Undo this
import** takes away what that import added, and empties what it filled in on clients and contacts
you had. Anything someone changed since, or that something else now uses, stays and is listed
with the reason. An import already undone says so.

A "Why we may mail them" column isn't imported yet; it is listed under "Not imported".

## The import file (on the host)

An import is one text file with one JSON object per line. The first line names the import and
the lists it needs. Each line after it is a client, a project or an entry, and may refer only to
lines above it:

```jsonl
{"format":"kin-import","version":1,"batch":"oldbooks","source":"Old Books","asOf":"2026-07-31","lists":[{"list":"invoices","template":"invoices"}]}
{"client":{"source":"c1","name":"Acme","createdAt":"2026-04-02"}}
{"entry":{"source":"i1","list":"invoices","title":"April retainer","state":"waiting","client":"c1","date":"2026-04-30","amount":"48250.00","number":"INV/26-27/004","payments":[{"source":"p1","amount":"48250.00","paidOn":"2026-05-20"}]}}
{"entry":{"source":"t1","list":"work","title":"Renew the domain","due":"2026-07-01"}}
```

- Every row has a `source` id: what the old system called it. Kin uses it to know a row it has
  imported before.
- A list named in the first line is made if you don't have it yet, from a template or with your
  own fields, states and categories. A list you already have only gains new fields and categories.
- A contact is a `contact` row naming its `client`, with `name`, `role`, `notes`, and `emails`
  and `phones` as lists, main one first. Kin cleans them as it does for a contact you type, and
  keeps at most eight of each.
- A deal is a `deal` row naming its `client`, `title` and `stage` (one of your stage ids), with
  `value` (`{"amount":"18000","currency":"EUR"}`), `expected` (a day) and `owner` if you have
  them. Deals come in through **Import a file** in Kin; the command reports deal rows as left out.
- Amounts are plain decimals in the list's currency unless a row names another. Dates are days
  (`2026-04-30`) or times with an offset.
- An entry whose amount is over a thousand times the largest in its list, or an invoice dated after
  its own due day, is refused as a likely slip. Add `"confirmed":true` to the entry if it is right.
- `"suggested":true` marks an entry an agent suggested that nobody has kept yet. Download
  everything writes it, and the entry comes back as a suggestion, in no money figure until you keep
  it. Without it, an entry comes in kept.
- An invoice keeps the number it was issued. Kin's own numbering carries on after the highest
  imported number in that year's series.
- Payments are recorded as **Record payment** records them: an invoice paid in full becomes Paid,
  on the day of its last payment.
- A payment whose note holds a receipt number the old system issued, such as
  `Advance received; receipt note QST-RN/2026-27/001`, keeps it: the receipt Kin makes for that
  payment carries the same number, and Kin's receipt numbering carries on after the highest one
  in that year's series.
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

Running it again is safe. Rows imported before are skipped, and anything you or an agent changed in
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
a client you've since added work for. An invoice or receipt you've paid in Kin or given a Kin
number always stays, with or without `--include-changed`. Invoice numbering doesn't go back, so no
number is ever issued twice. You can apply the same file again afterwards. Entry keys such as `INV-4` do go back
when nothing came after them, so a corrected file applied again gets the keys the batch had.

## What an import doesn't do

- It brings no files. Put links to where your documents live in a text field instead.
- It sends nothing: no notifications, reminders or messages, and no agent is woken, however old or
  overdue the entries are.
- It doesn't fill your company profile or bank details. Set those in Kin yourself.
