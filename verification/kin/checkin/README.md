# Loose check-in and a pulse fact (`node scripts/kin-model.ts checkin`)

**Rules.** A day's check-in comes at most once, never before its window, at a minute inside the window, and it happens if Kin runs at any time in the window. A moved check-in stays moved. An open fact, even one in hand, is in that day's check-in. Holding a fact never hides the task.
**Harm guarded.** The owner's morning check-in repeats, comes early, silently doesn't come, or leaves out something open.
**Bound.** Two days in five-minute ticks, one outage, one 15-minute clock change (never in the seconds between a slot falling due and the scheduler running it), one move, one fact. About 2 million states, 35 s. The chart is drawn on one day without clock changes. `--variants`: 4/4 caught.
**Open findings (not fixed).**

1. `FiresWhenUp`: the host sleeps from before the window until 9:10. T3's scheduler skips a fixed-time run more than 10 minutes late (`Schedule.ts isMissedFixedTimeRun`), but the window lasts 25 minutes. The day's check-in silently never comes. The fix belongs in T3's scheduler or a Kin-side catch-up.
2. `InsideWindow`: a run that starts late (host waking, clock change) uses its start as `dueAt` (`KinTriggerSink`, `checkIn.ts`), so the picked minute can land up to 10 minutes after the window closes.
3. `FactNeverAbsent`: when every open fact is held, `queueCheckIn` returns "nothing new" (`KinPulse.read` without held facts), so the held fact is not mentioned that day. Including held facts means a check-in every day while anything is held.
   **Left out.** Outside mail lines (their cursor moves even when a same-day duplicate drops them), the 200-fact cap, member-vs-owner hold visibility, Run now, quiet hours, DST.
   **Covers** (confirmed at kin `6b1f702561`): `apps/server/src/scheduledTasks/{Schedule.ts,ScheduledTaskService.ts}` (`runDueTasks`, `isMissedFixedTimeRun`, `nextScheduledRunAt`), `apps/server/src/kin/pulse/{checkIn.ts,checkIns.ts,checkInSeeds.ts,KinPulse.ts}` (`queueCheckIn`, `looseOffsetMs`, `followOwnerZone`, `handle`, `handledOf`), `apps/server/src/kin/triggers/{scheduledTasks.ts,KinTriggerSink.ts,kinSchedules.ts}`, `apps/server/src/kin/lead/KinEventQueue.ts` (`enqueue` dedupe).
