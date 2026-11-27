import type {
  KinOrgId,
  KinPersonId,
  KinPushError,
  KinPushPlatform,
  KinPushSendingStatus,
  KinPushTopic,
  KinPushWithdrawn,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";

import type { KinPushNotification, KinPushOutcome } from "./KinPushSender.ts";
import type { KinPushSettled } from "./KinPushTopics.ts";

/**
 * Kin's push sender (`KinPushSender.ts` builds it). Its tag stands alone so the pulse and other
 * services that settle what pushes told can reach it without importing how it sends.
 */
export class KinPushSender extends Context.Service<
  KinPushSender,
  {
    readonly status: KinPushSendingStatus;
    /** Whether pushes to this platform's devices go anywhere. */
    readonly statusFor: (platform: KinPushPlatform) => KinPushSendingStatus;
    /** Call after the commit; it sends in the background, outliving the request, and never fails. */
    readonly notify: (
      notification: KinPushNotification,
    ) => Effect.Effect<Fiber.Fiber<KinPushOutcome>>;
    /** Sends every push an approver key change still owes, then settles it. Returns how many. */
    readonly flushKeyPushes: Effect.Effect<number>;
    /**
     * Call after a commit that may have settled what pushes told people of: each one that no longer
     * needs its person is withdrawn from their phones, batched per person. Never fails.
     */
    readonly settle: (orgId: KinOrgId, settled: KinPushSettled) => Effect.Effect<void>;
    /** Waits for every batch of withdrawals already started to be sent. */
    readonly drainWithdrawals: Effect.Effect<void>;
    /**
     * One bounded pass over what pushes told that is still live: whatever no longer stands, by the
     * check reconcile uses, is withdrawn. Heals a batch a restart lost or a gateway refused.
     */
    readonly recover: Effect.Effect<void>;
    /** Of the topics a phone of `personId` still shows, the settled ones, and their badge. */
    readonly reconcile: (
      orgId: KinOrgId,
      personId: KinPersonId,
      topics: ReadonlyArray<KinPushTopic>,
    ) => Effect.Effect<
      {
        readonly remove: ReadonlyArray<KinPushWithdrawn>;
        readonly unknown: ReadonlyArray<KinPushTopic>;
        readonly badge: number;
      },
      KinPushError
    >;
  }
>()("t3/kin/push/KinPushSenderService/KinPushSender") {}
