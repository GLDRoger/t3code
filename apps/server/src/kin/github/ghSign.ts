import { ghPolicyScript } from "./ghPolicy.ts";

/**
 * What a Kin agent's shell finds first on PATH: `gh` and `git` acting as Kin's GitHub App (as the
 * owner without one), git's credential helper and pre-push guard, and `kin-as-owner`. They hold an
 * agent to Kin's rules but are no wall: the same shell can read the tokens they use.
 */

/** Where Kin keeps the App's identity, tokens and the owner-login record, under its state folder. */
export const GH_APP_FOLDER = "gh-app";
/** Two lines: the bot's login, then its no-reply email. Absent while the App isn't set up. */
export const APP_IDENTITY_FILE = "identity";
/** One installation token per GitHub account the App is installed on, named by the account. */
export const APP_TOKENS_FOLDER = "tokens";
/** One tab-separated line per `kin-as-owner` run; Kin reads on from where it last stopped. */
export const OWNER_USES_FILE = "owner-uses.log";
/** One line per text an agent's gh sent, as when and a hash (`agentMark.ts` `postKey`). */
export const AGENT_POSTS_FILE = "agent-posts.log";
const POLICY_FILE = "gh-policy.mjs";
const PRE_PUSH_HOOK = "pre-push";
const AS_OWNER_COMMAND = "kin-as-owner";
const COMMIT_TRAILER = "Kin-Agent";

export interface AgentShellPaths {
  /** The folder these scripts are written to, first on the agent's PATH. */
  readonly shims: string;
  /** The `gh-app` folder. */
  readonly app: string;
  /** The pinned gh these call. */
  readonly realGh: string;
  /** The Node that runs `ghPolicy.ts`'s program: the server's own. */
  readonly node: string;
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

/** The `gh` in front of the pinned one: picks the App's token, then runs Kin's policy (`ghPolicy.ts`). */
const ghSignScript = (paths: AgentShellPaths) => `#!/bin/sh
# Written by Kin. A Kin agent's gh: acts as Kin's GitHub App where it is installed, and lets through
# only the GitHub writes Kin agents make, signed (${POLICY_FILE}).
NODE=${shellQuote(paths.node)}
APP=${shellQuote(paths.app)}
${REPO_OF}
[ -x "$NODE" ] || { echo "kin: Kin's GitHub guard can't run here (no Node.js), so gh didn't run." >&2; exit 1; }
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
ELECTRON_RUN_AS_NODE=1 exec "$NODE" ${shellQuote(`${paths.shims}/${POLICY_FILE}`)} "$@"
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
at=0; sub=""; i=0; nx=""
for a do
  i=$((i + 1))
  if [ -n "$nx" ]; then nx=""; continue; fi
  case "$a" in
    -c|-C|--git-dir|--work-tree|--namespace|--config-env) nx=1 ;;
    -*) ;;
    *) at=$i; sub="$a"; break ;;
  esac
done
# A push, or an alias for one, runs Kin's pre-push guard first (\`${PRE_PUSH_HOOK}\`).
guard=""
case "$sub" in
  push) guard=1 ;;
  "") ;;
  *) case "$("$REAL" config --get "alias.$sub" 2>/dev/null)" in push|push[[:space:]]*) guard=1 ;; esac ;;
esac
trailer=""
if [ "$sub" = commit ] && [ -n "$KIN_AGENT_NAME" ] && "$REAL" commit -h 2>&1 | grep -q -- --trailer; then
  trailer=1
fi
if [ -n "$guard$trailer" ]; then
  i=0
  for a do
    i=$((i + 1)); shift
    [ "$i" -eq "$at" ] && [ -n "$guard" ] && set -- "$@" -c "core.hooksPath=$HERE"
    if [ "$i" -gt "$at" ] && [ -n "$guard" ] && [ "$a" = --no-verify ]; then
      KIN_SKIP_REPO_HOOKS=1; export KIN_SKIP_REPO_HOOKS; continue
    fi
    set -- "$@" "$a"
    [ "$i" -eq "$at" ] && [ -n "$trailer" ] && set -- "$@" --trailer "${COMMIT_TRAILER}: $KIN_AGENT_NAME"
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

/**
 * git's pre-push hook while a Kin agent pushes: git hands it every ref it resolved, so no spelling
 * of a push gets past it. A push may create, update or delete branches other than the remote's
 * default; then the repository's own pre-push hook runs.
 */
const prePushScript = () => `#!/bin/sh
# Written by Kin. Before a Kin agent's git push: refuses one that changes the remote's default
# branch, or pushes a tag or any other ref, then runs the repository's own pre-push hook.
input=$(cat)
remote="$1"; url="$2"
def=$(git symbolic-ref --quiet --short "refs/remotes/$remote/HEAD" 2>/dev/null)
def="\${def#"$remote"/}"
[ -n "$def" ] || def=$(git ls-remote --symref "$url" HEAD 2>/dev/null |
  sed -n 's#^ref: refs/heads/\\([^[:space:]]*\\)[[:space:]]*HEAD$#\\1#p')
refs() {
  while read -r lref lsha rref rsha; do
    [ -n "$rref" ] || continue
    case "$rref" in
      refs/heads/*)
        b="\${rref#refs/heads/}"
        if [ -n "$def" ]; then [ "$b" != "$def" ] || { echo default; return; }
        else case "$b" in main|master) echo default; return ;; esac; fi ;;
      *) echo other; return ;;
    esac
  done
}
verdict=$(printf '%s\\n' "$input" | refs)
case "$verdict" in
  default)
    echo "kin: Kin agents don't push to a repository's default branch (\${def:-main}): push a branch and open a pull request; the owner merges it." >&2
    exit 1 ;;
  other)
    echo "kin: Kin agents push branches only, never tags or other refs: ask the owner." >&2
    exit 1 ;;
esac
[ -z "$KIN_SKIP_REPO_HOOKS" ] || exit 0
hooks=$(env -u GIT_CONFIG_PARAMETERS -u GIT_CONFIG_COUNT git rev-parse --git-path hooks 2>/dev/null)
if [ -n "$hooks" ] && [ -x "$hooks/pre-push" ] && ! [ "$hooks/pre-push" -ef "$0" ]; then
  printf '%s\\n' "$input" | "$hooks/pre-push" "$@"
  exit $?
fi
exit 0
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
    {
      name: POLICY_FILE,
      text: ghPolicyScript({
        realGh: paths.realGh,
        app: paths.app,
        postsFile: `${paths.app}/${AGENT_POSTS_FILE}`,
      }),
    },
    { name: "git", text: gitScript(paths) },
    { name: PRE_PUSH_HOOK, text: prePushScript() },
    { name: "git-credential-kin", text: credentialScript(paths) },
    { name: AS_OWNER_COMMAND, text: asOwnerScript(paths) },
  ] as const;
