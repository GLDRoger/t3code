import type {
  AuthSessionId,
  KinDesktopNotice,
  KinOrgId,
  KinPersonId,
  KinPushSubject,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";

import { kinPushFit } from "./KinPushSender.ts";

type NoticeQueue = Queue.Queue<KinDesktopNotice>;
type Recipient = {
  readonly personId: KinPersonId;
  readonly delivery: "ring" | "quiet" | "badge";
  readonly subject?: KinPushSubject | undefined;
};

export class KinDesktopNotices extends Context.Service<
  KinDesktopNotices,
  {
    readonly listen: (
      orgId: KinOrgId,
      personId: KinPersonId,
      sessionId: AuthSessionId,
    ) => Effect.Effect<Queue.Dequeue<KinDesktopNotice>, never, Scope.Scope>;
    readonly listeningIn: (orgId: KinOrgId) => Effect.Effect<boolean>;
    readonly listening: (orgId: KinOrgId, personId: KinPersonId) => Effect.Effect<boolean>;
    readonly offer: (
      orgId: KinOrgId,
      push: Omit<KinDesktopNotice, "ring">,
      recipients: ReadonlyArray<Recipient>,
    ) => Effect.Effect<void>;
  }
>()("t3/kin/push/KinDesktopNotices") {}

export const layer = Layer.sync(KinDesktopNotices, () => {
  const orgs = new Map<KinOrgId, Map<KinPersonId, Map<AuthSessionId, Set<NoticeQueue>>>>();

  return KinDesktopNotices.of({
    listen: Effect.fn("KinDesktopNotices.listen")(function* (orgId, personId, sessionId) {
      const queue = yield* Queue.dropping<KinDesktopNotice>(32);
      return yield* Effect.acquireRelease(
        Effect.sync(() => {
          const people = orgs.get(orgId) ?? new Map();
          const sessions = people.get(personId) ?? new Map();
          const streams = sessions.get(sessionId) ?? new Set<NoticeQueue>();
          streams.add(queue);
          sessions.set(sessionId, streams);
          people.set(personId, sessions);
          orgs.set(orgId, people);
          return queue;
        }),
        () =>
          Effect.sync(() => {
            const people = orgs.get(orgId);
            const sessions = people?.get(personId);
            const streams = sessions?.get(sessionId);
            streams?.delete(queue);
            if (streams?.size === 0) sessions?.delete(sessionId);
            if (sessions?.size === 0) people?.delete(personId);
            if (people?.size === 0) orgs.delete(orgId);
          }).pipe(Effect.andThen(Queue.shutdown(queue))),
      );
    }),
    listeningIn: Effect.fn("KinDesktopNotices.listeningIn")((orgId) =>
      Effect.sync(() => orgs.has(orgId)),
    ),
    listening: Effect.fn("KinDesktopNotices.listening")((orgId, personId) =>
      Effect.sync(() => orgs.get(orgId)?.has(personId) ?? false),
    ),
    offer: Effect.fn("KinDesktopNotices.offer")((orgId, push, recipients) =>
      Effect.sync(() => {
        const people = orgs.get(orgId);
        if (people === undefined) return;
        let body: string | undefined;
        for (const { personId, delivery, subject } of recipients) {
          const sessions = people.get(personId);
          if (sessions === undefined || delivery === "badge") continue;
          const notice = {
            title: push.title,
            body: (body ??= kinPushFit(push.body, 4096)),
            ring: delivery === "ring",
            data: subject === undefined ? push.data : { ...push.data, subject },
          };
          for (const streams of sessions.values())
            for (const queue of streams) Queue.offerUnsafe(queue, notice);
        }
      }),
    ),
  });
});
