import { kinNeedsYouCount } from "@t3tools/client-runtime/kin/kinTasksList";
import { kinWorkListsMoved } from "@t3tools/client-runtime/kin/kinWorkStream";
import type { KinWorkMoveCounts } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { kinClient } from "./kinClient";
import { useKinOpen } from "./useKinOpen";
import { useKinWork, type KinWorkTarget } from "./useKinWork";

/**
 * The nav's Tasks count: the same number as Tasks' Needs you heading (`kinNeedsYouCount`), as the
 * phone's dock badge reads it. Without the host's open list it is Tasks' own count, read again
 * whenever Work's tasks change. Null until known, and on a host that counts neither.
 */
export function useKinTasksNeedsYou(target: KinWorkTarget): number | null {
  const { environmentId, orgId } = target;
  const open = useKinOpen(target);
  const work = useKinWork(target);
  const seq =
    open === null && work._tag === "ready" && !work.stale
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
  return kinNeedsYouCount({ open: open ?? null, counts: open === undefined ? null : counts });
}
