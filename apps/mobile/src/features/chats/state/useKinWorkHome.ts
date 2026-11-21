import { useAtomValue } from "@effect/atom-react";
import { kinDocsWeekStart } from "@t3tools/client-runtime/kin/kinWorkHome";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { useNowMinuteMs } from "../../../lib/clock";
import { kinClient } from "./kinClient";
import { useKinDocsCounts } from "./useKinDocs";
import type { KinWorkTarget } from "./useKinWork";

const noCountsAtom: ReturnType<typeof kinClient.workCounts> = Atom.make(AsyncResult.initial());

/** How many clients and open projects there are: the host's own totals, kept current. */
export function useKinClientCounts({ environmentId, orgId }: KinWorkTarget, enabled: boolean) {
  const result = useAtomValue(
    enabled ? kinClient.workCounts({ environmentId, input: { orgId } }) : noCountsAtom,
  );
  return Option.getOrNull(AsyncResult.value(result));
}

/**
 * How many docs there are and how many changed this week, kept current by the docs' own change
 * number. `refused` is a viewer the host keeps docs from.
 */
export function useKinDocsRecent(target: KinWorkTarget) {
  return useKinDocsCounts(target, kinDocsWeekStart(useNowMinuteMs()));
}
