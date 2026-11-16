import { useAtomValue } from "@effect/atom-react";
import type { KinDocsListResult, KinPersonId, KinRecord } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { kinClient } from "./kinClient";
import { useNowMinuteMs } from "./useKinClock";
import { useKinDocsLive } from "./useKinDocs";
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

const noCountsAtom: ReturnType<typeof kinClient.workCounts> = Atom.make(AsyncResult.initial());

/** How many clients and open projects there are: the host's own totals, kept current. */
export function useKinClientCounts({ environmentId, orgId }: KinWorkTarget, enabled: boolean) {
  const atom = kinClient.workCounts({ environmentId, input: { orgId } });
  const result = useAtomValue(enabled ? atom : noCountsAtom);
  // A teammate's read of clients is refused; they get no way in rather than a dead one.
  if (AsyncResult.isFailure(result)) return "refused" as const;
  return Option.getOrNull(AsyncResult.value(result));
}

const noDocsAtom: Atom.Atom<AsyncResult.AsyncResult<KinDocsListResult, unknown>> = Atom.make(
  AsyncResult.initial(),
);

/**
 * The newest-changed docs and how many there are, kept current by the docs' own change number.
 * `refused` is a viewer the host keeps docs from.
 */
export function useKinDocsRecent(target: KinWorkTarget) {
  const { refused, live } = useKinDocsLive(target);
  const atom = kinClient.docsUnder({
    environmentId: target.environmentId,
    input: { orgId: target.orgId, limit: 50 },
  });
  const held = Option.getOrNull(AsyncResult.value(useAtomValue(refused ? noDocsAtom : atom)));
  const behind = held !== null && live !== null && live.seq > held.seq;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the docs from the host again when the host announces a doc changed
  useEffect(() => {
    if (behind) appAtomRegistry.refresh(atom);
  }, [behind, atom]);
  return { refused, docs: held };
}
