import { type RouterHistory, useLocation, useRouter } from "@tanstack/react-router";

import { kinListAt, kinReturnHref } from "./kinListSwitch";

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** Settings was opened over this page, so closing it is one step back. */
    kinSettingsPushed?: boolean;
  }
}

// Settings lives in the address over whatever Kin page is open, as the profile sheet does, so a
// link opens it on a section and Back closes only Settings.
const SETTINGS_PARAM = "settings";
// What Memory opens filtered to, from a search result, or the connection Connections opens at.
const FIND_PARAM = "find";
// The setting a search found, by its settings-search id. Not the hash: the app's settings pages
// act on a hash themselves, and Kin's Settings lands on the row its own way.
const AT_PARAM = "at";

/** The open section: null while Settings is closed, "" when it is open with none chosen. */
export function kinSettingsSectionIn(searchStr: string): string | null {
  return new URLSearchParams(searchStr).get(SETTINGS_PARAM);
}

/** The settings-search id of the setting Settings opens at, or "". */
const kinSettingsAtIn = (searchStr: string): string =>
  new URLSearchParams(searchStr).get(AT_PARAM) ?? "";

/** The words Memory opens filtered to, the connection Connections opens at, or "". */
export const kinSettingsFindIn = (searchStr: string): string =>
  new URLSearchParams(searchStr).get(FIND_PARAM) ?? "";

function withSection(href: string, section: string | null, find?: string, target?: string): string {
  const url = new URL(href, "http://kin.invalid");
  url.searchParams.delete(FIND_PARAM);
  url.searchParams.delete(AT_PARAM);
  if (section === null) url.searchParams.delete(SETTINGS_PARAM);
  else url.searchParams.set(SETTINGS_PARAM, section);
  if (section !== null && find !== undefined && find !== "") url.searchParams.set(FIND_PARAM, find);
  if (section !== null && target !== undefined) url.searchParams.set(AT_PARAM, target);
  const search = url.searchParams.toString();
  return `${url.pathname}${search === "" ? "" : `?${search}`}${url.hash}`;
}

/** Settings on `section` over the Kin page last open: for an address outside Kin's pages. */
function kinSettingsHref(section: string, find?: string, target?: string): string {
  return withSection(kinReturnHref(), section, find, target);
}

/**
 * Opens Settings on `section` ("" for none chosen) over the page on screen; Memory can open
 * filtered to `find`, and Connections at the connection it names. `target` is the setting the
 * section scrolls to, by its settings-search id.
 */
export function openKinSettings(
  history: RouterHistory,
  section = "",
  find?: string,
  target?: string,
): void {
  const { pathname, search, hash, state } = history.location;
  if (kinListAt(pathname) !== "kin") {
    history.push(kinSettingsHref(section, find, target));
    return;
  }
  const href = withSection(`${pathname}${search}${hash}`, section, find, target);
  // From one section to another keeps the one step back to the page underneath.
  if (kinSettingsSectionIn(search) !== null) history.replace(href, state);
  else history.push(href, { ...state, kinSettingsPushed: true });
}

/** Memory filtered to `find`, in place of the dialog `dialogParam` names, as a search hit opens. */
export function openKinMemoryInstead(history: RouterHistory, find: string, dialogParam: string) {
  const { pathname, search, hash, state } = history.location;
  const params = new URLSearchParams(search);
  params.delete(dialogParam);
  const rest = params.toString();
  history.replace(
    withSection(`${pathname}${rest === "" ? "" : `?${rest}`}${hash}`, "memory", find),
    state,
  );
}

/** Settings on `section` in place of the dialog `dialogParam` names; Back brings that dialog back. */
export function openKinSettingsInstead(
  history: RouterHistory,
  section: string,
  dialogParam: string,
) {
  const { pathname, search, hash, state } = history.location;
  const params = new URLSearchParams(search);
  params.delete(dialogParam);
  const rest = params.toString();
  history.push(withSection(`${pathname}${rest === "" ? "" : `?${rest}`}${hash}`, section), {
    ...state,
    kinSettingsPushed: true,
  });
}

export function closeKinSettings(history: RouterHistory): void {
  const { pathname, search, hash, state } = history.location;
  if (state.kinSettingsPushed === true) return history.back();
  history.replace(withSection(`${pathname}${search}${hash}`, null), state);
}

const FOUND_ATTRIBUTE = "data-kin-setting-found";
const HANDS_ON = ["wheel", "touchmove", "pointerdown", "keydown"] as const;

/**
 * A ref for the open section's scroller: brings the setting the address names into view, focuses
 * and marks it until focus leaves. Rows draw as their data arrives, so it waits for the row and
 * holds it in view while the page above it settles, until the person scrolls, clicks or types.
 */
export function useKinSettingLanding() {
  const at = useLocation({ select: (location) => kinSettingsAtIn(location.searchStr) });
  const router = useRouter();
  return (body: HTMLElement | null) => {
    if (body === null || at === "") return;
    let row: HTMLElement | null = null;
    const center = () => {
      if (row === null) return;
      // Only the page's own scroller moves: scrollIntoView would also shift the dialog's frame.
      const scroller = row.closest<HTMLElement>("[data-settings-page-scroll]") ?? body;
      const box = scroller.getBoundingClientRect();
      const rect = row.getBoundingClientRect();
      scroller.scrollTop += rect.top - box.top - Math.max(16, (box.height - rect.height) / 2);
    };
    const settle = () => {
      if (row === null) {
        const found = document.getElementById(at);
        if (found === null || !body.contains(found)) return;
        row = found;
        found.setAttribute(FOUND_ATTRIBUTE, "");
        found.focus({ preventScroll: true });
        found.addEventListener("blur", () => found.removeAttribute(FOUND_ATTRIBUTE), {
          once: true,
        });
      }
      center();
    };
    const watch = new MutationObserver(settle);
    const release = () => {
      watch.disconnect();
      for (const type of HANDS_ON) body.removeEventListener(type, release, true);
      const { pathname, search, hash, state } = router.history.location;
      const params = new URLSearchParams(search);
      if (params.get(AT_PARAM) !== at) return;
      params.delete(AT_PARAM);
      const rest = params.toString();
      router.history.replace(`${pathname}${rest === "" ? "" : `?${rest}`}${hash}`, state);
    };
    watch.observe(body, { childList: true, subtree: true, characterData: true });
    for (const type of HANDS_ON) body.addEventListener(type, release, true);
    settle();
    return () => {
      watch.disconnect();
      for (const type of HANDS_ON) body.removeEventListener(type, release, true);
    };
  };
}
