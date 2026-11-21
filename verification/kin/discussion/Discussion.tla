---------------------------- MODULE Discussion ----------------------------
(* The Team room. First, around any one discussion: agents opening discussions against their caps,
   who may read the room as people are promoted and demoted, and a hand-off reporting back. Then
   one discussion between four agents: O opened it, D's call it is, C chairs (the Chief of staff),
   X has a stake and may pitch in uninvited. An agent opens it, for the owner or on its own, or
   the owner's Team-room message naming O and one more agent opens it with no turn spent. Each action names the code it stands for (paths under
   apps/server/src/kin). One action is one transaction. *)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS Broken, MaxMsgs, ChairAt, AfterObj, PerDay, AtOnce

Agents == {"O", "D", "C", "X"}
Touchable == {"O", "X"}
NoTurn == [who |-> "none", kind |-> "none"]
Turn(w, k) == [who |-> w, kind |-> k]

VARIABLES
  stage,                       \* "setup" (caps, readers, hand-off), then "talk" (one discussion)
  openNow, started,            \* agent-started discussions open now, and started today
  access, room, leak, changes, \* the viewer rule: who is owner-level, who the room lists, a teammate read it
  hs, reports,                 \* a hand-off: none, passed, claimed, replied, done; replies carried back
  asks, opened, plain,         \* the owner's naming message handled; discussions it opened; plain replies
  phase, final, turn, pending, msgs, widened, objUsed, afterObj, last, offers, chaired,
  turnMsgs, pitches, objections, origin, told, checkIns,
  beside                       \* discussions opened for the same ask beside the one Kin opened

side == <<openNow, started, access, room, leak, changes, hs, reports, asks, opened, plain>>
talk == <<phase, final, turn, pending, msgs, widened, objUsed, afterObj, last, offers,
          chaired, turnMsgs, pitches, objections, origin, told, checkIns, beside>>
vars == <<stage, side, talk>>

TalkInit ==
  /\ phase = "open" /\ final = FALSE /\ turn = Turn("O", "named")
  /\ msgs = 0 /\ widened = FALSE /\ objUsed = FALSE /\ afterObj = -1 /\ last = "none"
  /\ offers = [a \in Touchable |-> 0] /\ chaired = FALSE /\ turnMsgs = 0
  /\ pitches = 0 /\ objections = 0 /\ origin \in {"owner", "agent", "person"} /\ told = 0 /\ checkIns = 0
  /\ beside = 0
  \* team/turns.ts askedByPerson: O, named first, holds the first turn; the other named is asked next.
  /\ pending \in IF origin = "person" THEN {<<Turn(a, "named")>> : a \in {"D", "C"}} ELSE {<<>>}

SideInit ==
  /\ openNow = 0 /\ started = 0
  /\ access = [p \in {"co", "mem"} |-> IF p = "co" THEN "co_owner" ELSE "member"]
  /\ room = {"co"} /\ leak = FALSE /\ changes = 0
  /\ hs = "none" /\ reports = 0 /\ asks = 0 /\ opened = 0 /\ plain = 0

Init == stage = "setup" /\ SideInit /\ TalkInit

------------------------------------------------------------------------------------------------
(* team/turns.ts openRefusal, read by KinTeam.open with today's agent-started counts: the
   owner's own ask always opens; an agent's waits when 6 started today or 2 are open. *)
AgentOpens ==
  /\ stage = "setup" /\ started < PerDay + 2
  /\ Broken = "no-open-cap" \/ (started < PerDay /\ openNow < AtOnce)
  /\ openNow' = openNow + 1 /\ started' = started + 1
  /\ UNCHANGED <<stage, access, room, leak, changes, hs, reports, asks, opened, plain, talk>>

AgentDiscussionEnds ==
  /\ stage = "setup" /\ openNow > 0
  /\ openNow' = openNow - 1
  /\ UNCHANGED <<stage, started, access, room, leak, changes, hs, reports, asks, opened, plain, talk>>

(* The owner's day starts over (startOfDay in the owner's zone). *)
NewDay ==
  /\ stage = "setup" /\ started > 0
  /\ started' = 0
  /\ UNCHANGED <<stage, openNow, access, room, leak, changes, hs, reports, asks, opened, plain, talk>>

(* people/KinPeople.ts: the owner makes someone a co-owner or takes it away. The membership row
   stays: KinChatService.memberFor's viewer rule (roomReadable) is what keeps a teammate out. *)
SetAccess(p) ==
  /\ stage = "setup" /\ changes < 3
  /\ access' = [access EXCEPT ![p] = IF @ = "co_owner" THEN "member" ELSE "co_owner"]
  /\ changes' = changes + 1
  /\ UNCHANGED <<stage, openNow, started, room, leak, hs, reports, asks, opened, plain, talk>>

(* KinTeam.ensureRoom from the sweep: co-owners join, muted. *)
RoomSweep ==
  /\ stage = "setup"
  /\ room' = room \cup {p \in {"co", "mem"} : access[p] = "co_owner"}
  /\ room' # room
  /\ UNCHANGED <<stage, openNow, started, access, leak, changes, hs, reports, asks, opened, plain, talk>>

(* KinGroups.addMember refuses the Team room: Kin keeps its members. Were it to let a teammate
   in, the viewer rule below still keeps them out, so the model lets the owner try freely. *)
OwnerAdds(p) ==
  /\ stage = "setup" /\ p \notin room
  /\ room' = room \cup {p}
  /\ UNCHANGED <<stage, openNow, started, access, leak, changes, hs, reports, asks, opened, plain, talk>>

(* KinChatService history, read, the Chats list and its live rows all go through memberFor:
   a member of the room who is owner-level now. *)
Reads(p) ==
  /\ stage = "setup" /\ p \in room
  /\ access[p] = "co_owner" \/ Broken = "membership-only"
  /\ leak' = (leak \/ access[p] # "co_owner")
  /\ UNCHANGED <<stage, openNow, started, access, room, changes, hs, reports, asks, opened, plain, talk>>

(* lead/Handoff.ts handOff: the request goes to the other agent's chat, sent by the asker. *)
HandOff ==
  /\ stage = "setup" /\ hs = "none"
  /\ hs' = "passed"
  /\ UNCHANGED <<stage, openNow, started, access, room, leak, changes, reports, asks, opened, plain, talk>>

(* KinEventQueue claim: the receiver's wake-up takes the passed event. *)
ReceiverWakes ==
  /\ stage = "setup" /\ hs = "passed"
  /\ hs' = "claimed"
  /\ UNCHANGED <<stage, openNow, started, access, room, leak, changes, reports, asks, opened, plain, talk>>

(* Its answer in its own chat; an owed lane's silence gets the rescue, so it answers here. *)
ReceiverAnswers ==
  /\ stage = "setup" /\ hs = "claimed"
  /\ hs' = "replied"
  /\ UNCHANGED <<stage, openNow, started, access, room, leak, changes, reports, asks, opened, plain, talk>>

(* A wake-up that fails puts its events back (KinEventQueue requeue): another takes it. *)
ReceiverFails ==
  /\ stage = "setup" /\ hs = "claimed"
  /\ hs' = "passed"
  /\ UNCHANGED <<stage, openNow, started, access, room, leak, changes, reports, asks, opened, plain, talk>>

(* WakeupRunner.finishWakeup calls Handoff.reportBack: the last answer goes back to the asker's
   chat, shown as from the receiver, and wakes the asker, claimed by reply_message_id. It may
   run again for the same wake-up (a retry); the claim keeps it to once. *)
ReceiverEnds ==
  /\ stage = "setup" /\ hs \in {"replied", "done"}
  /\ Broken # "no-report-back"
  /\ reports < 2
  /\ \/ /\ hs = "replied"
        /\ hs' = "done" /\ reports' = reports + 1
     \/ /\ hs = "done" /\ Broken = "report-unclaimed"
        /\ hs' = "done" /\ reports' = reports + 1
  /\ UNCHANGED <<stage, openNow, started, access, room, leak, changes, asks, opened, plain, talk>>

(* lead/ChatWake.ts wake, live or again from its catch-up after a restart, hands the owner's
   Team-room message naming two agents to KinTeam.personAsked. Keyed by the message id, it opens
   their discussion once and nobody answers it as a plain reply; while another discussion is
   open it stays an ordinary message, which the room's agent answers as before, and once
   answered so it never opens one later. *)
AskHandled ==
  /\ stage = "setup" /\ origin = "person" /\ asks < 2
  /\ asks' = asks + 1
  \* A plain reply is ChatWake's event keyed by the message and agent: queued once at most.
  /\ CASE opened > 0 /\ Broken # "ask-unkeyed" -> UNCHANGED <<opened, plain>>
       [] plain > 0 /\ Broken # "plain-forgotten" -> UNCHANGED <<opened, plain>>
       [] openNow > 0 \/ opened > 0 -> plain' = 1 /\ UNCHANGED opened
       [] OTHER -> /\ opened' = opened + 1
                   /\ plain' = (IF Broken = "answerer-woken" THEN 1 ELSE plain)
  /\ UNCHANGED <<stage, openNow, started, access, room, leak, changes, hs, reports, talk>>

(* The discussion this model follows opens: by an agent for the owner or on its own (origin), or
   by the owner's message naming its agents once it opened one. *)
StartTalk ==
  /\ stage = "setup" /\ hs \in {"none", "done"}
  /\ origin = "person" => opened > 0
  /\ stage' = "talk"
  \* What came before no longer matters to the discussion: the checks on it ran there.
  /\ openNow' = 0 /\ started' = 0 /\ access' = [p \in {"co", "mem"} |-> IF p = "co" THEN "co_owner" ELSE "member"]
  /\ room' = {"co"} /\ leak' = FALSE /\ changes' = 0 /\ hs' = "none" /\ reports' = 0
  /\ asks' = 0 /\ opened' = 0 /\ plain' = 0
  /\ UNCHANGED talk

------------------------------------------------------------------------------------------------
(* team/turns.ts sayRefusal: whose turn, what a closing or objection turn must say, widening
   once, and who decides, parks and brings it to the owner. *)
Allowed(who, intent, widen, end) ==
  /\ ~final /\ turn.who = who
  /\ turn.kind = "closing" => end # "none"
  /\ turn.kind = "object" => (intent = "objection" /\ (end = "none" \/ Broken = "object-decides"))
  /\ widen => (~widened /\ who \in {"D", "C"})
  /\ end = "decide" => who \in {"D", "C"}
  /\ end = "park" => (who = "C" \/ turn.kind = "closing")
  /\ end = "bring" => who = "C"

Closing == [phase |-> "closing", turn |-> Turn("C", "closing"), pending |-> <<>>]

Dedupe(s, who) ==
  LET f[i \in 0..Len(s)] ==
        IF i = 0 THEN <<>>
        ELSE LET acc == f[i - 1] IN
             IF s[i].who = who \/ \E j \in 1..Len(acc) : acc[j].who = s[i].who
               THEN acc ELSE Append(acc, s[i])
  IN f[Len(s)]

Carried == SelectSeq(pending, LAMBDA t : t.kind \in {"named", "decider"})

(* turns.ts answerer: a message naming nobody goes to the decider; the decider's own to whoever
   spoke before it, else the chair. *)
Answerer(who) == IF who # "D" THEN "D" ELSE IF last # "none" /\ last # who THEN last
                 ELSE IF "C" # who THEN "C" ELSE "none"

(* turns.ts nextTurns, after msgs counts this message: a chair check once at ChairAt; at most one
   uninvited agent the message touches, right after it; then who it asks; then turns still owed. *)
Next1(who, to, touches, n) ==
  LET asked == IF to # "none" /\ to # who THEN <<Turn(to, "named")>>
               ELSE LET a == Answerer(who) IN
                    IF a = "none" THEN <<>>
                    ELSE <<Turn(a, IF a = "D" THEN "decider" ELSE "named")>>
      askedWho == {asked[i].who : i \in 1..Len(asked)}
      can(a) == a # who /\ a # "C" /\ a \notin askedWho /\ a \notin {who, last} /\ offers[a] < 2
      pitchers == {a \in touches : can(a)}
      \* stakes come strongest first; with two, X (the entity match) leads
      first == IF "X" \in pitchers THEN "X" ELSE "O"
      pitch == IF pitchers = {} THEN <<>>
               ELSE IF Broken = "all-pitch" THEN [i \in 1..Cardinality(pitchers) |->
                      Turn(IF i = 1 THEN first ELSE CHOOSE a \in pitchers : a # first, "pitch_in")]
               ELSE <<Turn(first, "pitch_in")>>
      chair == IF ~chaired /\ n >= ChairAt /\ who # "C" THEN <<Turn("C", "chair")>> ELSE <<>>
      all == Dedupe(chair \o pitch \o asked \o Carried, who)
  IN [turns |-> all, chair |-> chair # <<>>,
      offers |-> [a \in Touchable |-> offers[a] + (IF \E i \in 1..Len(pitch) : pitch[i].who = a
                                                     THEN 1 ELSE 0)],
      pitches |-> Len(SelectSeq(all, LAMBDA t : t.kind = "pitch_in"))]

\* What becomes final tells the owner at once when he asked for it (or named its agents), or by its card when brought
\* to him (KinTeam.tell, claimed by told_at); an agent's own waits for his next check-in.
TellNow(f, ph) ==
  told' = IF f /\ (origin \in {"owner", "person"} \/ ph = "escalated") /\ (told = 0 \/ Broken = "told-unclaimed")
            THEN told + 1 ELSE told

Settle(ph, f, t, p, tm) ==
  /\ phase' = ph /\ final' = f /\ turn' = t /\ pending' = p /\ turnMsgs' = tm
  /\ TellNow(f, ph)

(* KinTeam.say: team_say from the agent whose turn it is; turns.ts afterSay. *)
Say(who, intent, to, widen, end, touches) ==
  /\ stage = "talk" /\ Allowed(who, intent, widen, end)
  /\ msgs' = msgs + 1 /\ last' = who /\ widened' = (widened \/ widen)
  /\ objections' = objections + (IF turn.kind = "object" THEN 1 ELSE 0)
  /\ LET n == msgs + 1
         wasClosing == turn.kind = "closing"
         objector == IF \E a \in touches : a # who /\ a # "C" THEN CHOOSE a \in touches : a # who /\ a # "C"
                     ELSE IF last # "none" /\ last # who /\ last # "C" THEN last
                     ELSE IF "O" # who THEN "O" ELSE "none"
         kept == Broken = "turn-kept"
     IN
     CASE end = "park" ->
            /\ Settle("parked", TRUE, NoTurn, <<>>, 0)
            /\ UNCHANGED <<objUsed, afterObj, offers, chaired, pitches>>
       [] end = "bring" ->
            /\ Settle("escalated", TRUE, NoTurn, <<>>, 0)
            /\ UNCHANGED <<objUsed, afterObj, offers, chaired, pitches>>
       [] end = "decide" /\ (wasClosing \/ objUsed \/ objector = "none"
                             \/ (n >= MaxMsgs /\ Broken # "objection-past-cap")) ->
            /\ Settle("decided", TRUE, NoTurn, <<>>, 0)
            /\ UNCHANGED <<objUsed, afterObj, offers, chaired, pitches>>
       [] end = "decide" ->
            /\ Settle("decided", FALSE, Turn(objector, "object"), <<>>, 0)
            /\ pitches' = 0
            /\ UNCHANGED <<objUsed, afterObj, offers, chaired>>
       [] turn.kind = "object" ->
            /\ objUsed' = TRUE /\ afterObj' = AfterObj
            /\ IF n >= MaxMsgs /\ Broken # "no-message-cap"
                 THEN /\ Settle("closing", FALSE, Closing.turn, <<>>, 0)
                      /\ UNCHANGED <<offers, chaired>> /\ pitches' = 0
                 ELSE LET r == Next1(who, IF to = "none" THEN "D" ELSE to, touches, n) IN
                      /\ offers' = r.offers /\ chaired' = (chaired \/ r.chair) /\ pitches' = r.pitches
                      /\ IF r.turns = <<>>
                           THEN Settle("closing", FALSE, Closing.turn, <<>>, 0)
                           ELSE Settle("open", FALSE, Head(r.turns), Tail(r.turns), 0)
       [] OTHER ->
            LET left == IF afterObj = -1 THEN -1 ELSE afterObj - 1 IN
            /\ afterObj' = left /\ UNCHANGED objUsed
            /\ IF (left # -1 /\ left <= 0) \/ (n >= MaxMsgs /\ Broken # "no-message-cap")
                 THEN /\ Settle("closing", FALSE, Closing.turn, <<>>, 0)
                      /\ UNCHANGED <<offers, chaired>> /\ pitches' = 0
                 ELSE LET r == Next1(who, to, touches, n) IN
                      /\ offers' = r.offers /\ chaired' = (chaired \/ r.chair) /\ pitches' = r.pitches
                      /\ IF r.turns = <<>>
                           THEN Settle("closing", FALSE, Closing.turn, <<>>, 0)
                           ELSE IF kept
                             \* KinTeam.settle reusing the stored turn when said was ignored
                             THEN Settle(phase, FALSE, turn, Tail(r.turns), turnMsgs + 1)
                             ELSE Settle(phase, FALSE, Head(r.turns), Tail(r.turns), 0)
  /\ UNCHANGED <<stage, side, origin, checkIns, beside>>

(* KinTeam.wakeupEnded: the turn's wake-up ended without team_say, or the sweep found its event
   expired or failed. turns.ts afterPass. *)
Pass ==
  /\ stage = "talk" /\ ~final
  /\ CASE turn.kind = "closing" -> Settle("parked", TRUE, NoTurn, <<>>, 0)
       [] turn.kind = "object" -> Settle("decided", TRUE, NoTurn, <<>>, 0)
       [] pending = <<>> -> Settle("closing", FALSE, Closing.turn, <<>>, 0)
       [] OTHER -> Settle(phase, FALSE, Head(pending), Tail(pending), 0)
  /\ pitches' = 0
  /\ UNCHANGED <<stage, side, msgs, widened, objUsed, afterObj, last, offers, chaired,
                 objections, origin, checkIns, beside>>

(* KinTeam.wakeupEnded charges a wake-up's units (turns.ts afterUnits), and KinTeam.sweep closes
   a discussion a day idle (afterIdle): only the closing turn is left; an idle close parks it. *)
Cut ==
  /\ stage = "talk" /\ ~final /\ phase # "closing"
  /\ Settle("closing", FALSE, Closing.turn, <<>>, 0)
  /\ pitches' = 0
  /\ UNCHANGED <<stage, side, msgs, widened, objUsed, afterObj, last, offers, chaired,
                 objections, origin, checkIns, beside>>

IdleClose ==
  /\ stage = "talk" /\ ~final /\ phase = "closing"
  /\ Settle("parked", TRUE, NoTurn, <<>>, 0)
  /\ pitches' = 0
  /\ UNCHANGED <<stage, side, msgs, widened, objUsed, afterObj, last, offers, chaired,
                 objections, origin, checkIns, beside>>

(* WakeupRunner.finishWakeup after a check-in: KinTeam.deliverHeld tells what agents settled
   on their own, once each, claimed by told_at. *)
Delivers ==
  /\ final /\ origin = "agent"
  /\ (told = 0 \/ Broken = "told-unclaimed") /\ Broken # "held-forever"
CheckInRuns ==
  /\ stage = "talk" /\ checkIns < 2 /\ Delivers
  /\ checkIns' = checkIns + 1 /\ told' = told + 1
  /\ UNCHANGED <<stage, side, phase, final, turn, pending, msgs, widened, objUsed, afterObj, last,
                 offers, chaired, turnMsgs, pitches, objections, origin, beside>>

(* KinTeam.open from the agent whose turn it is in a discussion a person's message opened
   (open_key message:…), its rules saying such an ask starts with team_open: refused, naming that
   discussion and team_say, so nothing changes. The variant opens a second for the same ask. *)
OpensBeside ==
  /\ stage = "talk" /\ origin = "person" /\ ~final /\ turn.who # "none"
  /\ Broken = "open-beside" /\ beside = 0
  /\ beside' = 1
  /\ UNCHANGED <<stage, side, phase, final, turn, pending, msgs, widened, objUsed, afterObj, last,
                 offers, chaired, turnMsgs, pitches, objections, origin, told, checkIns>>

Move ==
  \/ \E who \in Agents, intent \in {"plain", "objection"}, to \in Agents \cup {"none"},
        widen \in BOOLEAN, end \in {"none", "decide", "park", "bring"}, touches \in SUBSET Touchable :
       Say(who, intent, to, widen, end, touches)
  \/ Pass

Next ==
  \/ AgentOpens \/ AgentDiscussionEnds \/ NewDay \/ RoomSweep \/ HandOff \/ ReceiverWakes
  \/ ReceiverAnswers \/ ReceiverFails \/ ReceiverEnds \/ AskHandled \/ StartTalk
  \/ \E p \in {"co", "mem"} : SetAccess(p) \/ OwnerAdds(p) \/ Reads(p)
  \/ Move \/ Cut \/ IdleClose \/ CheckInRuns \/ OpensBeside

Fair ==
  /\ WF_vars(ReceiverEnds) /\ WF_vars(ReceiverWakes) /\ SF_vars(ReceiverAnswers)
  /\ WF_vars(Move) /\ WF_vars(IdleClose) /\ WF_vars(CheckInRuns)

Spec == Init /\ [][Next]_vars /\ Fair

------------------------------------------------------------------------------------------------
Bounded == msgs <= MaxMsgs + 2 /\ started <= PerDay + 2 /\ turnMsgs <= 2 /\ plain <= 2

EndsWithinCaps == msgs <= MaxMsgs + 1
OpenCaps == openNow <= AtOnce /\ started <= PerDay
OneMessagePerTurn == turnMsgs <= 1
OnePitchPerMessage == pitches <= 1
OneObjection == objections <= 1
TeammateNeverReads == ~leak
ToldOnce == told <= 1
ReportOnce == reports <= 1
\* Once Kin's own discussion for the ask is the one followed, none opens beside it.
AskAnsweredOnce == opened + plain <= 1 /\ beside = 0
AlwaysEnds == stage = "talk" ~> (final /\ phase \in {"decided", "parked", "escalated"})
OwnerTold == final ~> told = 1
AskerGetsReply == hs = "replied" ~> reports = 1
=============================================================================
