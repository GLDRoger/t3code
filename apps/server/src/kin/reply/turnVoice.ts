import type { KinEvent, KinWakeupId } from "@t3tools/contracts";

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

export const replyNudgePrompt = (tags: ReadonlyArray<EventTag>) => {
  const words = tags.includes("pulse")
    ? "a check-in"
    : tags.includes("github")
      ? "a GitHub event"
      : "a trigger";
  return `This turn was started by ${words}, not by a person, so what you just wrote reached no one. If someone needs it, send it with kin_send. If not, end with kin_skip and it stays as your note.`;
};

export const sendRescuePrompt = (asker: string) =>
  `${asker} is waiting on this, and nothing you wrote reached anyone. Send what came of it now with kin_send.`;

export const sendClientMessageId = (wakeupId: KinWakeupId) => `kin-send:${wakeupId}`;
