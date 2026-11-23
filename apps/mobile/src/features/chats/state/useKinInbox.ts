import { useAtomValue } from "@effect/atom-react";
import { Atom, type AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../../../state/atom-registry";
import { kinClient, type KinSynced } from "./kinClient";
import type { KinHost } from "@t3tools/client-runtime/kin/kinHost";
import type { KinInboxState } from "@t3tools/client-runtime/kin/kinInboxModel";
import { kinWorkingAgents } from "@t3tools/client-runtime/kin/kinLeadPresentation";
import type { EnvironmentId, KinAgentId, KinOrgId } from "@t3tools/contracts";
import {
  kinInboxScreenState,
  type KinInboxScreenState,
} from "@t3tools/client-runtime/kin/kinScreenState";
import { useKinHost } from "./useKinHost";

type InboxResult = AsyncResult.AsyncResult<KinSynced<KinInboxState>, unknown> | null;

const noInboxAtom: Atom.Atom<InboxResult> = Atom.make<InboxResult>(null);

/** The agents on a live run, from the chat list's live rows (`kinWorkingAgents`). */
export function useKinWorkingAgents(
  environmentId: EnvironmentId,
  orgId: KinOrgId,
): ReadonlySet<KinAgentId> {
  const inbox = useAtomValue(kinClient.inbox({ environmentId, input: {} }));
  const leads = useAtomValue(kinClient.leads({ environmentId, input: { orgId } }));
  return kinWorkingAgents(
    inbox._tag === "Success" ? inbox.value.value.chats : null,
    leads._tag === "Success" ? leads.value.leads : [],
  );
}

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
