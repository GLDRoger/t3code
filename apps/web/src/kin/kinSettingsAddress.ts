import type { RouterHistory } from "@tanstack/react-router";

import { kinListAt, kinListSwitchHref } from "./kinListSwitch";

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** Settings was opened over this page, so closing it is one step back. */
    kinSettingsPushed?: boolean;
  }
}

// Settings lives in the address over whatever Kin page is open, as the profile sheet does, so a
// link opens it on a section and Back closes only Settings.
const SETTINGS_PARAM = "settings";

/** The open section: null while Settings is closed, "" when it is open with none chosen. */
export function kinSettingsSectionIn(searchStr: string): string | null {
  return new URLSearchParams(searchStr).get(SETTINGS_PARAM);
}

function withSection(href: string, section: string | null): string {
  const url = new URL(href, "http://kin.invalid");
  if (section === null) url.searchParams.delete(SETTINGS_PARAM);
  else url.searchParams.set(SETTINGS_PARAM, section);
  const search = url.searchParams.toString();
  return `${url.pathname}${search === "" ? "" : `?${search}`}${url.hash}`;
}

/** Settings on `section` over the Kin page last open: for an address outside Kin's pages. */
function kinSettingsHref(section: string): string {
  return withSection(kinListSwitchHref("threads"), section);
}

/** Opens Settings on `section` ("" for none chosen) over the page on screen. */
export function openKinSettings(history: RouterHistory, section = ""): void {
  const { pathname, search, hash, state } = history.location;
  if (kinListAt(pathname) !== "kin") {
    history.push(kinSettingsHref(section));
    return;
  }
  const href = withSection(`${pathname}${search}${hash}`, section);
  // From one section to another keeps the one step back to the page underneath.
  if (kinSettingsSectionIn(search) !== null) history.replace(href, state);
  else history.push(href, { ...state, kinSettingsPushed: true });
}

export function closeKinSettings(history: RouterHistory): void {
  const { pathname, search, hash, state } = history.location;
  if (state.kinSettingsPushed === true) return history.back();
  history.replace(withSection(`${pathname}${search}${hash}`, null), state);
}
