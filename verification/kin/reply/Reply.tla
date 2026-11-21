---------------------------- MODULE Reply ----------------------------
(* One person's chat with a lead: their messages, the wake-ups that answer them, the reply, the
   failure lines, a relay or nudge the lead sends them mid-turn, "Working…", and restarts. Each
   action names the code it stands for (paths under apps/server/src/kin). The reply is the text
   the lead writes, wherever it falls among its tool calls; the turn ends when the lead stops. *)
EXTENDS Naturals

CONSTANTS Broken, Msgs

VARIABLES
  ev,        \* kin_events.state per message: none, queued, claimed, done, failed
  tries,     \* kin_events.attempts
  wake,      \* "idle" or "running": one running wake-up per lead (K034_PerLeadWakeups)
  covered,   \* this wake-up's reply already covers the message (the bridge's slot)
  replies,   \* replies the person got for the message, over all wake-ups
  answered,  \* kin_events.replied_at: set the moment a reply for the message posts
  promise,   \* what the reply promised this wake-up: "none", "kept", or "open" (not done yet)
  notes,     \* lines naming a promise the reply made that a failure left undone
  fails,     \* final plain failure lines for the message
  thought,   \* the lead's reasoning reached the chat
  nudged,    \* the lead sent the asker a relay or nudge this wake-up
  lost,      \* a relay or nudge was refused
  worked,    \* this wake-up did something visible (kin_wakeups visible check)
  floor,     \* "open" or "closed" (KinFloor runs: a newer message closes the old run)
  presence,  \* the lead's line: "off", "on"
  restarts,
  shown,     \* a chart, visual or file card is all the message got this wake-up, no words
  asked,     \* the turn's end asked the lead once for the words it owed (rescue or caption)
  twice      \* the person read the same answer twice in one reply

vars == <<ev, tries, wake, covered, replies, answered, promise, notes, fails, thought, nudged, lost,
          worked, floor, presence, restarts, shown, asked, twice>>

Claimed == {m \in Msgs : ev[m] = "claimed"}
\* KinEventQueue RUN_ATTEMPTS: retries 15 s, 1 min and 15 min after a start that showed nothing.
StartAttempts == 4

Init ==
  /\ ev = [m \in Msgs |-> "none"] /\ tries = [m \in Msgs |-> 0]
  /\ wake = "idle" /\ covered = [m \in Msgs |-> FALSE]
  /\ replies = [m \in Msgs |-> 0] /\ fails = [m \in Msgs |-> 0]
  /\ answered = [m \in Msgs |-> FALSE] /\ promise = "none" /\ notes = [m \in Msgs |-> 0]
  /\ thought = FALSE /\ nudged = FALSE /\ lost = FALSE /\ worked = FALSE
  /\ floor = "open" /\ presence = "off" /\ restarts = 0
  /\ shown = [m \in Msgs |-> FALSE] /\ asked = [m \in Msgs |-> FALSE] /\ twice = FALSE

(* chat/KinChatService.ts sendClaimed → floor.open; lead/ChatWake.ts enqueues the wake event. *)
PersonSends(m) ==
  /\ ev[m] = "none" /\ (IF m = 1 THEN TRUE ELSE ev[m - 1] # "none")
  /\ ev' = [ev EXCEPT ![m] = "queued"]
  /\ floor' = "open"
  /\ UNCHANGED <<tries, wake, covered, replies, answered, promise, notes, fails, thought, nudged, lost,
                 worked, presence, restarts, shown, asked, twice>>

(* KinEventQueue.claim takes every queued event of the chat; bridge.preparing/begin: the line. *)
Claim ==
  /\ wake = "idle" /\ \E m \in Msgs : ev[m] = "queued"
  /\ ev' = [m \in Msgs |-> IF ev[m] = "queued" THEN "claimed" ELSE ev[m]]
  /\ wake' = "running" /\ presence' = "on"
  /\ covered' = [m \in Msgs |-> FALSE] /\ nudged' = FALSE /\ worked' = FALSE /\ promise' = "none"
  /\ shown' = [m \in Msgs |-> IF ev[m] = "queued" THEN FALSE ELSE shown[m]]
  /\ asked' = [m \in Msgs |-> IF ev[m] = "queued" THEN FALSE ELSE asked[m]]
  /\ UNCHANGED <<tries, replies, answered, notes, fails, thought, lost, floor, restarts, twice>>

(* KinEventQueue.steer: a message sent mid-turn joins the running wake-up with its own slot,
   until the run ends: the lead's reply ending its turn no longer closes it. *)
Steer(m) ==
  /\ wake = "running" /\ ev[m] = "queued"
  /\ ev' = [ev EXCEPT ![m] = "claimed"]
  /\ shown' = [shown EXCEPT ![m] = FALSE] /\ asked' = [asked EXCEPT ![m] = FALSE]
  /\ UNCHANGED <<tries, wake, covered, replies, answered, promise, notes, fails, thought, nudged, lost,
                 worked, floor, presence, restarts, twice>>

(* reply/KinReplyBridge.ts post/deliver: the lead's text posts once per slot (reply:<item>),
   before or after any tool call, and extends that message after; a card that asks or shows its
   result (kin_ask, a statement, an approval) answers the same way. isAnswer keeps Claude thinking
   items out (only the variant posts them). The post's own transaction sets replied_at on the
   events the model had read before the segment (`heard`); Steer here is the claim and the model
   reading it in one step. The reply may promise a card or a hand-over later work has to do. *)
LeadReplies ==
  /\ wake = "running" /\ \E m \in Claimed : ~covered[m]
  /\ replies' = [m \in Msgs |-> IF m \in Claimed /\ ~covered[m] THEN replies[m] + 1 ELSE replies[m]]
  /\ answered' = [m \in Msgs |-> answered[m] \/ m \in Claimed]
  /\ covered' = [m \in Msgs |-> covered[m] \/ m \in Claimed]
  /\ worked' = TRUE
  /\ promise' \in IF promise = "none" THEN {"none", "open"} ELSE {promise}
  /\ UNCHANGED <<ev, tries, wake, notes, fails, thought, nudged, lost, floor, presence, restarts,
                 shown, asked, twice>>

(* After a tool call, the lead writes its answer again, word for word. KinReplyBridge.post drops
   a segment that `repeats` the reply so far (reply/classify.ts); the variant extends with it. *)
LeadRepeats ==
  /\ wake = "running" /\ \E m \in Claimed : covered[m]
  /\ twice' = (twice \/ Broken = "repeat-posted")
  /\ UNCHANGED <<ev, tries, wake, covered, replies, answered, promise, notes, fails, thought, nudged,
                 lost, worked, floor, presence, restarts, shown, asked>>

(* kin_chart, kin_visual or a file's doc card: it shows something and says nothing, so the
   bridge's `answered` doesn't count it (SHOWS_ONLY). The variant counts it as the answer. *)
LeadShows ==
  /\ wake = "running" /\ \E m \in Claimed : ~covered[m]
  /\ shown' = [m \in Msgs |-> shown[m] \/ (m \in Claimed /\ ~covered[m])]
  /\ covered' = IF Broken = "chart-is-answer" THEN [m \in Msgs |-> covered[m] \/ m \in Claimed]
                ELSE covered
  /\ worked' = TRUE
  /\ UNCHANGED <<ev, tries, wake, replies, answered, promise, notes, fails, thought, nudged, lost,
                 floor, presence, restarts, asked, twice>>

(* The card is posted, or the hand-over sent, that the reply promised. *)
LeadKeepsPromise ==
  /\ wake = "running" /\ promise = "open"
  /\ promise' = "kept"
  /\ UNCHANGED <<ev, tries, wake, covered, replies, answered, notes, fails, thought, nudged, lost,
                 worked, floor, presence, restarts, shown, asked, twice>>

(* Thinking, even a summary that reads like the reply: it never posts (only the variant). *)
LeadThinks ==
  /\ wake = "running"
  /\ IF Broken = "reasoning-posted" /\ \E m \in Claimed : ~covered[m]
       THEN /\ thought' = TRUE
            /\ covered' = [m \in Msgs |-> covered[m] \/ m \in Claimed]
       ELSE UNCHANGED <<thought, covered>>
  /\ UNCHANGED <<ev, tries, wake, replies, answered, promise, notes, fails, nudged, lost, worked, floor,
                 presence, restarts, shown, asked, twice>>

(* lead/Handoff.ts relay, pulse nudge → LevelGate.postTo → KinFloor.admitToPerson: the hourly
   limit only, whatever the floor (the variant goes through authorize instead). *)
LeadNudgesAsker ==
  /\ wake = "running" /\ ~nudged
  /\ nudged' = TRUE /\ worked' = TRUE
  /\ lost' = (lost \/ (Broken = "relay-through-floor" /\ floor = "closed"))
  /\ covered' = IF Broken = "relay-counts" THEN [m \in Msgs |-> covered[m] \/ m \in Claimed]
                ELSE covered
  /\ UNCHANGED <<ev, tries, wake, replies, answered, promise, notes, fails, thought, floor, presence,
                 restarts, shown, asked, twice>>

LeadWorks == wake = "running" /\ ~worked /\ worked' = TRUE
  /\ UNCHANGED <<ev, tries, wake, covered, replies, answered, promise, notes, fails, thought, nudged,
                 lost, floor, presence, restarts, shown, asked, twice>>

(* A newer human message elsewhere, or six agent turns, closes this floor run. *)
FloorCloses == floor = "open" /\ floor' = "closed"
  /\ UNCHANGED <<ev, tries, wake, covered, replies, answered, promise, notes, fails, thought, nudged,
                 lost, worked, presence, restarts, shown, asked, twice>>

Owed == {m \in Claimed : ~covered[m]}

Ended == [m \in Msgs |-> IF m \in Claimed THEN "done" ELSE ev[m]]

(* KinReplyBridge.complete: the lead stopped. A message still owed words gets one turn asking for
   them (RESCUE_PROMPT, or CAPTION_PROMPT for one that only got a chart or file), then
   "{Lead} didn't reply." when none came, except under a chart or file, which stands. Events done
   (KinEventQueue.finish). settleLine clears the line. The variant ends without asking. *)
RunCompletes ==
  /\ wake = "running"
  /\ asked' = [m \in Msgs |-> asked[m] \/ (m \in Owed /\ Broken # "no-rescue")]
  /\ \/ /\ replies' = [m \in Msgs |-> IF m \in Owed THEN replies[m] + 1 ELSE replies[m]]
        /\ answered' = [m \in Msgs |-> answered[m] \/ m \in Owed]
        /\ UNCHANGED fails
     \/ /\ fails' = [m \in Msgs |-> IF m \in Owed /\ ~shown[m] THEN fails[m] + 1 ELSE fails[m]]
        /\ UNCHANGED <<replies, answered>>
  /\ ev' = Ended /\ wake' = "idle"
  /\ presence' = IF Broken = "line-stays" THEN presence ELSE "off"
  /\ UNCHANGED <<tries, covered, promise, notes, thought, nudged, lost, worked, floor, restarts, shown,
                 twice>>

(* WakeupRunner.finishWakeup after a failed or timed-out run: something visible → each message
   with its reply posted is done, the others failed with "{Lead} stopped partway."
   (KinEventQueue.finish `stranded` / `replied`). With every message replied, a line follows only
   for what the reply promised and the turn left undone (KinReplyBridge.failed "replied":
   missingCard, unkeptPromise); otherwise it is only logged. Nothing visible → retried with
   "trying again" (not final), and the fourth try fails with "won't try again on its own." *)
RunFails ==
  /\ wake = "running"
  /\ IF worked
       THEN LET mark(m) == answered[m] /\ Broken # "partway-after-reply"
                stranded == {m \in Claimed : ~mark(m)}
            IN /\ ev' = [m \in Msgs |-> IF m \in Claimed THEN IF mark(m) THEN "done" ELSE "failed"
                                         ELSE ev[m]]
               /\ fails' = [m \in Msgs |-> IF m \in stranded THEN fails[m] + 1 ELSE fails[m]]
               /\ notes' = [m \in Msgs |-> IF stranded = {} /\ m \in Claimed /\ promise = "open"
                                           THEN notes[m] + 1 ELSE notes[m]]
               /\ UNCHANGED tries
       ELSE /\ tries' = [m \in Msgs |-> IF m \in Claimed THEN tries[m] + 1 ELSE tries[m]]
            /\ ev' = [m \in Msgs |-> IF m \in Claimed
                                     THEN IF tries[m] + 1 >= StartAttempts THEN "failed" ELSE "queued"
                                     ELSE ev[m]]
            /\ fails' = [m \in Msgs |-> IF m \in Claimed /\ tries[m] + 1 >= StartAttempts
                                        THEN fails[m] + 1 ELSE fails[m]]
            /\ UNCHANGED notes
  /\ wake' = "idle"
  /\ presence' = IF Broken = "line-stays" THEN presence ELSE "off"
  /\ UNCHANGED <<covered, replies, answered, promise, thought, nudged, lost, worked, floor, restarts,
                 shown, asked, twice>>

(* Kin shuts down mid-turn: WakeupRunner.cleanup(interrupted) → KinEventQueue.requeueUnfinished
   marks done the claimed events whose reply posted (replied_at) and puts the rest back; the line
   lives in memory and is gone. *)
Restart ==
  /\ restarts < 1 /\ wake = "running"
  /\ ev' = [m \in Msgs |-> IF m \in Claimed
                            THEN IF answered[m] /\ Broken # "requeue-replied" THEN "done" ELSE "queued"
                            ELSE ev[m]]
  /\ wake' = "idle" /\ presence' = "off" /\ restarts' = restarts + 1
  /\ UNCHANGED <<tries, covered, replies, answered, promise, notes, fails, thought, nudged, lost, worked,
                 floor, shown, asked, twice>>

Next ==
  \/ \E m \in Msgs : PersonSends(m) \/ Steer(m)
  \/ Claim \/ LeadReplies \/ LeadRepeats \/ LeadShows \/ LeadKeepsPromise \/ LeadThinks
  \/ LeadNudgesAsker \/ LeadWorks
  \/ FloorCloses
  \/ RunCompletes \/ RunFails \/ Restart

Fair == WF_vars(Claim) /\ WF_vars(RunCompletes \/ RunFails)

Spec == Init /\ [][Next]_vars /\ Fair

------------------------------------------------------------------------------------------------
NeverTwo == \A m \in Msgs : replies[m] + fails[m] <= 1
\* The one exception to a single answer: a short line naming what the reply promised and a later
\* failure left undone, at most once, and only after a reply.
NoteOnlyForBrokenPromise == \A m \in Msgs : notes[m] <= 1 /\ (notes[m] = 1 => replies[m] = 1)
NeverReasoning == ~thought
\* The reply says its answer once, even when the lead writes it again after a tool call.
SaidOnce == ~twice
RelayLands == ~lost
\* A turn that ended without the words a message waited for asked the lead for them once: a
\* thinking-only end, and a chart or file with no line beside it.
AskedBeforeSilence == \A m \in Msgs : (ev[m] = "done" /\ ~answered[m]) => asked[m]
\* A chart or file asked for its line stands as the answer when none comes.
EveryMessageAnswered ==
  \A m \in Msgs : ev[m] # "none" ~> (replies[m] + fails[m] >= 1 \/ (shown[m] /\ asked[m]))
LineClears == presence = "on" ~> presence = "off"
=============================================================================
