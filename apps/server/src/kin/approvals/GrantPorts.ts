import {
  KinApprovalError,
  KinPersonId,
  type KinActionKind,
  type KinActionTarget,
  type KinOrgId,
  type KinResolvedTarget,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { KinAudit, type KinAuditAppendInput } from "./Audit.ts";

/** The verifier's rejection trace: the refusal is already decided, so a lost entry is only logged. */
export class KinGrantAudit extends Context.Service<
  KinGrantAudit,
  { readonly append: (input: KinAuditAppendInput) => Effect.Effect<void> }
>()("t3/kin/approvals/GrantPorts/KinGrantAudit") {}

export const auditLayer = Layer.effect(
  KinGrantAudit,
  Effect.gen(function* () {
    const audit = yield* KinAudit;
    return KinGrantAudit.of({
      append: Effect.fn("KinGrantAudit.append")(function* (entry) {
        yield* audit
          .append(entry)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning(`Kin audit: ${entry.event} not written`, error),
            ),
          );
      }),
    });
  }),
);

/** Grant check 4's role lookup: never from the grant or the client, only stored identity. */
export class KinOrgRoles extends Context.Service<
  KinOrgRoles,
  {
    readonly isOwner: (ref: {
      readonly orgId: KinOrgId;
      readonly personId: KinPersonId;
    }) => Effect.Effect<boolean, KinApprovalError>;
  }
>()("t3/kin/approvals/GrantPorts/KinOrgRoles") {}

// Phase 1 (chat spec, Identity): the org owner is the reserved person bootstrap creates.
// Phase 2 replaces this with org membership.
export const BOOTSTRAP_OWNER = Schema.decodeSync(KinPersonId)("kin-default-owner");

export const orgRolesLayer = Layer.effect(
  KinOrgRoles,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return KinOrgRoles.of({
      isOwner: Effect.fn("KinOrgRoles.isOwner")(
        function* (ref) {
          if (ref.personId !== BOOTSTRAP_OWNER) return false;
          const rows = yield* sql`SELECT 1 FROM kin_people
            WHERE org_id = ${ref.orgId} AND person_id = ${ref.personId}`;
          return rows.length > 0;
        },
        Effect.catch((cause) =>
          Effect.logWarning(
            "KinOrgRoles.isOwner failed",
            toPersistenceSqlError("KinOrgRoles.isOwner")(cause),
          ).pipe(
            Effect.andThen(
              Effect.fail(
                new KinApprovalError({ reason: "unavailable", message: "Org roles unavailable." }),
              ),
            ),
          ),
        ),
      ),
    });
  }),
);

/** Grant check 9: the server's own read of the PR or branch, with the bot's credential. */
export class KinLiveTargets extends Context.Service<
  KinLiveTargets,
  {
    readonly resolve: (input: {
      readonly kind: KinActionKind;
      readonly target: KinActionTarget;
    }) => Effect.Effect<KinResolvedTarget, KinApprovalError>;
  }
>()("t3/kin/approvals/GrantPorts/KinLiveTargets") {}

// Fails closed until APPR-8's installation tokens back it: no live read, no approval.
export const liveTargetsUnconfiguredLayer = Layer.succeed(
  KinLiveTargets,
  KinLiveTargets.of({
    resolve: Effect.fn("KinLiveTargets.resolve")(function* () {
      return yield* new KinApprovalError({
        reason: "unavailable",
        message: "Kin can't read GitHub yet, so it can't approve this.",
      });
    }),
  }),
);
