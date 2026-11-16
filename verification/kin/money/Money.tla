---------------------------- MODULE Money ----------------------------
(* Money recorded on a Confirm: one client transfer of 1 unit against an invoice that owes 2.
   An agent's receipt card says it came in; the bank statement shows it as a row, and the same
   file may be sent again. The owner, a co-owner or a member taps, on one device or two; the
   invoice can be edited, a payment taken back, a statement undone, Kin restarted. Each action
   names the code it stands for (paths under apps/server/src/kin). One action is one
   transaction: a tap's answer runs in the tap's own (work/cardAnswers.ts answerChoice). *)
EXTENDS Naturals, FiniteSets

CONSTANTS Broken

People == {"owner", "coowner", "member"}
OwnerLevel == {"owner", "coowner"}
Cards == {1, 2}
Stmts == {1, 2}
Other(s) == IF s = 1 THEN 2 ELSE 1
Src(s) == IF s = 1 THEN "s1" ELSE "s2"

VARIABLES
  amt,      \* the invoice's amount
  rev,      \* the invoice's kin_records.rev: every payment, void and edit moves it
  pays,     \* kin_record_payments on the invoice:
            \*   [n, src ("r", "s1" or "s2"), card, minor, shown, live, by, stale, receipted]
  rc,       \* kin_receipt_proposals.state per receipt card: none, open, made, declined
  rsnap,    \* the invoice revision the card's snapshot holds (snapshotOf: against.rev, paid)
  pending,  \* only in the variant record-after-tap: made cards whose payment is not yet written
  st,       \* kin_bank_statements per statement: none, choose (currency card up), read, applied
  cur,      \* the currency picked on the currency card: "?", "INR" (the invoice's), "USD"
  srev,     \* the review card's selection revision; a card from an earlier read shows less
  seenAt,   \* the invoice's amount and others' payments when the review was built (Candidate.seen)
  match,    \* what the review does with the row: pay, recorded, held, none
  held,     \* the statement has an entry for the row (kin_bank_statement_entries)
  asks, reads, edits, voids, undos, receipts, restarts

vars == <<amt, rev, pays, rc, rsnap, pending, st, cur, srev, seenAt, match, held, asks, reads,
          edits, voids, undos, receipts, restarts>>

Live == {x \in pays : x.live}
Paid == Cardinality({x \in Live : x.minor = 1}) + 2 * Cardinality({x \in Live : x.minor = 2})
Owed == amt - Paid
\* The bound: at most two of these, once each.
Trouble == edits + voids + undos + restarts
Calm == Trouble < 2

Pay(src, card, minor, shown, by, stale) ==
  pays' = pays \cup {[n |-> Cardinality(pays) + 1, src |-> src, card |-> card, minor |-> minor,
                      shown |-> shown, live |-> TRUE, by |-> by, stale |-> stale,
                      receipted |-> FALSE]}

Init ==
  /\ amt = 2 /\ rev = 0 /\ pays = {}
  /\ rc = [c \in Cards |-> "none"] /\ rsnap = [c \in Cards |-> 0] /\ pending = {}
  /\ st = [s \in Stmts |-> "none"] /\ cur = [s \in Stmts |-> "?"] /\ srev = [s \in Stmts |-> 0]
  /\ seenAt = [s \in Stmts |-> <<2, {}>>] /\ match = [s \in Stmts |-> "none"]
  /\ held = [s \in Stmts |-> FALSE]
  /\ asks = 0 /\ reads = 0 /\ edits = 0 /\ voids = 0 /\ undos = 0 /\ receipts = 0 /\ restarts = 0

(* gendocs/receiptProposals.ts proposeReceipt + the card: an advance of 1 set against the invoice,
   with the figures the card shows (snapshotOf). The agent asks again only when no receipt was
   made of this money: proposalOutcome tells it, and the money it reads on the invoice. *)
AgentAsks ==
  /\ asks < 2 /\ \A c \in Cards : rc[c] # "made" /\ Live = {}
  /\ rc' = [rc EXCEPT ![asks + 1] = "open"]
  /\ rsnap' = [rsnap EXCEPT ![asks + 1] = rev]
  /\ asks' = asks + 1
  /\ UNCHANGED <<amt, rev, pays, pending, st, cur, srev, seenAt, match, held, reads, edits, voids,
                 undos, receipts, restarts>>

(* receiptProposals.ts answerReceiptCard: owner level; answered once; the figures still as the
   card showed; then receipts.ts recordReceipt -> setAgainst -> KinRecords.pay, never more than
   the invoice still owes. Any refusal rolls the tap back and the card stays as it was. *)
TapReceipt(p, c) ==
  /\ \/ rc[c] = "open" /\ (rsnap[c] = rev \/ Broken = "no-snapshot-check")
     \* Only in the variant taps-race: a second phone's tap read the card before the first
     \* tap's transaction committed, as if the two were not serialized.
     \/ Broken = "taps-race" /\ rc[c] = "made" /\ rsnap[c] + 1 = rev
  /\ p \in OwnerLevel \/ Broken = "member-records"
  /\ LET minor == IF Broken = "pay-balance" THEN Owed ELSE 1 IN
       /\ minor >= 1 /\ (minor <= Owed \/ Broken = "taps-race")
       /\ rc' = [rc EXCEPT ![c] = "made"]
       /\ IF Broken = "record-after-tap"
            THEN /\ pending' = pending \cup {c} /\ UNCHANGED <<pays, rev>>
            ELSE /\ Pay("r", c, minor, 1, p, rsnap[c] # rev /\ Broken # "taps-race") /\ rev' = rev + 1
                 /\ UNCHANGED pending
  /\ UNCHANGED <<amt, rsnap, st, cur, srev, seenAt, match, held, asks, reads, edits, voids, undos,
                 receipts, restarts>>

TapReceiptCancel(p, c) ==
  /\ rc[c] = "open" /\ p \in OwnerLevel
  /\ rc' = [rc EXCEPT ![c] = "declined"]
  /\ UNCHANGED <<amt, rev, pays, rsnap, pending, st, cur, srev, seenAt, match, held, asks, reads,
                 edits, voids, undos, receipts, restarts>>

(* Only in the variant record-after-tap: the receipt written after the tap commits. *)
RecordLater(c) ==
  /\ c \in pending
  /\ Pay("r", c, 1, 1, "owner", FALSE) /\ rev' = rev + 1
  /\ pending' = pending \ {c}
  /\ UNCHANGED <<amt, rc, rsnap, st, cur, srev, seenAt, match, held, asks, reads, edits, voids,
                 undos, receipts, restarts>>

(* work/statements/statementReview.ts saveRead: a read, the first or again (the same file sent
   again is statement 2, its rows the same bank rows, statementApply.ts twinRows). The file names
   no currency, so the currency card goes up; applied_at goes back to NULL and the revision up. *)
Read(s) ==
  /\ reads < 3 /\ (s = 1 \/ st[1] # "none")
  /\ st' = [st EXCEPT ![s] = "choose"]
  /\ cur' = [cur EXCEPT ![s] = "?"]
  /\ srev' = [srev EXCEPT ![s] = IF st[s] = "none" THEN 0 ELSE srev[s] + 1]
  /\ reads' = reads + 1
  /\ UNCHANGED <<amt, rev, pays, rc, rsnap, pending, seenAt, match, held, asks, edits, voids, undos,
                 receipts, restarts>>

ReceiptPaid == \E x \in Live : x.src = "r"
\* statementReview.ts invoiceSeen: the amount, and the live payments this statement didn't record.
Seen(s) == <<amt, {x.n : x \in {y \in Live : y.src # Src(s)}}>>

(* statementReview.ts answerCurrencyCard: owner level, the card of the current read; buildReview
   matches the rows in that currency (statementMatch.ts) and saveRead posts a fresh card. A row
   this statement already recorded is held; a payment already on the invoice with no bank row is
   offered as recorded; in another currency the invoice is no candidate. *)
Pick(p, s, c) ==
  /\ st[s] = "choose" /\ p \in OwnerLevel
  /\ st' = [st EXCEPT ![s] = "read"]
  /\ cur' = [cur EXCEPT ![s] = c]
  /\ srev' = [srev EXCEPT ![s] = srev[s] + 1]
  /\ seenAt' = [seenAt EXCEPT ![s] = Seen(s)]
  /\ match' = [match EXCEPT ![s] =
                 IF held[s] /\ Broken # "undo-forgets-held" THEN "held"
                 ELSE IF c = "USD" THEN "none"
                 ELSE IF ReceiptPaid THEN "recorded"
                 ELSE IF Owed >= 1 THEN "pay" ELSE "none"]
  /\ UNCHANGED <<amt, rev, pays, rc, rsnap, pending, held, asks, reads, edits, voids, undos,
                 receipts, restarts>>

(* statementApply.ts applyStatement, one transaction: the owner himself; the card's revision is
   the stored one; a row this statement still holds (heldRows: kept by its receipt through an
   undo) is skipped, and a row another statement has an entry for is left as it is (elsewhere); a recorded match needs its payment still live; a payment needs the invoice's
   amount and the payments others recorded on it unchanged since the read (invoiceSeen), and never
   more than it owes (KinRecords.pay). A tap from a
   second device still showing an earlier read carries that read's revision and changes nothing,
   as does a co-owner's or a member's: no step. *)
ConfirmStatement(p, s) ==
  /\ st[s] = "read" /\ p = "owner"
  /\ LET elsewhere == held[Other(s)] /\ Broken # "no-elsewhere"
         kept == held[s] /\ Broken # "undo-forgets-held"
         stale == seenAt[s] # Seen(s)
     IN \/ /\ elsewhere \/ kept \/ match[s] \in {"held", "none"}
           /\ UNCHANGED <<pays, rev, held>>
        \/ /\ ~elsewhere /\ ~kept /\ match[s] = "recorded" /\ ReceiptPaid
           /\ held' = [held EXCEPT ![s] = TRUE]
           /\ UNCHANGED <<pays, rev>>
        \/ /\ ~elsewhere /\ ~kept /\ match[s] = "pay"
           /\ ~stale \/ Broken = "no-seen-check"
           /\ Owed >= 1
           /\ Pay(Src(s), 0, 1, 1, p, stale) /\ rev' = rev + 1
           /\ held' = [held EXCEPT ![s] = TRUE]
  /\ st' = [st EXCEPT ![s] = "applied"]
  /\ UNCHANGED <<amt, rc, rsnap, pending, cur, srev, seenAt, match, asks, reads, edits, voids, undos,
                 receipts, restarts>>

(* statementApply.ts undoStatement: the owner himself; each payment it made is taken back unless a
   receipt was issued for it, which keeps its row (and the entry) recorded. *)
Undo(s) ==
  /\ st[s] = "applied" /\ undos < 1 /\ Calm
  /\ LET kept == {x \in pays : x.src = Src(s) /\ x.live /\ x.receipted} IN
       /\ pays' = {IF x.src = Src(s) /\ x.live /\ ~x.receipted THEN [x EXCEPT !.live = FALSE] ELSE x
                   : x \in pays}
       /\ held' = [held EXCEPT ![s] = kept # {}]
       /\ rev' = IF \E x \in pays : x.src = Src(s) /\ x.live /\ ~x.receipted THEN rev + 1 ELSE rev
  /\ st' = [st EXCEPT ![s] = "read"]
  /\ undos' = undos + 1
  /\ UNCHANGED <<amt, rc, rsnap, pending, cur, srev, seenAt, match, asks, reads, edits, voids,
                 receipts, restarts>>

(* gendocs/receipts.ts forPayment: a receipt for a payment a statement recorded. It records no new
   money, so it needs no card (createsMoney is false). *)
IssueReceipt(s) ==
  /\ receipts < 1 /\ \E x \in pays : x.src = Src(s) /\ x.live /\ ~x.receipted
  /\ pays' = {IF x.src = Src(s) /\ x.live THEN [x EXCEPT !.receipted = TRUE] ELSE x : x \in pays}
  /\ receipts' = receipts + 1
  /\ UNCHANGED <<amt, rev, rc, rsnap, pending, st, cur, srev, seenAt, match, held, asks, reads,
                 edits, voids, undos, restarts>>

(* KinRecords.voidPayment: the owner takes a payment back; its receipt is void with it. *)
Void ==
  /\ voids < 1 /\ Calm /\ Live # {}
  /\ \E y \in Live :
       pays' = {IF x = y THEN [x EXCEPT !.live = FALSE] ELSE x : x \in pays}
  /\ rev' = rev + 1 /\ voids' = voids + 1
  /\ UNCHANGED <<amt, rc, rsnap, pending, st, cur, srev, seenAt, match, held, asks, reads, edits,
                 undos, receipts, restarts>>

(* KinRecords.update: the invoice re-issued or its amount changed; never below what it received. *)
EditInvoice ==
  /\ edits < 1 /\ Calm
  /\ \E a \in 0..2 : ((a >= Paid /\ a >= 1) \/ Broken = "edit-below-received") /\ amt' = a
  /\ rev' = rev + 1 /\ edits' = edits + 1
  /\ UNCHANGED <<pays, rc, rsnap, pending, st, cur, srev, seenAt, match, held, asks, reads, voids,
                 undos, receipts, restarts>>

(* Kin stops and starts: every committed row stays; work forked after a tap (the receipt's PDF)
   is lost, and asking again makes it. *)
Restart ==
  /\ restarts < 1 /\ Calm
  /\ pending' = {} /\ restarts' = restarts + 1
  /\ UNCHANGED <<amt, rev, pays, rc, rsnap, st, cur, srev, seenAt, match, held, asks, reads, edits,
                 voids, undos, receipts>>

Next ==
  \/ AgentAsks \/ Void \/ EditInvoice \/ Restart
  \/ \E p \in People, c \in Cards : TapReceipt(p, c) \/ TapReceiptCancel(p, c)
  \/ \E c \in Cards : RecordLater(c)
  \/ \E s \in Stmts : Read(s) \/ Undo(s) \/ IssueReceipt(s)
  \/ \E p \in People, s \in Stmts, c \in {"INR", "USD"} : Pick(p, s, c)
  \/ \E p \in People, s \in Stmts : ConfirmStatement(p, s)

Spec == Init /\ [][Next]_vars

------------------------------------------------------------------------------------------------
\* A CONSTRAINT: a broken variant can record without end; TLC stops exploring past four.
Bounded == Cardinality(pays) <= 4

MemberNeverRecords == \A x \in pays : x.by \in OwnerLevel
OncePerConfirm == \A c \in Cards : Cardinality({x \in pays : x.src = "r" /\ x.card = c}) <= 1
RecordedAsShown == \A x \in pays : x.minor = x.shown
StaleNeverRecords == \A x \in pays : ~x.stale
MoneyInBounded == Paid <= amt /\ Paid <= 1
RowOnce == Cardinality({x \in Live : x.src # "r"}) <= 1
ConfirmedIsRecorded ==
  \A c \in Cards : (rc[c] = "made" /\ c \notin pending) => \E x \in pays : x.src = "r" /\ x.card = c
=============================================================================
