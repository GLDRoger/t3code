import { useAtomValue } from "@effect/atom-react";
import { kinAccessMeAtom, kinOwnerLevelAtom } from "@t3tools/client-runtime/kin/kinAccess";
import { kinNeedsYouCount, kinTasksDealFactsOf } from "@t3tools/client-runtime/kin/kinTasksList";
import { kinWorkListsMoved } from "@t3tools/client-runtime/kin/kinWorkStream";
import type { KinWorkMoveCounts } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";

import { connectionAtomRuntime } from "../../../connection/runtime";
import { appAtomRegistry } from "../../../state/atom-registry";
import { kinClient } from "./kinClient";
import { useKinAttention } from "./useKinAttention";
import { useKinOpen } from "./useKinOpen";
import { useKinWork, type KinWorkTarget } from "./useKinWork";

/**
 * The dock's Tasks badge: the same number as Tasks' Needs you heading (`kinNeedsYouCount`). Without
 * the host's open list it is Tasks' own count, read again whenever Work's tasks change, and the deal facts.
 */
export function useKinTasksBadge(target: KinWorkTarget): number | null {
  const { environmentId, orgId } = target;
  const open = useKinOpen(target);
  const pulse = useKinAttention(target, !open.on);
  const ownerLevel = useAtomValue(kinOwnerLevelAtom(connectionAtomRuntime, environmentId));
  const me = useAtomValue(kinAccessMeAtom(connectionAtomRuntime, environmentId));
  const work = useKinWork(target);
  const seq =
    !open.on && work._tag === "ready" && !work.stale
      ? kinWorkListsMoved(work.live, ["work"])
      : null;
  const [counts, setCounts] = useState<KinWorkMoveCounts | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the host's Needs you count again when Work's change number moves
  useEffect(() => {
    if (seq === null) return;
    let current = true;
    void kinClient.workList
      .run(appAtomRegistry, {
        environmentId,
        input: { orgId, open: true, byMove: true, limit: 1, acceptCompactRows: true },
      })
      .then((result) => {
        if (current && AsyncResult.isSuccess(result)) setCounts(result.value.counts ?? null);
      });
    return () => {
      current = false;
    };
  }, [environmentId, orgId, seq]);
  const dealFacts = kinTasksDealFactsOf(open.on ? open.read : null, pulse, {
    ownerLevel,
    me: me?.personId ?? null,
  });
  return kinNeedsYouCount({
    open: open.on ? open.read : null,
    counts,
    dealFacts: dealFacts.length,
  });
}
