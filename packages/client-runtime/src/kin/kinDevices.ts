import {
  KIN_DEVICE_LIMIT,
  KIN_DEVICE_LINK_TTL_MINUTES,
  KinChatError,
  formatKinWhen,
  type KinPersonDevice,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { renewRemoteKinDevice } from "../authorization/remote.ts";
import { BearerConnectionCredential, type ConnectionCatalogEntry } from "../connection/catalog.ts";
import { ConnectionCredentialStore } from "../connection/credentialStore.ts";
import { credentialConnectionId } from "../connection/routes.ts";
import { kinFailureText } from "./kinAnswers.ts";
import { formatKinTime } from "./kinScreenState.ts";

export const KIN_DEVICES_COPY = {
  title: "Linked devices",
  rowDetail: "Phones and computers signed in as you",
  footer:
    "Each device stays signed in while you use it. One unused for 30 days signs out; link it again here.",
  empty: "No devices linked yet.",
  link: "Link a device",
  linkDetail: `Works once, for ${KIN_DEVICE_LINK_TTL_MINUTES} minutes. Making a new one cancels this one.`,
  replaces: "Making a new one cancels this one.",
  computerTitle: "On a computer with Claude Code or T3 Code",
  computerDetail:
    "Run the command, or paste the code into a Claude Code or T3 Code session and ask it to link Kin.",
  renew: "Make a new code",
  dropped:
    "The connection dropped before the link could be shown. Make a new code once you're back online.",
  phoneTitle: "On a phone or in a browser",
  phoneDetail: "Open the link, or scan the code.",
  limit: `You have ${KIN_DEVICE_LIMIT} devices linked, the most Kin allows. Remove one you no longer use, then link the new one.`,
  remove: "Remove",
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
/** "Linked 3 Nov · Last used 9:41". */
export function kinDeviceLine(device: KinPersonDevice, now: Date): string {
  const linked = new Date(device.boundAt);
  const day =
    linked.toDateString() === now.toDateString() ? "today" : formatKinWhen(linked, "date");
  const used =
    device.lastConnectedAt === null || device.lastConnectedAt === undefined
      ? ""
      : ` · Last used ${formatKinTime(new Date(device.lastConnectedAt), now)}`;
  return `Linked ${day}${used}`;
}

/** The confirmation before a device is signed out. */
export function kinRemoveDeviceCopy(
  device: KinPersonDevice,
  mine: boolean,
): { readonly title: string; readonly detail: string } {
  return {
    title: `Remove ${kinDeviceLabel(device)}?`,
    detail:
      device.current === true
        ? "It's signed out right away. This is the device you're using, so you'll be signed out here and need a new link to come back."
        : mine
          ? "It's signed out right away. Linking it again needs a new code."
          : "It's signed out right away. Their other devices stay signed in.",
  };
}

/** What a computer runs to link itself with a code. */
export function kinDeviceJoinCommand(code: string, httpBaseUrl: string): string {
  return `kin-mcp-bridge join ${code} --server ${new URL(httpBaseUrl).origin}`;
}

/**
 * How long a fresh code still works, to the minute. `nowMs` may trail the real time by up to a
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

/** Why no code was made, in the person's words. */
export function kinDeviceLinkProblem(error: unknown): string {
  if (isChatError(error) && error.reason === "limit") return KIN_DEVICES_COPY.limit;
  return kinFailureText(error, "Couldn't make a code.", {
    refused: "Your account can't link devices here.",
  });
}

export function kinRemoveDeviceProblem(error: unknown): string {
  return kinFailureText(error, "Couldn't remove that device.", {
    gone: "That device was already signed out.",
  });
}

/**
 * Renews a teammate's saved bearer on this device: the same session under a fresh deadline. The
 * live connection keeps its socket; the next connection uses the new token.
 */
export const renewKinTeammateDevice = Effect.fn("kin.devices.renewTeammate")(function* (
  entry: ConnectionCatalogEntry,
) {
  if (entry.target._tag !== "BearerConnectionTarget" || Option.isNone(entry.profile)) return false;
  const profile = entry.profile.value;
  if (profile._tag !== "BearerConnectionProfile") return false;
  const credentials = yield* ConnectionCredentialStore;
  const connectionId = credentialConnectionId(entry.target.connectionId);
  const stored = yield* credentials.get(connectionId);
  if (Option.isNone(stored)) return false;
  const renewed = yield* renewRemoteKinDevice({
    httpBaseUrl: profile.httpBaseUrl,
    bearerToken: stored.value.token,
  });
  if (renewed.accessToken === undefined) return false;
  yield* credentials.put(
    connectionId,
    new BearerConnectionCredential({ token: renewed.accessToken }),
  );
  return true;
});
