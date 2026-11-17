#!/usr/bin/env bash
# Zoya attaches a PDF in her chat with Chief, which answers it; she can fetch it, and nobody outside that chat can, by its id or a case-folded one.
source "$(dirname "$0")/lib.sh"
FILES="$(mktemp -d)"
trap 'rm -rf "$FILES"' EXIT
NAME="clinic-brief-$RUN.pdf"
printf '%%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%%%EOF\n' >"$FILES/$NAME"

kv as arjun web open chat:chief >/dev/null
expect_in "$(kv as arjun web snapshot --full)" "Attach files" "Arjun, a member, has no Attach files in his chat"
kv as zoya web open chat:chief >/dev/null
kv as zoya web attach "$FILES/$NAME" >/dev/null || fail "Zoya has no Attach files in her chat"
kv as zoya web type "The clinic's brief $RUN" --enter >/dev/null
kv as zoya web wait "$NAME" >/dev/null || fail "Zoya's PDF isn't in her chat"

# Chief takes her turn, PDF and all: its pages reach the agent as pictures, on every provider.
EVENT="$(kv db "select e.event_id from kin_events e join kin_messages m on m.message_id = json_extract(e.json, '\$.messageId') where m.body like '%$RUN%' limit 1" | tail -1)"
[[ "$EVENT" == chat-message-* ]] || fail "Zoya's message woke no agent ($EVENT)"
for _ in $(seq 1 90); do
  TURN="$(kv db "select status from kin_wakeups where event_ids like '%$EVENT%' and status != 'running' order by started_at limit 1" | tail -1)"
  [[ "$TURN" == completed || "$TURN" == failed ]] && break
  sleep 1
done
[[ "$TURN" == completed ]] || fail "Chief of staff's turn on Zoya's PDF didn't complete ($TURN)"

ID="$(kv db "select a.attachment_id from kin_message_attachments a join kin_messages m on m.message_id = a.message_id where m.body like '%$RUN%' limit 1" | tail -1)"
[[ "$ID" == kin-chat-* ]] || fail "no stored attachment for Zoya's message ($ID)"
url() { kv as "$1" rpc assets.createUrl "{\"resource\":{\"_tag\":\"attachment\",\"attachmentId\":\"$2\"}}" 2>&1 || true; }
expect_in "$(url zoya "$ID")" "relativeUrl" "Zoya can't fetch her own PDF"
UPPER="$(tr '[:lower:]' '[:upper:]' <<<"$ID")"
for person in arjun dev meera owner; do
  for id in "$ID" "$UPPER"; do
    answer="$(url "$person" "$id")"
    expect_not_in "$answer" "relativeUrl" "$person fetched Zoya's PDF by $id"
    expect_in "$answer" "AssetAttachmentNotFoundError" "$person's refusal isn't a plain not-found"
  done
done
pass "Zoya attached $NAME, Chief of staff answered it, and she fetches it; Arjun, Dev, Meera and the owner get not-found by its id"
