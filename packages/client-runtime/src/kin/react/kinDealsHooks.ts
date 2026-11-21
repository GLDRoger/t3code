import { useAtomValue } from "@effect/atom-react";
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
  KinRecordKey,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { kinListSend, type KinListOutcome } from "../kinLists.ts";
import type { KinScreenTarget } from "../kinScreenReads.ts";
import { kinWorkReadState } from "../kinWorkForms.ts";
import type { KinHookApp } from "./kinHookApp.ts";

const notYet = Atom.make(AsyncResult.initial<KinDealsResult>());

/** Deals, a deal's page, the stages and their writes, on one app's client. */
export function makeKinDealsHooks<R, ER>(app: KinHookApp<R, ER>) {
  const { kinClient, registry, useAtomCommand, kinHostConnected } = app;
  const dealsAtom = (target: KinScreenTarget, input: KinDealsInput) =>
    kinClient.workDeals({ environmentId: target.environmentId, input });
  const dealAtom = (target: KinScreenTarget, key: KinRecordKey) =>
    kinClient.workDeal({
      environmentId: target.environmentId,
      input: { orgId: target.orgId, key },
    });
  const stagesAtom = (target: KinScreenTarget) =>
    kinClient.workDealStages({
      environmentId: target.environmentId,
      input: { orgId: target.orgId },
    });

  /**
   * Deals under the filters; the host's stream reads them again when one moves. Null input reads
   * nothing yet and stays loading.
   */
  function useKinDeals(target: KinScreenTarget, input: KinDealsInput | null) {
    const atom = input === null ? null : dealsAtom(target, input);
    return {
      state: kinWorkReadState(useAtomValue(atom ?? notYet)),
      refresh: () => {
        if (atom !== null) registry.refresh(atom);
      },
    };
  }

  function useKinDealPage(target: KinScreenTarget, key: KinRecordKey) {
    const atom = dealAtom(target, key);
    return {
      state: kinWorkReadState(useAtomValue(atom)),
      refresh: () => registry.refresh(atom),
    };
  }

  function useKinDealStages(target: KinScreenTarget) {
    const atom = stagesAtom(target);
    return {
      state: kinWorkReadState(useAtomValue(atom)),
      refresh: () => registry.refresh(atom),
    };
  }

  /** A deal's writes, each answered with the deal as the host now has it. */
  function useKinDealSend(target: KinScreenTarget) {
    const { environmentId, orgId } = target;
    const move = useAtomCommand(kinClient.workDealMove, { reportFailure: false });
    const update = useAtomCommand(kinClient.workDealUpdate, { reportFailure: false });
    const create = useAtomCommand(kinClient.workDealCreate, { reportFailure: false });
    const step = useAtomCommand(kinClient.workDealStep, { reportFailure: false });
    const online = () => kinHostConnected(environmentId);
    const after = (outcome: KinListOutcome<KinDealResult>) => {
      if (outcome.ok) registry.refresh(dealAtom(target, outcome.value.deal.key));
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
            send: () =>
              step({ environmentId, input: { orgId, key, step: input, clientRequestId } }),
          }),
        ),
    };
  }

  /** "A deal goes quiet after N days", answered with the stages as the host now has them. */
  function useKinDealQuietDaysSet(target: KinScreenTarget) {
    const set = useAtomCommand(kinClient.workDealQuietDaysSet, { reportFailure: false });
    return async (days: number): Promise<KinListOutcome<KinDealStagesResult>> => {
      const outcome = await kinListSend({
        online: () => kinHostConnected(target.environmentId),
        send: () =>
          set({ environmentId: target.environmentId, input: { orgId: target.orgId, days } }),
      });
      if (outcome.ok) registry.refresh(stagesAtom(target));
      return outcome;
    };
  }

  function useKinDealStagesSet(target: KinScreenTarget) {
    const set = useAtomCommand(kinClient.workDealStagesSet, { reportFailure: false });
    return async (
      input: Omit<KinDealStagesSetInput, "orgId">,
    ): Promise<KinListOutcome<KinDealStagesResult>> => {
      const outcome = await kinListSend({
        online: () => kinHostConnected(target.environmentId),
        send: () =>
          set({ environmentId: target.environmentId, input: { ...input, orgId: target.orgId } }),
      });
      if (outcome.ok) registry.refresh(stagesAtom(target));
      return outcome;
    };
  }

  return {
    useKinDeals,
    useKinDealPage,
    useKinDealStages,
    useKinDealSend,
    useKinDealQuietDaysSet,
    useKinDealStagesSet,
  };
}
