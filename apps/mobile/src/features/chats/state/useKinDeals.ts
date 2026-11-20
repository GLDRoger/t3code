import { useAtomValue } from "@effect/atom-react";
import { kinAccessKnownAtom } from "@t3tools/client-runtime/kin/kinAccess";
import { kinDealsStartFilter, type KinDealsFilter } from "@t3tools/client-runtime/kin/kinDeals";
import { kinListSend, type KinListOutcome } from "@t3tools/client-runtime/kin/kinLists";
import { kinWorkReadState } from "@t3tools/client-runtime/kin/kinWorkForms";
import type {
  KinDealCreateInput,
  KinDealMove,
  KinDealResult,
  KinDealRow,
  KinDealStagesResult,
  KinDealStagesSetInput,
  KinDealStepInput,
  KinDealsInput,
  KinDealsResult,
  KinDealUpdateInput,
  EnvironmentId,
  KinRecordKey,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../../connection/runtime";

import { appAtomRegistry } from "../../../state/atom-registry";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "./kinClient";
import { kinHostConnected } from "./useKinHost";
import type { KinWorkTarget } from "./useKinWork";

const dealsAtom = (target: KinWorkTarget, input: KinDealsInput) =>
  kinClient.workDeals({ environmentId: target.environmentId, input });
const dealAtom = (target: KinWorkTarget, key: KinRecordKey) =>
  kinClient.workDeal({ environmentId: target.environmentId, input: { orgId: target.orgId, key } });
const stagesAtom = (target: KinWorkTarget) =>
  kinClient.workDealStages({
    environmentId: target.environmentId,
    input: { orgId: target.orgId },
  });

const notYet = Atom.make(AsyncResult.initial<KinDealsResult>());

/**
 * Deals under the filters; the host's stream reads them again when one moves. Null input reads
 * nothing yet and stays loading.
 */
export function useKinDeals(target: KinWorkTarget, input: KinDealsInput | null) {
  const atom = input === null ? null : dealsAtom(target, input);
  return {
    state: kinWorkReadState(useAtomValue(atom ?? notYet)),
    refresh: () => {
      if (atom !== null) appAtomRegistry.refresh(atom);
    },
  };
}

/** Where the Deals tab starts; null until the host says whether the viewer is owner level. */
export function useKinDealsStart(environmentId: EnvironmentId): KinDealsFilter | null {
  return kinDealsStartFilter(
    useAtomValue(kinAccessKnownAtom(connectionAtomRuntime, environmentId)),
  );
}

export function useKinDealPage(target: KinWorkTarget, key: KinRecordKey) {
  const atom = dealAtom(target, key);
  return {
    state: kinWorkReadState(useAtomValue(atom)),
    refresh: () => appAtomRegistry.refresh(atom),
  };
}

export function useKinDealStages(target: KinWorkTarget) {
  const atom = stagesAtom(target);
  return {
    state: kinWorkReadState(useAtomValue(atom)),
    refresh: () => appAtomRegistry.refresh(atom),
  };
}

/** A deal's writes, each answered with the deal as the host now has it. */
export function useKinDealSend(target: KinWorkTarget) {
  const { environmentId, orgId } = target;
  const move = useAtomCommand(kinClient.workDealMove, { reportFailure: false });
  const update = useAtomCommand(kinClient.workDealUpdate, { reportFailure: false });
  const create = useAtomCommand(kinClient.workDealCreate, { reportFailure: false });
  const step = useAtomCommand(kinClient.workDealStep, { reportFailure: false });
  const online = () => kinHostConnected(environmentId);
  const after = (outcome: KinListOutcome<KinDealResult>) => {
    if (outcome.ok) appAtomRegistry.refresh(dealAtom(target, outcome.value.deal.key));
    return outcome;
  };
  return {
    move: async (deal: Pick<KinDealRow, "key" | "rev">, to: KinDealMove) =>
      after(
        await kinListSend({
          online,
          send: () => move({ environmentId, input: { orgId, key: deal.key, rev: deal.rev, to } }),
        }),
      ),
    update: async (input: Omit<KinDealUpdateInput, "orgId">) =>
      after(
        await kinListSend({
          online,
          send: () => update({ environmentId, input: { ...input, orgId } }),
        }),
      ),
    create: async (input: Omit<KinDealCreateInput, "orgId">) =>
      after(
        await kinListSend({
          online,
          send: () => create({ environmentId, input: { ...input, orgId } }),
        }),
      ),
    step: async (key: KinRecordKey, input: KinDealStepInput, clientRequestId: string) =>
      after(
        await kinListSend({
          online,
          send: () => step({ environmentId, input: { orgId, key, step: input, clientRequestId } }),
        }),
      ),
  };
}

/** "A deal goes quiet after N days", answered with the stages as the host now has them. */
export function useKinDealQuietDaysSet(target: KinWorkTarget) {
  const set = useAtomCommand(kinClient.workDealQuietDaysSet, { reportFailure: false });
  return async (days: number): Promise<KinListOutcome<KinDealStagesResult>> => {
    const outcome = await kinListSend({
      online: () => kinHostConnected(target.environmentId),
      send: () =>
        set({ environmentId: target.environmentId, input: { orgId: target.orgId, days } }),
    });
    if (outcome.ok) appAtomRegistry.refresh(stagesAtom(target));
    return outcome;
  };
}

export function useKinDealStagesSet(target: KinWorkTarget) {
  const set = useAtomCommand(kinClient.workDealStagesSet, { reportFailure: false });
  return async (
    input: Omit<KinDealStagesSetInput, "orgId">,
  ): Promise<KinListOutcome<KinDealStagesResult>> => {
    const outcome = await kinListSend({
      online: () => kinHostConnected(target.environmentId),
      send: () =>
        set({ environmentId: target.environmentId, input: { ...input, orgId: target.orgId } }),
    });
    if (outcome.ok) appAtomRegistry.refresh(stagesAtom(target));
    return outcome;
  };
}
