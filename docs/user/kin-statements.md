# Bank and card statements

Send your monthly bank or card statement to your Chief of Staff in chat, and Kin works out which
invoices were paid and which expenses the debits were. Nothing is recorded until you confirm.

## Sending a statement

Attach the statement your bank lets you download: a PDF, CSV, XLS or XLSX. Kin checks every
row against the statement: the opening balance plus credits less debits must come to the closing
balance and each running balance must follow from the one before. For a PDF, each row's date,
amount and balance must also be printed on its line of the page, and every line that starts with
a date must be a row or something Kin can see isn't one. When Kin's own reading of a PDF doesn't
pass, your agent reads its pages instead, and Kin takes each row's numbers from the PDF's own text
and tells the agent which row doesn't hold until it does. Matches start ticked only when all of
this holds; otherwise the card says what Kin couldn't confirm, and nothing is ticked for you.

If the PDF is password-protected, a card asks for the password. Type it there and it goes to Kin
only. If you write it in a message instead, Kin uses it once to open the file and doesn't store it
in its own records, but your message still contains it, so delete the message if you'd rather it
didn't. Kin tries at most five passwords from the chat for a file; the card still takes the right
one after that. Tick
**Remember for this account** and the next statement for that account opens on its own. The
same card has **Forget the password** later.

A scanned statement has no text to read. Your agent reads the pages instead, and the review card
says the rows came from images, so check the amounts against the statement before you tick them.

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

## How far Kin sees your bank

Kin sees your bank only through the statements you confirm. Money shows the day it sees your bank
to, such as **Bank known to Oct 31**, with **Upload a statement** to send the next one. An invoice
still owed says it isn't recorded as paid and where the bank is known to, and each payment says
whether it came from a statement or who recorded it.

A missing month holds that day back, even when later months are in: send the gap to move it on.
Once a month has been over for five days without its statement, the morning brief says so once,
with how many invoices it would confirm. A playbook's `statement_due_days` changes the five days.

## Bank alerts between statements

Most banks mail you when money moves. When mail that looks like your bank's alert reaches a mailbox
connected to Kin, Kin asks once in chat whether that address is your bank's alerts for the account
it names, in that currency. Nothing counts before your Yes, and Kin counts only mail your mailbox's
own service vouched for, never a reply or a forward. Money then shows, under the bank line, how many
alerts came in and out since that account's last statement and, when it can, an estimated balance.
Alerts never move the day the bank is known to: banks skip some and mail filters catch others.

When an alert shows money that matches an invoice still owed, Kin asks whether that invoice was
paid, naming the client, the invoice and the amount. Only your tap on one records the payment, on
the alert's day. Once a confirmed statement covers that day, the statement answers for the money:
its lines replace the alerts, and an alert the statement doesn't have is named on its card and kept
out of every figure. Under Bank alerts in Settings, Connections, the mailbox, you can stop counting
a sender, count it again, or tap **Ask me again** on one you said No to.

## Reading a statement again

**Read again** on a statement's card reads its file afresh, using a remembered password or asking
for it. Rows this statement already recorded are found again by date, amount and direction, however
the new reading spells them, and only rows not yet in Bank transactions are offered. If a row it
recorded before isn't in the new reading, the card names it and ticks nothing, so you decide.
Until you confirm again, **Undo** on the new card takes back what the earlier confirm recorded.
You can also ask your agent to read it again, or run
`t3 kin statement reread --statement <id> --apply` on the computer running Kin. Without `--apply`
the command only reports where the statement stands and changes nothing.

## Undoing a statement

**Undo this statement** on the card takes back everything it recorded: payments, TDS lines,
expenses marked paid and expenses it created, across every confirm since a read again; the card
says how many rows came from each. Each entry's history shows both the change and the
undo. You can confirm the card again afterwards.
