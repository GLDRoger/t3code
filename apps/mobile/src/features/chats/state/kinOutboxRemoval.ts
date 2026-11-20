import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Drops a removed environment's unsent Kin messages. Lazy because the outbox reaches the
 * connection runtime, which imports `connection/platform.ts`, the caller.
 */
export const clearKinOutboxEnvironment = (environmentId: EnvironmentId): Promise<void> =>
  import("./kinOutboxDelivery").then((kin) => kin.clearKinOutboxEnvironment(environmentId));

/** Drops unsent messages that are not the session's new person's; lazy for the same reason. */
export const syncKinOutboxIdentity = (
  environmentId: EnvironmentId,
  identity: string | null,
  changed: boolean,
): Promise<void> =>
  import("./kinOutboxDelivery").then((kin) =>
    kin.syncKinOutboxIdentity(environmentId, identity, changed),
  );

/** Drops a removed environment's Kin device cache, from storage and from memory. */
export const clearKinCacheEnvironment = (environmentId: EnvironmentId): Promise<void> =>
  import("./kinClient").then((kin) => kin.forgetKinCache(environmentId));
