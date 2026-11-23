---------------------------- MODULE Stream ----------------------------
(* Work's live stream to one person, Ana, with Tasks open. Two tasks change and are shared with her
   or taken from her view. Task a is a promise whose deal can become private or public;
   she is made a co-owner or a member again; her socket drops and comes
   back. The host sends each change as the task itself, as her own read shows it now, numbered in
   her own numbering; her client folds what arrives. Each action names the code it stands for
   (paths under apps/server/src/kin/work and packages). One action is one transaction or one step
   of a fiber. *)
EXTENDS Naturals, FiniteSets

CONSTANTS Broken

Tasks == {"a", "b"}
MaxVer == 2

VARIABLES
  ver,        \* each task's version on the host, 1..MaxVer
  shared,     \* a teammate could see it by task sharing, ownership or project membership
  sectionsOn, \* the shell still shows Clients
  switchedOffline, \* the last switch took place after the socket had dropped
  dealPrivate, \* the linked deal hides its promise from teammates
  member,     \* Ana is a member; FALSE: a co-owner, who sees every task
  num,        \* her own number now: kin_team_seqs as a member, the org's latest as a co-owner
  unpub,      \* committed changes whose tick hasn't published: afterCommit runs once the lock is free
  log,        \* the changes kin_record_changes holds, as [k |-> number, t |-> task]
  up,         \* her socket is open, with a session subscribed (subscribeRows)
  sMember,    \* the level her session serves her at (makeWorkStream viewer)
  seen,       \* tasks her session told her of as a member (makeWorkStream seen)
  inbox,      \* ticks the session took in and hasn't sent (bufferLatestLiveStream, groupedWithin)
  heard,      \* every change up to here reached the session (makeWorkStream heard)
  early,      \* numbers heard past heard
  shown,      \* her client's row for each task: its version, or 0 when it holds none
  clientNamed, \* her Tasks shows the owner's client label on the linked promise
  at,         \* the number each row was last applied at (kinApplyWorkRow skips anything older)
  cursor,     \* where her client resumes: the last counts or synchronized number (KinWorkResume)
  cMember,    \* that number is a member's (afterTeam)
  leak,       \* she was told of a task she can't see and was never told of
  levelOwed,  \* her level changed under a live session: its next send must start her over
  levelBroke, \* something else was sent first
  changes, moves, drops

vars == <<ver, shared, dealPrivate, sectionsOn, switchedOffline, member, num, unpub, log, up, sMember, seen, inbox, heard, early, shown, clientNamed, at,
          cursor, cMember, leak, levelOwed, levelBroke, changes, moves, drops>>

Max(S) == CHOOSE m \in S : \A x \in S : x <= m
Min(a, b) == IF a < b THEN a ELSE b

(* What her own read shows (ownerWork.ts list via shownRecords), at a level. *)
Sees(t, asMember) == ~asMember \/ (shared[t] /\ ~(t = "a" /\ (dealPrivate \/ ~sectionsOn)))
Read == [t \in Tasks |-> IF Sees(t, member) THEN ver[t] ELSE 0]
ClientNamed(asMember) == ~asMember /\ sectionsOn

Init ==
  /\ ver = [t \in Tasks |-> 1] /\ shared = [t \in Tasks |-> t = "a"] /\ member = TRUE
  /\ dealPrivate = FALSE /\ sectionsOn = TRUE /\ switchedOffline = FALSE
  /\ num = 0 /\ unpub = {} /\ log = {} /\ up = TRUE /\ sMember = TRUE
  /\ seen = {"a"} /\ inbox = {} /\ heard = 0 /\ early = {}
  /\ shown = [t \in Tasks |-> IF t = "a" THEN 1 ELSE 0] /\ clientNamed = FALSE
  /\ at = [t \in Tasks |-> 0]
  /\ cursor = 0 /\ cMember = TRUE /\ leak = FALSE /\ levelOwed = FALSE /\ levelBroke = FALSE
  /\ changes = 0 /\ moves = 0 /\ drops = 0

Session == <<up, sMember, seen, inbox, heard, early>>
Client == <<shown, clientNamed, at, cursor, cMember>>
Ghosts == <<leak, levelOwed, levelBroke, switchedOffline>>

(* KinRecords.logChange: the change is logged at the next number, her own number moves when she
   sees it before or after (bumpTeamSeqs; a co-owner's is the org's, which every change moves),
   and its tick waits for the commit. *)
Logged(t, hers) ==
  IF hers
    THEN /\ num' = num + 1
         /\ unpub' = unpub \cup {[k |-> num + 1, t |-> t]}
         /\ log' = log \cup {[k |-> num + 1, t |-> t]}
    ELSE UNCHANGED <<num, unpub, log>>

(* KinRecords.update: its title, state, due day or holder. *)
Edit(t) ==
  /\ changes < 3 /\ ver[t] < MaxVer
  /\ ver' = [ver EXCEPT ![t] = @ + 1]
  /\ Logged(t, Sees(t, member))
  /\ UNCHANGED <<shared, dealPrivate, sectionsOn, member, moves, drops>> /\ UNCHANGED Session /\ UNCHANGED Client
  /\ UNCHANGED Ghosts
  /\ changes' = changes + 1

(* Shared with her, made private, given to her or taken from her, moved in or out of her project:
   her view of it moves either way. *)
Share(t) ==
  /\ changes < 3
  /\ shared' = [shared EXCEPT ![t] = ~@]
  /\ Logged(t, ~member \/ t # "a" \/ (~dealPrivate /\ sectionsOn))
  /\ UNCHANGED <<ver, dealPrivate, sectionsOn, member, moves, drops>> /\ UNCHANGED Session /\ UNCHANGED Client
  /\ UNCHANGED Ghosts
  /\ changes' = changes + 1

(* KinRecords.update includes the deal's promise in its before/after visibility scope.
   A teammate receives the deal tick when that scope changes what they may see. *)
DealLabel ==
  /\ changes < 3
  /\ dealPrivate' = ~dealPrivate
  /\ Logged("deal", ~member \/ (sectionsOn /\ shared["a"]))
  /\ UNCHANGED <<ver, shared, sectionsOn, member, moves, drops>>
  /\ UNCHANGED Session /\ UNCHANGED Client /\ UNCHANGED Ghosts
  /\ changes' = changes + 1

(* KinShell.set calls KinRecords.announce for the whole view: a numbered tick with no row. *)
ShellSwitch ==
  /\ changes < 3
  /\ sectionsOn' = ~sectionsOn
  /\ switchedOffline' = ~up
  /\ num' = num + 1
  /\ unpub' = unpub \cup {[k |-> num + 1, t |-> "shell"]}
  /\ changes' = changes + 1
  /\ UNCHANGED <<ver, shared, dealPrivate, member, log, moves, drops>>
  /\ UNCHANGED Session /\ UNCHANGED Client /\ UNCHANGED <<leak, levelOwed, levelBroke>>

(* KinPeople.setAccess, then KinRecords.peopleMoved: her own number moves and a people tick names
   her; it is no change to a task, so the log has none. *)
Level ==
  /\ moves < 1
  /\ member' = ~member
  /\ num' = num + 1
  /\ unpub' = unpub \cup {[k |-> num + 1, t |-> "level"]}
  /\ levelOwed' = up
  /\ moves' = moves + 1
  /\ UNCHANGED <<ver, shared, dealPrivate, sectionsOn, log, changes, drops, leak, levelBroke, switchedOffline>>
  /\ UNCHANGED Session /\ UNCHANGED Client

(* PubSub.publish in an afterCommit callback: any committed tick may go first. With no session it
   reaches no one. The session counts it heard: a member's own numbers, and a co-owner's task
   changes (a people tick reuses a number; it is no change arriving). *)
Publish(x) ==
  /\ x \in unpub
  /\ unpub' = unpub \ {x}
  /\ IF up
       THEN /\ inbox' = inbox \cup {x}
            /\ IF (sMember \/ x.t # "level") /\ x.k > heard
                 THEN LET E == early \cup {x.k}
                          h == CHOOSE m \in heard..(heard + 4) :
                                 /\ \A j \in (heard + 1)..m : j \in E
                                 /\ (m + 1) \notin E
                      IN /\ heard' = h /\ early' = {j \in E : j > h}
                 ELSE UNCHANGED <<heard, early>>
       ELSE UNCHANGED <<inbox, heard, early>>
  /\ UNCHANGED <<ver, shared, dealPrivate, sectionsOn, member, num, log, up, sMember, seen, changes, moves, drops>>
  /\ UNCHANGED Client /\ UNCHANGED Ghosts

(* workStream.ts restart: snapshot-required, then whole counts. The client drops what it held and
   reads its own view again (kinWorkLiveFold, createKinWorkList). *)
StartOver ==
  /\ shown' = Read
  /\ clientNamed' = ClientNamed(member)
  /\ at' = [t \in Tasks |-> num]
  /\ cursor' = num /\ cMember' = member
  /\ sMember' = member
  /\ seen' = {t \in Tasks : Sees(t, member)}
  /\ heard' = num /\ early' = {} /\ inbox' = {}

(* resumable: where a burst may close. A member's numbers run one by one; a co-owner's are the
   org's, so a gap is late only where the log has a change that hasn't arrived. *)
Resumable(top) ==
  IF Broken = "close-at-top" THEN top
  ELSE IF sMember THEN Min(top, heard)
  ELSE IF early = {} THEN Min(top, heard)
  ELSE LET last == Max(early)
           late == {c.k : c \in {c \in log : c.k > heard /\ c.k <= last /\ c.k \notin early}}
       IN Min(top, IF late = {} THEN last ELSE Max({0} \cup {m \in 0..last : \A j \in late : m < j})) 

(* makeWorkStream batch: the level read again first; then each task named, as her read shows it
   now (rowsNow): upsert, or removed only if she was told of it; then counts or synchronized. *)
Batch ==
  /\ up /\ inbox # {}
  /\ IF (sMember # member /\ Broken # "no-level-check")
        \/ (Broken # "no-shell-refresh" /\ \E x \in inbox : x.t = "shell")
       THEN /\ StartOver /\ levelOwed' = FALSE
            /\ UNCHANGED <<leak, levelBroke>>
       ELSE LET top == Max({x.k : x \in inbox})
                direct == {x.t : x \in inbox} \cap Tasks
                dependents == IF sMember /\ Broken # "deal-no-dependent-row" /\ \E x \in inbox : x.t = "deal"
                              THEN {"a"} ELSE {}
                named == direct \cup dependents
                \* rowsNow reads her number first, then the rows: each carries at least that.
                seqOf(t) == IF Broken = "tick-number"
                            THEN IF t \in direct THEN Max({x.k : x \in {y \in inbox : y.t = t}})
                                 ELSE top
                            ELSE num
                upserts == {t \in named : Sees(t, sMember)}
                removes == {t \in named \ upserts :
                              ~sMember \/ t \in seen \/ Broken = "removed-unseen"}
                applied == {t \in upserts \cup removes : at[t] < seqOf(t)}
            IN /\ leak' = (leak \/ \E t \in removes : sMember /\ t \notin seen)
               /\ shown' = [t \in Tasks |->
                              IF t \in applied THEN (IF t \in upserts THEN ver[t] ELSE 0)
                              ELSE shown[t]]
               /\ clientNamed' = IF "a" \in applied THEN ClientNamed(sMember) ELSE clientNamed
               /\ at' = [t \in Tasks |-> IF t \in applied THEN seqOf(t) ELSE at[t]]
               /\ seen' = IF sMember THEN (seen \cup upserts) \ removes ELSE seen
               /\ cursor' = Resumable(top) /\ cMember' = sMember
               /\ levelBroke' = (levelBroke \/ levelOwed)
               /\ inbox' = {}
               /\ UNCHANGED <<sMember, heard, early, levelOwed>>
  /\ UNCHANGED <<ver, shared, dealPrivate, sectionsOn, member, num, unpub, log, up, changes, moves, drops, switchedOffline>>

(* The socket drops: the session and what it hadn't sent go with it. *)
Drop ==
  /\ up /\ drops < 1
  /\ up' = FALSE /\ inbox' = {} /\ early' = {}
  /\ levelOwed' = FALSE
  /\ drops' = drops + 1
  /\ UNCHANGED <<ver, shared, dealPrivate, sectionsOn, member, num, unpub, log, sMember, seen, heard, changes, moves>>
  /\ UNCHANGED Client /\ UNCHANGED <<leak, levelBroke, switchedOffline>>

(* makeWorkStream start uses the assigned owner cursor, including numbers reserved without rows.
   A hole in the replay through that number starts her over. *)
Resume ==
  /\ ~up
  /\ up' = TRUE
  /\ LET now == IF ~member /\ Broken = "skip-reserved-on-resume"
                THEN Max({0} \cup {c.k : c \in log})
                ELSE num
         hole == \E k \in (cursor + 1)..now : ~\E c \in log : c.k = k
         replay == {t \in Tasks : \E c \in log : c.t = t /\ c.k > cursor /\ c.k <= now}
         seqOf(t) == Max({c.k : c \in {d \in log : d.t = t}})
     IN IF cMember # member \/ cursor > now \/ (cursor # now /\ (member \/ hole))
          THEN StartOver
          ELSE /\ sMember' = member
               /\ seen' = {t \in Tasks : Sees(t, member)}
               /\ heard' = num /\ early' = {} /\ inbox' = {}
               /\ shown' = [t \in Tasks |->
                              IF t \in replay /\ at[t] < seqOf(t) THEN ver[t] ELSE shown[t]]
               /\ clientNamed' = IF "a" \in replay /\ at["a"] < seqOf("a")
                                 THEN ClientNamed(member) ELSE clientNamed
               /\ at' = [t \in Tasks |->
                           IF t \in replay /\ at[t] < seqOf(t) THEN seqOf(t) ELSE at[t]]
               /\ cursor' = now /\ cMember' = member
  /\ UNCHANGED <<ver, shared, dealPrivate, sectionsOn, member, num, unpub, log, changes, moves, drops>>
  /\ UNCHANGED Ghosts

Next ==
  \/ \E t \in Tasks : Edit(t) \/ Share(t)
  \/ DealLabel \/ ShellSwitch \/ Level
  \/ \E x \in unpub : Publish(x)
  \/ Batch \/ Drop \/ Resume

Spec == Init /\ [][Next]_vars

------------------------------------------------------------------------------------------------
Settled == up /\ unpub = {} /\ inbox = {}
StreamEqualsRead == Settled => shown = Read
ClientLabelEqualsRead == Settled /\ switchedOffline => clientNamed = ClientNamed(member)
NoHiddenNamed == ~leak
LevelStartsOver == ~levelBroke
=============================================================================
