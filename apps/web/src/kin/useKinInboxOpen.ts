import { kinInboxScreenWithOpen } from "@t3tools/client-runtime/kin/kinOpenList";

import { useKinOpen } from "./useKinAttention";
import { kinHostKeptTarget, useKinInbox } from "./useKinHost";

/** The inbox with Waiting on you as the host's open list has it (`kinInboxWithOpen`). */
export function useKinInboxOpen(): ReturnType<typeof useKinInbox> {
  const inbox = useKinInbox();
  const target = kinHostKeptTarget(inbox.host);
  const open = useKinOpen(target);
  return { ...inbox, state: kinInboxScreenWithOpen(inbox.state, target?.orgId ?? null, open) };
}
