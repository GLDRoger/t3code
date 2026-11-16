#!/usr/bin/env bash
# Every chat card, made for real by the scripted agent in one person's chats, to look at on the
# phone or web. Not a pass/fail check: each line says what it made or why Kin refused it.
# Usage: card-gallery.sh [owner|meera|dev|zoya|arjun]   (default owner; on the running instance)
source "$(dirname "$0")/lib.sh"
set +e
WHO="${1:-owner}"
name_of() { kv people | awk -F'\t' -v who="$1" '$1 == who { print $2 }'; }
ME="$(name_of "$WHO")"
[[ -n "$ME" ]] || fail "no seeded person called $WHO"
DAY() { node -e "console.log(new Date(Date.now() + ($1) * 864e5).toISOString().slice(0, 10))"; }
make() { # <label> <agent> <tool> <json> [more tool args]
  local label="$1"
  shift
  local as=(--as-turn-of "$WHO")
  [[ " $* " == *" --as-turn-of "* ]] && as=()
  printf '%-22s %s\n' "$label" "$(kv tool "$@" ${as[@]+"${as[@]}"} 2>&1 | tail -1 | cut -c1-90)"
}
owner_level=false
[[ "$WHO" == owner || "$WHO" == meera ]] && owner_level=true

LONG=$'Here is where the Orbit Dental rebrand stands. The logo is final and the brand guide has a first draft, but the website copy waits on their product names, which Anita has now pushed twice, so I would plan around Monday.\n\n- Logo: final\n- Brand guide: first draft, Zoya reviewing\n- Website copy: waiting on product names\n\n| Piece | Owner | Due |\n|---|---|---|\n| Brand guide v2 | Zoya Sheikh | Fri |\n| Homepage copy | Arjun Rao | Mon |\n| Launch checklist | Dev Malhotra | Wed |\n\n```\ncolors:\n  primary: "#1F6FEB"\n```\n\nThe shared folder: https://drive.example.com/orbit-dental-brand'
make "long reply" chief people_read '{}' --reply "$LONG"
make "question" chief kin_ask '{"question":"Which day should the Orbit Dental launch move to?","detail":"Anita still owes the product names.","options":[{"label":"Monday"},{"label":"Wednesday"},{"label":"Keep Friday"}]}' --reply "One question for you."
make "chart" chief kin_chart '{"chart":"bar","title":"Tasks done this week","unit":{"kind":"count"},"labels":["Zoya","Arjun","Dev","Meera"],"series":[{"name":"Done","values":[7,5,9,3]}],"valueLabels":true}' --reply "Dev closed the most."
HTML='<div style="font-family:system-ui;padding:12px"><b>Pipeline</b><div style="display:flex;gap:8px;margin-top:8px"><div style="flex:1;background:#e8f0fe;padding:8px;border-radius:8px">Leads<br><b>12</b></div><div style="flex:1;background:#fef3e8;padding:8px;border-radius:8px">Quoted<br><b>5</b></div><div style="flex:1;background:#e8fef0;padding:8px;border-radius:8px">Won<br><b>3</b></div></div></div>'
make "visual" chief kin_visual "$(node -e 'console.log(JSON.stringify({ title: "Sales pipeline this month", html: process.argv[1], height: 120 }))' "$HTML")" --reply "Three won this month."
make "plan" chief kin_ask '{"question":"First plan for the Lumen website?","detail":"8 tasks in 3 milestones: design (Zoya, 3), build (Arjun, 4), launch (Dev, 1). Done by 12 Dec.","options":[{"label":"Go ahead","kind":"yes"},{"label":"Let me change it","kind":"no"}]}' --reply "Here is a first plan."
# Someone else's request carried into this person's chat, and this person's own carried out.
if $owner_level; then
  make "relay to $WHO" chief kin_relay "{\"to\":\"$ME\",\"text\":\"Can W-2 move to Monday? The clinic sent the logo files late.\"}" --reply "I've asked." --as-turn-of zoya
else
  make "relay to $WHO" chief kin_relay "{\"to\":\"$ME\",\"text\":\"Rhea says the logo review moves to Monday; can you take it then?\"}" --reply "I've told them." --as-turn-of owner
fi
make "working (12 s)" chief people_read '{}' --reply "Checked everyone's hours." --hold 12
last="$(kv db "select message_id from kin_messages where author_kind = 'human' and body like '[kv:%' order by created_at desc limit 1" | tail -1)"
make "reaction" chief kin_react "{\"messageId\":\"$last\",\"emoji\":\"👍\"}" --reply "Noted."
if $owner_level; then
  make "check-in" chief kin_schedule '{"what":"Check in on what is due today","title":"Morning check-in","at":"09:30","days":[1,2,3,4,5],"chatId":"$chat","around":true,"checkIn":true}' --reply "I'll check in on weekdays around 9:30."
  make "money chart" finance kin_chart '{"chart":"line","title":"Money in by month","unit":{"kind":"money","currency":"INR"},"labelType":"month","labels":["2026-06","2026-07","2026-08","2026-09","2026-10","2026-11"],"series":[{"name":"Received","values":[18000000,22500000,19800000,26100000,24000000,9500000]}]}' --reply "November is slow so far."
  make "invoice PDF" finance kin_document '{"entry":"INV-1","recipe":"invoice","title":"Invoice INV/26-27/004"}' --reply "Here is the invoice."
  make "send email" finance kin_connection_call '{"connection":"hello@ambermill.example","tool":"mail_send","arguments":{"to":["anita@orbitdental.example"],"subject":"Invoice INV/26-27/004 from Ambermill","body":"Hi Anita,\n\nThe October retainer invoice is attached.\n\nThanks,\nRhea","attachments":["INV-1"]},"reason":"send the invoice"}' --reply "Here's the email, ready to send."
  make "receipt" finance kin_receipt "{\"advance\":{\"client\":\"C-1\",\"amount\":\"₹25,000\",\"receivedOn\":\"$(DAY -2)\"},\"towards\":\"the December refresh\",\"mode\":\"bank transfer\",\"reference\":\"UTR 4471\"}" --reply "Here's the advance to confirm."
fi
echo "gallery for $ME: open their chats with Chief of staff$($owner_level && echo ' and Finance')."
echo "more: confirm a send card, then 'kv mail expire hello@ambermill.example' before the next Confirm for a failed send that comes back."
