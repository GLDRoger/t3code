import { KIN_DEVICE_LIMIT } from "@t3tools/contracts";

/** What the app's own page shows; the main process owns it, the page only renders it. */
export interface KinShellView {
  readonly view: "join" | "unreachable" | "stopped";
  /** The team's host, as a person reads it (`kin.example.com`), or null before joining. */
  readonly host: string | null;
  readonly problem: string | null;
  /** On the join page after a link that didn't work: the host it can still go back to. */
  readonly canGoBack: boolean;
}

export const KIN_SHELL_COPY = {
  notALink: "That isn't a Kin join link. Ask whoever sent it for a new one.",
  insecure:
    "That link starts with http://, so it isn't safe to sign in with. Ask whoever sent it for a link that starts with https://.",
  spent: "That link has already been used or has run out. Ask whoever sent it for a new one.",
  limit: `You already have ${KIN_DEVICE_LIMIT} devices signed in. Remove one you no longer use under Settings → Your devices, then make a new link.`,
  signedOut: "You've been signed out of your team's Kin. Paste a new join link to sign in again.",
  stillUnreachable: "Still can't reach it.",
  ambiguous: "That has more than one link in it. Paste just the join link.",
  redirected:
    "That link sent Kin somewhere else, so Kin stopped. Ask whoever sent it for a new one.",
  tryAgain: "Kin couldn't reach your team's Kin just now. Try again.",
  backOnTeam: (origin: string) => `Kin is back on your team's Kin at ${origin}, still signed in.`,
  clearFailed: "Kin couldn't finish signing out of your old team's Kin.",
  clearFailedDetail: (newOrigin: string, oldOrigin: string) =>
    `Kin is now on ${newOrigin}, but it couldn't remove what ${oldOrigin} stored on this computer.`,
} as const;

/**
 * The question before a link signs this computer in somewhere. A link from outside the app always
 * asks, defaulting to Cancel; a pasted link asks only when it would replace the team.
 */
export function kinShellJoinQuestion(input: {
  readonly origin: string;
  readonly current: string | null;
  readonly fromOutside: boolean;
}): {
  readonly message: string;
  readonly detail: string;
  readonly confirm: string;
  readonly defaultToCancel: boolean;
} | null {
  const { origin, current } = input;
  const staysUntil = `It stays signed in there until the new link works, then signs out of it.`;
  if (!input.fromOutside) {
    if (current === null || current === origin) return null;
    return {
      message: "Join a different team's Kin?",
      detail: `This link is for ${origin}. Kin on this computer is signed in to ${current}. ${staysUntil}`,
      confirm: "Join",
      defaultToCancel: false,
    };
  }
  if (current === null) {
    return {
      message: `Join the Kin at ${origin}?`,
      detail:
        "A link from outside Kin asked to sign this computer in there. Join only if you expected this link.",
      confirm: "Join",
      defaultToCancel: true,
    };
  }
  if (current === origin) {
    return {
      message: `Sign in to the Kin at ${origin} again?`,
      detail:
        "Kin on this computer is already signed in there. A link from outside Kin asked to sign it in again.",
      confirm: "Sign In Again",
      defaultToCancel: true,
    };
  }
  return {
    message: `Switch to the Kin at ${origin}?`,
    detail: `Kin on this computer is signed in to ${current}. ${staysUntil}`,
    confirm: "Switch",
    defaultToCancel: true,
  };
}

const KIN_MARK_SVG = `<svg class="mark" viewBox="0 0 1024 1024" aria-hidden="true"><rect width="1024" height="1024" rx="230" fill="#182543"/><g transform="translate(512 512) scale(0.86) translate(-512 -515)"><path d="M173.85 524.36 L479.85 248.36 A48 48 0 0 1 544.15 248.36 L850.15 524.36 A48 48 0 0 1 785.85 595.64 L512 348.64 L238.15 595.64 A48 48 0 0 1 173.85 524.36 Z" fill="#FFF1DC"/><circle cx="512" cy="690" r="104" fill="#FFB238"/></g></svg>`;

export const KIN_SHELL_PAGE_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const KIN_SHELL_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kin</title>
<style>
:root { color-scheme: light dark; --bg: #ffffff; --fg: #141821; --muted: #5b6272; --line: #d5d9e1; --field: #ffffff; --primary: #182543; --on-primary: #fff1dc; --danger: #b42318; --focus: #ffb238; }
@media (prefers-color-scheme: dark) { :root { --bg: #0c1018; --fg: #eef0f4; --muted: #9aa1b0; --line: #2c3342; --field: #131925; --primary: #fff1dc; --on-primary: #182543; --danger: #ff8a7a; } }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; display: flex; align-items: center; justify-content: center; padding: 32px 24px; }
main { width: 100%; max-width: 400px; }
main[hidden] { display: none; }
.brand { display: flex; align-items: center; gap: 12px; margin-bottom: 40px; }
.mark { width: 44px; height: 44px; flex: none; }
.name { font-size: 22px; font-weight: 650; letter-spacing: -0.01em; }
h1 { font-size: 24px; line-height: 1.25; font-weight: 650; letter-spacing: -0.015em; margin: 0 0 8px; }
p { margin: 0; }
.lead { color: var(--muted); margin-bottom: 24px; }
label { display: block; font-weight: 550; margin-bottom: 8px; }
input { width: 100%; height: 44px; padding: 0 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--field); color: var(--fg); font: inherit; }
input:focus-visible, button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
input[aria-invalid="true"] { border-color: var(--danger); }
.problem { color: var(--danger); margin-top: 8px; }
.problem:empty { display: none; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
button { height: 44px; padding: 0 18px; border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer; border: 1px solid transparent; }
button.primary { background: var(--primary); color: var(--on-primary); }
button.secondary { background: transparent; color: var(--fg); border-color: var(--line); }
button:disabled { opacity: 0.55; cursor: default; }
.hint { color: var(--muted); font-size: 13.5px; margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--line); }
.hint p + p { margin-top: 8px; }
.titlebar { position: fixed; inset: 0 0 auto 0; height: 52px; -webkit-app-region: drag; }
</style>
</head>
<body>
<div class="titlebar" aria-hidden="true"></div>
<main id="join" hidden>
  <div class="brand">${KIN_MARK_SVG}<span class="name">Kin</span></div>
  <h1>Paste your join link</h1>
  <p class="lead">It signs this computer in to your team's Kin.</p>
  <form id="join-form" novalidate>
    <label for="link">Join link</label>
    <input id="link" name="link" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://" aria-describedby="join-problem">
    <p id="join-problem" class="problem" role="alert"></p>
    <div class="actions">
      <button id="join-button" class="primary" type="submit" disabled>Join</button>
      <button id="back-button" class="secondary" type="button" hidden>Back to your team's Kin</button>
    </div>
  </form>
  <div class="hint">
    <p>Someone on your team sends you this link.</p>
    <p>Already use Kin in a browser? Make a link there for this computer: Settings → Profile → Link a device. If you set up your company's Kin: Settings → Sharing &amp; access → Create link.</p>
  </div>
</main>
<main id="unreachable" hidden>
  <div class="brand">${KIN_MARK_SVG}<span class="name">Kin</span></div>
  <h1 id="unreachable-title">Can't reach your team's Kin.</h1>
  <p class="lead" id="unreachable-detail">Check this computer's internet connection, or ask whoever runs your team's Kin whether it's up.</p>
  <p id="unreachable-problem" class="problem" role="status"></p>
  <div class="actions">
    <button id="retry-button" class="primary" type="button">Try again</button>
    <button id="different-button" class="secondary" type="button">Use a different link</button>
  </div>
</main>
<script src="/shell.js"></script>
</body>
</html>
`;

export const KIN_SHELL_PAGE_SCRIPT = `"use strict";
(async () => {
  const shell = window.kinShell;
  if (!shell) return;
  const state = await shell.state();
  const $ = (id) => document.getElementById(id);
  if (state.view === "unreachable" || state.view === "stopped") {
    $("unreachable").hidden = false;
    if (state.view === "stopped") {
      $("unreachable-title").textContent = "Your team's Kin stopped working.";
      $("unreachable-detail").textContent = "Kin reloaded it a few times, but it kept stopping.";
    } else if (state.host) $("unreachable-detail").textContent = "Kin couldn't connect to " + state.host + ". Check this computer's internet connection, or ask whoever runs your team's Kin whether it's up.";
    $("unreachable-problem").textContent = state.problem || "";
    const retry = $("retry-button");
    retry.focus();
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      retry.textContent = "Trying…";
      await shell.retry();
    });
    $("different-button").addEventListener("click", () => shell.useDifferentLink());
    return;
  }
  $("join").hidden = false;
  const input = $("link");
  const button = $("join-button");
  const problem = $("join-problem");
  const showProblem = (text) => {
    problem.textContent = text || "";
    input.setAttribute("aria-invalid", text ? "true" : "false");
  };
  showProblem(state.problem);
  if (state.canGoBack && state.host) {
    const back = $("back-button");
    back.textContent = "Back to " + state.host;
    back.hidden = false;
    back.addEventListener("click", () => shell.back());
  }
  input.addEventListener("input", () => {
    button.disabled = input.value.trim() === "";
    if (problem.textContent) showProblem(null);
  });
  input.focus();
  $("join-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (input.value.trim() === "") return;
    button.disabled = true;
    input.readOnly = true;
    button.textContent = "Joining…";
    const result = await shell.join(input.value);
    if (!result.leaving) {
      showProblem(result.problem);
      button.textContent = "Join";
      button.disabled = false;
      input.readOnly = false;
      input.focus();
      input.select();
    }
  });
})();
`;
