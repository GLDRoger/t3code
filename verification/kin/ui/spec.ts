// Kin's UI properties for Bombadil. The runner picks the role; see README.md for what each means.
// Extractors run inside the page and must be self-contained; properties run in Bombadil.
import { always, eventually, next, now } from "@antithesishq/bombadil";
import { actions, extract, weighted } from "@antithesishq/bombadil/browser";
import { back, scroll } from "@antithesishq/bombadil/browser/defaults/actions";
import { FORBIDDEN, role, type Role } from "./roles.ts";

export {
  noUncaughtExceptions,
  noUnhandledPromiseRejections,
  noConsoleErrors,
  noHttpErrorCodes,
} from "@antithesishq/bombadil/browser/defaults/properties";

const screen = extract((state) => {
  const doc = state.document;
  const body = doc.body;
  // Only Kin is under test; T3's coding screens are left by pressing Back.
  const inKin = state.window.location.pathname.startsWith("/kin");
  const text = inKin ? (body?.innerText ?? "").slice(0, 40_000) : "";
  const main = doc.querySelector("main");
  // Sheets and dialogs only: toasts and popovers are not a level.
  const dialogs = [
    ...doc.querySelectorAll(
      "[data-slot=dialog-popup],[data-slot=sheet-popup],[role=dialog][aria-modal=true]",
    ),
  ].filter(
    (d) => (d as HTMLElement).offsetParent !== null || getComputedStyle(d).position === "fixed",
  );
  const busy = doc.querySelectorAll("[aria-busy=true],.animate-spin,[role=progressbar]").length;
  const toggles = doc.querySelectorAll(
    "[aria-checked=true],[aria-expanded=true],[aria-pressed=true],[aria-selected=true],[data-state=open],[data-state=checked]",
  ).length;
  const url = new URL(state.window.location.href);
  // Counts the app states, beside the rows it lists for the same thing (null where not on screen).
  // Settings is a modal over the page while the address names a section; its text is the screen's.
  const shown = url.searchParams.has("settings") ? doc.querySelector("[data-app-modal]") : main;
  const mainText = inKin ? ((shown as HTMLElement | null)?.innerText ?? "") : "";
  const lines = mainText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const after = (marker: RegExp) => {
    const i = lines.findIndex((l) => marker.test(l));
    return i === -1 ? null : lines.slice(i + 1);
  };
  const num = (re: RegExp) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  };
  // A filter or a search narrows the list on purpose, so the tasks count is compared without one.
  const searched = [...doc.querySelectorAll("main input")].some(
    (i) => (i as HTMLInputElement).value !== "",
  );
  const onTasks =
    url.pathname.endsWith("/tasks") && !url.search && !searched && !/Clear filter/.test(mainText);
  // Rows follow "Filter" directly; a chosen filter ("Late", "Due this week") sits between them.
  const listed = onTasks ? after(/^Filter$/) : null;
  // "Handled (n)" holds nudges set aside with "I've got it"; some may be open tasks, and open or
  // folded, those rows name no task key, so the list below never counts them.
  const handledAt = lines.findIndex((l) => /^Handled \(\d+\)$/.test(l));
  const handledHidden = handledAt === -1 ? 0 : Number(/\d+/.exec(lines[handledAt])![0]);
  // A task under "Needs you" is not repeated in the rows below the filter.
  const keysIn = (ls: string[]) =>
    new Set(ls.flatMap((l) => [...l.matchAll(/(?:^|· )(W-\d+)\b/g)].map((m) => m[1])));
  const taskRows =
    listed && /· W-\d+$/.test(listed[1] ?? "")
      ? keysIn([...(after(/^Needs you$/) ?? []), ...listed]).size
      : null;
  const onTeam = url.searchParams.get("settings") === "team";
  const teamLines = onTeam ? after(/^One chat with everyone/) : null;
  const teamOthers = teamLines ? teamLines.length / 2 - 1 : null;
  const onDates = url.searchParams.has("dates");
  let datesSoon: number | null = null;
  const shownAfter = onDates ? after(/^Only what['’]s open$/) : null;
  // The month grid lists entries by day number only; the count is compared on the agenda.
  const agenda = shownAfter?.slice(1, 3).join() === "Mon,Tue" ? null : shownAfter;
  if (agenda) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const limit = today.getTime() + 30 * 86_400_000;
    let day: number | null = null;
    datesSoon = 0;
    for (const l of agenda) {
      if (l === "Today") day = today.getTime();
      else if (l === "Tomorrow") day = today.getTime() + 86_400_000;
      else if (l === "Yesterday") day = today.getTime() - 86_400_000;
      else if (/^(?:[A-Z][a-z]{2}, )?[A-Z][a-z]{2} \d{1,2}(?:, \d{4})?$/.test(l)) {
        const bare = l.replace(/^[A-Z][a-z]{2}, /, "");
        day = new Date(/\d{4}$/.test(bare) ? bare : `${bare}, ${today.getFullYear()}`).getTime();
      } else if (
        day !== null &&
        /^[A-Z][a-z]+ · /.test(l) &&
        !/ · (?:Done|Paid|Dropped|Declined|Accepted|Void)\b/.test(l)
      )
        if (day >= today.getTime() && day <= limit) datesSoon++;
    }
  }
  const counts = {
    tasksClaim: onTasks ? num(/\nTasks\n(\d+) open/) : null,
    taskRows,
    handledHidden,
    teamClaim: onTeam ? num(/\nTeam\n(\d+) teammates?/) : null,
    teamOthers,
    datesClaim: onDates ? num(/Coming-up dates\n(\d+) in the next 30 days/) : null,
    datesSoon,
  };
  return {
    counts,
    path: url.pathname,
    search: Object.fromEntries(url.searchParams),
    text,
    inKin,
    mainBlank: inKin && main !== null && (main as HTMLElement).innerText.trim() === "",
    dialogs: dialogs.length,
    // Settings is a modal standing in for a page; a form over it is the one sheet.
    sheets: dialogs.filter((d) => !d.matches("[data-app-modal]")).length,
    dialogTitles: dialogs.map(
      (d) => (d.querySelector("h1,h2,h3,[id$=title]") as HTMLElement | null)?.innerText ?? "",
    ),
    busy,
    sig: `${url.pathname}${url.search}|${dialogs.length}|${toggles}|${text.length}|${text.slice(0, 200)}|${text.slice(-400)}`,
  };
});
const lastAction = extract((state) => state.lastAction as never);
const href = extract((state) => state.window.location.href);

const shown = () => screen.current?.text ?? "";

// Privacy: what this role must never read, on any screen it can reach. One property per kind of
// secret, so one leak doesn't hide another (Bombadil reports a property's first failure only).
const leaks = (kind: keyof (typeof FORBIDDEN)[Role]) => () =>
  !FORBIDDEN[role()][kind].some((p) => p.test(shown()));
export const privacyMoney = always(leaks("money"));
export const privacyOwnerPrivate = always(leaks("ownerPrivate"));
export const privacyContact = always(leaks("contact"));

// No false dead ends: the app never tells you a place it offered is broken or gone.
const never = (pattern: RegExp) => always(() => !pattern.test(shown()));
export const noCouldntLoad = never(/Couldn['’]t load|Failed to load|Try again/i);
export const noGoneRecord = never(/isn['’]t here any ?more|no longer exists|not found/i);
export const noSomethingWrong = never(/Something went wrong|Unexpected error/i);
export const noNotAvailable = never(
  /Not available|You don['’]t have access|not allowed|Only whoever holds|or gave it to them, can/i,
);

// An enabled control is one the host lets through: a tap never brings up a refusal that wasn't on
// the screen before it.
const REFUSAL =
  /You can['’]t do that here|isn['’]t allowed to|can['’]t change (?:it|this)|Only (?:the owner|whoever|the person who)[^.\n]* can/i;
export const enabledNeverRefused = always(() => {
  const before = shown();
  if (REFUSAL.test(before)) return true;
  return next(() => {
    if (!clicked(lastAction.current)) return true;
    const answered = () => !REFUSAL.test(shown());
    return answered() && next(() => answered() && next(answered));
  });
});
// Only a request that got no answer blames the connection; the walk's server is always up, so a
// refusal or something gone must never read as one.
export const noConnectionBlame = never(
  /check (?:your|the) connection|can['’]t reach your|isn['’]t answering right now/i,
);
export const noBlankScreen = always(
  now(() => screen.current?.mainBlank === true).implies(
    eventually(() => screen.current?.mainBlank !== true).within(6, "seconds"),
  ),
);
export const spinnersEnd = always(
  now(() => (screen.current?.busy ?? 0) > 0).implies(
    eventually(() => (screen.current?.busy ?? 0) === 0).within(10, "seconds"),
  ),
);

// Vocabulary: internal words and broken values never reach the screen.
export const noBrokenValues = never(/\bundefined\b|\bNaN\b|\[object Object\]|\bnull\b/);
export const noATeammate = never(/A teammate/);
export const noInternalWords = never(
  /\bwidgets?\b|\bwake(?:-?up)?s?\b|\bdeferrals?\b|\bL[0-3]\b|\blead agent\b|\bpulse\b|\bfloor\b/i,
);
export const noRawIds = never(
  /\bkin-default\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-|\bperson[-_][a-z0-9]{6,}|\bagent[-_][a-z0-9]{6,}/,
);

// Depth: dock tab → list → record → sheet. A record opened inside another record, or a sheet
// opened from a sheet, is a level deeper. Confirmation prompts (alertdialog) don't count.
const RECORD_KEYS = ["client", "project", "list", "dates", "subscriptions", "doc"];
export const noRecordInRecord = always(() => {
  const s = screen.current;
  if (!s) return true;
  // A doc's history and changes open as sheets over it, so only records count here.
  return RECORD_KEYS.filter((k) => k in s.search).length <= 1;
});
export const noSheetOnSheet = always(() => (screen.current?.sheets ?? 0) <= 1);

// No dead controls: a click on a button, link or row changes something you can see.
const clicked = (action: unknown) => {
  if (!action || typeof action !== "object" || !("Click" in action)) return null;
  const fp = (action as { Click: { fingerprint: Record<string, string | null> } }).Click
    .fingerprint;
  return {
    tag: fp.tag ?? "",
    role: fp.role ?? null,
    name: (
      fp.accessibleName ??
      fp.accessible_name ??
      fp.textContent ??
      fp.text_content ??
      ""
    ).trim(),
  };
};
export const noDeadControls = always(() => {
  const before = screen.current?.sig;
  return next(() => {
    const fp = clicked(lastAction.current);
    if (!fp || (!["button", "a"].includes(fp.tag) && fp.role !== "button" && fp.role !== "link"))
      return true;
    return eventually(() => screen.current?.sig !== before).within(3, "seconds");
  });
});

// Count equals list: a number the app states matches the rows it lists for the same thing. The
// dock's "Tasks N open" against the task list, "Team N teammates" against the people on the Team
// page, and Money's "N in the next 30 days" against the agenda entries in those 30 days.
const countsAgree = () => {
  const c = screen.current?.counts;
  if (!c) return true;
  const agree = (claim: number | null, shown: number | null) =>
    claim === null || shown === null || claim === shown;
  return (
    (agree(c.tasksClaim, c.taskRows) ||
      (c.taskRows !== null &&
        c.tasksClaim !== null &&
        c.tasksClaim > c.taskRows &&
        c.tasksClaim <= c.taskRows + c.handledHidden)) &&
    agree(c.teamClaim, c.teamOthers) &&
    agree(c.datesClaim, c.datesSoon)
  );
};
// Rows arrive a moment after a count, so a mismatch counts once it has held for three captured
// states on the same address.
export const countMatchesList = always(() => {
  if (countsAgree()) return true;
  const at = href.current;
  const settled = () => href.current !== at || countsAgree();
  return next(() => settled() || next(settled));
});

// Going back closes what a tap opened. Kin keeps what is open in the address, and closing or
// switching a record replaces the entry, so the rule is: open something (the address gains a
// key), press Back, and you are where you were before opening it.
const parts = (url: string) => {
  const [pathname, query = ""] = url.split("#")[0].split("?");
  return {
    pathname,
    keys: query
      .split("&")
      .filter(Boolean)
      .map((kv) => kv.split("=")[0]),
  };
};
const opened = (from: string, to: string) => {
  const a = parts(from);
  const b = parts(to);
  return (
    a.pathname === b.pathname &&
    b.keys.length > a.keys.length &&
    a.keys.every((k) => b.keys.includes(k))
  );
};
export const backClosesWhatOpened = always(() => {
  const a = href.current;
  return next(() => {
    const b = href.current;
    if (lastAction.current === "Back" || !opened(a, b)) return true;
    return next(() => lastAction.current !== "Back" || href.current === a);
  });
});

// Actions: taps, scrolling and Back. No typing, so nothing is sent to an agent. Bombadil's own
// click fingerprints carry no name for Kin's buttons, so taps are listed here, by visible name,
// and irreversible or outward controls are left out in the page (see README).
const tappable = extract((state) => {
  const doc = state.document;
  if (!state.window.location.pathname.startsWith("/kin")) return [];
  const EXCLUDED =
    /^(?:Create|New agent|Add agent|Remove|Delete|Revoke|Retire|Sign out|Log out|Leave|Confirm|Send|Archive|Void|Pay|Approve|Reset|Disconnect|Turn off|Run now|Connect|Sign in|Hand back|Give back|Mark done|Reopen|Drop|Share|Unshare|Make private|Only me|Change|Upload|Attach|Download|Copy link|Switch to coding|Usage|Pull requests)/i;
  const selector =
    "button,a[href],[role=button],[role=link],[role=menuitem],[role=menuitemradio],[role=option],[role=tab],[role=switch],[role=checkbox],input[type=checkbox],input[type=radio],select,summary";
  const out = [];
  for (const el of doc.querySelectorAll(selector)) {
    const h = el as HTMLElement;
    if (
      h.closest("[inert],[aria-hidden=true]") ||
      (h as HTMLButtonElement).disabled ||
      h.getAttribute("aria-disabled") === "true"
    )
      continue;
    const r = h.getBoundingClientRect();
    if (
      r.width < 4 ||
      r.height < 4 ||
      r.bottom < 0 ||
      r.right < 0 ||
      r.top > state.window.innerHeight ||
      r.left > state.window.innerWidth
    )
      continue;
    const x = Math.min(Math.max(r.left + r.width / 2, 1), state.window.innerWidth - 1);
    const y = Math.min(Math.max(r.top + r.height / 2, 1), state.window.innerHeight - 1);
    const hit = doc.elementFromPoint(x, y);
    if (!hit || (hit !== h && !h.contains(hit))) continue;
    const name = (h.getAttribute("aria-label") ?? h.innerText ?? h.getAttribute("title") ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (EXCLUDED.test(name) || (h as HTMLInputElement).type === "file") continue;
    const fingerprint = {
      testId: h.dataset.testid ?? null,
      id: h.id || null,
      role: h.getAttribute("role"),
      accessibleName: name.slice(0, 120) || null,
      tag: h.tagName.toLowerCase(),
      href: h.getAttribute("href"),
      nameAttr: h.getAttribute("name"),
      placeholder: h.getAttribute("placeholder"),
      inputType: h.getAttribute("type"),
      textContent: null,
      structuralPath: null as string | null,
    };
    // Bombadil wants a structural path exactly when nothing else identifies the element.
    const named = [
      fingerprint.testId,
      fingerprint.id,
      fingerprint.role,
      fingerprint.accessibleName,
      fingerprint.href,
      fingerprint.nameAttr,
      fingerprint.placeholder,
      fingerprint.inputType,
    ];
    if (named.every((v) => v === null))
      fingerprint.structuralPath = `${fingerprint.tag}@${Math.round(x)},${Math.round(y)}`;
    out.push({ fingerprint, point: { x, y } });
  }
  return out;
});
const taps = actions(() => tappable.current.map((t) => ({ Click: t })));
export const kinActions = weighted([
  [20, taps],
  [3, scroll],
  [4, back],
  // Kin boots behind a splash; waiting keeps the walk alive until something is tappable.
  [1, actions(() => ["Wait"])],
]);
