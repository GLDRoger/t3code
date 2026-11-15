import { useAtomValue } from "@effect/atom-react";
import { KIN_ATTENTION } from "@t3tools/client-runtime/kin/kinAttention";
import { kinWorkAgent } from "@t3tools/client-runtime/kin/kinWorkHome";
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
import type { KinWorkTarget } from "./useKinWork";

const noAttentionAtom: Atom.Atom<AsyncResult.AsyncResult<KinPulseRead, unknown>> = Atom.make(
  AsyncResult.initial(),
);
const noGoalsAtom: Atom.Atom<AsyncResult.AsyncResult<KinGoalsResult, unknown>> = Atom.make(
  AsyncResult.initial(),
);

const attentionAtom = ({ environmentId, orgId }: KinWorkTarget) =>
  kinClient.attention({ environmentId, input: { orgId, includeHandled: true } });

/** What needs attention, live over the host's pulse topic; null until read or where refused. */
export function useKinAttention(target: KinWorkTarget, enabled = true) {
  const state = kinWorkReadState(useAtomValue(enabled ? attentionAtom(target) : noAttentionAtom));
  return state._tag === "ready" ? state.value : null;
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
      if (!AsyncResult.isSuccess(outcome)) setProblem(KIN_ATTENTION.failed);
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
        : "Couldn't save the goal. Check the target and dates, then try again.";
    },
  };
}
