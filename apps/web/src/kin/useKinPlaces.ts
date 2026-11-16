import type { KinPersonId, KinRecord } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { kinClient } from "./kinClient";
import { useNowMinuteMs } from "./useKinClock";
import type { KinWorkTarget } from "./useKinWork";

const localDayEnd = (nowMs: number) => {
  const now = new Date(nowMs);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - 1;
};

/**
 * Your own open tasks due by the end of today, late ones included, read again whenever Work
 * changes. Null until the first answer; an empty list when it can't be read.
 */
export function useKinMyDueTasks(
  { environmentId, orgId }: KinWorkTarget,
  me: KinPersonId | null,
  seq: number | null,
): ReadonlyArray<KinRecord> | null {
  const dayEnd = localDayEnd(useNowMinuteMs());
  const [held, setHeld] = useState<ReadonlyArray<KinRecord> | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads your due tasks from the host, again when the host announces a change to Work or the day turns
  useEffect(() => {
    if (me === null || seq === null) return;
    let current = true;
    void kinClient.workList
      .run(appAtomRegistry, {
        environmentId,
        input: {
          orgId,
          owner: { _tag: "person", personId: me },
          open: true,
          dueBy: new Date(dayEnd).toISOString(),
          limit: 20,
        },
      })
      .then((result) => {
        if (!current) return;
        // A failed reread keeps what was shown; the stale notice says the page is behind.
        if (AsyncResult.isSuccess(result)) setHeld(result.value.records);
        else setHeld((before) => before ?? []);
      });
    return () => {
      current = false;
    };
  }, [environmentId, orgId, me, dayEnd, seq]);
  if (me === null) return [];
  return held;
}
