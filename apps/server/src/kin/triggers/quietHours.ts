import * as DateTime from "effect/DateTime";

export type KinQuietHours = { readonly from: string; readonly to: string };

/** Used until the owner sets their own in Kin's settings. */
export const KIN_DEFAULT_QUIET_HOURS: KinQuietHours = { from: "21:00", to: "08:00" };

/** Whether `now` falls in `hours` on the wall clock of `zone`; `from` after `to` spans midnight. */
export function isQuiet(now: number, zone: string, hours: KinQuietHours) {
  const p = DateTime.toParts(DateTime.makeZonedUnsafe(now, { timeZone: zone }));
  const time = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  return hours.from < hours.to
    ? time >= hours.from && time < hours.to
    : hours.from > hours.to && (time >= hours.from || time < hours.to);
}
