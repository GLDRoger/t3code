import type { RouterHistory } from "@tanstack/react-router";

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

/** The open section: null while Settings is closed, "" when it is open with none chosen. */
export function kinSettingsSectionIn(searchStr: string): string | null {
  return new URLSearchParams(searchStr).get(SETTINGS_PARAM);
}

/** The words Memory opens filtered to, the connection Connections opens at, or "". */
export const kinSettingsFindIn = (searchStr: string): string =>
  new URLSearchParams(searchStr).get(FIND_PARAM) ?? "";

function withSection(
  href: string,
  section: string | null,
  find?: string,
  target?: string,
): string {
  const url = new URL(href, "http://kin.invalid");
  if (target !== undefined) url.hash = target;
  url.searchParams.delete(FIND_PARAM);
  if (section === null) url.searchParams.delete(SETTINGS_PARAM);
  else url.searchParams.set(SETTINGS_PARAM, section);
  if (section !== null && find !== undefined && find !== "") url.searchParams.set(FIND_PARAM, find);
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
