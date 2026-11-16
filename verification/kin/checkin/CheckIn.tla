---------------------------- MODULE CheckIn ----------------------------
(* The owner's loose morning check-in over two days, and one pulse fact about a member's task.
   Time is in five-minute ticks, twelve to a day; the slot's window opens at tick 5 (the slot time
   minus five minutes) and closes at tick 10 (plus twenty). Each action names the code it stands
   for (apps/server/src/scheduledTasks for T3's scheduler, apps/server/src/kin otherwise). *)
EXTENDS Integers

CONSTANTS Broken, Days, MaxJumps

Day == 12
Grace == 2         \* Schedule.ts MISSED_FIXED_TIME_GRACE_MS: ten minutes
Width == 5         \* checkIn.ts looseOffsetMs: 0..25 minutes into the window
SeedSlot == 5      \* the seeded check-in's window start (kinSchedules.ts windowStart)
MovedSlot == 7     \* where the owner moves it
Horizon == Days * Day

VARIABLES
  clock,     \* the host's wall clock, in ticks
  up,        \* Kin is running
  slot,      \* the check-in's window start in the day (kin_schedules + native timeOfDay)
  moved,     \* the owner moved it (kin_schedules.source_event no longer the seed's)
  nextRun,   \* scheduled_tasks.next_run_at
  queued,    \* per day: the check-in event's notBefore, or 0 (kin_events, dedupe checkin:<day>)
  offset,    \* per day: looseOffsetMs, fixed per schedule and day
  woke,      \* per day: times the agent woke for that day's check-in
  wokeAt,    \* per day: when it first woke
  dueAt,     \* per day: when the slot's window opened (next_run_at when it ran)
  ran,       \* per day: the slot's run reached the check-in (queued or "nothing new")
  upInWindow,\* per day: Kin was up at some tick of that day's window
  fact,      \* the pulse fact: "none", "open", "held", "cleared"
  heldBy,    \* who holds it: "", "owner", "member"
  told,      \* per day: the check-in that day carried the fact (new, still or in hand)
  skipped,   \* per day: the slot ran with the fact open but queued nothing ("nothing new")
  taskShown, \* the member, who holds the task, still sees it
  jumps, outages

vars == <<clock, up, slot, moved, nextRun, queued, offset, woke, wokeAt, dueAt, ran, upInWindow, fact, heldBy,
          told, skipped, taskShown, jumps, outages>>

DayOf(c) == c \div Day
Opens(d) == d * Day + slot
Closes(d) == d * Day + slot + Width
DayRange == 0 .. Days - 1
\* Schedule.ts nextScheduledRunAt: the next slot strictly after `from`.
NextAfter(s, from) == IF from % Day < s THEN DayOf(from) * Day + s ELSE (DayOf(from) + 1) * Day + s

Init ==
  /\ clock = 0 /\ up = TRUE /\ slot = SeedSlot /\ moved = FALSE
  /\ nextRun = SeedSlot
  /\ queued = [d \in DayRange |-> 0]
  /\ offset \in [DayRange -> 0 .. Width]
  /\ woke = [d \in DayRange |-> 0] /\ wokeAt = [d \in DayRange |-> 0]
  /\ dueAt = [d \in DayRange |-> 0] /\ ran = [d \in DayRange |-> FALSE]
  /\ upInWindow = [d \in DayRange |-> FALSE]
  /\ fact = "open" /\ heldBy = ""
  /\ told = [d \in DayRange |-> FALSE] /\ skipped = [d \in DayRange |-> FALSE]
  /\ taskShown = TRUE /\ jumps = 0 /\ outages = 0

InWindow(c) == DayOf(c) \in DayRange /\ c >= Opens(DayOf(c)) /\ c <= Closes(DayOf(c))
Seen(c) == [d \in DayRange |-> upInWindow[d] \/ (up /\ InWindow(c) /\ DayOf(c) = d)]

\* Kin's scheduler and queue look every few seconds: while Kin is up nothing due waits a tick.
Due == up /\ ((nextRun <= clock /\ DayOf(clock) \in DayRange)
               \/ \E d \in DayRange : queued[d] # 0 /\ clock >= queued[d] - 1)

Tick ==
  /\ clock < Horizon /\ ~Due
  /\ clock' = clock + 1
  /\ upInWindow' = [d \in DayRange |-> upInWindow[d] \/ (up /\ InWindow(clock + 1) /\ DayOf(clock + 1) = d)]
  /\ UNCHANGED <<up, slot, moved, nextRun, queued, offset, woke, wokeAt, dueAt, ran, fact, heldBy, told, skipped,
                 taskShown, jumps, outages>>

(* The host's clock is set forward or back fifteen minutes. *)
ClockJumps ==
  /\ jumps < MaxJumps /\ ~Due
  /\ \E delta \in {-3, 3} : clock + delta >= 0 /\ clock + delta <= Horizon
       /\ clock' = clock + delta
  /\ jumps' = jumps + 1
  /\ UNCHANGED <<up, slot, moved, nextRun, queued, offset, woke, wokeAt, dueAt, ran, upInWindow, fact, heldBy,
                 told, skipped, taskShown, outages>>

(* The host sleeps or Kin stops, then starts again; next_run_at is stored, never recomputed. *)
GoesDown == up /\ outages < 1 /\ ~Due /\ up' = FALSE /\ outages' = outages + 1
  /\ UNCHANGED <<clock, slot, moved, nextRun, queued, offset, woke, wokeAt, dueAt, ran, upInWindow, fact,
                 heldBy, told, skipped, taskShown, jumps>>
ComesUp == ~up /\ up' = TRUE
  /\ upInWindow' = Seen(clock)
  /\ UNCHANGED <<clock, slot, moved, nextRun, queued, offset, woke, wokeAt, dueAt, ran, fact, heldBy, told,
                 skipped, taskShown, jumps, outages>>

(* ScheduledTaskService.runDueTasks: a run more than ten minutes late is rescheduled unseen;
   otherwise KinTriggerSink → scheduledTasks.ts runNative → checkIn.ts queueCheckIn with
   dueAt = the run's start. KinPulse.read without held facts gates it ("nothing_new"); the
   dedupe key is the day of dueAt (KinEventQueue.enqueue ON CONFLICT DO NOTHING). *)
SlotRuns ==
  /\ up /\ nextRun <= clock + (IF Broken = "fire-early" THEN 1 ELSE 0) /\ DayOf(clock) \in DayRange
  /\ nextRun' = NextAfter(slot, clock)
  /\ LET d == DayOf(clock) IN
       IF clock - nextRun > Grace
         THEN UNCHANGED <<queued, told, skipped, dueAt, ran>>
         ELSE /\ ran' = [ran EXCEPT ![d] = TRUE]
              /\ IF fact # "open"
                   THEN /\ skipped' = [skipped EXCEPT ![d] = skipped[d] \/ (fact = "held" /\ queued[d] = 0)]
                        /\ UNCHANGED <<queued, told, dueAt>>
                   ELSE /\ IF queued[d] # 0 /\ Broken # "no-dedupe" THEN UNCHANGED <<queued, dueAt>>
                           ELSE /\ queued' = [queued EXCEPT ![d] =
                                     clock + offset[d] + 1]
                                /\ dueAt' = [dueAt EXCEPT ![d] = nextRun]
                                \* ("fire-early": the slot runs five minutes before it is due)
                        /\ told' = [told EXCEPT ![d] = TRUE]
                        /\ UNCHANGED skipped
  /\ UNCHANGED <<clock, up, slot, moved, offset, woke, wokeAt, upInWindow, fact, heldBy, taskShown,
                 jumps, outages>>

(* KinEventQueue readiness: the event wakes the agent from notBefore on (stored +1 so 0 = none). *)
AgentWakes(d) ==
  /\ up /\ queued[d] # 0 /\ clock >= queued[d] - 1
  /\ woke' = [woke EXCEPT ![d] = woke[d] + 1]
  /\ wokeAt' = IF woke[d] = 0 THEN [wokeAt EXCEPT ![d] = clock] ELSE wokeAt
  /\ queued' = IF Broken = "no-dedupe" THEN [queued EXCEPT ![d] = 0] ELSE [queued EXCEPT ![d] = Horizon + 99]
  /\ UNCHANGED <<clock, up, slot, moved, nextRun, offset, dueAt, ran, upInWindow, fact, heldBy, told, skipped,
                 taskShown, jumps, outages>>

(* pulse/checkIns.ts save: the owner moves it ten minutes later; native next_run_at recomputed. *)
OwnerMoves ==
  /\ ~moved /\ moved' = TRUE /\ slot' = MovedSlot
  /\ nextRun' = NextAfter(MovedSlot, clock)
  /\ UNCHANGED <<clock, up, queued, offset, woke, wokeAt, dueAt, ran, upInWindow, fact, heldBy, told, skipped,
                 taskShown, jumps, outages>>

(* pulse/checkInSeeds.ts followOwnerZone: re-keys seed rows only (kin-seed source event). *)
SeedFollows ==
  /\ slot # SeedSlot /\ (~moved \/ Broken = "follow-moved")
  /\ slot' = SeedSlot /\ nextRun' = NextAfter(SeedSlot, clock)
  /\ UNCHANGED <<clock, up, moved, queued, offset, woke, wokeAt, dueAt, ran, upInWindow, fact, heldBy, told,
                 skipped, taskShown, jumps, outages>>

(* KinPulse tick senses the member's overdue task; pulse_handle got_it / not_a_problem / undo. *)
FactAppears == fact = "none" /\ fact' = "open"
  /\ UNCHANGED <<clock, up, slot, moved, nextRun, queued, offset, woke, wokeAt, dueAt, ran, upInWindow, heldBy,
                 told, skipped, taskShown, jumps, outages>>
FactHeld(p) == fact = "open" /\ fact' = "held" /\ heldBy' = p
  /\ taskShown' = (taskShown /\ Broken # "handle-hides-task")
  /\ UNCHANGED <<clock, up, slot, moved, nextRun, queued, offset, woke, wokeAt, dueAt, ran, upInWindow, told,
                 skipped, jumps, outages>>
FactClears == fact \in {"open", "held"} /\ fact' = "cleared"
  /\ UNCHANGED <<clock, up, slot, moved, nextRun, queued, offset, woke, wokeAt, dueAt, ran, upInWindow, heldBy,
                 told, skipped, taskShown, jumps, outages>>

Next ==
  \/ Tick \/ ClockJumps \/ GoesDown \/ ComesUp \/ SlotRuns \/ OwnerMoves \/ SeedFollows
  \/ \E d \in DayRange : AgentWakes(d)
  \/ FactAppears \/ FactClears \/ \E p \in {"owner", "member"} : FactHeld(p)

Spec == Init /\ [][Next]_vars

------------------------------------------------------------------------------------------------
OncePerDay == \A d \in DayRange : woke[d] <= 1
NeverBeforeWindow == \A d \in DayRange : woke[d] > 0 => wokeAt[d] >= dueAt[d]
\* The minute Kin picks (notBefore, stored +1) is inside the window; waking later because Kin
\* was down then is not this rule's business.
InsideWindow == \A d \in DayRange :
  (queued[d] # 0 /\ queued[d] <= Horizon + 1) => queued[d] - 1 <= dueAt[d] + Width
StaysMoved == moved => slot = MovedSlot
FiresWhenUp == \A d \in DayRange : (clock > Closes(d) /\ upInWindow[d]) => ran[d]
FactNeverAbsent == \A d \in DayRange : ~skipped[d]
HandleKeepsTask == taskShown
=============================================================================
