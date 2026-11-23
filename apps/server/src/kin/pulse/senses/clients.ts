import { KinRecordId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as KinShell from "../../shell/KinShell.ts";
import * as Touches from "../../work/touches.ts";
import {
  agentOrOwner,
  daysText,
  iso,
  lateText,
  type SenseContext,
  type SensedFact,
} from "./shared.ts";

const KIND_WORDS: Record<NonNullable<Touches.ClientSense["lastKind"]>, string> = {
  call: "a call",
  meeting: "a meeting",
  email: "an email",
  message: "a message",
  other: "a contact",
  invoice: "an invoice",
  quote: "a quote",
  payment: "a payment",
};

const consequence = (ctx: SenseContext, one: Touches.ClientSense, counts: string) => {
  const silence =
    one.from === "added"
      ? one.days === 0
        ? "No contact logged yet"
        : `No contact logged since they were added ${daysText(one.days)} ago`
      : one.from === "project"
        ? `Nothing logged since their last project ended ${daysText(one.days)} ago`
        : `No contact ${lateText(ctx, one.lastAt ?? ctx.at)} (${counts} count; the last was ${one.lastKind === null ? "a contact" : KIND_WORDS[one.lastKind]})`;
  if (one.sense === "client_quiet") return `${silence}, during an open project.`;
  if (one.sense === "client_cold") return `${silence}, and nothing open with them.`;
  return `Something we owe them has been past due ${lateText(ctx, one.dueAt ?? ctx.at)}.`;
};

/** Contact with clients: quiet during a project, cold without one, waiting on something of ours. */
export const clientSenses = Effect.fn("KinPulse.clientSenses")(function* (ctx: SenseContext) {
  const shell = yield* KinShell.getForDisplay(ctx.orgId);
  const invoices = KinShell.sectionOn(shell, "invoices");
  const money = KinShell.sectionOn(shell, "money");
  const counts = invoices
    ? "calls, meetings, mail, invoices and payments"
    : money
      ? "calls, meetings, mail and payments"
      : "calls, meetings and mail";
  const sensed = yield* Touches.clientSenses(ctx.orgId, ctx.at, { invoices, money });
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
    consequence: consequence(ctx, one, counts),
    actor: agentOrOwner(ctx.chief),
    sensitive: one.sensitive,
    // The late work itself reaches its holder once as task_late (`tellHolders`); this, briefs.
    wake: one.sense === "client_waiting_on_us" ? "brief" : "sweep",
  }));
});
