/**
 * What a Kin agent's shell finds first on PATH (POSIX sh): `gh` and `git` that act as Kin's GitHub
 * App from the files `KinGitHubApp.ts` keeps in `gh-app` (as the owner when there are none), git's
 * credential helper, and `kin-as-owner`, which runs one recorded command as the owner.
 */

/** Where Kin keeps the App's identity, tokens and the owner-login record, under its state folder. */
export const GH_APP_FOLDER = "gh-app";
/** Two lines: the bot's login, then its no-reply email. Absent while the App isn't set up. */
export const APP_IDENTITY_FILE = "identity";
/** One installation token per GitHub account the App is installed on, named by the account. */
export const APP_TOKENS_FOLDER = "tokens";
/** One tab-separated line per `kin-as-owner` run; Kin reads on from where it last stopped. */
export const OWNER_USES_FILE = "owner-uses.log";
const AS_OWNER_COMMAND = "kin-as-owner";
const COMMIT_TRAILER = "Kin-Agent";

export interface AgentShellPaths {
  /** The folder these scripts are written to, first on the agent's PATH. */
  readonly shims: string;
  /** The `gh-app` folder. */
  readonly app: string;
  /** The pinned gh these call. */
  readonly realGh: string;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * `kin_repo <args>` prints owner/name for a command: its -R/--repo, GH_REPO, a GitHub URL or
 * `repos/` path among its arguments (not a body or title), else this checkout's upstream or origin.
 */
const REPO_OF = `kin_repo() {
  r="$GH_REPO"; g=""; p=""
  case "$1 $2" in "repo "*) case "$3" in -*|"") ;; */*) g="$3" ;; esac ;; esac
  for a do
    case "$p" in
      -R|--repo) r="$a" ;;
      --body|-b|--title|-t|-f|-F|--field|--raw-field|--body-file|-m|--message) p=""; continue ;;
    esac
    case "$a" in
      --repo=*) r="\${a#--repo=}" ;;
      -R?*) r="\${a#-R}" ;;
      https://github.com/*/*|git@github.com:*/*) [ -n "$g" ] || g="\${a#*github.com?}" ;;
      repos/*/*|/repos/*/*) [ -n "$g" ] || { g="\${a#/}"; g="\${g#repos/}"; } ;;
    esac
    p="$a"
  done
  [ -n "$r" ] || r="$g"
  if [ -z "$r" ]; then
    for remote in upstream origin; do
      r=$(git remote get-url "$remote" 2>/dev/null | sed -n 's#^.*github\\.com[:/]##p')
      [ -z "$r" ] || break
    done
  fi
  r="\${r#/}"; o="\${r%%/*}"; n="\${r#*/}"; n="\${n%%/*}"; n="\${n%.git}"
  [ -n "$o" ] && [ -n "$n" ] && [ "$o" != "$r" ] && printf '%s/%s' "$o" "$n"
  return 0
}`;

/**
 * Kin agents never merge, approve, or change a repo's settings, access or secrets, under the App
 * or the owner's login. The App's token can't change settings at all (`KinGitHubApp.ts`); this
 * stops the rest before gh runs.
 */
const REFUSALS = `refuse() { printf 'kin: %s\\n' "$1" >&2; exit 1; }
NO_MERGE="Kin agents don't merge pull requests: tell the owner it is ready and he merges it."
NO_APPROVE="Kin agents don't approve pull requests: comment or request changes instead."
NO_SETTINGS="Kin agents don't change a repository's settings, access or secrets: ask the owner."
case "$1 $2" in
  "pr merge") refuse "$NO_MERGE" ;;
  "pr review") for a do case "$a" in --approve|-a) refuse "$NO_APPROVE" ;; esac; done ;;
  "repo edit"|"repo delete"|"repo rename"|"repo archive"|"repo unarchive"|"secret set"|"secret delete"|"secret remove"|"variable set"|"variable delete"|"variable remove")
    refuse "$NO_SETTINGS" ;;
  "api "*)
    M=""; P=""; F=""; HASF=""; nx=""; first=1
    for a do
      if [ -n "$first" ]; then first=""; continue; fi
      case "$nx" in
        m) M="$a"; nx=""; continue ;;
        f) F="$F $a"; HASF=1; nx=""; continue ;;
        i) HASF=1; if [ "$a" != - ] && [ -f "$a" ]; then F="$F $(cat "$a")"; fi; nx=""; continue ;;
        s) nx=""; continue ;;
      esac
      case "$a" in
        -X|--method) nx=m ;;
        -X*) M="\${a#-X}" ;;
        --method=*) M="\${a#--method=}" ;;
        -f|-F|--field|--raw-field) nx=f ;;
        --field=*|--raw-field=*) F="$F \${a#*=}"; HASF=1 ;;
        --input) nx=i ;;
        -H|--header|-q|--jq|-t|--template|--cache|--hostname|-p|--preview) nx=s ;;
        -*) ;;
        *) [ -n "$P" ] || P="\${a#/}" ;;
      esac
    done
    [ -n "$M" ] || { if [ -n "$HASF" ]; then M=POST; else M=GET; fi; }
    M=$(printf '%s' "$M" | tr 'a-z' 'A-Z')
    case "$P" in
      graphql)
        case "$F" in *mutation*)
          case "$F" in
            *mergePullRequest*|*enablePullRequestAutoMerge*|*mergeBranch*) refuse "$NO_MERGE" ;;
            *APPROVE*) refuse "$NO_APPROVE" ;;
            *updateRepository*|*BranchProtectionRule*|*Ruleset*|*Collaborator*|*updateTeam*) refuse "$NO_SETTINGS" ;;
          esac ;;
        esac ;;
      *)
        if [ "$M" != GET ]; then
          case "$P" in
            */pulls/*/merge|*/merges) refuse "$NO_MERGE" ;;
            */reviews|*/reviews/*/events) case "$F" in *APPROVE*) refuse "$NO_APPROVE" ;; esac ;;
            repos/*/*/*)
              case "$P" in
                */collaborators*|*/invitations*|*/branches/*/protection*|*/rulesets*|*/hooks*|*/keys*|*/environments*|*/actions/secrets*|*/actions/variables*|*/actions/permissions*|*/transfer|*/vulnerability-alerts|*/automated-security-fixes)
                  refuse "$NO_SETTINGS" ;;
              esac ;;
            repos/*/*) refuse "$NO_SETTINGS" ;;
            orgs/*/repos) ;;
            orgs/*|teams/*) refuse "$NO_SETTINGS" ;;
          esac
        fi ;;
    esac ;;
esac`;

/** The `gh` in front of the pinned one: refuses, picks the App's token, signs, runs the real gh. */
const ghSignScript = (paths: AgentShellPaths) => `#!/bin/sh
# Written by Kin. A Kin agent's gh: acts as Kin's GitHub App where it is installed, signs what the
# agent posts, then runs the real gh.
REAL=${shellQuote(paths.realGh)}
APP=${shellQuote(paths.app)}
${REFUSALS}
${REPO_OF}
if [ -z "$KIN_AS_OWNER" ] && [ -s "$APP/${APP_IDENTITY_FILE}" ]; then
  acct=$(kin_repo "$@" | tr 'A-Z' 'a-z'); acct="\${acct%%/*}"
  case "$acct" in *[!a-z0-9-]*) acct="" ;; esac
  T=""
  if [ -n "$acct" ]; then
    [ -s "$APP/${APP_TOKENS_FOLDER}/$acct" ] && T=$(cat "$APP/${APP_TOKENS_FOLDER}/$acct")
  else
    set -- "$APP/${APP_TOKENS_FOLDER}"/* -- "$@"
    if [ "$2" = -- ] && [ -s "$1" ]; then T=$(cat "$1"); fi
    while [ "$1" != -- ]; do shift; done; shift
  fi
  if [ -n "$T" ]; then GH_TOKEN="$T"; export GH_TOKEN; fi
fi
NAME="$KIN_AGENT_NAME"
[ -n "$NAME" ] || exec "$REAL" "$@"
SLUG=$(printf '%s' "$NAME" | tr 'A-Z' 'a-z' | sed 's/[^a-z0-9][^a-z0-9]*/-/g; s/^-//; s/-$//')
[ -n "$SLUG" ] || SLUG=agent
SIGN="_$NAME, via Kin_
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
  esac
fi
exec "$REAL" "$@"
`;

/** The `git` in front of the real one, found on PATH without this folder. */
const gitScript = (paths: AgentShellPaths) => `#!/bin/sh
# Written by Kin. A Kin agent's git: each commit names the agent in a ${COMMIT_TRAILER} trailer, and
# with Kin's GitHub App set up, git authors and pushes as the App unless kin-as-owner runs it.
HERE=${shellQuote(paths.shims)}
APP=${shellQuote(paths.app)}
HELPER=${shellQuote(`!${shellQuote(`${paths.shims}/git-credential-kin`)}`)}
P=""
IFS=:
for d in $PATH; do [ "$d" = "$HERE" ] || P="\${P:+$P:}$d"; done
unset IFS
REAL=$(PATH="$P" command -v git) || { echo "kin: there is no git on this machine's PATH" >&2; exit 127; }
at=0; i=0; nx=""
for a do
  i=$((i + 1))
  if [ -n "$nx" ]; then nx=""; continue; fi
  case "$a" in
    -c|-C|--git-dir|--work-tree|--namespace|--config-env) nx=1 ;;
    -*) ;;
    *) [ "$a" = commit ] && at=$i; break ;;
  esac
done
if [ "$at" -gt 0 ] && [ -n "$KIN_AGENT_NAME" ] && "$REAL" commit -h 2>&1 | grep -q -- --trailer; then
  i=0
  for a do
    i=$((i + 1)); shift
    set -- "$@" "$a"
    [ "$i" -eq "$at" ] && set -- "$@" --trailer "${COMMIT_TRAILER}: $KIN_AGENT_NAME"
  done
fi
if [ -z "$KIN_AS_OWNER" ] && [ -s "$APP/${APP_IDENTITY_FILE}" ]; then
  { IFS= read -r NAME; IFS= read -r EMAIL; } < "$APP/${APP_IDENTITY_FILE}"
  set -- -c "user.name=$NAME" -c "user.email=$EMAIL" \\
    -c credential.https://github.com.helper= -c "credential.https://github.com.helper=$HELPER" \\
    -c credential.https://github.com.useHttpPath=true \\
    -c url.https://github.com/.insteadOf=git@github.com: \\
    -c url.https://github.com/.insteadOf=ssh://git@github.com/ "$@"
fi
exec "$REAL" "$@"
`;

/** git's credential helper while the App is set up: its token, else the owner's gh login. */
const credentialScript = (paths: AgentShellPaths) => `#!/bin/sh
# Written by Kin. Hands git Kin's GitHub App token for the repo's account, or the owner's gh login
# where the App isn't installed. Stores nothing.
REAL=${shellQuote(paths.realGh)}
APP=${shellQuote(paths.app)}
[ "$1" = get ] || exit 0
input=$(cat)
host=$(printf '%s\\n' "$input" | sed -n 's/^host=//p')
path=$(printf '%s\\n' "$input" | sed -n 's/^path=//p')
acct=$(printf '%s' "\${path%%/*}" | tr 'A-Z' 'a-z')
case "$acct" in *[!a-z0-9-]*) acct="" ;; esac
if [ "$host" = github.com ] && [ -n "$acct" ] && [ -s "$APP/${APP_TOKENS_FOLDER}/$acct" ]; then
  printf 'username=x-access-token\\npassword=%s\\n' "$(cat "$APP/${APP_TOKENS_FOLDER}/$acct")"
  exit 0
fi
printf '%s\\n' "$input" | exec "$REAL" auth git-credential get
`;

/** Runs one command as the owner's own GitHub login; refuses to when Kin can't record it. */
const asOwnerScript = (paths: AgentShellPaths) => `#!/bin/sh
# Written by Kin. ${AS_OWNER_COMMAND} <command…>: runs one command as the owner's own GitHub login
# instead of Kin's GitHub App, after Kin records who ran what, where and when.
APP=${shellQuote(paths.app)}
[ $# -gt 0 ] || { echo "usage: ${AS_OWNER_COMMAND} <command> [arguments…]" >&2; exit 2; }
${REPO_OF}
case "$1" in gh) repo=$(shift; kin_repo "$@") ;; *) repo=$(kin_repo "$@") ;; esac
flat() { printf '%s' "$1" | tr '\\t\\r\\n' '   '; }
T=$(printf '\\t')
line="$(date +%s)$T$$$T$(flat "$KIN_AGENT_NAME")$T$(flat "$repo")$T$(flat "$*")"
{ mkdir -p "$APP" && printf '%s\\n' "$line" >> "$APP/${OWNER_USES_FILE}"; } 2>/dev/null || {
  echo "kin: Kin couldn't record this use of the owner's login, so it didn't run." >&2
  exit 1
}
KIN_AS_OWNER=1
export KIN_AS_OWNER
unset GH_TOKEN GITHUB_TOKEN
exec "$@"
`;

/** Every script the agent's shell finds first, by file name. */
export const agentShellScripts = (paths: AgentShellPaths) =>
  [
    { name: "gh", text: ghSignScript(paths) },
    { name: "git", text: gitScript(paths) },
    { name: "git-credential-kin", text: credentialScript(paths) },
    { name: AS_OWNER_COMMAND, text: asOwnerScript(paths) },
  ] as const;
