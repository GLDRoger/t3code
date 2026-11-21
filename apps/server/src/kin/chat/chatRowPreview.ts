import {
  kinIsBrief,
  kinMessageShape,
  kinPageGist,
  type KinChatSummary,
  type KinMessageId,
} from "@t3tools/contracts";

/** What stays of a page's body in a row sent with its line. */
const KIN_ROW_BODY_CHARS = 280;

const cut = (body: string) => {
  const end = Math.min(body.length, KIN_ROW_BODY_CHARS);
  // Never half of a surrogate pair.
  const code = body.charCodeAt(end - 1);
  return body.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end);
};

/**
 * A row for a client with `acceptPreview`. A page goes as its line, which is all a row, a push or
 * an alert shows of it; a message an open waiting item names keeps its body, which that item shows.
 */
export const previewRow = (
  chat: KinChatSummary,
  waitedOn: (messageId: KinMessageId) => boolean,
): KinChatSummary => {
  const last = chat.lastMessage;
  if (last === null || kinMessageShape(last) === "bubble" || waitedOn(last.messageId)) return chat;
  const body = cut(last.body);
  if (body.length === last.body.length || body.trim() === "") return chat;
  const { embeds: _embeds, turnChanges: _turnChanges, ...message } = last;
  return {
    ...chat,
    lastMessage: { ...message, body },
    lastPreview: { gist: kinPageGist(last.body), brief: kinIsBrief(last.body, last.form) },
  };
};
