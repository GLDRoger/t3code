---------------------------- MODULE Reply ----------------------------
(* One person's chat with a lead: their messages, the wake-ups that answer them, the reply, the
   failure lines, a relay or nudge the lead sends them mid-turn, "Working…", and restarts. Each
   action names the code it stands for (paths under apps/server/src/kin). *)
EXTENDS Naturals

CONSTANTS Broken, Msgs

VARIABLES
  ev,        \* kin_events.state per message: none, queued, claimed, done, failed
  tries,     \* kin_events.attempts
  wake,      \* "idle" or "running": one running wake-up per lead (K034_PerLeadWakeups)
  covered,   \* this wake-up's reply already covers the message (the bridge's slot)
  replies,   \* replies the person got for the message, over all wake-ups
  fails,     \* final plain failure lines for the message
  thought,   \* the lead's reasoning reached the chat
  nudged,    \* the lead sent the asker a relay or nudge this wake-up
  lost,      \* a relay or nudge was refused
  worked,    \* this wake-up did something visible (kin_wakeups visible check)
  floor,     \* "open" or "closed" (KinFloor runs: a newer message closes the old run)
  presence,  \* the lead's line: "off", "on"
  restarts

vars == <<ev, tries, wake, covered, replies, fails, thought, nudged, lost, worked, floor, presence,
          restarts>>

Claimed == {m \in Msgs : ev[m] = "claimed"}

Init ==
  /\ ev = [m \in Msgs |-> "none"] /\ tries = [m \in Msgs |-> 0]
  /\ wake = "idle" /\ covered = [m \in Msgs |-> FALSE]
  /\ replies = [m \in Msgs |-> 0] /\ fails = [m \in Msgs |-> 0]
  /\ thought = FALSE /\ nudged = FALSE /\ lost = FALSE /\ worked = FALSE
  /\ floor = "open" /\ presence = "off" /\ restarts = 0

(* chat/KinChatService.ts sendClaimed → floor.open; lead/ChatWake.ts enqueues the wake event. *)
PersonSends(m) ==
  /\ ev[m] = "none" /\ (IF m = 1 THEN TRUE ELSE ev[m - 1] # "none")
  /\ ev' = [ev EXCEPT ![m] = "queued"]
  /\ floor' = "open"
  /\ UNCHANGED <<tries, wake, covered, replies, fails, thought, nudged, lost, worked, presence,
                 restarts>>

(* KinEventQueue.claim takes every queued event of the chat; bridge.preparing/begin: the line. *)
Claim ==
  /\ wake = "idle" /\ \E m \in Msgs : ev[m] = "queued"
  /\ ev' = [m \in Msgs |-> IF ev[m] = "queued" THEN "claimed" ELSE ev[m]]
  /\ wake' = "running" /\ presence' = "on"
  /\ covered' = [m \in Msgs |-> FALSE] /\ nudged' = FALSE /\ worked' = FALSE
  /\ UNCHANGED <<tries, replies, fails, thought, lost, floor, restarts>>

(* KinEventQueue.steer: a message sent mid-turn joins the running wake-up with its own slot. *)
Steer(m) ==
  /\ wake = "running" /\ ev[m] = "queued"
  /\ ev' = [ev EXCEPT ![m] = "claimed"]
  /\ UNCHANGED <<tries, wake, covered, replies, fails, thought, nudged, lost, worked, floor,
                 presence, restarts>>

(* reply/KinReplyBridge.ts deliver: an answer segment posts once per slot (reply:<item>), extends
   after; isAnswer keeps Claude thinking items out (only the variant posts them). *)
LeadReplies ==
  /\ wake = "running" /\ \E m \in Claimed : ~covered[m]
  /\ replies' = [m \in Msgs |-> IF m \in Claimed /\ ~covered[m] THEN replies[m] + 1 ELSE replies[m]]
  /\ covered' = [m \in Msgs |-> covered[m] \/ m \in Claimed]
  /\ worked' = TRUE
  /\ UNCHANGED <<ev, tries, wake, fails, thought, nudged, lost, floor, presence, restarts>>

LeadThinks ==
  /\ wake = "running"
  /\ IF Broken = "reasoning-posted" /\ \E m \in Claimed : ~covered[m]
       THEN /\ thought' = TRUE
            /\ covered' = [m \in Msgs |-> covered[m] \/ m \in Claimed]
       ELSE UNCHANGED <<thought, covered>>
  /\ UNCHANGED <<ev, tries, wake, replies, fails, nudged, lost, worked, floor, presence, restarts>>

(* lead/Handoff.ts relay, pulse nudge → LevelGate.postTo → KinFloor.admitToPerson: the hourly
   limit only, whatever the floor (the variant goes through authorize instead). *)
LeadNudgesAsker ==
  /\ wake = "running" /\ ~nudged
  /\ nudged' = TRUE /\ worked' = TRUE
  /\ lost' = (lost \/ (Broken = "relay-through-floor" /\ floor = "closed"))
  /\ covered' = IF Broken = "relay-counts" THEN [m \in Msgs |-> covered[m] \/ m \in Claimed]
                ELSE covered
  /\ UNCHANGED <<ev, tries, wake, replies, fails, thought, floor, presence, restarts>>

LeadWorks == wake = "running" /\ ~worked /\ worked' = TRUE
  /\ UNCHANGED <<ev, tries, wake, covered, replies, fails, thought, nudged, lost, floor, presence,
                 restarts>>

(* A newer human message elsewhere, or six agent turns, closes this floor run. *)
FloorCloses == floor = "open" /\ floor' = "closed"
  /\ UNCHANGED <<ev, tries, wake, covered, replies, fails, thought, nudged, lost, worked, presence,
                 restarts>>

Owed == {m \in Claimed : ~covered[m]}
Ended == [m \in Msgs |-> IF m \in Claimed THEN "done" ELSE ev[m]]

(* KinReplyBridge.complete: a completed run that owed a reply gets one rescue turn, then
   "{Lead} didn't reply." Events done (KinEventQueue.finish). settleLine clears the line. *)
RunCompletes ==
  /\ wake = "running"
  /\ \/ /\ replies' = [m \in Msgs |-> IF m \in Owed THEN replies[m] + 1 ELSE replies[m]]
        /\ UNCHANGED fails
     \/ /\ fails' = [m \in Msgs |-> IF m \in Owed THEN fails[m] + 1 ELSE fails[m]]
        /\ UNCHANGED replies
  /\ ev' = Ended /\ wake' = "idle"
  /\ presence' = IF Broken = "line-stays" THEN presence ELSE "off"
  /\ UNCHANGED <<tries, covered, thought, nudged, lost, worked, floor, restarts>>

(* WakeupRunner.finishWakeup after a failed or timed-out run: something visible → events failed
   and "{Lead} stopped partway."; nothing visible → retried with "trying again" (not final), and
   the third try fails with "won't try again on its own." *)
RunFails ==
  /\ wake = "running"
  /\ IF worked
       THEN /\ ev' = [m \in Msgs |-> IF m \in Claimed THEN "failed" ELSE ev[m]]
            /\ fails' = [m \in Msgs |-> IF m \in Claimed THEN fails[m] + 1 ELSE fails[m]]
            /\ UNCHANGED tries
       ELSE /\ tries' = [m \in Msgs |-> IF m \in Claimed THEN tries[m] + 1 ELSE tries[m]]
            /\ ev' = [m \in Msgs |-> IF m \in Claimed
                                     THEN IF tries[m] + 1 >= 3 THEN "failed" ELSE "queued"
                                     ELSE ev[m]]
            /\ fails' = [m \in Msgs |-> IF m \in Claimed /\ tries[m] + 1 >= 3
                                        THEN fails[m] + 1 ELSE fails[m]]
  /\ wake' = "idle"
  /\ presence' = IF Broken = "line-stays" THEN presence ELSE "off"
  /\ UNCHANGED <<covered, replies, thought, nudged, lost, worked, floor, restarts>>

(* Kin shuts down mid-turn: WakeupRunner.cleanup(interrupted) → KinEventQueue.requeueUnfinished
   puts the claimed events back, whatever was posted; the line lives in memory and is gone. *)
Restart ==
  /\ restarts < 1 /\ wake = "running"
  /\ ev' = [m \in Msgs |-> IF m \in Claimed THEN "queued" ELSE ev[m]]
  /\ wake' = "idle" /\ presence' = "off" /\ restarts' = restarts + 1
  /\ UNCHANGED <<tries, covered, replies, fails, thought, nudged, lost, worked, floor>>

Next ==
  \/ \E m \in Msgs : PersonSends(m) \/ Steer(m)
  \/ Claim \/ LeadReplies \/ LeadThinks \/ LeadNudgesAsker \/ LeadWorks \/ FloorCloses
  \/ RunCompletes \/ RunFails \/ Restart

Fair == WF_vars(Claim) /\ WF_vars(RunCompletes \/ RunFails)

Spec == Init /\ [][Next]_vars /\ Fair

------------------------------------------------------------------------------------------------
NeverTwo == \A m \in Msgs : replies[m] + fails[m] <= 1
NeverReasoning == ~thought
RelayLands == ~lost
EveryMessageAnswered == \A m \in Msgs : ev[m] # "none" ~> replies[m] + fails[m] >= 1
LineClears == presence = "on" ~> presence = "off"
=============================================================================
