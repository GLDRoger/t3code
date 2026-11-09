import { useAtomValue } from "@effect/atom-react";
import { Atom, type AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../../../state/atom-registry";
import { kinClient, type KinSynced } from "./kinClient";
import type { KinHost } from "./kinHost";
import type { KinInboxState } from "./kinInboxModel";
import { kinInboxScreenState, type KinInboxScreenState } from "./kinScreenState";
import { useKinHost } from "./useKinHost";

type InboxResult = AsyncResult.AsyncResult<KinSynced<KinInboxState>, unknown> | null;

const noInboxAtom: Atom.Atom<InboxResult> = Atom.make<InboxResult>(null);

/** The Kin host's inbox as one screen state, plus a retry for whichever read failed. */
export function useKinInbox(): {
  readonly host: KinHost;
  readonly state: KinInboxScreenState;
  readonly retry: () => void;
} {
  const host = useKinHost();
  const environmentId = host._tag === "host" ? host.environmentId : null;
  const inboxAtom: Atom.Atom<InboxResult> =
    environmentId === null ? noInboxAtom : kinClient.inbox({ environmentId, input: {} });
  const state = kinInboxScreenState(host, useAtomValue(inboxAtom));
  const retry = () => {
    if (environmentId === null || state._tag !== "error") return;
    if (state.retry === "orgs")
      appAtomRegistry.refresh(kinClient.orgs({ environmentId, input: {} }));
    else appAtomRegistry.refresh(inboxAtom);
  };
  return { host, state, retry };
}
