import { kinInboxScreenWithOpen } from "@t3tools/client-runtime/kin/kinOpenList";

import { useKinOpen } from "./useKinAttention";
import { useKinInbox } from "./useKinInbox";

/** The inbox with Waiting on you as the host's open list has it (`kinInboxWithOpen`). */
export function useKinInboxOpen(): ReturnType<typeof useKinInbox> {
  const inbox = useKinInbox();
  const { host } = inbox;
  const orgId =
    host._tag === "host" && host.probe._tag === "ready"
      ? (host.probe.orgs.me[0]?.orgId ?? null)
      : null;
  const target =
    host._tag === "host" && orgId !== null ? { environmentId: host.environmentId, orgId } : null;
  const open = useKinOpen(target);
  return { ...inbox, state: kinInboxScreenWithOpen(inbox.state, orgId, open) };
}
