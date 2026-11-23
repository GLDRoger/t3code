import type { KinAgentId, KinEvent, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { SILENT_REPLY } from "../reply/classify.ts";
import { agentQuietUntil, personQuietUntil } from "../triggers/quietHold.ts";
import { isDraftWake } from "./draftWake.ts";
import { standingNow } from "./KinPulse.ts";
import { PREPARE_SENSES, URGENT_SENSES } from "./prepareSenses.ts";

const PREPARES: ReadonlySet<string> = new Set(PREPARE_SENSES);

/** A wake Kin queued for one of those facts: its own, not a check-in's or a person's follow-up. */
export const isPrepareWake = (
  event: KinEvent,
): event is Extract<KinEvent, { readonly _tag: "pulse" }> =>
  event._tag === "pulse" &&
  event.checkIn === undefined &&
  event.origin === undefined &&
  event.factKeys.length > 0 &&
  event.factKeys.every((key) => PREPARES.has(key.split(":")[0] ?? ""));

/** What the agent reads when Kin wakes it for one of those facts. */
export const HEAD_START_WAKE = `Kin woke you to make a head start on the facts given with this wake (each also marked wokeYou in the pulse). Do the first piece of each that can be done now; nothing is issued, paid or posted in this turn. A message that would leave the company is a draft whose card waits on a Confirm: nothing is sent, so never say it was. A document, form or notes go through doc_create or kin_document, linked to what they are for. Then tell the person it is for in at most two short sentences: what you prepared and where it is (the card or the link), and what was left open in it. Never retell what the draft says. Never ask a question where a draft would do. If nothing can be prepared, ask whoever has what is missing, as the pulse rule says; when no one does, say in one line what is missing. If a first piece of each already exists, write exactly ${SILENT_REPLY}.`;
/** A wake whose fact was handled or stopped being true before its turn. */
export const HEAD_START_GONE = `Kin checked this again as this turn started: it is handled or no longer true, so there is nothing to start. Write exactly ${SILENT_REPLY}.`;

/** The facts a head start is for, as true now (`standingNow`); undefined once none stands. */
export const prepareWakeText = Effect.fn("KinPulse.prepareWakeText")(function* (
  orgId: KinOrgId,
  factKeys: ReadonlyArray<string>,
  now: number,
) {
  const facts = yield* standingNow(orgId, factKeys, now);
  return facts.length === 0 ? undefined : { text: HEAD_START_WAKE, facts };
});

/**
 * When a wake Kin queued by itself, claimed inside the quiet hours it was held for, goes back to
 * the queue: a head start until its agent's owner is free, unless a client waits on us; a
 * follow-up until its person is. Such wakes are claimed alone, so the first one decides.
 */
export const wakeHeldUntil = Effect.fn("KinPulse.wakeHeldUntil")(function* (
  orgId: KinOrgId,
  agentId: KinAgentId,
  events: ReadonlyArray<KinEvent>,
  now: number,
) {
  const [event] = events;
  if (event?._tag !== "pulse") return undefined;
  if (isDraftWake(event) && event.origin?.personId !== undefined)
    return yield* personQuietUntil(orgId, event.origin.personId, now);
  if (!isPrepareWake(event)) return undefined;
  const urgent = events.some(
    (one) =>
      one._tag === "pulse" &&
      one.factKeys.some((key) => URGENT_SENSES.has(key.split(":")[0] ?? "")),
  );
  return urgent ? undefined : yield* agentQuietUntil(orgId, agentId, now);
});
