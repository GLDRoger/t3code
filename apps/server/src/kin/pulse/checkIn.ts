import {
  KinEvent,
  KinEventId,
  type KinAgentId,
  type KinMemoryItemId,
  type KinOrgId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import * as KinEventQueue from "../lead/KinEventQueue.ts";
import {
  LOOSE_AFTER_MINUTES,
  LOOSE_BEFORE_MINUTES,
  looseSpanMinutes,
} from "../triggers/kinSchedules.ts";
import { dayIn } from "../work/money.ts";
import * as KinPulse from "./KinPulse.ts";
import { matchLines, type OutsideRead } from "./outside.ts";

const MINUTE = 60_000;
const sha = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

/**
 * How far into its window a loose slot fires: fixed per schedule and day, so a restart that
 * works it out again lands on the same minute, and the next day lands elsewhere.
 */
export const looseOffsetMs = (
  scheduleId: string,
  slot: string,
  spanMinutes = LOOSE_BEFORE_MINUTES + LOOSE_AFTER_MINUTES,
) => (Number.parseInt(sha(`${scheduleId}\0${slot}`).slice(0, 8), 16) % (spanMinutes + 1)) * MINUTE;

const decodeEvent = Schema.decodeUnknownEffect(KinEvent);
const OUTSIDE_CAP = 60;

/**
 * One check-in: the open facts and what is new outside, handed to the agent as one pulse event
 * at the slot's minute. With neither, nothing is queued and no model runs. `slot` keys the event,
 * so one slot queues once however often it is fired.
 */
export const queueCheckIn = Effect.fn("KinPulse.checkIn")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly scheduleId: KinMemoryItemId;
  readonly title: string;
  readonly what: string;
  /** When the native task's slot was due: the window's start when loose. */
  readonly dueAt: number;
  /** The time a loose check-in is around ("09:00"); null when it is exact. */
  readonly looseAt: string | null;
  /** A Run now tap: its own slot, at once. */
  readonly manualId?: string | undefined;
  readonly zone: string;
  readonly at: number;
  readonly outside: OutsideRead;
}) {
  const queue = yield* KinEventQueue.KinEventQueue;
  const { orgId, at } = input;
  const facts = yield* KinPulse.read({ orgId, at, viewer: { _tag: "owner" }, limit: 200 });
  const matched = yield* matchLines(orgId, input.outside.lines);
  const byId = new Map(matched.map(({ line }) => [`${line.source}\0${line.id}`, line]));
  const lines = input.outside.lines
    .map((line) => byId.get(`${line.source}\0${line.id}`) ?? line)
    .toSorted((a, b) => Number(b.matched !== undefined) - Number(a.matched !== undefined))
    .slice(0, OUTSIDE_CAP);
  if (facts.total === 0 && lines.length === 0) return { _tag: "nothing_new" } as const;
  const slot = input.manualId ?? dayIn(input.dueAt, input.zone);
  const notBefore =
    input.looseAt !== null && input.manualId === undefined
      ? input.dueAt + looseOffsetMs(input.scheduleId, slot, looseSpanMinutes(input.looseAt))
      : undefined;
  const dedupeKey = `checkin:${input.scheduleId}:${slot}`;
  const queued = yield* queue
    .enqueue(
      yield* decodeEvent({
        _tag: "pulse",
        orgId,
        eventId: KinEventId.make(`pulse-${sha(`${orgId}\0${dedupeKey}`).slice(0, 32)}`),
        agentId: input.agentId,
        receivedAt: DateTime.formatIso(DateTime.makeUnsafe(at)),
        dedupeKey,
        provenance: { _tag: "system" },
        factKeys: [],
        checkIn: {
          scheduleId: input.scheduleId,
          title: input.title.slice(0, 200),
          what: input.what.slice(0, 2000),
          slot: slot.slice(0, 200),
        },
        ...(lines.length === 0 ? {} : { outside: lines }),
        // A check-in or brief is judgement whatever an earlier one already told: the main model.
        strong: true,
      }),
      notBefore === undefined ? undefined : { notBefore },
    )
    .pipe(
      Effect.map((result) => (result.duplicate ? "duplicate" : "queued")),
      Effect.catchTags({
        KinEventQueueUnknownAgent: () => Effect.succeed("no_agent" as const),
        KinEventQueueRetiredAgent: () => Effect.succeed("no_agent" as const),
      }),
    );
  return {
    _tag: queued,
    facts: facts.total,
    outside: lines.length,
    notBefore: notBefore ?? at,
  } as const;
});
