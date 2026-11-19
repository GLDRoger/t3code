import { useAtomValue } from "@effect/atom-react";
import { kinDocsWeekStart } from "@t3tools/client-runtime/kin/kinWorkHome";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { useNowMinuteMs } from "../../../lib/clock";
import { appAtomRegistry } from "../../../state/atom-registry";
import { kinClient } from "./kinClient";
import { useKinDocsLive } from "./useKinDocs";
import type { KinWorkTarget } from "./useKinWork";

const noCountsAtom: ReturnType<typeof kinClient.workCounts> = Atom.make(AsyncResult.initial());

/** How many clients and open projects there are: the host's own totals, kept current. */
export function useKinClientCounts({ environmentId, orgId }: KinWorkTarget, enabled: boolean) {
  const result = useAtomValue(
    enabled ? kinClient.workCounts({ environmentId, input: { orgId } }) : noCountsAtom,
  );
  return Option.getOrNull(AsyncResult.value(result));
}

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
