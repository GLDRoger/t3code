const PREFIX = "t3code:kin:calendar-hidden:";

/** Whether this browser shows calendar events in Dates (`kinCalendarDeviceKey`); on until turned off here. */
export function kinCalendarShownHere(key: string) {
  try {
    return window.localStorage.getItem(`${PREFIX}${key}`) !== "1";
  } catch {
    return true;
  }
}

export function rememberKinCalendarShown(key: string, shown: boolean) {
  try {
    if (shown) window.localStorage.removeItem(`${PREFIX}${key}`);
    else window.localStorage.setItem(`${PREFIX}${key}`, "1");
  } catch {
    // Storage off: the switch holds for this visit.
  }
}
