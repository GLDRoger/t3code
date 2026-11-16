#!/usr/bin/env bash
# Social on the fake Zernio. With nothing connected, a pack and its reminder. Then our own accounts
# connected in Settings and a client's over RPC; Social reads the numbers, drafts five posts (a
# picture-less Instagram post and a client's account are refused), puts them on one card; the owner
# removes one and confirms, four are scheduled, Undo cancels one, three go out, one fails and Retry
# posts it. Each post reached the service once, on its own group's account.
source "$(dirname "$0")/lib.sh"
MODEL='{"instanceId":"kinVerifyScript","model":"script"}'
AGENT="Social $RUN"
get() { node -e 'let v=JSON.parse(process.argv[1]);for(const k of process.argv[2].split("."))v=v?.[k];process.stdout.write(typeof v==="string"?v:JSON.stringify(v??null))' "$1" "$2"; }
# A time this many hours ahead, in the owner's zone.
at() { node -e 'const d=new Date(Date.now()+Number(process.argv[1])*3600e3+19800e3);process.stdout.write(d.toISOString().slice(0,16)+":00+05:30")' "$1"; }
act() { # card action value
  local rev
  rev="$(card_revision "$1")"
  kv as owner rpc kin.widgets.act "{\"widgetId\":\"$1\",\"revision\":$rev,\"actionId\":\"$2\",\"value\":$3,\"clientActionId\":\"$2-$RUN-$rev\"}" >/dev/null
}
post_state() { kv db "select state from kin_social_posts where caption like '$1%'" | tail -1; }
count() { kv db "$1" | tail -1; }

# A fresh start for this run: no groups from an earlier one.
for group in $(kv as owner rpc kin.social.list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).groups.map(g=>g.groupId).join(" ")))'); do
  kv as owner rpc kin.social.remove "{\"groupId\":\"$group\"}" >/dev/null
done
created="$(kv as owner rpc kin.lead.create "{\"name\":\"$AGENT\",\"domain\":\"social-$RUN\",\"charter\":\"Runs the studio's own social accounts and its clients' calendars.\",\"models\":{\"strong\":$MODEL,\"cheap\":$MODEL}}")"
CHAT="$(get "$created" ownerChatId)"
lumen_client="$(kv as owner rpc kin.social.list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s).clients.find(c=>/lumen/i.test(c.label)))))')"
LUMEN="$(get "$lumen_client" clientId)"
LUMEN_LABEL="$(get "$lumen_client" label)"

# Nothing connected: Social still plans, as a pack with a reminder at its time.
read="$(kv tool "$AGENT" social_read '{}')"
expect_in "$read" "No social accounts are connected" "social_read didn't say nothing is connected: $read"
pack="$(kv tool "$AGENT" social_pack "{\"where\":\"Instagram Story, @ambermill\",\"why\":\"Not connected yet\",\"caption\":\"Pack $RUN: studio tour on Friday ☕\",\"at\":\"$(at 30)\",\"chatId\":\"\$chat\",\"sourceEventId\":\"\$event\"}")"
expect_in "$pack" "packId" "no pack: $pack"
[[ "$(count "select count(*) from kin_widgets where state_json like '%Pack $RUN%'")" == 1 ]] || fail "no pack card in the owner's chat"
[[ "$(count "select count(*) from kin_widgets where state_json like '%Pack $RUN%' and json_extract(state_json, '\$.reminderId') is not null")" == 1 ]] || fail "the pack set no reminder"

# Our own accounts, connected in Settings › Connections › Social accounts with a key for one profile.
own="$(kv social profile "Ambermill $RUN" linkedin:"Ambermill Studio" threads:amb$RUN instagram:amb$RUN)"
own_profile="$(get "$own" profileId)"
kv social past "$own_profile" '[{"platform":"linkedin","content":"Behind the lens: the Saffron Lane shoot","likes":412,"saves":91,"shares":22,"reach":6120},{"platform":"threads","content":"New business cards are in","likes":41,"reach":880}]' >/dev/null
kv as owner web open settings/connections >/dev/null
kv as owner web wait "Social accounts" >/dev/null || fail "Connections has no Social accounts section"
kv as owner web click --name "Connect accounts" >/dev/null
kv as owner web type --name "Profile key" "$(get "$own" key)" >/dev/null
kv as owner web click --name "Check the key" >/dev/null
kv as owner web wait "This key reaches" >/dev/null || fail "checking the key listed no accounts"
kv as owner web click --name "Connect these accounts" >/dev/null
kv as owner web wait "Ambermill $RUN" >/dev/null || fail "our own group isn't listed after connecting"
# A key that reaches every profile is refused; a member can't list them.
whole="$(kv social profile "Whole $RUN" linkedin:whole$RUN all-profiles)"
refused="$(kv as owner rpc kin.social.check "{\"kind\":\"client\",\"clientId\":\"$LUMEN\",\"key\":\"$(get "$whole" key)\"}" 2>&1 || true)"
expect_in "$refused" "kin-verify:" "a key reaching every profile was accepted: $refused"
member="$(kv as zoya rpc kin.social.list 2>&1 || true)"
expect_in "$member" "kin-verify:" "a member read the social accounts: $member"
# The client, Lumen Studio, over RPC as the phone does.
client="$(kv social profile "Lumen $RUN" facebook:"Lumen Studio" instagram:lumen$RUN)"
check="$(kv as owner rpc kin.social.check "{\"kind\":\"client\",\"clientId\":\"$LUMEN\",\"key\":\"$(get "$client" key)\"}")"
kv as owner rpc kin.social.connect "{\"checkId\":\"$(get "$check" checkId)\"}" >/dev/null

# Social reads real numbers, and drafts. Media is checked before any card.
read="$(kv tool "$AGENT" social_read '{"group":"our own"}')"
expect_in "$read" "Saffron Lane" "social_read didn't give last week's posts"
expect_in "$read" "412" "social_read didn't give the numbers"
nopic="$(kv tool "$AGENT" social_draft "{\"group\":\"our own\",\"account\":\"instagram\",\"caption\":\"Picture-less $RUN\",\"at\":\"$(at 40)\"}" 2>&1 || true)"
expect_in "$nopic" "needs a picture" "an Instagram post without a picture was drafted: $nopic"
other="$(kv tool "$AGENT" social_draft "{\"group\":\"our own\",\"account\":\"lumen$RUN\",\"caption\":\"Wrong group $RUN\",\"at\":\"$(at 40)\"}" 2>&1 || true)"
[[ "$(count "select count(*) from kin_social_posts where caption = 'Wrong group $RUN'")" == 0 ]] || fail "a client's account took our own post: $other"
for i in 1 2 3 4 5; do
  platform="$([[ $((i % 2)) == 1 ]] && echo linkedin || echo threads)"
  kv tool "$AGENT" social_draft "{\"group\":\"our own\",\"account\":\"$platform\",\"caption\":\"W$RUN post $i: behind the lens ✨\",\"at\":\"$(at $((40 + i * 2)))\"}" >/dev/null
done
kv tool "$AGENT" social_draft "{\"group\":\"$LUMEN_LABEL\",\"account\":\"facebook\",\"caption\":\"L$RUN: a 1BHK in warm light only\",\"at\":\"$(at 50)\"}" >/dev/null
[[ "$(kv social posts | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).filter(p=>p.content.includes(process.argv[1])).length)))' "$RUN")" == 0 ]] ||
  fail "a draft reached the service before any Confirm"

# One card for our own; the client's card waits for the client's OK.
kv tool "$AGENT" social_week '{"group":"our own"}' >/dev/null
kv tool "$AGENT" social_week "{\"group\":\"$LUMEN_LABEL\"}" >/dev/null
card="$(card_id "W$RUN post 1")"
lumen="$(card_id "L$RUN")"
kv as owner web open "$CHAT" >/dev/null
kv as owner web wait "W$RUN post 5" >/dev/null || fail "the week card isn't in the owner's chat"
digest() { kv db "select json_extract(state_json, '\$.digest') from kin_widgets where widget_id = '$1'" | tail -1; }
early="$(kv as owner rpc kin.widgets.act "{\"widgetId\":\"$lumen\",\"revision\":$(card_revision "$lumen"),\"actionId\":\"confirm\",\"value\":\"$(digest "$lumen")\",\"clientActionId\":\"early-$RUN\"}" 2>&1 || true)"
expect_in "$early" "said OK" "the client's week confirmed without the client's OK: $early"
act "$card" remove "\"$(count "select post_id from kin_social_posts where caption like 'W$RUN post 5%'")\""
act "$card" confirm "\"$(digest "$card")\""
scheduled() { count "select count(*) from kin_social_posts where caption like 'W$RUN%' and state = 'scheduled'"; }
for _ in $(seq 1 60); do [[ "$(scheduled)" == 4 ]] && break; sleep 0.5; done
[[ "$(scheduled)" == 4 ]] || fail "Confirm scheduled $(scheduled) posts, not 4"
[[ "$(post_state "W$RUN post 5")" == removed ]] || fail "the removed post left its removed state"

# Undo one; it is cancelled at the service.
act "$card" undo "\"$(count "select post_id from kin_social_posts where caption like 'W$RUN post 4%'")\""
for _ in $(seq 1 60); do [[ "$(post_state "W$RUN post 4")" == cancelled ]] && break; sleep 0.5; done
[[ "$(post_state "W$RUN post 4")" == cancelled ]] || fail "Undo didn't cancel the post"

# The time comes: two go out, one fails on the platform with its reason; Retry posts it.
li="$(kv social accounts "$own_profile" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).find(a=>a.platform==="linkedin").accountId))')"
kv social fail-next "$li" "LinkedIn refused it: duplicate content." >/dev/null
kv clock advance 50h >/dev/null
settled() { count "select count(*) from kin_social_posts where caption like 'W$RUN%' and state in ('posted','failed')"; }
for _ in $(seq 1 240); do [[ "$(settled)" == 3 ]] && break; sleep 0.5; done
[[ "$(settled)" == 3 ]] || fail "only $(settled) of 3 posts settled after their time"
failed="$(count "select post_id from kin_social_posts where caption like 'W$RUN%' and state = 'failed'")"
[[ "$failed" == sp_* ]] || fail "no post failed on the platform"
expect_in "$(count "select reason from kin_social_posts where post_id = '$failed'")" "duplicate content" "the failure didn't say why"
act "$card" retry "\"$failed\""
retried() { count "select state from kin_social_posts where post_id = '$failed'"; }
for _ in $(seq 1 240); do [[ "$(retried)" == posted ]] && break; sleep 0.5; done
[[ "$(retried)" == posted ]] || fail "Retry left the post $(retried)"

# At the service: three of ours live once each, all on our own profile; nothing of the client's.
summary="$(kv social posts | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const all=JSON.parse(s);
  const ours=all.filter(p=>p.content.startsWith(process.argv[1]));
  const live=ours.filter(p=>p.status==="published");
  const client=all.filter(p=>p.content.startsWith(process.argv[3])).length;
  process.stdout.write(`${live.length} ${new Set(ours.map(p=>p.idempotencyKey)).size} ${ours.every(p=>p.profileId===process.argv[2])} ${client}`)})' "W$RUN" "$own_profile" "L$RUN")"
[[ "$summary" == "3 3 true 0" ]] || fail "the service holds \"$summary\" (want 3 published, 3 keys, all on our profile, 0 client)"
pass "pack and reminder with nothing connected; 5 drafted, 1 removed, 4 confirmed, 1 undone, 3 posted after one retry; the client's card held for its OK; no cross-group post"
