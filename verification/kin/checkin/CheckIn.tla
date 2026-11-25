---------------------------- MODULE CheckIn ----------------------------
(* The owner's loose morning check-in over two days, one pulse fact about a member's task, and
   one unprompted post to the owner or to a member at a time it must wait: the owner's quiet
   hours (the first four ticks of his day), or the member's quiet hours or time outside her
   working hours, on her own clock, half a day ahead of his. Or the post is a line someone left
   with the agent for the owner's next check-in instead of sending it (a relay with checkIn).
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
CatchUpGrace == 36 \* checkInCatchUp.ts CATCH_UP_MS: three hours, so the rest of the model's day
Horizon == Days * Day
QuietTicks == 4    \* quietHold.ts: 22:00 to 08:00, the first ticks of each modelled day
Shift == 6         \* the member's clock runs half a day ahead of the owner's
WorkStart == 6     \* her working hours, ticks 6 to 9 of her day; she holds messages outside them
WorkEnd == 10      \* (hold_outside_hours, on by default); the owner's switch is off

VARIABLES
  clock,     \* the host's wall clock, in ticks
  up,        \* Kin is running
  slot,      \* the check-in's window start in the day (kin_schedules + native timeOfDay)
  moved,     \* the owner moved it (kin_schedules.source_event no longer the seed's)
  nextRun,   \* scheduled_tasks.next_run_at
  queued,    \* per day: the check-in event's notBefore, or 0 (kin_events, dedupe checkin:<day>)
  queuedAt,  \* per day: when it was queued
  offset,    \* per day: looseOffsetMs, fixed per schedule and day
  woke,      \* per day: times the agent woke for that day's check-in
  wokeAt,    \* per day: when it first woke
  dueAt,     \* per day: when the slot's window opened (next_run_at when it ran)
  ran,       \* per day: the slot's run reached the check-in (queued or "nothing new")
  upInWindow,\* per day: Kin was up at some tick of that day's window
  fact,      \* the pulse fact: "none", "open", "held", "cleared"
  heldBy,    \* who holds it: "", "owner", "member"
  told,      \* per day: the offered signature and whether the turn omitted it
  toldAs,    \* kin_pulse_told: the fact's state when last told ("" never), its told-once key
  tells,     \* times the fact was told since it last changed
  skipped,   \* per day: the slot ran with the fact open but queued nothing ("nothing new")
  taskShown, \* the member, who holds the task, still sees it
  posted,    \* the unprompted post was made
  to,        \* whom it was for: "owner" or "member" ("" before it is made)
  held,      \* kin_held_posts: it waits, stored, until they are free
  deliverAt, \* when they are
  delivered, \* times it reached the chat
  inQuiet,   \* it reached the chat inside their quiet hours
  offHours,  \* it reached the member outside her working hours
  left,      \* the post was left for the owner's next check-in (leftForCheckIn.ts)
  taken,     \* d + 1 when day d's check-in took it to tell (kin_pulse_told left:<hold>), else 0
  jumps, outages

told2 == <<toldAs, tells>>
quiet == <<posted, to, held, deliverAt, delivered, inQuiet, offHours>>
leftVars == <<left, taken>>
vars == <<clock, up, slot, moved, nextRun, queued, queuedAt, offset, woke, wokeAt, dueAt, ran, upInWindow,
          fact, heldBy, told, skipped, taskShown, jumps, outages, told2, quiet, leftVars>>

DayOf(c) == c \div Day
Opens(d) == d * Day + slot
Closes(d) == d * Day + slot + Width
DayRange == 0 .. Days - 1
\* Schedule.ts nextScheduledRunAt: the next slot strictly after `from`.
NextAfter(s, from) == IF from % Day < s THEN DayOf(from) * Day + s ELSE (DayOf(from) + 1) * Day + s

Init ==
  /\ clock = 0 /\ up = TRUE /\ slot = SeedSlot /\ moved = FALSE
  /\ nextRun = SeedSlot
  /\ queued = [d \in DayRange |-> 0] /\ queuedAt = [d \in DayRange |-> 0]
  /\ offset \in [DayRange -> 0 .. Width]
  /\ woke = [d \in DayRange |-> 0] /\ wokeAt = [d \in DayRange |-> 0]
  /\ dueAt = [d \in DayRange |-> 0] /\ ran = [d \in DayRange |-> FALSE]
  /\ upInWindow = [d \in DayRange |-> FALSE]
  /\ fact = "open" /\ heldBy = ""
  /\ told = [d \in DayRange |-> <<"", FALSE>>] /\ skipped = [d \in DayRange |-> FALSE]
  /\ taskShown = TRUE /\ jumps = 0 /\ outages = 0
  /\ toldAs = "" /\ tells = 0
  /\ posted = FALSE /\ to = "" /\ held = FALSE /\ deliverAt = 0 /\ delivered = 0
  /\ inQuiet = FALSE /\ offHours = FALSE
  /\ left = FALSE /\ taken = 0

InWindow(c) == DayOf(c) \in DayRange /\ c >= Opens(DayOf(c)) /\ c <= Closes(DayOf(c))
Seen(c) == [d \in DayRange |-> upInWindow[d] \/ (up /\ InWindow(c) /\ DayOf(c) = d)]

\* What must hold, on each person's own clock: quiet hours for both, and for the member, whose
\* switch is on, any time outside her working hours.
Local(p, c) == IF p = "member" THEN (c + Shift) % Day ELSE c % Day
QuietFor(p, c) == Local(p, c) < QuietTicks
OffFor(p, c) == p = "member" /\ ~(Local(p, c) >= WorkStart /\ Local(p, c) < WorkEnd)
(* quietHold.ts personRule + quietHours.ts heldAt: the code's rule. "company-clock": read on the
   owner's clock; "quiet-only": working hours ignored (the code before this change). *)
CodeLocal(p, c) == IF Broken = "company-clock" THEN c % Day ELSE Local(p, c)
CodeHolds(p, c) == CodeLocal(p, c) < QuietTicks
  \/ (p = "member" /\ Broken # "quiet-only"
      /\ ~(CodeLocal(p, c) >= WorkStart /\ CodeLocal(p, c) < WorkEnd))
\* quietHours.ts freeAt: the first tick from c on when the code lets it go.
FreeAt(p, c) == CHOOSE t \in c .. c + Day :
  ~CodeHolds(p, t) /\ \A u \in c .. t - 1 : CodeHolds(p, u)

\* leftForCheckIn.ts leftOpen: a left line no check-in has taken; it alone brings a check-in.
LeftOpen == left /\ held /\ taken = 0
\* heldDelivery.ts reservedByCheckIn: deliverHeld leaves a taken line to its check-in.
Untaken == taken = 0 \/ Broken = "deliver-taken"

(* checkInCatchUp.ts missedSlot: T3's scheduler has moved past today's slot (next_run_at after
   now) and it has not run since its window opened, on the same day, within the grace. *)
Missed == /\ DayOf(clock) \in DayRange
          /\ clock >= Opens(DayOf(clock)) /\ clock - Opens(DayOf(clock)) < CatchUpGrace
          /\ nextRun > clock /\ ~ran[DayOf(clock)]
          /\ Broken # "no-catch-up"

\* Kin's scheduler, queue and tick look every few seconds: while Kin is up nothing due waits a tick.
Due == up /\ ((nextRun <= clock /\ DayOf(clock) \in DayRange) \/ Missed
               \/ (held /\ clock >= deliverAt /\ ~CodeHolds(to, clock) /\ Untaken)
               \/ \E d \in DayRange : queued[d] # 0 /\ clock >= queued[d] - 1)

Tick ==
  /\ clock < Horizon /\ ~Due
  /\ clock' = clock + 1
  /\ upInWindow' = [d \in DayRange |-> upInWindow[d] \/ (up /\ InWindow(clock + 1) /\ DayOf(clock + 1) = d)]
  /\ UNCHANGED <<up, slot, moved, nextRun, queued, queuedAt, offset, woke, wokeAt, dueAt, ran, fact, heldBy, told, skipped,
                 taskShown, jumps, outages, told2, quiet, leftVars>>

(* The host's clock is set forward or back fifteen minutes. *)
ClockJumps ==
  /\ jumps < MaxJumps /\ ~Due
  /\ \E delta \in {-3, 3} : clock + delta >= 0 /\ clock + delta <= Horizon
       /\ clock' = clock + delta
  /\ jumps' = jumps + 1
  /\ UNCHANGED <<up, slot, moved, nextRun, queued, queuedAt, offset, woke, wokeAt, dueAt, ran, upInWindow, fact, heldBy,
                 told, skipped, taskShown, outages, told2, quiet, leftVars>>

(* The host sleeps or Kin stops, then starts again; next_run_at is stored, never recomputed. *)
GoesDown == up /\ outages < 1 /\ ~Due /\ up' = FALSE /\ outages' = outages + 1
  \* A held post is a stored row: a restart keeps it ("held-in-memory": it was only in memory).
  /\ held' = (held /\ Broken # "held-in-memory")
  /\ UNCHANGED <<clock, slot, moved, nextRun, queued, queuedAt, offset, woke, wokeAt, dueAt, ran, upInWindow, fact,
                 heldBy, told, skipped, taskShown, jumps, told2, posted, to, deliverAt, delivered, inQuiet,
                 offHours, leftVars>>
ComesUp == ~up /\ up' = TRUE
  /\ upInWindow' = Seen(clock)
  /\ UNCHANGED <<clock, slot, moved, nextRun, queued, queuedAt, offset, woke, wokeAt, dueAt, ran, fact, heldBy, told,
                 skipped, taskShown, jumps, outages, told2, quiet, leftVars>>

(* runNative → checkIn.ts queueCheckIn for day d, from a run that started at `clock`. told.ts
   untold gates it: a fact open or in hand is offered unless reserved or already told as it stands now
   (kin_pulse_told); with nothing untold no event is queued and no model runs. The minute is the
   window's start plus the day's offset, or at once when that has passed; the dedupe key is the
   day (KinEventQueue.enqueue ON CONFLICT DO NOTHING). *)
Tellable == fact = "open" \/ (fact = "held" /\ Broken # "held-left-out")
Reserved == \E d \in DayRange : queued[d] # 0 /\ queued[d] <= Horizon + 1 /\ told[d][1] = fact
Queue(d, due, offered) ==
  /\ queued' = [queued EXCEPT ![d] =
       (IF Broken \in {"late-offset", "fire-early"} THEN clock + offset[d]
        ELSE IF Opens(d) + offset[d] >= clock THEN Opens(d) + offset[d] ELSE clock) + 1]
  /\ queuedAt' = [queuedAt EXCEPT ![d] = clock]
  /\ dueAt' = [dueAt EXCEPT ![d] = due]
  /\ told' = [told EXCEPT ![d] = <<offered, FALSE>>]
  /\ taken' = IF LeftOpen THEN d + 1 ELSE taken
Fire(d, due) ==
  /\ ran' = [ran EXCEPT ![d] = TRUE]
  /\ IF Tellable /\ ((fact # toldAs /\ ~Reserved) \/ Broken = "tell-again")
       THEN /\ IF queued[d] # 0 /\ Broken # "no-dedupe" THEN UNCHANGED <<queued, queuedAt, dueAt, told, taken>>
               ELSE Queue(d, due, fact)
            /\ UNCHANGED skipped
       ELSE /\ skipped' = [skipped EXCEPT ![d] =
                skipped[d] \/ (fact \in {"open", "held"} /\ fact # toldAs /\ ~Reserved /\ queued[d] = 0)]
            \* Only a left line to tell: the check-in comes for it, offering no fact ("").
            /\ IF LeftOpen /\ queued[d] = 0 THEN Queue(d, due, "")
               ELSE UNCHANGED <<queued, queuedAt, told, dueAt, taken>>

(* ScheduledTaskService.runDueTasks: a run more than ten minutes late is rescheduled unseen;
   otherwise KinTriggerSink → scheduledTasks.ts runNative with dueAt = the run's start.
   ("fire-early": the slot runs five minutes before it is due, and picks its minute from that
   start: the window clamp alone keeps an early run from waking early.) *)
SlotRuns ==
  /\ up /\ nextRun <= clock + (IF Broken = "fire-early" THEN 1 ELSE 0) /\ DayOf(clock) \in DayRange
  /\ nextRun' = NextAfter(slot, clock)
  /\ IF clock - nextRun > Grace
       THEN UNCHANGED <<queued, queuedAt, told, skipped, dueAt, ran, taken>>
       ELSE Fire(DayOf(clock), nextRun)
  /\ UNCHANGED <<clock, up, slot, moved, offset, woke, wokeAt, upInWindow, fact, heldBy, taskShown,
                 jumps, outages, told2, quiet, left>>

(* scheduledTasks.ts tick (at start-up and every tick) → checkInCatchUp.ts missedCheckIns: the
   fire the slot would have made, `ns:<task>:<window start>:scheduled`, put once and run now. *)
CatchUp ==
  /\ up /\ Missed
  /\ Fire(DayOf(clock), Opens(DayOf(clock)))
  /\ UNCHANGED <<clock, up, slot, moved, nextRun, offset, woke, wokeAt, upInWindow, fact, heldBy,
                 taskShown, jumps, outages, told2, quiet, left>>

(* KinEventQueue readiness: the event wakes the agent from notBefore on (stored +1 so 0 = none). *)
(* The successful turn and its ledger settlement are one step here. settleCheckInTold releases
   an offered fact omitted from the turn's posts. It keeps one named or handled in that turn. *)
(* A left line it took is told when the turn posted (kept) and closed with its delivery mark
   (settleLeft), or, when it posted nothing, freed for the next check-in ("close-unposted": closed
   anyway). *)
AgentWakes(d, kept) ==
  /\ up /\ queued[d] # 0 /\ clock >= queued[d] - 1
  /\ told' = IF kept \/ told[d][1] = "" THEN told ELSE [told EXCEPT ![d] = <<told[d][1], TRUE>>]
  /\ IF (kept \/ Broken = "keep-omission") /\ told[d][1] # ""
       THEN /\ tells' = IF told[d][1] = toldAs THEN tells + 1 ELSE 1
            /\ toldAs' = told[d][1]
       ELSE UNCHANGED told2
  \* leftGiven gives the turn the line it took, whatever deliverHeld did meanwhile.
  /\ IF taken = d + 1
       THEN IF kept \/ Broken = "close-unposted"
              THEN /\ held' = FALSE /\ delivered' = delivered + (IF kept THEN 1 ELSE 0)
                   /\ UNCHANGED taken
              ELSE /\ taken' = 0 /\ UNCHANGED <<held, delivered>>
       ELSE UNCHANGED <<held, delivered, taken>>
  \* The check-in's own quiet hold (agentQuietUntil) is left out here, so its tell is not a post.
  /\ woke' = [woke EXCEPT ![d] = woke[d] + 1]
  /\ wokeAt' = IF woke[d] = 0 THEN [wokeAt EXCEPT ![d] = clock] ELSE wokeAt
  /\ queued' = IF Broken = "no-dedupe" THEN [queued EXCEPT ![d] = 0] ELSE [queued EXCEPT ![d] = Horizon + 99]
  /\ UNCHANGED <<clock, up, slot, moved, nextRun, queuedAt, offset, dueAt, ran, upInWindow, fact, heldBy, skipped,
                 taskShown, jumps, outages, posted, to, deliverAt, inQuiet, offHours, left>>

\* A moved slot's day is measured against its new window: being up in the old one no longer counts.
Remeasured(s) ==
  [d \in DayRange |-> IF d = DayOf(clock)
                      THEN up /\ clock >= d * Day + s /\ clock <= d * Day + s + Width
                      ELSE upInWindow[d]]

(* pulse/checkIns.ts save: the owner moves it ten minutes later; native next_run_at recomputed. *)
OwnerMoves ==
  /\ ~moved /\ moved' = TRUE /\ slot' = MovedSlot
  /\ nextRun' = NextAfter(MovedSlot, clock)
  /\ upInWindow' = Remeasured(MovedSlot)
  /\ UNCHANGED <<clock, up, queued, queuedAt, offset, woke, wokeAt, dueAt, ran, fact, heldBy, told, skipped,
                 taskShown, jumps, outages, told2, quiet, leftVars>>

(* pulse/checkInSeeds.ts followOwnerZone: re-keys seed rows only (kin-seed source event). *)
SeedFollows ==
  /\ slot # SeedSlot /\ (~moved \/ Broken = "follow-moved")
  /\ slot' = SeedSlot /\ nextRun' = NextAfter(SeedSlot, clock)
  /\ upInWindow' = Remeasured(SeedSlot)
  /\ UNCHANGED <<clock, up, moved, queued, queuedAt, offset, woke, wokeAt, dueAt, ran, fact, heldBy, told,
                 skipped, taskShown, jumps, outages, told2, quiet, leftVars>>

(* KinPulse tick senses the member's overdue task; pulse_handle got_it / not_a_problem / undo. *)
FactAppears == fact = "none" /\ fact' = "open"
  /\ UNCHANGED <<clock, up, slot, moved, nextRun, queued, queuedAt, offset, woke, wokeAt, dueAt, ran, upInWindow, heldBy,
                 told, skipped, taskShown, jumps, outages, told2, quiet, leftVars>>
FactHeld(p) == fact = "open" /\ fact' = "held" /\ heldBy' = p
  /\ taskShown' = (taskShown /\ Broken # "handle-hides-task")
  /\ UNCHANGED <<clock, up, slot, moved, nextRun, queued, queuedAt, offset, woke, wokeAt, dueAt, ran, upInWindow, told,
                 skipped, jumps, outages, told2, quiet, leftVars>>
FactClears == fact \in {"open", "held"} /\ fact' = "cleared"
  /\ UNCHANGED <<clock, up, slot, moved, nextRun, queued, queuedAt, offset, woke, wokeAt, dueAt, ran, upInWindow, heldBy,
                 told, skipped, taskShown, jumps, outages, told2, quiet, leftVars>>

(* An unprompted line to a person at a time it must wait (a night job's notice, a fact wake's
   turn, a relay, nudge or notice the agent sends them): quietHold.ts holdIfQuiet or
   holdFor/holdLine stores it with when they are free; "post-in-quiet" posts it. *)
QuietPost(p) ==
  /\ ~posted /\ (QuietFor(p, clock) \/ OffFor(p, clock)) /\ DayOf(clock) \in DayRange
  /\ posted' = TRUE /\ to' = p
  /\ IF Broken = "post-in-quiet" \/ ~CodeHolds(p, clock)
       THEN /\ delivered' = 1 /\ inQuiet' = QuietFor(p, clock) /\ offHours' = OffFor(p, clock)
            /\ UNCHANGED <<held, deliverAt>>
       ELSE /\ held' = TRUE /\ deliverAt' = FreeAt(p, clock)
            /\ UNCHANGED <<delivered, inQuiet, offHours>>
  /\ UNCHANGED <<clock, up, slot, moved, nextRun, queued, queuedAt, offset, woke, wokeAt, dueAt, ran, upInWindow,
                 fact, heldBy, told, skipped, taskShown, jumps, outages, told2, leftVars>>

(* Handoff.ts relay with checkIn on the first day, before the window or after it: the line is
   stored for the owner's next check-in instead of sent (holdLine), and deliverHeld may post it a
   day later if none took it. *)
Leave ==
  /\ ~posted /\ clock \in {QuietTicks, Day - 1}
  /\ posted' = TRUE /\ to' = "owner" /\ left' = TRUE /\ held' = TRUE
  /\ deliverAt' = FreeAt("owner", clock + Day)
  /\ UNCHANGED <<clock, up, slot, moved, nextRun, queued, queuedAt, offset, woke, wokeAt, dueAt, ran, upInWindow,
                 fact, heldBy, told, skipped, taskShown, jumps, outages, told2, delivered, inQuiet, offHours,
                 taken>>

(* heldDelivery.ts deliverHeld on the drain tick: posts what is due and marks it delivered in one
   transaction ("deliver-twice": the mark is lost and the next tick posts it again). A host that
   slept past their free time holds it again ("deliver-late-night": it posts once due). *)
Deliver ==
  /\ delivered < 2 /\ up /\ held /\ clock >= deliverAt /\ Untaken
  /\ (~CodeHolds(to, clock) \/ Broken = "deliver-late-night")
  /\ held' = (Broken = "deliver-twice")
  /\ delivered' = delivered + 1
  /\ inQuiet' = (inQuiet \/ QuietFor(to, clock))
  /\ offHours' = (offHours \/ OffFor(to, clock))
  /\ UNCHANGED <<clock, up, slot, moved, nextRun, queued, queuedAt, offset, woke, wokeAt, dueAt, ran, upInWindow,
                 fact, heldBy, told, skipped, taskShown, jumps, outages, told2, posted, to, deliverAt,
                 leftVars>>

Next ==
  \/ Tick \/ ClockJumps \/ GoesDown \/ ComesUp \/ SlotRuns \/ CatchUp \/ OwnerMoves \/ SeedFollows
  \/ \E d \in DayRange, kept \in BOOLEAN : AgentWakes(d, kept)
  \/ FactAppears \/ FactClears \/ \E p \in {"owner", "member"} : FactHeld(p)
  \/ \E p \in {"owner", "member"} : QuietPost(p)
  \/ Leave
  \/ Deliver

Spec == Init /\ [][Next]_vars

------------------------------------------------------------------------------------------------
OncePerDay == \A d \in DayRange : woke[d] <= 1
NeverBeforeWindow == \A d \in DayRange : woke[d] > 0 => wokeAt[d] >= dueAt[d]
\* The minute Kin picks (notBefore, stored +1) is inside the window, or, when Kin only noticed the
\* slot after the window closed (a catch-up), the moment it noticed: never a further offset. Waking
\* later because Kin was down then is not this rule's business.
InsideWindow == \A d \in DayRange :
  (queued[d] # 0 /\ queued[d] <= Horizon + 1) =>
    queued[d] - 1 <= (IF dueAt[d] + Width >= queuedAt[d] THEN dueAt[d] + Width ELSE queuedAt[d])
StaysMoved == moved => slot = MovedSlot
FiresWhenUp == \A d \in DayRange : (clock > Closes(d) /\ upInWindow[d]) => ran[d]
FactNeverAbsent == \A d \in DayRange : ~skipped[d]
HandleKeepsTask == taskShown
ToldOnce == tells <= 1
OmissionsReleased ==
  (\E d \in DayRange : told[d] = <<toldAs, TRUE>>) =>
    \E d \in DayRange : woke[d] > 0 /\ told[d] = <<toldAs, FALSE>>
HeldDeliveredOnce == delivered <= 1
HeldNeverLost == posted => (held \/ delivered >= 1)
QuietIsQuiet == ~inQuiet
OffHoursWait == ~offHours
=============================================================================
