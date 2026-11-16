#!/usr/bin/env bash
# A fact is told once: the next check-in with nothing changed queues nothing; a change is told.
# A check-in that comes in the owner's quiet hours waits for their end (07:00 unless he set
# others), survives a restart, and runs once. So does a relay to Zoya in hers: held, not refused,
# in her chat at 07:00 and not before, with one push.
source "$(dirname "$0")/lib.sh"
# The owner's zone, set so the wall clock reads `$1` o'clock now: Etc/GMT-N is UTC+N.
zone_at() { node -e 'const h=new Date().getUTCHours();let n=((+process.argv[1]-h)%24+24)%24;if(n>14)n-=24;process.stdout.write(n===0?"Etc/GMT":`Etc/GMT${n>0?"-":"+"}${Math.abs(n)}`)' "$1"; }
# HH:MM on that zone's clock, six minutes on: a new check-in's window opens five minutes before.
soon() { node -e 'const d=new Date(Date.now()+6*60000);process.stdout.write(new Intl.DateTimeFormat("en-GB",{timeZone:process.argv[1],hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(d))' "$1"; }
q() { kv db "$1" | tail -n +2 | tail -1; }
checkin() {
  local title="$1" zone="$2"
  kv as owner rpc kin.checkIns.save "{\"agentId\":\"$CHIEF\",\"title\":\"$title\",\"what\":\"Look over what needs attention.\",\"at\":\"$(soon "$zone")\",\"days\":[0,1,2,3,4,5,6]}" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).checkIns.find(c=>c.title===process.argv[1])?.scheduleId??""))' "$title"
}
# Waits until the slot has run (T3's last run is set, up to four minutes), then for Kin's sink.
ran() {
  for _ in $(seq 1 240); do
    [[ "$(q "select count(*) from scheduled_tasks t join kin_schedules s on s.task_id = t.task_id where s.schedule_id = '$1' and t.last_run_at is not null")" == 1 ]] && sleep 8 && return 0
    sleep 1
  done
  fail "check-in $1 never ran"
}
event_of() { q "select event_id from kin_events where dedupe_key like 'checkin:$1:%' limit 1"; }
told_by() { kv db "select fact_key from kin_pulse_told where event_id = '$1' order by fact_key" | tail -n +2; }

CHIEF="$(q "select agent_id from kin_leads where domain = 'chief' limit 1")"
DAY="$(zone_at 14)"
kv as owner rpc kin.triggers.setTimeZone "{\"timeZone\":\"$DAY\"}" >/dev/null

# A task of Zoya's that went late yesterday: a fact nobody has told the owner yet.
yesterday="$(node -e 'process.stdout.write(new Date(Date.now()-86400000).toISOString().slice(0,10))')"
created="$(kv tool chief record_create "{\"records\":[{\"title\":\"Invented poster $RUN\",\"owner\":\"Zoya Sheikh\",\"due\":\"$yesterday\"}]}" --raw)"
task="$(grep -o 'W-[0-9]*' <<<"$created" | head -1)"
[[ -n "$task" ]] || fail "couldn't make a late task ($created)"

# Day one: the late task is told.
first="$(checkin "Told $RUN a" "$DAY")"
ran "$first"
first_event="$(event_of "$first")"
[[ -n "$first_event" ]] || fail "the first check-in queued nothing though $task is late"
first_told="$(told_by "$first_event")"
invoice="$(grep -m1 "^task_late:$task:" <<<"$first_told" || true)"
[[ -n "$invoice" ]] || fail "the first check-in didn't tell $task's late fact (told: $first_told)"

# Day two, nothing changed: the next check-in runs, queues nothing, and no model starts.
second="$(checkin "Told $RUN b" "$DAY")"
ran "$second"
[[ -z "$(event_of "$second")" ]] || fail "a check-in with nothing untold queued a turn"

# It changes (the owner takes it in hand): told again, and nothing told before with it.
kv as owner rpc kin.pulse.handle "{\"factKey\":\"$invoice\",\"action\":\"got_it\"}" >/dev/null
third="$(checkin "Told $RUN c" "$DAY")"
ran "$third"
third_event="$(event_of "$third")"
[[ -n "$third_event" ]] || fail "a changed fact started no check-in"
third_told="$(told_by "$third_event")"
expect_in "$third_told" "$invoice" "the changed fact wasn't told"
while read -r key; do
  [[ "$key" == "$invoice" ]] || expect_not_in "$third_told" "$key" "the changed check-in told $key again"
done <<<"$first_told"

# 23:00 on the owner's clock: the changed fact's check-in is held to the end of quiet hours.
NIGHT="$(zone_at 23)"
kv as owner rpc kin.triggers.setTimeZone "{\"timeZone\":\"$NIGHT\"}" >/dev/null
kv as owner rpc kin.pulse.handle "{\"factKey\":\"$invoice\",\"action\":\"undo\"}" >/dev/null
night="$(checkin "Told $RUN d" "$NIGHT")"
ran "$night"
night_event="$(event_of "$night")"
[[ -n "$night_event" ]] || fail "the night check-in queued nothing"
held_until="$(q "select not_before from kin_events where event_id = '$night_event'")"
ends="$(q "select coalesce(json_extract(quiet_hours_json, '\$.to'), '07:00') from kin_trigger_settings limit 1")"
eight="$(node -e 'const z=process.argv[1];const f=t=>new Intl.DateTimeFormat("en-GB",{timeZone:z,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(t);let t=Math.ceil(Date.now()/60000)*60000;while(f(t)!==process.argv[2])t+=60000;process.stdout.write(String(t))' "$NIGHT" "$ends")"
[[ "$held_until" == "$eight" ]] || fail "the night check-in waits until $held_until, not $ends ($eight)"
sleep 5
[[ "$(q "select count(*) from kin_wakeups where wakeup_id = (select wakeup_id from kin_events where event_id = '$night_event')")" == 0 ]] ||
  fail "the night check-in woke the agent in quiet hours"

# 23:xx on Zoya's clock too: the owner's relay to her is taken and held, and the agent told 07:00.
ZOYA="$(q "select person_id from kin_people where handle = 'zoya'")"
kv as owner rpc kin.people.updateProfile "{\"personId\":\"$ZOYA\",\"timeZone\":\"$NIGHT\"}" >/dev/null
kv as zoya rpc kin.push.registerDevice "{\"token\":\"$(printf 'a%.0s' {1..64})\",\"platform\":\"ios\",\"apsEnvironment\":\"development\"}" >/dev/null
RELAY="Proof $RUN: the clinic moved the Thursday review to 10:00."
relayed="$(kv tool chief kin_relay "{\"to\":\"Zoya Sheikh\",\"text\":\"$RELAY\"}" --as-turn-of owner)"
expect_in "$relayed" "kin_relay: ok" "the relay in Zoya's quiet hours was refused: $relayed"
expect_in "$relayed" "07:00 their time" "the agent wasn't told when it reaches her"
[[ "$(q "select count(*) from kin_messages where body = '$RELAY'")" == 0 ]] ||
  fail "the relay reached Zoya inside her quiet hours"
[[ "$(q "select count(*) from kin_held_posts where body = '$RELAY' and delivered_at is null")" == 1 ]] ||
  fail "the relay wasn't held"
relay_pushes() { kv push sent | rg -c "Proof $RUN: the clinic moved" || echo 0; }
[[ "$(relay_pushes)" == 0 ]] || fail "the held relay pushed Zoya at night"

# Quiet hours end (stored times move back; the server restarts): it runs, once.
kv clock advance "$(((eight - $(date +%s) * 1000) / 60000 + 2))m" >/dev/null
for _ in $(seq 1 120); do
  [[ "$(q "select state from kin_events where event_id = '$night_event'")" == done ]] && break
  sleep 1
done
[[ "$(q "select state from kin_events where event_id = '$night_event'")" == done ]] ||
  fail "the held check-in didn't run after 08:00"
[[ "$(q "select count(*) from kin_wakeups w join kin_events e on e.wakeup_id = w.wakeup_id where e.event_id = '$night_event'")" == 1 ]] ||
  fail "the held check-in ran more than once"
for _ in $(seq 1 60); do
  [[ "$(q "select count(*) from kin_messages where body = '$RELAY'")" == 1 ]] && break
  sleep 1
done
[[ "$(q "select count(*) from kin_messages m join kin_chats c on c.org_id = m.org_id and c.chat_id = m.chat_id where m.body = '$RELAY' and m.author_kind = 'agent' and c.direct_key = '$ZOYA:$CHIEF'")" == 1 ]] ||
  fail "the held relay isn't in Zoya's chat once, from the agent, after 07:00"
[[ "$(relay_pushes)" == 1 ]] || fail "the held relay pushed Zoya $(relay_pushes) times at delivery"
kv as owner rpc kin.people.updateProfile "{\"personId\":\"$ZOYA\",\"timeZone\":\"Asia/Kolkata\"}" >/dev/null
kv as owner rpc kin.triggers.setTimeZone "{\"timeZone\":\"$DAY\"}" >/dev/null
pass "$task late told once, silence while unchanged, told again alone when it changed; at 23:00 held to $ends, kept over a restart, run once; a relay to Zoya at 23:00 held and in her chat at $ends, pushed once"
