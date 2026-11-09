import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Drops a removed environment's unsent Kin messages. Lazy because the outbox reaches the
 * connection runtime, which imports `connection/platform.ts`, the caller.
 */
export const clearKinOutboxEnvironment = (environmentId: EnvironmentId): Promise<void> =>
  import("./kinOutboxDelivery").then((kin) => kin.clearKinOutboxEnvironment(environmentId));
