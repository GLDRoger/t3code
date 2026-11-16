---------------------------- MODULE Social ----------------------------
(* A week of social posts: Social drafts and shows them on one card per group, the owner removes,
   notes a client's OK and taps Confirm, Kin hands each post to the posting service, the owner may
   Undo or Retry, the service posts or fails, accounts move, keys change and Kin restarts. Each
   action names the code it stands for (paths under apps/server/src/kin/social). One action is one
   transaction, or one step of the scheduler's pass. *)
EXTENDS Naturals, FiniteSets

CONSTANTS Broken, Posts

\* Post 3 is a client's; the others are the company's own. Post 2 is a second post on the company's
\* card that is only shown, removed or confirmed, never handed over: it keeps the state space small.
Grp(p) == IF p = 3 THEN "client" ELSE "own"
Full == Posts \ {2}
Groups == {"own", "client"}
Accounts == {"a1", "a2"}
\* The accounts each group's profile held when it was connected (kin_social_groups.accounts_json).
Home == [a \in Accounts |-> IF a = "a1" THEN "own" ELSE "client"]
\* Idempotency keys one post can use: one per Confirm, and a second only in a broken variant.
Keys == {1, 2}
After == {"due", "late"}

VARIABLES
  st,          \* kin_social_posts.state; "none" before Social drafts it
  ver,         \* the post's wording and time: 2 after an edit
  acct,        \* kin_social_posts.account_id
  shown,       \* the version the group's card showed for it (its digest)
  removedEver, \* the owner removed it from a card
  drawn, replaced, confirmed, ok, \* per group: the week card, and the client-OK switch
  conShown,    \* the version Confirm signed for it
  okAtConfirm, \* the client's OK was on when Confirm was tapped
  attempted,   \* kin_social_posts.attempt_at: a schedule call may have reached the service
  sid,         \* kin_social_posts.service_post_id is saved
  pc,          \* the pass's step for this post: "called" while the service's answer is unsaved
  lateOk,      \* confirmed_at is after its time: the owner's Retry allows posting late
  retried, reason, tried,
  svc,         \* the posting service's entries for this post, one per idempotency key
  svcVer, svcProf, calls,
  prof,        \* which group's profile each account is in at the service now
  reach,       \* the profiles each group's key reaches now
  clock,       \* "before" the Undo window closes, "closing", "due", "late" (Kin was off at its time)
  edits, restarts, errors, moves, widens

post == <<st, ver, acct, shown, removedEver, conShown, okAtConfirm, attempted, sid, pc, lateOk,
          retried, reason, tried>>
card == <<drawn, replaced, confirmed, ok>>
service == <<svc, svcVer, svcProf, calls, prof, reach>>
trouble == <<edits, restarts, errors, moves, widens>>
vars == <<post, card, service, clock, trouble>>

\* The bound: at most two kinds of trouble in one run, each at most once.
Trouble == restarts + errors + moves + widens
Calm == Trouble < 2
Idle == \A q \in Posts : pc[q] = "idle"
Key(p) == IF calls[p] = 0 THEN 1 ELSE calls[p]

Init ==
  /\ st = [p \in Posts |-> "none"] /\ ver = [p \in Posts |-> 0] /\ acct = [p \in Posts |-> ""]
  /\ shown = [p \in Posts |-> 0] /\ removedEver = [p \in Posts |-> FALSE]
  /\ drawn = [g \in Groups |-> FALSE] /\ replaced = [g \in Groups |-> FALSE]
  /\ confirmed = [g \in Groups |-> FALSE] /\ ok = [g \in Groups |-> FALSE]
  /\ conShown = [p \in Posts |-> 0] /\ okAtConfirm = [p \in Posts |-> FALSE]
  /\ attempted = [p \in Posts |-> FALSE] /\ sid = [p \in Posts |-> FALSE]
  /\ pc = [p \in Posts |-> "idle"] /\ lateOk = [p \in Posts |-> FALSE]
  /\ retried = [p \in Posts |-> FALSE] /\ reason = [p \in Posts |-> ""]
  /\ tried = [p \in Posts |-> FALSE]
  /\ svc = [p \in Posts |-> [k \in Keys |-> "none"]]
  /\ svcVer = [p \in Posts |-> [k \in Keys |-> 0]]
  /\ svcProf = [p \in Posts |-> [k \in Keys |-> ""]]
  /\ calls = [p \in Posts |-> 0]
  /\ prof = Home /\ reach = [g \in Groups |-> {g}]
  /\ clock = "before"
  /\ edits = 0 /\ restarts = 0 /\ errors = 0 /\ moves = 0 /\ widens = 0

(* SocialService.ts draft: Kin refuses an account outside the post's group. *)
AgentDrafts(p, a) ==
  /\ st[p] = "none" /\ Home[a] = Grp(p)
  /\ st' = [st EXCEPT ![p] = "draft"] /\ ver' = [ver EXCEPT ![p] = 1]
  /\ acct' = [acct EXCEPT ![p] = a]
  /\ UNCHANGED <<shown, removedEver, conShown, okAtConfirm, attempted, sid, pc, lateOk, retried,
                 reason, tried, card, service, clock, trouble>>

(* SocialService.ts draft with postId: only a draft or a post waiting for Confirm can change, and
   that puts it back to draft and marks its card replaced. *)
AgentEdits(p) ==
  /\ edits < 1
  /\ \/ st[p] \in {"draft", "proposed"}
     \/ Broken = "edit-after-confirm" /\ st[p] \in {"scheduling", "scheduled"}
  /\ ver' = [ver EXCEPT ![p] = 2]
  /\ IF st[p] = "proposed" /\ Broken # "no-replace-no-digest"
       THEN /\ st' = [st EXCEPT ![p] = "draft"]
            /\ replaced' = [replaced EXCEPT ![Grp(p)] = TRUE]
       ELSE UNCHANGED <<st, replaced>>
  /\ edits' = edits + 1
  /\ UNCHANGED <<acct, shown, removedEver, conShown, okAtConfirm, attempted, sid, pc, lateOk,
                 retried, reason, tried, drawn, confirmed, ok, service, clock, restarts, errors,
                 moves, widens>>

(* SocialService.ts week and cards.ts writeWeekCard: the group's drafts still to come, on one
   card that shows each post as it is now. *)
ShowWeek(g) ==
  /\ ~drawn[g] \/ replaced[g]
  /\ LET ds == {p \in Posts : Grp(p) = g /\ st[p] \in {"draft", "proposed"}} IN
       /\ ds # {}
       /\ st' = [p \in Posts |-> IF p \in ds THEN "proposed" ELSE st[p]]
       /\ shown' = [p \in Posts |-> IF p \in ds THEN ver[p] ELSE shown[p]]
  /\ drawn' = [drawn EXCEPT ![g] = TRUE] /\ replaced' = [replaced EXCEPT ![g] = FALSE]
  /\ confirmed' = [confirmed EXCEPT ![g] = FALSE] /\ ok' = [ok EXCEPT ![g] = FALSE]
  /\ UNCHANGED <<ver, acct, removedEver, conShown, okAtConfirm, attempted, sid, pc, lateOk,
                 retried, reason, tried, service, clock, trouble>>

(* cards.ts applyWeekTap "remove". *)
OwnerRemoves(p) ==
  /\ st[p] = "proposed" /\ ~replaced[Grp(p)]
  /\ st' = [st EXCEPT ![p] = "removed"] /\ removedEver' = [removedEver EXCEPT ![p] = TRUE]
  /\ UNCHANGED <<ver, acct, shown, conShown, okAtConfirm, attempted, sid, pc, lateOk, retried,
                 reason, tried, card, service, clock, trouble>>

(* cards.ts applyWeekTap "client_ok". *)
ClientSaysOk ==
  /\ drawn["client"] /\ ~ok["client"] /\ ~confirmed["client"]
  /\ ok' = [ok EXCEPT !["client"] = TRUE]
  /\ UNCHANGED <<post, drawn, replaced, confirmed, service, clock, trouble>>

(* cards.ts applyWeekTap "confirm": refused on a replaced card, without a client's OK, or when the
   rows no longer match the digest the card showed; then every post still proposed is confirmed. *)
OwnerConfirms(g) ==
  /\ drawn[g] /\ ~confirmed[g] /\ ~replaced[g]
  /\ ok[g] \/ g = "own" \/ Broken = "no-client-ok"
  /\ LET ps == {p \in Posts : Grp(p) = g /\ st[p] = "proposed"}
         on == IF Broken = "confirm-all-on-card"
                 THEN ps \cup {p \in Posts : Grp(p) = g /\ st[p] = "removed"}
                 ELSE ps
     IN /\ ps # {}
        /\ (\A p \in ps : shown[p] = ver[p]) \/ Broken = "no-replace-no-digest"
        /\ st' = [p \in Posts |-> IF p \in on THEN "scheduling" ELSE st[p]]
        /\ conShown' = [p \in Posts |-> IF p \in on THEN shown[p] ELSE conShown[p]]
        /\ okAtConfirm' = [p \in Posts |-> IF p \in on THEN ok[g] ELSE okAtConfirm[p]]
  /\ confirmed' = [confirmed EXCEPT ![g] = TRUE]
  /\ UNCHANGED <<ver, acct, shown, removedEver, attempted, sid, pc, lateOk, retried, reason,
                 tried, drawn, replaced, ok, service, clock, trouble>>

\* Refused for its account: "nothing was sent" only when no earlier attempt may have reached the service.
AccountReason(p) == IF attempted[p] /\ Broken # "old-account-message" THEN "account-unknown" ELSE "account"

(* SocialService.ts handOver, one step of the pass (single permit, so one post at a time). A post
   handed over before (a Retry of a failed one) is retried at the service. One confirmed for a time
   that passed while Kin was off fails, saying whether an earlier attempt may have reached the
   service. Otherwise the group's key must reach exactly its profile and the account be in it now;
   attempt_at is written before the call, and the call carries the post's idempotency key. *)
KinHandsOver(p) ==
  /\ st[p] = "scheduling" /\ Idle
  /\ ~(Broken = "no-resume" /\ attempted[p])
  /\ IF sid[p] THEN
       /\ svc[p][Key(p)] = "failed"
       /\ svc' = [svc EXCEPT ![p][Key(p)] = "scheduled"]
       /\ st' = [st EXCEPT ![p] = "scheduled"]
       /\ UNCHANGED <<reason, attempted, pc, svcVer, svcProf, calls>>
     ELSE IF clock = "late" /\ ~lateOk[p] THEN
       /\ st' = [st EXCEPT ![p] = "failed"]
       /\ reason' = [reason EXCEPT ![p] =
            IF attempted[p] /\ Broken # "old-late-message" THEN "late-unknown" ELSE "late-unsent"]
       /\ UNCHANGED <<attempted, pc, svc, svcVer, svcProf, calls>>
     ELSE IF Broken # "no-send-check" /\ ~(reach[Grp(p)] = {Grp(p)} /\ prof[acct[p]] = Grp(p)) THEN
       /\ st' = [st EXCEPT ![p] = "failed"] /\ reason' = [reason EXCEPT ![p] = AccountReason(p)]
       /\ UNCHANGED <<attempted, pc, svc, svcVer, svcProf, calls>>
     ELSE
       LET k == IF Broken = "new-key-per-attempt" THEN calls[p] + 1 ELSE 1 IN
       /\ k \in Keys
       /\ attempted' = [attempted EXCEPT ![p] = TRUE]
       /\ calls' = [calls EXCEPT ![p] = k]
       /\ IF prof[acct[p]] \notin reach[Grp(p)]
            \* The service refuses an account the key can't reach.
            THEN /\ st' = [st EXCEPT ![p] = "failed"] /\ reason' = [reason EXCEPT ![p] = AccountReason(p)]
                 /\ UNCHANGED <<pc, svc, svcVer, svcProf>>
            ELSE /\ IF svc[p][k] = "none"
                      THEN /\ svc' = [svc EXCEPT ![p][k] = "scheduled"]
                           /\ svcVer' = [svcVer EXCEPT ![p][k] = ver[p]]
                           /\ svcProf' = [svcProf EXCEPT ![p][k] = prof[acct[p]]]
                      ELSE UNCHANGED <<svc, svcVer, svcProf>>
                 /\ pc' = [pc EXCEPT ![p] = "called"]
                 /\ UNCHANGED <<st, reason>>
  /\ UNCHANGED <<ver, acct, shown, removedEver, conShown, okAtConfirm, sid, lateOk, retried, tried,
                 card, prof, reach, clock, trouble>>

(* handOver's end: the service id is saved whatever the post's state now (an Undo may have landed
   during the call), and a post still scheduling becomes scheduled. *)
KinSaves(p) ==
  /\ pc[p] = "called"
  /\ sid' = [sid EXCEPT ![p] = TRUE]
  /\ st' = [st EXCEPT ![p] = IF st[p] = "scheduling" THEN "scheduled" ELSE st[p]]
  /\ pc' = [pc EXCEPT ![p] = "idle"]
  /\ UNCHANGED <<ver, acct, shown, removedEver, conShown, okAtConfirm, attempted, lateOk, retried,
                 reason, tried, card, service, clock, trouble>>

(* onError with an unknown outcome (unavailable, rate limit): the answer is lost, the next pass
   calls again with the same key. *)
AnswerLost(p) ==
  /\ pc[p] = "called" /\ Calm
  /\ pc' = [pc EXCEPT ![p] = "idle"] /\ errors' = errors + 1
  /\ UNCHANGED <<st, ver, acct, shown, removedEver, conShown, okAtConfirm, attempted, sid, lateOk,
                 retried, reason, tried, card, service, clock, edits, restarts, moves, widens>>

(* Kin restarts: the pass in flight is gone; the rows stay. *)
Restart ==
  /\ Calm
  /\ pc' = [p \in Posts |-> "idle"] /\ restarts' = restarts + 1
  /\ UNCHANGED <<st, ver, acct, shown, removedEver, conShown, okAtConfirm, attempted, sid, lateOk,
                 retried, reason, tried, card, service, clock, edits, errors, moves, widens>>

(* cards.ts applyWeekTap "undo": while the post is more than 5 minutes away. *)
OwnerUndoes(p) ==
  /\ st[p] \in {"scheduling", "scheduled"} /\ clock = "before"
  /\ st' = [st EXCEPT ![p] = "undoing"] /\ tried' = [tried EXCEPT ![p] = FALSE]
  /\ UNCHANGED <<ver, acct, shown, removedEver, conShown, okAtConfirm, attempted, sid, pc, lateOk,
                 retried, reason, card, service, clock, trouble>>

(* SocialService.ts cancelOne, run by the pass the tap starts. With no saved id but an attempt that
   may have reached the service, the same key finds what it made. A post the service already sent
   can't be deleted: the card goes back to scheduled, saying Undo didn't go through. *)
KinCancels(p) ==
  /\ st[p] = "undoing" /\ Idle
  /\ LET known == sid[p] \/ (attempted[p] /\ Broken # "no-rederive")
         k == Key(p)
     IN IF Broken = "local-undo" \/ ~known \/ svc[p][k] = "none"
          THEN /\ st' = [st EXCEPT ![p] = "cancelled"]
               /\ UNCHANGED <<svc, sid, reason>>
          ELSE IF svc[p][k] = "posted"
            THEN /\ st' = [st EXCEPT ![p] = "scheduled"]
                 /\ reason' = [reason EXCEPT ![p] = "undo-late"]
                 /\ sid' = [sid EXCEPT ![p] = TRUE]
                 /\ UNCHANGED svc
            ELSE /\ svc' = [svc EXCEPT ![p][k] = "cancelled"]
                 /\ st' = [st EXCEPT ![p] = "cancelled"]
                 /\ UNCHANGED <<sid, reason>>
  /\ UNCHANGED <<ver, acct, shown, removedEver, conShown, okAtConfirm, attempted, pc, lateOk,
                 retried, tried, card, svcVer, svcProf, calls, prof, reach, clock, trouble>>

(* onError on an undoing post with an unknown outcome: it stays undoing for the next pass. *)
CancelLost(p) ==
  /\ st[p] = "undoing" /\ ~tried[p] /\ Idle /\ Calm
  /\ tried' = [tried EXCEPT ![p] = TRUE] /\ errors' = errors + 1
  /\ UNCHANGED <<st, ver, acct, shown, removedEver, conShown, okAtConfirm, attempted, sid, pc,
                 lateOk, retried, reason, card, service, clock, edits, restarts, moves, widens>>

(* The pass reads a scheduled post after its time (provider.status) and settles the card. *)
KinReads(p) ==
  /\ st[p] = "scheduled" /\ sid[p] /\ clock \in After /\ Idle
  /\ LET s == svc[p][Key(p)] IN
       /\ s \in {"posted", "failed", "cancelled"}
       /\ st' = [st EXCEPT ![p] = s]
       /\ reason' = [reason EXCEPT ![p] = IF s = "failed" THEN "platform" ELSE ""]
  /\ UNCHANGED <<ver, acct, shown, removedEver, conShown, okAtConfirm, attempted, sid, pc, lateOk,
                 retried, tried, card, service, clock, trouble>>

(* cards.ts applyWeekTap "retry": back to scheduling, and confirmed_at is now, so a post whose
   time passed goes out now rather than failing as late again. *)
OwnerRetries(p) ==
  /\ st[p] = "failed"
  /\ st' = [st EXCEPT ![p] = "scheduling"] /\ reason' = [reason EXCEPT ![p] = ""]
  /\ retried' = [retried EXCEPT ![p] = TRUE]
  /\ lateOk' = [lateOk EXCEPT ![p] = (Broken # "late-retry-stuck")]
  /\ UNCHANGED <<ver, acct, shown, removedEver, conShown, okAtConfirm, attempted, sid, pc, tried,
                 card, service, clock, trouble>>

(* The posting service at the post's time. *)
ServicePosts(p, k) ==
  /\ svc[p][k] = "scheduled" /\ clock \in After
  /\ svc' = [svc EXCEPT ![p][k] = "posted"]
  /\ UNCHANGED <<post, card, svcVer, svcProf, calls, prof, reach, clock, trouble>>

ServiceFails(p, k) ==
  /\ svc[p][k] = "scheduled" /\ clock \in After /\ Calm
  /\ svc' = [svc EXCEPT ![p][k] = "failed"] /\ errors' = errors + 1
  /\ UNCHANGED <<post, card, svcVer, svcProf, calls, prof, reach, clock, edits, restarts, moves,
                 widens>>

(* At the service, the owner moves the company's account into the client's profile. *)
AccountMoves ==
  /\ moves = 0 /\ Calm
  /\ prof' = [prof EXCEPT !["a1"] = "client"] /\ moves' = 1
  /\ UNCHANGED <<post, card, svc, svcVer, svcProf, calls, reach, clock, edits, restarts, errors,
                 widens>>

(* At the service, a group's key is changed to reach every profile. *)
KeyWidens(g) ==
  /\ widens = 0 /\ Calm
  /\ reach' = [reach EXCEPT ![g] = Groups] /\ widens' = 1
  /\ UNCHANGED <<post, card, svc, svcVer, svcProf, calls, prof, clock, edits, restarts, errors,
                 moves>>

(* Time. Undo closes 5 minutes before the post's time, and the pass a tap starts runs at once:
   the model lets the time come only after that pass has tried to cancel. "late" is a time that
   passed while Kin was off. *)
Tick ==
  /\ \/ clock = "before" /\ clock' = "closing"
     \/ clock = "closing" /\ (\A p \in Posts : st[p] = "undoing" => tried[p]) /\ clock' = "due"
     \/ clock = "due" /\ restarts > 0 /\ clock' = "late"
  /\ UNCHANGED <<post, card, service, trouble>>

Next ==
  \/ \E p \in Posts, a \in Accounts : AgentDrafts(p, a)
  \/ \E p \in Posts : OwnerRemoves(p)
  \/ \E p \in Full : AgentEdits(p) \/ KinHandsOver(p) \/ KinSaves(p) \/ KinCancels(p)
       \/ AnswerLost(p) \/ OwnerUndoes(p) \/ CancelLost(p) \/ KinReads(p) \/ OwnerRetries(p)
  \/ \E g \in Groups : ShowWeek(g) \/ OwnerConfirms(g) \/ KeyWidens(g)
  \/ \E p \in Full, k \in Keys : ServicePosts(p, k) \/ ServiceFails(p, k)
  \/ ClientSaysOk \/ Restart \/ AccountMoves \/ Tick

Fair == \A p \in Full : WF_vars(KinHandsOver(p)) /\ WF_vars(KinSaves(p)) /\ WF_vars(KinCancels(p))

Spec == Init /\ [][Next]_vars /\ Fair

----------------------------------------------------------------------------
Made(p, k) == svc[p][k] # "none"

\* Only a Confirm covering that exact version of the post puts it at the service.
ConfirmCovers == \A p \in Posts, k \in Keys : Made(p, k) => conShown[p] > 0 /\ svcVer[p][k] = conShown[p]
\* A post goes only to an account in its own group's profile.
NeverOtherGroup == \A p \in Posts, k \in Keys : Made(p, k) => svcProf[p][k] = Grp(p)
RemovedNeverScheduled == \A p \in Posts : removedEver[p] => st[p] = "removed" /\ \A k \in Keys : ~Made(p, k)
ClientNeedsOk == \A p \in Posts, k \in Keys : (Grp(p) = "client" /\ Made(p, k)) => okAtConfirm[p]
\* Restarts and lost answers never make a second entry for one post.
AtMostOneEntry == \A p \in Posts : Cardinality({k \in Keys : Made(p, k)}) <= 1
\* Cancelled on the card means nothing at the service can still go out.
CancelledIsTrue == \A p \in Posts : st[p] = "cancelled" => \A k \in Keys : svc[p][k] \in {"none", "cancelled"}
LateIsTrue == \A p \in Posts : (st[p] = "failed" /\ reason[p] = "late-unsent") => \A k \in Keys : ~Made(p, k)
AccountFailIsTrue == \A p \in Posts : (st[p] = "failed" /\ reason[p] = "account") => \A k \in Keys : ~Made(p, k)
PostedIsTrue == \A p \in Posts : st[p] = "posted" => \E k \in Keys : svc[p][k] = "posted"
RetryNeverLate == \A p \in Posts : retried[p] => ~(st[p] = "failed" /\ reason[p] \in {"late-unsent", "late-unknown"})

\* After Confirm, a post never stays on Scheduling: restarts don't lose it.
ConfirmedSettles == \A p \in Full : st[p] = "scheduling" ~> st[p] # "scheduling"
\* An Undo Kin took cancels the post, unless the service couldn't be reached in time.
UndoCancels == \A p \in Full : st[p] = "undoing" ~> (st[p] = "cancelled" \/ tried[p])
=============================================================================
