import {
  EnvironmentId,
  KinPushCategory,
  KinPushData,
  kinDeferralItemIdFromWidgetId,
  type KinChatId,
  type KinWidgetsActInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { KIN_NOTIFICATION_CATEGORIES, type KinNotificationAction } from "./kinCategories";

/** expo-notifications' `DEFAULT_ACTION_IDENTIFIER`: the banner itself was tapped. */
export const KIN_DEFAULT_ACTION_IDENTIFIER = "expo.modules.notifications.actions.DEFAULT";

export interface KinNotificationRoute {
  /** One per notification and button, so the live listener and the cold-start read act once. */
  readonly responseKey: string;
  readonly environmentId: EnvironmentId;
  readonly path: string;
  readonly act: KinWidgetsActInput | null;
}

const decodePushData = Schema.decodeUnknownOption(KinPushData);
const isCategory = Schema.is(KinPushCategory);

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

function pushData(raw: unknown): KinPushData | null {
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return Option.getOrNull(decodePushData(data));
}

const decodeSegment = (segment: string): string | null => {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded.length > 0 && decoded !== "." && decoded !== ".." ? decoded : null;
  } catch {
    return null;
  }
};

const kinChatPath = (environmentId: string, orgId: string, chatId: string) =>
  `/kin/${encodeURIComponent(environmentId)}/${encodeURIComponent(orgId)}/chats/${encodeURIComponent(chatId)}`;

/**
 * Where a push's `deepLink` opens, checked against the ids it carries. The sender writes
 * `/kin/<environmentId>/<orgId>/(chats|actions)/<id>`, `/kin/<environmentId>/<orgId>/approvals` or
 * `/kin/<environmentId>/<orgId>/people/<personId>/devices`; anything else is dropped.
 */
function linkTarget(data: KinPushData): { environmentId: string; path: string } | null {
  const parts = data.deepLink.split("/");
  if (parts[0] !== "" || parts[1] !== "kin") return null;
  if (parts.length === 5 && parts[4] === "approvals") {
    const [environmentId, orgId] = parts.slice(2, 4).map(decodeSegment);
    if (!environmentId || orgId !== data.orgId) return null;
    return {
      environmentId,
      path: `/kin/${encodeURIComponent(environmentId)}/${encodeURIComponent(orgId)}/approvals`,
    };
  }
  if (parts.length === 7 && parts[4] === "people" && parts[6] === "devices") {
    const [environmentId, orgId, , personId] = parts.slice(2).map(decodeSegment);
    if (!environmentId || !personId || orgId !== data.orgId) return null;
    return {
      environmentId,
      path: `/kin/${encodeURIComponent(environmentId)}/${encodeURIComponent(orgId)}/people/${encodeURIComponent(personId)}/devices`,
    };
  }
  if (parts.length !== 6) return null;
  const [environmentId, orgId, kind, id] = parts.slice(2).map(decodeSegment);
  if (!environmentId || !orgId || !kind || !id || orgId !== data.orgId) return null;
  if (kind === "chats") {
    if (data.chatId !== undefined && data.chatId !== id) return null;
    return { environmentId, path: kinChatPath(environmentId, orgId, id) };
  }
  if (kind === "actions") {
    if (data.pendingActionId !== undefined && data.pendingActionId !== id) return null;
    // MOB-8: open the `KinApproval` route (this link, re-encoded) once it exists. Until then
    // Review opens the chat holding the card, or the chat list for an approval with no chat.
    return {
      environmentId,
      path: data.chatId === undefined ? "/kin" : kinChatPath(environmentId, orgId, data.chatId),
    };
  }
  return null;
}

function deferralAct(
  data: KinPushData,
  action: KinNotificationAction,
  notificationId: string,
): KinWidgetsActInput | null {
  if (action.identifier === "review") return null;
  if (data.widgetId === undefined || data.revision === undefined || data.revision < 1) return null;
  const itemId = kinDeferralItemIdFromWidgetId(data.orgId, data.widgetId);
  if (itemId === null) return null;
  return {
    widgetId: data.widgetId,
    revision: data.revision,
    actionId: action.identifier,
    value: itemId,
    // The host dedupes on this, so a replayed response can't act twice.
    clientActionId: `push:${notificationId}:${action.identifier}`,
  };
}

/** What a tap on a Kin notification, or on one of its buttons, should do. Null for non-Kin pushes. */
export function kinNotificationRoute(response: unknown): KinNotificationRoute | null {
  const request = field(field(response, "notification"), "request");
  const content = field(request, "content");
  const data = pushData(field(content, "data"));
  if (data === null) return null;
  const target = linkTarget(data);
  if (target === null) return null;
  const notificationId = field(request, "identifier");
  const actionIdentifier = field(response, "actionIdentifier");
  if (typeof notificationId !== "string" || notificationId.length === 0) return null;
  const pressed = typeof actionIdentifier === "string" ? actionIdentifier : "";
  const category = field(content, "categoryIdentifier");
  const actions: ReadonlyArray<KinNotificationAction> = isCategory(category)
    ? KIN_NOTIFICATION_CATEGORIES[category]
    : [];
  const action =
    pressed === KIN_DEFAULT_ACTION_IDENTIFIER
      ? undefined
      : actions.find((candidate) => candidate.identifier === pressed);
  return {
    responseKey: `${notificationId}\u0000${pressed}`,
    environmentId: EnvironmentId.make(target.environmentId),
    path: target.path,
    act: action === undefined ? null : deferralAct(data, action, notificationId),
  };
}

/** Delivered notifications from this host's chats that `settled` says are done, by id. */
export function kinSettledNotificationIds(
  presented: ReadonlyArray<unknown>,
  environmentId: EnvironmentId,
  settled: (chatId: KinChatId) => boolean,
): ReadonlyArray<string> {
  return presented.flatMap((notification) => {
    const request = field(notification, "request");
    const identifier = field(request, "identifier");
    const data = pushData(field(field(request, "content"), "data"));
    if (typeof identifier !== "string" || data?.chatId === undefined) return [];
    const target = linkTarget(data);
    return target?.environmentId === environmentId && settled(data.chatId) ? [identifier] : [];
  });
}

/**
 * The chat a read on another device left with nothing unread, from a background push's task
 * payload (`data.dataString` is the push's `body`). Null for anything else.
 */
export function kinClearedChat(
  payload: unknown,
): { readonly environmentId: EnvironmentId; readonly chatId: KinChatId } | null {
  const data = pushData(field(field(payload, "data"), "dataString"));
  if (data?.cleared !== true || data.chatId === undefined) return null;
  const target = linkTarget(data);
  return target === null
    ? null
    : { environmentId: EnvironmentId.make(target.environmentId), chatId: data.chatId };
}

export type KinActionDelivery = "drop" | "wait" | "post";

/** What to do with a pending notification button tap, given the current Kin host. */
export function kinActionDelivery(input: {
  /** Null until this phone knows its Kin host. */
  readonly hostEnvironmentId: EnvironmentId | null;
  readonly targetEnvironmentId: EnvironmentId;
  readonly connected: boolean;
  readonly inFlight: boolean;
}): KinActionDelivery {
  if (input.hostEnvironmentId === null) return "wait";
  // Any host holding this phone's token can send a push; only the Kin host's own buttons act.
  if (input.hostEnvironmentId !== input.targetEnvironmentId) return "drop";
  return input.inFlight || !input.connected ? "wait" : "post";
}
