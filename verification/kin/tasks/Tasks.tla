---------------------------- MODULE Tasks ----------------------------
(* One task's life between the owner, two teammates (Ana and Ben) and a lead agent: given, taken on
   by starting, handed back with a note, given again, taken back, its late alert held, marked done
   and reopened, made private, moved into a project Ben is on. Each action names the code it
   stands for (paths under apps/server/src/kin). One action is one transaction. *)
EXTENDS Naturals, FiniteSets

CONSTANTS Broken

People == {"owner", "ana", "ben"}
Members == {"ana", "ben"}
Everyone == People \cup {"agent"}

VARIABLES
  holder,    \* kin_records.owner: exactly one principal
  byAgent,   \* assigned_by_agent_id: the agent gave it on its own (cleared by a hand-back)
  byPerson,  \* assigned_by_person_id: who asked for it to be given, or "none"
  asked,     \* who asked the agent for the last hand-off it made, "none" when no one did
  state,     \* open, doing, done
  private,   \* sensitive: the owner's private label (made private never goes back, by design)
  inProject, \* filed under the project Ben is a member of
  alert,     \* the pulse's late fact: none, raised, held
  bounced,   \* who handed it back since the last change on it, as notBouncedBack reads it
  backs,     \* who really handed it back since the last change on it
  handedBack, \* handed_back_id: who handed it back, shown on the row until it moves on, or "none"
  pingpong,  \* the agent gave it back to someone who handed it back, nothing changed, unasked
  told,      \* notices the receiver of the last hand-off got
  owed,      \* the last hand-off's receiver is someone other than whoever moved it
  helper,    \* one teammate also on the task, distinct from its holder
  moves, edits

vars == <<handedBack, backs, holder, byAgent, byPerson, asked, state, private, inProject, alert, bounced, pingpong,
          told, owed, moves, edits, helper>>

(* work/teamView.ts personSees, for a teammate: a task they hold; unlabelled, one they made or
   gave; a task they are also on; unlabelled, one in a project they are on. The owner and co-owners see every task. *)
Sees(p) ==
  \/ p = "owner"
  \/ holder = p /\ ~(Broken = "hold-hides" /\ alert = "held")
  \/ helper = p /\ Broken # "helper-cannot-see"
  \/ (~private \/ Broken = "giver-sees-private") /\ byPerson = p
  \/ ~private /\ inProject /\ p = "ben"

Init ==
  /\ holder = "owner" /\ byAgent = FALSE /\ byPerson = "none" /\ asked = "none" /\ state = "open"
  /\ private = FALSE /\ inProject = FALSE /\ alert = "none" /\ bounced = {} /\ backs = {}
  /\ handedBack = "none" /\ helper = "none"
  /\ pingpong = FALSE /\ told = 0 /\ owed = FALSE /\ moves = 0 /\ edits = 0

\* Each hand-off tells its receiver once: a person by the agent's line (assignNotices.ts
\* tellPeople) or, moved by a person, one banner (tellOnTasks); an agent by a wake-up.
Tell(to, actor, n) == /\ owed' = (to # actor) /\ told' = IF to # actor THEN n ELSE 0

(* KinRecords.update with an owner patch. The owner on his screen (ownerWork.ts assign; "take
   back" is to: null, to himself), a teammate giving a task they hold, or the lead agent with
   record_assign (leadWork.ts runAssign), which first asks notBouncedBack: no one who handed it
   back since anything on it changed, unless the owner said so in this turn. The person whose turn
   it is (`asker`, "none" for a turn nobody asked for) is the giver; the agent only on its own. *)
Give(actor, to, asker) ==
  /\ moves < 4 /\ state # "done" /\ to # holder
  /\ actor = "owner" \/ (actor \in Members /\ holder = actor) \/ actor = "agent"
  /\ actor # "agent" => asker = "none"
  /\ actor = "agent" /\ asker # "owner" => to \notin bounced
  /\ pingpong' = (pingpong \/ (actor = "agent" /\ asker # "owner" /\ to \in backs))
  \* The code before this change read the last change alone: any hand-off since hid a hand-back.
  /\ bounced' = IF Broken = "last-change-only" THEN {} ELSE bounced
  /\ holder' = to
  /\ helper' = IF helper = to THEN "none" ELSE helper
  \* "agent-gives": the agent is the giver whoever asked (the code before this change).
  /\ byAgent' = (actor = "agent" /\ to # "agent" /\ (asker = "none" \/ Broken = "agent-gives"))
  /\ byPerson' = IF actor # "agent" THEN actor ELSE IF asker = "none" THEN "owner" ELSE asker
  /\ asked' = IF actor = "agent" THEN asker ELSE "none"
  /\ state' = "open"
  \* "mark-stays": given again, the row still says it was handed back.
  /\ handedBack' = IF Broken = "mark-stays" THEN handedBack ELSE "none"
  /\ Tell(to, actor, 1)
  /\ moves' = moves + 1
  /\ UNCHANGED <<backs, private, inProject, alert, edits>>

(* KinRecords.handBack, from record_hand_back (leadWork.ts runHandBack) or the holder's screen
   (ownerWork.ts handBack): to the agent that gave it, else whoever asked, else the owner; never
   a closed task. The receiver hears it: the agent is woken, a person is told. *)
HandBack ==
  /\ moves < 4 /\ holder # "owner" /\ state # "done"
  /\ LET to == IF byAgent THEN "agent" ELSE IF byPerson # "none" THEN byPerson ELSE "owner" IN
       /\ to # holder
       /\ holder' = to
       /\ helper' = IF helper = to THEN "none" ELSE helper
       /\ byAgent' = FALSE
       /\ state' = "open"
       /\ bounced' = IF Broken = "last-change-only" THEN {holder} ELSE bounced \cup {holder}
       /\ backs' = backs \cup {holder}
       /\ handedBack' = holder
       /\ IF Broken = "screen-hand-back-silent" /\ holder \in Members /\ to \in People
            THEN /\ owed' = TRUE /\ told' = 0
            ELSE Tell(to, holder, 1)
  /\ moves' = moves + 1
  /\ UNCHANGED <<byPerson, asked, private, inProject, alert, pingpong, edits>>

(* Starting it is how a holder takes it on (state doing); no one is told. *)
Start ==
  /\ state = "open" /\ holder # "agent"
  /\ state' = "doing"
  /\ UNCHANGED <<handedBack, backs, holder, byAgent, byPerson, asked, private, inProject, alert, bounced, pingpong, told, owed,
                 moves, edits, helper>>

(* A change on it that isn't a hand-off: its notes, due day or title (KinRecords.update). *)
Edit ==
  /\ edits < 1
  /\ bounced' = {} /\ backs' = {}
  /\ edits' = edits + 1
  /\ UNCHANGED <<handedBack, holder, byAgent, byPerson, asked, state, private, inProject, alert, pingpong, told, owed,
                 moves, helper>>

(* KinRecords.alsoOnFor and update: an authorized writer puts one teammate on the task or they
   come off it. This is an edit for notBouncedBack, distinct from giving the task away. *)
ChangeHelper(p) ==
  /\ p # holder /\ p # helper
  /\ helper' = p
  /\ edits < 1
  /\ bounced' = {} /\ backs' = {}
  /\ edits' = edits + 1
  /\ UNCHANGED <<handedBack, holder, byAgent, byPerson, asked, state, private, inProject, alert,
                 pingpong, told, owed, moves>>

MarkDone ==
  /\ state # "done"
  /\ state' = "done"
  /\ handedBack' = "none"
  /\ UNCHANGED <<backs, holder, byAgent, byPerson, asked, private, inProject, alert, bounced, pingpong, told, owed,
                 moves, edits, helper>>

(* Reopened by its holder or the owner: KinRecords.update state; nothing makes done final. *)
Reopen ==
  /\ state = "done" /\ Broken # "done-final"
  /\ state' = "open"
  /\ UNCHANGED <<handedBack, backs, holder, byAgent, byPerson, asked, private, inProject, alert, bounced, pingpong, told, owed,
                 moves, edits, helper>>

MakePrivate ==
  /\ ~private
  /\ private' = TRUE
  /\ UNCHANGED <<handedBack, backs, holder, byAgent, byPerson, asked, state, inProject, alert, bounced, pingpong, told, owed,
                 moves, edits, helper>>

MoveProject ==
  /\ inProject' = ~inProject
  /\ UNCHANGED <<handedBack, backs, holder, byAgent, byPerson, asked, state, private, alert, bounced, pingpong, told, owed,
                 moves, edits, helper>>

(* pulse/senses/work.ts task_late raises it while it is open past due; KinPulse hold keeps it
   from nagging until its end; done clears the cause. *)
AlertRaised ==
  /\ alert = "none" /\ state # "done"
  /\ alert' = "raised"
  /\ UNCHANGED <<handedBack, backs, holder, byAgent, byPerson, asked, state, private, inProject, bounced, pingpong, told, owed,
                 moves, edits, helper>>

AlertHeld ==
  /\ alert = "raised"
  /\ alert' = "held"
  /\ UNCHANGED <<handedBack, backs, holder, byAgent, byPerson, asked, state, private, inProject, bounced, pingpong, told, owed,
                 moves, edits, helper>>

Next ==
  \/ \E actor \in Everyone, to \in Everyone, asker \in People \cup {"none"} : Give(actor, to, asker)
  \/ \E p \in Members \cup {"none"} : ChangeHelper(p)
  \/ HandBack \/ Start \/ Edit \/ MarkDone \/ Reopen \/ MakePrivate \/ MoveProject
  \/ AlertRaised \/ AlertHeld

Spec == Init /\ [][Next]_vars

------------------------------------------------------------------------------------------------
HolderSees == holder \in Everyone /\ (holder \in Members => Sees(holder))
NoPingPong == ~pingpong
PrivateStaysPrivate == private => \A p \in Members : Sees(p) => p \in {holder, helper}
HelperSees == helper \in Members => (helper # holder /\ Sees(helper))
DoneReversible == state = "done" => ENABLED Reopen
OneNoticePerHandOff == owed => told = 1
\* Whoever asked the agent for the hand-off gave it, so a hand-back goes to them.
AskerIsGiver == asked \in People => (~byAgent /\ byPerson = asked)
\* "Handed back by X" shows only on an open task X handed to its holder.
HandedBackShown == handedBack # "none" => (state # "done" /\ handedBack # holder)
=============================================================================
