import { useAtomValue } from "@effect/atom-react";
import { kinOwnerLevelAtom } from "@t3tools/client-runtime/kin/kinAccess";
import {
  kinAttentionProblem,
  kinAttentionShown,
  type KinAttentionScope,
  KIN_GOALS,
} from "@t3tools/client-runtime/kin/kinAttention";
import { kinAskAboutAgent } from "@t3tools/client-runtime/kin/kinScreenReads";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { kinWorkReadState } from "@t3tools/client-runtime/kin/kinWorkForms";
import type {
  KinGoalSaveInput,
  KinGoalsResult,
  KinPulseHandleAction,
  KinPulseScreenRead,
  KinDay,
  KinRecordKey,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { connectionAtomRuntime } from "../connection/runtime";
import { kinClient, kinReads } from "./kinClient";
import { useKinOpenChat } from "./useKinOpenChat";
import { useKinMoneyLive } from "./useKinMoneyLive";
import { useRereadOnChange } from "./useKinMoney";
import { kinWorkLiveAtom, type KinWorkTarget } from "./useKinWork";

const noAttentionAtom: Atom.Atom<AsyncResult.AsyncResult<KinPulseScreenRead, unknown>> = Atom.make(
  AsyncResult.initial(),
);
const noLiveAtom: Atom.Atom<AsyncResult.AsyncResult<{ readonly seq: number }, unknown>> = Atom.make(
  AsyncResult.initial(),
);
const noGoalsAtom: Atom.Atom<AsyncResult.AsyncResult<KinGoalsResult, unknown>> = Atom.make(
  AsyncResult.initial(),
);

const attentionAtom = kinReads.attention;
const streamedAtom = kinReads.attentionStreamed;

/**
 * What needs attention, live; null until read. A host that streams it sends what moved. On an
 * older one it is read again when the pulse topic moves, which covers all an owner-level viewer is
 * shown; a member's view also turns on what is shared with them, so theirs follows Work's changes.
 */
export function useKinAttention(
  target: KinWorkTarget,
  enabled = true,
  paged = false,
  scope?: KinAttentionScope,
) {
  const streamed = useAtomValue(streamedAtom(target));
  const atom =
    enabled && streamed !== null ? attentionAtom(target, streamed, paged, scope) : noAttentionAtom;
  const state = kinWorkReadState(useAtomValue(atom));
  const ownerLevel = useAtomValue(kinOwnerLevelAtom(connectionAtomRuntime, target.environmentId));
  const reads =
    useAtomValue(kinClient.workRead.permissionAtom(target.environmentId)) &&
    enabled &&
    !ownerLevel &&
    streamed === false;
  const live = useAtomValue(reads ? kinWorkLiveAtom(target) : noLiveAtom);
  const seq = Option.getOrNull(AsyncResult.value(live))?.seq ?? null;
  useRereadOnChange(seq, () => appAtomRegistry.refresh(atom));
  const answered = useAtomValue(kinReads.answered(target));
  return state._tag === "ready" ? kinAttentionShown(state.value, new Set(answered)) : null;
}

/**
 * "I've got it", Snooze and "Not a problem", Undo, and setting a record aside or lifting it, with
 * one line when a tap didn't save.
 */
export function useKinAttentionHandle(target: KinWorkTarget, scope?: KinAttentionScope) {
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
export function useKinAskAbout({ environmentId, orgId }: KinWorkTarget) {
  const openChat = useKinOpenChat();
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
 * The company's goals, read again when Work changes or needs attention moves; on Money's own screen
 * (`money`), from Money's stream where the host streams it.
 */
export function useKinGoals(
  target: KinWorkTarget,
  options: { readonly enabled: boolean; readonly money?: boolean },
) {
  const streamed = useKinMoneyLive(target, "goals");
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
      if (live === null) appAtomRegistry.refresh(atom);
      return AsyncResult.isSuccess(outcome)
        ? null
        : kinFailureText(squashAtomCommandFailure(outcome), KIN_GOALS.saveFailed);
    },
  };
}
