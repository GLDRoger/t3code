import { useAtomValue } from "@effect/atom-react";
import type {
  KinDay,
  KinGoalSaveInput,
  KinGoalsResult,
  KinPulseHandleAction,
  KinPulseScreenRead,
  KinRecordKey,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { squashAtomCommandFailure } from "../../state/runtime.ts";
import { kinAccessMeAtom, kinOwnerLevelAtom } from "../kinAccess.ts";
import { kinFailureText } from "../kinAnswers.ts";
import {
  kinAttentionProblem,
  kinAttentionShown,
  type KinAttentionScope,
  KIN_GOALS,
} from "../kinAttention.ts";
import { kinAskAboutAgent, type KinScreenTarget } from "../kinScreenReads.ts";
import { kinNeedsYouCount, kinTasksDealFactsOf } from "../kinTasksList.ts";
import { kinWorkReadState } from "../kinWorkForms.ts";
import {
  type KinHookApp,
  type KinUseMoneyLive,
  type KinUseOpenChat,
  useRereadOnChange,
} from "./kinHookApp.ts";

/** The app's own hooks these read through, so each app keeps its navigation and access rules. */
export interface KinAttentionUses {
  readonly useKinOpenChat: KinUseOpenChat;
  readonly useKinMoneyLive: KinUseMoneyLive;
  readonly kinWorkLiveAtom: (
    target: KinScreenTarget,
  ) => Atom.Atom<AsyncResult.AsyncResult<{ readonly seq: number }, unknown>>;
}

const noAttentionAtom: Atom.Atom<AsyncResult.AsyncResult<KinPulseScreenRead, unknown>> = Atom.make(
  AsyncResult.initial(),
);
const noLiveAtom: Atom.Atom<AsyncResult.AsyncResult<{ readonly seq: number }, unknown>> = Atom.make(
  AsyncResult.initial(),
);
const noGoalsAtom: Atom.Atom<AsyncResult.AsyncResult<KinGoalsResult, unknown>> = Atom.make(
  AsyncResult.initial(),
);
const noCountsAtom: Atom.Atom<
  AsyncResult.AsyncResult<{ readonly needsYou: number } | null, unknown>
> = Atom.make(AsyncResult.initial());

/** Needs you, its taps, Ask about and the company's goals, on one app's client. */
export function makeKinAttentionHooks<R, ER>(app: KinHookApp<R, ER>, uses: KinAttentionUses) {
  const { kinClient, kinReads, registry, runtime, useAtomCommand } = app;
  const attentionAtom = kinReads.attention;
  const streamedAtom = kinReads.attentionStreamed;

  /**
   * What needs attention, live; null until read. A host that streams it sends what moved. On an
   * older one it is read again when the pulse topic moves, which covers all an owner-level viewer
   * is shown; a member's view also turns on what is shared with them, so theirs follows Work's.
   */
  function useKinAttention(
    target: KinScreenTarget,
    enabled = true,
    paged = false,
    scope?: KinAttentionScope,
  ) {
    const streamed = useAtomValue(streamedAtom(target));
    const atom =
      enabled && streamed !== null
        ? attentionAtom(target, streamed, paged, scope)
        : noAttentionAtom;
    const state = kinWorkReadState(useAtomValue(atom));
    const ownerLevel = useAtomValue(kinOwnerLevelAtom(runtime, target.environmentId));
    const reads =
      useAtomValue(kinClient.workRead.permissionAtom(target.environmentId)) &&
      enabled &&
      !ownerLevel &&
      streamed === false;
    const live = useAtomValue(reads ? uses.kinWorkLiveAtom(target) : noLiveAtom);
    const seq = Option.getOrNull(AsyncResult.value(live))?.seq ?? null;
    useRereadOnChange(seq, () => registry.refresh(atom));
    const answered = useAtomValue(kinReads.answered(target));
    return state._tag === "ready" ? kinAttentionShown(state.value, new Set(answered)) : null;
  }

  /**
   * The Tasks badge: the same number as Tasks' Needs you heading (`kinNeedsYouCount`): Tasks' own
   * count, which the host's Needs attention carries as it moves, and the deal facts. An older host's
   * count is read again as Work's tasks change. Null until first known.
   */
  function useKinTasksNeedsYou(target: KinScreenTarget): number | null {
    const { environmentId, orgId } = target;
    const pulse = useKinAttention(target, true);
    const ownerLevel = useAtomValue(kinOwnerLevelAtom(runtime, environmentId));
    const me = useAtomValue(kinAccessMeAtom(runtime, environmentId));
    const streamed = useAtomValue(streamedAtom(target));
    const carried = streamed === true ? (pulse?.tasksNeedsYou ?? null) : null;
    const older = streamed === false || (pulse !== null && carried === null);
    const read = useAtomValue(
      older ? kinClient.workMoveCounts({ environmentId, input: { orgId } }) : noCountsAtom,
    );
    const counts =
      carried !== null ? { needsYou: carried } : Option.getOrNull(AsyncResult.value(read));
    const dealFacts = kinTasksDealFactsOf(pulse, { ownerLevel, me: me?.personId ?? null });
    const known = kinNeedsYouCount({ counts, dealFacts: dealFacts.length });
    // Offline or reconnecting the count can't be read; the badge keeps the last one it showed.
    const key = `${environmentId}:${orgId}`;
    const [last, setLast] = useState({ key, count: known });
    if (known !== null && (known !== last.count || key !== last.key))
      setLast({ key, count: known });
    return known ?? (last.key === key ? last.count : null);
  }

  /**
   * "I've got it", Snooze and "Not a problem", Undo, and setting a record aside or lifting it,
   * with one line when a tap didn't save.
   */
  function useKinAttentionHandle(target: KinScreenTarget, scope?: KinAttentionScope) {
    const handle = useAtomCommand(kinClient.attentionHandle, { reportFailure: false });
    const aside = useAtomCommand(kinClient.attentionAside, { reportFailure: false });
    const [busy, setBusy] = useState<string | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    return {
      busy,
      problem,
      /** Sets `record` aside until `until`, else until lifted; `factKey` leaves the list at once. */
      aside: async (
        record: KinRecordKey,
        action: "set" | "lift",
        until?: KinDay,
        factKey?: string,
      ) => {
        setBusy(factKey ?? record);
        setProblem(null);
        if (factKey !== undefined) kinReads.markAnswered(target, factKey, true);
        const outcome = await aside({
          environmentId: target.environmentId,
          input: {
            orgId: target.orgId,
            record,
            action,
            ...(until === undefined ? {} : { until }),
          },
        });
        setBusy(null);
        kinReads.afterAttentionHandle(target, scope);
        const problem = kinAttentionProblem(
          AsyncResult.isSuccess(outcome) ? null : squashAtomCommandFailure(outcome),
        );
        if (problem === null) return;
        if (factKey !== undefined) kinReads.markAnswered(target, factKey, false);
        setProblem(problem);
      },
      send: async (factKey: string, action: KinPulseHandleAction, until?: KinDay) => {
        setBusy(factKey);
        setProblem(null);
        const mark = (on: boolean) => kinReads.markAnswered(target, factKey, on);
        // Answered, it leaves at once; an Undo lets the live read show it open again.
        mark(action !== "undo");
        const outcome = await handle({
          environmentId: target.environmentId,
          input: {
            orgId: target.orgId,
            factKey,
            action,
            ...(until === undefined ? {} : { until }),
          },
        });
        setBusy(null);
        kinReads.afterAttentionHandle(target, scope);
        const problem = kinAttentionProblem(
          AsyncResult.isSuccess(outcome) ? null : squashAtomCommandFailure(outcome),
        );
        if (problem === null) return;
        if (action !== "undo") mark(false);
        setProblem(problem);
      },
    };
  }

  /** Opens the chat with the agent a row names, else the front door, holding what it is about. */
  function useKinAskAbout({ environmentId, orgId }: KinScreenTarget) {
    const openChat = uses.useKinOpenChat();
    const canRestore = useAtomValue(kinClient.leadRestore.permissionAtom(environmentId));
    const result = useAtomValue(kinReads.askLeads({ environmentId, orgId }, canRestore));
    const leads = Option.getOrNull(AsyncResult.value(result))?.leads ?? [];
    return (agentId: string | null) => {
      const agent = kinAskAboutAgent(leads, agentId);
      if (agent === null) return null;
      return {
        name: agent.name,
        ask: (message: string) => openChat(environmentId, orgId, agent.ownerChatId, message),
      };
    };
  }

  /**
   * The company's goals, read again when Work changes or needs attention moves; on Money's own
   * screen (`money`), from Money's stream where the host streams it.
   */
  function useKinGoals(
    target: KinScreenTarget,
    options: { readonly enabled: boolean; readonly money?: boolean },
  ) {
    const streamed = uses.useKinMoneyLive(target, "goals");
    const live = options.money === true ? streamed : null;
    const atom = kinClient.goals({
      environmentId: target.environmentId,
      input: { orgId: target.orgId },
    });
    const read = kinReads.chosen(live, atom, options.enabled);
    const state = kinWorkReadState(useAtomValue(read.atom ?? noGoalsAtom));
    const save = useAtomCommand(kinClient.goalSave, { reportFailure: false });
    const canSave = useAtomValue(kinClient.goalSave.permissionAtom(target.environmentId));
    return {
      state,
      canSave,
      save: async (input: Omit<KinGoalSaveInput, "orgId">) => {
        const outcome = await save({
          environmentId: target.environmentId,
          input: { ...input, orgId: target.orgId },
        });
        if (live === null) registry.refresh(atom);
        return AsyncResult.isSuccess(outcome)
          ? null
          : kinFailureText(squashAtomCommandFailure(outcome), KIN_GOALS.saveFailed);
      },
    };
  }

  return {
    useKinAttention,
    useKinTasksNeedsYou,
    useKinAttentionHandle,
    useKinAskAbout,
    useKinGoals,
  };
}
