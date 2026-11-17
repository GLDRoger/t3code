import { useAtomValue } from "@effect/atom-react";
import { kinOwnerLevelAtom } from "@t3tools/client-runtime/kin/kinAccess";
import type { KinMoneyPart } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../../../connection/runtime";
import { kinClient, kinReads } from "./kinClient";
import type { KinWorkTarget } from "./useKinWork";

/** `part` from Money's stream where this viewer reads it (`kinReads.moneyLive`). */
export function useKinMoneyLive<P extends KinMoneyPart>(target: KinWorkTarget, part: P) {
  const { environmentId, orgId } = target;
  const streamed = useAtomValue(kinClient.moneyStreamed({ environmentId, input: { orgId } }));
  const ownerLevel = useAtomValue(kinOwnerLevelAtom(connectionAtomRuntime, environmentId));
  return kinReads.moneyLive(target, part, ownerLevel, streamed);
}
