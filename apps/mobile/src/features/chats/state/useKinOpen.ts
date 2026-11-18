import { useAtomValue } from "@effect/atom-react";
import type { KinHost } from "@t3tools/client-runtime/kin/kinHost";
import type { KinInboxState } from "@t3tools/client-runtime/kin/kinInboxModel";
import { kinOpenShown, kinOpenWaiting } from "@t3tools/client-runtime/kin/kinOpenView";
import type { KinOpenRead, KinWaitingItem } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { kinClient, kinReads } from "./kinClient";
import type { KinWorkTarget } from "./useKinWork";

const noOpenAtom: Atom.Atom<AsyncResult.AsyncResult<KinOpenRead, unknown>> = Atom.make(
  AsyncResult.initial(),
);
const noStreamedAtom: Atom.Atom<boolean | null> = Atom.make(false);
const noAnsweredAtom: Atom.Atom<ReadonlyArray<string>> = Atom.make([]);

/**
 * The host's one list of what is open for you (`kin.open.subscribe`), shared by every reader. `on`
 * false is a host that doesn't stream it, or hasn't said yet: readers keep today's reads. `read` is
 * null until it first arrives, then the last one held through a dropped connection.
 */
export function useKinOpen(target: KinWorkTarget | null, enabled = true) {
  const at =
    target === null
      ? null
      : { environmentId: target.environmentId, input: { orgId: target.orgId } };
  const streamed = useAtomValue(at === null ? noStreamedAtom : kinClient.openStreamed(at));
  const on = at !== null && enabled && streamed === true;
  const result = useAtomValue(on ? kinClient.openLive(at) : noOpenAtom);
  const answered = useAtomValue(target === null ? noAnsweredAtom : kinReads.answered(target));
  const read = Option.getOrNull(AsyncResult.value(result));
  return { on, read: read === null ? null : kinOpenShown(read, new Set(answered)) };
}

/**
 * Waiting on you for `selectKinInboxView`: the open list's for your company, the chat list's for
 * any other. Undefined where the chat list's own stand: an older host, or until the list arrives.
 */
export function useKinOpenWaiting(
  host: KinHost,
  inbox: KinInboxState | null,
): ReadonlyArray<KinWaitingItem> | undefined {
  const orgId =
    host._tag === "host" && host.probe._tag === "ready"
      ? (host.probe.orgs.me[0]?.orgId ?? null)
      : null;
  const open = useKinOpen(
    host._tag === "host" && orgId !== null ? { environmentId: host.environmentId, orgId } : null,
  );
  if (!open.on || open.read === null || inbox === null) return undefined;
  return [...inbox.waiting.filter((item) => item.orgId !== orgId), ...kinOpenWaiting(open.read)];
}
