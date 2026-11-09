import {
  EnvironmentId,
  KinPushCategory,
  KinPushData,
  kinDeferralItemIdFromWidgetId,
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
 * `/kin/<environmentId>/<orgId>/(chats|actions)/<id>`; anything else is dropped.
 */
function linkTarget(data: KinPushData): { environmentId: string; path: string } | null {
  const parts = data.deepLink.split("/");
  if (parts.length !== 6 || parts[0] !== "" || parts[1] !== "kin") return null;
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
