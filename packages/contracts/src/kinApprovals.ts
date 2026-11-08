import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  type AuthEnvironmentScope,
} from "./auth.ts";
import {
  AuthSessionId,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { KinAgentId, KinChatId, KinMessageId, KinOrgId, KinPersonId } from "./kinChat.ts";
import { CanonicalUtcTimestamp, KinLevel } from "./kinLead.ts";
import { PullRequestMergeMethod } from "./pullRequest.ts";

const pattern = (regex: RegExp, expected: string) =>
  Schema.String.check(Schema.makeFilter((value: string) => regex.test(value), { expected }));

export const Hex64 = pattern(/^[0-9a-f]{64}$/, "64 lowercase hex characters");
export type Hex64 = typeof Hex64.Type;
export const Sha40 = pattern(/^[0-9a-f]{40}$/, "a 40-character lowercase commit SHA");
export type Sha40 = typeof Sha40.Type;
export const RepoSlug = pattern(
  /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/,
  "an owner/name repository slug",
);
export type RepoSlug = typeof RepoSlug.Type;
// The approval key refuses to show anything outside this set (approvals spec section 5),
// so the server refuses it before a card exists.
const SHOWN_PATH = /^[A-Za-z0-9._/+-]{1,255}$/;
export const BranchName = pattern(SHOWN_PATH, "a branch name of letters, digits and . _ - / +");
export type BranchName = typeof BranchName.Type;
export const KinContentPath = pattern(SHOWN_PATH, "a path of letters, digits and . _ - / +");
export type KinContentPath = typeof KinContentPath.Type;
/** RFC 7638 SHA-256 thumbprint of a P-256 JWK, base64url without padding. */
export const KinKeyThumbprint = pattern(/^[A-Za-z0-9_-]{43}$/, "a base64url JWK thumbprint");
export type KinKeyThumbprint = typeof KinKeyThumbprint.Type;
// Ids the phone shows in a prompt take only the device's id characters (§5).
const shownId = Schema.makeFilter((value: string) => /^[A-Za-z0-9._-]+$/.test(value), {
  expected: "an id of letters, digits and . _ -",
});
const Base64UrlString = pattern(/^[A-Za-z0-9_-]+$/, "unpadded base64url");

export const KinActionId = TrimmedNonEmptyString.pipe(Schema.brand("KinActionId"));
export type KinActionId = typeof KinActionId.Type;
export const KinGrantId = TrimmedNonEmptyString.pipe(Schema.brand("KinGrantId"));
export type KinGrantId = typeof KinGrantId.Type;

export const KinActionClass = Schema.Literals(["read", "talk", "work", "privileged"]);
export type KinActionClass = typeof KinActionClass.Type;

export const KinActionKind = Schema.Literals([
  "merge_pull_request",
  "delete_branch",
  "set_level",
  "change_rules",
  "memory_purge",
  "register_approver_key",
  "deploy",
  "release",
  "spend",
  "use_secret",
  "set_delegation",
  "set_next_of_kin",
  "admit_outside_agent",
]);
export type KinActionKind = typeof KinActionKind.Type;

export const KinActionTarget = Schema.Union([
  Schema.TaggedStruct("pull_request", {
    host: Schema.Literal("github.com"),
    repo: RepoSlug,
    number: PositiveInt,
    mergeMethod: PullRequestMergeMethod,
    deleteBranchAfter: Schema.Boolean,
  }),
  Schema.TaggedStruct("branch", {
    host: Schema.Literal("github.com"),
    repo: RepoSlug,
    ref: BranchName,
  }),
  Schema.TaggedStruct("content", { path: KinContentPath, sha256: Hex64 }),
  Schema.TaggedStruct("level", {
    agentId: KinAgentId.check(shownId),
    chatId: Schema.optional(KinChatId.check(shownId)),
    level: KinLevel,
  }),
  // Only an attested hardware key can be activated, so a grant never targets any other (§4).
  Schema.TaggedStruct("device_key", {
    thumbprint: KinKeyThumbprint,
    hardware: Schema.Literals(["secure_enclave", "strongbox", "tee"]),
    attested: Schema.Literal(true),
  }),
]);
export type KinActionTarget = typeof KinActionTarget.Type;

/** The target each kind takes. Kinds missing here have no target yet and can't be requested. */
const KIN_ACTION_TARGET_TAG = {
  merge_pull_request: "pull_request",
  delete_branch: "branch",
  set_level: "level",
  change_rules: "content",
  memory_purge: "content",
  register_approver_key: "device_key",
} as const satisfies Partial<Record<KinActionKind, KinActionTarget["_tag"]>>;

export const KinCheckRun = Schema.Struct({
  name: TrimmedNonEmptyString,
  required: Schema.Boolean,
  status: Schema.Literals(["passed", "failed", "pending", "skipped"]),
});
export type KinCheckRun = typeof KinCheckRun.Type;

/** Facts the server read itself (GitHub, the memory repo). The agent never supplies them. */
export const KinResolvedTarget = Schema.Union([
  Schema.TaggedStruct("pull_request", {
    headSha: Sha40,
    base: BranchName,
    head: BranchName,
    title: Schema.String,
    additions: NonNegativeInt,
    deletions: NonNegativeInt,
    files: NonNegativeInt,
    checks: Schema.Array(KinCheckRun),
  }),
  Schema.TaggedStruct("branch", { headSha: Sha40 }),
  Schema.TaggedStruct("none", {}),
]);
export type KinResolvedTarget = typeof KinResolvedTarget.Type;

export const KinPendingActionState = Schema.Literals([
  "awaiting_approval",
  "approved",
  "executing",
  "succeeded",
  "failed",
  "interrupted",
  "rejected",
  "expired",
  "voided",
  "cancelled",
]);
export type KinPendingActionState = typeof KinPendingActionState.Type;

export const KinProvenanceRole = Schema.Literals(["owner", "member", "guest", "none"]);
export type KinProvenanceRole = typeof KinProvenanceRole.Type;
export const KinHumanRef = Schema.Struct({ humanId: KinPersonId });
export type KinHumanRef = typeof KinHumanRef.Type;

export const KinProvenance = Schema.Struct({
  startedBy: Schema.Union([KinHumanRef, Schema.Literal("schedule"), Schema.Literal("github")]),
  startedByRole: KinProvenanceRole,
  chain: Schema.Array(
    Schema.Struct({
      kind: TrimmedNonEmptyString,
      id: TrimmedNonEmptyString,
      authorRole: KinProvenanceRole,
    }),
  ),
  afterNonOwnerMessage: Schema.optional(
    Schema.Struct({ humanId: KinPersonId, messageId: KinMessageId }),
  ),
});
export type KinProvenance = typeof KinProvenance.Type;

// Phase 5 two-key approvals and phase 3 next of kin add members here, not a migration.
export const KinApproverRequirement = Schema.Struct({ role: Schema.Literal("owner") });
export type KinApproverRequirement = typeof KinApproverRequirement.Type;

export const KinPendingAction = Schema.Struct({
  id: KinActionId,
  orgId: KinOrgId,
  idempotencyKey: Hex64,
  kind: KinActionKind,
  target: KinActionTarget,
  resolved: KinResolvedTarget,
  targetDigest: Hex64,
  nonce: Base64UrlString,
  revision: NonNegativeInt,
  reason: Schema.String.check(Schema.isMaxLength(500)),
  requestedBy: Schema.Struct({ agentId: KinAgentId, threadId: ThreadId }),
  provenance: KinProvenance,
  requiredApprovers: Schema.Array(KinApproverRequirement),
  state: KinPendingActionState,
  stateReason: Schema.optional(Schema.String),
  createdAt: CanonicalUtcTimestamp,
  updatedAt: CanonicalUtcTimestamp,
  expiresAt: CanonicalUtcTimestamp,
});
export type KinPendingAction = typeof KinPendingAction.Type;

export const KinApproverPublicJwk = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: pattern(/^[A-Za-z0-9_-]{43}$/, "a base64url P-256 coordinate"),
  y: pattern(/^[A-Za-z0-9_-]{43}$/, "a base64url P-256 coordinate"),
});
export type KinApproverPublicJwk = typeof KinApproverPublicJwk.Type;

export const KinApproverKeyState = Schema.Literals(["pending", "active", "revoked"]);
export type KinApproverKeyState = typeof KinApproverKeyState.Type;
export const KinApproverKeyPlatform = Schema.Literals(["ios", "android"]);
export type KinApproverKeyPlatform = typeof KinApproverKeyPlatform.Type;
export const KinApproverKeyHardware = Schema.Literals([
  "secure_enclave",
  "strongbox",
  "tee",
  "software",
]);
export type KinApproverKeyHardware = typeof KinApproverKeyHardware.Type;

export const KinApproverKey = Schema.Struct({
  orgId: KinOrgId,
  thumbprint: KinKeyThumbprint,
  publicJwk: KinApproverPublicJwk,
  humanId: KinPersonId,
  deviceLabel: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  platform: KinApproverKeyPlatform,
  hardware: KinApproverKeyHardware,
  attested: Schema.Boolean,
  sessionId: Schema.optional(AuthSessionId),
  state: KinApproverKeyState,
  createdAt: CanonicalUtcTimestamp,
  confirmedAt: Schema.optional(CanonicalUtcTimestamp),
  revokedAt: Schema.optional(CanonicalUtcTimestamp),
});
export type KinApproverKey = typeof KinApproverKey.Type;

const KIN_GRANT_TYP = "kin-grant+jws";
export const KIN_GRANT_MAX_LIFETIME_SECONDS = 900;
export const KIN_GRANT_MAX_CLOCK_SKEW_SECONDS = 300;

export const KinGrantHeader = Schema.Struct({
  typ: Schema.Literal(KIN_GRANT_TYP),
  alg: Schema.Literal("ES256"),
  kid: KinKeyThumbprint,
});
export type KinGrantHeader = typeof KinGrantHeader.Type;

const SignedInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const KinGrantPayloadFields = {
  v: Schema.Literal(1),
  orgId: KinOrgId,
  actionId: KinActionId,
  revision: SignedInt,
  nonce: Base64UrlString,
  jti: Base64UrlString,
  kind: KinActionKind,
  targetDigest: Hex64,
  target: KinActionTarget,
  headSha: Schema.optional(Sha40),
  base: Schema.optional(BranchName),
  mergeMethod: Schema.optional(PullRequestMergeMethod),
  approver: Schema.Struct({ humanId: KinPersonId, kid: KinKeyThumbprint }),
  decision: Schema.Literal("approve"),
  iat: SignedInt,
  exp: SignedInt,
};

type GrantFacts = {
  readonly kind: KinActionKind;
  readonly target: KinActionTarget;
  readonly headSha?: string | undefined;
  readonly base?: string | undefined;
  readonly mergeMethod?: string | undefined;
};

/** Field presence per kind (approvals spec section 5), shared by the payload and the challenge. */
const grantFactsMatchKind = Schema.makeFilter(
  (grant: GrantFacts) => {
    const tag = (KIN_ACTION_TARGET_TAG as Partial<Record<KinActionKind, string>>)[grant.kind];
    if (tag === undefined) return `kind ${grant.kind} can't be granted yet`;
    if (grant.target._tag !== tag) return `kind ${grant.kind} needs a ${tag} target`;
    const pinsHead = grant.kind === "merge_pull_request" || grant.kind === "delete_branch";
    if (pinsHead !== (grant.headSha !== undefined)) return "headSha presence doesn't match kind";
    const isMerge = grant.kind === "merge_pull_request";
    if (isMerge !== (grant.base !== undefined)) return "base presence doesn't match kind";
    if (isMerge !== (grant.mergeMethod !== undefined))
      return "mergeMethod presence doesn't match kind";
    if (grant.target._tag === "pull_request" && grant.mergeMethod !== grant.target.mergeMethod)
      return "mergeMethod differs from the target";
    return true;
  },
  { expected: "grant fields that match its kind" },
);

// The iat/exp windows are checked by `verifyKinGrant` so they fail as `time_window`.
export const KinGrantPayload = Schema.Struct(KinGrantPayloadFields).check(grantFactsMatchKind);
export type KinGrantPayload = typeof KinGrantPayload.Type;

const { jti: _jti, iat: _iat, exp: _exp, ...unsignedFields } = KinGrantPayloadFields;
/** What `challenge` returns: the payload minus the fields the device adds (`jti`, `iat`, `exp`). */
export const KinGrantUnsignedPayload = Schema.Struct(unsignedFields).check(grantFactsMatchKind);
export type KinGrantUnsignedPayload = typeof KinGrantUnsignedPayload.Type;

export const KinGrantRejectionReason = Schema.Literals([
  "malformed",
  "unknown_key",
  "revoked_key",
  "bad_signature",
  "not_owner",
  "session_mismatch",
  "stale",
  "target_mismatch",
  "time_window",
  "head_moved",
  "replayed",
]);
export type KinGrantRejectionReason = typeof KinGrantRejectionReason.Type;

export const KinGrant = Schema.Struct({
  id: KinGrantId,
  orgId: KinOrgId,
  actionId: KinActionId,
  revision: NonNegativeInt,
  jti: Base64UrlString,
  approverHumanId: KinPersonId,
  keyThumbprint: KinKeyThumbprint,
  compact: Schema.String,
  iat: SignedInt,
  exp: SignedInt,
  acceptedAt: CanonicalUtcTimestamp,
  consumedAt: Schema.NullOr(CanonicalUtcTimestamp),
});
export type KinGrant = typeof KinGrant.Type;

export const KinAuditEvent = Schema.Literals([
  "action_requested",
  "action_refreshed",
  "grant_accepted",
  "grant_rejected",
  "action_rejected",
  "action_voided",
  "execution_started",
  "execution_finished",
  "execution_reconciled",
  "key_registered",
  "key_confirmed",
  "key_revoked",
  "credential_check_failed",
]);
export type KinAuditEvent = typeof KinAuditEvent.Type;

export const KinAuditEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  orgId: KinOrgId,
  seq: PositiveInt,
  at: CanonicalUtcTimestamp,
  event: KinAuditEvent,
  actionId: Schema.optional(KinActionId),
  kind: Schema.optional(KinActionKind),
  target: Schema.optional(KinActionTarget),
  headSha: Schema.optional(Sha40),
  grantJti: Schema.optional(Schema.String),
  keyThumbprint: Schema.optional(KinKeyThumbprint),
  deviceLabel: Schema.optional(Schema.String),
  sessionId: Schema.optional(AuthSessionId),
  provenance: Schema.optional(KinProvenance),
  result: Schema.optional(Schema.String),
  prevHash: Hex64,
  hash: Hex64,
});
export type KinAuditEntry = typeof KinAuditEntry.Type;

/** What `get` and `list` show. Non-owners get the redacted card and never a challenge. */
export const KinApprovalView = Schema.Union([
  Schema.TaggedStruct("full", {
    action: KinPendingAction,
    canApprove: Schema.Literal(true),
  }),
  Schema.TaggedStruct("redacted", {
    actionId: KinActionId,
    orgId: KinOrgId,
    kind: KinActionKind,
    repo: Schema.NullOr(RepoSlug),
    number: Schema.NullOr(PositiveInt),
    title: Schema.NullOr(Schema.String),
    state: KinPendingActionState,
    waitingOn: Schema.String,
    canApprove: Schema.Literal(false),
  }),
]);
export type KinApprovalView = typeof KinApprovalView.Type;

export const KinApprovalListEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", { actions: Schema.Array(KinApprovalView) }),
  Schema.TaggedStruct("action", { action: KinApprovalView }),
]);
export type KinApprovalListEvent = typeof KinApprovalListEvent.Type;

export const KinApprovalsListInput = Schema.Struct({ orgId: Schema.optional(KinOrgId) });
export type KinApprovalsListInput = typeof KinApprovalsListInput.Type;
export const KinApprovalsActionInput = Schema.Struct({ actionId: KinActionId });
export type KinApprovalsActionInput = typeof KinApprovalsActionInput.Type;
export const KinApprovalsChallengeResult = Schema.Struct({
  payload: KinGrantUnsignedPayload,
  resolved: KinResolvedTarget,
});
export type KinApprovalsChallengeResult = typeof KinApprovalsChallengeResult.Type;
export const KinApprovalsSubmitGrantInput = Schema.Struct({
  compact: Schema.String.check(Schema.isMaxLength(16_384)),
});
export type KinApprovalsSubmitGrantInput = typeof KinApprovalsSubmitGrantInput.Type;
export const KinApprovalsRejectInput = Schema.Struct({
  actionId: KinActionId,
  revision: NonNegativeInt,
});
export type KinApprovalsRejectInput = typeof KinApprovalsRejectInput.Type;
export const KinApprovalsDecisionResult = Schema.Struct({
  actionId: KinActionId,
  state: KinPendingActionState,
});
export type KinApprovalsDecisionResult = typeof KinApprovalsDecisionResult.Type;

export const KinApprovalsKeyChallengeInput = Schema.Struct({});
export type KinApprovalsKeyChallengeInput = typeof KinApprovalsKeyChallengeInput.Type;
export const KinApprovalsKeyChallengeResult = Schema.Struct({
  challenge: Base64UrlString,
  expiresAt: CanonicalUtcTimestamp,
});
export type KinApprovalsKeyChallengeResult = typeof KinApprovalsKeyChallengeResult.Type;
const Base64Blob = Schema.String.check(Schema.isMaxLength(16_384));
export const KinApproverKeyAttestation = Schema.Union([
  Schema.Struct({
    format: Schema.Literal("android-key"),
    /** Base64 DER certificates, leaf first. */
    certificateChain: Schema.Array(Base64Blob).check(Schema.isMaxLength(10)),
  }),
  Schema.Struct({
    format: Schema.Literal("apple-app-attest"),
    /** Base64 SHA-256 of the App Attest key's public key. */
    keyId: Base64Blob,
    /** Base64 CBOR from `DCAppAttestService.attestKey` over `sha256(challenge ‖ 0x04 ‖ x ‖ y)`. */
    attestationObject: Base64Blob,
  }),
]);
export type KinApproverKeyAttestation = typeof KinApproverKeyAttestation.Type;
export const KinApprovalsRegisterKeyInput = Schema.Struct({
  orgId: KinOrgId,
  publicJwk: KinApproverPublicJwk,
  platform: KinApproverKeyPlatform,
  challenge: Base64UrlString,
  // Without one the key is stored unattested and can never be activated. The server derives `hardware`.
  attestation: Schema.optional(KinApproverKeyAttestation),
  deviceLabel: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
});
export type KinApprovalsRegisterKeyInput = typeof KinApprovalsRegisterKeyInput.Type;
export const KinApprovalsRegisterKeyResult = Schema.Struct({
  key: KinApproverKey,
  code: pattern(/^\d{6}$/, "a 6-digit code"),
});
export type KinApprovalsRegisterKeyResult = typeof KinApprovalsRegisterKeyResult.Type;
export const KinApprovalsKeyInput = Schema.Struct({
  orgId: KinOrgId,
  thumbprint: KinKeyThumbprint,
});
export type KinApprovalsKeyInput = typeof KinApprovalsKeyInput.Type;
export const KinApprovalsConfirmKeyInput = Schema.Struct({
  ...KinApprovalsKeyInput.fields,
  code: pattern(/^\d{6}$/, "a 6-digit code"),
});
export type KinApprovalsConfirmKeyInput = typeof KinApprovalsConfirmKeyInput.Type;
export const KinApprovalsOrgInput = Schema.Struct({ orgId: KinOrgId });
export type KinApprovalsOrgInput = typeof KinApprovalsOrgInput.Type;
export const KinApprovalsListKeysResult = Schema.Struct({ keys: Schema.Array(KinApproverKey) });
export type KinApprovalsListKeysResult = typeof KinApprovalsListKeysResult.Type;

export const KinAuditListInput = Schema.Struct({
  orgId: KinOrgId,
  afterSeq: Schema.optional(NonNegativeInt),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(200)),
});
export type KinAuditListInput = typeof KinAuditListInput.Type;
export const KinAuditListResult = Schema.Struct({
  entries: Schema.Array(KinAuditEntry),
  hasMore: Schema.Boolean,
});
export type KinAuditListResult = typeof KinAuditListResult.Type;
export const KinAuditVerifyResult = Schema.Struct({
  ok: Schema.Boolean,
  checked: NonNegativeInt,
  firstBadSeq: Schema.NullOr(PositiveInt),
});
export type KinAuditVerifyResult = typeof KinAuditVerifyResult.Type;

export class KinApprovalError extends Schema.TaggedError<KinApprovalError>()("KinApprovalError", {
  reason: Schema.Union([
    KinGrantRejectionReason,
    Schema.Literals([
      "not_found",
      "unavailable",
      "invalid_state",
      "unsupported_kind",
      "not_a_lead",
      "bad_challenge",
      "bad_code",
      "not_local",
      "unattested",
    ]),
  ]),
  message: Schema.String,
}) {}

export const KIN_APPROVAL_WS_METHODS = {
  list: "kin.approvals.list",
  get: "kin.approvals.get",
  challenge: "kin.approvals.challenge",
  submitGrant: "kin.approvals.submitGrant",
  reject: "kin.approvals.reject",
  keyChallenge: "kin.approvals.keyChallenge",
  registerKey: "kin.approvals.registerKey",
  confirmKey: "kin.approvals.confirmKey",
  listKeys: "kin.approvals.listKeys",
  revokeKey: "kin.approvals.revokeKey",
  auditList: "kin.audit.list",
  auditVerify: "kin.audit.verify",
} as const;

const error = Schema.Union([KinApprovalError, EnvironmentAuthorizationError]);

export const KinApprovalRpcs = [
  Rpc.make(KIN_APPROVAL_WS_METHODS.list, {
    payload: KinApprovalsListInput,
    success: KinApprovalListEvent,
    error,
    stream: true,
  }),
  Rpc.make(KIN_APPROVAL_WS_METHODS.get, {
    payload: KinApprovalsActionInput,
    success: KinApprovalView,
    error,
  }),
  Rpc.make(KIN_APPROVAL_WS_METHODS.challenge, {
    payload: KinApprovalsActionInput,
    success: KinApprovalsChallengeResult,
    error,
  }),
  Rpc.make(KIN_APPROVAL_WS_METHODS.submitGrant, {
    payload: KinApprovalsSubmitGrantInput,
    success: KinApprovalsDecisionResult,
    error,
  }),
  Rpc.make(KIN_APPROVAL_WS_METHODS.reject, {
    payload: KinApprovalsRejectInput,
    success: KinApprovalsDecisionResult,
    error,
  }),
  Rpc.make(KIN_APPROVAL_WS_METHODS.keyChallenge, {
    payload: KinApprovalsKeyChallengeInput,
    success: KinApprovalsKeyChallengeResult,
    error,
  }),
  Rpc.make(KIN_APPROVAL_WS_METHODS.registerKey, {
    payload: KinApprovalsRegisterKeyInput,
    success: KinApprovalsRegisterKeyResult,
    error,
  }),
  Rpc.make(KIN_APPROVAL_WS_METHODS.confirmKey, {
    payload: KinApprovalsConfirmKeyInput,
    success: KinApproverKey,
    error,
  }),
  Rpc.make(KIN_APPROVAL_WS_METHODS.listKeys, {
    payload: KinApprovalsOrgInput,
    success: KinApprovalsListKeysResult,
    error,
  }),
  Rpc.make(KIN_APPROVAL_WS_METHODS.revokeKey, {
    payload: KinApprovalsKeyInput,
    success: KinApproverKey,
    error,
  }),
  Rpc.make(KIN_APPROVAL_WS_METHODS.auditList, {
    payload: KinAuditListInput,
    success: KinAuditListResult,
    error,
  }),
  Rpc.make(KIN_APPROVAL_WS_METHODS.auditVerify, {
    payload: KinApprovalsOrgInput,
    success: KinAuditVerifyResult,
    error,
  }),
] as const;

/** The outer gate only; person, key and signature checks are the real ones. */
export const KIN_APPROVAL_RPC_SCOPES = {
  [KIN_APPROVAL_WS_METHODS.list]: AuthOrchestrationReadScope,
  [KIN_APPROVAL_WS_METHODS.get]: AuthOrchestrationReadScope,
  [KIN_APPROVAL_WS_METHODS.challenge]: AuthOrchestrationOperateScope,
  [KIN_APPROVAL_WS_METHODS.submitGrant]: AuthOrchestrationOperateScope,
  [KIN_APPROVAL_WS_METHODS.reject]: AuthOrchestrationOperateScope,
  [KIN_APPROVAL_WS_METHODS.keyChallenge]: AuthAccessWriteScope,
  [KIN_APPROVAL_WS_METHODS.registerKey]: AuthAccessWriteScope,
  [KIN_APPROVAL_WS_METHODS.confirmKey]: AuthAccessWriteScope,
  [KIN_APPROVAL_WS_METHODS.listKeys]: AuthAccessWriteScope,
  [KIN_APPROVAL_WS_METHODS.revokeKey]: AuthAccessWriteScope,
  [KIN_APPROVAL_WS_METHODS.auditList]: AuthAccessWriteScope,
  [KIN_APPROVAL_WS_METHODS.auditVerify]: AuthAccessWriteScope,
} as const satisfies Record<
  (typeof KIN_APPROVAL_WS_METHODS)[keyof typeof KIN_APPROVAL_WS_METHODS],
  AuthEnvironmentScope
>;
