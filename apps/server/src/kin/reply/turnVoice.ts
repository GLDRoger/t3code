import type { KinEvent, KinWakeupId } from "@t3tools/contracts";

import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import { normalized } from "./classify.ts";

type EventTag = KinEvent["_tag"];

export const PERSON_TAGS = [
  "chat.message",
  "widget.action",
  "chat.reaction",
] as const satisfies ReadonlyArray<EventTag>;
type PersonTag = (typeof PERSON_TAGS)[number];

export const TRIGGER_TAGS = {
  github: true,
  "deferral.due": true,
  routine: true,
  watchdog: true,
  pulse: true,
  "record.changed": true,
  "task.finished": true,
  "action.resolved": true,
  "bills.read": true,
  resume: true,
} satisfies Record<Exclude<EventTag, PersonTag>, true>;

export const isPersonTag = (tag: string): tag is PersonTag =>
  PERSON_TAGS.some((personTag) => personTag === tag);

export const startedBy = (tags: ReadonlyArray<EventTag>): "person" | "trigger" =>
  tags.some(isPersonTag) ? "person" : "trigger";

export const voiceFor = (input: {
  readonly tags: ReadonlyArray<EventTag>;
  readonly sendOnly: boolean;
}): "text" | "send" => (input.sendOnly && startedBy(input.tags) === "trigger" ? "send" : "text");

export const followUpFor = (input: {
  readonly voice: "text" | "send";
  readonly owed: boolean;
  readonly answered: boolean;
  readonly withheld: boolean;
  readonly sent: boolean;
  readonly skipped: boolean;
  readonly finalText: boolean;
}): "rescue" | "nudge" | null => {
  if (input.withheld || input.sent || input.skipped) return null;
  if (input.owed) return input.answered ? null : "rescue";
  return input.voice === "send" && input.finalText ? "nudge" : null;
};

/** What a triggered turn's header and nudge say started it, from stored fields only. */
type StartedBy = {
  readonly _tag: EventTag;
  readonly subject?:
    | {
        readonly type: string;
        readonly approved?: true | undefined;
        readonly answered?: true | undefined;
        readonly dismissed?: true | undefined;
        readonly reopened?: true | undefined;
        readonly lapsed?: true | undefined;
        readonly undone?: true | undefined;
      }
    | undefined;
  readonly checkIn?: { readonly scheduleId: string } | undefined;
  readonly reason?: string | undefined;
};
const CHECK_IN_WORDS: Record<string, string> = {
  "checkin-morning": "the morning check-in",
  "checkin-evening": "the evening check-in",
  "checkin-weekly": "the weekly check-in",
};
const DUE_WORDS: Record<string, string> = {
  reminder: "a reminder coming due",
  scheduled_task: "a scheduled task's run",
  followup: "a follow-up coming due",
  deferral: "something put off coming due",
  country: "the company's country being set",
};
const questionWords = (subject: NonNullable<StartedBy["subject"]>) =>
  subject.approved === true
    ? "a draft the owner approved"
    : subject.answered === true
      ? "an answer to a question you asked"
      : subject.lapsed === true
        ? "a question lapsing unanswered"
        : subject.dismissed === true
          ? subject.reopened === true
            ? "a dismissed question reopened"
            : "a question card dismissed"
          : subject.undone === true
            ? "an answer put back"
            : "an open question reaching its day";
const startedWords = (event: StartedBy): string | undefined => {
  switch (event._tag) {
    case "github":
      return "a GitHub event";
    case "deferral.due":
      return event.subject?.type === "question"
        ? questionWords(event.subject)
        : (DUE_WORDS[event.subject?.type ?? ""] ?? "something coming due");
    case "routine":
      return "a scheduled brief";
    case "watchdog":
      return "Kin's watch";
    case "pulse":
      return event.checkIn === undefined
        ? "something Kin noticed in its records"
        : (CHECK_IN_WORDS[event.checkIn.scheduleId] ?? "a check-in");
    case "record.changed":
      return event.reason === "assigned" ? "work given to you" : "a change to work you hold";
    case "task.finished":
      return "work you delegated finishing";
    case "action.resolved":
      return "an approval's outcome";
    case "bills.read":
      return "bills to read";
    case "resume":
      return "Kin resuming after a pause";
    default:
      return undefined;
  }
};
export const triggerWords = (events: ReadonlyArray<StartedBy>) => {
  const words = [...new Set(events.flatMap((event) => startedWords(event) ?? []))];
  return words.length === 0
    ? "a trigger"
    : words.length === 1
      ? words[0]!
      : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
};

export const replyNudgePrompt = (events: ReadonlyArray<StartedBy>) =>
  `This turn was started by ${triggerWords(events)}, not by a person, so what you just wrote reached no one. If someone needs it, send it with kin_send. If not, end with kin_skip and it stays as your note.`;

export const sendRescuePrompt = (asker: string) =>
  `${asker} is waiting on this, and nothing you wrote reached anyone. Send what came of it now with kin_send.`;

export const sendClientMessageId = (wakeupId: KinWakeupId) => `kin-send:${wakeupId}`;
const UPDATE_PREFIX = "kin-update:";
export const STORED_UPDATE_PREFIX = `send:${UPDATE_PREFIX}`;
export const updateClientMessageId = Effect.fn("KinReplyBridge.updateClientMessageId")(function* (
  wakeupId: KinWakeupId,
  text: string,
) {
  const digest = yield* Digest.Digest;
  const hash = yield* digest.digest(Digest.sha256, new TextEncoder().encode(normalized(text)));
  return `${UPDATE_PREFIX}${wakeupId}:${Hex.encode(hash).slice(0, 16)}`;
});

export const UPDATE_SHOWN =
  "Shown in the chat without a notification. Carry on; write your reply when the work is done.";

export const UPDATE_REFUSALS = {
  "not running": "Not shown: this turn is no longer running.",
  quiet: "Not shown: this turn posts to no chat.",
  trigger:
    "Not shown: a trigger started this turn, so no one is waiting on progress. Finish the work, then send what came of it with kin_send, or end with kin_skip.",
  "not direct":
    "Not shown: updates go only to a direct chat. Carry on; here your reply is the one message.",
  "already sent": "Not shown: this turn's reply is already sent. End the turn.",
  "too long":
    "Not shown: an update is a line or two. The whole answer goes in your reply at the end.",
  same: "Not shown: that update is already in the chat. Carry on with the work.",
  limit: "Not shown: this turn has no updates left. Carry on; your reply still goes at the end.",
} as const;

// Words under eval: change them only with the send cases.
export const SEND_REFUSALS = {
  team: "Nothing was sent: use team_say to speak in the Team room.",
  quiet: "Nothing was sent: this turn posts to no chat. End the turn.",
  "already skipped": "Nothing was sent: this turn already ended with kin_skip.",
  "already sent": "Nothing more was sent: this turn's one message is already sent. End the turn.",
  "non-owner check-in":
    "Nothing was sent: check_in is only for the owner's own chat. Use now or quiet here.",
  "no check-in": "Nothing was sent: no check-in is on. Use now or quiet to send it to the chat.",
  "not running": "Nothing was sent: this turn is no longer running.",
  "not posted":
    "Nothing was sent: Kin could not post this message in this chat. Send it once more only if you changed it; otherwise end the turn.",
  repeat:
    "Nothing was sent: this turn already posted those words in this chat. End the turn, or send only what is new.",
} as const;
