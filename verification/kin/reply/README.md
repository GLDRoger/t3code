# A turn's reply (`node scripts/kin-model.ts reply`)

**Rules.** Each message gets at most one reply or one plain failure line, and eventually at least one, even if the agent sent the asker a nudge or relay meanwhile. Reasoning never posts as the reply. A nudge or relay always lands whatever the floor. "Working…" always clears.
**Harm guarded.** A person waits for an answer that never comes, gets two, or reads the agent's private reasoning.
**Bound.** Two messages from one person to one lead, three start attempts, one restart, a floor that can close. About 7,000 states, 5 s. `--variants`: 4/4 caught.
**Open findings (not fixed).**

1. The reply posts, then the turn fails on a later step, and "{Lead} stopped partway." follows (`WakeupRunner.finishWakeup`, `stranded > 0`). That is two answers to one message, but it truthfully says the work did not finish. Product choice.
2. Kin shuts down after the reply but before the turn ends. `WakeupRunner.cleanup(interrupted)` → `KinEventQueue.requeueUnfinished` requeues the message whatever was posted, and after the restart the agent answers it again. Seen by setting the partway path aside (`RunFails` only before visible work).
   **Fixed in this change.** A nudge or relay sent to the asker mid-turn counted as their reply (`KinReplyBridge.answered`), leaving them with silence. Variant `relay-counts`.
   **Left out.** Several leads in a group, steering caps, rescue timing, reply-text classification (`classify.ts`), non-Claude reasoning ids, hangs before a run starts.
   **Covers** (confirmed at kin `6b1f702561` plus this change): `apps/server/src/kin/reply/KinReplyBridge.ts` (`answered`, `complete`, `deliver`), `apps/server/src/kin/lead/WakeupRunner.ts` (`finishWakeup`, `cleanup`), `apps/server/src/kin/lead/KinEventQueue.ts` (`claim`, `steer`, `finish`, `requeueUnfinished`), `apps/server/src/kin/floor/KinFloor.ts` (`admitToPerson`, `authorize`), `apps/server/src/kin/lead/Handoff.ts` (`relay`), `apps/server/src/kin/pulse/nudge.ts`.
