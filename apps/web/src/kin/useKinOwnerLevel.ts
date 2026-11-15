import { useAtomValue } from "@effect/atom-react";
import { kinOwnerLevelAtom } from "@t3tools/client-runtime/kin/kinAccess";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { isChatOnlySession } from "../environments/primary";

/**
 * Whether the viewer runs the company here: the owner's own session always does; a chat-only
 * session does once the host says its person is the owner or a co-owner.
 */
export function useKinOwnerLevel(environmentId: EnvironmentId): boolean {
  const atom = useMemo(
    () => kinOwnerLevelAtom(connectionAtomRuntime, environmentId),
    [environmentId],
  );
  const stored = useAtomValue(atom);
  return !isChatOnlySession() || stored;
}
