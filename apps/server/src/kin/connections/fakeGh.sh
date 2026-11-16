#!/bin/sh
# A stand-in for gh, for GitHubLogin.test.ts and `KIN_DEV_FAKE_GITHUB`. State lives in
# $KIN_FAKE_GH: `token` and `user` are the login it holds, `decision` (ok, expired or denied)
# answers a waiting code sign-in, `revoked` makes GitHub refuse the login, `prs` counts the PRs
# `pr create` made, and `calls` records every run. `gh api` and the posting commands go to
# `fakeGitHub.ts` beside this file (`github.json` in the state). Invented data only; it never reaches GitHub.
S="$KIN_FAKE_GH"
echo "$*" >> "$S/calls"
API="$(dirname "$0")/fakeGitHub.ts"
[ -f "$API" ] || API="$(dirname "$0")/../github/fakeGitHub.ts"
case "$1 $2 $3" in
  "api -i user"|"api user/orgs"*) ;;
  "api "*|"pr review"*|"pr comment"*|"issue comment"*|"issue create"*)
    if [ -f "$S/revoked" ]; then echo "gh: Bad credentials (HTTP 401)" >&2; exit 1; fi
    exec node "$API" "$@" ;;
esac
case "$1 $2" in
  "auth token")
    if [ -f "$S/token" ]; then cat "$S/token"; exit 0; fi
    echo "no oauth token found for github.com" >&2; exit 1 ;;
  "auth setup-git")
    for site in github.com gist.github.com; do
      git config --global --add "credential.https://$site.helper" ""
      git config --global --add "credential.https://$site.helper" "!$0 auth git-credential"
    done; exit 0 ;;
  "auth logout")
    rm -f "$S/token" "$S/user"; exit 0 ;;
  "config get")
    [ -f "$S/user" ] && cat "$S/user"; exit 0 ;;
  "api -i")
    if [ -f "$S/revoked" ]; then echo "gh: Bad credentials (HTTP 401)" >&2; exit 1; fi
    printf 'HTTP/2.0 200 OK\r\nX-Oauth-Scopes: gist, read:org, repo, workflow\r\n\r\n{"login":"%s","id":1}\n' "$(cat "$S/user")"
    exit 0 ;;
  "pr create")
    # A PR for the checkout's branch, numbered by how many came before; never reaches GitHub.
    n=$(( $(cat "$S/prs" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$S/prs"
    echo "https://github.com/$(cat "$S/user")/$(basename "$(git remote get-url origin)" .git)/pull/$n"
    exit 0 ;;
  "api user/orgs")
    printf 'invented-co\nside-project\n'; exit 0 ;;
  "auth login")
    case "$*" in
      *--with-token*)
        read token
        case "$token" in
          ghp_good*) printf '%s' "$token" > "$S/token"; printf 'invented-owner' > "$S/user"; exit 0 ;;
          ghp_noscope*) echo "error validating token: missing required scope 'read:org'" >&2; exit 1 ;;
          *) echo "error validating token: HTTP 401: Bad credentials (https://api.github.com/)" >&2; exit 1 ;;
        esac ;;
    esac
    echo "! First copy your one-time code: WXYZ-2345" >&2
    echo "Open this URL to continue in your web browser: https://github.com/login/device" >&2
    while [ ! -f "$S/decision" ]; do sleep 0.05; done
    case "$(cat "$S/decision")" in
      ok) printf 'gho_INVENTEDdeviceToken0000000000000000' > "$S/token"; printf 'invented-owner' > "$S/user"
          echo "✓ Authentication complete." >&2; exit 0 ;;
      expired) echo "error: expired_token: the device code has expired" >&2; exit 1 ;;
      *) echo "error: access_denied: the user has denied your application access" >&2; exit 1 ;;
    esac ;;
esac
echo "fake gh: unexpected $*" >&2
exit 2
