import { KinApprovalError, KinApprovalRpcs } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as RpcGroup from "effect/rpc/RpcGroup";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";

const group = RpcGroup.make(...KinApprovalRpcs);
// Every method refuses until its task lands (APPR-3, -4, -5, -10); nothing here can approve.
const unavailable = Effect.fail(
  new KinApprovalError({ reason: "unavailable", message: "Kin approvals are unavailable." }),
);

export const makeKinApprovalHandlers = (_session: AuthenticatedSession) =>
  Effect.sync(() =>
    group.of({
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
      "kin.audit.list": () => unavailable,
      "kin.audit.verify": () => unavailable,
    }),
  );
