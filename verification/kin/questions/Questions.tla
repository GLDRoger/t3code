---------------------------- MODULE Questions ----------------------------
(* Two agents put questions to one person about the same thing (one intent, one record), over a
   few days, while the host may stop and start. Each action names the code it stands for, under
   apps/server/src/kin. Time is in ticks; a question's day is Delay ticks after it is asked, and a
   question with no safe default is raised RaiseGap ticks after its day. *)
EXTENDS Integers, FiniteSets

CONSTANTS Broken, MaxOutages

Agents == {"finance", "chief"}
Qs == {1, 2}            \* question slots: the second can only be a later ask
Delay == 2              \* rules.ts defaultDue: the end of the next working day
RaiseGap == 1           \* rules.ts raiseAt: the next working morning
DayLong == 1            \* KIN_CHOICE_CARD_TTL_MS: a plain card's day
Horizon == 7

VARIABLES
  clock,    \* the host's wall clock
  up,       \* Kin is running
  outages,
  st,       \* kin_questions.state: "none", "open", "answered", "default_taken", "withdrawn"
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
  memo      \* what a broken sweep remembers in memory only

vars == <<clock, up, outages, st, asker, safe, leaves, askedAt, due, raised, raises, card, turns,
          done, outside, memo>>

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

Open == {q \in Qs : st[q] = "open"}
Unchanged(vs) == UNCHANGED vs

(* kin_ask through planAsk and recordAsk: an agent asks about the same record with the same
   intent. Refused while one is open (`repeats`); a second slot is used only after the first.
   `marks` is what the agent says (a default, or "none"); safeDefault adds the words check. *)
Ask(q, a, says, isOut) ==
  /\ up
  /\ st[q] = "none"
  /\ q = 2 => st[1] # "none"
  /\ clock + Delay + RaiseGap <= Horizon
  /\ Broken = "no-repeat-check" \/ Open = {}
  /\ st' = [st EXCEPT ![q] = "open"]
  /\ asker' = [asker EXCEPT ![q] = a]
  /\ leaves' = [leaves EXCEPT ![q] = isOut]
  /\ safe' = [safe EXCEPT ![q] = IF Broken = "no-words-check" THEN says ELSE says /\ ~isOut]
  /\ askedAt' = [askedAt EXCEPT ![q] = clock]
  /\ due' = [due EXCEPT ![q] = clock + Delay]
  /\ card' = [card EXCEPT ![q] = TRUE]
  /\ memo' = IF Broken = "timer-in-memory" THEN memo \cup {q} ELSE memo
  /\ UNCHANGED <<clock, up, outages, raised, raises, turns, done, outside>>

(* The person's tap, on the question's card or its raise card (cardAnswers.ts answerCard, in
   the tap's transaction). A closed card takes no tap (KinChatService.actOn). *)
Tap(q) ==
  /\ up
  /\ card[q]
  /\ Broken = "answer-after-take" \/ st[q] = "open"
  /\ st' = [st EXCEPT ![q] = "answered"]
  /\ card' = [card EXCEPT ![q] = FALSE]
  /\ UNCHANGED <<clock, up, outages, asker, safe, leaves, askedAt, due, raised, raises, turns,
                 done, outside, memo>>

(* kin_ask_close: answered in words (any agent in a chat with them), or withdrawn by its asker. *)
Close(q, outcome) ==
  /\ up
  /\ st[q] = "open"
  /\ st' = [st EXCEPT ![q] = outcome]
  /\ card' = [card EXCEPT ![q] = FALSE]
  /\ UNCHANGED <<clock, up, outages, asker, safe, leaves, askedAt, due, raised, raises, turns,
                 done, outside, memo>>

(* A plain choice card stops taking taps a day after it was posted; an open question's does not
   (choiceCard.ts choiceExpired, untilAnswered). *)
Expire(q) ==
  /\ Broken = "day-expiry"
  /\ card[q] /\ st[q] = "open" /\ clock >= askedAt[q] + DayLong
  /\ card' = [card EXCEPT ![q] = FALSE]
  /\ UNCHANGED <<clock, up, outages, st, asker, safe, leaves, askedAt, due, raised, raises,
                 turns, done, outside, memo>>

Tick ==
  /\ clock < Horizon
  /\ clock' = clock + 1
  /\ UNCHANGED <<up, outages, st, asker, safe, leaves, askedAt, due, raised, raises, card, turns,
                 done, outside, memo>>

Stop ==
  /\ up /\ outages < MaxOutages
  /\ up' = FALSE /\ outages' = outages + 1
  /\ memo' = {}
  /\ UNCHANGED <<clock, st, asker, safe, leaves, askedAt, due, raised, raises, card, turns, done,
                 outside>>

Start ==
  /\ ~up /\ up' = TRUE
  /\ UNCHANGED <<clock, outages, st, asker, safe, leaves, askedAt, due, raised, raises, card,
                 turns, done, outside, memo>>

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

(* raise: no safe default, the next working morning after its day: one fresh card, once. *)
Raise(q) ==
  /\ up
  /\ st[q] = "open" /\ ~safe[q]
  /\ Broken = "raise-repeats" \/ ~raised[q]
  /\ clock >= due[q] + RaiseGap
  /\ Broken # "timer-in-memory" \/ q \in memo
  /\ raises[q] < 2
  /\ raised' = [raised EXCEPT ![q] = TRUE]
  /\ raises' = [raises EXCEPT ![q] = raises[q] + 1]
  /\ card' = [card EXCEPT ![q] = TRUE]
  /\ UNCHANGED <<clock, up, outages, st, asker, safe, leaves, askedAt, due, turns, done, outside,
                 memo>>

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

Next ==
  \/ \E q \in Qs, a \in Agents, says \in BOOLEAN, isOut \in BOOLEAN : Ask(q, a, says, isOut)
  \/ \E q \in Qs : Tap(q) \/ Expire(q) \/ TakeDefault(q) \/ Raise(q) \/ RunTurn(q)
  \/ \E q \in Qs, outcome \in {"answered", "withdrawn"} : Close(q, outcome)
  \/ Tick \/ Stop \/ Start

Fairness ==
  /\ WF_vars(Tick) /\ WF_vars(Start)
  /\ \A q \in Qs : WF_vars(TakeDefault(q)) /\ WF_vars(Raise(q)) /\ WF_vars(RunTurn(q))

Spec == Init /\ [][Next]_vars /\ Fairness

\* Rules, in the owner's words in view.ts.
OnceWhileOpen == Cardinality(Open) <= 1
NeverBeforeItsDay == \A q \in Qs : turns[q] > 0 => (st[q] = "default_taken" /\ clock >= due[q])
TakenOnce == \A q \in Qs : turns[q] <= 1 /\ done[q] <= 1
AnsweredOrTaken == \A q \in Qs : st[q] = "answered" => turns[q] = 0
NothingLeaves == outside = 0
TapsWhileOpen == \A q \in Qs : st[q] = "open" => card[q]
RaisedOnce == \A q \in Qs : raises[q] <= 1
\* Every question ends: answered, its default taken and done, or withdrawn; one with no safe
\* default ends or rests, raised once, in Waiting on you.
Settles(q) ==
  \/ st[q] \in {"answered", "withdrawn"}
  \/ (st[q] = "default_taken" /\ done[q] = turns[q])
  \/ (st[q] = "open" /\ ~safe[q] /\ raised[q])
AlwaysEnds == \A q \in Qs : (st[q] = "open") ~> Settles(q)
=============================================================================
