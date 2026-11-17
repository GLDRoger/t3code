import { useAtomValue } from "@effect/atom-react";
import type { KinMoneyPart } from "@t3tools/contracts";

import { kinClient, kinReads } from "./kinClient";
import { useKinOwnerLevel } from "./useKinOwnerLevel";
import type { KinWorkTarget } from "./useKinWork";

/** `part` from Money's stream where this viewer reads it (`kinReads.moneyLive`). */
export function useKinMoneyLive<P extends KinMoneyPart>(target: KinWorkTarget, part: P) {
  const { environmentId, orgId } = target;
  const streamed = useAtomValue(kinClient.moneyStreamed({ environmentId, input: { orgId } }));
  return kinReads.moneyLive(target, part, useKinOwnerLevel(environmentId), streamed);
}
