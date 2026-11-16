---------------------------- MODULE People ----------------------------
(* Changing who one person (Ana) is, against what she can see and do at each moment. The owner
   or a co-owner invites her, she joins, is made a co-owner, demoted, made a project's lead,
   taken off it, has her Money place turned on or off, is removed and let back in. Meanwhile she
   reads, taps an owner-level card waiting in her chat, has a turn running for her, and holds a
   task an agent gave her. Each action names the code it stands for (paths under
   apps/server/src/kin). One action is one transaction or one request. *)
EXTENDS Naturals

CONSTANTS Broken

Callers == {"owner", "coowner"}

VARIABLES
  access,   \* kin_people.access for Ana: "none" (no row yet), "member", "co_owner"
  ownerIn,  \* the owner is in the company, and his row still says owner
  bound,    \* Ana has a live session (kin_session_bindings.revoked_at IS NULL)
  gone,     \* Ana was removed (removeAccess) and is not back
  invite,   \* an unused invite link for Ana: "none", "new", "again" (one naming her row)
  sess,     \* the level Ana's session was issued at: used only by the session variants
  turnMoney,\* the Money place when her running turn started: used only by turn-keeps-places
  money,    \* kin_people.sees_money
  leads,    \* Ana leads the project (projects.owner_id), so its money is hers to see
  card,     \* an owner-level card waits in Ana's chat: "none", "open", "answered"
  turn,     \* a turn running for Ana, built at her level then: "none", "owner", "member"
  holds,    \* who holds the task an agent gave Ana: "agent", "ana"
  told,     \* the agent was woken when the task came back to it
  leaked,   \* something owner-level reached Ana while she was not owner-level
  stuck,    \* Ana, owner-level now, was served at a member's level
  seen,     \* Ana read the project's money while it wasn't hers to see
  kinds,    \* a co-owner changed someone's kind
  rejoined, \* the kind Ana came back as after a removal: "no" until she does
  given,    \* the kind the owner gave her since her removal: "member" unless he promoted her
  removals, joins

vars == <<given, access, ownerIn, bound, gone, invite, sess, turnMoney, money, leads, card, turn, holds,
          told, leaked, stuck, seen, kinds, rejoined, removals, joins>>

OwnerLevel == access = "co_owner"
\* people/KinAccess.ts ownerLevel: read on every request. The session variants read the level the
\* session was issued at instead.
Level == IF Broken \in {"level-from-session", "promote-needs-rejoin"} THEN sess ELSE access
SeesMoney(place) == Level = "co_owner" \/ place \/ leads
Allowed == OwnerLevel \/ money \/ leads

Init ==
  /\ access = "none" /\ ownerIn = TRUE /\ bound = FALSE /\ gone = FALSE /\ invite = "none"
  /\ sess = "none" /\ turnMoney = FALSE /\ money = FALSE /\ leads = FALSE /\ card = "none"
  /\ turn = "none" /\ holds = "agent" /\ told = FALSE
  /\ leaked = FALSE /\ stuck = FALSE /\ seen = FALSE /\ kinds = FALSE /\ rejoined = "no" /\ given = "member"
  /\ removals = 0 /\ joins = 0

(* people/KinPeople.ts createInvite: owner level; one naming Ana's row only if the caller may act
   on her (mayActOn: a co-owner acts on members). *)
Invite(by) ==
  /\ invite = "none" /\ ~bound
  /\ invite' = IF access = "none" THEN "new" ELSE "again"
  /\ by = "coowner" => access # "co_owner"
  /\ UNCHANGED <<given, access, ownerIn, bound, gone, sess, turnMoney, money, leads, card, turn, holds,
                 told, leaked, stuck, seen, kinds, rejoined, removals, joins>>

(* KinPeople.accept: a new row starts a member with Money off; a row named again keeps what it
   says; a session is issued and bound. *)
Join ==
  /\ invite # "none" /\ joins < 2
  /\ access' = IF access = "none" THEN "member" ELSE access
  /\ money' = IF access = "none" THEN FALSE ELSE money
  /\ bound' = TRUE /\ gone' = FALSE /\ invite' = "none"
  /\ sess' = access'
  /\ rejoined' = IF gone THEN access' ELSE rejoined
  /\ joins' = joins + 1
  /\ UNCHANGED <<given, ownerIn, turnMoney, leads, card, turn, holds, told, leaked, stuck, seen, kinds,
                 removals>>

(* KinPeople.setAccess: the owner alone, never on himself; a demotion aborts the turns running in
   her chats (abortChatTurns). A co-owner's call is refused (ownerOnly). *)
SetAccess(by, to) ==
  /\ access # "none" /\ access # to
  /\ by = "owner" \/ Broken = "coowner-sets-kind"
  /\ access' = to
  /\ turn' = IF to = "member" /\ turn = "owner" /\ Broken # "no-abort" THEN "none" ELSE turn
  /\ kinds' = (kinds \/ by = "coowner")
  /\ given' = IF gone THEN to ELSE given
  /\ UNCHANGED <<ownerIn, bound, gone, invite, sess, turnMoney, money, leads, card, holds, told,
                 leaked, stuck, seen, rejoined, removals, joins>>

(* KinPeople.removeAccess: owner level, on a member (mayActOn), never on the owner (denied).
   Invites revoked, sessions revoked, chats left, turns aborted (onPersonRemoved); her open tasks go
   back to whoever gave them, which wakes the agent (handTasksBack -> records.handBack); her row is
   a member's again with a new joiner's places, marked removed until a link lets her back in. *)
Remove(by) ==
  /\ bound /\ removals < 1
  /\ by = "coowner" => access # "co_owner"
  /\ bound' = FALSE /\ gone' = TRUE /\ invite' = "none" /\ turn' = "none" /\ card' = "none"
  /\ IF Broken = "removal-keeps-tasks" \/ holds # "ana"
       THEN UNCHANGED <<holds, told>>
       ELSE holds' = "agent" /\ told' = TRUE
  /\ IF Broken = "rejoin-keeps-level"
       THEN UNCHANGED <<access, money>>
       ELSE access' = "member" /\ money' = FALSE
  /\ removals' = removals + 1 /\ given' = "member"
  /\ UNCHANGED <<ownerIn, sess, turnMoney, leads, leaked, stuck, seen, kinds, rejoined, joins>>

(* Only in the variant coowner-removes-owner: mayActOn no longer refuses the owner. *)
RemoveOwner ==
  /\ Broken = "coowner-removes-owner" /\ ownerIn
  /\ ownerIn' = FALSE
  /\ UNCHANGED <<given, access, bound, gone, invite, sess, turnMoney, money, leads, card, turn, holds, told,
                 leaked, stuck, seen, kinds, rejoined, removals, joins>>

(* KinPeople.setPlaces: owner level, only on a member. *)
SetMoney(by, on) ==
  /\ access = "member" /\ money # on
  /\ money' = on
  /\ UNCHANGED <<given, access, ownerIn, bound, gone, invite, sess, turnMoney, leads, card, turn, holds,
                 told, leaked, stuck, seen, kinds, rejoined, removals, joins>>

(* The project's owner field set to Ana, or to someone else (KinRecords.update on the project). *)
SetLead(on) ==
  /\ access # "none" /\ leads # on
  /\ leads' = on
  /\ UNCHANGED <<given, access, ownerIn, bound, gone, invite, sess, turnMoney, money, card, turn, holds,
                 told, leaked, stuck, seen, kinds, rejoined, removals, joins>>

(* A send or receipt card waiting for an owner-level tap comes up in Ana's own chat with a lead. *)
CardUp ==
  /\ bound /\ OwnerLevel /\ card = "none"
  /\ card' = "open"
  /\ UNCHANGED <<given, access, ownerIn, bound, gone, invite, sess, turnMoney, money, leads, turn, holds,
                 told, leaked, stuck, seen, kinds, rejoined, removals, joins>>

(* Ana taps Confirm: answerAsk / answerReceiptCard ask ownerLevel at the tap; refused otherwise. *)
TapCard ==
  /\ bound /\ card = "open" /\ Level = "co_owner"
  /\ card' = "answered"
  /\ leaked' = (leaked \/ ~OwnerLevel)
  /\ UNCHANGED <<given, access, ownerIn, bound, gone, invite, sess, turnMoney, money, leads, turn, holds,
                 told, stuck, seen, kinds, rejoined, removals, joins>>

(* Any read Ana makes (kin.access.me, Team, Money, a list): served at her level read now, the
   places and projects read now (work/teamView.ts personSees, placesOf). *)
Read ==
  /\ bound
  /\ leaked' = (leaked \/ (Level = "co_owner" /\ ~OwnerLevel))
  /\ stuck' = (stuck \/ (OwnerLevel /\ Level # "co_owner"))
  /\ seen' = (seen \/ (SeesMoney(money) /\ ~Allowed))
  /\ UNCHANGED <<given, access, ownerIn, bound, gone, invite, sess, turnMoney, money, leads, card, turn,
                 holds, told, kinds, rejoined, removals, joins>>

(* Ana writes to a lead: the turn is built at her level now; it answers later. *)
TurnStarts ==
  /\ bound /\ turn = "none"
  /\ turn' = IF Level = "co_owner" THEN "owner" ELSE "member"
  /\ turnMoney' = money
  /\ UNCHANGED <<given, access, ownerIn, bound, gone, invite, sess, money, leads, card, holds, told, leaked,
                 stuck, seen, kinds, rejoined, removals, joins>>

(* The turn answers: its reads go through the team view, places and projects read at that call
   (work/teamView.ts); only the variant turn-keeps-places uses the places from its start. *)
TurnAnswers ==
  /\ bound /\ turn # "none"
  /\ leaked' = (leaked \/ (turn = "owner" /\ ~OwnerLevel))
  /\ seen' = (seen \/ (SeesMoney(IF Broken = "turn-keeps-places" THEN turnMoney ELSE money)
                       /\ turn = "member" /\ ~Allowed))
  /\ turn' = "none"
  /\ UNCHANGED <<given, access, ownerIn, bound, gone, invite, sess, turnMoney, money, leads, card, holds,
                 told, stuck, kinds, rejoined, removals, joins>>

(* An agent gives Ana the task (record_assign: resolveWho -> personNamed, which names no one
   removed: kin_people.removed_at); she can hand it back (record_hand_back). *)
AgentGives ==
  /\ holds = "agent" /\ (~gone \/ Broken = "give-to-gone") /\ access # "none"
  /\ holds' = "ana" /\ told' = FALSE
  /\ UNCHANGED <<given, access, ownerIn, bound, gone, invite, sess, turnMoney, money, leads, card, turn,
                 leaked, stuck, seen, kinds, rejoined, removals, joins>>

HandsBack ==
  /\ holds = "ana" /\ bound
  /\ holds' = "agent" /\ told' = TRUE
  /\ UNCHANGED <<given, access, ownerIn, bound, gone, invite, sess, turnMoney, money, leads, card, turn,
                 leaked, stuck, seen, kinds, rejoined, removals, joins>>

Next ==
  \/ \E by \in Callers : Invite(by) \/ Remove(by) \/ SetAccess(by, "co_owner")
                         \/ SetAccess(by, "member") \/ SetMoney(by, TRUE) \/ SetMoney(by, FALSE)
  \/ Join \/ RemoveOwner \/ SetLead(TRUE) \/ SetLead(FALSE) \/ CardUp \/ TapCard \/ Read
  \/ TurnStarts \/ TurnAnswers \/ AgentGives \/ HandsBack

Spec == Init /\ [][Next]_vars

------------------------------------------------------------------------------------------------
NothingOwnerLevelAfter == ~leaked
PromotionTakesEffect == ~stuck
PlaceOffHides == ~seen
TasksGoBack == gone => holds # "ana"
CoOwnerChangesNoKind == ~kinds
OneOwner == ownerIn
RejoinsAsMember == rejoined \in {"no", given}
=============================================================================
