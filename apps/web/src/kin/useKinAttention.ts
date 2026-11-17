import { useAtomValue } from "@effect/atom-react";
import { kinOwnerLevelAtom } from "@t3tools/client-runtime/kin/kinAccess";
import {
  KIN_NEEDS_YOU_PAGE,
  kinAttentionProblem,
  kinAttentionShown,
  kinPulseScopeOf,
  type KinAttentionScope,
} from "@t3tools/client-runtime/kin/kinAttention";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { kinWorkAgent } from "@t3tools/client-runtime/kin/kinWorkHome";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { kinWorkReadState } from "@t3tools/client-runtime/kin/kinWorkForms";
import type {
  KinGoalSaveInput,
  KinGoalsResult,
  KinPulseHandleAction,
  KinPulseScreenRead,
  KinDay,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { prefillKinDraft } from "./KinChatView";
import { connectionAtomRuntime } from "../connection/runtime";
import { kinClient } from "./kinClient";
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

/**
 * `paged`: the first open facts Needs you shows, and counts of the rest (`outline`). `scope`: only
 * what a client's, project's or Money's own section is about; the section still filters exactly.
 */
const attentionInput = (
  { environmentId, orgId }: KinWorkTarget,
  paged: boolean,
  scope: KinAttentionScope | undefined,
) => ({
  environmentId,
  input: {
    orgId,
    includeHandled: true,
    ...(paged ? { limit: KIN_NEEDS_YOU_PAGE } : {}),
    ...(scope === undefined ? {} : { scope: kinPulseScopeOf(scope) }),
  },
});
const attentionAtom = (
  target: KinWorkTarget,
  streamed: boolean,
  paged = false,
  scope?: KinAttentionScope,
) =>
  streamed
    ? kinClient.attentionLive(attentionInput(target, paged, scope))
    : kinClient.attention(attentionInput(target, paged, scope));
const streamedAtom = ({ environmentId, orgId }: KinWorkTarget) =>
  kinClient.attentionStreamed({ environmentId, input: { orgId } });
/** Facts answered on this device, hidden until the live read says where they stand now. */
const answeredAtom = Atom.family((_target: string) =>
  Atom.make<ReadonlyArray<string>>([]).pipe(Atom.keepAlive),
);
const answeredOf = ({ environmentId, orgId }: KinWorkTarget) =>
  answeredAtom(`${environmentId}:${orgId}`);

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
  const answered = useAtomValue(answeredOf(target));
  return state._tag === "ready" ? kinAttentionShown(state.value, new Set(answered)) : null;
}

/** "I've got it", Snooze and "Not a problem", and Undo, with one line when a tap didn't save. */
export function useKinAttentionHandle(target: KinWorkTarget, scope?: KinAttentionScope) {
  const handle = useAtomCommand(kinClient.attentionHandle, { reportFailure: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  return {
    busy,
    problem,
    send: async (factKey: string, action: KinPulseHandleAction, until?: KinDay) => {
      setBusy(factKey);
      setProblem(null);
      const answered = answeredOf(target);
      const mark = (on: boolean) => {
        const rest = appAtomRegistry.get(answered).filter((key) => key !== factKey);
        appAtomRegistry.set(answered, on ? [...rest, factKey] : rest);
      };
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
      // A host that streams it sends the answer's effect; an older one is asked again.
      if (appAtomRegistry.get(streamedAtom(target)) === false) {
        appAtomRegistry.refresh(attentionAtom(target, false));
        appAtomRegistry.refresh(attentionAtom(target, false, true));
        if (scope !== undefined)
          appAtomRegistry.refresh(attentionAtom(target, false, false, scope));
      }
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
  const navigate = useNavigate();
  const canRestore = useAtomValue(kinClient.leadRestore.permissionAtom(environmentId));
  const result = useAtomValue(
    canRestore
      ? kinClient.agents({ environmentId, orgId })
      : kinClient.leads({ environmentId, input: { orgId } }),
  );
  const leads = Option.getOrNull(AsyncResult.value(result))?.leads ?? [];
  return (agentId: string | null) => {
    const agent =
      leads.find((lead) => lead.agentId === agentId && lead.retired === undefined) ??
      kinWorkAgent(leads, "tasks");
    if (agent === null) return null;
    return {
      name: agent.name,
      ask: (message: string) => {
        prefillKinDraft(environmentId, orgId, agent.ownerChatId, message);
        void navigate({
          to: "/kin/$environmentId/$orgId/$chatId",
          params: { environmentId, orgId, chatId: agent.ownerChatId },
        });
      },
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
  const atom =
    live?.atom ??
    kinClient.goals({ environmentId: target.environmentId, input: { orgId: target.orgId } });
  const state = kinWorkReadState(
    useAtomValue(options.enabled && live !== undefined ? atom : noGoalsAtom),
  );
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
        : kinFailureText(squashAtomCommandFailure(outcome), "Couldn't save the goal.");
    },
  };
}
