#!/usr/bin/env bash
# A late task reaches whoever holds it, once. Arjun's wakes Chief of staff to tell him; two of the
# Chief's own ride in that same one wake. The next pass tells none of them again. Moving the due
# day tells it again, once. No model: the wake is the queued pulse event (`holders:` dedupe key)
# and the told rows in kin_pulse_told. No `kv clock advance`: it moves due dates too, so every
# fact would be new; the unit tests cover a week of passes.
source "$(dirname "$0")/lib.sh"
q() { kv db "$1" | tail -n +2 | tail -1; }
CHIEF="$(q "select agent_id from kin_leads where domain = 'chief' limit 1")"
ARJUN="$(q "select person_id from kin_people where display_name = 'Arjun Rao'")"
day() { node -e 'process.stdout.write(new Date(Date.now()+(+process.argv[1])*86400000).toISOString().slice(0,10))' "$1"; }
make() {
  kv tool chief record_create "{\"records\":[{\"title\":\"$1\",\"owner\":\"$2\",\"due\":\"$(day -1)\"}]}" \
    --as-turn-of owner --raw | grep -o 'W-[0-9]*' | head -1
}
his="$(make "Invented poster $RUN" "Arjun Rao")"
mine="$(make "Invented brochure $RUN" me)"
also="$(make "Invented flyer $RUN" me)"
[[ -n "$his" && -n "$mine" && -n "$also" ]] || fail "couldn't make the late tasks"
told() { q "select count(*) from kin_pulse_told where fact_key like 'task_late:$1:%' and person_id = '$2'"; }
wakes_with() { q "select count(*) from kin_events where agent_id = '$CHIEF' and dedupe_key like 'holders:%' and json like '%task_late:$1:%'"; }
# The pulse runs within seconds of a record change.
for _ in $(seq 1 60); do
  [[ "$(told "$his" "$ARJUN")" == 1 && "$(told "$also" "agent:$CHIEF")" == 1 ]] && break
  sleep 1
done
[[ "$(told "$his" "$ARJUN")" == 1 ]] || fail "Arjun's late $his wasn't told to him"
[[ "$(told "$mine" "agent:$CHIEF")" == 1 && "$(told "$also" "agent:$CHIEF")" == 1 ]] ||
  fail "the Chief's own late $mine and $also weren't told to it"
[[ "$(wakes_with "$his")" == 1 ]] || fail "$his woke the Chief $(wakes_with "$his") times"
[[ "$(q "select count(*) from kin_events where agent_id = '$CHIEF' and dedupe_key like 'holders:%' and json like '%task_late:$mine:%' and json like '%task_late:$also:%'")" == 1 ]] ||
  fail "the Chief's two late tasks didn't come in one wake"

# A change so the pulse runs again: nothing told twice.
seen="$(q "select max(last_seen_at) from kin_pulse_facts")"
kv tool chief record_create "{\"records\":[{\"title\":\"Invented note $RUN\",\"owner\":\"me\"}]}" --as-turn-of owner >/dev/null
for _ in $(seq 1 60); do
  [[ "$(q "select max(last_seen_at) from kin_pulse_facts")" != "$seen" ]] && break
  sleep 1
done
[[ "$(q "select max(last_seen_at) from kin_pulse_facts")" != "$seen" ]] || fail "the pulse didn't run after the change"
for one in "$his:$ARJUN" "$mine:agent:$CHIEF" "$also:agent:$CHIEF"; do
  [[ "$(told "${one%%:*}" "${one#*:}")" == 1 ]] || fail "${one%%:*} was told again on the next pass"
done
[[ "$(wakes_with "$his")" == 1 ]] || fail "$his woke the Chief again on the next pass"

# Its due day moves: a new fact, told once more.
kv tool chief record_update "{\"key\":\"$his\",\"due\":\"$(day -2)\"}" --as-turn-of owner >/dev/null
for _ in $(seq 1 60); do
  [[ "$(told "$his" "$ARJUN")" == 2 ]] && break
  sleep 1
done
[[ "$(told "$his" "$ARJUN")" == 2 ]] || fail "moving $his's due day didn't tell Arjun again"
[[ "$(wakes_with "$his")" == 2 ]] || fail "moving $his's due day woke the Chief $(wakes_with "$his") times in all"
pass "$his late told to Arjun once through the Chief; $mine and $also in one wake; nothing again on the next pass; a moved due day told once more"
