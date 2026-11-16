/**
 * The `gh` a Kin agent's shell finds first on its PATH: it runs the real one, after ending what the
 * agent posts (a PR or issue body, a comment, a review, a `body` field to `gh api`) with the agent's
 * signature and hidden marker, as `agentMark.ts` writes them. `KIN_AGENT_NAME` names the agent; without
 * it, it changes nothing. POSIX sh, so it runs wherever the agent's shell does.
 */
export const ghSignScript = (realGh: string) => `#!/bin/sh
# Written by Kin. Signs what a Kin agent posts on GitHub, then runs the real gh.
REAL=${shellQuote(realGh)}
NAME="$KIN_AGENT_NAME"
[ -n "$NAME" ] || exec "$REAL" "$@"
SLUG=$(printf '%s' "$NAME" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9][^a-z0-9]*/-/g; s/^-//; s/-$//')
[ -n "$SLUG" ] || SLUG=agent
SIGN="— $NAME, via Kin
<!-- kin-agent: $SLUG -->"
sign() {
  case "$1" in
    *"<!-- kin-agent:"*) printf '%s' "$1" ;;
    *[![:space:]]*) printf '%s\\n\\n%s' "$(printf '%s' "$1")" "$SIGN" ;;
    *) printf '%s' "$SIGN" ;;
  esac
}
case "$1 $2" in
  "pr create"|"issue create"|"pr comment"|"issue comment"|"pr review"|"pr edit"|"issue edit") KIND=post ;;
  "api "*) KIND=api ;;
  *) exec "$REAL" "$@" ;;
esac
HAS_BODY=""; FILL=""; NEXT=""
for a do
  shift
  case "$NEXT" in
    body) set -- "$@" "$(sign "$a")"; NEXT=""; continue ;;
    file) if [ "$a" = "-" ]; then text=$(cat); else text=$(cat "$a"); fi
          set -- "$@" "$(sign "$text")"; NEXT=""; continue ;;
    field) case "$a" in body=*) a="body=$(sign "\${a#body=}")" ;; esac
           set -- "$@" "$a"; NEXT=""; continue ;;
  esac
  if [ "$KIND" = api ]; then
    case "$a" in
      -f|-F|--field|--raw-field) NEXT=field ;;
    esac
    set -- "$@" "$a"; continue
  fi
  case "$a" in
    --body|-b) HAS_BODY=1; NEXT=body; set -- "$@" "$a" ;;
    --body=*) HAS_BODY=1; set -- "$@" "--body=$(sign "\${a#--body=}")" ;;
    --body-file|-F) HAS_BODY=1; NEXT=file; set -- "$@" "--body" ;;
    --body-file=*) HAS_BODY=1; f="\${a#--body-file=}"
      if [ "$f" = "-" ]; then text=$(cat); else text=$(cat "$f"); fi
      set -- "$@" "--body" "$(sign "$text")" ;;
    --fill|--fill-first|--fill-verbose|-f) FILL=1; set -- "$@" "$a" ;;
    *) set -- "$@" "$a" ;;
  esac
done
if [ "$KIND" = post ] && [ -z "$HAS_BODY" ]; then
  case "$1 $2" in
    "pr create") if [ -n "$FILL" ]; then set -- "$@" --body "$(sign "$(git log -1 --format=%b 2>/dev/null)")"
                 else set -- "$@" --body "$SIGN"; fi ;;
    "issue create") set -- "$@" --body "$SIGN" ;;
    "pr review") case " $* " in *" --approve "*|*" -a "*) set -- "$@" --body "$SIGN" ;; esac ;;
  esac
fi
exec "$REAL" "$@"
`;

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
