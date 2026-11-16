// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous retry-key hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import { KinChatError, KinWakeupId } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { KinRepoReads } from "../../github/KinRepoReads.ts";
import { ghApiLayer, ownerGitHubReview } from "../../github/GitHubWatch.ts";
import { KinPullRequestCare } from "../../github/PullRequestCare.ts";
import { SHARED_REFUSAL } from "../Audience.ts";
import { toolAdmitted } from "../SharedTools.ts";
import { laneFor } from "../../reply/KinReplyBridge.ts";
import { KinHandoff } from "../Handoff.ts";
import { KinTeam } from "../../team/KinTeam.ts";
import { KinLevelGate } from "../LevelGate.ts";
import { quote } from "../LeadPrompt.ts";
import { LeadMemory, resolveLead } from "../LeadMemory.ts";
import { KinWorkers } from "../Workers.ts";
import { readPeople } from "../peopleRead.ts";
import { updatePeople } from "../peopleUpdate.ts";
import { KinLeadToolkit } from "./tools.ts";

const isKinChatError = Schema.is(KinChatError);
const failure = (error: unknown) =>
  isKinChatError(error)
    ? error
    : new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });

const admitted = (
  lead: Effect.Success<ReturnType<typeof resolveLead>>,
  name: string,
  args: unknown,
) =>
  toolAdmitted(lead, name, args).pipe(
    Effect.flatMap((ok) =>
      ok
        ? Effect.void
        : Effect.fail(new KinChatError({ reason: "not_allowed", message: SHARED_REFUSAL })),
    ),
  );

const githubQuote = (value: unknown) => ({ quoted: quote("GitHub data (untrusted)", value, true) });

// Kin's service checks the persisted lead and wake-up, rather than T3 thread-control grants.
export const handlers = McpToolAccess.toLayer(KinLeadToolkit, {
  kin_delegate: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.delegate")(function* (input) {
      return yield* (yield* KinWorkers).delegate(yield* McpInvocationContext, input);
    }),
  ),
  kin_follow_up: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.followUp")(function* (input) {
      return yield* (yield* KinWorkers).followUp(yield* McpInvocationContext, input);
    }),
  ),
  kin_worker_stop: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.workerStop")(function* (input) {
      return yield* (yield* KinWorkers).stop(yield* McpInvocationContext, input);
    }),
  ),
  kin_leads: McpToolAccess.reads(
    Effect.fn("KinLeadToolkit.leads")(function* () {
      return yield* (yield* KinHandoff).leads(yield* McpInvocationContext);
    }),
  ),
  people_read: McpToolAccess.reads(
    Effect.fn("KinLeadToolkit.peopleRead")(function* () {
      return yield* readPeople(yield* resolveLead(yield* McpInvocationContext));
    }, Effect.mapError(failure)),
  ),
  people_update: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.peopleUpdate")(function* (input) {
      const lead = yield* resolveLead(yield* McpInvocationContext);
      yield* admitted(lead, "people_update", input);
      return yield* updatePeople(lead, input);
    }, Effect.mapError(failure)),
  ),
  kin_hand_off: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.handOff")(function* (input) {
      return yield* (yield* KinHandoff).handOff(yield* McpInvocationContext, input);
    }),
  ),
  kin_take_private: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.takePrivate")(function* (input) {
      return yield* (yield* KinHandoff).takePrivate(yield* McpInvocationContext, input);
    }),
  ),
  kin_relay: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.relay")(function* (input) {
      const { postTo } = yield* KinLevelGate;
      return yield* (yield* KinHandoff).relay(yield* McpInvocationContext, input, postTo);
    }),
  ),
  team_open: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.teamOpen")(function* (input) {
      return yield* (yield* KinTeam).open(yield* McpInvocationContext, input);
    }),
  ),
  team_say: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.teamSay")(function* (input) {
      return yield* (yield* KinTeam).say(yield* McpInvocationContext, input);
    }),
  ),
  kin_ask: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.ask")(function* (input) {
      const lead = yield* resolveLead(yield* McpInvocationContext);
      const wakeupId = KinWakeupId.make(lead.wakeupId);
      const lane = yield* laneFor({ orgId: lead.orgId, agentId: lead.agentId, wakeupId });
      if (Option.isNone(lane))
        return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
      // An identical call in the same wake-up is a retry and returns the same card.
      const key = NodeCrypto.createHash("sha256").update(stableStringify(input)).digest("hex");
      const result = yield* (yield* KinLevelGate).ask(
        { ...lead, wakeupId },
        {
          ...input,
          chatId: lane.value.chatId,
          clientMessageId: `kin-ask:${wakeupId}:${key.slice(0, 32)}`,
        },
      );
      return { widgetId: result.widgetId, messageId: result.messageId };
    }, Effect.mapError(failure)),
  ),
  kin_chart: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.chart")(function* (input) {
      const lead = yield* resolveLead(yield* McpInvocationContext);
      const wakeupId = KinWakeupId.make(lead.wakeupId);
      const lane = yield* laneFor({ orgId: lead.orgId, agentId: lead.agentId, wakeupId });
      if (Option.isNone(lane))
        return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
      // An identical call in the same wake-up is a retry and returns the same card.
      const key = NodeCrypto.createHash("sha256").update(stableStringify(input)).digest("hex");
      const result = yield* (yield* KinLevelGate).chart(
        { ...lead, wakeupId },
        {
          ...input,
          chatId: lane.value.chatId,
          clientMessageId: `kin-chart:${wakeupId}:${key.slice(0, 32)}`,
          intent: lane.value.mode === "reply" ? "answer" : "evidence",
        },
      );
      return { widgetId: result.widgetId, messageId: result.messageId };
    }, Effect.mapError(failure)),
  ),
  kin_visual: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.visual")(function* (input) {
      const lead = yield* resolveLead(yield* McpInvocationContext);
      const wakeupId = KinWakeupId.make(lead.wakeupId);
      const lane = yield* laneFor({ orgId: lead.orgId, agentId: lead.agentId, wakeupId });
      if (Option.isNone(lane))
        return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
      // An identical call in the same wake-up is a retry and returns the same card.
      const key = NodeCrypto.createHash("sha256").update(stableStringify(input)).digest("hex");
      const result = yield* (yield* KinLevelGate).visual(
        { ...lead, wakeupId },
        {
          ...input,
          chatId: lane.value.chatId,
          clientMessageId: `kin-visual:${wakeupId}:${key.slice(0, 32)}`,
          intent: lane.value.mode === "reply" ? "answer" : "evidence",
        },
      );
      return { widgetId: result.widgetId, messageId: result.messageId };
    }, Effect.mapError(failure)),
  ),
  kin_react: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.react")(function* (input) {
      const lead = yield* resolveLead(yield* McpInvocationContext);
      const wakeupId = KinWakeupId.make(lead.wakeupId);
      const lane = yield* laneFor({ orgId: lead.orgId, agentId: lead.agentId, wakeupId });
      if (Option.isNone(lane))
        return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
      return yield* (yield* KinLevelGate).react(
        { ...lead, wakeupId },
        { ...input, chatId: lane.value.chatId },
      );
    }, Effect.mapError(failure)),
  ),
  memory_search: McpToolAccess.reads(
    Effect.fn("KinLeadToolkit.search")(function* (input) {
      return yield* (yield* LeadMemory).search(yield* McpInvocationContext, input);
    }),
  ),
  memory_read: McpToolAccess.reads(
    Effect.fn("KinLeadToolkit.read")(function* (input) {
      return yield* (yield* LeadMemory).read(yield* McpInvocationContext, input);
    }),
  ),
  memory_write: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.write")(function* (input) {
      return yield* (yield* LeadMemory).write(yield* McpInvocationContext, input);
    }),
  ),
  memory_label: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.label")(function* (input) {
      return yield* (yield* LeadMemory).label(yield* McpInvocationContext, input);
    }),
  ),
  kin_defer: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.defer")(function* (input) {
      return yield* (yield* LeadMemory).defer(yield* McpInvocationContext, input);
    }),
  ),
  kin_schedule: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.schedule")(function* (input) {
      return yield* (yield* LeadMemory).schedule(yield* McpInvocationContext, input);
    }),
  ),
  kin_cancel: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.cancel")(function* (input) {
      return yield* (yield* LeadMemory).cancel(yield* McpInvocationContext, input);
    }),
  ),
  kin_journal: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.journal")(function* (input) {
      return yield* (yield* LeadMemory).journal(yield* McpInvocationContext, input);
    }),
  ),
  kin_github_repos: McpToolAccess.reads(
    Effect.fn("KinLeadToolkit.githubRepos")(function* () {
      const lead = yield* resolveLead(yield* McpInvocationContext);
      return yield* (yield* KinRepoReads).repos(lead);
    }, Effect.mapError(failure)),
  ),
  kin_github_prs: McpToolAccess.reads(
    Effect.fn("KinLeadToolkit.githubPrs")(function* (input) {
      const lead = yield* resolveLead(yield* McpInvocationContext);
      return githubQuote(yield* (yield* KinRepoReads).pulls(lead, input));
    }, Effect.mapError(failure)),
  ),
  kin_github_pr: McpToolAccess.reads(
    Effect.fn("KinLeadToolkit.githubPr")(function* (input) {
      const lead = yield* resolveLead(yield* McpInvocationContext);
      return githubQuote(yield* (yield* KinRepoReads).pull(lead, input));
    }, Effect.mapError(failure)),
  ),
  kin_github_runs: McpToolAccess.reads(
    Effect.fn("KinLeadToolkit.githubRuns")(function* (input) {
      const lead = yield* resolveLead(yield* McpInvocationContext);
      return githubQuote(yield* (yield* KinRepoReads).runs(lead, input));
    }, Effect.mapError(failure)),
  ),
  kin_github_review: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.githubReview")(function* (input) {
      const lead = yield* resolveLead(yield* McpInvocationContext);
      yield* admitted(lead, "kin_github_review", input);
      const asOwner = yield* ownerGitHubReview(lead, input).pipe(Effect.provide(ghApiLayer));
      if (asOwner !== undefined) return asOwner;
      return yield* (yield* KinPullRequestCare).review(lead, input);
    }, Effect.mapError(failure)),
  ),
  kin_github_link: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.githubLink")(function* (input) {
      const lead = yield* resolveLead(yield* McpInvocationContext);
      yield* admitted(lead, "kin_github_link", input);
      return yield* (yield* KinPullRequestCare).link(lead, input);
    }, Effect.mapError(failure)),
  ),
});
