---------------------------- MODULE GitHubEvents ----------------------------
(* Kin watching one GitHub thread with the owner's login: things happen on it (a teammate's PR, a
   teammate's /kin, a stranger's /kin, the agent's own signed reply), Kin looks, decides, wakes an
   agent once, reacts once, and the agent's reply lands back on the thread. The server can stop at
   any point. Each action names the code it stands for (paths under apps/server/src/kin). One
   action is one transaction. *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Broken,
  MaxThings,        \* things on the thread, the agent's replies included
  MaxStops          \* the server stopping anywhere

PerLook == 1        \* GitHubWatch.ts WAKES_PER_LOOK, scaled down
PerThread == 2      \* GitHubWatch.ts PER_THREAD_HOURLY, scaled down
Kinds == {"pr", "call", "stranger"}

VARIABLES
  thread,     \* what is on the thread, oldest first: pr, call, stranger, own
  cursor,     \* kin_github_watch.since_at: everything up to here was weighed
  handled,    \* kin_github_handled: the trigger keys stored, whatever the outcome
  capped,     \* those stored as "capped": stopped for the hour, with the note
  wakes,      \* per thing, the agent wake-ups (kin_events) it caused
  pending,    \* wake-ups queued and not yet run
  reactions,  \* per thing, the 👀 Kin put on it
  phase,      \* idle, looking (between StartLook and EndLook)
  upTo,       \* the newest thing this look read
  at,         \* the next thing this look weighs
  woken,      \* wake-ups this look
  later,      \* this look left a trigger for the next one
  react,      \* the thing just woken, owed its 👀 (0 when none)
  hourWakes,  \* wake-ups on the thread this hour
  notes,      \* "stopped for the hour" comments this hour (one hour: its end resets both)
  stops

vars == <<thread, cursor, handled, capped, wakes, pending, reactions, phase, upTo, at, woken, later, react,
          hourWakes, notes, stops>>

Things == 1..MaxThings

(* githubTriggers.ts decideTriggers: a teammate's PR (review) or /kin (call) is a trigger; a
   stranger's /kin is not (isInside), and text with the agent's marker never is (isAgentText). *)
Inside(k) == k \in {"pr", "call"}
Trigger(k) ==
  \/ Inside(k)
  \/ Broken = "no-marker" /\ k = "own"
  \/ Broken = "stranger-calls" /\ k = "stranger"

Init ==
  /\ thread = <<>> /\ cursor = 0 /\ handled = {} /\ capped = {} /\ wakes = [i \in Things |-> 0]
  /\ pending = {} /\ reactions = [i \in Things |-> 0]
  /\ phase = "idle" /\ upTo = 0 /\ at = 1 /\ woken = 0 /\ later = FALSE /\ react = 0
  /\ hourWakes = 0 /\ notes = 0 /\ stops = 0

(* People act on GitHub, whether Kin is running or not. *)
Happen(k) ==
  /\ Len(thread) < MaxThings
  /\ thread' = Append(thread, k)
  /\ UNCHANGED <<capped, cursor, handled, wakes, pending, reactions, phase, upTo, at, woken, later, react,
                 hourWakes, notes, stops>>

(* github/GitHubWatch.ts poll: notifications since the cursor (If-Modified-Since) and the owner's
   own events (If-None-Match) say what changed; the look reads the thread as it is now. *)
StartLook ==
  /\ phase = "idle" /\ react = 0
  /\ phase' = "looking" /\ upTo' = Len(thread) /\ at' = cursor + 1 /\ woken' = 0 /\ later' = FALSE
  \* Moving the cursor before weighing: a stop mid-look loses what was left.
  /\ cursor' = IF Broken = "cursor-first" THEN Len(thread) ELSE cursor
  /\ UNCHANGED <<capped, thread, handled, wakes, pending, reactions, react, hourWakes, notes, stops>>

(* GitHubWatch.ts handle: in one transaction, skip a stored key; over the look's cap leave it for
   the next look (nothing stored); over the thread's hour stop it ("capped", one note); else store
   it and queue the wake-up whose dedupe key is the trigger's. *)
Weigh ==
  /\ phase = "looking" /\ at <= upTo /\ react = 0
  /\ LET k == thread[at] IN
     IF ~Trigger(k) \/ (at \in handled /\ Broken \notin {"react-each-look", "wake-each-look"})
     THEN /\ at' = at + 1
          /\ UNCHANGED <<handled, wakes, pending, woken, later, react, hourWakes, notes, capped>>
     ELSE IF at \in handled /\ Broken = "react-each-look"
     \* The broken variant reacts again to what an earlier look already handled.
     THEN /\ at' = at + 1 /\ react' = at
          /\ UNCHANGED <<handled, wakes, pending, woken, later, hourWakes, notes, capped>>
     ELSE IF woken >= PerLook
     THEN IF Broken = "skip-over-cap"
          THEN /\ handled' = handled \cup {at} /\ at' = at + 1
               /\ UNCHANGED <<wakes, pending, woken, later, react, hourWakes, notes, capped>>
          ELSE /\ later' = TRUE /\ at' = at + 1
               /\ UNCHANGED <<handled, wakes, pending, woken, react, hourWakes, notes, capped>>
     ELSE IF hourWakes >= PerThread
     THEN /\ handled' = handled \cup {at} /\ capped' = capped \cup {at} /\ at' = at + 1
          /\ notes' = IF notes = 0 \/ Broken = "note-each" THEN notes + 1 ELSE notes
          /\ UNCHANGED <<wakes, pending, woken, later, react, hourWakes>>
     ELSE /\ handled' = handled \cup {at}
          /\ wakes' = [wakes EXCEPT ![at] = @ + 1]
          /\ pending' = pending \cup {at}
          /\ woken' = woken + 1 /\ hourWakes' = hourWakes + 1
          /\ at' = at + 1 /\ react' = at
          /\ UNCHANGED <<later, notes, capped>>
  /\ UNCHANGED <<thread, cursor, reactions, phase, upTo, stops>>

(* GitHubWatch.ts react: the 👀, after the commit; a stop before it leaves none. *)
React ==
  /\ react # 0
  /\ reactions' = [reactions EXCEPT ![react] = @ + 1]
  /\ react' = 0
  /\ UNCHANGED <<capped, thread, cursor, handled, wakes, pending, phase, upTo, at, woken, later, hourWakes,
                 notes, stops>>

(* The end of a look: the cursor moves only when nothing was left for the next look. *)
EndLook ==
  /\ phase = "looking" /\ at > upTo /\ react = 0
  /\ cursor' = IF later THEN cursor ELSE upTo
  /\ phase' = "idle"
  /\ UNCHANGED <<capped, thread, handled, wakes, pending, reactions, upTo, at, woken, later, react,
                 hourWakes, notes, stops>>

(* The agent's turn (lead/WakeupRunner.ts): it answers on GitHub, signed (github/ghSign.ts), so its
   reply is on the thread with the marker. *)
Turn(i) ==
  /\ i \in pending
  /\ pending' = pending \ {i}
  /\ thread' = IF Len(thread) < MaxThings THEN Append(thread, "own") ELSE thread
  /\ UNCHANGED <<capped, cursor, handled, wakes, reactions, phase, upTo, at, woken, later, react, hourWakes,
                 notes, stops>>

(* The server stops anywhere and starts again: what was stored stays, the look in hand is gone. *)
Stop ==
  /\ stops < MaxStops
  /\ stops' = stops + 1
  /\ phase' = "idle" /\ react' = 0 /\ upTo' = 0 /\ at' = 1 /\ woken' = 0 /\ later' = FALSE
  /\ UNCHANGED <<capped, thread, cursor, handled, wakes, pending, reactions, hourWakes, notes>>

Next ==
  \/ \E k \in Kinds : Happen(k)
  \/ StartLook \/ Weigh \/ React \/ EndLook \/ Stop
  \/ \E i \in Things : Turn(i)

Spec == Init /\ [][Next]_vars

------------------------------------------------------------------------------------------------
OnceEach == \A i \in Things : wakes[i] <= 1
NoneLost ==
  (phase = "idle" /\ cursor = Len(thread)) =>
    \A i \in 1..Len(thread) : Inside(thread[i]) => wakes[i] > 0 \/ i \in capped
OutsideStartsNothing == \A i \in 1..Len(thread) : wakes[i] > 0 => Inside(thread[i])
OneReaction == \A i \in Things : reactions[i] <= 1
OneNotePerHour == notes <= 1
=============================================================================
