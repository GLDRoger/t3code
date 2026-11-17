#!/usr/bin/env bash
# Give all open tasks to… The owner opens Zoya's page in Settings → Team and finds the offer with
# her count; over RPC Arjun can't give Zoya's tasks away. The owner gives everything she holds to
# Arjun: each task moves as one change, Arjun is told once for all of them, and Undo hands them
# back. Zoya then gives her own open tasks to Dev and back again.
source "$(dirname "$0")/lib.sh"
q() { kv db "$1" | tail -n +2 | tail -1; }
ZOYA="$(q "select person_id from kin_people where display_name = 'Zoya Sheikh'")"
ARJUN="$(q "select person_id from kin_people where display_name = 'Arjun Rao'")"
DEV="$(q "select person_id from kin_people where display_name = 'Dev Malhotra'")"
held() { q "select count(*) from kin_records where register_id = 'work' and owner_kind = 'person' and owner_id = '$1' and state in ('open','doing','waiting')"; }
keys_of() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s).keys)))'; }
from() { printf '{"_tag":"person","personId":"%s"}' "$1"; }
open_count="$(held "$ZOYA")"
[[ "$open_count" -ge 1 ]] || fail "Zoya holds no open tasks to give"

kv as owner web open "/kin?settings=team" >/dev/null
kv as owner web click --name "Zoya Sheikh" >/dev/null || fail "Settings → Team has no Zoya Sheikh to open"
kv as owner web click --name "Give all open tasks to…" >/dev/null ||
  fail "Zoya's page has no Give all open tasks to…"
kv as owner web wait "$open_count open task" >/dev/null || fail "the dialog didn't count her $open_count open tasks"

refused="$(kv as arjun rpc kin.work.handOver "{\"from\":$(from "$ZOYA"),\"to\":$(from "$ARJUN")}" 2>&1 || true)"
[[ "$(held "$ZOYA")" == "$open_count" ]] || fail "Arjun gave Zoya's tasks away: $refused"

titles="$(q "select group_concat(title, '|') from kin_records where register_id = 'work' and owner_kind = 'person' and owner_id = '$ZOYA' and state in ('open','doing','waiting')")"
first="${titles%%|*}"
seq0="$(q "select coalesce(max(seq), 0) from kin_messages")"
cseq0="$(q "select coalesce(max(seq), 0) from kin_record_changes")"
keys="$(kv as owner rpc kin.work.handOver "{\"from\":$(from "$ZOYA"),\"to\":$(from "$ARJUN")}" | keys_of)"
[[ "$(held "$ZOYA")" == 0 && "$(held "$ARJUN")" -ge "$open_count" ]] ||
  fail "after the hand-over Zoya still holds $(held "$ZOYA")"
changes="$(q "select count(*) from kin_record_changes c join kin_records r on r.record_id = c.record_id where c.seq > $cseq0 and r.owner_id = '$ARJUN' and c.fields_json like '%owner%' and c.actor_kind = 'person'")"
[[ "$changes" -ge "$open_count" ]] || fail "the moves weren't each recorded as a change ($changes)"
for _ in $(seq 1 30); do
  [[ "$(q "select count(*) from kin_messages where seq > $seq0 and body like '%$first%'")" -ge 1 ]] && break
  sleep 1
done
told="$(q "select count(*) from kin_messages where seq > $seq0 and body like '%$first%'")"
[[ "$told" == 1 ]] || fail "Arjun was told $told times, not once"

kv as owner rpc kin.work.handOver "{\"from\":$(from "$ARJUN"),\"to\":$(from "$ZOYA"),\"keys\":$keys}" >/dev/null
[[ "$(held "$ZOYA")" == "$open_count" ]] || fail "Undo didn't hand Zoya her tasks back"

mine="$(kv as zoya rpc kin.work.handOver "{\"from\":$(from "$ZOYA"),\"to\":$(from "$DEV")}" | keys_of)"
[[ "$(held "$ZOYA")" == 0 ]] || fail "Zoya couldn't give her own tasks to Dev"
kv as owner rpc kin.work.handOver "{\"from\":$(from "$DEV"),\"to\":$(from "$ZOYA"),\"keys\":$mine}" >/dev/null
[[ "$(held "$ZOYA")" == "$open_count" ]] || fail "her tasks didn't come back from Dev"
pass "the owner gave Zoya's $open_count open tasks to Arjun from her page, Arjun was told once, Undo put them back; Arjun couldn't; Zoya gave hers to Dev"
