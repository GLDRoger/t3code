---------------------------- MODULE GitHubEvents ----------------------------
(* Kin watching one GitHub thread with the owner's login. The thread is a PR's (Item "pull"):
   things happen on it (a teammate's PR, a teammate's /kin, a stranger's /kin, the agent's own
   signed reply), Kin looks, decides, wakes an agent once, reacts once, and the agent's reply lands
   back on the thread. Or it is a new issue (Item "issue") that issue triage answers: Kin's comment,
   then a reply when a person answers it, under the replies' cap, the hour's ceilings and the
   owner's switch. The server can stop at any point. Each action names the code it stands for
   (paths under apps/server/src/kin). One action is one transaction. *)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Broken,
  MaxThings,        \* things on a PR's thread, the agent's replies included
  MaxStops,         \* the server stopping anywhere
  Items,            \* the threads checked: "pull", "issue", or both (each run is one thread)
  MaxIssue,         \* things on the issue: the issue itself, comments, the agent's posts
  MaxHours          \* hours ending while the issue is watched

PerLook == 1        \* GitHubWatch.ts WAKES_PER_LOOK, scaled down
PerThread == 2      \* GitHubWatch.ts PER_THREAD_HOURLY, scaled down
Kinds == {"pr", "call", "stranger"}
TriageReplies == 2  \* githubTriggers.ts TRIAGE_REPLIES (3), scaled down
RepoHour == 2       \* GitHubWatch.ts AUTO_WAKES_PER_HOUR (10) for triage wakes per repo, scaled down
OutsideHour == 1    \* AUTO_WAKES_PER_HOUR (10) for outside wakes per org, scaled further, so each
                    \* ceiling is seen to hold by its own check
Looks == {"poll", "hook"}   \* the minute's poll and the App's webhook look (lookAt), unlocked

VARIABLES
  item,       \* which thread this run watches
  thread,     \* what is on the thread, oldest first: pr, call, stranger, own; on an issue the
              \* issue (in: by a teammate, out: by a stranger), then person, bot, own
  cursor,     \* kin_github_watch.since_at: everything up to here was weighed
  handled,    \* kin_github_handled: the trigger keys stored, whatever the outcome
  capped,     \* those stored as "capped": stopped for the hour, with the note
  wakes,      \* per thing, the agent wake-ups (kin_events) it caused
  pending,    \* wake-ups queued and not yet run
  reactions,  \* per thing, the 👀 Kin put on it
  phase,      \* idle, looking (between StartLook and EndLook)
  upTo,       \* the newest thing this look read
  at,         \* the next thing this look weighs
  woken,      \* wake-ups this look
  later,      \* this look left a trigger for the next one
  react,      \* the thing just woken, owed its 👀 (0 when none)
  hourWakes,  \* wake-ups on the thread this hour
  notes,      \* "stopped for the hour" comments this hour (one hour: its end resets both)
  stops,
  triageOn,   \* the repo's "reply to new issues" switch (triage-from:<repo>)
  looks,      \* per look on the issue: what it read and may claim (cand 0: not looking)
  seenTo,     \* seen:<ref>:c<id> rows: every comment up to here was weighed
  kinSaid,    \* triaged:<ref> "posted": where Kin's last comment GitHub took is (0: none yet)
  sent,       \* a comment GitHub took whose answer Kin has not stored yet (0: none)
  hourTriage, \* triage wakes in the repo this hour
  hourOut,    \* outside wakes in the org this hour
  hours,
  offWoke,    \* a look that read the switch off woke triage
  lateWoke    \* triage woke while the switch was off

vars == <<item, thread, cursor, handled, capped, wakes, pending, reactions, phase, upTo, at, woken,
          later, react, hourWakes, notes, stops, triageOn, looks, seenTo, kinSaid, sent, hourTriage,
          hourOut, hours, offWoke, lateWoke>>
pullVars == <<cursor, capped, reactions, phase, upTo, at, woken, later, react, hourWakes, notes>>
issueVars == <<triageOn, looks, seenTo, kinSaid, sent, hourTriage, hourOut, hours, offWoke, lateWoke>>

Things == 1..(IF MaxThings > MaxIssue THEN MaxThings ELSE MaxIssue)
NotLooking == [cand |-> 0, read |-> 0, on |-> TRUE]

(* githubTriggers.ts decideTriggers: a teammate's PR (review) or /kin (call) is a trigger; a
   stranger's /kin is not (isInside), and text with the agent's marker never is (isAgentText). *)
Inside(k) == k \in {"pr", "call"}
Trigger(k) ==
  \/ Inside(k)
  \/ Broken = "no-marker" /\ k = "own"
  \/ Broken = "stranger-calls" /\ k = "stranger"

Init ==
  /\ item \in Items
  /\ thread = <<>> /\ cursor = 0 /\ handled = {} /\ capped = {} /\ wakes = [i \in Things |-> 0]
  /\ pending = {} /\ reactions = [i \in Things |-> 0]
  /\ phase = "idle" /\ upTo = 0 /\ at = 1 /\ woken = 0 /\ later = FALSE /\ react = 0
  /\ hourWakes = 0 /\ notes = 0 /\ stops = 0
  /\ triageOn = TRUE /\ looks = [l \in Looks |-> NotLooking] /\ seenTo = 0 /\ kinSaid = 0
  /\ sent = 0 /\ hourTriage = 0 /\ hourOut = 0 /\ hours = 0 /\ offWoke = FALSE /\ lateWoke = FALSE

(* People act on GitHub, whether Kin is running or not. *)
Happen(k) ==
  /\ item = "pull" /\ Len(thread) < MaxThings
  /\ thread' = Append(thread, k)
  /\ UNCHANGED <<item, capped, cursor, handled, wakes, pending, reactions, phase, upTo, at, woken,
                 later, react, hourWakes, notes, stops>>
  /\ UNCHANGED issueVars

(* github/GitHubWatch.ts poll: notifications since the cursor (If-Modified-Since) and the owner's
   own events (If-None-Match) say what changed; the look reads the thread as it is now. *)
StartLook ==
  /\ item = "pull" /\ phase = "idle" /\ react = 0
  /\ phase' = "looking" /\ upTo' = Len(thread) /\ at' = cursor + 1 /\ woken' = 0 /\ later' = FALSE
  \* Moving the cursor before weighing: a stop mid-look loses what was left.
  /\ cursor' = IF Broken = "cursor-first" THEN Len(thread) ELSE cursor
  /\ UNCHANGED <<item, capped, thread, handled, wakes, pending, reactions, react, hourWakes, notes,
                 stops>>
  /\ UNCHANGED issueVars

(* GitHubWatch.ts handle: in one transaction, skip a stored key; over the look's cap leave it for
   the next look (nothing stored); over the thread's hour stop it ("capped", one note); else store
   it and queue the wake-up whose dedupe key is the trigger's. *)
Weigh ==
  /\ item = "pull" /\ phase = "looking" /\ at <= upTo /\ react = 0
  /\ LET k == thread[at] IN
     IF ~Trigger(k) \/ (at \in handled /\ Broken \notin {"react-each-look", "wake-each-look"})
     THEN /\ at' = at + 1
          /\ UNCHANGED <<handled, wakes, pending, woken, later, react, hourWakes, notes, capped>>
     ELSE IF at \in handled /\ Broken = "react-each-look"
     \* The broken variant reacts again to what an earlier look already handled.
     THEN /\ at' = at + 1 /\ react' = at
          /\ UNCHANGED <<handled, wakes, pending, woken, later, hourWakes, notes, capped>>
     ELSE IF woken >= PerLook
     THEN IF Broken = "skip-over-cap"
          THEN /\ handled' = handled \cup {at} /\ at' = at + 1
               /\ UNCHANGED <<wakes, pending, woken, later, react, hourWakes, notes, capped>>
          ELSE /\ later' = TRUE /\ at' = at + 1
               /\ UNCHANGED <<handled, wakes, pending, woken, react, hourWakes, notes, capped>>
     ELSE IF hourWakes >= PerThread
     THEN /\ handled' = handled \cup {at} /\ capped' = capped \cup {at} /\ at' = at + 1
          /\ notes' = IF notes = 0 \/ Broken = "note-each" THEN notes + 1 ELSE notes
          /\ UNCHANGED <<wakes, pending, woken, later, react, hourWakes>>
     ELSE /\ handled' = handled \cup {at}
          /\ wakes' = [wakes EXCEPT ![at] = @ + 1]
          /\ pending' = pending \cup {at}
          /\ woken' = woken + 1 /\ hourWakes' = hourWakes + 1
          /\ at' = at + 1 /\ react' = at
          /\ UNCHANGED <<later, notes, capped>>
  /\ UNCHANGED <<item, thread, cursor, reactions, phase, upTo, stops>>
  /\ UNCHANGED issueVars

(* GitHubWatch.ts react: the 👀, after the commit; a stop before it leaves none. *)
React ==
  /\ react # 0
  /\ reactions' = [reactions EXCEPT ![react] = @ + 1]
  /\ react' = 0
  /\ UNCHANGED <<item, capped, thread, cursor, handled, wakes, pending, phase, upTo, at, woken, later,
                 hourWakes, notes, stops>>
  /\ UNCHANGED issueVars

(* The end of a look: the cursor moves only when nothing was left for the next look. *)
EndLook ==
  /\ item = "pull" /\ phase = "looking" /\ at > upTo /\ react = 0
  /\ cursor' = IF later THEN cursor ELSE upTo
  /\ phase' = "idle"
  /\ UNCHANGED <<item, capped, thread, handled, wakes, pending, reactions, upTo, at, woken, later,
                 react, hourWakes, notes, stops>>
  /\ UNCHANGED issueVars

(* The agent's turn (lead/WakeupRunner.ts): it answers on GitHub, signed (github/ghSign.ts), so its
   reply is on the thread with the marker. *)
Turn(i) ==
  /\ item = "pull" /\ i \in pending
  /\ pending' = pending \ {i}
  /\ thread' = IF Len(thread) < MaxThings THEN Append(thread, "own") ELSE thread
  /\ UNCHANGED <<item, capped, cursor, handled, wakes, reactions, phase, upTo, at, woken, later,
                 react, hourWakes, notes, stops>>
  /\ UNCHANGED issueVars

(* The server stops anywhere and starts again: what was stored stays, the looks in hand are gone,
   and so is a comment GitHub took before Kin stored its answer. Queued wake-ups stay queued. *)
Stop ==
  /\ stops < MaxStops
  /\ stops' = stops + 1
  /\ phase' = "idle" /\ react' = 0 /\ upTo' = 0 /\ at' = 1 /\ woken' = 0 /\ later' = FALSE
  /\ looks' = [l \in Looks |-> NotLooking] /\ sent' = 0
  /\ UNCHANGED <<item, capped, thread, cursor, handled, wakes, pending, reactions, hourWakes, notes>>
  /\ UNCHANGED <<triageOn, seenTo, kinSaid, hourTriage, hourOut, hours, offWoke, lateWoke>>

------------------------------------------------------------------------------------------------
(* Issue triage, on one new issue in a repo with triage on. The issue is opened since triage
   began and Kin's App is installed, so a stranger's issue may be triaged (appOn). *)
Repliers == {"person"}
  \cup (IF Broken = "own-wakes-reply" THEN {"own"} ELSE {})
  \cup (IF Broken = "bot-wakes-reply" THEN {"bot"} ELSE {})
RepliesWoken == Cardinality({i \in 2..Len(thread) : wakes[i] > 0})
\* A comment's author is in the company exactly when the issue's is (see the README's choices).
OutsideIssue == thread[1] = "out"

IssueHappen ==
  /\ item = "issue"
  /\ \/ thread = <<>> /\ \E k \in {"in", "out"} : thread' = <<k>>
     \/ thread # <<>> /\ Len(thread) < MaxIssue /\ \E k \in {"person", "bot"} : thread' = Append(thread, k)
  /\ UNCHANGED <<item, handled, wakes, pending, stops>> /\ UNCHANGED pullVars /\ UNCHANGED issueVars

(* github/githubWatchStore.ts setTriage: the owner turns "reply to new issues" off. *)
SwitchOff ==
  /\ item = "issue" /\ triageOn
  /\ triageOn' = FALSE
  /\ UNCHANGED <<item, thread, handled, wakes, pending, stops, looks, seenTo, kinSaid, sent,
                 hourTriage, hourOut, hours, offWoke, lateWoke>>
  /\ UNCHANGED pullVars

(* GitHubWatch.ts lookContext then weigh: the switch as the look begins (triageStates), Kin's
   history (triageHistory), the comments not yet seen, and decideTriggers: a new issue with no
   comment of Kin's yet is "triage"; after Kin's comment, the people's comments since it are one
   "triage_reply" keyed by the last, while replies are left. A look with nothing to claim marks
   what it read seen. *)
Read(l) ==
  /\ item = "issue" /\ looks[l].cand = 0 /\ thread # <<>>
  /\ LET on == triageOn \/ Broken = "ignore-off"
         after == {i \in 2..Len(thread) : i > seenTo /\ i > kinSaid /\ thread[i] \in Repliers}
         first == on /\ kinSaid = 0 /\ ~\E i \in 2..Len(thread) : thread[i] = "own"
         reply == on /\ kinSaid # 0 /\ after # {}
                  /\ (RepliesWoken < TriageReplies \/ Broken = "no-reply-cap")
         cand == IF first THEN 1
                 ELSE IF reply THEN CHOOSE i \in after : \A j \in after : j <= i
                 ELSE 0
     IN IF cand # 0 /\ cand \notin handled
        THEN /\ looks' = [looks EXCEPT ![l] = [cand |-> cand, read |-> Len(thread), on |-> triageOn]]
             /\ UNCHANGED seenTo
        ELSE /\ seenTo' = IF Len(thread) > seenTo THEN Len(thread) ELSE seenTo
             /\ UNCHANGED looks
  /\ UNCHANGED <<item, thread, handled, wakes, pending, stops, triageOn, kinSaid, sent, hourTriage,
                 hourOut, hours, offWoke, lateWoke>>
  /\ UNCHANGED pullVars

(* GitHubWatch.ts claimTrigger, one transaction: skip a stored key; past the hour's allowance
   (hasAutomaticAllowance: outside wakes per org, triage wakes per repo) leave it for a later look,
   its comments held unseen; a reply checks Kin's history again (triageHistory: Kin spoke before
   it, replies left) or is passed over; else store it and queue the wake-up. Then the look marks
   what it read seen. *)
Claim(l) ==
  /\ item = "issue" /\ looks[l].cand # 0
  /\ LET k == looks[l].cand
         outside == OutsideIssue
         full == \/ outside /\ hourOut >= OutsideHour /\ Broken # "no-outside-hour"
                 \/ hourTriage >= RepoHour /\ Broken # "no-repo-hour"
         ok == k = 1 \/ (kinSaid # 0 /\ kinSaid < k /\
                         (RepliesWoken < TriageReplies \/ Broken \in {"no-reply-cap", "reply-cap-at-look"}))
         seen == IF looks[l].read > seenTo THEN looks[l].read ELSE seenTo
     IN IF k \in handled
        THEN /\ seenTo' = seen
             /\ UNCHANGED <<handled, wakes, pending, hourTriage, hourOut, offWoke, lateWoke>>
        ELSE IF full
        THEN /\ seenTo' = IF k = 1 THEN seen ELSE seenTo
             /\ UNCHANGED <<handled, wakes, pending, hourTriage, hourOut, offWoke, lateWoke>>
        ELSE IF ~ok
        THEN /\ seenTo' = seen
             /\ UNCHANGED <<handled, wakes, pending, hourTriage, hourOut, offWoke, lateWoke>>
        ELSE /\ handled' = handled \cup {k}
             /\ wakes' = [wakes EXCEPT ![k] = @ + 1]
             /\ pending' = pending \cup {k}
             /\ hourTriage' = hourTriage + 1
             /\ hourOut' = IF outside THEN hourOut + 1 ELSE hourOut
             /\ offWoke' = (offWoke \/ ~looks[l].on)
             /\ lateWoke' = (lateWoke \/ ~triageOn)
             /\ seenTo' = seen
  /\ looks' = [looks EXCEPT ![l] = NotLooking]
  /\ UNCHANGED <<item, thread, stops, triageOn, kinSaid, sent, hours>>
  /\ UNCHANGED pullVars

(* The triage turn (lead/WakeupRunner.ts, github/boundIssue.ts postIssueComment): it ends quiet,
   or posts its one comment with kin_github_comment (review_url claimed once per key). A refused
   post stores nothing the rules count and leaves the turn free to try again or end quiet. *)
Quiet(i) ==
  /\ item = "issue" /\ i \in pending
  /\ pending' = pending \ {i}
  /\ UNCHANGED <<item, thread, handled, wakes, stops>> /\ UNCHANGED pullVars /\ UNCHANGED issueVars

Post(i) ==
  /\ item = "issue" /\ i \in pending /\ sent = 0 /\ Len(thread) < MaxIssue
  /\ pending' = pending \ {i}
  /\ thread' = Append(thread, "own")
  /\ sent' = Len(thread) + 1
  /\ UNCHANGED <<item, handled, wakes, stops, triageOn, looks, seenTo, kinSaid, hourTriage, hourOut,
                 hours, offWoke, lateWoke>>
  /\ UNCHANGED pullVars

(* GitHub's answer: stored as triaged:<ref> "posted" at the comment's time; or it never came
   ("unknown"), and the comment is on the issue with nothing stored. *)
Answer(told) ==
  /\ item = "issue" /\ sent # 0
  /\ kinSaid' = IF told THEN sent ELSE kinSaid
  /\ sent' = 0
  /\ UNCHANGED <<item, thread, handled, wakes, pending, stops, triageOn, looks, seenTo, hourTriage,
                 hourOut, hours, offWoke, lateWoke>>
  /\ UNCHANGED pullVars

(* An hour ends: the allowances count wakes of the past hour only. *)
HourEnds ==
  /\ item = "issue" /\ hours < MaxHours
  /\ hours' = hours + 1 /\ hourTriage' = 0 /\ hourOut' = 0
  /\ UNCHANGED <<item, thread, handled, wakes, pending, stops, triageOn, looks, seenTo, kinSaid,
                 sent, offWoke, lateWoke>>
  /\ UNCHANGED pullVars

Next ==
  \/ \E k \in Kinds : Happen(k)
  \/ StartLook \/ Weigh \/ React \/ EndLook \/ Stop
  \/ \E i \in Things : Turn(i)
  \/ IssueHappen \/ SwitchOff \/ HourEnds
  \/ \E l \in Looks : Read(l) \/ Claim(l)
  \/ \E i \in Things : Quiet(i) \/ Post(i)
  \/ \E told \in BOOLEAN : Answer(told)

Spec == Init /\ [][Next]_vars

------------------------------------------------------------------------------------------------
OnceEach == \A i \in Things : wakes[i] <= 1
NoneLost ==
  (item = "pull" /\ phase = "idle" /\ cursor = Len(thread)) =>
    \A i \in 1..Len(thread) : Inside(thread[i]) => wakes[i] > 0 \/ i \in capped
OutsideStartsNothing ==
  item = "pull" => \A i \in 1..Len(thread) : wakes[i] > 0 => Inside(thread[i])
OneReaction == \A i \in Things : reactions[i] <= 1
OneNotePerHour == notes <= 1

RepliesCapped ==
  item = "issue" =>
    /\ RepliesWoken <= TriageReplies
    /\ Cardinality({i \in 1..Len(thread) : thread[i] = "own"}) <= 1 + TriageReplies
NoReplyToSelf == item = "issue" => \A i \in 2..Len(thread) : wakes[i] > 0 => thread[i] = "person"
OffNextLook == ~offWoke
\* Not in the config: it does not hold (the README's MUST FIX). Add it once the claim re-reads
\* the switch.
OffAtOnce == ~lateWoke
RepoHourCapped == hourTriage <= RepoHour
OutsideHourCapped == hourOut <= OutsideHour
=============================================================================
