---------------------------- MODULE Send ----------------------------
(* A mail card that leaves the company: the agent asks, may correct itself with a newer card, the
   owner, a co-owner or a member taps, the account's sign-in can expire, the provider can fail and
   the server can restart. Each action names the code it stands for (paths under
   apps/server/src/kin). One action is one transaction, or one step of the after-tap fiber. *)
EXTENDS Naturals, FiniteSets

CONSTANTS Broken, Cards

People == {"owner", "coowner", "member"}
OwnerLevel == {"owner", "coowner"}
None == 0

VARIABLES
  card,      \* kin_connection_asks.state per card; "none" before the agent asks
  text,      \* which wording of the mail the card shows: 1 the draft, 2 the correction
  doc,       \* the invoice file version the card shows (Prepared.attachments)
  why,       \* reason of a stale or failed card
  next,      \* the card that came back with the same mail, if any
  by,        \* who moved it to sending
  tapLate,   \* Confirm landed while a newer card for the same invoice already showed
  job,       \* the after-tap fiber (work/cardAnswers.ts afterTap): lost on restart
  went,      \* times the provider accepted this card's mail
  wentDoc,   \* the file version that went
  pending,   \* askFor posted this card and has not yet replaced the older ones
  latestDoc, \* the invoice's current file version
  account,   \* the mail connection's sign-in
  asks, restarts, remakes, expiries, errors

vars == <<card, text, doc, why, next, by, tapLate, job, went, wentDoc, pending, latestDoc,
          account, asks, restarts, remakes, expiries, errors>>

Free == {c \in Cards : card[c] = "none"}
NewCard(c) == CHOOSE x \in Free : \A y \in Free : x <= y

Init ==
  /\ card = [c \in Cards |-> "none"]
  /\ text = [c \in Cards |-> 0]
  /\ doc = [c \in Cards |-> 0]
  /\ why = [c \in Cards |-> ""]
  /\ next = [c \in Cards |-> None]
  /\ by = [c \in Cards |-> ""]
  /\ tapLate = [c \in Cards |-> FALSE]
  /\ job = [c \in Cards |-> "idle"]
  /\ went = [c \in Cards |-> 0]
  /\ wentDoc = [c \in Cards |-> 0]
  /\ pending = None
  /\ latestDoc = 1
  /\ account = "ok"
  /\ asks = 0 /\ restarts = 0 /\ remakes = 0 /\ expiries = 0 /\ errors = 0

(* connections/ConnectionsService.ts askFor: prepareMail reads the invoice's current file, the ask
   row is inserted and levelGate.ask posts the card. Replacing older cards is a later statement. *)
AgentAsks ==
  /\ asks < 2 /\ pending = None /\ Free # {}
  /\ LET c == NewCard(Free) IN
       /\ card' = [card EXCEPT ![c] = "open"]
       /\ text' = [text EXCEPT ![c] = asks + 1]
       /\ doc' = [doc EXCEPT ![c] = latestDoc]
       /\ pending' = IF \E o \in Cards : o # c /\ card[o] = "open" THEN c ELSE None
  /\ asks' = asks + 1
  /\ UNCHANGED <<why, next, by, tapLate, job, went, wentDoc, latestDoc, account, restarts,
                 remakes, expiries, errors>>

(* askFor, after the post: open cards for the same invoice go stale, "Replaced by a newer card." *)
AgentReplacesOlder ==
  /\ pending # None
  /\ LET olds == {o \in Cards : o # pending /\ card[o] = "open"} IN
       IF Broken = "no-replace" THEN UNCHANGED <<card, why, next>>
       ELSE /\ card' = [o \in Cards |-> IF o \in olds THEN "stale" ELSE card[o]]
            /\ why' = [o \in Cards |-> IF o \in olds THEN "replaced" ELSE why[o]]
            /\ next' = [o \in Cards |-> IF o \in olds THEN pending ELSE next[o]]
  /\ pending' = None
  /\ UNCHANGED <<text, doc, by, tapLate, job, went, wentDoc, latestDoc, account, asks, restarts,
                 remakes, expiries, errors>>

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
                    /\ UNCHANGED <<text, doc, next, by, tapLate, went, wentDoc, pending, latestDoc,
                                   account, asks, restarts, remakes, expiries, errors>>
                 \/ /\ account = "ok" /\ (doc[c] = latestDoc \/ Broken = "no-file-check")
                    /\ card' = [card EXCEPT ![c] = "sending"]
                    /\ by' = [by EXCEPT ![c] = p]
                    /\ tapLate' = [tapLate EXCEPT ![c] = tapLate[c] \/ NewerShowing(c)]
                    /\ job' = [job EXCEPT ![c] = "queued"]
                    /\ UNCHANGED <<text, doc, why, next, went, wentDoc, pending, latestDoc, account,
                                   asks, restarts, remakes, expiries, errors>>

TapCancel(p, c) ==
  /\ card[c] = "open" /\ p \in OwnerLevel
  /\ card' = [card EXCEPT ![c] = "declined"]
  /\ UNCHANGED <<text, doc, why, next, by, tapLate, job, went, wentDoc, pending, latestDoc,
                 account, asks, restarts, remakes, expiries, errors>>

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
     \/ /\ account = "ok" /\ errors < 1
        /\ job' = [job EXCEPT ![c] = "error"]
        /\ errors' = errors + 1
        /\ UNCHANGED <<went, wentDoc>>
  /\ UNCHANGED <<card, text, doc, why, next, by, tapLate, pending, latestDoc, account, asks,
                 restarts, remakes, expiries>>

(* sendAsk's finish: sent, or failed; a sign-in failure returns the same mail for a fresh card. *)
SendRecorded(c) ==
  /\ job[c] \in {"went", "signin", "error"}
  /\ card' = [card EXCEPT ![c] = IF job[c] = "went" THEN "sent" ELSE "failed"]
  /\ why' = [why EXCEPT ![c] = IF job[c] = "went" THEN "" ELSE job[c]]
  /\ job' = [job EXCEPT ![c] = IF job[c] = "signin" THEN "fresh" ELSE "idle"]
  /\ UNCHANGED <<text, doc, next, by, tapLate, went, wentDoc, pending, latestDoc, account, asks,
                 restarts, remakes, expiries, errors>>

(* cardAnswers.ts sendAsked's `again`: freshAsk inserts the same mail with the current files and
   chat.ask posts it. *)
FreshCard(c) ==
  /\ job[c] = "fresh" /\ Free # {}
  /\ LET n == NewCard(Free) IN
       /\ card' = [card EXCEPT ![n] = "open"]
       /\ text' = [text EXCEPT ![n] = text[c]]
       /\ doc' = [doc EXCEPT ![n] = latestDoc]
       /\ next' = [next EXCEPT ![c] = n]
  /\ job' = [job EXCEPT ![c] = "idle"]
  /\ UNCHANGED <<why, by, tapLate, went, wentDoc, pending, latestDoc, account, asks, restarts,
                 remakes, expiries, errors>>

(* The server stops and starts: forked after-tap fibers are gone; every row stays. *)
Restart ==
  /\ restarts < 1
  /\ restarts' = restarts + 1
  /\ job' = [c \in Cards |-> "idle"]
  /\ pending' = None
  /\ UNCHANGED <<card, text, doc, why, next, by, tapLate, went, wentDoc, latestDoc, account, asks,
                 remakes, expiries, errors>>

SignInExpires ==
  /\ account = "ok" /\ expiries < 1
  /\ account' = "expired" /\ expiries' = expiries + 1
  /\ UNCHANGED <<card, text, doc, why, next, by, tapLate, job, went, wentDoc, pending, latestDoc,
                 asks, restarts, remakes, errors>>

SignInAgain ==
  /\ account = "expired" /\ account' = "ok"
  /\ UNCHANGED <<card, text, doc, why, next, by, tapLate, job, went, wentDoc, pending, latestDoc,
                 asks, restarts, remakes, expiries, errors>>

InvoiceRemade ==
  /\ remakes < 1
  /\ latestDoc' = latestDoc + 1 /\ remakes' = remakes + 1
  /\ UNCHANGED <<card, text, doc, why, next, by, tapLate, job, went, wentDoc, pending, account,
                 asks, restarts, expiries, errors>>

Next ==
  \/ AgentAsks \/ AgentReplacesOlder
  \/ \E p \in People, c \in Cards : TapConfirm(p, c) \/ TapCancel(p, c)
  \/ \E c \in Cards : ProviderSends(c) \/ SendRecorded(c) \/ FreshCard(c)
  \/ Restart \/ SignInExpires \/ SignInAgain \/ InvoiceRemade

Fair == /\ WF_vars(AgentReplacesOlder)
        /\ \A c \in Cards : WF_vars(ProviderSends(c)) /\ WF_vars(SendRecorded(c))
                            /\ WF_vars(FreshCard(c))
        /\ WF_vars(SignInAgain)

Spec == Init /\ [][Next]_vars /\ Fair

------------------------------------------------------------------------------------------------
SentAtMostOnce == \A c \in Cards : went[c] <= 1
MemberNeverSends == \A c \in Cards : went[c] > 0 => by[c] \in OwnerLevel
SentAsShown == \A c \in Cards : went[c] > 0 => wentDoc[c] = doc[c]
ReplacedNeverSends == \A c \in Cards : went[c] > 0 => ~tapLate[c] /\ why[c] # "replaced"
ModelHasRoom == \A c \in Cards : job[c] = "fresh" => Free # {}

ConfirmedSettles == \A c \in Cards : card[c] = "sending" ~> card[c] \in {"sent", "failed"}
FailureComesBack ==
  \A c \in Cards : (card[c] = "failed" \/ (card[c] = "stale" /\ why[c] = "doc")) ~> next[c] # None
=============================================================================
