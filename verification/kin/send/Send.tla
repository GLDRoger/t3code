---------------------------- MODULE Send ----------------------------
(* A mail card that leaves the company: the agent asks, may correct itself with a newer card, the
   owner, a co-owner or a member taps, the account's sign-in can expire, the provider can fail and
   the server can restart. Each action names the code it stands for (paths under
   apps/server/src/kin). One action is one transaction, or one step of the after-tap fiber. *)
EXTENDS Naturals, FiniteSets

CONSTANTS Broken, Cards

People == {"owner", "member"}
OwnerLevel == {"owner"}
None == 0

VARIABLES
  card,      \* kin_connection_asks.state per card; "none" before the agent asks
  text,      \* which wording of the mail the card shows: 1 the draft, 2 the correction
  doc,       \* the invoice file version the card shows (Prepared.attachments)
  why,       \* reason of a stale or failed card
  next,      \* the card that came back with the same mail, if any
  by,        \* who moved it to sending
  tapLate,   \* Confirm landed while a newer card for the same invoice already showed
  oldFile,   \* Confirm landed after the invoice was re-made
  job,       \* the after-tap fiber (work/cardAnswers.ts afterTap): lost on restart
  owes,      \* kin_connection_asks.owes_card: set with the failure, cleared once the new card binds
  went,      \* times the provider accepted this card's mail
  wentDoc,   \* the file version that went
  pending,   \* askFor posted this card and has not yet replaced the older ones
  latestDoc, \* the invoice's current file version
  account,   \* the mail connection's sign-in
  asks, restarts, remakes, expiries, errors

vars == <<card, text, doc, why, next, by, tapLate, oldFile, job, owes, went, wentDoc, pending,
          latestDoc, account, asks, restarts, remakes, expiries, errors>>

Free == {c \in Cards : card[c] = "none"}
\* The bound: at most two kinds of trouble in one run, each at most once.
Trouble == remakes + expiries + errors + restarts
Calm == Trouble < 2
NewCard(c) == CHOOSE x \in Free : \A y \in Free : x <= y

Init ==
  /\ card = [c \in Cards |-> "none"]
  /\ text = [c \in Cards |-> 0]
  /\ doc = [c \in Cards |-> 0]
  /\ why = [c \in Cards |-> ""]
  /\ next = [c \in Cards |-> None]
  /\ by = [c \in Cards |-> ""]
  /\ tapLate = [c \in Cards |-> FALSE]
  /\ oldFile = [c \in Cards |-> FALSE]
  /\ job = [c \in Cards |-> "idle"]
  /\ owes = [c \in Cards |-> FALSE]
  /\ went = [c \in Cards |-> 0]
  /\ wentDoc = [c \in Cards |-> 0]
  /\ pending = None
  /\ latestDoc = 1
  /\ account = "ok"
  /\ asks = 0 /\ restarts = 0 /\ remakes = 0 /\ expiries = 0 /\ errors = 0

Olds(c) == {o \in Cards : o # c /\ card[o] = "open"}

(* connections/ConnectionsService.ts askFor: prepareMail reads the invoice's current file, the ask
   row is inserted and levelGate.ask posts the card; its bind (replaceOlder) marks the older open
   cards stale in the card's own transaction. *)
AgentAsks ==
  /\ asks < 2 /\ pending = None /\ Free # {}
  /\ LET c == NewCard(Free) IN
       /\ text' = [text EXCEPT ![c] = asks + 1]
       /\ doc' = [doc EXCEPT ![c] = latestDoc]
       /\ IF Broken \in {"no-replace", "replace-after-post"}
            THEN /\ card' = [card EXCEPT ![c] = "open"]
                 /\ pending' = IF Broken = "replace-after-post" /\ Olds(c) # {} THEN c ELSE None
                 /\ UNCHANGED <<why, next>>
            ELSE /\ card' = [o \in Cards |-> IF o = c THEN "open"
                                            ELSE IF o \in Olds(c) THEN "stale" ELSE card[o]]
                 /\ why' = [o \in Cards |-> IF o \in Olds(c) THEN "replaced" ELSE why[o]]
                 /\ next' = [o \in Cards |-> IF o \in Olds(c) THEN c ELSE next[o]]
                 /\ pending' = None
  /\ asks' = asks + 1
  /\ UNCHANGED <<by, tapLate, oldFile, job, owes, went, wentDoc, latestDoc, account, restarts,
                 remakes, expiries, errors>>

(* Only in the variant "replace-after-post", as the code was before: a later statement. *)
AgentReplacesOlder ==
  /\ pending # None
  /\ card' = [o \in Cards |-> IF o \in Olds(pending) THEN "stale" ELSE card[o]]
  /\ why' = [o \in Cards |-> IF o \in Olds(pending) THEN "replaced" ELSE why[o]]
  /\ next' = [o \in Cards |-> IF o \in Olds(pending) THEN pending ELSE next[o]]
  /\ pending' = None
  /\ UNCHANGED <<text, doc, by, tapLate, oldFile, job, owes, went, wentDoc, latestDoc, account, asks,
                 restarts, remakes, expiries, errors>>

NewerShowing(c) == \E n \in Cards : card[n] # "none" /\ text[n] > text[c]

(* connections/ConnectionsService.ts answerAsk, in the tap's transaction (work/cardAnswers.ts
   answerChoice), then sql.afterCommit forks sendAsked. *)
TapConfirm(p, c) ==
  /\ card[c] # "none"
  /\ \/ /\ p \notin OwnerLevel /\ Broken # "member-confirms"
        /\ UNCHANGED vars
     \/ /\ p \in OwnerLevel \/ Broken = "member-confirms"
        /\ \/ /\ card[c] # "open" /\ ~(Broken = "no-answered-check" /\ card[c] = "sending")
              /\ UNCHANGED vars
           \/ /\ card[c] = "open" \/ (Broken = "no-answered-check" /\ card[c] = "sending")
              /\ \/ /\ account = "expired"
                    /\ UNCHANGED vars
                 \/ /\ account = "ok" /\ doc[c] # latestDoc /\ Broken # "no-file-check"
                    /\ card' = [card EXCEPT ![c] = "stale"]
                    /\ why' = [why EXCEPT ![c] = "doc"]
                    /\ job' = [job EXCEPT ![c] = "fresh"]
                    /\ owes' = [owes EXCEPT ![c] = TRUE]
                    /\ UNCHANGED <<text, doc, next, by, tapLate, oldFile, went, wentDoc, pending, latestDoc,
                                   account, asks, restarts, remakes, expiries, errors>>
                 \/ /\ account = "ok" /\ (doc[c] = latestDoc \/ Broken = "no-file-check")
                    /\ card' = [card EXCEPT ![c] = "sending"]
                    /\ by' = [by EXCEPT ![c] = p]
                    /\ tapLate' = [tapLate EXCEPT ![c] = tapLate[c] \/ NewerShowing(c)]
                    /\ oldFile' = [oldFile EXCEPT ![c] = oldFile[c] \/ doc[c] # latestDoc]
                    /\ job' = [job EXCEPT ![c] = "queued"]
                    /\ UNCHANGED <<text, doc, why, next, owes, went, wentDoc, pending, latestDoc, account,
                                   asks, restarts, remakes, expiries, errors>>

TapCancel(p, c) ==
  /\ card[c] = "open" /\ p \in OwnerLevel
  /\ card' = [card EXCEPT ![c] = "declined"]
  /\ UNCHANGED <<text, doc, why, next, by, tapLate, oldFile, job, owes, went, wentDoc, pending,
                 latestDoc, account, asks, restarts, remakes, expiries, errors>>

(* sendAsk: only an ask in 'sending'; withSignIn calls the provider with the card's own files
   (Sending.ts sendMail, filesOf by attachmentId and sha256). *)
ProviderSends(c) ==
  /\ job[c] = "queued" /\ card[c] = "sending"
  /\ \/ /\ account = "expired"
        /\ job' = [job EXCEPT ![c] = "signin"]
        /\ UNCHANGED <<went, wentDoc, errors>>
     \/ /\ account = "ok"
        /\ went' = [went EXCEPT ![c] = went[c] + 1]
        /\ wentDoc' = [wentDoc EXCEPT ![c] = IF Broken = "send-latest-file" THEN latestDoc ELSE doc[c]]
        /\ job' = [job EXCEPT ![c] = "went"]
        /\ UNCHANGED errors
     \/ /\ account = "ok" /\ errors < 1 /\ Calm
        /\ job' = [job EXCEPT ![c] = "error"]
        /\ errors' = errors + 1
        /\ UNCHANGED <<went, wentDoc>>
  /\ UNCHANGED <<card, text, doc, why, next, by, tapLate, oldFile, owes, pending, latestDoc, account,
                 asks, restarts, remakes, expiries>>

(* sendAsk's finish: sent, or failed with the same mail returned for a fresh card; owes_card is set
   in the same UPDATE as the failure. *)
SendRecorded(c) ==
  /\ job[c] \in {"went", "signin", "error"}
  /\ card' = [card EXCEPT ![c] = IF job[c] = "went" THEN "sent" ELSE "failed"]
  /\ why' = [why EXCEPT ![c] = IF job[c] = "went" THEN "" ELSE job[c]]
  /\ job' = [job EXCEPT ![c] = IF job[c] = "went" \/ (job[c] = "error" /\ Broken = "error-loses-mail")
                                THEN "idle" ELSE "fresh"]
  /\ owes' = [owes EXCEPT ![c] = job'[c] = "fresh"]
  /\ UNCHANGED <<text, doc, next, by, tapLate, oldFile, went, wentDoc, pending, latestDoc, account, asks,
                 restarts, remakes, expiries, errors>>

Newer(c) == {n \in Cards : card[n] # "none" /\ text[n] > text[c]}

(* cardAnswers.ts showOutcome: freshAsk inserts the same mail with the current files and chat.ask
   posts it, unless the agent asked for this mail again since (superseded): then that card stands.
   Either way the failed ask owes no card any more (bind, or freshAsk on superseded). chat.ask is
   idempotent on its clientMessageId, so a restart between posting and binding re-binds the same
   card rather than posting a second one. *)
FreshCard(c) ==
  /\ job[c] = "fresh"
  /\ IF Newer(c) # {} /\ Broken # "copy-beside-correction"
       THEN /\ next' = [next EXCEPT ![c] = CHOOSE n \in Newer(c) : TRUE]
            /\ UNCHANGED <<card, text, doc>>
       ELSE /\ Free # {}
            /\ LET n == NewCard(Free) IN
                 /\ card' = [card EXCEPT ![n] = "open"]
                 /\ text' = [text EXCEPT ![n] = text[c]]
                 /\ doc' = [doc EXCEPT ![n] = latestDoc]
                 /\ next' = [next EXCEPT ![c] = n]
  /\ job' = [job EXCEPT ![c] = "idle"]
  /\ owes' = [owes EXCEPT ![c] = FALSE]
  /\ UNCHANGED <<why, by, tapLate, oldFile, went, wentDoc, pending, latestDoc, account, asks, restarts,
                 remakes, expiries, errors>>

(* The server stops and starts: forked after-tap fibers are gone; every row stays. layer.ts then
   runs resumeInterruptedSends for asks still sending from before the start, and for failed asks
   that still owe their new card (interruptedSends, owes_card). *)
Restart ==
  /\ restarts < 1 /\ Calm
  /\ restarts' = restarts + 1
  /\ job' = [c \in Cards |-> IF card[c] = "sending" /\ Broken # "no-resume" THEN "recover"
                            ELSE IF owes[c] /\ Broken # "no-owed-card" THEN "fresh" ELSE "idle"]
  /\ pending' = None
  /\ UNCHANGED <<card, text, doc, why, next, by, tapLate, oldFile, owes, went, wentDoc, latestDoc,
                 account, asks, remakes, expiries, errors>>

(* interruptedSends: failed, "may or may not have gone", the same mail on a fresh card. *)
Recovered(c) ==
  /\ job[c] = "recover" /\ card[c] = "sending"
  /\ card' = [card EXCEPT ![c] = "failed"]
  /\ why' = [why EXCEPT ![c] = "restart"]
  /\ job' = [job EXCEPT ![c] = "fresh"]
  /\ owes' = [owes EXCEPT ![c] = TRUE]
  /\ UNCHANGED <<text, doc, next, by, tapLate, oldFile, went, wentDoc, pending, latestDoc, account, asks,
                 restarts, remakes, expiries, errors>>

SignInExpires ==
  /\ account = "ok" /\ expiries < 1 /\ Calm
  /\ account' = "expired" /\ expiries' = expiries + 1
  /\ UNCHANGED <<card, text, doc, why, next, by, tapLate, oldFile, job, owes, went, wentDoc, pending,
                 latestDoc, asks, restarts, remakes, errors>>

SignInAgain ==
  /\ account = "expired" /\ account' = "ok"
  /\ UNCHANGED <<card, text, doc, why, next, by, tapLate, oldFile, job, owes, went, wentDoc, pending,
                 latestDoc, asks, restarts, remakes, expiries, errors>>

InvoiceRemade ==
  /\ remakes < 1 /\ Calm
  /\ latestDoc' = latestDoc + 1 /\ remakes' = remakes + 1
  /\ UNCHANGED <<card, text, doc, why, next, by, tapLate, oldFile, job, owes, went, wentDoc, pending,
                 account, asks, restarts, expiries, errors>>

Next ==
  \/ AgentAsks \/ AgentReplacesOlder
  \/ \E p \in People, c \in Cards : TapConfirm(p, c) \/ TapCancel(p, c)
  \/ \E c \in Cards : ProviderSends(c) \/ SendRecorded(c) \/ FreshCard(c) \/ Recovered(c)
  \/ Restart \/ SignInExpires \/ SignInAgain \/ InvoiceRemade

Fair == /\ WF_vars(AgentReplacesOlder)
        /\ \A c \in Cards : WF_vars(ProviderSends(c)) /\ WF_vars(SendRecorded(c))
                            /\ WF_vars(FreshCard(c)) /\ WF_vars(Recovered(c))
        /\ WF_vars(SignInAgain)

Spec == Init /\ [][Next]_vars /\ Fair

------------------------------------------------------------------------------------------------
SentAtMostOnce == \A c \in Cards : went[c] <= 1
MemberNeverSends == \A c \in Cards : went[c] > 0 => by[c] \in OwnerLevel
SentAsShown == \A c \in Cards : went[c] > 0 => wentDoc[c] = doc[c]
ReplacedNeverSends == \A c \in Cards : went[c] > 0 => ~tapLate[c] /\ why[c] # "replaced"
\* A CONSTRAINT: a broken variant can send without end; TLC stops exploring past two sends.
SendsBounded == \A c \in Cards : went[c] <= 2
OutdatedNeverSends == \A c \in Cards : went[c] > 0 => ~oldFile[c]
ModelHasRoom == \A c \in Cards : job[c] = "fresh" => Free # {}

ConfirmedSettles == \A c \in Cards : card[c] = "sending" ~> card[c] \in {"sent", "failed"}
\* "Comes back": on a new card, or on the newer card the agent itself put up for this mail.
FailureComesBack ==
  \A c \in Cards : (card[c] = "failed" \/ (card[c] = "stale" /\ why[c] = "doc"))
                    ~> (next[c] # None \/ Newer(c) # {})
=============================================================================
