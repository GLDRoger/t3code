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
  given,    \* the kind she should come back as: hers at removal, or what the owner gave her since
  keptMoney,\* her Money place when removed (kin_people.removed_access_json)
  backMoney,\* her Money place when she came back: "no" until she does, then "on" or "off"
  heldThen, \* she held the agent's task when removed
  inviter,  \* who made the unused link: "none", "owner", "coowner"
  backBy,   \* who made the link she came back through: "none" until she does
  promoted, \* the owner made her a co-owner while she was removed
  removals, joins

vars == <<given, access, ownerIn, bound, gone, invite, sess, turnMoney, money, leads, card, turn, holds,
          told, leaked, stuck, seen, kinds, rejoined, removals, joins, keptMoney, backMoney, heldThen,
          inviter, backBy, promoted>>
back == <<keptMoney, backMoney, heldThen, inviter, backBy, promoted>>

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
  /\ keptMoney = FALSE /\ backMoney = "no" /\ heldThen = FALSE /\ inviter = "none" /\ backBy = "none"
  /\ promoted = FALSE

\* The kind a link for Ana would bring back: hers now, or, removed, the one a new link restores.
Kind == IF gone THEN given ELSE access

(* people/KinPeople.ts createInvite: owner level; one naming Ana's row only if the caller may act
   on her (mayActOn: a co-owner acts on members), judged for a removed person on the kind a link
   would bring back ("coowner-brings-back": on the demoted row). *)
Invite(by) ==
  /\ invite = "none" /\ ~bound
  /\ invite' = IF access = "none" THEN "new" ELSE "again"
  /\ by = "coowner" => (IF Broken = "coowner-brings-back" THEN access ELSE Kind) # "co_owner"
  /\ inviter' = by
  /\ UNCHANGED <<given, access, ownerIn, bound, gone, sess, turnMoney, money, leads, card, turn, holds,
                 told, leaked, stuck, seen, kinds, rejoined, removals, joins, keptMoney, backMoney,
                 heldThen, backBy, promoted>>

(* KinPeople.accept: a new row starts a member with Money off; a row named again keeps what it
   says; a removed person comes back as they were (bringBack: removed_access_json; "rejoin-as-new":
   the demoted row stays); a session is issued and bound. *)
Join ==
  /\ invite # "none" /\ joins < 2
  /\ access' = IF access = "none" THEN "member"
               ELSE IF gone /\ Broken # "rejoin-as-new" THEN given ELSE access
  /\ money' = IF access = "none" THEN FALSE
              ELSE IF gone /\ Broken # "rejoin-as-new" THEN keptMoney ELSE money
  /\ bound' = TRUE /\ gone' = FALSE /\ invite' = "none"
  /\ sess' = access'
  /\ rejoined' = IF gone THEN access' ELSE rejoined
  /\ backMoney' = IF gone THEN (IF money' THEN "on" ELSE "off") ELSE backMoney
  /\ backBy' = IF gone THEN inviter ELSE backBy
  /\ joins' = joins + 1
  /\ UNCHANGED <<given, ownerIn, turnMoney, leads, card, turn, holds, told, leaked, stuck, seen, kinds,
                 removals, keptMoney, heldThen, inviter, promoted>>

(* KinPeople.setAccess: the owner alone, never on himself; a demotion aborts the turns running in
   her chats (abortChatTurns). A co-owner's call is refused (ownerOnly). *)
SetAccess(by, to) ==
  /\ access # "none" /\ access # to
  /\ by = "owner" \/ Broken = "coowner-sets-kind"
  \* Removed, the change is to the kind a link brings back; the row stays a member's.
  /\ access' = IF gone THEN access ELSE to
  /\ turn' = IF to = "member" /\ turn = "owner" /\ Broken # "no-abort" THEN "none" ELSE turn
  /\ kinds' = (kinds \/ by = "coowner")
  /\ given' = IF gone THEN to ELSE given
  /\ promoted' = IF gone THEN to = "co_owner" ELSE promoted
  /\ UNCHANGED <<ownerIn, bound, gone, invite, sess, turnMoney, money, leads, card, holds, told,
                 leaked, stuck, seen, rejoined, removals, joins, keptMoney, backMoney, heldThen,
                 inviter, backBy>>

(* KinPeople.removeAccess: owner level, on a member (mayActOn), never on the owner (denied).
   Invites revoked, sessions revoked, chats left, turns aborted (onPersonRemoved). Access only: her
   open tasks stay hers, each noting who removed her (noteTasks), and no agent is woken
   ("removal-hands-back": they go back to whoever gave them, which wakes the agent). Her row is a
   member's with a new joiner's places until a link brings back what it kept
   ("removal-keeps-level": the row keeps her level while she is gone). *)
Remove(by) ==
  /\ bound /\ removals < 1
  /\ by = "coowner" => access # "co_owner"
  /\ bound' = FALSE /\ gone' = TRUE /\ invite' = "none" /\ turn' = "none" /\ card' = "none"
  /\ inviter' = "none"
  /\ heldThen' = (holds = "ana")
  /\ IF Broken = "removal-hands-back" /\ holds = "ana"
       THEN holds' = "agent" /\ told' = TRUE
       ELSE UNCHANGED <<holds, told>>
  /\ IF Broken = "removal-keeps-level"
       THEN UNCHANGED <<access, money>>
       ELSE access' = "member" /\ money' = FALSE
  /\ removals' = removals + 1 /\ given' = access /\ keptMoney' = money
  /\ UNCHANGED <<ownerIn, sess, turnMoney, leads, leaked, stuck, seen, kinds, rejoined, joins,
                 backMoney, backBy, promoted>>

(* Only in the variant coowner-removes-owner: mayActOn no longer refuses the owner. *)
RemoveOwner ==
  /\ Broken = "coowner-removes-owner" /\ ownerIn
  /\ ownerIn' = FALSE
  /\ UNCHANGED <<given, access, bound, gone, invite, sess, turnMoney, money, leads, card, turn, holds, told,
                 leaked, stuck, seen, kinds, rejoined, removals, joins, back>>

(* KinPeople.setPlaces: owner level, only on a member; removed, on the places a link brings back. *)
SetMoney(by, on) ==
  /\ IF gone
       THEN /\ given = "member" /\ keptMoney # on /\ keptMoney' = on /\ UNCHANGED money
       ELSE /\ access = "member" /\ money # on /\ money' = on /\ UNCHANGED keptMoney
  /\ UNCHANGED <<given, access, ownerIn, bound, gone, invite, sess, turnMoney, leads, card, turn, holds,
                 told, leaked, stuck, seen, kinds, rejoined, removals, joins, backMoney, heldThen,
                 inviter, backBy, promoted>>

(* The project's owner field set to Ana, or to someone else (KinRecords.update on the project). *)
SetLead(on) ==
  /\ access # "none" /\ leads # on
  /\ leads' = on
  /\ UNCHANGED <<given, access, ownerIn, bound, gone, invite, sess, turnMoney, money, card, turn, holds,
                 told, leaked, stuck, seen, kinds, rejoined, removals, joins, back>>

(* A send or receipt card waiting for an owner-level tap comes up in Ana's own chat with a lead. *)
CardUp ==
  /\ bound /\ OwnerLevel /\ card = "none"
  /\ card' = "open"
  /\ UNCHANGED <<given, access, ownerIn, bound, gone, invite, sess, turnMoney, money, leads, turn, holds,
                 told, leaked, stuck, seen, kinds, rejoined, removals, joins, back>>

(* Ana taps Confirm: answerAsk / answerReceiptCard ask ownerLevel at the tap; refused otherwise. *)
TapCard ==
  /\ bound /\ card = "open" /\ Level = "co_owner"
  /\ card' = "answered"
  /\ leaked' = (leaked \/ ~OwnerLevel)
  /\ UNCHANGED <<given, access, ownerIn, bound, gone, invite, sess, turnMoney, money, leads, turn, holds,
                 told, stuck, seen, kinds, rejoined, removals, joins, back>>

(* Any read Ana makes (kin.access.me, Team, Money, a list): served at her level read now, the
   places and projects read now (work/teamView.ts personSees, placesOf). *)
Read ==
  /\ bound
  /\ leaked' = (leaked \/ (Level = "co_owner" /\ ~OwnerLevel))
  /\ stuck' = (stuck \/ (OwnerLevel /\ Level # "co_owner"))
  /\ seen' = (seen \/ (SeesMoney(money) /\ ~Allowed))
  /\ UNCHANGED <<given, access, ownerIn, bound, gone, invite, sess, turnMoney, money, leads, card, turn,
                 holds, told, kinds, rejoined, removals, joins, back>>

(* Ana writes to a lead: the turn is built at her level now; it answers later. *)
TurnStarts ==
  /\ bound /\ turn = "none"
  /\ turn' = IF Level = "co_owner" THEN "owner" ELSE "member"
  /\ turnMoney' = money
  /\ UNCHANGED <<given, access, ownerIn, bound, gone, invite, sess, money, leads, card, holds, told, leaked,
                 stuck, seen, kinds, rejoined, removals, joins, back>>

(* The turn answers: its reads go through the team view, places and projects read at that call
   (work/teamView.ts); only the variant turn-keeps-places uses the places from its start. *)
TurnAnswers ==
  /\ bound /\ turn # "none"
  /\ leaked' = (leaked \/ (turn = "owner" /\ ~OwnerLevel))
  /\ seen' = (seen \/ (SeesMoney(IF Broken = "turn-keeps-places" THEN turnMoney ELSE money)
                       /\ turn = "member" /\ ~Allowed))
  /\ turn' = "none"
  /\ UNCHANGED <<given, access, ownerIn, bound, gone, invite, sess, turnMoney, money, leads, card, holds,
                 told, stuck, kinds, rejoined, removals, joins, back>>

(* An agent gives Ana the task (record_assign: resolveWho -> personNamed, which names no one
   removed: kin_people.removed_at); she can hand it back (record_hand_back). *)
AgentGives ==
  /\ holds = "agent" /\ (~gone \/ Broken = "give-to-gone") /\ access # "none"
  /\ holds' = "ana" /\ told' = FALSE
  /\ UNCHANGED <<given, access, ownerIn, bound, gone, invite, sess, turnMoney, money, leads, card, turn,
                 leaked, stuck, seen, kinds, rejoined, removals, joins, back>>

HandsBack ==
  /\ holds = "ana" /\ bound
  /\ holds' = "agent" /\ told' = TRUE
  /\ UNCHANGED <<given, access, ownerIn, bound, gone, invite, sess, turnMoney, money, leads, card, turn,
                 leaked, stuck, seen, kinds, rejoined, removals, joins, back>>

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
\* Removing changes access only: a task she held stays hers, and no agent is woken for it.
TasksStay == (gone /\ heldThen) => (holds = "ana" /\ ~told)
CoOwnerChangesNoKind == ~kinds
OneOwner == ownerIn
\* Let back in, she has exactly what she had, or what the owner gave her while she was gone.
ComesBackAsShe ==
  rejoined \in {"no", given} /\ backMoney \in {"no", IF keptMoney THEN "on" ELSE "off"}
\* Removed, she holds no level anywhere, even while nothing of hers is signed in.
RemovedHoldsNoLevel == gone => access # "co_owner"
\* A co-owner's link never brings back someone owner-level by itself: only the owner's does, or
\* his making her a co-owner while she was gone.
OwnerBringsBackOwnerLevel == rejoined = "co_owner" => (backBy = "owner" \/ promoted)
=============================================================================
