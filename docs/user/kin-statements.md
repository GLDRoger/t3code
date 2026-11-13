# Bank and card statements

Send your monthly bank or card statement to your Chief of Staff in chat, and Kin works out which
invoices were paid and which expenses the debits were. Nothing is recorded until you confirm.

## Sending a statement

Attach the statement your bank lets you download: a PDF, CSV, XLS or XLSX. Kin checks every
row against the statement: the opening balance plus credits less debits must come to the closing
balance, each running balance must follow from the one before, and each page must have as many
rows as it prints. When Kin's own reading of a PDF doesn't pass those checks, your agent reads
its pages instead, and Kin tells it which row doesn't hold until it does. If it still doesn't add
up, the card says so and where, and nothing on it is ticked for you.

If the PDF is password-protected, a card asks for the password. Type it there and it goes to Kin
only. If you write it in your message instead, your agent uses it once to open the file and
doesn't keep it, but the message itself stays in the chat, so delete it if you'd rather it
didn't. Tick
**Remember for this account** and the next statement for that account opens on its own. The
same card has **Forget the password** later.

A scanned statement has no text to read. Your agent reads the pages instead, and the review card
says the rows came from images, so check them against the statement.

## Reviewing and confirming

One review card shows the statement in three groups:

- **Matched**: credits that pay an open invoice, and debits that pay an expense. A credit for
  the invoice less 10% or 2% shows as paid with TDS deducted, and records the TDS as its own
  line. Untick any you want to leave.
- **Pick a match**: rows that fit more than one entry. Pick one, or leave it for later.
- **Not matched**: each row starts as left for later, with what Kin suggests beside it. Make a
  debit a new expense, mark a row a transfer between your own accounts, or ignore it. **Use
  Kin's suggestions** takes them all at once.

**Confirm** records exactly what the card shows, all or nothing. If something changed since Kin
read the statement, such as an invoice paid in the meantime, nothing is recorded and the card
says why. Money and Invoices update straight away.

After you confirm, your agent goes through the rows still unexplained with you, until none are
left or you say leave them.

Every row is kept in the **Bank transactions** list, so rows you left for later stay there as
unexplained. If you already keep a list called Bank transactions, Kin uses it and knows the rows
already in it. Sending the same statement again, or one that overlaps the last, adds no row
twice. Bank transactions never count as spending or income in Money.

## Reading a statement again

**Read again** on a statement's card reads its file afresh, using a remembered password or asking
for it. Rows already recorded show as already recorded, and only rows not yet in Bank
transactions are offered. You can also ask your agent to read it again, or run
`t3 kin statement reread --statement <id> --apply` on the computer running Kin.

## Undoing a statement

**Undo this statement** on the card takes back everything it recorded: payments, TDS lines,
expenses marked paid and expenses it created. Each entry's history shows both the change and the
undo. You can confirm the card again afterwards.
