import {
  EnvironmentId,
  KinPushCategory,
  KinPushData,
  kinDeferralItemIdFromWidgetId,
  type KinChatId,
  type KinWidgetsActInput,
} from "@t3tools/contracts";
import { kinChoiceActInput } from "@t3tools/client-runtime/kin/kinChoicePresentation";
import { kinNotificationDestination } from "@t3tools/client-runtime/kin/kinNotificationDestination";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  KIN_CHOICE_ANSWERS,
  KIN_NOTIFICATION_CATEGORIES,
  type KinNotificationAction,
} from "./kinCategories";

/** expo-notifications' `DEFAULT_ACTION_IDENTIFIER`: the banner itself was tapped. */
export const KIN_DEFAULT_ACTION_IDENTIFIER = "expo.modules.notifications.actions.DEFAULT";

export interface KinNotificationRoute {
  /** One per notification and button, so the live listener and the cold-start read act once. */
  readonly responseKey: string;
  readonly environmentId: EnvironmentId;
  /** Opened in order: the chat, then what the push is about over it, so Back lands in the chat. */
  readonly paths: ReadonlyArray<string>;
  readonly act: KinWidgetsActInput | null;
}

const decodePushData = Schema.decodeUnknownOption(KinPushData);
const isCategory = Schema.is(KinPushCategory);

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/** The push's data, its `subject` left raw: one a later build adds must not lose the chat. */
function pushData(raw: unknown): { readonly data: KinPushData; readonly subject: unknown } | null {
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof data !== "object" || data === null) return null;
  const { subject, ...rest } = data as Record<string, unknown>;
  return Option.match(decodePushData(rest), {
    onNone: () => null,
    onSome: (decoded) => ({ data: decoded, subject }),
  });
}

const decodeSegment = (segment: string): string | null => {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded.length > 0 && decoded !== "." && decoded !== ".." ? decoded : null;
  } catch {
    return null;
  }
};

const kinPath = (environmentId: string, orgId: string, ...rest: ReadonlyArray<string>) =>
  `/kin/${[environmentId, orgId, ...rest].map(encodeURIComponent).join("/")}`;
const kinChatPath = (environmentId: string, orgId: string, chatId: string) =>
  kinPath(environmentId, orgId, "chats", chatId);
const RECORD_SCREEN = {
  task: "work",
  entry: "work",
  client: "clients",
  project: "projects",
  doc: "docs",
} as const;

/**
 * What a tap opens: the push's subject when this build can open it, over the chat it came in;
 * else the link's own screen. A subject that is gone shows its screen's not-found over the chat.
 */
function landing(
  data: KinPushData,
  subject: unknown,
  target: { readonly environmentId: string; readonly path: string },
): ReadonlyArray<string> {
  const opensChat =
    data.chatId !== undefined &&
    target.path === kinChatPath(target.environmentId, data.orgId, data.chatId);
  const destination = opensChat
    ? kinNotificationDestination({ chatId: data.chatId, subject })
    : null;
  if (destination === null)
    return target.path.startsWith(`${kinPath(target.environmentId, data.orgId, "work")}/`)
      ? [kinPath(target.environmentId, data.orgId, "work"), target.path]
      : [target.path];
  if (destination._tag === "chat")
    return [
      destination.messageId === null
        ? target.path
        : `${target.path}?message=${encodeURIComponent(destination.messageId)}`,
    ];
  if (destination._tag === "tasks")
    return [target.path, kinPath(target.environmentId, data.orgId, "work")];
  return [
    target.path,
    kinPath(target.environmentId, data.orgId, RECORD_SCREEN[destination.kind], destination.key),
  ];
}

/**
 * Where a push's `deepLink` opens, checked against the ids it carries. The sender writes
 * `/kin/<environmentId>/<orgId>/(chats|actions|work|projects)/<id>`,
 * `/kin/<environmentId>/<orgId>/(approvals|work)` or
 * `/kin/<environmentId>/<orgId>/people/<personId>/devices`; anything else is dropped.
 */
function linkTarget(data: KinPushData): { environmentId: string; path: string } | null {
  const parts = data.deepLink.split("/");
  if (parts[0] !== "" || parts[1] !== "kin") return null;
  if (parts.length === 5 && parts[4] === "work") {
    const [environmentId, orgId] = parts.slice(2, 4).map(decodeSegment);
    if (!environmentId || orgId !== data.orgId) return null;
    return { environmentId, path: kinPath(environmentId, orgId, "work") };
  }
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
  // Someone's moves on the reader's tasks, told in no chat: the one task or project, over Tasks.
  if (kind === "work" || kind === "projects")
    return { environmentId, path: kinPath(environmentId, orgId, kind, id) };
  if (kind === "actions") {
    if (data.pendingActionId !== undefined && data.pendingActionId !== id) return null;
    // MOB-8: open the `KinApproval` route (this link, re-encoded) once it exists. Until then
    // Review opens the chat holding the card, or Waiting on you for an approval with no chat.
    return {
      environmentId,
      path:
        data.chatId === undefined ? "/kin/waiting" : kinChatPath(environmentId, orgId, data.chatId),
    };
  }
  return null;
}

/** A button's widget action: a question's answer exactly as a tap on its card posts it. */
function buttonAct(
  data: KinPushData,
  action: KinNotificationAction,
  notificationId: string,
): KinWidgetsActInput | null {
  if (action.identifier === "review") return null;
  if (data.widgetId === undefined || data.revision === undefined || data.revision < 1) return null;
  // The host dedupes on this, so a replayed response can't act twice.
  const clientActionId = `push:${notificationId}:${action.identifier}`;
  const answer = KIN_CHOICE_ANSWERS.findIndex((one) => one === action.identifier);
  if (answer >= 0) {
    const optionId = data.choices?.[answer];
    return optionId === undefined
      ? null
      : kinChoiceActInput(
          { widgetId: data.widgetId, revision: data.revision },
          optionId,
          clientActionId,
        );
  }
  const itemId = kinDeferralItemIdFromWidgetId(data.orgId, data.widgetId);
  if (itemId === null) return null;
  return {
    widgetId: data.widgetId,
    revision: data.revision,
    actionId: action.identifier,
    value: itemId,
    clientActionId,
  };
}

/** What a tap on a Kin notification, or on one of its buttons, should do. Null for non-Kin pushes. */
export function kinNotificationRoute(response: unknown): KinNotificationRoute | null {
  const request = field(field(response, "notification"), "request");
  const content = field(request, "content");
  const read = pushData(field(content, "data"));
  if (read === null) return null;
  const { data } = read;
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
    paths: landing(data, read.subject, target),
    act: action === undefined ? null : buttonAct(data, action, notificationId),
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
    const data = pushData(field(field(request, "content"), "data"))?.data;
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
  const data = pushData(field(field(payload, "data"), "dataString"))?.data;
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
