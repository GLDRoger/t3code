// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous retry-key hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import { KinChatError, KinWakeupId } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { withAgentsAs } from "../../github/appRepos.ts";
import { ghApiLayer } from "../../github/GitHubWatch.ts";
import { agentsView, gitHubApp } from "../../github/KinGitHubApp.ts";
import { isMemoryRepo, repoList, setRepo } from "../../github/githubWatchStore.ts";
import { linkGithubItem } from "../../github/githubLink.ts";
import { askReview, postReview } from "../../github/reviewAsk.ts";
import { SHARED_REFUSAL } from "../Audience.ts";
import { toolAdmitted } from "../SharedTools.ts";
import { reviewOnce } from "../outsideReview.ts";
import { laneFor } from "../../reply/replyLane.ts";
import { KinChatService } from "../../chat/KinChatService.ts";
import { KinServer } from "../../KinServer.ts";
import * as Questions from "../../questions/openQuestions.ts";
import { askPerson } from "../../questions/askPerson.ts";
import * as CardActions from "../../widgets/cardActions.ts";
import * as CardPlans from "../../widgets/cardPlans.ts";
import * as ChoiceCard from "../../widgets/choiceCard.ts";
import { KinHandoff } from "../Handoff.ts";
import { KinEventQueue } from "../KinEventQueue.ts";
import { KinTeam } from "../../team/KinTeam.ts";
import { KinLevelGate } from "../LevelGate.ts";
import { LeadMemory, resolveLead } from "../LeadMemory.ts";
import { readPeople } from "../peopleRead.ts";
import { updatePeople } from "../peopleUpdate.ts";
import { setAway } from "../awaySet.ts";
import { updateAgent } from "../agentUpdate.ts";
import { wordOf } from "../../pulse/holds.ts";
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

/** What a figure call did and what the person sees, so the reply needs nothing in its place. */
const shownLine = (what: "chart" | "page", inReply: boolean) =>
  inReply
    ? `Made. The ${what} shows under your reply; to show it elsewhere in the reply, copy its figure line there exactly, on a line of its own.`
    : `Posted. The ${what} is in the chat now, as its own message.`;

// Kin's service checks the persisted lead and wake-up, rather than T3 thread-control grants.
export const handlers = McpToolAccess.toLayer(KinLeadToolkit, {
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
  away_set: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.awaySet")(function* (input) {
      const lead = yield* resolveLead(yield* McpInvocationContext);
      yield* admitted(lead, "away_set", input);
      return yield* setAway(lead, input);
    }, Effect.mapError(failure)),
  ),
  agent_update: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.agentUpdate")(function* (input) {
      const lead = yield* resolveLead(yield* McpInvocationContext);
      yield* admitted(lead, "agent_update", input);
      return yield* updateAgent(lead, input);
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
  kin_ask_person: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.askPerson")(function* (input) {
      const lead = yield* resolveLead(yield* McpInvocationContext);
      return yield* askPerson({ ...lead, wakeupId: KinWakeupId.make(lead.wakeupId) }, input, {
        chat: yield* KinChatService,
        gate: yield* KinLevelGate,
      });
    }, Effect.mapError(failure)),
  ),
  kin_ask: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.ask")(function* (input) {
      if (input.options.length < 2)
        return yield* new KinChatError({
          reason: "invalid_state",
          message: ChoiceCard.FEWER_THAN_TWO,
        });
      const lead = yield* resolveLead(yield* McpInvocationContext);
      const wakeupId = KinWakeupId.make(lead.wakeupId);
      const lane = yield* laneFor({ orgId: lead.orgId, agentId: lead.agentId, wakeupId });
      if (Option.isNone(lane))
        return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
      // An identical call in the same wake-up is a retry and returns the same card.
      const key = NodeCrypto.createHash("sha256").update(stableStringify(input)).digest("hex");
      const { default: chosen, by, about, intent, ...card } = input;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* Clock.currentTimeMillis;
      const chatId = lane.value.chatId;
      // Each action is checked as this turn could do it; its button and line are the server's own.
      const drawAll = Effect.forEach(card.options, (option) =>
        option.action === undefined
          ? Effect.undefined
          : CardActions.draw(lead, chatId, option.action),
      );
      const drawn = yield* drawAll;
      const asked = { ...card, actions: drawn };
      const options = ChoiceCard.choiceCardState(asked).options;
      const plans = options.flatMap((option, index) => {
        const one = drawn[index];
        return one === undefined ? [] : [{ optionId: option.optionId, plan: one.plan }];
      });
      // The default may name an option by the agent's words or by the server's button; "none"
      // is read first, so no option's label can take it.
      const wanted = ChoiceCard.readAs(chosen);
      const none = wanted === "none";
      const names = (label: string) => ChoiceCard.readAs(label) === wanted;
      const named = none
        ? []
        : card.options.flatMap((option, index) =>
            names(option.label) || names(options[index]!.label) ? [index] : [],
          );
      if (plans.length > 0) {
        const labels = options.map((option) => ChoiceCard.readAs(option.label));
        const twice = options.find((_, index) => labels.indexOf(labels[index]!) !== index);
        if (twice !== undefined)
          return yield* new KinChatError({
            reason: "invalid_state",
            message: `Two options would read “${twice.label}”. Kin labels an option with an action by what it does; give the others their own words.`,
          });
        if (named.length > 1)
          return yield* new KinChatError({
            reason: "invalid_state",
            message: `default “${chosen}” names more than one option. Give each option its own label.`,
          });
      }
      const at = named[0];
      const defaultPlan = at === undefined ? undefined : drawn[at]?.plan;
      // A refused repeat posts nothing; an allowed one is stored in its card's own transaction.
      const plan = yield* Questions.planAsk({
        orgId: lead.orgId,
        agentId: lead.agentId,
        chatId,
        key: `${wakeupId}:${key}`,
        question: card.question,
        labels: options.map((option) => option.label),
        default: none ? "none" : at === undefined ? chosen : options[at]!.label,
        by,
        about,
        intent,
        now,
        acts: defaultPlan,
        held:
          defaultPlan === undefined
            ? undefined
            : yield* CardActions.untakenAtDay(lead.orgId, defaultPlan),
        ownerLevelAsked:
          (yield* wordOf({ orgId: lead.orgId, agentId: lead.agentId, wakeupId }))?.ownerLevel ===
          true,
      });
      // Drawn again inside the card's transaction: what was checked is what is stored.
      const recheck = drawAll.pipe(
        Effect.flatMap((again) =>
          again.every(
            (one, index) => JSON.stringify(one?.plan) === JSON.stringify(drawn[index]?.plan),
          )
            ? Effect.void
            : Effect.fail(
                new KinChatError({
                  reason: "invalid_state",
                  message: "What an option names changed while its card was made. Ask again.",
                }),
              ),
        ),
        Effect.mapError(failure),
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      const result = yield* (yield* KinLevelGate).ask(
        { ...lead, wakeupId },
        {
          ...asked,
          ...(plan === undefined ? {} : { untilAnswered: true as const }),
          ...(plans.length === 0 ? {} : { recheck }),
          chatId,
          clientMessageId: `kin-ask:${wakeupId}:${key.slice(0, 32)}`,
        },
        plan === undefined && plans.length === 0
          ? undefined
          : (widget) =>
              Effect.gen(function* () {
                if (plan !== undefined)
                  yield* Questions.recordAsk(plan, { widgetId: widget.widgetId, options });
                yield* CardPlans.sealPlans({
                  orgId: lead.orgId,
                  chatId,
                  widgetId: widget.widgetId,
                  plans,
                  now,
                });
              }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      );
      return plan === undefined
        ? {
            widgetId: result.widgetId,
            messageId: result.messageId,
            untaken: "group" as const,
            note: ChoiceCard.NOTHING_TIMED,
          }
        : {
            widgetId: result.widgetId,
            messageId: result.messageId,
            question: plan.questionId,
            by: DateTime.formatIso(DateTime.makeUnsafe(plan.dueAt)),
            ...(plan.untaken === undefined ? {} : { untaken: plan.untaken }),
            ...(plan.note === undefined ? {} : { note: plan.note }),
          };
    }, Effect.mapError(failure)),
  ),
  kin_ask_close: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.askClose")(function* (input) {
      const lead = yield* resolveLead(yield* McpInvocationContext);
      const wakeupId = KinWakeupId.make(lead.wakeupId);
      const lane = yield* laneFor({ orgId: lead.orgId, agentId: lead.agentId, wakeupId });
      const row = yield* Questions.readQuestion(lead.orgId, input.question);
      const asked =
        row === undefined || Option.isNone(lane)
          ? undefined
          : yield* Questions.personOfChat(lead.orgId, lane.value.chatId);
      // Its asker, or a turn in a chat with its person, finds it; only its asker closes it.
      if (row === undefined || (row.agentId !== lead.agentId && asked !== row.personId))
        return yield* new KinChatError({
          reason: "not_found",
          message: "No such open question. Your seat lists the open ones.",
        });
      const services = Option.getOrThrow((yield* KinServer).services);
      const closed = yield* (yield* SqlClient.SqlClient).withTransaction(
        Questions.closeQuestion(
          {
            orgId: lead.orgId,
            agentId: lead.agentId,
            wakeupId,
            questionId: row.questionId,
            outcome: input.outcome,
            answer: input.answer,
            now: yield* Clock.currentTimeMillis,
          },
          Context.get(services, KinChatService),
          Context.get(services, KinEventQueue),
        ),
      );
      return { question: closed.questionId, state: closed.state };
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
      return "figure" in result
        ? { ...result, next: shownLine("chart", true) }
        : {
            widgetId: result.widgetId,
            messageId: result.messageId,
            next: shownLine("chart", false),
          };
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
      return "figure" in result
        ? { ...result, next: shownLine("page", true) }
        : {
            widgetId: result.widgetId,
            messageId: result.messageId,
            next: shownLine("page", false),
          };
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
  kin_github_review: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.githubReview")(function* (input) {
      const lead = yield* resolveLead(yield* McpInvocationContext);
      yield* admitted(lead, "kin_github_review", input);
      const asOwner = yield* reviewOnce(
        lead,
        postReview(lead, input).pipe(Effect.provide(ghApiLayer)),
      );
      if (asOwner !== undefined) return asOwner;
      return yield* new KinChatError({
        reason: "unavailable",
        message: "GitHub isn't connected. The owner connects it in Settings, Connections.",
      });
    }, Effect.mapError(failure)),
  ),
  kin_github_review_ask: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.githubReviewAsk")(function* (input) {
      const services = Option.getOrThrow((yield* KinServer).services);
      return yield* askReview(yield* McpInvocationContext, input).pipe(
        Effect.provide(ghApiLayer),
        Effect.provideService(KinEventQueue, Context.get(services, KinEventQueue)),
      );
    }, Effect.mapError(failure)),
  ),
  kin_github_watch: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.githubWatch")(
      function* (input) {
        const lead = yield* resolveLead(yield* McpInvocationContext);
        yield* admitted(lead, "kin_github_watch", input);
        const app = yield* gitHubApp;
        const state = Option.isSome(app) ? yield* app.value.state() : ({ _tag: "none" } as const);
        const repos = withAgentsAs(yield* repoList(lead.orgId), state);
        if (input.repo === undefined) {
          const accounts = (yield* agentsView(app, lead.orgId)).accounts;
          return {
            repos: repos.slice(0, 100),
            ...(accounts === undefined ? {} : { appAccounts: accounts }),
          };
        }
        const named = input.repo.toLowerCase();
        if (yield* isMemoryRepo(named))
          return yield* new KinChatError({
            reason: "not_allowed",
            message:
              "That is Kin's memory repo. Kin never watches it: its own memory PRs would wake an agent for every memory write.",
          });
        if (!repos.some((repo) => repo.repo.toLowerCase() === named))
          return yield* new KinChatError({
            reason: "not_found",
            message:
              "Kin doesn't watch that repo: it isn't the owner's or his organisations', or GitHub isn't connected.",
          });
        const changed =
          input.watch === undefined && input.mentions === undefined
            ? repos
            : yield* setRepo(
                {
                  orgId: lead.orgId,
                  repo: named,
                  ...(input.watch === undefined ? {} : { watched: input.watch }),
                  ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
                },
                yield* Clock.currentTimeMillis,
              );
        return { repos: changed.filter((repo) => repo.repo.toLowerCase() === named) };
      },
      Effect.catchTags({ SqlError: () => Effect.fail(failure(undefined)) }),
      Effect.mapError(failure),
    ),
  ),
  kin_github_link: McpToolAccess.actsAsCaller(
    Effect.fn("KinLeadToolkit.githubLink")(function* (input) {
      const lead = yield* resolveLead(yield* McpInvocationContext);
      yield* admitted(lead, "kin_github_link", input);
      return yield* linkGithubItem(lead, input);
    }, Effect.mapError(failure)),
  ),
});
