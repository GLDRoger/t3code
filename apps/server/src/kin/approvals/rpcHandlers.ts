import { KinApprovalError, KinApprovalRpcs, type KinOrgId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as RpcGroup from "effect/rpc/RpcGroup";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { ApproverKeys, type KinKeyCaller } from "./ApproverKeys.ts";
import * as Audit from "./Audit.ts";
import { GrantVerifier } from "./GrantVerifier.ts";

const group = RpcGroup.make(...KinApprovalRpcs);
// `list` refuses until its task lands. Approving only goes through GrantVerifier.
const unavailable = Effect.fail(
  new KinApprovalError({ reason: "unavailable", message: "Kin approvals are unavailable." }),
);
const disabled = new KinApprovalError({
  reason: "disabled",
  message: "Kin is not running on this host.",
});
const failed = () =>
  new KinApprovalError({ reason: "unavailable", message: "Kin audit is unavailable." });

export const makeKinApprovalHandlers = Effect.fn("makeKinApprovalHandlers")(function* (
  session: AuthenticatedSession,
  kin: Option.Option<Context.Context<KinIdentity | ApproverKeys | GrantVerifier>>,
) {
  const audit = yield* Audit.make;
  const keys = Effect.gen(function* () {
    if (Option.isNone(kin)) return yield* disabled;
    const services = kin.value;
    const people = yield* Context.get(services, KinIdentity).resolve(session);
    const caller: KinKeyCaller = { session, people };
    return {
      keys: Context.get(services, ApproverKeys),
      grants: Context.get(services, GrantVerifier),
      caller,
    };
  });
  // Owner-only (spec section 11): membership in the org is not enough.
  const asOwner = Effect.fn("KinApprovals.asOwner")(function* (orgId: KinOrgId) {
    if (Option.isNone(kin)) return yield* disabled;
    const identity = Context.get(kin.value, KinIdentity);
    const people = yield* identity.resolve(session);
    const { owner } = identity;
    const isOwner = people.some(
      (person) => person.orgId === owner.orgId && person.personId === owner.personId,
    );
    if (owner.orgId !== orgId || !isOwner) {
      return yield* new KinApprovalError({ reason: "not_owner", message: "Owner only." });
    }
    return audit;
  });
  return group.of({
    "kin.approvals.list": () => Stream.fromEffect(unavailable),
    "kin.approvals.get": (input) =>
      keys.pipe(Effect.flatMap(({ grants, caller }) => grants.view(caller, input))),
    "kin.approvals.challenge": (input) =>
      keys.pipe(Effect.flatMap(({ grants, caller }) => grants.challenge(caller, input))),
    "kin.approvals.submitGrant": (input) =>
      keys.pipe(Effect.flatMap(({ grants, caller }) => grants.submitGrant(caller, input))),
    "kin.approvals.reject": (input) =>
      keys.pipe(Effect.flatMap(({ grants, caller }) => grants.reject(caller, input))),
    "kin.approvals.keyChallenge": () =>
      keys.pipe(Effect.flatMap(({ keys, caller }) => keys.keyChallenge(caller))),
    "kin.approvals.registerKey": (input) =>
      keys.pipe(Effect.flatMap(({ keys, caller }) => keys.registerKey(caller, input))),
    "kin.approvals.listKeys": (input) =>
      keys.pipe(Effect.flatMap(({ keys, caller }) => keys.listKeys(caller, input))),
    "kin.approvals.revokeKey": (input) =>
      keys.pipe(Effect.flatMap(({ keys, caller }) => keys.revokeKey(caller, input))),
    "kin.audit.list": (input) =>
      asOwner(input.orgId).pipe(
        Effect.flatMap((owner) => owner.list(input).pipe(Effect.mapError(failed))),
      ),
    "kin.audit.verify": (input) =>
      asOwner(input.orgId).pipe(
        Effect.flatMap((owner) => owner.verify(input).pipe(Effect.mapError(failed))),
      ),
  });
});
