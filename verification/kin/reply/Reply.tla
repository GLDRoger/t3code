---------------------------- MODULE Reply ----------------------------
(* One person's chat with a lead: their messages, the wake-ups that answer them, the reply, the
   failure lines, a relay or nudge the lead sends them mid-turn, "Working…", Stop, and restarts.
   Each action names the code it stands for (paths under apps/server/src/kin). The reply is the
   text the lead writes, wherever it falls among its tool calls. The bridge holds it while the run
   works and posts it once the run has ended, as one group of bubbles in one transaction. *)
EXTENDS Naturals

CONSTANTS Broken, Msgs,
  Quiet,     \* messages that may go unanswered: a plain new reaction, another agent's answer
             \* coming back, a message this agent handed off (KinReplyBridge quietAllowed)
  Triggers   \* events that may arrive from a trigger instead (a check-in, GitHub, a pulse fact):
             \* reply/turnVoice.ts startedBy reads no person's act among them

VARIABLES
  ev,        \* kin_events.state per message: none, queued, claimed, done, failed, expired
  tries,     \* kin_events.attempts
  wake,      \* "idle" or "running": one running wake-up per lead (K034_PerLeadWakeups)
  covered,   \* this wake-up's reply already covers the message (the bridge's slot)
  replies,   \* replies the person got for the message, over all wake-ups: a group counts once
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
  twice,     \* the person read the same answer twice in one reply
  diagnostic, \* a terminal provider diagnostic reached the posted reply
  joined,    \* someone joined the chat, or the asker lost co-owner access, after this wake-up's
             \* private prompt was built: it may post nowhere it was built for
  joins,
  noticed,   \* the bridge's movedNoticed: this wake-up handled a reply held back for the join
  aborted,   \* kin_wakeups.aborted_at, set by requeueForAudience
  moves,     \* times a message's events were moved to a fresh wake-up (the `_audienceMoved` flag)
  heldBack,  \* the chat was told the message's reply was held back for the join
  toOld,     \* a reply posted to the audience the turn's prompt was built for, after the join
  demoted,   \* the asker was made a member (one access change in the bound)
  held,      \* reply text the lead wrote for the message this wake-up, held, not yet posted
  ended,     \* how the wake-up's run ended: "no" (still working), "completed", "failed",
             \* "interrupted" (a person's Stop); completion runs after it
  stopping,  \* a person's Stop landed on the running wake-up (KinStop.interrupt)
  sent,      \* a kin_send succeeded this wake-up: the turn's one message
  stopped,   \* the person's Stop ended the message (KinStop marked its event done)
  stopPosted, \* reply text was posted for a message its person had stopped
  partial,   \* part of a reply group showed in the chat without the rest
  twoRings,  \* one reply group rang (pushed or counted unread) more than once
  early,     \* reply text posted while the run was still working
  letGo,     \* an accepted kin_skip ended the turn with nothing posted for the message
  trig,      \* the Triggers event arrived from a trigger, not from the person
  voice,     \* the wake-up's voice as it started (Wake.startingVoice): "send" when it claimed only
             \* triggers with kinTriggerSendOnly on, so only kin_send reaches anyone; else "text"
  nudges,    \* follow-ups this wake-up sent for unsent text (turnVoice.ts followUpFor "nudge")
  plain      \* a triggered turn's plain text reached the chat in send voice

audience == <<joined, joins, noticed, aborted, moves, heldBack, toOld, demoted>>
turn == <<held, ended, stopping, sent, voice, nudges>>
marks == <<stopped, stopPosted, partial, twoRings, early, letGo, trig, plain>>
vars == <<ev, tries, wake, covered, replies, answered, promise, notes, fails, thought, nudged, lost,
          worked, floor, presence, restarts, shown, asked, twice, diagnostic, audience, turn, marks>>

Claimed == {m \in Msgs : ev[m] = "claimed"}
TrigMsg(m) == m \in Triggers /\ trig
QuietMsg(m) == m \in Quiet /\ ~TrigMsg(m)
\* Held text no group has posted yet: what the flush at the run's end owes the chat.
Pending == {m \in Msgs : held[m] /\ ~covered[m]}
(* KinReplyBridge.flushReplies drops the slot a send-voice wake-up started with (`startingVoice`):
   its text is journalled "Not sent". The variant posts it, as plain text did before the switch. *)
Dropped == IF Broken = "trigger-text-posts" THEN {} ELSE {m \in Msgs : TrigMsg(m) /\ voice = "send"}
Unposted == Pending \ Dropped
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
  /\ diagnostic = FALSE
  /\ joined = FALSE /\ joins = 0 /\ noticed = FALSE /\ aborted = FALSE
  /\ moves = [m \in Msgs |-> 0] /\ heldBack = [m \in Msgs |-> FALSE] /\ toOld = FALSE
  /\ demoted = FALSE
  /\ held = [m \in Msgs |-> FALSE] /\ ended = "no" /\ stopping = FALSE /\ sent = FALSE
  /\ stopped = [m \in Msgs |-> FALSE] /\ stopPosted = FALSE /\ partial = FALSE
  /\ twoRings = FALSE /\ early = FALSE /\ letGo = [m \in Msgs |-> FALSE]
  /\ trig = FALSE /\ voice = "text" /\ nudges = 0 /\ plain = FALSE

(* The wake-up is over: what lived in its memory goes with it. What only a running wake-up reads,
   and Claim sets afresh, is cleared too, so idle states that differ only in a finished turn's
   leftovers are one state; no step, rule or fairness condition reads it while idle. *)
TurnOver == held' = [m \in Msgs |-> FALSE] /\ ended' = "no" /\ stopping' = FALSE /\ sent' = FALSE
  /\ voice' = "text" /\ nudges' = 0
  /\ covered' = [m \in Msgs |-> FALSE] /\ worked' = FALSE /\ promise' = "none"
  /\ joined' = FALSE /\ noticed' = FALSE /\ aborted' = FALSE
\* The part of the audience's record that outlives the wake-up.
lasting == <<joins, moves, heldBack, toOld, demoted>>

(* An event's new states. A settled event (done, failed, expired) is never claimed again, so its
   attempt count is never read again: it is cleared, which merges states that differ only there. *)
Ev(e) == ev' = e /\ tries' = [m \in Msgs |-> IF e[m] \in {"queued", "claimed"} THEN tries[m] ELSE 0]

(* chat/KinChatService.ts sendClaimed → floor.open; lead/ChatWake.ts enqueues the wake event. *)
PersonSends(m) ==
  /\ ev[m] = "none" /\ (IF m = 1 THEN TRUE ELSE ev[m - 1] # "none")
  /\ ev' = [ev EXCEPT ![m] = "queued"]
  /\ floor' = "open"
  /\ UNCHANGED <<tries, wake, covered, replies, answered, promise, notes, fails, thought, nudged, lost,
                 worked, presence, restarts, shown, asked, twice, diagnostic, audience, turn, marks>>

(* A trigger's event for the lead's own chat (a check-in, a GitHub event, a pulse fact), queued
   with no person's act and no floor (pulse/checkIn.ts, github/GitHubWatch.ts and the others). *)
TriggerFires(m) ==
  /\ m \in Triggers /\ ev[m] = "none"
  /\ ev' = [ev EXCEPT ![m] = "queued"] /\ trig' = TRUE
  /\ UNCHANGED <<tries, wake, covered, replies, answered, promise, notes, fails, thought, nudged, lost,
                 worked, floor, presence, restarts, shown, asked, twice, diagnostic, audience, turn,
                 stopped, stopPosted, partial, twoRings, early, letGo, plain>>

(* KinEventQueue.claim takes every queued event of the chat; bridge.preparing/begin: the line.
   Its prompt is built for the chat as it now stands (Audience.ts recordAudience). *)
Claim ==
  /\ wake = "idle" /\ \E m \in Msgs : ev[m] = "queued"
  /\ ev' = [m \in Msgs |-> IF ev[m] = "queued" THEN "claimed" ELSE ev[m]]
  /\ wake' = "running" /\ presence' = "on"
  /\ covered' = [m \in Msgs |-> FALSE] /\ nudged' = FALSE /\ worked' = FALSE /\ promise' = "none"
  /\ shown' = [m \in Msgs |-> IF ev[m] = "queued" THEN FALSE ELSE shown[m]]
  /\ asked' = [m \in Msgs |-> IF ev[m] = "queued" THEN FALSE ELSE asked[m]]
  /\ joined' = FALSE /\ noticed' = FALSE /\ aborted' = FALSE
  /\ letGo' = [m \in Msgs |-> IF ev[m] = "queued" THEN FALSE ELSE letGo[m]]
  \* replyLane.ts laneFor: voiceFor over the claimed tags, with the switch on (its default).
  /\ voice' = IF \A m \in Msgs : ev[m] = "queued" => TrigMsg(m) THEN "send" ELSE "text"
  /\ UNCHANGED <<tries, replies, answered, notes, fails, thought, lost, floor, restarts, twice, diagnostic,
                 joins, moves, heldBack, toOld, demoted, held, ended, stopping, sent, nudges, stopped,
                 stopPosted, partial, twoRings, early, trig, plain>>

(* KinEventQueue.steer: a message sent mid-turn joins the running wake-up with its own slot,
   until the run ends: in the run (steer), or as a run the wake-up adopts (queue), whose end is
   the wake-up's end (WakeupRunner follows it before it reads the terminal status). A message
   sent after a Stop waits for a fresh wake-up here. The code at 85cc2bbd3c does not wait:
   `queue.steer` and `steering.open` still take it until the runner sees the interrupted run end.
   The variant lets it in, either way (`steer-after-stop`). *)
Steer(m) ==
  /\ wake = "running" /\ ended = "no" /\ ev[m] = "queued"
  \* WakeupRunner.steer releases what it took once the audience changed or the turn was aborted.
  /\ ~joined
  /\ ~stopping \/ Broken = "steer-after-stop"
  /\ ev' = [ev EXCEPT ![m] = "claimed"]
  /\ shown' = [shown EXCEPT ![m] = FALSE] /\ asked' = [asked EXCEPT ![m] = FALSE]
  \* In the interrupted run it stays a Stop; as an adopted run it turns the end into that run's.
  /\ stopping' \in IF stopping THEN {TRUE, FALSE} ELSE {FALSE}
  /\ letGo' = [letGo EXCEPT ![m] = FALSE]
  /\ UNCHANGED <<tries, wake, covered, replies, answered, promise, notes, fails, thought, nudged, lost,
                 worked, floor, presence, restarts, twice, diagnostic, audience, held, ended, sent,
                 voice, nudges, stopped, stopPosted, partial, twoRings, early, trig, plain>>

(* reply/KinReplyBridge.ts decide: the lead's text is held by slot (`outcome: "held"`) and
   nothing posts; its streaming draft is gone too. isAnswer keeps Claude thinking items out (only
   the variant posts them). Held text is no visible work (DID_VISIBLE_WORK reads posted rows, tool
   calls and pending actions). The reply may promise a card or a hand-over later work has to do. *)
LeadWrites ==
  /\ wake = "running" /\ ended = "no" /\ \E m \in Claimed : ~covered[m] /\ ~held[m]
  /\ held' = [m \in Msgs |-> held[m] \/ (m \in Claimed /\ ~covered[m])]
  /\ promise' \in IF promise = "none" THEN {"none", "open"} ELSE {promise}
  /\ UNCHANGED <<ev, tries, wake, covered, replies, answered, notes, fails, thought, nudged, lost,
                 worked, floor, presence, restarts, shown, asked, twice, diagnostic, audience, ended,
                 stopping, sent, voice, nudges, marks>>

(* lead/mcp/handlers.ts kin_send → KinReplyBridge.send: the agent's own message is the turn's one
   message for every slot it covers: text held for them is journalled "Not sent" at the flush.
   A person's turn sends now; a trigger may send now, quietly or at the owner's next check-in.
   The model does not distinguish levels. In a send-voice wake-up it is the only way the
   trigger's words reach anyone. One transaction checks the person's Stop (`wasStopped`), posts or
   holds the message and writes the receipt (`kin_lead_tool_calls`, its request hash and steer
   cutoff), so a Stop committed first refuses it and a retry or a resumed bridge returns the same
   message (`storedSend`). A slot steered in after it posts as its own. A second, different send
   is refused, so is one after kin_skip, and the gate withholds one after a join. The model sends
   before any other visible work (text may be held before it), or after the nudge; after a tool
   call it is the same step. The variant lets a send through after the Stop committed. *)
Sendable == {m \in Msgs : ~covered[m] /\ (ev[m] = "claimed" \/
               (Broken = "send-after-stop" /\ stopping /\ stopped[m] /\ ev[m] = "done"))}
LeadSends ==
  /\ wake = "running" /\ ended = "no" /\ ~joined /\ ~sent /\ (~worked \/ nudges > 0)
  /\ ~stopping \/ Broken = "send-after-stop"
  /\ \A m \in Claimed : ~letGo[m]
  /\ Sendable # {}
  /\ replies' = [m \in Msgs |-> IF m \in Sendable THEN replies[m] + 1 ELSE replies[m]]
  /\ answered' = [m \in Msgs |-> answered[m] \/ m \in Sendable]
  \* The variant forgets the receipt, so the flush posts the text held beside the send.
  /\ covered' = IF Broken = "text-after-send" THEN covered
                ELSE [m \in Msgs |-> covered[m] \/ m \in Sendable]
  /\ worked' = TRUE /\ sent' = TRUE
  /\ twoRings' = (twoRings \/ Broken = "bubble-two-rings")
  /\ stopPosted' = (stopPosted \/ \E m \in Sendable : stopped[m])
  /\ UNCHANGED <<ev, tries, wake, promise, notes, fails, thought, nudged, lost, floor, presence,
                 restarts, shown, asked, twice, diagnostic, audience, held, ended, stopping, voice,
                 nudges, stopped, partial, early, letGo, trig, plain>>

(* After a tool call, the lead writes its answer again, word for word. flushReplies keeps each
   exact paragraph once per slot (classify.ts uniqueParagraphs); the variant posts it twice. *)
LeadRepeats ==
  /\ wake = "running" /\ ended = "no" /\ \E m \in Claimed : held[m]
  /\ twice' = (twice \/ Broken = "repeat-posted")
  /\ UNCHANGED <<ev, tries, wake, covered, replies, answered, promise, notes, fails, thought, nudged,
                 lost, worked, floor, presence, restarts, shown, asked, diagnostic, audience, turn,
                 marks>>

(* kin_chart, kin_visual or a file's doc card: it shows something and says nothing, so the
   bridge's `answered` doesn't count it (SHOWS_ONLY). The variant counts it as the answer. *)
LeadShows ==
  /\ wake = "running" /\ ended = "no" /\ \E m \in Claimed : ~covered[m] /\ ~joined
  /\ shown' = [m \in Msgs |-> shown[m] \/ (m \in Claimed /\ ~covered[m])]
  /\ covered' = IF Broken = "chart-is-answer" THEN [m \in Msgs |-> covered[m] \/ m \in Claimed]
                ELSE covered
  /\ worked' = TRUE
  /\ UNCHANGED <<ev, tries, wake, replies, answered, promise, notes, fails, thought, nudged, lost,
                 floor, presence, restarts, asked, twice, diagnostic, audience, turn, marks>>

(* The card is posted, or the hand-over sent, that the reply promised. *)
LeadKeepsPromise ==
  /\ wake = "running" /\ ended = "no" /\ promise = "open" /\ ~joined
  /\ promise' = "kept"
  /\ UNCHANGED <<ev, tries, wake, covered, replies, answered, notes, fails, thought, nudged, lost,
                 worked, floor, presence, restarts, shown, asked, twice, diagnostic, audience, turn,
                 marks>>

(* Thinking, even a summary that reads like the reply: it never posts (only the variant). *)
LeadThinks ==
  /\ wake = "running" /\ ended = "no"
  /\ IF Broken = "reasoning-posted" /\ \E m \in Claimed : ~covered[m]
       THEN /\ thought' = TRUE
            /\ covered' = [m \in Msgs |-> covered[m] \/ m \in Claimed]
       ELSE UNCHANGED <<thought, covered>>
  /\ UNCHANGED <<ev, tries, wake, replies, answered, promise, notes, fails, nudged, lost, worked, floor,
                 presence, restarts, shown, asked, twice, diagnostic, audience, turn, marks>>

(* KinReplyBridge.settle checks a failed run's final answer against its provider error
   (classify.ts isProviderErrorText). The diagnostic leaves no posted reply or answered mark. *)
TerminalDiagnostic ==
  /\ wake = "running"
  /\ diagnostic' = (diagnostic \/ Broken = "diagnostic-posted")
  /\ UNCHANGED <<ev, tries, wake, covered, replies, answered, promise, notes, fails, thought,
                 nudged, lost, worked, floor, presence, restarts, shown, asked, twice, audience, turn,
                 marks>>

(* lead/Handoff.ts relay, pulse nudge → LevelGate.postTo → KinFloor.admitToPerson: the hourly
   limit only, whatever the floor (the variant goes through authorize instead). Here it is
   visible work and nothing more, so only the two relay variants remember it was sent. *)
LeadNudgesAsker ==
  /\ wake = "running" /\ ended = "no" /\ ~nudged /\ ~joined
  /\ nudged' = (Broken \in {"relay-counts", "relay-through-floor"}) /\ worked' = TRUE
  /\ lost' = (lost \/ (Broken = "relay-through-floor" /\ floor = "closed"))
  /\ covered' = IF Broken = "relay-counts" THEN [m \in Msgs |-> covered[m] \/ m \in Claimed]
                ELSE covered
  /\ UNCHANGED <<ev, tries, wake, replies, answered, promise, notes, fails, thought, floor, presence,
                 restarts, shown, asked, twice, diagnostic, audience, turn, marks>>

LeadWorks == wake = "running" /\ ended = "no" /\ ~worked /\ worked' = TRUE
  /\ UNCHANGED <<ev, tries, wake, covered, replies, answered, promise, notes, fails, thought, nudged,
                 lost, floor, presence, restarts, shown, asked, twice, diagnostic, audience, turn,
                 marks>>

(* A newer human message elsewhere, or six agent turns, closes this floor run. Only a relay
   that went through the floor would read it, so only that variant closes it. *)
FloorCloses == Broken = "relay-through-floor" /\ floor = "open" /\ floor' = "closed"
  /\ UNCHANGED <<ev, tries, wake, covered, replies, answered, promise, notes, fails, thought, nudged,
                 lost, worked, presence, restarts, shown, asked, twice, diagnostic, audience, turn,
                 marks>>

(* lead/KinStop.ts interrupt, a person's Stop: this wake-up's claimed events are marked done,
   then its run is interrupted and the chat reads "Rhea stopped Ada." That line is the person's
   own act, not an answer, so the model counts it on no message (`stopped` instead). *)
PersonStops ==
  /\ wake = "running" /\ ended = "no" /\ ~stopping /\ Claimed # {}
  /\ Ev([m \in Msgs |-> IF m \in Claimed THEN "done" ELSE ev[m]])
  /\ stopped' = [m \in Msgs |-> stopped[m] \/ m \in Claimed]
  /\ stopping' = TRUE
  /\ UNCHANGED <<wake, covered, replies, answered, promise, notes, fails, thought, nudged,
                 lost, worked, floor, presence, restarts, shown, asked, twice, diagnostic, audience,
                 held, ended, sent, voice, nudges, stopPosted, partial, twoRings, early, letGo, trig,
                 plain>>

(* lead/mcp/handlers.ts kin_skip → KinReplyBridge.skip: the agent ends its turn with nothing to
   send, its note kept in its journal only. Accepted when every message the wake-up claimed may go
   unanswered (`quietAllowed`) or already has held text (`hasReplyText`), which still posts at the
   end; then `answered` counts the skip and `complete` asks no rescue. Refused ("someone here is
   waiting on your answer") it changes nothing: the turn goes on, and its reply posts as usual. The
   variant accepts it, and counts it as the answer, for a message owed words. *)
(* On a trigger's slot in a send-voice turn it is always accepted, text held or not: nothing
   posts (`dropText`). After an accepted send it changes nothing. *)
LetsGo(m) == ~covered[m] /\ (~held[m] \/ (TrigMsg(m) /\ voice = "send"))
Skip ==
  /\ wake = "running" /\ ended = "no" /\ ~sent
  /\ \E m \in Claimed : LetsGo(m) /\ ~letGo[m]
  /\ \A m \in Claimed : QuietMsg(m) \/ TrigMsg(m) \/ held[m] \/ covered[m]
                         \/ Broken = "skip-silences"
  /\ letGo' = [m \in Msgs |-> letGo[m] \/ (m \in Claimed /\ LetsGo(m))]
  /\ UNCHANGED <<ev, tries, wake, covered, replies, answered, promise, notes, fails, thought, nudged,
                 lost, worked, floor, presence, restarts, shown, asked, twice, diagnostic, audience,
                 turn, stopped, stopPosted, partial, twoRings, early, trig, plain>>

(* KinReplyBridge.complete → flushReplies, after a completed or failed run: each slot's held
   text, joined, its exact repeats gone, split by kinReplyBubbles (or into parts past 16,000
   characters), posts through one KinLevelGate.postReply: every row, the floor grant, the figures
   and replied_at (`repliedBy`) in one transaction, published after commit. Bubble 1 rings as the
   reply's level says; bubbles 2..N are `silent`. Bubble 1 keeps the slot's key and the rest take
   `~b2`.., so a retried flush finds its rows. A refused bubble rolls the group back
   (ReplyHeldBack after a join). Slots post in order, each its own transaction; the model posts
   them in one step, as nothing else it counts happens between them. *)
Posts(P, mid) ==
  /\ toOld' = (toOld \/ (joined /\ P # {}))
  /\ replies' = [m \in Msgs |-> IF m \in P THEN replies[m] + 1 ELSE replies[m]]
  /\ answered' = [m \in Msgs |-> answered[m] \/ m \in P]
  /\ covered' = [m \in Msgs |-> covered[m] \/ m \in P]
  /\ worked' = (worked \/ P # {})
  /\ stopPosted' = (stopPosted \/ \E m \in P : stopped[m])
  /\ early' = (early \/ (P # {} /\ mid))
  \* The variant posts bubble 1 on its own commit, before the rest of the group.
  /\ partial' = (partial \/ (P # {} /\ Broken = "bubble-first"))
  /\ twoRings' = (twoRings \/ (P # {} /\ Broken = "bubble-two-rings"))
  /\ plain' = (plain \/ \E m \in P : TrigMsg(m) /\ voice = "send")

\* After the join, LevelGate's destination is "moved" (or "aborted"): see ReplyHeldBack.
Postable == IF ~joined \/ Broken = "reply-after-join" THEN Unposted ELSE {}

(* The wake-up's run ends: completed, failed or timed out, and the flush posts what it held; or,
   after a Stop, interrupted, and nothing posts (WakeupRunner: `status`,
   `stopped: status === "interrupted"`). *)
RunEnds ==
  /\ wake = "running" /\ ended = "no"
  /\ IF stopping THEN ended' = "interrupted" /\ Posts({}, FALSE)
     ELSE ended' \in {"completed", "failed"} /\ Posts(Postable, FALSE)
  /\ UNCHANGED <<ev, tries, wake, promise, notes, fails, thought, nudged, lost, floor, presence,
                 restarts, shown, asked, twice, diagnostic, joined, joins, noticed, aborted, moves,
                 heldBack, demoted, held, stopping, sent, voice, nudges, stopped, letGo, trig>>

(* The flush again, for held text RunEnds left: after a resumed restart (only the variant forgets
   what it posted), mid-turn (variant `posts-mid-turn`), or after a Stop (`stop-flushes`). *)
Flush ==
  /\ wake = "running" /\ Postable # {}
  /\ \/ ended \in {"completed", "failed"}
     \/ Broken = "posts-mid-turn" /\ ended = "no"
     \/ Broken = "stop-flushes" /\ ended = "interrupted"
  /\ Posts(Postable, ended = "no")
  /\ UNCHANGED <<ev, tries, wake, promise, notes, fails, thought, nudged, lost, floor, presence,
                 restarts, shown, asked, twice, diagnostic, joined, joins, noticed, aborted, moves,
                 heldBack, demoted, turn, stopped, letGo, trig>>

Owed == {m \in Claimed : ~covered[m]}

(* Every join, in its transaction (chat/KinGroups.ts shareWith → lead/ChatSharing.ts
   onPersonJoined): each ask waiting in the chat, or claimed unanswered by a turn aborted for its
   audience, expires, and stoppedLines gives the chat one line per agent ("didn't reply" / "didn't
   finish its reply"), which tellStopped posts after commit. The model counts that line on each
   expired ask. *)
Expire(exp) ==
  /\ Ev([m \in Msgs |-> IF m \in exp THEN "expired" ELSE ev[m]])
  /\ fails' = [m \in Msgs |-> IF m \in exp /\ Broken # "join-expires-silently" THEN fails[m] + 1
                             ELSE fails[m]]

(* Someone joins the chat while the turn works, and it was not aborted for that
   (Audience.ts abortChatTurns spares the lead's owner and a settled reply): its prompt was built
   for the owner alone, so LevelGate's destination is now "moved" for its every post here. A
   second join needs a fresh turn's owner-only prompt, so a leave in between. What waits in the
   queue expires (`Expire`); the spared turn keeps what it claimed. *)
SomeoneJoins ==
  /\ wake = "running" /\ ~joined /\ joins < 2
  /\ joined' = TRUE /\ joins' = joins + 1
  /\ Expire({m \in Msgs : ev[m] = "queued"})
  /\ UNCHANGED <<wake, covered, replies, answered, promise, notes, thought, nudged,
                 lost, worked, floor, presence, restarts, shown, asked, twice, diagnostic,
                 noticed, aborted, moves, heldBack, toOld, demoted, turn, marks>>

(* Someone joins who is not the lead's owner: abortChatTurns marks the running turn aborted
   (kin_wakeups.aborted_at), so LevelGate's destination is "aborted" for its every post and
   WakeupRunner stops it; with no turn running, nothing is aborted. Every ask waiting, and every
   ask the aborted turn claimed with no replied_at, expires with the line (`Expire`); one it
   already replied to is done, so `finish` requeues nothing for a later turn to answer again. *)
JoinStops ==
  /\ joins < 2 /\ (wake = "idle" \/ ~joined)
  /\ joins' = joins + 1
  /\ LET exp == {m \in Msgs : ev[m] = "queued" \/ (ev[m] = "claimed" /\ ~answered[m])}
     IN /\ Ev([m \in Msgs |-> IF m \in exp THEN "expired"
                                ELSE IF ev[m] = "claimed" THEN "done" ELSE ev[m]])
        /\ fails' = [m \in Msgs |-> IF m \in exp /\ Broken # "join-expires-silently"
                                   THEN fails[m] + 1 ELSE fails[m]]
  /\ IF wake = "running" THEN joined' = TRUE /\ aborted' = TRUE ELSE UNCHANGED <<joined, aborted>>
  /\ UNCHANGED <<wake, covered, replies, answered, promise, notes, thought, nudged,
                 lost, worked, floor, presence, restarts, shown, asked, twice, diagnostic,
                 noticed, moves, heldBack, toOld, demoted, turn, marks>>

(* people/KinPeople.ts setAccess: the asker, a co-owner, is made a member while the turn works.
   For each chat they are in, abortChatTurns marks the running, unsettled turn aborted (it was
   built at the owner's level), so LevelGate's destination is "aborted" for its every post and
   WakeupRunner stops it after commit. Unlike a join, this step ends no ask itself: what the turn
   claimed, replied or not, stays claimed for `finish`, and what waits stays queued. *)
MadeMember ==
  /\ wake = "running" /\ ~aborted /\ ~demoted
  /\ joined' = TRUE /\ aborted' = TRUE /\ demoted' = TRUE
  /\ UNCHANGED <<ev, tries, wake, covered, replies, answered, promise, notes, fails, thought, nudged,
                 lost, worked, floor, presence, restarts, shown, asked, twice, diagnostic, joins,
                 noticed, moves, heldBack, toOld, turn, marks>>

(* reply/KinReplyBridge.ts flushReplies → refusedReply: the held reply is withheld for the join
   (`moved`), first time this wake-up. lead/KinEventQueue.ts requeueForAudience, in one
   transaction: a turn that did nothing visible (DID_VISIBLE_WORK, the model's `worked`) and whose
   claimed events carry no `_audienceMoved` is marked aborted and its events flagged; `finish` then
   hands them to a fresh wake-up. Otherwise the chat hears one line ("didn't reply" / "didn't
   finish its reply"), and in the same transaction KinEventQueue.endLostToJoin marks done the
   turn's claimed asks in the chat with no replied_at, so no failed run, retry or restart answers
   or tells them again. Either way `complete` says nothing more (movedNoticed). An aborted turn
   says nothing here. *)
ReplyHeldBack ==
  /\ wake = "running" /\ ended \in {"completed", "failed"}
  /\ joined /\ ~noticed /\ ~aborted /\ Unposted # {}
  /\ noticed' = TRUE
  /\ IF (~worked \/ Broken = "requeue-after-work")
        /\ (\A m \in Claimed : moves[m] = 0 \/ Broken = "requeue-again")
       THEN /\ aborted' = TRUE
            /\ moves' = [m \in Msgs |-> IF m \in Claimed THEN moves[m] + 1 ELSE moves[m]]
            /\ UNCHANGED <<ev, tries, fails, heldBack>>
       ELSE /\ fails' = [m \in Msgs |-> IF m \in Owed THEN fails[m] + 1 ELSE fails[m]]
            /\ heldBack' = [m \in Msgs |-> heldBack[m] \/ m \in Owed]
            /\ Ev([m \in Msgs |-> IF m \in Claimed /\ ~answered[m] /\ Broken # "line-not-ended"
                                     THEN "done" ELSE ev[m]])
            /\ UNCHANGED <<aborted, moves>>
  /\ UNCHANGED <<wake, covered, replies, answered, promise, notes, thought, nudged, lost,
                 worked, floor, presence, restarts, shown, asked, twice, diagnostic, joined, joins,
                 toOld, demoted, turn, marks>>

(* KinEventQueue.finish, first branch: an aborted wake-up is released, its claimed events with
   replied_at are done and the rest go back to the queue, no attempt spent and nothing posted
   (WakeupRunner.finishWakeup gets no outcome). The flag stays in each event's stored data.
   `aborted-requeues-replied` requeues a replied one too (the code before `cb67994eb4`); so does
   `requeue-after-work`, whose early requeue after a posted reply this step now also undoes. *)
Requeued == [m \in Msgs |-> IF m \in Claimed
                            THEN IF answered[m]
                                    /\ Broken \notin {"aborted-requeues-replied", "requeue-after-work"}
                                 THEN "done" ELSE "queued"
                            ELSE ev[m]]

Ended == [m \in Msgs |-> IF m \in Claimed THEN "done" ELSE ev[m]]

\* The flush is done: every held slot posted, or was withheld for the join and handled.
Flushed == Unposted = {} \/ (joined /\ (noticed \/ aborted))

(* KinReplyBridge.complete, after the flush, for a completed run: a message still owed words gets
   one turn asking for them (RESCUE_PROMPT, or CAPTION_PROMPT for one that only got a chart or
   file), whose text posts the same way, then "{Lead} didn't reply." when none came, except under
   a chart or file, which stands. One an accepted kin_skip let go is owed nothing (`answered`
   reads the skip). Events done (KinEventQueue.finish). settleLine clears the line. The variant
   ends without asking. *)
Due == {m \in Owed : ~letGo[m] /\ ~TrigMsg(m)}

(* KinReplyBridge.complete, a send-voice turn that ended with text after its last tool, no send and
   no kin_skip: one queued follow-up in the same thread (`rescue(…, "nudge")`, NUDGE_PROMPT), whose
   adopted run (`nudgeMessageId`, KinIdentity.isAdoptedRunMessage) may send, skip or write again;
   whatever follows stands. Only a completed run, never an empty ending, never once a person's act
   joined the turn. A recovered nudge run is recognized (`settle` → `nudged`), not sent again. The
   variant asks again after the first. *)
NudgeDue ==
  /\ voice = "send" /\ ~sent /\ ~stopping /\ ~aborted /\ ~noticed
  /\ nudges < (IF Broken = "nudge-loops" THEN 2 ELSE 1)
  /\ Claimed # {} /\ \A m \in Claimed : TrigMsg(m)
  /\ \E m \in Claimed : held[m] /\ ~covered[m] /\ ~letGo[m]
Nudge ==
  /\ wake = "running" /\ ended = "completed" /\ Flushed /\ NudgeDue
  /\ ended' = "no" /\ nudges' = nudges + 1
  /\ UNCHANGED <<ev, tries, wake, covered, replies, answered, promise, notes, fails, thought, nudged,
                 lost, worked, floor, presence, restarts, shown, asked, twice, diagnostic, audience,
                 held, stopping, sent, voice, marks>>

RunCompletes ==
  /\ wake = "running" /\ ended = "completed" /\ Flushed /\ ~NudgeDue
  /\ IF noticed \/ aborted
       \* A held-back reply, or a turn aborted for its audience (WakeupRunner skips `complete`
       \* for it, and its every post goes nowhere): no rescue, no other line.
       THEN /\ Ev(IF aborted THEN Requeued ELSE Ended)
            /\ UNCHANGED <<asked, replies, answered, fails>>
       ELSE /\ asked' = [m \in Msgs |-> asked[m] \/ (m \in Due /\ Broken # "no-rescue")]
            /\ \/ /\ replies' = [m \in Msgs |-> IF m \in Due THEN replies[m] + 1 ELSE replies[m]]
                  /\ answered' = [m \in Msgs |-> answered[m] \/ m \in Due]
                  /\ UNCHANGED fails
               \/ /\ fails' = [m \in Msgs |-> IF m \in Due /\ ~shown[m] THEN fails[m] + 1 ELSE fails[m]]
                  /\ UNCHANGED <<replies, answered>>
            /\ Ev(Ended)
  /\ wake' = "idle"
  /\ presence' = IF Broken = "line-stays" THEN presence ELSE "off"
  /\ TurnOver
  /\ UNCHANGED <<notes, thought, nudged, lost, floor, restarts, shown, twice, diagnostic, lasting,
                 marks>>

(* WakeupRunner.finishWakeup after a failed or timed-out run, once the flush posted what it held
   (`rescue: false`, so no rescue): something visible → each message with its reply posted is
   done, the others failed with "{Lead} stopped partway." (KinEventQueue.finish `stranded` /
   `replied`). With every message replied, a line follows only for what the reply promised and
   the turn left undone (KinReplyBridge.failed "replied": missingCard, unkeptPromise); otherwise it
   is only logged. Nothing visible → retried with "trying again" (not final), and the fourth try
   fails with "won't try again on its own." An aborted wake-up goes back to the queue first, as in
   RunCompletes. *)
RunFails ==
  /\ wake = "running" /\ ended = "failed" /\ Flushed
  /\ IF aborted
       THEN /\ Ev(Requeued)
            /\ UNCHANGED <<fails, notes>>
     ELSE IF worked
       THEN LET mark(m) == answered[m] /\ Broken # "partway-after-reply"
                stranded == {m \in Claimed : ~mark(m)}
            IN /\ Ev([m \in Msgs |-> IF m \in Claimed THEN IF mark(m) THEN "done" ELSE "failed"
                                         ELSE ev[m]])
               /\ fails' = [m \in Msgs |-> IF m \in stranded THEN fails[m] + 1 ELSE fails[m]]
               /\ notes' = [m \in Msgs |-> IF stranded = {} /\ m \in Claimed /\ promise = "open"
                                           THEN notes[m] + 1 ELSE notes[m]]
       ELSE /\ ev' = [m \in Msgs |-> IF m \in Claimed
                                     THEN IF tries[m] + 1 >= StartAttempts THEN "failed" ELSE "queued"
                                     ELSE ev[m]]
            \* The try is counted; an event that failed for good is settled, as in `Ev`.
            /\ tries' = [m \in Msgs |-> IF m \in Claimed
                                        THEN IF tries[m] + 1 >= StartAttempts THEN 0 ELSE tries[m] + 1
                                        ELSE tries[m]]
            /\ fails' = [m \in Msgs |-> IF m \in Claimed /\ tries[m] + 1 >= StartAttempts
                                        THEN fails[m] + 1 ELSE fails[m]]
            /\ UNCHANGED notes
  /\ wake' = "idle"
  /\ presence' = IF Broken = "line-stays" THEN presence ELSE "off"
  /\ TurnOver
  /\ UNCHANGED <<replies, answered, thought, nudged, lost, floor, restarts, shown, asked, twice,
                 diagnostic, lasting, marks>>

(* The run a person stopped ends interrupted: complete(stopped) journals each held slot "Not sent"
   and drops it, before any page, figure, promise, rescue or follow-up; `finish` marks what is
   still claimed done (`interrupted`), never retried or told as failed. The variant posts instead
   (Flush). An aborted wake-up skips `complete` and goes back to the queue, as in RunCompletes. *)
RunStopped ==
  /\ wake = "running" /\ ended = "interrupted"
  /\ Broken = "stop-flushes" => Flushed
  /\ Ev(IF aborted THEN Requeued ELSE Ended)
  /\ wake' = "idle"
  /\ presence' = IF Broken = "line-stays" THEN presence ELSE "off"
  /\ TurnOver
  /\ UNCHANGED <<replies, answered, notes, fails, thought, nudged, lost, floor, restarts, shown,
                 asked, twice, diagnostic, lasting, marks>>

(* Kin shuts down mid-turn. Run gone: WakeupRunner.cleanup(interrupted) →
   KinEventQueue.requeueUnfinished marks done the claimed events whose reply posted (replied_at)
   and puts the rest back; the line and the held text live in memory and are gone. Run still in
   the thread: start-up recovery begins the bridge again and waits on it (WakeupRunner recovery,
   `bridge.begin`, `wait`); `settle` rebuilds the held text from the projection, and the flush
   posts no group twice: `saidBodies` drops what this wake-up stored and a re-sent key returns
   its stored row (`findClientMessage`). The variant re-posts. Resuming before the run ended is
   the same turn going on, so the model resumes only after it. A send's receipt is stored with it,
   so a resumed wake-up after a send still holds it (`sentThrough`). *)
Restart ==
  /\ restarts < 1 /\ wake = "running"
  /\ restarts' = restarts + 1
  /\ \/ /\ Ev([m \in Msgs |-> IF m \in Claimed
                                 THEN IF answered[m] /\ Broken # "requeue-replied" THEN "done"
                                      ELSE "queued"
                                 ELSE ev[m]])
        /\ wake' = "idle" /\ presence' = "off"
        /\ TurnOver
     \/ /\ ended # "no"
        \* The receipt is read back (`storedSend`); the variant forgets it, so the flush posts the
        \* text held beside the send.
        /\ covered' = IF Broken = "requeue-reposts" \/ (Broken = "send-forgotten-on-restart" /\ sent)
                      THEN [m \in Msgs |-> FALSE] ELSE covered
        /\ sent' = (sent /\ Broken # "send-forgotten-on-restart")
        /\ UNCHANGED <<ev, tries, wake, presence, held, ended, stopping, voice, nudges, worked, promise,
                       joined, noticed, aborted>>
  /\ UNCHANGED <<replies, answered, notes, fails, thought, nudged, lost, floor, shown, asked, twice,
                 diagnostic, lasting, marks>>

Next ==
  \/ \E m \in Msgs : PersonSends(m) \/ TriggerFires(m) \/ Steer(m)
  \/ Claim \/ LeadWrites \/ LeadSends \/ LeadRepeats \/ LeadShows \/ LeadKeepsPromise \/ LeadThinks
  \/ LeadNudgesAsker \/ LeadWorks \/ TerminalDiagnostic
  \/ FloorCloses \/ SomeoneJoins \/ JoinStops \/ MadeMember \/ PersonStops
  \/ Skip \/ RunEnds \/ Flush \/ ReplyHeldBack
  \/ Nudge \/ RunCompletes \/ RunFails \/ RunStopped \/ Restart

Fair == WF_vars(Claim) /\ WF_vars(RunEnds) /\ WF_vars(Flush) /\ WF_vars(ReplyHeldBack)
        /\ WF_vars(Nudge)
        /\ WF_vars(RunCompletes \/ RunFails \/ RunStopped)

Spec == Init /\ [][Next]_vars /\ Fair

------------------------------------------------------------------------------------------------
\* One reply group or one plain line per message: a group of bubbles counts once.
NeverTwo == \A m \in Msgs : replies[m] + fails[m] <= 1
\* The one exception to a single answer: a short line naming what the reply promised and a later
\* failure left undone, at most once, and only after a reply.
NoteOnlyForBrokenPromise == \A m \in Msgs : notes[m] <= 1 /\ (notes[m] = 1 => replies[m] = 1)
NeverReasoning == ~thought
NeverDiagnostic == ~diagnostic
\* The reply says its answer once, even when the lead writes it again after a tool call.
SaidOnce == ~twice
RelayLands == ~lost
\* A turn that ended without the words a message waited for asked the lead for them once: a
\* thinking-only end, and a chart or file with no line beside it.
\* A reply Kin held back for a join is told so in the chat instead (`heldBack`), a message
\* its person stopped wanted nothing more (`stopped`), and one that needed no answer was let go.
LetGoQuietly(m) == letGo[m] /\ QuietMsg(m)
AskedBeforeSilence ==
  \A m \in Msgs : (ev[m] = "done" /\ ~answered[m] /\ ~heldBack[m] /\ ~stopped[m]
                   /\ ~LetGoQuietly(m) /\ ~TrigMsg(m)) => asked[m]
\* A message whose reply a join held back moves to a fresh wake-up at most once.
MovedOnce == \A m \in Msgs : moves[m] <= 1
\* Nothing posts to the chat a private prompt was built for once someone else can read it.
NeverToOldAudience == ~toOld
\* Reply text posts only once the run has ended; a send is the agent's own message and posts then.
HeldToTheEnd == ~early
\* A reply group shows whole or not at all, whatever restarts.
AllOrNone == ~partial
\* After a person's Stop, nothing that run held for their message ever posts.
StopPostsNothing == ~stopPosted
\* A reply group rings (push, unread) at most once: bubble 1, or none for a quiet one.
OneRing == ~twoRings
\* A chart or file asked for its line stands as the answer when none comes; a message its
\* person stopped ends with their own Stop; a reaction or another agent's answer that needed no
\* answer ends with the agent's kin_skip, and nothing else may.
EveryMessageAnswered ==
  \A m \in Msgs : ev[m] # "none" ~> (replies[m] + fails[m] >= 1 \/ (shown[m] /\ asked[m])
                                     \/ stopped[m] \/ (ev[m] = "done" /\ LetGoQuietly(m))
                                     \/ (ev[m] \in {"done", "failed"} /\ TrigMsg(m)))
\* A turn a trigger started speaks only through kin_send: its plain text never posts.
TriggerOnlySends == ~plain
\* A send-voice turn that wrote and didn't send is asked once, and never again.
NudgeOnce == nudges <= 1
LineClears == presence = "on" ~> presence = "off"
=============================================================================
