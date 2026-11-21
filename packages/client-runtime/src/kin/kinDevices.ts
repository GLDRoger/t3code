import {
  KIN_DEVICE_LIMIT,
  KIN_DEVICE_LINK_TTL_MINUTES,
  KinChatError,
  formatKinWhen,
  type KinPersonDevice,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { kinFailureText } from "./kinAnswers.ts";
import { formatKinTime } from "./kinScreenState.ts";

export const KIN_DEVICES_COPY = {
  loadFailed: "Couldn't load devices",
  title: "Your devices",
  rowDetail: "Phones and browsers signed in as you",
  footer:
    "Each device stays signed in for 30 days from when it was linked. Then link it again here.",
  empty: "No devices linked yet.",
  link: "Link a device",
  linkDetail: `Works once, for ${KIN_DEVICE_LINK_TTL_MINUTES} minutes. Making a new one cancels this one.`,
  replaces: "Making a new one cancels this one.",
  renew: "Make a new link",
  dropped:
    "The connection dropped before the link could be shown. Make a new link once you're back online.",
  scan: "Scan this with the new phone, or open the link in the new browser.",
  expired: "This link has run out",
  expiredDetail: `Links work for ${KIN_DEVICE_LINK_TTL_MINUTES} minutes. Make a new one for the device.`,
  limit: `You have ${KIN_DEVICE_LIMIT} devices linked, the most Kin allows. Remove one you no longer use, then link the new one.`,
  remove: "Remove",
  thisDevice: "This device",
  ownerFooter: "Removing a device signs it out right away.",
} as const;

/** Signed in now: not removed and not run out. A device with no session left is gone too. */
export function kinActiveDevices(
  devices: ReadonlyArray<KinPersonDevice>,
  nowMs: number,
): ReadonlyArray<KinPersonDevice> {
  const recent = (device: KinPersonDevice) =>
    Date.parse(device.lastConnectedAt ?? device.boundAt) || 0;
  return devices
    .filter(
      (device) =>
        device.revokedAt === null &&
        device.expiresAt !== null &&
        Date.parse(device.expiresAt) > nowMs,
    )
    .sort(
      (left, right) =>
        Number(right.current === true) - Number(left.current === true) ||
        recent(right) - recent(left),
    );
}

export function kinDeviceLabel(device: KinPersonDevice): string {
  if (device.label !== null) return device.label;
  if (device.deviceType === "mobile") return "Phone";
  if (device.deviceType === "desktop") return "Computer";
  return "Device";
}

// @effect-diagnostics globalDate:off - the shared clock-and-day labels take a Date.
/** "Linked 3 Nov · Last connected 9:41": when it last opened a connection, not its last use. */
export function kinDeviceLine(device: KinPersonDevice, now: Date): string {
  const linked = new Date(device.boundAt);
  const day =
    linked.toDateString() === now.toDateString() ? "today" : formatKinWhen(linked, "date");
  const used =
    device.lastConnectedAt === null || device.lastConnectedAt === undefined
      ? ""
      : ` · Last connected ${formatKinTime(new Date(device.lastConnectedAt), now)}`;
  return `Linked ${day}${used}`;
}

/** Whether the asking device may remove this one. Older hosts don't say, and allowed it. */
export function kinDeviceRemovable(device: KinPersonDevice): boolean {
  return device.removable !== false;
}

/** The devices linked from this one, down the line: removing it signs them out too. */
export function kinDevicesLinkedFrom(
  device: KinPersonDevice,
  devices: ReadonlyArray<KinPersonDevice>,
): ReadonlyArray<KinPersonDevice> {
  const gone = new Set<string>([device.sessionId]);
  const linked: Array<KinPersonDevice> = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const other of devices)
      if (other.linkedFrom != null && gone.has(other.linkedFrom) && !gone.has(other.sessionId)) {
        gone.add(other.sessionId);
        linked.push(other);
        grew = true;
      }
  }
  return linked;
}

/**
 * The device a link this one just made brought in: linked from this device since the link was
 * made. Read from the host's list, so a list that loads late can't name an old device.
 */
export function kinDeviceJustLinked(
  devices: ReadonlyArray<KinPersonDevice>,
  linkId: string,
): KinPersonDevice | null {
  return devices.find((device) => device.linkId === linkId) ?? null;
}

/** The confirmation before a device is signed out, naming what goes with it. */
export function kinRemoveDeviceCopy(
  device: KinPersonDevice,
  mine: boolean,
  /** Every device the host listed: the chain runs through ones already signed out. */
  devices: ReadonlyArray<KinPersonDevice>,
  nowMs: number,
): { readonly title: string; readonly detail: string } {
  const active = new Set(kinActiveDevices(devices, nowMs).map((held) => held.sessionId));
  const linked = kinDevicesLinkedFrom(device, devices);
  const below = linked.filter((held) => active.has(held.sessionId));
  const names = below.map(kinDeviceLabel);
  const also =
    names.length === 0
      ? ""
      : names.length === 1
        ? ` ${names[0]}, linked from it, is signed out too.`
        : ` So are the devices linked from it: ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}.`;
  const own = device.keysMade ?? 0;
  const made = (from: ReadonlyArray<KinPersonDevice>) =>
    from.reduce((sum, held) => sum + (held.keysMade ?? 0), own);
  // Keys end on every device below, signed out already or not; only signed-in ones are named.
  const keys = made(linked);
  const where =
    keys === own
      ? "it"
      : keys === made(below)
        ? "these devices"
        : "it or on devices linked from it";
  const ends =
    keys === 0
      ? ""
      : ` This also ends the coding-agent ${keys === 1 ? "key" : "keys"} made on ${where}.`;
  return {
    title: `Remove ${kinDeviceLabel(device)}?`,
    detail:
      device.current === true
        ? `It's signed out right away.${also}${ends} This is the device you're using, so you'll be signed out here and need a new link to come back.`
        : mine
          ? `It's signed out right away.${also}${ends} Linking it again needs a new link.`
          : `It's signed out right away.${also}${ends} Their other devices stay signed in.`,
  };
}

/**
 * How long a fresh link still works, to the minute. `nowMs` may trail the real time by up to a
 * minute (the shared minute tick), so the count is capped at the code's lifetime.
 */
export function kinDeviceLinkLeft(
  expiresAt: string,
  nowMs: number,
): { readonly expired: true } | { readonly expired: false; readonly text: string } {
  const remaining = Date.parse(expiresAt) - nowMs;
  if (remaining <= 0) return { expired: true };
  const minutes = Math.min(KIN_DEVICE_LINK_TTL_MINUTES, Math.ceil(remaining / 60_000));
  const until = formatKinWhen(Date.parse(expiresAt), "time");
  return {
    expired: false,
    text: `Works once, until ${until} (${minutes} ${minutes === 1 ? "minute" : "minutes"} left).`,
  };
}

const isChatError = Schema.is(KinChatError);

/** Why no link was made, in the person's words. */
export function kinDeviceLinkProblem(error: unknown): string {
  if (isChatError(error) && error.reason === "limit") return KIN_DEVICES_COPY.limit;
  return kinFailureText(error, "Couldn't make a link.", {
    refused: "Your account can't link devices here.",
  });
}

export function kinRemoveDeviceProblem(error: unknown): string {
  return kinFailureText(error, "Couldn't remove that device.", {
    refused: "Remove this device from the device you joined with, or ask the owner.",
    gone: "That device was already signed out.",
  });
}
