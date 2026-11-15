import { KinRecordId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Touches from "../../work/touches.ts";
import {
  agentOrOwner,
  daysText,
  hoursText,
  iso,
  type SenseContext,
  type SensedFact,
} from "./shared.ts";

const consequence = (one: Touches.ClientSense) => {
  const silence =
    one.lastAt === null ? "No logged contact yet" : `No logged contact for ${daysText(one.days)}`;
  if (one.sense === "client_quiet") return `${silence}, during an open project.`;
  if (one.sense === "client_cold") return `${silence}, and nothing open with them.`;
  return `Something we owe them is ${hoursText(one.late ?? 0)} past due.`;
};

/** Contact with clients: quiet during a project, cold without one, waiting on something of ours. */
export const clientSenses = Effect.fn("KinPulse.clientSenses")(function* (ctx: SenseContext) {
  const sensed = yield* Touches.clientSenses(ctx.orgId, ctx.at);
  return sensed.map((one): SensedFact => ({
    sense: one.sense,
    family: "work",
    key: `${one.sense}:${one.episode}`,
    subject: {
      kind: "record",
      key: one.key,
      title: one.name,
      recordId: KinRecordId.make(one.partyId),
    },
    scope: { clientKey: one.key, clientTitle: one.name },
    since: iso(one.since),
    measure: {
      value: one.sense === "client_waiting_on_us" ? (one.late ?? 0) : one.days,
      unit: one.sense === "client_waiting_on_us" ? "hours" : "days",
      threshold: one.limit.value,
      from: one.limit.from,
    },
    consequence: consequence(one),
    actor: agentOrOwner(ctx.chief),
    sensitive: one.sensitive,
    // Late work already wakes its holder as task_late; this one only reaches briefs.
    wake: one.sense === "client_waiting_on_us" ? "brief" : "sweep",
  }));
});
