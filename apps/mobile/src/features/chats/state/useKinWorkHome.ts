import { useAtomValue } from "@effect/atom-react";
import { kinDocsWeekStart } from "@t3tools/client-runtime/kin/kinWorkHome";
import { createKinWorkFollowedRead } from "@t3tools/client-runtime/kin/kinWorkList";
import type { KinPersonId, KinRecord } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { useNowMinuteMs } from "../../../lib/clock";
import { appAtomRegistry } from "../../../state/atom-registry";
import { kinClient } from "./kinClient";
import { useKinDocsLive } from "./useKinDocs";
import { kinWorkChoicesAtom, kinWorkLiveAtom, type KinWorkTarget } from "./useKinWork";
import { useLocalDayStartMs } from "./useLocalDayStartMs";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Your own open tasks due by the end of today, late ones included, kept current by Work's stream
 * and read again when it can't say. Null until the first answer; an empty list when it can't be read.
 */
export function useKinMyDueTasks(
  { environmentId, orgId }: KinWorkTarget,
  me: KinPersonId | null,
  seq: number | null,
): ReadonlyArray<KinRecord> | null {
  const dayEnd = useLocalDayStartMs() + DAY_MS - 1;
  const [held, setHeld] = useState<{
    readonly me: string | undefined;
    readonly records: ReadonlyArray<KinRecord>;
  } | null>(null);
  // Like the task list, it lives as long as the screen, which a new company or host remounts.
  const [follower] = useState(() =>
    createKinWorkFollowedRead({
      read: (input) => kinClient.workList.run(appAtomRegistry, { environmentId, input }),
      rows: () =>
        appAtomRegistry
          .get(kinWorkLiveAtom({ environmentId, orgId }))
          .pipe(AsyncResult.value, Option.getOrNull)?.rows ?? null,
      onChange: (records, input) =>
        setHeld({
          me: input.owner?._tag === "person" ? input.owner.personId : undefined,
          records,
        }),
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows your due tasks on the host: applies what Work's stream sent, reads when it can't, and again when the day turns
  useEffect(() => {
    if (me === null || seq === null) return;
    follower.update({
      orgId,
      owner: { _tag: "person", personId: me },
      open: true,
      dueBy: new Date(dayEnd).toISOString(),
      limit: 20,
    });
  }, [follower, orgId, me, dayEnd, seq]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- abandons a read in flight when the screen leaves
  useEffect(() => follower.dispose, [follower]);
  if (me === null) return [];
  // Rows read for someone else, or another company, are not yours.
  return held !== null && held.me === me ? held.records : null;
}

/** The active clients and open projects, kept current by Work's changes. */
export function useKinChoicesLive(target: KinWorkTarget, enabled: boolean) {
  const result = useAtomValue(enabled ? kinWorkChoicesAtom(target) : noChoicesAtom);
  return Option.getOrNull(AsyncResult.value(result));
}

const noCountsAtom: ReturnType<typeof kinClient.workCounts> = Atom.make(AsyncResult.initial());

/** How many clients and open projects there are: the host's own totals, kept current. */
export function useKinClientCounts({ environmentId, orgId }: KinWorkTarget, enabled: boolean) {
  const result = useAtomValue(
    enabled ? kinClient.workCounts({ environmentId, input: { orgId } }) : noCountsAtom,
  );
  return Option.getOrNull(AsyncResult.value(result));
}

const noChoicesAtom: ReturnType<typeof kinWorkChoicesAtom> = Atom.make(AsyncResult.initial());
const noDocsAtom: Atom.Atom<
  AsyncResult.AsyncResult<
    { readonly total: number; readonly changed: number; readonly seq: number },
    unknown
  >
> = Atom.make(AsyncResult.initial());

/**
 * How many docs there are and how many changed this week, kept current by the docs' own change
 * number. `refused` is a viewer the host keeps docs from.
 */
export function useKinDocsRecent(target: KinWorkTarget) {
  const { refused, live } = useKinDocsLive(target);
  const since = kinDocsWeekStart(useNowMinuteMs());
  const atom = kinClient.docsCounts({
    environmentId: target.environmentId,
    input: { orgId: target.orgId, since },
  });
  const result = useAtomValue(refused ? noDocsAtom : atom);
  const held = Option.getOrNull(AsyncResult.value(result));
  const behind = held !== null && live !== null && live.seq > held.seq;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the counts from the host again when the host announces a doc changed
  useEffect(() => {
    if (behind) appAtomRegistry.refresh(atom);
  }, [behind, atom]);
  return { refused, docs: held };
}
