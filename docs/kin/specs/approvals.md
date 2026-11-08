# Spec: approvals, grants and the action executor

Owner of: `KinPendingAction`, `request_action`, `KinGrant`, `KinApproverKey`, the action executor, `KinAuditEntry`, the GitHub App and branch rulesets.
Covers DESIGN.md section 9.1–9.7 and 10 (phase 1), 9.6 and 9.9 (phase 3), 9.8 (phase 5), and section 12 code gap 4 (actions that run twice).

## Goal

An agent can only propose a privileged action. Code carries it out only after a valid, owner-signed grant bound to that exact action, at most once. Nothing typed in a chat, drawn by an agent, or sent by a member's client can become the owner's approval. GitHub's own rules still block a merge if every part of Kin is compromised.

## What exists in T3

| Piece                   | Path                                                                                                                                                                                                                                   | What it gives us                                                                                                                                                                                                            | What it doesn't                                                                                                                                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DPoP proof verification | `packages/shared/src/dpop.ts` (`verifyDpopProof`, `computeDpopJwkThumbprint`), `apps/server/src/auth/dpop.ts` (`verifyRequestDpopProof`)                                                                                               | ES256 over P-256 with `@noble/curves`, RFC 7638-style thumbprint, ±300 s clock window (`DPOP_MAX_CLOCK_SKEW_SECONDS`), replay markers keyed by `thumbprint:jti` via `ServerSecretStore.create` (fails if the marker exists) | Binds a key to an HTTP request, not to an action. The key comes from the proof header itself.                                                                                                                                                                                              |
| Session binding         | `apps/server/src/auth/SessionStore.ts` (`SessionClaims.jkt`), `EnvironmentAuth.ts` (rejects a DPoP-bound token without a matching proof)                                                                                               | A session can be bound to one device key                                                                                                                                                                                    | Sessions carry `scopes`, not a person or a role. `sub` is a label such as `"browser"`.                                                                                                                                                                                                     |
| RPC scopes              | `apps/server/src/auth/RpcAuthorization.ts` (`RPC_REQUIRED_SCOPES` `satisfies Record<WsRpcMethod, AuthEnvironmentScope>`), scopes in `packages/contracts/src/auth.ts`                                                                   | Every WS RPC must declare a scope, or typecheck fails                                                                                                                                                                       | Scopes are per device session, not per person. No role concept.                                                                                                                                                                                                                            |
| Session list and revoke | `apps/server/src/auth/http.ts` (`revokeClient`, `revokeOtherClients`, need `access:write`)                                                                                                                                             | The owner can revoke device sessions                                                                                                                                                                                        | Nothing about signing keys.                                                                                                                                                                                                                                                                |
| Mobile device key       | `apps/mobile/src/features/cloud/dpop.ts` (`loadOrCreateDpopProofKeyPair`)                                                                                                                                                              | A P-256 key for the managed relay                                                                                                                                                                                           | **Software key.** Generated in JS with `@noble/curves`, private JWK stored with `expo-secure-store` under `t3code.cloud.dpop-proof-key`, no biometric gate, used only for the managed relay.                                                                                               |
| Secret files            | `apps/server/src/auth/ServerSecretStore.ts` (`get`, `set`, `create`, `getOrCreateRandom`, `remove`)                                                                                                                                    | Atomic create-if-absent                                                                                                                                                                                                     | Files under `secretsDir`, not the OS keychain.                                                                                                                                                                                                                                             |
| OS keychain             | `@napi-rs/keyring` ^1.3.0, already in `apps/server/package.json`; used by `packages/provider-cursor/src/server/CursorKeychain.ts` (`AsyncEntry`)                                                                                       | Read and write OS keychain items from the server                                                                                                                                                                            | —                                                                                                                                                                                                                                                                                          |
| GitHub merge            | `packages/source-control-github/src/server/GitHubPullRequestApi.ts` (`runAction` → GraphQL `MergePullRequest`), reached through `PullRequestService.runAction` with `PullRequestActionInput` (`packages/contracts/src/pullRequest.ts`) | Merge with method `merge`/`squash`/`rebase`                                                                                                                                                                                 | **Doesn't pin the head.** `expectedHeadOid` is sent only when the merge body is rewritten. Merge-queue repos switch to auto-merge. The credential is whatever `GitHubRequestPolicy.credential` picks: a Settings token, T3's own GitHub App sign-in (user-to-server), `GH_TOKEN`, or `gh`. |
| Agent tools             | `apps/server/src/mcp/McpHttpServer.ts` (`layerTools`, `toolkitRegistration`), `McpInvocationContext.ts` (`McpThreadCaller`, `McpClientCaller`)                                                                                         | MCP tools for threads, with the calling thread id                                                                                                                                                                           | `layerTools` is advertised to every thread, and `AgentContextBudget.test.ts` measures it.                                                                                                                                                                                                  |
| Persistence             | `apps/server/src/persistence/Migrations.ts` (Effect `Migrator.fromRecord`, table `effect_sql_migrations`, numbered files up to `080_`)                                                                                                 | SQLite with migrations                                                                                                                                                                                                      | Upstream numbering; Kin can't add numbered files without merge conflicts.                                                                                                                                                                                                                  |
| Canonical JSON          | `packages/shared/src/relaySigning.ts` (`stableStringify`, code-unit key order)                                                                                                                                                         | Stable bytes to sign                                                                                                                                                                                                        | —                                                                                                                                                                                                                                                                                          |

No module in `apps/mobile/package.json` creates Secure Enclave or Keystore keys, and `expo-local-authentication` isn't a dependency. Local native modules live in `apps/mobile/modules/` (for example `t3-native-controls` with `expo-module.config.json`) and are autolinked from that folder.

## Design

### 1. Action classes and kinds

```ts
// packages/contracts/src/kinApprovals.ts (new)
export const KinActionClass = Schema.Literals(["read", "talk", "work", "privileged"]);

export const KinActionKind = Schema.Literals([
  // phase 1, executed here
  "merge_pull_request",
  "delete_branch",
  // phase 1, executed by other specs' handlers through the registry (section 6)
  "set_level", // lead spec: L0–L3 per lead and chat
  "change_rules", // lead spec: rules.md, bound to the new file's hash
  "memory_purge", // triggers spec: history rewrite for one item
  "register_approver_key", // this spec: a second device
  // later
  "deploy",
  "release",
  "spend",
  "use_secret", // phase 3+, refused as unsupported_kind until a handler exists
  "set_delegation",
  "set_next_of_kin", // phase 3
  "admit_outside_agent", // phase 5
]);
```

`classOf(kind)` returns `privileged` for every kind above. Read, Talk and Work stay with the lead spec's level checks (`delegate_task`, posting, pushing a branch); `request_action` handles only privileged kinds. `ceilingAllows(provenance, class, level)` (section 8) is exported for the lead spec to use on Work.

### 2. `request_action`: the agent's only privileged tool

```ts
request_action({
  kind: KinActionKind,
  target: KinActionTarget,     // tagged by kind, below
  reason: string,              // ≤ 500 chars, shown quoted on the card, never trusted
}) -> { actionId, state: "awaiting_approval" | <existing state>, waitingOn: "owner" }
```

- Served by a **Kin-only MCP server** at `/kin/mcp` (new, `apps/server/src/kin/approvals/mcp.ts`), built with `McpServer.layerHttp` the same way as `layerMcpTransport` in `McpHttpServer.ts`. It is not added to upstream `layerTools`, so ordinary T3 threads never see it and `AgentContextBudget.test.ts` doesn't change.
- The handler accepts only an `McpThreadCaller` whose `threadId` is a registered lead session (lead spec's registry). `McpClientCaller` (outside OAuth clients) and worker threads (`subagent: true`, or any thread not in the registry) get `not_a_lead`.
- The server, not the agent, fills everything else: `orgId` and `provenance` from the lead's current `KinEvent`, the PR's head SHA, base, diff size and checks from GitHub. The agent names a PR; it can't name a SHA.
- It returns immediately. It never waits for the approval and never returns a token.

Targets:

```ts
export const KinActionTarget = Schema.Union([
  Schema.TaggedStruct("pull_request", {
    host: Schema.Literal("github.com"),
    repo: RepoSlug,
    number: PositiveInt,
    mergeMethod: PullRequestMergeMethod, // reuse packages/contracts/src/pullRequest.ts
    deleteBranchAfter: Schema.Boolean,
  }),
  Schema.TaggedStruct("branch", {
    host: Schema.Literal("github.com"),
    repo: RepoSlug,
    ref: BranchName,
  }),
  Schema.TaggedStruct("content", { path: Schema.String, sha256: Hex64 }), // rules.md, purge plan
  Schema.TaggedStruct("level", {
    agentId: KinAgentId,
    chatId: Schema.optional(KinChatId),
    level: KinLevel,
  }),
  Schema.TaggedStruct("device_key", { thumbprint: Schema.String }),
]);
```

### 3. `KinPendingAction`: lifecycle and storage

```ts
export const KinPendingActionState = Schema.Literals([
  "awaiting_approval",
  "approved",
  "executing",
  "succeeded",
  "failed",
  "interrupted", // terminal after execution
  "rejected",
  "expired",
  "voided",
  "cancelled", // terminal without execution
]);

export const KinPendingAction = Schema.Struct({
  id: KinActionId, // "act_" + 26-char ULID
  orgId: KinOrgId,
  idempotencyKey: Hex64, // section 7
  kind: KinActionKind,
  target: KinActionTarget,
  resolved: KinResolvedTarget, // server-read facts: headSha, base, title, additions, deletions, files, checks
  targetDigest: Hex64, // sha256(stableStringify({kind, target, resolved.headSha, resolved.base}))
  nonce: Schema.String, // 32 random bytes, base64url; rotated when `resolved` changes
  revision: Schema.Int, // bumps with each nonce rotation
  reason: Schema.String, // agent text, rendered as a quote
  requestedBy: Schema.Struct({ agentId: KinAgentId, threadId: ThreadId }),
  provenance: KinProvenance, // section 8
  requiredApprovers: Schema.Array(KinApproverRequirement), // phase 1: [{ role: "owner" }]
  state: KinPendingActionState,
  stateReason: Schema.optional(Schema.String),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc, // createdAt + 7 days while awaiting approval
});
```

`requiredApprovers` is a list from day one so that phase 5's two-key approvals (9.8) and phase 3's next of kin (9.9) add entries instead of a migration.

Transitions (every one is a compare-and-set `UPDATE … WHERE id = ? AND state = ? AND revision = ?`; zero rows changed means someone else won and the caller stops):

| From                | To                                          | When                                                                                 |
| ------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------ |
| —                   | `awaiting_approval`                         | `request_action` inserts; card posted                                                |
| `awaiting_approval` | `awaiting_approval` (revision+1, new nonce) | PR head, base or checks change (webhook from triggers spec, or re-read at card open) |
| `awaiting_approval` | `approved`                                  | A grant passes every check in section 5; grant row inserted in the same transaction  |
| `awaiting_approval` | `rejected` / `cancelled` / `expired`        | Owner taps Reject; lead withdraws; `expiresAt` passes                                |
| `approved`          | `executing`                                 | Executor claims it (single claim, section 6)                                         |
| `approved`          | `voided`                                    | Grant expires before claim, head moved, signing key revoked, stop switch on          |
| `executing`         | `succeeded` / `failed`                      | GitHub answers                                                                       |
| `executing`         | `succeeded` / `interrupted`                 | Restart finds it mid-flight; reconciliation decides (section 6)                      |

Storage (new, SQLite, Kin's own migration set in `apps/server/src/kin/persistence/migrations.ts` with its own `Migrator` table `kin_sql_migrations`; owned with the chat spec so all Kin tables share one runner):

- `kin_pending_actions` — columns as above; `UNIQUE(org_id, idempotency_key)`; index `(org_id, state)`.
- `kin_grants` — `id`, `org_id`, `action_id`, `revision`, `jti` **UNIQUE**, `approver_human_id`, `key_thumbprint`, `compact` (the signed token), `iat`, `exp`, `accepted_at`, `consumed_at`; `UNIQUE(action_id, approver_human_id)`.
- `kin_executions` — `action_id` **PRIMARY KEY**, `grant_id`, `started_at`, `finished_at`, `outcome`, `github_request_id`, `merge_commit_sha`, `error`. Inserting this row is the claim; a second insert fails.
- `kin_approver_keys` — section 4.
- `kin_audit` — section 9.

### 4. Approver keys: what T3 has and what Kin adds

**T3 today:** device sessions are bearer or DPoP-bound tokens with scopes. The mobile DPoP key is a software key in `expo-secure-store`, used for the managed relay only, without a biometric prompt. Nothing ties a key to a person or a role. That is fine for connecting; it isn't enough to approve a merge.

**Kin adds a separate approval key per device.** It never signs connections, only grants.

|             | iOS                                                                                                                                                                                                                  | Android                                                                                                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key         | P-256 in the Secure Enclave: `SecKeyCreateRandomKey` with `kSecAttrTokenIDSecureEnclave`, not exportable                                                                                                             | EC `secp256r1` in `AndroidKeyStore`, `PURPOSE_SIGN`, `DIGEST_SHA256`, `setIsStrongBoxBacked(true)` with fallback to TEE                                                                                                   |
| Gate        | `SecAccessControlCreateWithFlags(… kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet])`: every signature needs Face ID or Touch ID; the key dies if biometrics are re-enrolled | `setUserAuthenticationRequired(true)`, `setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG)` (per-use), `setInvalidatedByBiometricEnrollment(true)`; sign inside `BiometricPrompt` with a `CryptoObject(Signature)` |
| Signature   | `SecKeyCreateSignature(.ecdsaSignatureMessageX962SHA256)` → DER; convert to 64-byte `r‖s`                                                                                                                            | `SHA256withECDSA` → DER; convert the same way                                                                                                                                                                             |
| Attestation | Not in phase 1 (App Attest is a later option)                                                                                                                                                                        | Record the `setAttestationChallenge` certificate chain; verify the root is Google's hardware root; store `attested: true/false`                                                                                           |

**Modules.** None of this exists in the repo's dependencies.

- **Recommended: a new local Expo module** `apps/mobile/modules/kin-approval-key` (Swift + Kotlin, autolinked from `modules/`). API: `createKey(attestationChallenge): {publicJwk, hardware, attestation?}`, `sign(signingInput): base64url`, `hasKey()`, `deleteKey()`. `signingInput` is the grant's JWS signing input (section 5). The module signs nothing else: natively, it refuses anything that isn't a well-formed `KinGrant` and writes the approval text from the payload, so no caller chooses what the user is shown. The Kotlin side needs `androidx.biometric:biometric` (**new dependency**, Google, declared in the module's own `android/build.gradle`).
- Not enough on their own: `expo-local-authentication` (**new**, Expo) only shows a prompt and doesn't bind a key; `expo-secure-store` (already installed, `~58.0.2`) with `requireAuthentication: true` gates a stored secret, but the key is still generated in JS and its bytes enter JS memory. Use the latter only as a stopgap behind a `softwareKey: true` flag that the card shows and the audit records.
- Considered and not used: `react-native-biometrics` (**new**, third party) makes RSA keys and isn't Secure Enclave-backed on iOS.
- iOS needs `NSFaceIDUsageDescription`. Add it with a Kin config plugin `apps/mobile/plugins/withKinApprovalKey.cjs` (new), listed with one line in `apps/mobile/app.config.ts`.

```ts
export const KinApproverKey = Schema.Struct({
  orgId: KinOrgId,
  thumbprint: Schema.String, // computeDpopJwkThumbprint(publicJwk)
  publicJwk: DpopPublicJwk, // packages/shared/src/dpopCommon.ts
  humanId: KinPersonId, // chat spec's KinAuthor human id
  deviceLabel: Schema.String,
  platform: Schema.Literals(["ios", "android"]),
  hardware: Schema.Literals(["secure_enclave", "strongbox", "tee", "software"]),
  attested: Schema.Boolean,
  sessionId: Schema.optional(AuthSessionId), // the T3 session that registered it
  state: Schema.Literals(["pending", "active", "revoked"]),
  createdAt: Schema.DateTimeUtc,
  confirmedAt: Schema.optional(Schema.DateTimeUtc),
  revokedAt: Schema.optional(Schema.DateTimeUtc),
});
```

Registration:

1. The phone calls `kin.approvals.keyChallenge()` (`access:write`), which returns a single-use 32-byte nonce bound to that session and valid for 5 minutes. It passes the nonce to `createKey`, then calls `kin.approvals.registerKey({publicJwk, platform, challenge, attestation?, deviceLabel})` over the same session. The server consumes the nonce, stores the key as `pending` and returns a 6-digit code derived from `sha256(thumbprint ‖ serverNonce)`.
   - **Android:** `attestation.certificateChain` is required. The server checks it offline: the chain verifies up to a Google hardware attestation root and no certificate is on Google's attestation revocation list; the leaf's public key equals `publicJwk`; the leaf's KeyDescription has `attestationChallenge` equal to the nonce, `attestationSecurityLevel` and `keyMintSecurityLevel` (`keymasterSecurityLevel` before KeyMint) of `TrustedEnvironment` or `StrongBox`, and in `hardwareEnforced`: purpose `SIGN`, algorithm EC on P-256, digest SHA-256, `userAuthType` biometric only (`FINGERPRINT`, the value Keystore uses for every strong biometric), no `authTimeout`, no `noAuthRequired`, `origin` `GENERATED`, and `rootOfTrust` with `verifiedBootState` `Verified` and `deviceLocked` true; `attestationApplicationId` names the release package with a signing-certificate SHA-256 on the server's allowlist. All pass: `attested: true`, and `hardware` is `strongbox` or `tee` from the attestation security level. Any check fails: `attested: false`, `hardware: "software"`. The client never supplies `hardware`.
   - **iOS:** no attestation in phase 1, so the key is stored with `attested: false` and `hardware: "secure_enclave"`, which is claimed by the platform, not proven.
2. **First key in an org:** confirmed on the Mac running the server, in the desktop app's local session (loopback only), where the owner checks the code shown on both screens. No remote path can confirm the first key.
3. **Later keys:** confirmed by a grant of kind `register_approver_key` signed by an existing active key.
4. Revoking (`kin.approvals.revokeKey`, from settings or the desktop) sets `revoked` and voids every `approved` action whose grant that key signed. Revoking a T3 device session (`revokeClient`) also revokes keys registered from it.

A key's role isn't stored on the key. It is read at verify time from org membership (chat spec), so demoting a person takes effect at once.

### 5. `KinGrant`: format and checks

The grant is a compact JWS: `b64url(header).b64url(payload).b64url(sig)`, ES256, with header bytes = `stableStringify(header)` and payload bytes = `stableStringify(payload)` (`packages/shared/src/relaySigning.ts`), and `b64url` unpadded. The signing input is the ASCII string `b64url(header).b64url(payload)`. The header has exactly the three fields below; `target` is encoded with its `_tag`. `headSha` is present for `merge_pull_request` and `delete_branch` and absent otherwise; `base` and `mergeMethod` are present for `merge_pull_request` only, and `mergeMethod` equals `target.mergeMethod`.

```ts
export const KinGrantHeader = Schema.Struct({
  typ: Schema.Literal("kin-grant+jws"),
  alg: Schema.Literal("ES256"),
  kid: Schema.String, // key thumbprint; any `jwk` field is rejected
});

export const KinGrantPayload = Schema.Struct({
  v: Schema.Literal(1),
  orgId: KinOrgId,
  actionId: KinActionId,
  revision: Schema.Int,
  nonce: Schema.String, // the pending action's current nonce
  jti: Schema.String, // 16+ random bytes from the device
  kind: KinActionKind,
  targetDigest: Hex64,
  // human-readable copy of what the card showed; must equal the server's record
  target: KinActionTarget,
  headSha: Schema.optional(Sha40), // required for merge_pull_request and delete_branch
  base: Schema.optional(BranchName),
  mergeMethod: Schema.optional(PullRequestMergeMethod),
  approver: Schema.Struct({ humanId: KinPersonId, kid: Schema.String }),
  decision: Schema.Literal("approve"),
  iat: Schema.Int, // device clock, seconds
  exp: Schema.Int, // iat + 900 at most
});
```

**The card is drawn from the payload it signs.** `kin.approvals.challenge(actionId)` returns the unsigned payload (minus `jti`, `iat`, `exp`, which the device adds). The app parses it and renders repo, PR, SHA, base, method, diff size and checks from those fields and `resolved`, then signs the same bytes. There is no second copy of the facts that could drift from what is signed.

**The device checks what it signs.** The approval key module parses the signing input natively before it asks for a biometric, and refuses it unless: both parts are canonical `stableStringify` JSON (no whitespace, sorted keys, so no duplicate keys); the header has exactly `alg: "ES256"`, `typ: "kin-grant+jws"` and a `kid`; the payload has only the fields above, with `v: 1`, `decision: "approve"`, a `kind` the module has a prompt for, the matching `target` tag, `approver.kid` equal to the header `kid` byte for byte, `exp − iat ≤ 900` and `|deviceNow − iat| ≤ 300`. The prompt text comes from fixed per-kind templates in the module, such as `Merge GLDRoger/t3code #212 (a1b2c3d4e5f60718) into "main" by squashing`, with the first 16 characters of every hash. Shown values are refused, never cleaned, unless they are ASCII from a per-field allowlist (branches and paths: letters, digits, `. _ - / +`; lead and chat ids: letters, digits, `. _ -`), and a prompt over 200 characters is refused rather than cut. A kind with no template can't be signed until the module adds one. The server's checks below still apply in full.

`kin.approvals.submitGrant({compact})` checks, in this order, and stops at the first failure with a typed reason:

1. Decode header and payload; `alg`, `typ`, no `jwk`; each part's bytes equal `stableStringify(JSON.parse(bytes))` → `malformed`.
2. `kid` is an `active` key in `payload.orgId`, and `payload.approver.kid` equals it → `unknown_key` / `revoked_key`.
3. Signature verifies with `p256.verify(sig, sha256(signingInput), key, {prehash: false, format: "compact", lowS: true})` → `bad_signature`. Unlike `verifyDpopProof`, `lowS: true` is required: the device always sends low-S, and ECDSA's `(r, n − s)` twin of a signature would otherwise also verify. Never identify or deduplicate a grant by its compact string; `jti` is its identity, and `compact` is kept for audit only.
4. `approver.humanId` equals the key's `humanId`, and that person currently meets a `requiredApprovers` entry (phase 1: holds the owner role in the org) → `not_owner`.
5. The RPC caller's session is the session the key was registered from, or another session of the same person → `session_mismatch`. (Defence in depth; the signature is the real check.)
6. Pending action exists in the org, is `awaiting_approval`, and `revision` and `nonce` match → `stale` (the card refreshes).
7. `kind`, `target`, `targetDigest`, `headSha`, `base`, `mergeMethod` equal the server's record → `target_mismatch`.
8. `|now − iat| ≤ 300` and `exp − iat ≤ 900` → `time_window`.
9. Re-read the PR from GitHub with the bot token; head and base still match → `head_moved` (rotate nonce, refresh card).
10. In one transaction: insert `kin_grants` (`jti` UNIQUE, `(action_id, approver)` UNIQUE) and CAS the action to `approved` → `replayed` on conflict.

The grant's life ends at `min(exp, acceptedAt + 15 min)`. It is consumed when the executor claims the action, and can't be used for anything else: the binding is to `actionId`, `nonce` and `targetDigest`, all server-chosen.

A rejection doesn't need a signature (rejecting is always safe) but is still recorded with the session that sent it.

### 6. The action executor

`apps/server/src/kin/approvals/ActionExecutor.ts` (new). One fiber per org, one action at a time per repo.

```ts
interface KinActionHandler<K extends KinActionKind> {
  readonly kind: K;
  readonly precheck: (a: KinPendingAction) => Effect<void, KinExecError>; // re-read live state
  readonly run: (a: KinPendingAction, g: KinGrant) => Effect<KinOutcome, KinExecError>;
  readonly reconcile: (
    a: KinPendingAction,
  ) => Effect<"done" | "not_done" | "unknown", KinExecError>;
}
```

Handlers register through `KinActionHandlers` (a Context service). This spec ships `merge_pull_request`, `delete_branch` and `register_approver_key`; the lead spec registers `set_level` and `change_rules`; the triggers spec registers `memory_purge`. Kinds with no handler fail `unsupported_kind` at `request_action`, before any card is shown.

Run order for an `approved` action:

1. Stop switch (lead spec) off; org not paused → else stay `approved` until the grant lapses, then `voided`.
2. Grant still alive, key still active, approver still owner.
3. **Claim:** `INSERT INTO kin_executions(action_id, …)` and CAS `approved → executing` in one transaction. A failed insert means it already ran or is running: refuse.
4. `precheck` with the bot token: PR open, `head.sha == grant.headSha`, `base.ref == grant.base`, method allowed by the repo, not a merge-queue repo (phase 1 refuses merge queues: `merge_queue_unsupported`).
5. `run` with the owner's merge credential: `PUT /repos/{owner}/{repo}/pulls/{n}/merge` with `{sha: grant.headSha, merge_method}`. The `sha` field makes GitHub refuse with 409 if the head moved after step 4. The executor calls REST directly through a small client in `apps/server/src/kin/github/OwnerMergeClient.ts`, **not** `PullRequestService.runAction`, because that path doesn't pin the head and picks its own credential.
6. Record outcome, audit entry, and post the result to the chat (task card update).

**Crash in the middle.** On startup the executor scans `executing` rows. For each it calls `reconcile`: for a merge, `GET /pulls/{n}`; `merged == true` and `merge_commit_sha` present → `succeeded`; still open → `interrupted`; GitHub unreachable → retry with backoff, state unchanged. `interrupted` is terminal: the grant is spent, and the owner gets a card "The merge didn't finish. Approve again?" that creates a new pending action. One grant, one attempt, always.

**Owner's merge credential.** A fine-grained personal access token from the owner, limited to the Kin repos, with **Contents: Read and write** and **Metadata: Read** only. GitHub's permission table puts `PUT /pulls/{n}/merge` and `DELETE /git/refs/{ref}` under Contents: write, and `POST /pulls/{n}/reviews` under Pull requests: write, so this token **can merge and delete branches but can't approve a PR**. It lives in the OS keychain via `@napi-rs/keyring` (`AsyncEntry("kin-owner-merge", "<orgId>")`), is read per execution, and is never logged, put in an environment variable, or passed to a child process. Expiry is set to 90 days; a card warns 7 days before.

### 7. Idempotency (gap 4)

- `idempotencyKey = sha256(stableStringify({orgId, kind, target, source}))` where `source` is the lead's triggering event id (`KinEvent.id`, lead spec): a webhook delivery id, a deferral id plus its due time, or a chat message id.
- A second `request_action` with the same key returns the existing action instead of creating one: a replayed webhook, a deferral that fires twice, or a lead that retries after a timeout all land on the same row.
- A new commit on the PR doesn't change the key. It rotates the nonce on the same action.
- Execution: the `kin_executions` primary key makes a second run impossible, whatever restarts or duplicate fibers do.
- Grants: `jti` UNIQUE and one grant per approver per action.

### 8. Provenance ceiling

```ts
export const KinProvenance = Schema.Struct({
  startedBy: Schema.Union([KinHumanRef, Schema.Literal("schedule"), Schema.Literal("github")]),
  startedByRole: Schema.Literals(["owner", "member", "guest", "none"]),
  chain: Schema.Array(
    Schema.Struct({ kind: Schema.String, id: Schema.String, authorRole: Schema.String }),
  ),
  afterNonOwnerMessage: Schema.optional(
    Schema.Struct({ humanId: KinPersonId, messageId: KinMessageId }),
  ),
});
```

- The lead spec computes it from the `KinEvent` and passes it down to workers; the ceiling is the lowest role in the chain. Webhook content (PR bodies, comments) counts as `none`.
- **Work** runs only if the ceiling and the chat's level allow it (`ceilingAllows`).
- **Privileged** is proposed under any ceiling but runs only with the owner's grant, which is the owner's own authority for that one action. When `startedByRole != "owner"` or `afterNonOwnerMessage` is set, the card shows "Asked for after Priya's message" above the buttons.
- `change_rules`, `set_level`, `register_approver_key`, and (later) `set_delegation` and `set_next_of_kin` are refused at `request_action` unless `startedByRole == "owner"`. A member can't even get those cards in front of the owner.

### 9. Approval cards

- The chat message carries a `KinWidget` (chat spec) of type `approval` with **only** `{actionId}`. An agent can't supply title, buttons or text for it; the chat service rejects agent-authored `approval` widgets with any other field.
- Apps render the card natively from `kin.approvals.get(actionId)`. The server projects per viewer:
  - **Owner:** full facts, `canApprove: true`, shown in **Waiting on you** and the direct chat.
  - **Anyone else:** `{repo, number, title, state, waitingOn: "Nishchay"}`, `canApprove: false`, no challenge. `kin.approvals.challenge` and `submitGrant` refuse non-owners with `not_owner` anyway.
- The card shows repo, PR number and title, head SHA (first 16, full on tap), base ← head, method, `+additions −deletions` and file count, required checks with status, the agent's reason as a quote, and the provenance warning.
- Approve: the approval key module shows the grant's own text, written natively from the signed payload (section 5): `Merge GLDRoger/t3code #212 (a1b2c3d4e5f60718) into "main" by squashing` → biometric → sign → submit. Android shows it in the `BiometricPrompt`. Face ID mostly ignores the prompt's reason text, so on Face ID iPhones the module first shows it in a native confirmation sheet, in its own window above the app's; Approve refuses to sign (`E_OBSCURED`) unless that window is key and nothing covers it. Touch ID shows it in the system prompt. Notification and lock-screen actions open the app to this card; nothing is signed in the background, and the module signs one grant at a time.
- Desktop and web show the card read-only with "Approve on your phone" in phase 1.

### 10. GitHub: the bot App, the owner's review, rulesets

**Kin GitHub App** (new, created with the manifest flow by `scripts/kin-github-app.ts`), installed on selected repos only.

| Permission                                                            | Level          | Why                                                                                                                  |
| --------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------- |
| Metadata                                                              | Read           | Required                                                                                                             |
| Contents                                                              | Read and write | Push worker branches (rulesets protect `main`)                                                                       |
| Pull requests                                                         | Read and write | Open draft PRs, comment, read reviews                                                                                |
| Issues                                                                | Read and write | Comment on and link issues                                                                                           |
| Checks                                                                | Read           | Show checks on cards                                                                                                 |
| Commit statuses                                                       | Read           | Same                                                                                                                 |
| Actions                                                               | Read           | CI run state                                                                                                         |
| Workflows                                                             | **None**       | GitHub then rejects pushes that change `.github/workflows`, so a worker can't add a workflow that reads repo secrets |
| Administration, Secrets, Environments, Deployments, Members, Webhooks | **None**       |                                                                                                                      |

Webhook events (consumed by the triggers spec): `pull_request`, `pull_request_review`, `check_suite`, `check_run`, `status`, `issue_comment`, `push`. The App's private key is in the OS keychain (`AsyncEntry("kin-github-app", "<appId>")`). Installation tokens last one hour; each worker gets one minted with `POST /app/installations/{id}/access_tokens` narrowed by `repositories` and `permissions` (workers touching untrusted input get `contents: read` only).

**The owner's GitHub review comes from the phone.** The ruleset needs a code-owner approval that the server can't produce, since the merge token above can't review. When the owner taps Approve, the phone, after the same biometric prompt, calls `POST /repos/{o}/{r}/pulls/{n}/reviews` with `{event: "APPROVE", commit_id: headSha}` directly to GitHub, using a user-to-server token for the Kin App held only on the phone (`expo-secure-store` with `requireAuthentication: true`, obtained once by device flow). Then it submits the grant. The server never sees this token. If the phone has no token, the card offers "Approve on GitHub" and waits for the `pull_request_review` webhook before enabling the Kin approval.

**Ruleset on each Kin repo** (`scripts/kin-rulesets.ts` applies it with `POST /repos/{o}/{r}/rulesets` and checks for drift):

```json
{
  "name": "kin-main",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "require_code_owner_review": true,
        "dismiss_stale_reviews_on_push": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [{ "context": "<per repo>" }]
      }
    }
  ]
}
```

- `bypass_actors` is empty, including repository admins. Otherwise the owner's merge token could skip review.
- `.github/CODEOWNERS` contains `* @GLDRoger`, so the bot's approval never counts, and a PR that changes CODEOWNERS needs the owner's review too.
- A tag ruleset `kin-release` restricts `v*` tag creation and deletion, with no bypass, for when releases arrive.

### 11. Audit

```ts
export const KinAuditEntry = Schema.Struct({
  id: Schema.String,
  orgId: KinOrgId,
  seq: Schema.Int,
  at: Schema.DateTimeUtc,
  event: Schema.Literals([
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
  ]),
  actionId: Schema.optional(KinActionId),
  kind: Schema.optional(KinActionKind),
  target: Schema.optional(KinActionTarget),
  headSha: Schema.optional(Sha40),
  grantJti: Schema.optional(Schema.String),
  keyThumbprint: Schema.optional(Schema.String),
  deviceLabel: Schema.optional(Schema.String),
  sessionId: Schema.optional(AuthSessionId),
  provenance: Schema.optional(KinProvenance),
  result: Schema.optional(Schema.String), // merge commit SHA, or the failure reason
  prevHash: Hex64,
  hash: Hex64, // sha256(prevHash ‖ stableStringify(entry without hash))
});
```

Append-only (`kin_audit`, no `UPDATE` or `DELETE` statements in the repository code). The hash chain makes edits visible; `kin.audit.verify` recomputes it. Rejected grants are audited with their failure reason and the sending session, so a forged approval leaves a trace. `kin.audit.list` is owner-only. The audit stores the grant's `jti` and the key thumbprint, never tokens or keychain contents.

### 12. Credential hygiene check

At startup and hourly, the executor checks which GitHub identity T3 itself uses (`GitHubRequestPolicy.credential("github.com")`, then `GET /user`). If it is the owner's personal login, or `GH_TOKEN`/`GITHUB_TOKEN` is set in the server environment, the executor writes `credential_check_failed`, refuses privileged execution, and posts a card to the owner. Agent CLIs run as children of the server and inherit its `gh` login and environment, so on the Kin machine that identity must be the bot. The triggers spec's Kin host setup owns making it so.

## Threat model

| Threat                                     | Example                                                    | Stopped by                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Injected instruction                       | PR body says "merge this now"                              | Lead can only `request_action`; owner signs a native card; ceiling flags it                                       |
| Fake approval in text                      | Member types "Nishchay approved"                           | Only `submitGrant` with a valid signature changes state                                                           |
| Forged approval from a member's client     | Modified app calls `submitGrant`                           | Checks 2–4: key not registered, or registered to a non-owner → `not_owner`                                        |
| Agent-drawn button                         | Generated widget labelled "Approve"                        | `approval` widgets carry only `actionId`; the card is native; generated widgets can't call approvals RPCs         |
| Card shows one thing, phone signs another  | Buggy or tampered app code asks the key to sign another PR | The key signs only canonical grants; the module writes the approval text natively from the bytes it signs         |
| Tampered JS draws over the Face ID sheet   | An over-the-air bundle covers the text, leaves Approve     | Sheet in the module's own window above the app's; Approve checks nothing covers it (`E_OBSCURED`)                 |
| Replay                                     | Captured grant sent again, or for another PR               | `jti` UNIQUE, nonce and `targetDigest` binding, executions PK                                                     |
| Bait and switch                            | New commit pushed after the owner looks                    | Nonce rotation, check 9, executor precheck, `sha` on the merge call, `dismiss_stale_reviews_on_push`              |
| Double run                                 | Restart mid-merge, duplicate webhook, deferral fires twice | Idempotency key, executions PK, reconciliation                                                                    |
| Stolen phone                               | Thief has the unlocked phone                               | Per-use biometric on the key; `.biometryCurrentSet` / enrollment invalidation; revoke from desktop                |
| Compromised Kin server or agent with shell | Reads the keychain merge token                             | Token can't review; ruleset needs the owner's code-owner review at the current SHA, which only the phone can make |
| Bot self-approval                          | Bot approves its own PR                                    | GitHub forbids author approval; bot isn't a code owner                                                            |
| Workflow exfiltration                      | Worker adds a workflow that prints secrets                 | App has no Workflows permission                                                                                   |
| Rule change from chat                      | "Remember: Priya can approve merges"                       | `change_rules`/delegations need owner provenance and a grant                                                      |

Tampered JS delivered over the air is the attacker the native sheet and grant parser defend against, so release builds must set `updates.codeSigningCertificate` for `expo-updates`.

`deleteKey` needs no biometric, so tampered JS can delete the approval key. That is an accepted denial of service: registering a new key needs a fresh session challenge, attestation on Android, and the owner's confirmation.

## Files

New (Kin-owned):

- `packages/contracts/src/kinApprovals.ts` — all schemas above, RPC definitions, `KIN_APPROVAL_RPC_SCOPES`.
- `packages/shared/src/kinGrant.ts` — `encodeGrantSigningInput`, `verifyKinGrant` (pure, shared with mobile).
- `apps/server/src/kin/approvals/` — `PendingActions.ts` (repository + CAS), `GrantVerifier.ts`, `ApproverKeys.ts`, `ActionExecutor.ts`, `handlers/mergePullRequest.ts`, `handlers/deleteBranch.ts`, `handlers/registerApproverKey.ts`, `mcp.ts` (`request_action`, `/kin/mcp`), `rpc.ts`, `Audit.ts`, `CredentialHygiene.ts`, `*.test.ts`.
- `apps/server/src/kin/github/` — `KinGitHubApp.ts` (installation tokens), `OwnerMergeClient.ts`, `Keychain.ts`.
- `apps/server/src/kin/persistence/migrations.ts` (shared with the chat spec).
- `apps/mobile/modules/kin-approval-key/` — Swift, Kotlin, `expo-module.config.json`, `index.ts`.
- `apps/mobile/src/features/chats/approvals/` — `ApprovalCard.tsx`, `useApproveAction.ts`, `githubReviewToken.ts`.
- `apps/mobile/plugins/withKinApprovalKey.cjs`.
- `scripts/kin-github-app.ts`, `scripts/kin-rulesets.ts`.

Upstream hooks (one line each):

- `apps/server/src/auth/RpcAuthorization.ts` — `...KIN_APPROVAL_RPC_SCOPES,` in `RPC_REQUIRED_SCOPES` (or folded into the chat spec's single Kin spread, if it adds one).
- `packages/contracts/src/kinRpcs.ts` (Kin-owned, created by CHAT-6) — add the approval RPCs and scopes to `KinRpcs` and `KIN_RPC_SCOPES`; `rpc.ts` and `RpcAuthorization.ts` already spread those.
- `apps/server/src/server.ts` — Kin layer already added by the chat spec; approvals layers join `apps/server/src/kin/layer.ts`, not upstream.
- HTTP route for `/kin/mcp` — the same router hook the chat spec uses for Kin routes.
- `apps/mobile/app.config.ts` — `"./plugins/withKinApprovalKey.cjs",` in `plugins`.

RPCs and scopes: `kin.approvals.list` (stream) and `get` → `orchestration:read`; `challenge`, `submitGrant`, `reject` → `orchestration:operate`; `keyChallenge`, `registerKey`, `confirmKey`, `listKeys`, `revokeKey`, `kin.audit.list`, `kin.audit.verify` → `access:write`. Scopes are only the outer gate; the person and signature checks above are the real ones.

## Interfaces to other specs

- **Chat:** `KinOrgId`, `KinPersonId` (human `KinAuthor`), `KinChatMember` roles (owner lookup), `KinWidget` type `approval {actionId}` with the agent-field rejection, posting result messages, **Waiting on you** items. Chat spec owns the Kin migration runner and the Kin RPC/route hooks.
- **Lead:** registry of lead threads (for `request_action`), `KinEvent.id` (idempotency) and provenance, the stop switch (executor checks it), levels (`set_level` handler, `ceilingAllows`), `change_rules` handler.
- **Triggers:** `pull_request` synchronize/closed webhooks → `refreshAction(actionId)`; `pull_request_review` → enables a card waiting on a GitHub review; `memory_purge` handler; Kin host setup (bot `gh` login, keychain items, hygiene check passing); upstream contract test for `GitHubRequestPolicy.credential` and `verifyDpopProof`.
- **Mobile:** renders `ApprovalCard` inside the chat screens; this spec ships the card, the native module and the signing hook.

## Security tests (named, all in `apps/server/src/kin/approvals/*.test.ts` unless noted)

1. `a member's client sends a forged approval and the server rejects it` — member session with the member's own active key signs a correct payload → `not_owner`, state unchanged, `grant_rejected` audited.
2. `a grant signed by an unregistered key is rejected` → `unknown_key`.
3. `a grant whose header carries a jwk is rejected` → `malformed`.
4. `a grant signed by a revoked key is rejected, and revoking voids approved actions it signed`.
5. `an owner grant replayed a second time is rejected` → `replayed`.
6. `an owner grant for PR 212 can't approve PR 213` → `target_mismatch` / `stale`.
7. `a grant for the old nonce fails after a new commit` → `stale`; card revision bumps.
8. `a grant older than 15 minutes is voided before execution`.
9. `a grant with exp more than 900 s after iat is rejected`.
10. `the head moving between approval and merge stops the merge` — precheck fails; and with precheck stubbed, GitHub's 409 from the `sha` field is mapped to `failed: head_moved`.
11. `two executors racing on one action run it once` — concurrent claims, one `kin_executions` row.
12. `a restart mid-merge reconciles to succeeded when GitHub shows it merged`, and `… to interrupted when it is still open`, with no second merge call.
13. `a replayed webhook and a deferral firing twice create one pending action`.
14. `request_action from a worker thread or an outside MCP client is refused` → `not_a_lead`.
15. `an agent-authored approval widget with extra fields is rejected by the chat service` (chat spec test, listed here).
16. `non-owners get the redacted card and no challenge`.
17. `change_rules requested under member provenance is refused at request_action`.
18. `privileged execution is refused while the credential hygiene check fails`.
19. `the merge token is never written to logs, audit, env or child processes` — grep the captured logs and spawned env in an integration test.
20. `the audit chain detects an edited row` (`kin.audit.verify`).
21. `the first approver key can't be confirmed from a remote session`.
22. Mobile (`apps/mobile/modules/kin-approval-key`, device test): `signing without biometrics fails`, `re-enrolling biometrics invalidates the key`, `DER signatures convert to compact and verify on the server`, `only one signature at a time, under the grant's own text`, `an overlay over the sheet can't approve`. The module's README has the checklist; its grant parser's vectors run without a device.
23. GitHub (`scripts/kin-rulesets.ts --check`, run against a scratch repo): `the owner merge token can't submit a review` (expect 403), `the bot can't merge to main` and `a merge without a code-owner review is blocked`.

Acceptance for phase 1: on `GLDRoger/t3code`, the lead requests a merge of a bot PR; the owner approves on the phone with Face ID; the GitHub review lands from the phone; the executor merges with the pinned SHA; the audit lists grant, device, SHA, provenance and merge commit. Tests 1–21 pass in CI; 22–23 pass on the release checklist.

## Tasks

**APPR-1 Contracts.** All schemas, RPC definitions and scope map in `packages/contracts/src/kinApprovals.ts`; `packages/shared/src/kinGrant.ts` with signing input and pure verification. Files: those two plus tests. Depends on: CHAT-1 (org, human and widget ids). Done when: `vp run typecheck` passes and `kinGrant.test.ts` verifies a grant signed with a `node:crypto` P-256 key and rejects tampered payloads. Owner: backend.

**APPR-2 Storage and state machine.** Tables, Kin migrations, `PendingActions.ts` with CAS transitions, idempotency key, nonce rotation, expiry sweep. Depends on: APPR-1, CHAT-2. Done when: transition tests (including 11 and 13) pass. Owner: backend.

**APPR-3 `request_action` tool.** `/kin/mcp` server, lead-only gate, server-side resolution of the PR, provenance capture, owner-only kinds. Depends on: APPR-2, LEAD-1, LEAD-5. Done when: tests 14 and 17 pass and a lead thread sees exactly one Kin tool. Owner: backend.

**APPR-4 Grant verification.** `GrantVerifier.ts` implementing checks 1–10, `challenge`, `submitGrant`, `reject` RPCs, audit on every rejection. Depends on: APPR-2, APPR-5. Done when: tests 1–9 pass. Owner: backend.

**APPR-5 Approver keys.** Registry, `registerKey`/`confirmKey`/`listKeys`/`revokeKey`, desktop loopback confirmation with matching code, revoke-on-session-revoke, `register_approver_key` handler. Depends on: APPR-1, APPR-2. Done when: tests 4 and 21 pass. Owner: backend.

**APPR-6 Native approval key module.** `apps/mobile/modules/kin-approval-key` for iOS (Secure Enclave, `.biometryCurrentSet`) and Android (Keystore, StrongBox fallback, `BiometricPrompt`, attestation chain); DER-to-compact; config plugin for `NSFaceIDUsageDescription`. Depends on: nothing. Done when: device tests in 22 pass on one iPhone and one Pixel, and a signature verifies with `p256.verify`. Owner: UI (native).

**APPR-7 Approval card and phone flow.** `approvePendingAction` (challenge, biometric sign and submit; the card itself is MOB-8), GitHub review from the phone with the device-flow token, "Approve on GitHub" fallback. Depends on: APPR-4, APPR-6, MOB-4. Done when: on a device, approving a test PR posts a GitHub review at the head SHA and moves the action to `approved`; a member account sees "Waiting on Nishchay" with no button (test 16 on the server). Owner: UI.

**APPR-8 GitHub App and credentials.** `scripts/kin-github-app.ts` (manifest with the permission table), `KinGitHubApp.ts` (installation tokens, narrowing), `Keychain.ts`, owner merge token setup and expiry warning, `CredentialHygiene.ts`. Depends on: APPR-1. Done when: test 18 passes and `scripts/kin-github-app.ts --check` prints the App's permissions matching the table. Owner: backend.

**APPR-9 Executor.** `ActionExecutor.ts`, handler registry, `merge_pull_request` and `delete_branch` handlers via `OwnerMergeClient.ts` (REST with `sha`), stop-switch check, startup reconciliation, result posting. Depends on: APPR-4, APPR-8, LEAD-11. Done when: tests 10–12 and 19 pass against a recorded GitHub fake, and one real merge on a scratch repo succeeds. Owner: backend.

**APPR-10 Audit.** `Audit.ts` with hash chain, `kin.audit.list`/`verify`, entries from every step above. Depends on: APPR-2. Done when: test 20 passes and the acceptance merge shows a complete trail. Owner: backend.

**APPR-11 Rulesets and CODEOWNERS.** `scripts/kin-rulesets.ts` apply and `--check` drift mode, tag ruleset, CODEOWNERS check. Depends on: APPR-8. Done when: test 23 passes on a scratch repo and `--check` reports no drift on `GLDRoger/t3code`. Owner: backend.

Later, marked by phase:

**APPR-12 (phase 3) Delegations (9.6).** `set_delegation` kind and handler; `KinDelegation {orgId, grantee, kinds, scope: {repo, paths?, labels?}, expiresAt, signedBy}`; a matching delegation lets the grantee's own signed grant meet `requiredApprovers`; list and one-tap revoke. Depends on: APPR-4, APPR-9. Done when: a delegated docs merge by a member succeeds, an out-of-scope one fails `not_owner`, and revoked delegations stop working at once. Owner: backend.

**APPR-13 (phase 3) L3 risk gate (10).** Path and label classifier (`auth`, `security`, migrations, `.github/**` are never low-risk) used by delegations and L3. Depends on: APPR-12, LEAD-8. Done when: a fixture list of PRs classifies as expected. Owner: backend.

**APPR-14 (phase 3) Next of kin (9.9).** `set_next_of_kin` (owner-signed, max two, can't name self), escalation timer (2 h default or owner away) with a 30-minute warning, undo-only default scope (revert merge, roll back deploy, pause routines), any owner answer cancels, return summary in the owner's direct chat. Next of kin must also be a GitHub code owner. Depends on: APPR-12, TRIG-3. Done when: a simulated outage hands a revert to the next of kin after the wait, and an owner tap during the wait cancels it. Owner: backend.

**APPR-15 (phase 5) Two-key approvals for outside agents (9.8).** `admit_outside_agent` with a signed manifest; `requiredApprovers` = credential owner and resource owner; cards show "Waiting on Priya, then Nishchay"; an agent key can never be an approver key. Depends on: APPR-12, chat spec's outside-agent membership. Done when: a merge from an outside agent needs both grants and fails with either one alone. Owner: backend.

## Design corrections

1. **T3's device key is not hardware-backed or biometric-gated.** DESIGN 9.2 says the grant is signed by "a DPoP-style key in the Secure Enclave or Keystore". The existing mobile DPoP key (`apps/mobile/src/features/cloud/dpop.ts`) is a software key in `expo-secure-store`, used only for the managed relay. Kin needs a new, separate approval key and a new native module (APPR-6).
2. **T3 sessions have no person or role.** `SessionClaims` carry scopes and a label `sub`. "The signer has the owner role" has to come from Kin's membership (chat spec), with keys bound to a person.
3. **T3's merge path doesn't pin the head SHA.** `GitHubPullRequestApi.runAction` sends `expectedHeadOid` only when it rewrites the merge body, and switches to auto-merge on merge-queue repos. The executor must call `PUT /pulls/{n}/merge` with `sha` itself and refuse merge queues in phase 1.
4. **Agents can reach whatever GitHub login the server has.** Provider CLIs run as the server's user and inherit its `gh` login and `GH_TOKEN`. "Agents never hold the owner's GitHub token" only holds if the Kin machine's `gh` identity is the bot (hygiene check, section 12).
5. **"The owner's real approval on GitHub" needs a source.** DESIGN 9.5 requires a code-owner review but doesn't say who submits it. If the server held a token able to review, a compromised server could approve and merge. This spec splits it: the server's token can merge but not review (Contents: write only); the review comes from the phone, or from the owner on GitHub.
6. **Ruleset bypass must be empty, even for the owner.** Otherwise the owner's merge token bypasses review. The cost: PRs the owner writes by hand need someone else's review or a temporary bypass (open question 2).
7. **`request_action` can't go in upstream `layerTools`.** That list is advertised to every thread and measured by `AgentContextBudget.test.ts`. It gets a Kin-only MCP endpoint.

## Open questions

1. The phone needs a GitHub user token for the Kin App (device flow, once). Is that acceptable, or should phase 1 start with "Approve on GitHub" only and add the phone token later?
2. Owner-written PRs under an empty bypass list: route them through the bot, or add a time-boxed bypass toggled by an owner-signed action?
3. Merge-queue repos: support `enablePullRequestAutoMerge` with `expectedHeadOid` later, or keep refusing?
4. Should the executor run as a separate OS user with its own keychain, so code running as the Kin server's user can't read the merge token at all? Phase 1 relies on the token being unable to review.
5. Desktop approvals: a Touch ID-gated Secure Enclave key on macOS through a native addon, or phone-only for good?
