import { useAtomValue } from "@effect/atom-react";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { kinAttentionProblem, kinAttentionShown } from "@t3tools/client-runtime/kin/kinAttention";
import { kinWorkAgent } from "@t3tools/client-runtime/kin/kinWorkHome";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { kinWorkReadState } from "@t3tools/client-runtime/kin/kinWorkForms";
import type {
  KinGoalSaveInput,
  KinGoalsResult,
  KinPulseHandleAction,
  KinPulseRead,
  KinDay,
} from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { appAtomRegistry } from "../../../state/atom-registry";
import { useAtomCommand } from "../../../state/use-atom-command";
import { setComposerDraftText } from "../../../state/use-composer-drafts";
import { kinDraftKey } from "../components/KinComposer";
import { kinClient } from "./kinClient";
import { useRereadOnChange } from "./useKinMoney";
import { kinWorkLiveAtom, type KinWorkTarget } from "./useKinWork";

const noAttentionAtom: Atom.Atom<AsyncResult.AsyncResult<KinPulseRead, unknown>> = Atom.make(
  AsyncResult.initial(),
);
const noLiveAtom: Atom.Atom<AsyncResult.AsyncResult<{ readonly seq: number }, unknown>> = Atom.make(
  AsyncResult.initial(),
);
const noGoalsAtom: Atom.Atom<AsyncResult.AsyncResult<KinGoalsResult, unknown>> = Atom.make(
  AsyncResult.initial(),
);

const attentionAtom = ({ environmentId, orgId }: KinWorkTarget) =>
  kinClient.attention({ environmentId, input: { orgId, includeHandled: true } });
/** Facts answered on this device, hidden until the live read says where they stand now. */
const answeredAtom = Atom.family((_target: string) =>
  Atom.make<ReadonlyArray<string>>([]).pipe(Atom.keepAlive),
);
const answeredOf = ({ environmentId, orgId }: KinWorkTarget) =>
  answeredAtom(`${environmentId}:${orgId}`);

/**
 * What needs attention, live over the host's pulse topic and read again whenever Work changes,
 * so a paid invoice or a moved date never leaves the old row behind; null until read.
 */
export function useKinAttention(target: KinWorkTarget, enabled = true) {
  const atom = enabled ? attentionAtom(target) : noAttentionAtom;
  const state = kinWorkReadState(useAtomValue(atom));
  const reads = useAtomValue(kinClient.workRead.permissionAtom(target.environmentId)) && enabled;
  const live = useAtomValue(reads ? kinWorkLiveAtom(target) : noLiveAtom);
  const seq = Option.getOrNull(AsyncResult.value(live))?.seq ?? null;
  useRereadOnChange(seq, () => appAtomRegistry.refresh(atom));
  const answered = useAtomValue(answeredOf(target));
  return state._tag === "ready" ? kinAttentionShown(state.value, new Set(answered)) : null;
}

/** "I've got it", Snooze and "Not a problem", and Undo, with one line when a tap didn't save. */
export function useKinAttentionHandle(target: KinWorkTarget) {
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
      appAtomRegistry.refresh(attentionAtom(target));
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
  const navigation = useNavigation();
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
        setComposerDraftText(kinDraftKey(environmentId, orgId, agent.ownerChatId), message);
        navigation.navigate("KinChat", { environmentId, orgId, chatId: agent.ownerChatId });
      },
    };
  };
}

/** The company's goals, read again when Work changes or needs attention moves. */
export function useKinGoals(
  target: KinWorkTarget,
  options: { readonly enabled: boolean; readonly seq: number | null },
) {
  const atom = kinClient.goals({
    environmentId: target.environmentId,
    input: { orgId: target.orgId },
  });
  const state = kinWorkReadState(useAtomValue(options.enabled ? atom : noGoalsAtom));
  useRereadOnChange(options.seq, () => appAtomRegistry.refresh(atom));
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
      appAtomRegistry.refresh(atom);
      return AsyncResult.isSuccess(outcome)
        ? null
        : kinFailureText(squashAtomCommandFailure(outcome), "Couldn't save the goal.");
    },
  };
}
