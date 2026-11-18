import {
  KinPushSubject,
  kinMessageSubject,
  type KinChatId,
  type KinChatSummary,
  type KinMessageId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Where a tap on a Kin notification lands, on the phone and on the web alike: the entry it is
 * about, the reader's Tasks, a card's message in its chat, or the chat. `chatId` on a record or
 * on Tasks is the chat under it.
 */
export type KinNotificationDestination =
  | {
      readonly _tag: "chat";
      readonly chatId: KinChatId;
      readonly messageId: KinMessageId | null;
    }
  | {
      readonly _tag: "record";
      readonly chatId: KinChatId | null;
      readonly key: string;
      readonly kind: Extract<KinPushSubject, { readonly _tag: "record" }>["kind"];
    }
  | { readonly _tag: "tasks"; readonly chatId: KinChatId | null };

const decodeSubject = Schema.decodeUnknownOption(KinPushSubject);

/**
 * The landing for a notification's chat and subject. A subject this build can't read, or a card
 * outside the chat, lands on the chat; with neither, there is nothing to open here.
 */
export function kinNotificationDestination(input: {
  readonly chatId: KinChatId | undefined;
  readonly subject: unknown;
}): KinNotificationDestination | null {
  const chatId = input.chatId ?? null;
  const subject = Option.getOrNull(decodeSubject(input.subject));
  if (subject?._tag === "record")
    return { _tag: "record", chatId, key: subject.key, kind: subject.kind };
  if (subject?._tag === "tasks") return { _tag: "tasks", chatId };
  if (chatId === null) return null;
  return {
    _tag: "chat",
    chatId,
    messageId: subject?._tag === "message" ? subject.messageId : null,
  };
}

/** The landing for a chat's newest message, as its push would carry it to this reader. */
export const kinChatArrivalDestination = (chat: KinChatSummary): KinNotificationDestination =>
  kinNotificationDestination({
    chatId: chat.chatId,
    subject: chat.lastMessage === null ? undefined : kinMessageSubject(chat.lastMessage),
  }) ?? { _tag: "chat", chatId: chat.chatId, messageId: null };
