import { KinApprovalError, KinApprovalRpcs, type KinOrgId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as RpcGroup from "effect/rpc/RpcGroup";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as Audit from "./Audit.ts";

const group = RpcGroup.make(...KinApprovalRpcs);
// Every method refuses until its task lands (APPR-3, -4, -5); nothing here can approve.
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
  // Passed in rather than read from `KinServer`, whose service union reaches the judge.
  kin: Option.Option<Context.Context<KinIdentity>>,
) {
  const audit = yield* Audit.make;
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
    "kin.approvals.get": () => unavailable,
    "kin.approvals.challenge": () => unavailable,
    "kin.approvals.submitGrant": () => unavailable,
    "kin.approvals.reject": () => unavailable,
    "kin.approvals.keyChallenge": () => unavailable,
    "kin.approvals.registerKey": () => unavailable,
    "kin.approvals.confirmKey": () => unavailable,
    "kin.approvals.listKeys": () => unavailable,
    "kin.approvals.revokeKey": () => unavailable,
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
