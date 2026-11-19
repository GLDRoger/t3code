import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SessionStore } from "../../auth/SessionStore.ts";
import { layerAuthTest, pairSession } from "../auth/ProofKeySessions.testkit.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import { KinIdentity, KinIdentityConfig } from "../chat/KinIdentity.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as People from "../people/KinPeople.ts";
import * as Records from "../work/KinRecords.ts";
import * as TasksKeys from "./TasksKeys.ts";

// Invented company only: Ambermill's owner and two teammates, Zoya and Arjun.
const identities = KinIdentity.layer.pipe(
  Layer.provide(
    Layer.succeed(KinIdentityConfig, {
      orgName: "Ambermill",
      ownerHandle: "rhea",
      ownerDisplayName: "Rhea",
    }),
  ),
  Layer.provideMerge(Repository.layer),
);
export const layerAt = (dir: string | { readonly prefix: string }) =>
  People.layer.pipe(
    Layer.provideMerge(Records.layer),
    Layer.provideMerge(KinEventQueue.layer),
    Layer.provideMerge(Hub.layer),
    Layer.provideMerge(identities),
    Layer.provideMerge(layerAuthTest(dir)),
  );
export const layer = layerAt({ prefix: "kin-tasks-key-" });
/** The owner signed in on a paired device, and Zoya and Arjun on the phones their invites made. */
export const team = Effect.gen(function* () {
  const people = yield* People.KinPeople;
  const sessions = yield* SessionStore;
  const identity = yield* KinIdentity;
  const orgId = identity.owner.orgId;
  const signedIn = yield* sessions.issue({ subject: "browser" });
  yield* pairSession(signedIn.sessionId);
  const ownerApp = yield* sessions.verify(signedIn.token);
  const join = Effect.fn("test.join")(function* (displayName: string) {
    const invite = yield* people.createInvite(ownerApp, { orgId, displayName });
    const joined = yield* people.accept({ secret: invite.secret });
    return {
      personId: joined.person.personId,
      token: joined.accessToken,
      app: yield* sessions.verify(joined.accessToken),
    };
  });
  return {
    orgId,
    rhea: { personId: identity.owner.personId, app: ownerApp },
    zoya: yield* join("Zoya"),
    arjun: yield* join("Arjun"),
  };
});

export const admitted = Effect.fn("test.admitted")(function* (secret: string) {
  const holder = yield* TasksKeys.admit(secret);
  assert.isTrue(Option.isSome(holder), "the key is admitted");
  return Option.getOrThrow(holder);
});
