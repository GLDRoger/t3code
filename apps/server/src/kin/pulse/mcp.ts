import {
  KIN_TEXT_LOCALE,
  KinChatError,
  KinDay,
  KinPulseFact,
  KinPulseFamily,
  KinPulseAside,
  KinPulseHandleAction,
  KinPulseRead,
  KinRecordKey,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinServer } from "../KinServer.ts";
import { agentServices } from "../mcp/KinChatToolkit.ts";
import { isHeld } from "../lead/LevelGate.ts";
import { theirTime } from "../triggers/quietHold.ts";
import { SHARED_REFUSAL, effectiveAudience, turnPeople } from "../lead/Audience.ts";
import { type Lead, leadTool } from "../work/leadWork.ts";
import { ownerZone, startOfDay } from "../work/recordRows.ts";
import { dayIn } from "../work/money.ts";
import { asideLine, holdNames, subjectText, wordOf } from "./holds.ts";
import * as KinPulse from "./KinPulse.ts";
import { nudge } from "./nudge.ts";

export const PulseReadInput = Schema.Struct({
  project: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))).annotate({
    description: "Only facts on this project: its key (P-2) or exact name.",
  }),
  client: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))).annotate({
    description: "Only facts on this client: its key (C-3) or exact name.",
  }),
  family: Schema.optional(KinPulseFamily).annotate({
    description:
      "work (tasks), money (invoices, quotes, renewals, budgets) or system (stuck tasks, held work).",
  }),
  includeHandled: Schema.optional(Schema.Boolean).annotate({
    description: "Also show facts someone already has in hand. Default false.",
  }),
});
export const PulseHandleInput = Schema.Struct({
  factKey: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(300))).annotate({
    description: "The fact's key, exactly as pulse_read or the Pulse section gave it.",
  }),
  record: Schema.optional(KinRecordKey).annotate({
    description:
      "Instead of factKey: a record's key (C-7, P-2, INV-9) to set aside or lift, also when nothing about it is open yet.",
  }),
  action: Schema.optional(KinPulseHandleAction).annotate({
    description:
      "got_it (default): you or someone has it in hand; it comes back after until, or 3 days. not_a_problem: drop it until what it is about changes. set_aside: a person said to leave it; its record is set aside until the day in until, or until someone lifts it. undo: take any of these back.",
  }),
  until: Schema.optional(
    Schema.Union([
      KinDay,
      Schema.String.check(
        Schema.isPattern(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/,
        ),
      ),
    ]),
  ).annotate({
    description:
      "For got_it: hide it until this day (owner's time zone) or time with offset. For set_aside: the day the person named; leave it out for until they say.",
  }),
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(500))).annotate({
    description: "One line on what is being done, for whoever reads it next.",
  }),
});

export const PulseReadResult = Schema.Struct({
  ...KinPulseRead.fields,
  held: Schema.optional(Schema.Array(Schema.String)),
});
export const PulseAsideResult = Schema.Struct({
  setAside: Schema.NullOr(KinPulseAside),
  said: Schema.String,
});

export const PulseNudgeInput = Schema.Struct({
  person: TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
    description: "The teammate, by name as people_read gives it.",
  }),
  factKey: TrimmedNonEmptyString.check(Schema.isMaxLength(300)).annotate({
    description: "The fact it is about, exactly as the Pulse section or pulse_read gave it.",
  }),
  text: TrimmedNonEmptyString.check(
    Schema.isMaxLength(280),
    Schema.makeFilter((value) => !value.includes("\n"), { expected: "one line" }),
  ).annotate({
    description:
      'One line, with the concrete consequence: "W-12 was due Friday; the Lumen demo on Tuesday waits on it. Still on for Monday?"',
  }),
});
export const PulseNudgeResult = Schema.Struct({
  person: Schema.String,
  day: Schema.String,
  note: Schema.String,
});

/** The owner in their own turn; in a turn others read, the people behind it, or a refusal. */
const viewerOf = Effect.fn("KinPulseTools.viewer")(function* (lead: Lead) {
  if ((yield* effectiveAudience(lead)) === "owner_only") return { _tag: "owner" } as const;
  const behind = yield* turnPeople(lead);
  if (behind === undefined || behind.people.length === 0)
    return yield* new KinChatError({ reason: "not_allowed", message: SHARED_REFUSAL });
  return { _tag: "people", people: behind.people } as const;
});

const runRead = Effect.fnUntraced(function* (lead: Lead, input: typeof PulseReadInput.Type) {
  const { setAside, ...read } = yield* KinPulse.read({
    orgId: lead.orgId,
    at: yield* Clock.currentTimeMillis,
    viewer: yield* viewerOf(lead),
    scope: { project: input.project, client: input.client, family: input.family },
    includeHandled: input.includeHandled,
    withAside: true,
  });
  if (setAside === undefined || setAside.length === 0) return read;
  const names = yield* holdNames(lead.orgId);
  const zone = yield* ownerZone(lead.orgId);
  return { ...read, held: setAside.map((aside) => asideLine(aside, names, zone)) };
});

/** An agent sets or lifts a hold only on a person's own word in this turn, never on its own. */
const NOT_ON_WORD =
  "Only a person can set something aside or lift it: in their own message to you, or from Needs attention. This turn was not woken by a person's own message, so nothing changed.";

/** The company's hold on an owner-level person's word; a teammate's own on theirs. */
const holdingOf = Effect.fn("KinPulseTools.holding")(function* (lead: Lead) {
  const word = yield* wordOf({
    orgId: lead.orgId,
    agentId: lead.agentId,
    wakeupId: lead.wakeupId,
  });
  return word === null
    ? ({ _tag: "refused", message: NOT_ON_WORD } satisfies KinPulse.Holding)
    : ({
        _tag: "may",
        forPersonId: word.ownerLevel ? null : word.personId,
        onWordOf: word.personId,
      } satisfies KinPulse.Holding);
});

/** What the server now guarantees about a hold, in the words the agent may pass on. */
const saidOf = (aside: KinPulseAside | null, recordKey: string, zone: string) => {
  if (aside === null)
    return `${recordKey} is not set aside now: what is open about it comes back once at the next check-in.`;
  const day = aside.until === null ? null : dayIn(DateTime.toEpochMillis(aside.until), zone);
  return `Set aside: ${subjectText(aside)}, ${day === null ? "until someone lifts it" : `until ${day}`}${aside.mine ? ", for that person only" : ""}. Before then Kin tells nothing about it and no question card can be raised about it; ${day === null ? "once lifted" : `on ${day}`} it comes back once at the check-in.`;
};

const runHandle = Effect.fnUntraced(function* (lead: Lead, input: typeof PulseHandleInput.Type) {
  const at = yield* Clock.currentTimeMillis;
  const until =
    input.until === undefined
      ? undefined
      : input.until.length === 10
        ? startOfDay(input.until, yield* ownerZone(lead.orgId))
        : Option.match(DateTime.make(input.until), {
            onNone: () => undefined,
            onSome: DateTime.toEpochMillis,
          });
  const viewer = yield* viewerOf(lead);
  const by = { _tag: "agent" as const, agentId: lead.agentId };
  const action = input.action ?? "got_it";
  const holding = yield* holdingOf(lead);
  const zone = yield* ownerZone(lead.orgId);
  if (input.factKey === undefined) {
    if (input.record === undefined || action === "not_a_problem")
      return yield* new KinChatError({
        reason: "invalid_state",
        message: "Give factKey, or record with set_aside (or got_it) or undo.",
      });
    const aside = yield* KinPulse.aside({
      orgId: lead.orgId,
      at,
      viewer,
      by,
      recordKey: input.record,
      action: action === "undo" ? "lift" : "set",
      until: until ?? null,
      note: input.note ?? null,
      holding,
    });
    return { setAside: aside, said: saidOf(aside, input.record, zone) };
  }
  // A day on a person's word sets the fact's record aside: the whole promise, not three days.
  const aside =
    action === "set_aside" ||
    (action === "got_it" && until !== undefined && holding._tag === "may");
  const fact = yield* KinPulse.handle({
    orgId: lead.orgId,
    at,
    viewer,
    by,
    factKey: input.factKey,
    action: aside ? "set_aside" : action,
    until,
    note: input.note,
    holding,
    ...(action === "got_it" ? { orPlain: true } : {}),
  });
  if (fact.aside !== undefined && (aside || action === "undo"))
    return { setAside: fact.aside, said: saidOf(fact.aside, fact.aside.record.key, zone) };
  if (action === "undo" && fact.subject.kind === "record")
    return { setAside: null, said: saidOf(null, fact.subject.key, zone) };
  return fact;
});

const runNudge = Effect.fnUntraced(function* (lead: Lead, input: typeof PulseNudgeInput.Type) {
  if ((yield* viewerOf(lead))._tag !== "owner")
    return yield* new KinChatError({ reason: "not_allowed", message: SHARED_REFUSAL });
  const kin = yield* KinServer;
  if (Option.isNone(kin.services))
    return yield* new KinChatError({ reason: "disabled", message: "Kin is not running here." });
  const chat = Context.get(kin.services.value, KinChatService);
  const { agent, postTo } = yield* agentServices;
  const sent = yield* nudge({
    orgId: lead.orgId,
    agentId: lead.agentId,
    at: yield* Clock.currentTimeMillis,
    person: input.person,
    factKey: input.factKey,
    text: input.text,
    chatFor: (personId) =>
      chat
        .createDirect(
          { _tag: "person", orgId: lead.orgId, personId },
          {
            orgId: lead.orgId,
            agentId: lead.agentId,
          },
        )
        .pipe(
          Effect.map((direct) => direct.chatId),
          Effect.mapError(
            () =>
              new KinChatError({
                reason: "not_allowed",
                message: `${input.person} can't message you, so you can't nudge them. Ask the owner, or the team agent.`,
              }),
          ),
        ),
    post: (chatId, clientMessageId, personId, notBefore) =>
      postTo(agent, personId, {
        chatId,
        body: input.text,
        intent: "question",
        clientMessageId,
        notBefore,
      }).pipe(
        Effect.map((posted) => (isHeld(posted) ? posted : undefined)),
        Effect.mapError(failure),
      ),
  });
  return {
    person: sent.person,
    day: sent.day,
    note: `${sent.held === undefined ? "Sent" : `Held until they start: Kin delivers it at ${theirTime(sent.held.at, sent.held.zone, KIN_TEXT_LOCALE)},`} in ${sent.person}'s chat with you. Their answer arrives there; if none comes, replan or tell the owner rather than nudging again.`,
  };
});

const read = leadTool("KinPulseTools.read", runRead);
const nudgeTool = leadTool("KinPulseTools.nudge", runNudge);
const handle = leadTool("KinPulseTools.handle", runHandle);

// tools/list runs this before handler services are provided; the Kin MCP endpoint provides `KinIdentity`.
const enabled = McpToolAccess.threadBoundGate(() => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  const scope = Context.getOrUndefined(fiber.context, McpInvocationContext);
  const identity = Context.getOrUndefined(fiber.context, KinIdentity);
  return (
    scope?.thread !== undefined &&
    scope.thread.subagent !== true &&
    identity?.isLeadThread(scope.thread.threadId) === true
  );
});
const shared = {
  failure: Schema.Union([KinChatError, OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext,
    ThreadManagementService,
    KinIdentity,
    KinServer,
    SqlClient.SqlClient,
  ],
};

export const KinPulseToolkit = Toolkit.make(
  Tool.make("pulse_read", {
    ...shared,
    description:
      "What needs attention now, computed from Kin's records: late or stalled tasks, overdue invoices, unanswered quotes, renewals, budgets, stuck tasks; each fact with a key, its consequence and who should act. Use it, not memory, for what is late, overdue or due today. Read-only.",
    parameters: PulseReadInput,
    success: PulseReadResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("pulse_handle", {
    ...shared,
    description:
      'Once you have acted on a pulse fact or decided it needs nothing: mark it got_it (optionally until a date) or not a problem so it stops coming back; undo takes that back. When a person, in their own message or tap this turn, says to leave something until a day or until they say ("leave INV-9 for a month", "they\'ll pay in two weeks, don\'t remind me"), set_aside its fact or its record, with until for a day and without for until lifted. Do it yourself in that turn, for any record you can read, also one another agent looks after: never hand it off, as a hand-off can\'t carry their word. If it is refused, tell them plainly it is not set aside and that they can set it aside from Needs attention. A client or project covers everything under it. That is the whole promise: Kin tells nothing and raises no question about it before then, so make no deferral or reminder for the same day, and tell them only what the result says. undo on their word lifts it. In any other turn it is refused.',
    parameters: PulseHandleInput,
    success: Schema.Union([KinPulseFact, PulseAsideResult]),
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("pulse_nudge", {
    ...shared,
    description:
      "Nudge a teammate about one of their open Work facts: Kin posts your one line in their chat with you. Only with a concrete consequence (a date missed, someone blocked, a client waiting). Refused while your last nudge to them is unanswered: then replan, take it over or tell the owner.",
    parameters: PulseNudgeInput,
    success: PulseNudgeResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
);

const isKinChatError = Schema.is(KinChatError);
const failure = (error: unknown) =>
  isKinChatError(error)
    ? error
    : new KinChatError({ reason: "unavailable", message: "The pulse is unavailable right now." });

export const handlers = McpToolAccess.toLayer(KinPulseToolkit, {
  pulse_read: McpToolAccess.reads(
    Effect.fn("KinPulseToolkit.read")(function* (input) {
      return yield* read(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  pulse_handle: McpToolAccess.actsAsCaller(
    Effect.fn("KinPulseToolkit.handle")(function* (input) {
      return yield* handle(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
  pulse_nudge: McpToolAccess.actsAsCaller(
    Effect.fn("KinPulseToolkit.nudge")(function* (input) {
      return yield* nudgeTool(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
});
