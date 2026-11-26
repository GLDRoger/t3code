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
  readonly owed: boolean;
  readonly answered: boolean;
  readonly withheld: boolean;
}): "rescue" | null => (input.owed && !input.answered && !input.withheld ? "rescue" : null);

export const sendClientMessageId = (wakeupId: KinWakeupId) => `kin-send:${wakeupId}`;
