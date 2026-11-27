---------------------------- MODULE Questions ----------------------------
(* Two agents put questions to one person about the same thing (one intent, one record), over a
   few days, while the host may stop and start. A question may be asked for another chat (the
   asker lane, questions/askPerson.ts): then it has no default, may be held for the person's quiet
   hours before its card is posted, and its answer goes back to the chat that asked; unanswered
   after its raise's own day, or at its first when its person never signed in, it lapses and that
   chat is told once. Each action names the code it stands for, under apps/server/src/kin. Time is
   in ticks; a question's day is Delay ticks after it is asked (or posted), and a question with no
   safe default is raised RaiseGap ticks after its day. *)
EXTENDS Integers, FiniteSets

CONSTANTS Broken, MaxOutages

Agents == {"finance", "chief"}
Qs == {1, 2}            \* question slots: the second can only be a later ask
Delay == 2              \* rules.ts defaultDue: the end of the next working day
RaiseGap == 1           \* rules.ts raiseAt: the next working morning
DayLong == 1            \* KIN_CHOICE_CARD_TTL_MS: a plain card's day
Horizon == 7
DismissalWindow == 3    \* Seven days in planAsk, scaled to fit a repeat after expiry.

VARIABLES
  clock,    \* the host's wall clock
  up,       \* Kin is running
  outages,
  st,       \* kin_questions.state: "none", "open", "answered", "default_taken", "withdrawn",
            \* "dismissed", "lapsed"
  asker,    \* kin_questions.agent_id
  safe,     \* kin_questions.safe: the default may be taken alone
  leaves,   \* the default would send something out or move money (the truth, not the flag)
  askedAt, due,
  raised,   \* kin_questions.raised_at is set
  raises,   \* raise cards posted
  card,     \* the question's card takes taps (a raise replaces it with another that does)
  turns,    \* turns queued to take its default (kin_events, dedupe question:<id>)
  done,     \* times its default was done by a turn
  outside,  \* defaults done that left the company or moved money
  memo,     \* what a broken sweep remembers in memory only
  other,    \* kin_questions.for_chat_id is set: asked for another chat
  posted,   \* its card was posted (a held one has widget_id NULL until then)
  back,     \* turns its answer queued in the asker's lane (dedupe question-answered:<id>)
  there,    \* turns its answer started in the asked person's own chat
  dismissedAt, \* time of the first question's dismissal (-1 before)
  renewed,     \* the second ask was prompted by the person returning to the subject
  pend,     \* a broken return trip's answer, kept in memory until after commit
  unsigned, \* asked for another chat of someone who never signed in (people/signedIn.ts)
  raisedAt, \* when it was raised (-1 before); kept only for one asked for another chat
  told      \* lapse lines in the chat it was asked for, each with its asker's one turn there

vars == <<clock, up, outages, st, asker, safe, leaves, askedAt, due, raised, raises, card, turns,
          done, outside, memo, other, posted, back, there, pend, dismissedAt, renewed,
          unsigned, raisedAt, told>>
lane == <<other, posted, back, there, pend, dismissedAt, renewed>>
lapse == <<unsigned, raisedAt, told>>

Init ==
  /\ clock = 0 /\ up = TRUE /\ outages = 0
  /\ st = [q \in Qs |-> "none"]
  /\ asker = [q \in Qs |-> "finance"]
  /\ safe = [q \in Qs |-> FALSE]
  /\ leaves = [q \in Qs |-> FALSE]
  /\ askedAt = [q \in Qs |-> 0]
  /\ due = [q \in Qs |-> 0]
  /\ raised = [q \in Qs |-> FALSE]
  /\ raises = [q \in Qs |-> 0]
  /\ card = [q \in Qs |-> FALSE]
  /\ turns = [q \in Qs |-> 0]
  /\ done = [q \in Qs |-> 0]
  /\ outside = 0
  /\ memo = {}
  /\ other = [q \in Qs |-> FALSE]
  /\ posted = [q \in Qs |-> FALSE]
  /\ back = [q \in Qs |-> 0]
  /\ there = [q \in Qs |-> 0]
  /\ dismissedAt = -1 /\ renewed = FALSE
  /\ pend = {}
  /\ unsigned = [q \in Qs |-> FALSE]
  /\ raisedAt = [q \in Qs |-> -1]
  /\ told = [q \in Qs |-> 0]

Open == {q \in Qs : st[q] = "open"}
Unchanged(vs) == UNCHANGED vs

(* kin_ask through planAsk and recordAsk, or askPerson for another chat: an agent asks about the
   same record with the same intent. Refused while one is open (`repeats`, askPerson's
   `askedAgain`); a second slot is used only after the first. `says` is the default the agent
   names; safeDefault adds the words check. Asked for another chat there is no default, and in
   the person's quiet hours or away days (`holdFor`) it is stored with no card. *)
RecentDismissal(at) == dismissedAt >= 0 /\ at <= dismissedAt + DismissalWindow

Ask(q, a, says, isOut, isOther, isHeld, freshWords, isUnsigned) ==
  /\ up
  /\ st[q] = "none"
  /\ q = 2 => st[1] # "none"
  /\ isHeld => isOther
  /\ isUnsigned => isOther
  /\ clock + Delay + RaiseGap + (IF isOther THEN Delay ELSE 0) <= Horizon
  /\ Broken = "no-repeat-check" \/ Open = {}
  /\ freshWords => (q = 2 /\ ~isOther /\ RecentDismissal(clock))
  /\ q = 2 /\ ~isOther /\ RecentDismissal(clock) =>
       freshWords \/ Broken = "forget-dismissal"
  /\ renewed' = (renewed \/ freshWords)
  /\ st' = [st EXCEPT ![q] = "open"]
  /\ asker' = [asker EXCEPT ![q] = a]
  /\ leaves' = [leaves EXCEPT ![q] = isOut]
  /\ safe' = [safe EXCEPT ![q] =
       IF isOther /\ Broken # "default-for-other" THEN FALSE
       ELSE IF Broken = "no-words-check" THEN says ELSE says /\ ~isOut]
  /\ askedAt' = [askedAt EXCEPT ![q] = clock]
  /\ due' = [due EXCEPT ![q] = clock + Delay]
  /\ card' = [card EXCEPT ![q] = ~isHeld]
  /\ other' = [other EXCEPT ![q] = isOther]
  /\ posted' = [posted EXCEPT ![q] = ~isHeld]
  /\ memo' = IF Broken = "timer-in-memory" THEN memo \cup {q} ELSE memo
  /\ unsigned' = [unsigned EXCEPT ![q] = isUnsigned]
  /\ UNCHANGED <<clock, up, outages, raised, raises, turns, done, outside, back, there, pend, dismissedAt>>
  /\ UNCHANGED <<raisedAt, told>>

(* settleDue's postHeld: once the person's hold lets it through, the held card is posted and its
   day counted from then. *)
Post(q) ==
  /\ up
  /\ st[q] = "open" /\ ~posted[q]
  /\ posted' = [posted EXCEPT ![q] = TRUE]
  /\ card' = [card EXCEPT ![q] = TRUE]
  /\ due' = [due EXCEPT ![q] = clock + Delay]
  /\ UNCHANGED <<clock, up, outages, st, asker, safe, leaves, askedAt, raised, raises, turns, done,
                 outside, memo, other, back, there, pend, dismissedAt, renewed>>
  /\ UNCHANGED lapse

(* The answer of one asked for another chat goes back in the answer's own transaction
   (`sendBack`): Kin's line there and one turn of the asker there. The broken return trip keeps it
   in memory for after the commit, which a stop loses. *)
SendBack(q) ==
  IF ~other[q] THEN UNCHANGED <<back, pend>>
  ELSE IF Broken = "after-commit"
    THEN pend' = pend \cup {q} /\ UNCHANGED back
    ELSE back' = [back EXCEPT ![q] = back[q] + 1] /\ UNCHANGED pend

(* A broken return trip's after-commit step. *)
Deliver(q) ==
  /\ up /\ q \in pend
  /\ back' = [back EXCEPT ![q] = back[q] + 1]
  /\ pend' = pend \ {q}
  /\ UNCHANGED <<clock, up, outages, st, asker, safe, leaves, askedAt, due, raised, raises, card,
                 turns, done, outside, memo, other, posted, there, dismissedAt, renewed>>
  /\ UNCHANGED lapse

(* The person's tap, on the question's card or its raise card (cardAnswers.ts answerCard, in
   the tap's transaction). A closed card takes no tap (KinChatService.actOn). Asked for another
   chat, the tap is marked handled, so it starts no turn in the person's own chat. *)
Tap(q) ==
  /\ up
  /\ card[q]
  /\ Broken = "answer-after-take" \/ st[q] = "open"
  /\ st' = [st EXCEPT ![q] = "answered"]
  /\ card' = [card EXCEPT ![q] = FALSE]
  /\ SendBack(q)
  /\ there' = IF other[q] /\ Broken = "tap-wakes-there"
       THEN [there EXCEPT ![q] = there[q] + 1] ELSE there
  /\ UNCHANGED <<clock, up, outages, asker, safe, leaves, askedAt, due, raised, raises, turns,
                 done, outside, memo, other, posted, dismissedAt, renewed>>
  /\ UNCHANGED lapse

(* kin_ask_close: answered in words by its asker from the person's own message in its chat, or
   withdrawn (from the asking side, when asked for another chat). Words go back as a tap does. *)
Close(q, outcome) ==
  /\ up
  /\ st[q] = "open"
  /\ outcome = "answered" => posted[q]
  /\ outcome = "dismissed" => posted[q]
  /\ dismissedAt' = IF q = 1 /\ outcome = "dismissed" THEN clock ELSE dismissedAt
  /\ st' = [st EXCEPT ![q] = outcome]
  /\ card' = [card EXCEPT ![q] = FALSE]
  /\ IF outcome = "answered" THEN SendBack(q) ELSE UNCHANGED <<back, pend>>
  /\ UNCHANGED <<clock, up, outages, asker, safe, leaves, askedAt, due, raised, raises, turns,
                 done, outside, memo, other, posted, there, renewed>>
  /\ UNCHANGED lapse

(* A plain choice card stops taking taps a day after it was posted; an open question's does not
   (choiceCard.ts choiceExpired, untilAnswered). *)
Expire(q) ==
  /\ Broken = "day-expiry"
  /\ card[q] /\ st[q] = "open" /\ clock >= askedAt[q] + DayLong
  /\ card' = [card EXCEPT ![q] = FALSE]
  /\ UNCHANGED <<clock, up, outages, st, asker, safe, leaves, askedAt, due, raised, raises,
                 turns, done, outside, memo>>
  /\ UNCHANGED lane
  /\ UNCHANGED lapse

(* The bound: time stops where a held card could no longer be posted and raised in the horizon. *)
Tick ==
  /\ clock < Horizon
  /\ \A q \in Qs : (st[q] = "open" /\ ~posted[q]) => clock + 1 + Delay + RaiseGap + Delay <= Horizon
  \* An asked-for one not raised yet: time leaves room for its raise to have a day of its own.
  /\ \A q \in Qs : (st[q] = "open" /\ other[q] /\ ~unsigned[q] /\ ~raised[q]) =>
       clock + 1 + Delay <= Horizon
  /\ clock' = clock + 1
  /\ UNCHANGED <<up, outages, st, asker, safe, leaves, askedAt, due, raised, raises, card, turns,
                 done, outside, memo>>
  /\ UNCHANGED lane
  /\ UNCHANGED lapse

Stop ==
  /\ up /\ outages < MaxOutages
  /\ up' = FALSE /\ outages' = outages + 1
  /\ memo' = {}
  /\ pend' = {}
  /\ UNCHANGED <<clock, st, asker, safe, leaves, askedAt, due, raised, raises, card, turns, done,
                 outside, other, posted, back, there, dismissedAt, renewed>>
  /\ UNCHANGED lapse

Start ==
  /\ ~up /\ up' = TRUE
  /\ UNCHANGED <<clock, outages, st, asker, safe, leaves, askedAt, due, raised, raises, card,
                 turns, done, outside, memo>>
  /\ UNCHANGED lane
  /\ UNCHANGED lapse

(* openQuestions.ts settleDue on the deferral tick, takeDefault: one transaction moves an open,
   safe row past its day to default_taken, queues the asker's turn and closes the card. The
   broken sweep checks what it remembers instead of the row. *)
TakeDefault(q) ==
  /\ up
  /\ IF Broken = "memory-settled"
       THEN st[q] \in {"open", "default_taken"} /\ q \notin memo /\ safe[q]
       ELSE st[q] = "open" /\ (safe[q] \/ Broken = "no-safety")
  /\ Broken = "early" \/ clock >= due[q]
  /\ Broken # "timer-in-memory" \/ q \in memo
  /\ st' = [st EXCEPT ![q] = "default_taken"]
  /\ turns' = [turns EXCEPT ![q] = turns[q] + 1]
  /\ card' = [card EXCEPT ![q] = Broken = "answer-after-take"]
  /\ memo' = IF Broken = "memory-settled" THEN memo \cup {q} ELSE memo
  /\ UNCHANGED <<clock, up, outages, asker, safe, leaves, askedAt, due, raised, raises, done,
                 outside>>
  /\ UNCHANGED lane
  /\ UNCHANGED lapse

(* raise: no safe default, the next working morning after its day: one fresh card, once. A held
   one is raised only after its card reached them (settleDue's due query). *)
Raise(q) ==
  /\ up
  /\ st[q] = "open" /\ ~safe[q] /\ posted[q]
  /\ Broken = "raise-repeats" \/ ~raised[q]
  /\ Broken = "raise-unsigned" \/ ~unsigned[q]
  /\ clock >= due[q] + RaiseGap
  /\ Broken # "timer-in-memory" \/ q \in memo
  /\ raises[q] < 2
  /\ raised' = [raised EXCEPT ![q] = TRUE]
  /\ raises' = [raises EXCEPT ![q] = raises[q] + 1]
  /\ card' = [card EXCEPT ![q] = TRUE]
  /\ raisedAt' = IF other[q] THEN [raisedAt EXCEPT ![q] = clock] ELSE raisedAt
  /\ UNCHANGED <<clock, up, outages, st, asker, safe, leaves, askedAt, due, turns, done, outside,
                 memo>>
  /\ UNCHANGED lane
  /\ UNCHANGED <<unsigned, told>>

(* lapseAsked, in the sweep's transaction: asked for another chat and still open, it lapses at its
   raise's own day, or instead of its raise when its person never signed in. Its card closes, and
   the chat it was asked for hears once, with its asker's one turn there. The broken sweeps tell
   again on a rerun, lapse before the raised card had its day, or tell nobody. *)
Lapse(q) ==
  /\ up
  /\ other[q] /\ posted[q]
  /\ st[q] = "open" \/ (Broken = "lapse-repeats" /\ st[q] = "lapsed" /\ told[q] < 2)
  /\ IF raised[q]
       THEN Broken = "early-lapse" \/ clock >= raisedAt[q] + Delay
       ELSE unsigned[q] /\ clock >= due[q] + RaiseGap
  /\ Broken # "timer-in-memory" \/ q \in memo
  /\ st' = [st EXCEPT ![q] = "lapsed"]
  /\ card' = [card EXCEPT ![q] = FALSE]
  /\ told' = IF Broken = "lapse-silent" THEN told ELSE [told EXCEPT ![q] = told[q] + 1]
  /\ UNCHANGED <<clock, up, outages, asker, safe, leaves, askedAt, due, raised, raises, turns,
                 done, outside, memo>>
  /\ UNCHANGED lane
  /\ UNCHANGED <<unsigned, raisedAt>>

(* The asker's turn (LeadPrompt, dueTurnText): it does the default with its tools. Anything that
   would leave the company still stops at its Confirm card, which this model leaves out; the
   rule below is that the server never asks for such a default. *)
RunTurn(q) ==
  /\ up
  /\ turns[q] > done[q]
  /\ done' = [done EXCEPT ![q] = done[q] + 1]
  /\ outside' = IF leaves[q] THEN outside + 1 ELSE outside
  /\ UNCHANGED <<clock, up, outages, st, asker, safe, leaves, askedAt, due, raised, raises, card,
                 turns, memo>>
  /\ UNCHANGED lane
  /\ UNCHANGED lapse

Next ==
  \/ \E q \in Qs, a \in Agents, says \in BOOLEAN, isOut \in BOOLEAN, isOther \in BOOLEAN,
       isHeld \in BOOLEAN, freshWords \in BOOLEAN, isUnsigned \in BOOLEAN :
       Ask(q, a, says, isOut, isOther, isHeld, freshWords, isUnsigned)
  \/ \E q \in Qs : Tap(q) \/ Expire(q) \/ TakeDefault(q) \/ Raise(q) \/ RunTurn(q) \/ Lapse(q)
  \/ \E q \in Qs : Post(q) \/ Deliver(q)
  \/ \E q \in Qs, outcome \in {"answered", "withdrawn", "dismissed"} : Close(q, outcome)
  \/ Tick \/ Stop \/ Start

Fairness ==
  /\ WF_vars(Tick) /\ WF_vars(Start)
  /\ \A q \in Qs : WF_vars(TakeDefault(q)) /\ WF_vars(Raise(q)) /\ WF_vars(RunTurn(q))
  /\ \A q \in Qs : WF_vars(Lapse(q))
  /\ \A q \in Qs : WF_vars(Post(q)) /\ WF_vars(Deliver(q))

Spec == Init /\ [][Next]_vars /\ Fairness

\* Rules, in the owner's words in view.ts.
OnceWhileOpen == Cardinality(Open) <= 1
DismissalStands ==
  (st[2] # "none" /\ ~other[2] /\ RecentDismissal(askedAt[2]) /\ askedAt[2] >= dismissedAt) =>
    renewed
NeverBeforeItsDay == \A q \in Qs : turns[q] > 0 => (st[q] = "default_taken" /\ clock >= due[q])
TakenOnce == \A q \in Qs : turns[q] <= 1 /\ done[q] <= 1
AnsweredOrTaken == \A q \in Qs : st[q] = "answered" => turns[q] = 0
NothingLeaves == outside = 0
TapsWhileOpen == \A q \in Qs : (st[q] = "open" /\ posted[q]) => card[q]
RaisedOnce == \A q \in Qs : raises[q] <= 1
\* Every question ends: answered, its default taken and done, withdrawn, dismissed or lapsed; one
\* with no safe default asked in its own chat ends or rests, raised once, in Waiting on you.
Settles(q) ==
  \/ st[q] \in {"answered", "withdrawn", "dismissed", "lapsed"}
  \/ (st[q] = "default_taken" /\ done[q] = turns[q])
  \/ (st[q] = "open" /\ ~safe[q] /\ raised[q] /\ ~other[q])
AlwaysEnds == \A q \in Qs : (st[q] = "open") ~> Settles(q)
\* Asked for another chat and unanswered, it lapses: the chat it was asked for hears once, never
\* before its raise had a day of its own, and someone who never signed in isn't asked again.
ToldOnce == \A q \in Qs : told[q] <= 1
ToldWhenLapsed == \A q \in Qs : st[q] = "lapsed" => (other[q] /\ told[q] = 1)
LapsesAfterItsDay == \A q \in Qs : (st[q] = "lapsed" /\ raised[q]) => clock >= raisedAt[q] + Delay
UnsignedNotAskedAgain == \A q \in Qs : unsigned[q] => raises[q] = 0
\* Asked for another chat: nobody answers for the person, and the answer wakes the asker once, in
\* the chat that asked, never in the person's own.
NoDefaultForOther == \A q \in Qs : other[q] => turns[q] = 0
OneWake == \A q \in Qs : other[q] => (back[q] <= 1 /\ there[q] = 0)
AnswerGoesBack == \A q \in Qs : (other[q] /\ st[q] = "answered") ~> back[q] = 1
=============================================================================
