import { KIN_REFRESH_TOPICS, type KinOrgId, type KinRefreshTopic } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

export type KinRevisions = Readonly<Record<KinRefreshTopic, number>>;

/** A burst of commits (an import, a statement applied) settles this long, then is one change. */
export const KIN_REFRESH_SETTLE = Duration.millis(250);

const NONE = Object.fromEntries(KIN_REFRESH_TOPICS.map((topic) => [topic, 0])) as KinRevisions;

/**
 * Told by the service that commits a change to a Kin read that `kin.work.subscribe` and
 * `kin.docs.subscribe` don't cover. A no-op outside the server, as in the `kin` CLI and in tests
 * that don't watch it; the server's hub layer provides the one clients hear.
 */
export class KinRefreshObserver extends Context.Reference<{
  /** Moves `topic` once the current transaction commits, once per transaction; at once outside one. */
  readonly touch: (orgId: KinOrgId, topic: KinRefreshTopic) => Effect.Effect<void>;
}>("t3/kin/chat/KinRefreshObserver", { defaultValue: () => ({ touch: () => Effect.void }) }) {}

/** The revisions clients read again on, per org. */
export class KinRefreshHub extends Context.Service<
  KinRefreshHub,
  {
    /** The org's revisions now, then after each settled burst. Server only: callers filter by viewer. */
    readonly changes: (orgId: KinOrgId) => Stream.Stream<KinRevisions>;
  }
>()("t3/kin/chat/KinRefreshHub") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const revisions = new Map<KinOrgId, KinRevisions>();
  const hubs = new Map<KinOrgId, PubSub.PubSub<void>>();
  const touched = new WeakMap<object, Set<string>>();
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...hubs.values()], PubSub.shutdown, { discard: true }),
  );
  const current = (orgId: KinOrgId) => revisions.get(orgId) ?? NONE;
  const hubOf = Effect.fn("KinRefreshHub.hubOf")(function* (orgId: KinOrgId) {
    const held = hubs.get(orgId);
    if (held !== undefined) return held;
    // A subscriber only needs to know it is behind, so one waiting signal is enough.
    const created = yield* PubSub.sliding<void>(1);
    const hub = hubs.get(orgId) ?? created;
    hubs.set(orgId, hub);
    return hub;
  });
  const bump = (orgId: KinOrgId, topic: KinRefreshTopic) =>
    Effect.suspend(() => {
      const now = current(orgId);
      revisions.set(orgId, { ...now, [topic]: now[topic] + 1 });
      const hub = hubs.get(orgId);
      return hub === undefined ? Effect.void : PubSub.publish(hub, undefined).pipe(Effect.asVoid);
    });

  const touch = Effect.fn("KinRefreshHub.touch")(function* (
    orgId: KinOrgId,
    topic: KinRefreshTopic,
  ) {
    const transaction = yield* Effect.serviceOption(sql.transactionService);
    if (Option.isSome(transaction)) {
      const key = `${orgId}:${topic}`;
      const seen = touched.get(transaction.value) ?? new Set<string>();
      if (seen.has(key)) return;
      seen.add(key);
      touched.set(transaction.value, seen);
    }
    yield* sql.afterCommit(bump(orgId, topic));
  });
  const hub = KinRefreshHub.of({
    changes: (orgId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(yield* hubOf(orgId));
          const settled = PubSub.take(subscription).pipe(
            Effect.andThen(Effect.sleep(KIN_REFRESH_SETTLE)),
            Effect.andThen(PubSub.takeUpTo(subscription, 1)),
            Effect.map(() => current(orgId)),
          );
          return Stream.concat(
            Stream.sync(() => current(orgId)),
            Stream.fromEffectRepeat(settled),
          );
        }),
      ),
  });
  return Context.make(KinRefreshHub, hub).pipe(Context.add(KinRefreshObserver, { touch }));
});

export const layer = Layer.effectContext(make);
