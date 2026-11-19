import { useAtomValue } from "@effect/atom-react";
import { kinOpenShown, kinOpenWaitingAtom } from "@t3tools/client-runtime/kin/kinOpenView";
import { kinWorkReadState } from "@t3tools/client-runtime/kin/kinWorkForms";
import type { EnvironmentId, KinOpenRead, KinOrgId, KinWaitingItem } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { kinClient, kinReads } from "./kinClient";
import type { KinWorkTarget } from "./useKinWork";

/**
 * The host's open list: null where today's reads stand (a host that doesn't stream it, or a
 * stream that failed before its first read), undefined while the host hasn't said or it loads.
 */
const openAtom = Atom.family((key: string) => {
  const [environmentId, orgId] = JSON.parse(key) as [EnvironmentId, KinOrgId];
  const target = { environmentId, input: { orgId } };
  return Atom.make((get): KinOpenRead | null | undefined => {
    const streamed = get(kinClient.openStreamed(target));
    if (streamed !== true) return streamed === null ? undefined : null;
    const state = kinWorkReadState(get(kinClient.openLive(target)));
    if (state._tag === "ready") return state.value;
    return state._tag === "loading" ? undefined : null;
  }).pipe(Atom.withLabel(`kin:open:read:${environmentId}`));
});

const waitingAtom = Atom.family((key: string) => kinOpenWaitingAtom(openAtom(key)));

const keyOf = ({ environmentId, orgId }: KinWorkTarget) => JSON.stringify([environmentId, orgId]);

/**
 * Everything open for this person, from the one `kin.open.subscribe` per org every reader shares,
 * less what was just answered here. Null: read as before. Undefined: not known yet.
 */
export function useKinOpen(target: KinWorkTarget): KinOpenRead | null | undefined {
  const read = useAtomValue(openAtom(keyOf(target)));
  const answered = useAtomValue(kinReads.answered(target));
  return read == null ? read : kinOpenShown(read, new Set(answered));
}

const noWaitingAtom = Atom.make<ReadonlyArray<KinWaitingItem> | null>(null);

/** What waits on this person in their org's chats, from the open list; null where it isn't read. */
export function useKinOpenWaiting(target: KinWorkTarget | null) {
  return useAtomValue(target === null ? noWaitingAtom : waitingAtom(keyOf(target)));
}
