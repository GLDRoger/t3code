# Spec: approvals, grants and the action executor

Owner of: `KinPendingAction`, `KinGrant`, `KinApproverKey`, the action executor and `KinAuditEntry`.
Covers DESIGN.md section 9.1–9.7 and 10 (phase 1), 9.6 and 9.9 (phase 3), 9.8 (phase 5), and section 12 code gap 4 (actions that run twice).

## Goal

An agent can only propose a privileged action. Code carries it out only after a valid, owner-signed grant bound to that exact action, at most once. Nothing typed in a chat, drawn by an agent, or sent by a member's client can become the owner's approval.

Kin doesn't merge code. Agents work on GitHub with the owner's own `gh` login from an owner-only turn's shell (lead spec); when a PR is approved and green, the lead tells the owner, and he merges it himself.

## What exists in T3

| Piece                   | Path                                                                                                                                                                 | What it gives us                                                                                                                                                                                                            | What it doesn't                                                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DPoP proof verification | `packages/shared/src/dpop.ts` (`verifyDpopProof`, `computeDpopJwkThumbprint`), `apps/server/src/auth/dpop.ts` (`verifyRequestDpopProof`)                             | ES256 over P-256 with `@noble/curves`, RFC 7638-style thumbprint, ±300 s clock window (`DPOP_MAX_CLOCK_SKEW_SECONDS`), replay markers keyed by `thumbprint:jti` via `ServerSecretStore.create` (fails if the marker exists) | Binds a key to an HTTP request, not to an action. The key comes from the proof header itself.                                                                                                |
| Session binding         | `apps/server/src/auth/SessionStore.ts` (`SessionClaims.jkt`), `EnvironmentAuth.ts` (rejects a DPoP-bound token without a matching proof)                             | A session can be bound to one device key                                                                                                                                                                                    | Sessions carry `scopes`, not a person or a role. `sub` is a label such as `"browser"`.                                                                                                       |
| RPC scopes              | `apps/server/src/auth/RpcAuthorization.ts` (`RPC_REQUIRED_SCOPES` `satisfies Record<WsRpcMethod, AuthEnvironmentScope>`), scopes in `packages/contracts/src/auth.ts` | Every WS RPC must declare a scope, or typecheck fails                                                                                                                                                                       | Scopes are per device session, not per person. No role concept.                                                                                                                              |
| Session list and revoke | `apps/server/src/auth/http.ts` (`revokeClient`, `revokeOtherClients`, need `access:write`)                                                                           | The owner can revoke device sessions                                                                                                                                                                                        | Nothing about signing keys.                                                                                                                                                                  |
| Mobile device key       | `apps/mobile/src/features/cloud/dpop.ts` (`loadOrCreateDpopProofKeyPair`)                                                                                            | A P-256 key for the managed relay                                                                                                                                                                                           | **Software key.** Generated in JS with `@noble/curves`, private JWK stored with `expo-secure-store` under `t3code.cloud.dpop-proof-key`, no biometric gate, used only for the managed relay. |
| Secret files            | `apps/server/src/auth/ServerSecretStore.ts` (`get`, `set`, `create`, `getOrCreateRandom`, `remove`)                                                                  | Atomic create-if-absent                                                                                                                                                                                                     | Files under `secretsDir`, not the OS keychain.                                                                                                                                               |
| OS keychain             | `@napi-rs/keyring` ^1.3.0, in `apps/server/package.json`; the desktop's `ChromiumKeys.ts` loads it lazily (`AsyncEntry`). Kin doesn't use it                         | Read and write OS keychain items from the server                                                                                                                                                                            | —                                                                                                                                                                                            |
| Agent tools             | `apps/server/src/mcp/McpHttpServer.ts` (`layerTools`, `toolkitRegistration`), `McpInvocationContext.ts` (`McpThreadCaller`, `McpClientCaller`)                       | MCP tools for threads, with the calling thread id                                                                                                                                                                           | `layerTools` is advertised to every thread, and `AgentContextBudget.test.ts` measures it.                                                                                                    |
| Persistence             | `apps/server/src/persistence/Migrations.ts` (Effect `Migrator.fromRecord`, table `effect_sql_migrations`, numbered files up to `080_`)                               | SQLite with migrations                                                                                                                                                                                                      | Upstream numbering; Kin can't add numbered files without merge conflicts.                                                                                                                    |
| Canonical JSON          | `packages/shared/src/relaySigning.ts` (`stableStringify`, code-unit key order)                                                                                       | Stable bytes to sign                                                                                                                                                                                                        | —                                                                                                                                                                                            |

No module in `apps/mobile/package.json` creates Secure Enclave or Keystore keys, and `expo-local-authentication` isn't a dependency. Local native modules live in `apps/mobile/modules/` (for example `t3-native-controls` with `expo-module.config.json`) and are autolinked from that folder.

## Design

### 1. Action classes and kinds

```ts
// packages/contracts/src/kinApprovals.ts (new)
export const KinActionClass = Schema.Literals(["read", "talk", "work", "privileged"]);

export const KinActionKind = Schema.Literals([
  // retired with the owner's merge token: no handler, so an approved one is voided
  "merge_pull_request",
  "delete_branch",
  // executed through the registry (section 6); only set_level has a handler today
  "set_level", // lead spec: what a lead may do, per lead and chat
  "change_rules", // lead spec: rules.md, bound to the new file's hash
  "memory_purge", // triggers spec: history rewrite for one item
  "register_approver_key", // replaced by registerKey (section 4); voided if approved
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

`classOf(kind)` returns `privileged` for every kind above. Read, Talk and Work stay with the lead spec's level checks (`delegate_task`, posting, pushing a branch). `ceilingAllows(provenance, class, level)` (section 8) is exported for the lead spec to use on Work.

### 2. Who can ask

No agent tool creates a pending action. The only requester is the owner, through owner-only RPCs: `kin.levels.raise` creates `set_level` under the reserved requester `kin-promotion`, and `KinPendingActions.create` refuses `set_level` from any other requester. The server fills the target's facts itself; the client names the lead, chat and level, never a digest or nonce.

An agent that needs something only the owner can do says so in chat or asks with `kin_ask`. Its answer is a tap, never an approval.

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
  Schema.TaggedStruct("device_key", {
    thumbprint: Schema.String,
    hardware: Schema.Literals(["secure_enclave", "strongbox", "tee"]), // the server's record
    attested: Schema.Literal(true), // only an attested key can be proposed
  }),
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

| From                | To                                          | When                                                                                                                                       |
| ------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| —                   | `awaiting_approval`                         | An owner-only RPC inserts (section 2); card posted                                                                                         |
| `awaiting_approval` | `awaiting_approval` (revision+1, new nonce) | The target's live facts change when the card opens (check 9)                                                                               |
| `awaiting_approval` | `approved`                                  | A grant passes every check in section 5; grant row inserted in the same transaction                                                        |
| `awaiting_approval` | `rejected` / `cancelled` / `expired`        | Owner taps Reject; lead withdraws; `expiresAt` passes                                                                                      |
| `approved`          | `executing`                                 | Executor claims it (single claim, section 6)                                                                                               |
| `approved`          | `voided`                                    | Grant lapses before claim (the stop switch or an unconfigured host holds it until then), key revoked, approver no longer owner, no handler |
| `executing`         | `succeeded` / `failed`                      | The handler answers; a precheck or stop-switch failure after the claim is `failed`                                                         |
| `executing`         | `succeeded` / `interrupted`                 | Restart finds it mid-flight; reconciliation decides (section 6)                                                                            |

Storage (new, SQLite, Kin's own migration track in `apps/server/src/kin/persistence/` (`KinMigrations.ts`, one `migrations/K00N_*.ts` file per change) with its own `Migrator` table `kin_sql_migrations`; owned with the chat spec so all Kin tables share one runner):

- `kin_pending_actions` — columns as above; `UNIQUE(org_id, idempotency_key)`; index `(org_id, state)`.
- `kin_grants` — `id`, `org_id`, `action_id`, `revision`, `jti` **UNIQUE**, `approver_human_id`, `key_thumbprint`, `compact` (the signed token), `iat_s`, `exp_s` (the token's seconds), `accepted_at`, `consumed_at`; `UNIQUE(action_id, approver_human_id)`.
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
| Attestation | App Attest (`DCAppAttestService`) over `sha256(challenge ‖ public key)`, made natively from the key just created; verify per Apple's steps; store `attested: true/false`                                             | Record the `setAttestationChallenge` certificate chain; verify the root is Google's hardware root; store `attested: true/false`                                                                                           |

**Modules.** None of this exists in the repo's dependencies.

- **Recommended: a new local Expo module** `apps/mobile/modules/kin-approval-key` (Swift + Kotlin, autolinked from `modules/`). API: `createKey(attestationChallenge): {publicJwk, hardware, attestation?}`, `sign(signingInput): base64url`, `hasKey()`, `deleteKey()`. `signingInput` is the grant's JWS signing input (section 5). The module signs nothing else: natively, it refuses anything that isn't a well-formed `KinGrant` and writes the approval text from the payload, so no caller chooses what the user is shown. The Kotlin side needs `androidx.biometric:biometric` (**new dependency**, Google, declared in the module's own `android/build.gradle`).
- Not enough on their own: `expo-local-authentication` (**new**, Expo) only shows a prompt and doesn't bind a key; `expo-secure-store` (already installed, `~58.0.2`) with `requireAuthentication: true` gates a stored secret, but the key is still generated in JS and its bytes enter JS memory. Neither is a stopgap: a key made in JS can't be attested, so the server never activates it.
- Considered and not used: `react-native-biometrics` (**new**, third party) makes RSA keys and isn't Secure Enclave-backed on iOS.
- iOS needs `NSFaceIDUsageDescription` and the `com.apple.developer.devicecheck.appattest-environment` entitlement (`development` for development builds, `production` otherwise; none for personal-team builds, whose keys stay unattested). Add both with a Kin config plugin `apps/mobile/plugins/withKinApprovalKey.cjs` (new), listed with one entry in `apps/mobile/app.config.ts`. App Attest is a system framework, so it adds no dependency; the App ID needs the App Attest capability.

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
  state: Schema.Literals(["active", "revoked"]),
  createdAt: Schema.DateTimeUtc,
  confirmedAt: Schema.optional(Schema.DateTimeUtc),
  revokedAt: Schema.optional(Schema.DateTimeUtc),
});
```

Registration:

1. The phone calls `kin.approvals.keyChallenge()` (`access:write`), which returns a single-use 32-byte nonce bound to that session and valid for 5 minutes. It passes the nonce to `createKey`, then calls `kin.approvals.registerKey({enrolmentVersion: 2, publicJwk, platform, challenge, attestation?, deviceLabel})` over the same session. A request without `enrolmentVersion` comes from an app older than one-step set-up, which expects a code back and deletes its key without one; it is refused before anything changes (`unavailable`, the one reason those apps show the host's text for), asking the owner to update the app. The server consumes the nonce and checks the attestation below. A key with no attestation, or one that fails, is refused (`unattested`) and nothing is stored. One that passes is stored `active`, sealed (`KinKeySeal.seal`, an HMAC under a server secret over the org, thumbprint, public JWK, person, hardware and `created_at`), so a row inserted or edited in SQLite never signs. Challenges live in server memory, so after a restart the phone asks for a new one. A thumbprint registers only once; an identical retry from the same session (its answer was lost) returns the stored key.
   - **Android:** `attestation.certificateChain` is required. The server checks it offline: the chain verifies up to one of Google's two hardware attestation roots (the legacy RSA root and the newer ECDSA root), each pinned by its public key, and no certificate is on Google's attestation revocation list; the leaf's public key equals `publicJwk` and is EC P-256; the KeyDescription is read from the leaf only, and a chain where any other certificate carries one is refused; the leaf's KeyDescription has `attestationChallenge` equal to the nonce, `attestationSecurityLevel` and `keyMintSecurityLevel` (`keymasterSecurityLevel` before KeyMint) of `TrustedEnvironment` or `StrongBox`, and in `hardwareEnforced`: purpose `SIGN`, algorithm EC with `ecCurve` P-256 and `keySize` 256, digest SHA-256, `userAuthType` biometric only (`FINGERPRINT`, the value Keystore uses for every strong biometric), no `authTimeout`, no `noAuthRequired`, `origin` `GENERATED`, and `rootOfTrust` with `verifiedBootState` `Verified` and `deviceLocked` true; `allApplications` absent from both authorization lists; `attestationApplicationId` names exactly one package, the release package, with exactly the allowlisted signing-certificate SHA-256s, each once. The chain's last certificate only has to carry a pinned root's key, since Google reissued its RSA root under the same key; the pinned certificate takes its place, so its own validity and its signature on the next certificate are what count. Invalidation on biometric re-enrolment is checked only on the client (`KeyInfo` after creation, README); attestation can't prove it. All pass: `attested: true`, and `hardware` is `strongbox` or `tee` from the attestation security level. Any check fails: refused. The client never supplies `hardware`.
   - **Both chains** get RFC 5280 path validation with Node's `X509Certificate` and the attestation DER reader: names chain, each certificate is signed by the next and valid now (the pinned anchor included), every issuer is a CA (`basicConstraints` cA true) whose `keyUsage`, when present, allows certificate signing and whose path length allows the CAs below it, and a CA's critical extension other than those two fails closed unless the platform defines it (Android's provisioning info, `1.3.6.1.4.1.11129.2.1.30`; none on iOS). Google's own verifier skips CA checks because some older devices' chains don't follow RFC 5280, and it ignores the leaf's validity and expired factory-provisioned certificates; Kin checks all of these, so such a phone is refused, never let through.
   - **iOS:** `attestation` is `{format: "apple-app-attest", keyId, attestationObject}`. `createKey` makes it natively: a fresh App Attest key, attested over the client data hash `sha256(challenge ‖ 0x04 ‖ x ‖ y)` of the Secure Enclave key it just made. The module computes that hash itself, so JS can't get an attestation over a key or data it chose. The server follows Apple's documented verification: the `x5c` chain verifies to the pinned Apple App Attest root; the nonce extension (OID `1.2.840.113635.100.8.2`) equals `sha256(authData ‖ clientDataHash)`, where the server recomputes `clientDataHash` from the nonce it issued and `publicJwk`; the credential certificate's public key hashes to `keyId`; `authData`'s RP ID hash is `sha256("<teamId>.<bundleId>")` for the Kin bundle id; the counter is 0; the aaguid is `appattest` followed by seven zero bytes for production builds, and `appattestdevelop` only on a server configured to accept development builds; the credential id equals `keyId`. All pass: `hardware: "secure_enclave"`. No attestation (a simulator or an unsupported device) or any failed check: refused. The attestation object's `fmt` must be `apple-appattest` (the CBOR field, distinct from the client's `format` label `apple-app-attest`). `keyId` is `sha256` of the credential certificate's public key as the 65-byte X9.63 point, not its SPKI. Every certificate in `x5c` must be valid at verification time. The App Attest key is used only here; nothing later asserts with it, so the attestation's receipt isn't needed. App Attest proves the app, not its version: once several native builds have shipped, the server keeps a minimum native build (or a version allowlist) and refuses registration from older ones. On iOS `attested: true` means a genuine Kin app instance asked for this public key. It does not prove the approver key is in the Secure Enclave or gated by biometrics, and it does not detect a jailbroken phone; Android's attestation does prove hardware storage and a verified, locked boot. The owner accepted this weaker meaning for phase 1 (2026-11-09), since without it no iPhone could approve. `hardware: "secure_enclave"` is claimed by the platform, not proven.
   - **Either platform:** the server never stores a key without a trusted attestation, with no exception. That is what stops an agent, a tool, a script on the host or tampered JS from making a P-256 key in software and registering it: only the genuine Kin app on a real phone can present one.
2. **Every key, first or replacement, can approve once registered.** The write's transaction checks the caller again against stored rows: the org's owner (`KinOrgRoles`), from a session that isn't a shared or guest one (`kin:chat` scope). Teammates, agents, MCP tools, scheduled tasks and workers have no owner session, so they are refused (`not_owner`). At most 10 keys are active per org (`MAX_ACTIVE_KEYS`, `too_many_keys`). The same transaction writes `key_registered` and the owner's notice (below). Startup closes what the earlier flows left: a key still waiting to be allowed in Settings is revoked as ran out, audited, and the phone sets up again; phone-to-phone requests (`register_approver_key`) are cancelled, or voided if approved, expired or not, and have no handler.
   - **Telling the owner:** `KinKeyNotices` writes fixed text in the owner's own chat (`chat/executionNotices.ts`, audience `owner`) inside the key change's transaction, so a notice can't be lost or doubled, and a failure to write it rolls the change back. The chat is the chief of staff's, else another live lead's, else the owner's first, skipping any chat someone else reads. With no such chat, nothing goes to a chat: the key row is the record and Settings → Approvals shows it under recent activity. Either way the same transaction records the push the change owes (`kin_key_pushes`, with the notice's text); after commit it goes to every device of the key's owner, through quiet hours, opening Approvals, and is marked sent. A start sends whatever is still owed, so a crash between commit and send delays it but doesn't lose it; one sent just before a crash may go twice. The chat notice doesn't push for itself. The notice says which phone, when (in the owner's time zone) and where to remove it. The device name is reported by the phone, so it is reduced to letters, digits, spaces, apostrophes and hyphens (40 at most) before it is quoted; no markdown, link, domain or mention survives. The message id is the key's, so a retry posts once.
   - **Accepted cost:** whoever holds an owner session and a genuine Kin app on their own phone can enrol that phone. Any owner session can pair another in T3, so no step inside the sign-in layer could stop this without a new authority. The notice is the mitigation.
3. Removing (`kin.approvals.revokeKey`, from any owner session, web or phone) sets `revoked`, voids every `approved` action whose grant that key signed and every claimed one whose write hasn't started, writes `key_revoked` and the notice, all in one transaction. The last key can be removed; nothing can be approved until a phone is set up again. The executor's write start re-checks the key in its own transaction, so a removal that lands after the executor last read the key still stops the write. Revoking a T3 device session (`revokeClient`) also revokes keys registered from it. Kin reads `auth_sessions.revoked_at` at startup and before it trusts, lists or activates a key, rather than hooking T3's auth code. Expiry is not revocation: a key outlives the session that registered it. A DPoP relay session renews hourly under a new session id but the same DPoP key, so each key also stores that key's thumbprint (`proof_key_thumbprint`), and revoking any session of that DPoP key revokes the key (below).

The server's attestation allowlist comes from `KIN_ANDROID_PACKAGE`, `KIN_ANDROID_SIGNING_CERT_SHA256` (comma-separated hex), `KIN_IOS_APP_ID` (`<teamId>.<bundleId>`) and `KIN_IOS_APP_ATTEST_DEVELOPMENT` (accept `appattestdevelop`; default false). With none set, every phone is refused. Google's roots and Apple's App Attest root are pinned in `apps/server/src/kin/approvals/attestation/roots.ts`. Google's revocation list is fetched from `https://android.googleapis.com/attestation/status` and cached for an hour. If it can't be fetched, Android registration fails and the phone retries; it never stores a key whose chain went unchecked.

#### Device session revocation (lane B integration)

`ApproverKeys.reconcileSessions` revokes a key when either of these holds (`revokedBySession` in `apps/server/src/kin/auth/ProofKeySessions.ts`, which grant check 10 also uses):

- Its registering session was revoked, and that session either has no `kin_auth_session_keys` row and was revoked before it expired, or is marked by `individually_revoked` (see below).
- Any session mapped to the key's `proof_key_thumbprint` is marked by `individually_revoked`. This is how a renewed relay session's revocation reaches a key registered under an earlier id.

A mapping is marked when `individually_revoked != 0 AND (individually_revoked != 1 OR s.revoked_at <= s.expires_at)`: 1 is a revoke that counts only before expiry, 2 an unconditional block (bulk sign-out, or a revoke that killed an active session).

"Sign out other devices" revokes every other session and blocks every other mapped proof key, even one whose sessions had all expired, but never the caller's own key, so the caller's own key and its earlier renewals keep their approver keys. Revoking only an expired, disconnected session of a phone doesn't reach its key; revoke that phone's key itself. Either revocation counts against a key unless it was repaired and landed before the key's `created_at` (integer milliseconds; `auth_sessions.revoked_at` is ISO-8601 text, converted to milliseconds before comparing). So a revocation after a key registered revokes it for good, even once repaired, and a repair never restores an approver key; the phone registers a new one. `registerKey` refuses (`invalid_state`) a proof key with any unrepaired revocation and allows one whose revocations are all repaired, because mobile keeps one DPoP key per install and can't pair with a fresh one. The exchange block below uses the same proof key rule, where every repaired revocation stops counting.

There is no backfill: historical `jkt` values exist only in signed tokens, not stored sessions. The mapping is environment-local, not org-owned; the approver table supplies org isolation. K015_AuthSessionKeys owns this environment-local exception; these auth tables intentionally have no org_id.

With Kin enabled, an individually revoked mapped session blocks fresh exchanges for that exact proof key, including cloud re-mints; an individual revocation that reaches only an expired, disconnected session does not block. A revoke that kills an active session (`expires_at >= now`, matching the guard's `revoked_at <= expires_at`, or connected past expiry, since upstream treats a connected session as active) blocks the key unconditionally, whether that session is the target or a same-key sibling, so revoking an expired target that has a live renewal blocks the key. Individual revocation also revokes every active session sharing the key; expired, disconnected siblings are left alone. A client revoke from Settings passes the caller: the cascade never revokes the caller's own session, and when the caller holds the target's key the revoke signs out the target and its other same-key sessions without blocking the key or voiding its repairs, so an owner clearing a stale entry of their own phone keeps access. A caller on another key, managed policy and the CLI block as above. Session insertion, mapping and a second block check share a transaction with individual revocation, so either race ordering leaves the new session revoked and issuance fails rather than returning a dead token. Revoke notifications and connected-session removals run only after commit. Upstream issue still updates in-memory state and emits an upsert inside the transaction: a DPoP issue that rolls back can leave a stale upsert. Bulk “sign out other devices” is an explicit decision: it blocks every other proof key mapped in this environment, even one whose last session had already expired offline, until the owner repairs it. It excludes the caller's exact key, including earlier renewals. With Kin disabled the server hooks are no-ops; the CLI uses a read-only sqlite_master check to enable hooks against existing Kin auth tables without running Kin migrations, and remains a no-op when the table is absent; enabled-store initialization failure fails closed. Managed-policy revocations ("no remote clients") are individual revocations too, so those keys stay blocked after remote access is turned back on until the owner repairs them. A revoke that lands between insert and commit fails the exchange with a server-side issue error rather than a credential rejection; a retry is harmless because the bootstrap credential is already spent.

The server owner can deliberately re-pair the same key with `t3 auth pairing create --repair-proof-key <RFC-7638-thumbprint>` against the target environment's home directory, with Kin enabled or with Kin off when that database already has the Kin auth tables; the repair is consumed once Kin is on. The flag accepts only canonical 43-character base64url SHA-256 thumbprints. The CLI preserves upstream's `one-time-token` subject and records a key-bound repair in `kin_auth_key_repairs` with its pairing link id and integer-millisecond creation/consumption timestamps. Exchanges atomically consume that exact repair and acknowledge existing individual and bulk blocks; cloud mints, unbound links, another key and replay cannot acknowledge them. A later individual revocation or bulk sign-out blocks again and voids that key's unconsumed repairs, so a repair link issued before the block cannot lift it. Repair consumption and acknowledgement precede session insertion in a separate transaction because upstream resolves/consumes bootstrap grants before issuing a session; the post-insert check covers intervening revocation. If session issuance fails after consumption, the repair is spent and the key is already unblocked; a fresh ordinary pairing can retry unless a later revocation blocks it again. Repair never restores sessions or approver keys or bypasses registration/confirmation.

Nishchay's sign-off on the environment-local auth-table exception is still required.

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

**The card is drawn from the payload it signs.** `kin.approvals.challenge(actionId)` returns the unsigned payload (minus `jti`, `iat`, `exp`, which the device adds). The app parses it and renders repo, PR, SHA, base, method, diff size and checks from those fields and `resolved`, then signs the same bytes. There is no second copy of the facts that could drift from what is signed. `challenge` takes no org: the server looks the action up in the caller's own orgs and refuses anyone who isn't an approver (`not_owner`). For `merge_pull_request` and `delete_branch` it re-reads GitHub first and, if the head or base changed (what check 9 compares), rotates the nonce before answering. Other live facts, such as checks and diff size, are returned fresh without a rotation, so a check finishing never voids a grant check 9 would accept. `approver.kid` is the person's active key registered from this session, else their most recently confirmed one.

**The device checks what it signs.** The approval key module parses the signing input natively before it asks for a biometric, and refuses it unless: both parts are canonical `stableStringify` JSON (no whitespace, sorted keys, so no duplicate keys); the header has exactly `alg: "ES256"`, `typ: "kin-grant+jws"` and a `kid`; the payload has only the fields above, with `v: 1`, `decision: "approve"`, a `kind` the module has a prompt for, the matching `target` tag, `approver.kid` equal to the header `kid` byte for byte, `exp − iat ≤ 900` and `|deviceNow − iat| ≤ 300`. The prompt text comes from fixed per-kind templates in the module, such as `Set agent "agt_…" to L2 in all chats`, with every hash in full (the agent writes commits and content, so it could grind a value that matches a shortened hash), wrapped rather than cut. Shown values are refused, never cleaned, unless they are ASCII from a per-field allowlist (branches and paths: letters, digits, `. _ - / +`; lead and chat ids: letters, digits, `. _ -`), and a prompt over 200 characters is refused rather than cut. A kind with no template can't be signed until the module adds one. The server's checks below still apply in full.

`kin.approvals.submitGrant({compact})` checks, in this order, and stops at the first failure with a typed reason:

1. Decode header and payload; `alg`, `typ`, no `jwk`; each part's bytes equal `stableStringify(JSON.parse(bytes))`; `jti` is at least 16 bytes (22 base64url characters) and `nonce` is 32 bytes (43 characters) → `malformed`. The device parsers refuse the same.
2. `kid` is an `active` and attested key in `payload.orgId`, and `payload.approver.kid` equals it → `unknown_key` / `revoked_key`. "Attested" also needs the row's `seal`: an HMAC-SHA256, keyed by the server secret `kin-approver-key-seal`, over the org, thumbprint, public JWK, person, hardware and `created_at` (the bound of the session-revocation check), written by registration in the `INSERT` that stores the key and cleared on revoke (`approvals/KeySeal.ts`). An unattested key is never stored, and a row inserted or edited in SQLite carries no valid seal, so either one found active means the database was edited; it fails `unknown_key`. The attestation evidence itself is checked once, at registration, and not stored; the seal carries that verdict after. It defends against a SQLite write only: whatever can read the secrets directory can forge one.
3. Signature verifies with `p256.verify(sig, sha256(signingInput), key, {prehash: false, format: "compact", lowS: true})` → `bad_signature`. Unlike `verifyDpopProof`, `lowS: true` is required: the device always sends low-S, and ECDSA's `(r, n − s)` twin of a signature would otherwise also verify. Never identify or deduplicate a grant by its compact string; `jti` is its identity, and `compact` is kept for audit only.
4. `approver.humanId` equals the key's `humanId`, and that person currently meets a `requiredApprovers` entry (phase 1: holds the owner role in the org) → `not_owner`.
5. The RPC caller's session is the session the key was registered from, or another session of the same person → `session_mismatch`. (Defence in depth; the signature is the real check.)
6. Pending action exists in the org, is `awaiting_approval`, and `revision` and `nonce` match → `stale` (the card refreshes), or `replayed` when the org already holds this `jti` or this approver's grant for the action. An accepted grant sent again fails here, before check 10, because its action is no longer `awaiting_approval`.
7. `kind`, `target`, `targetDigest`, `headSha`, `base`, `mergeMethod` equal the server's record → `target_mismatch`.
8. `now` is a finite number, `|now − iat| ≤ 300`, `iat < exp`, `exp − iat ≤ 900` and `now < exp` → `time_window`.
9. Kinds that pin a pull request's head re-read it and refuse a moved head or base with `head_moved` (rotate nonce, refresh card), or `unavailable` when it can't be read. Those kinds are retired, so no grant reaches this read today; other kinds skip it.
10. In one transaction: insert `kin_grants` (`jti` UNIQUE, `(action_id, approver)` UNIQUE) and CAS the action to `approved` while both the action and the grant are unexpired and the signing key is still `active`, attested and from an unrevoked session → `replayed` when that org already holds the `jti` or this approver's grant for the action, `revoked_key` when the key was revoked after check 2 (say, during check 9's read), `stale` otherwise.

The grant's life ends at `min(exp, acceptedAt + 15 min)`. It is consumed when the executor claims the action, which needs the signing key to pass check 10's key test again, since a session revocation voids the action only on the next key read. It can't be used for anything else: the binding is to `actionId`, `nonce` and `targetDigest`, all server-chosen.

A rejection doesn't need a signature (rejecting is always safe) but is still recorded with the session that sent it. `reject({actionId, revision})` is limited to the action's approvers and is a compare-and-set on the revision. An action past `expiresAt` moves to `expired` instead, and the reject fails `invalid_state`.

Every refused grant writes `grant_rejected` with its reason, the sending session, and the grant's claimed `actionId`, `kind`, `jti`, `kid` and `headSha`. The entry goes in the key's org once check 3 has verified the signature, and before that in the caller's org, so an unproven grant can't write into another org's chain. A session with no Kin person is only logged. Each kind of rejection has its own cap of 20 entries per session and org a minute: junk (`malformed`, `unknown_key`), grants that name a real key but haven't verified (such as `bad_signature` or `revoked_key`), and verified grants refused later (such as `replayed` or `stale`). Junk can't use up the budget that records forgeries against a real key; when a minute ends, one entry per kind records how many were skipped (`5 more not recorded`), so a flood can't grow the audit chain without bound or hide a real attempt.

### 6. The action executor

`apps/server/src/kin/approvals/ActionExecutor.ts`. One action at a time per org. Its worker forks a run for each action `PendingActions.approve` publishes; every minute it retries held actions and reconciles `executing` rows that no fiber in the process holds; and the expiry sweep runs on its own minute schedule, so a stuck run can't hold it up. Claim and finish live on `KinExecutionLedger`, which `approvals/layer.ts` provides to the executor alone.

```ts
// apps/server/src/kin/approvals/ActionHandlers.ts
interface KinActionHandler {
  readonly kind: KinActionKind;
  readonly precheck: (a: KinPendingAction) => Effect<void, KinExecError>; // re-read live state
  readonly run: (a: KinPendingAction, c: KinExecutionContext) => Effect<KinOutcome, KinExecError>;
  readonly reconcile: (
    a: KinPendingAction,
  ) => Effect<
    "done" | "not_done" | "unknown" | { _tag: "done"; outcome: KinOutcome },
    KinExecError
  >;
}
// c.grant: the stored KinGrant; c.payload: the signed KinGrantPayload, decoded from c.grant.compact.
```

A `run` that can't tell whether its side effect landed (no answer, a 5xx, an unreadable 200, a defect) fails `unknown_outcome`; the executor then reconciles and never calls `run` again.

Handlers register through `KinActionHandlers` (a Context service, built from one list in `approvals/layer.ts`). The only handler is the lead spec's `set_level`. An approved action whose kind has no handler is voided (`unsupported_kind`) without a claim, which is what happens to a merge or branch deletion approved before the GitHub App was retired. Each held action gets one audit entry per hold reason (`execution_held` with `held: not_configured`, `held: paused` and so on), and when the sweep voids one whose grant lapsed while held, the owner's notice names the reason. The executor, its ledger and its handlers stay out of `approvals/layer.ts`'s output: context lookups go by key string, and that output reaches every service holding `kin.services`.

Run order for an `approved` action:

1. Stop switch (lead spec) off → else stay `approved` until the grant lapses, then the sweep voids it.
2. Approver still owner (`KinOrgRoles`) → else stay `approved` until the grant lapses.
3. Before the claim, the stored grant must verify again: its signature against its key's public JWK, that key's seal (check 2), and its payload binding this action's org, id, revision, `jti`, approver and facts (check 7) → else `voided: grant_unverified`. A grant row or an `approved` state written straight into SQLite stops here.
4. **Claim:** `INSERT INTO kin_executions(action_id, …)` and CAS `approved → executing` in one transaction. The insert also requires the grant unconsumed and alive, the signing key usable, and the org not paused. A failed insert means it already ran, is running or may not run: refuse.
5. The signing key and the approver's owner role checked again, then `precheck`. Any failure from here on is `failed`: the grant is spent.
6. The stop switch again, and `kin_executions.write_started_at` recorded, immediately before the side effect.
7. `run`.
8. Record outcome (`kin_executions`, `execution_finished` with the grant's `jti`, key thumbprint and the key's `deviceLabel`), and post the result as a system notice to the owner's chat.

**Crash in the middle.** On startup the executor scans `executing` rows and calls each one's `reconcile`: done → `succeeded` (`execution_reconciled`); not done → `interrupted`; no `write_started_at` means nothing was sent → `failed: not_started`. `interrupted` is terminal: the grant is spent, and the owner's notice says to ask again. One grant, one attempt, always.

### 7. Idempotency (gap 4)

- `idempotencyKey = sha256(stableStringify({orgId, kind, target, source}))` where `source` names what asked: for an owner request, the request's own id.
- A second request with the same key returns the existing action instead of creating one, so a retried request lands on the same row.
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
  ceilingBelowOwner: Schema.Boolean,
  afterNonOwnerMessage: Schema.optional(
    Schema.Struct({ humanId: KinPersonId, messageId: KinMessageId }),
  ),
});
```

- The lead spec computes it from the `KinEvent`; the ceiling is the lowest role in the chain. GitHub content (PR bodies, comments) counts as `none`.
- **Work** runs only if the ceiling and the chat's level allow it (`ceilingAllows`).
- **Privileged** runs only with the owner's grant, which is the owner's own authority for that one action. Today every request comes from the owner's session (section 2), so its provenance is the owner's. `ceilingBelowOwner` and `afterNonOwnerMessage` stay in the schema so the card can warn, above the buttons, if a kind an agent proposes ever returns.
- `set_level`, `change_rules`, `register_approver_key`, and (later) `set_delegation` and `set_next_of_kin` must never be requestable from an agent's turn unless every event in the wake-up's chain is the owner's. Checking only a cited event isn't enough: a lead can cite an owner's message while acting on a member's in the same batch.
- Roles come from stored rows, never event text: a chat message's stored `author_role` (human, posted), or for other human events the actor's current chat membership. Only the lead's own owner counts as `owner`; another human holding an owner row counts as `member`. Agent, system, schedule and GitHub events count as `none`. `afterNonOwnerMessage` names the first non-owner human message in the batch.

### 9. Approval cards

- The chat message carries a `KinWidget` (chat spec) of type `approval` with **only** `{actionId}`. An agent can't supply title, buttons or text for it; the chat service rejects agent-authored `approval` widgets with any other field.
- Apps render the card natively from `kin.approvals.get(actionId)`. The server projects per viewer:
  - **Owner:** full facts, `canApprove: true`, shown in **Waiting on you** and the direct chat.
  - **Anyone else:** `{repo, number, title, state, waitingOn: "Nishchay"}`, `canApprove: false`, no challenge. `kin.approvals.challenge` and `submitGrant` refuse non-owners with `not_owner` anyway.
- The card shows the target (for `set_level`, the lead, the chat or all chats, and the level), the reason as a quote, and the provenance warning.
- Approve: the approval key module shows the grant's own text, written natively from the signed payload (section 5): `Merge GLDRoger/t3code #212 (a1b2c3d4e5f60718293a4b5c6d7e8f9012345678) into "main" by squashing` → biometric → sign → submit. Android shows it in the `BiometricPrompt`. Face ID mostly ignores the prompt's reason text, so on Face ID iPhones the module first shows it in a native confirmation sheet, in its own window above the app's. The sheet ends any picture in picture the app's web views start, before it shows and while it is up. Coverage is checked on every frame while the sheet is up. Approve stays disabled, and ignores taps, until every frame for 0.7 s has found the sheet key and uncovered; any frame that isn't clear restarts the delay, as do the sheet appearing, becoming key again, and the keyboard showing or hiding. Once enabled, the first frame that isn't clear disables Approve and arming starts over. So a tap aimed at something JS drew, or the second tap of a double tap, can't land on it. A tap that arrives while something covers the sheet signs nothing (`E_OBSCURED`). Touch ID shows it in the system prompt. Notification and lock-screen actions open the app to this card; nothing is signed in the background, and the module signs one grant at a time.
- Desktop and web show the card read-only with "Approve on your phone" in phase 1.

### 10. GitHub

Kin watches GitHub with the owner's login, connected from the phone at Settings → Connections → GitHub (`gh auth login` by device code, then `gh auth setup-git`, as the server's OS user). Owner-only turns that have read no outside text get a shell; `kin_github_review`, `kin_github_watch` and `kin_github_link` show only while that login is connected; the watch polls the owner's repos and wakes the lead on a `/kin` comment (triggers spec). Signing out stops all of it.

Agents write as Kin's GitHub App when Settings holds one (`appStore.ts`), made there or adopted once from the host's `KIN_GITHUB_APP_ID`; a Disconnect marks that id taken so a restart doesn't adopt it again (`KinGitHubApp.ts`). The server keeps the key and mints one-hour installation tokens without administration, secrets, members, hooks or organization permissions, so a token can't change who has access; it writes them, with the bot's identity, to files the agent shell's `gh`, `git` and credential helper read (`ghSign.ts`). Repos without an installation fall through to the owner's login. `kin-as-owner <command>` runs one command as the owner, and the server records each run (agent, repo, command with secrets stripped) for Connections. Kin's own posts (reviews, reactions, memory PRs) use the App where installed and the owner otherwise.

Kin never merges code or approves. The shell's `gh` refuses merging, approving and settings changes under either identity; under the owner that refusal is the only wall, since the shell runs as the server's OS user. Branch protection is whatever the owner sets on GitHub; Kin doesn't apply or check rulesets. Kin's own memory repo is the exception (triggers spec, memory repo guard rails). Comments and PR bodies carry the agent's signature line.

The App's webhook exists only as a reason to look sooner: Kin points it at its public address with a secret it makes and keeps beside the App's key, verifies each delivery's signature before reading it, and queues a look at the one thread it names (`appHook.ts`, `hookHttp.ts`). A delivery carries no authority and none of its text is kept or shown; the look reads GitHub as the poll does and claims the same keys, so a lost, late or repeated delivery changes nothing the poll wouldn't. Setting the hook needs no new permission. The owner's merge token, `RequestAction` handlers, `scripts/kin-github-app.ts` and `scripts/kin-rulesets.ts` stay removed.

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
    "action_cancelled",
    "action_expired",
    "action_voided",
    "execution_started",
    "execution_finished",
    "execution_reconciled",
    "execution_held",
    "key_registered",
    "key_confirmed",
    "key_revoked",
    "credential_check_failed", // retired: written by the removed hygiene check
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
  result: Schema.optional(Schema.String), // the outcome, or the failure reason
  prevHash: Hex64,
  hash: Hex64, // sha256(prevHash ‖ stableStringify(entry without hash))
});
```

Append-only: `BEFORE UPDATE` and `BEFORE DELETE` triggers on `kin_audit` abort every edit, and the repository code has no such statements. The hash chain makes edits that bypass the triggers visible; `kin.audit.verify` recomputes it. Rejected grants are audited with their failure reason and the sending session, so a forged approval leaves a trace. `kin.audit.list` and `kin.audit.verify` are owner-only: the session must resolve to the org's owner, not just a person in the org. `list` returns a row that no longer decodes as `{ seq, corrupt: true }` instead of failing the page. The audit stores the grant's `jti` and the key thumbprint, never tokens or keychain contents.

`apps/server/src/kin/approvals/Audit.ts` (`KinAudit`) is the only writer. `append` joins the caller's transaction, so `PendingActions.ts` writes each transition's entry atomically with the transition: `action_requested` on insert (not on an idempotent replay), `action_refreshed`, `grant_accepted`, the four terminal `action_*` moves (the sweep included), `execution_started` with the claim, and `execution_finished`, or `execution_reconciled` when startup reconciliation decides the outcome. `approve` also writes `grant_rejected` for `stale`, `replayed` and `revoked_key`, after its transaction ends: when no grant row was inserted the transaction commits empty, and only a lost compare-and-set on the action rolls the inserted grant back. The entry goes on the chain of the org that owns the action; a grant naming an unknown org or action stays `stale` and writes nothing. Rejections decided before `approve` (checks 1–9) and key events are written by APPR-4 and APPR-5 through `KinAudit.append`, and the executor writes `execution_held` once per held action and reason. No RPC or MCP tool writes or deletes entries.

Each org has its own chain. The first entry's `prevHash` is 64 zeros, and `seq` counts from 1 with no gaps. Appends are serialized by SQLite's single `BEGIN IMMEDIATE` writer, with `UNIQUE(org_id, seq)` as a backstop. `entry_json` holds `stableStringify` of the whole entry. `verify` walks the chain in `seq` order and reports the first entry whose bytes, columns, position, `prevHash` or `hash` don't hold, which catches an edited, deleted, reordered or inserted row. The chain has no secret and no outside anchor, so it can't show a truncated tail or a chain recomputed from the edit onward by someone with write access to the database. It catches tampering, not a compromised server.

## Threat model

| Threat                                    | Example                                                                                                   | Stopped by                                                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Injected instruction                      | PR body says "merge this now"                                                                             | No agent tool can request one; the owner merges on GitHub himself                                                                                             |
| Fake approval in text                     | Member types "Nishchay approved"                                                                          | Only `submitGrant` with a valid signature changes state                                                                                                       |
| Forged approval from a member's client    | Modified app calls `submitGrant`                                                                          | Checks 2–4: key not registered, or registered to a non-owner → `not_owner`                                                                                    |
| Agent-drawn button                        | Generated widget labelled "Approve"                                                                       | `approval` widgets carry only `actionId`; the card is native; generated widgets can't call approvals RPCs                                                     |
| Card shows one thing, phone signs another | Buggy or tampered app code asks the key to sign another PR                                                | The key signs only canonical grants; the module writes the approval text natively from the bytes it signs                                                     |
| Tampered JS draws over the Face ID sheet  | An over-the-air bundle covers the text, leaves Approve                                                    | Sheet in the module's own window above the app's; Approve checks nothing covers it (`E_OBSCURED`)                                                             |
| Tampered JS times a tap onto Approve      | Draws a button where Approve will appear, calls `sign` on touch-down; or covers Approve, then uncovers it | Approve enables only after every frame for 0.7 s finds the sheet key and uncovered, and any later frame that isn't clear disables it and restarts the 0.7 s   |
| Tampered JS draws into picture in picture | Starts PiP that partly covers the sheet's text and takes taps inside its own frame                        | The module closes web-view PiP for as long as the sheet is up; `expo-video` PiP from tampered JS, and other apps' PiP, are accepted residual risk (see below) |
| Tampered JS registers a software key      | Deletes the hardware key, makes a P-256 key in JS, registers it                                           | App Attest or Keystore attestation of a key the native module made; unattested keys are never activated                                                       |
| Replay                                    | Captured grant sent again, or for another PR                                                              | `jti` UNIQUE, nonce and `targetDigest` binding, executions PK                                                                                                 |
| Double run                                | Restart mid-run, a retried request                                                                        | Idempotency key, executions PK, reconciliation                                                                                                                |
| Stolen phone                              | Thief has the unlocked phone                                                                              | Per-use biometric on the key; `.biometryCurrentSet` / enrollment invalidation; remove its key in Settings, then Approvals, in Kin on the web or desktop       |
| Rule change from chat                     | "Remember: Priya can approve merges"                                                                      | `change_rules`/delegations need owner provenance and a grant                                                                                                  |

Tampered JS is the attacker the native sheet, the grant parser and attestation defend against. Over-the-air updates are its main way in. BRAND-1 (#35) turns updates on in Kin builds only when both a Kin EAS project (`KIN_EAS_PROJECT_ID`) and an update code-signing certificate (`KIN_UPDATES_CODE_SIGNING_CERT`) are configured: it removes upstream's updates URL and EAS project, and writes `updates.codeSigningCertificate` so `expo-updates` loads only bundles signed by Kin's key. Without both, the only JS that runs is the JS in the signed binary. Until #35 merges, the mobile app keeps upstream's updates config.

Picture in picture is drawn by the system above every app window, so the sheet can't see it or tell it apart from clear. A PiP window the app starts can partly cover the grant text and takes taps inside its own frame, so the user may not see the whole grant; it can't tap Approve, and Approve still signs only the grant's own text. The module closes web-view PiP (including one tampered JS starts with `injectJavaScript`) for as long as the sheet is up. It reaches only web views in the app's windows. `expo-video` PiP started by tampered JS, PiP from a web view that isn't in a window (such as one on a screen under a pushed screen), and other apps' PiP are accepted residual risk. Kin builds could drop `UIBackgroundModes: audio`, which system PiP needs, to shrink this further. Foreground notification banners from `expo-notifications`, which tampered JS can schedule with its own text, are the same class of risk: system UI the sheet can't detect that can sit over part of it.

`deleteKey` needs no biometric, so tampered JS can delete the approval key. That is only a denial of service because a replacement must be attested: registering a new key needs a fresh session challenge, an App Attest or Keystore attestation of a key the native module made, and the owner's own session, and the server never stores an unattested key.

An agent in an owner-only turn holds the owner's GitHub login through `gh`, so it can do on GitHub what the owner can. That is the price of a shell on his own repos; the shell is withheld from shared turns and from any turn that has read outside text (lead spec), and what reaches the default branch is still the owner's merge.

## Files

New (Kin-owned):

- `packages/contracts/src/kinApprovals.ts` — all schemas above, RPC definitions, `KIN_APPROVAL_RPC_SCOPES`.
- `packages/shared/src/kinGrant.ts` — `encodeGrantSigningInput`, `verifyKinGrant` (pure, shared with mobile).
- `apps/server/src/kin/approvals/` — `PendingActions.ts` (repository + CAS), `GrantVerifier.ts`, `ApproverKeys.ts`, `ActionExecutor.ts`, `ActionHandlers.ts`, `handlers/setLevel.ts`, `rpcHandlers.ts`, `Audit.ts`, `*.test.ts`.
- `apps/server/src/kin/persistence/migrations/K00N_Approvals.ts`, registered in `KinMigrations.ts` (the track is shared with the chat spec).
- `apps/mobile/modules/kin-approval-key/` — Swift, Kotlin, `expo-module.config.json`, `index.ts`.
- `apps/mobile/src/features/chats/approvals/` — `ApprovalCard.tsx`, `useApproveAction.ts`.
- `apps/mobile/plugins/withKinApprovalKey.cjs`.

Upstream hooks (one line each):

- `apps/server/src/auth/RpcAuthorization.ts` — `...KIN_APPROVAL_RPC_SCOPES,` in `RPC_REQUIRED_SCOPES` (or folded into the chat spec's single Kin spread, if it adds one).
- `packages/contracts/src/kinRpcs.ts` (Kin-owned, created by CHAT-6) — add the approval RPCs and scopes to `KinRpcs` and `KIN_RPC_SCOPES`; `rpc.ts` and `RpcAuthorization.ts` already spread those.
- `apps/server/src/server.ts` — Kin layer already added by the chat spec; approvals layers join `apps/server/src/kin/layer.ts`, not upstream.
- `apps/mobile/app.config.ts` — `["./plugins/withKinApprovalKey.cjs", { appAttestEnvironment }]` in `plugins`.

RPCs and scopes: `kin.approvals.list` (stream) and `get` → `orchestration:read`; `challenge`, `submitGrant`, `reject` → `orchestration:operate`; `keyChallenge`, `registerKey`, `listKeys`, `revokeKey`, `kin.audit.list`, `kin.audit.verify` → `access:write`. Scopes are only the outer gate; the person and signature checks above are the real ones.

## Interfaces to other specs

- **Chat:** `KinOrgId`, `KinPersonId` (human `KinAuthor`), `KinChatMember` roles (owner lookup), `KinWidget` type `approval {actionId}` with the agent-field rejection, posting result messages, **Waiting on you** items. Chat spec owns the Kin migration runner and the Kin RPC/route hooks.
- **Lead:** `KinEvent` provenance, the stop switch (executor checks it), levels (`ceilingAllows`, and the `set_level` handler behind `kin.levels.raise`, never a lead's request), `change_rules` handler.
- **Triggers:** `memory_purge` handler; upstream contract test for `verifyDpopProof`.
- **Mobile:** renders `ApprovalCard` inside the chat screens; this spec ships the card, the native module and the signing hook.
- **T3 auth (lane A), open hand-offs:**
  - `KinIdentity.resolve` returns each person's org role once members exist (CHAT-11). `registerKey` then refuses anyone but the owner and takes `startedByRole` from that role. Until then, `resolve` returns only the org owner, so the literal `"owner"` is accurate.

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
10. `two executors racing on one action run it once` — concurrent claims, one `kin_executions` row.
11. `an agent-authored approval widget with extra fields is rejected by the chat service` (chat spec test, listed here).
12. `non-owners get the redacted card and no challenge`.
13. `the audit chain detects an edited row` (`kin.audit.verify`).
14. `the owner's phone with a trusted attestation can approve at once` (never without one, a teammate, an agent or another org's id), with the 10-key cap, replayed and cross-session challenges, retries, and Remove voiding what the key signed.
15. Mobile (`apps/mobile/modules/kin-approval-key`, device test): `signing without biometrics fails`, `re-enrolling biometrics invalidates the key`, `DER signatures convert to compact and verify on the server`, `only one signature at a time, under the grant's own text`, `an overlay over the sheet can't approve`, `a double tap can't land on Approve`, `a cover removed after the first tap can't approve` (including about 50 randomised-timer hides: Approve never enables less than 0.7 s after the cover goes), `a cover mounted after Approve arms and hidden on the first tap can't approve on the second`, `the app's own web-view picture in picture closes before the sheet shows and while it is up`, `system UI doesn't lock the sheet out`. The module's README has the checklist; its grant parser's vectors run without a device.

Acceptance: the owner raises a lead's level from Settings, approves on the phone with Face ID, the executor applies it once, and the audit lists grant, device, provenance and outcome. The numbered server tests pass in CI; 22 passes on the release checklist. (Numbers 10, 12–14 and 17–19 and 23 belonged to the retired merge path.)

## Tasks

**APPR-1 Contracts.** All schemas, RPC definitions and scope map in `packages/contracts/src/kinApprovals.ts`; `packages/shared/src/kinGrant.ts` with signing input and pure verification. Files: those two plus tests. Depends on: CHAT-1 (org, human and widget ids). Done when: `vp run typecheck` passes and `kinGrant.test.ts` verifies a grant signed with a `node:crypto` P-256 key and rejects tampered payloads. Owner: backend.

**APPR-2 Storage and state machine.** Tables, Kin migrations, `PendingActions.ts` with CAS transitions, idempotency key, nonce rotation, expiry sweep. Depends on: APPR-1, CHAT-2. Done when: transition tests (including 11 and 13) pass. Owner: backend.

**APPR-4 Grant verification.** `GrantVerifier.ts` implementing checks 1–10, `challenge`, `submitGrant`, `reject` RPCs, audit on every rejection. Depends on: APPR-2, APPR-5. Done when: tests 1–9 pass. Owner: backend.

**APPR-5 Approver keys.** Registry, `registerKey`/`listKeys`/`revokeKey`, App Attest and Keystore attestation verification (section 4), never storing an unattested key, revoke-on-session-revoke, `register_approver_key` handler with `hardware` and `attested` in its target. Depends on: APPR-1, APPR-2. Done when: tests 4 and 21 pass. Owner: backend.

**APPR-6 Native approval key module.** `apps/mobile/modules/kin-approval-key` for iOS (Secure Enclave, `.biometryCurrentSet`, App Attest) and Android (Keystore, StrongBox fallback, `BiometricPrompt`, attestation chain); DER-to-compact; config plugin for `NSFaceIDUsageDescription` and the App Attest entitlement. Depends on: nothing. Done when: device tests in 22 pass on one iPhone and one Pixel, and a signature verifies with `p256.verify`. Owner: UI (native).

**APPR-7 Approval card and phone flow.** `approvePendingAction` (challenge, biometric sign and submit; the card itself is MOB-8). Depends on: APPR-4, APPR-6, MOB-4. Done when: on a device, approving a level raise moves the action to `approved`; a member account sees "Waiting on Nishchay" with no button (test 16 on the server). Owner: UI.

**APPR-9 Executor.** `ActionExecutor.ts`, handler registry, stop-switch check, startup reconciliation, result posting. Depends on: APPR-4, LEAD-11. Done when: test 11 passes. Owner: backend.

**APPR-10 Audit.** `Audit.ts` with hash chain, `kin.audit.list`/`verify`, entries from every step above. Depends on: APPR-2. Done when: test 20 passes and the acceptance run shows a complete trail. Owner: backend.

Later, marked by phase:

**APPR-12 (phase 3) Delegations (9.6).** `set_delegation` kind and handler; `KinDelegation {orgId, grantee, kinds, scope: {repo, paths?, labels?}, expiresAt, signedBy}`; a matching delegation lets the grantee's own signed grant meet `requiredApprovers`; list and one-tap revoke. Depends on: APPR-4, APPR-9. Done when: a delegated action by a member succeeds, an out-of-scope one fails `not_owner`, and revoked delegations stop working at once. Owner: backend.

**APPR-13 (phase 3) L3 risk gate (10).** Path and label classifier (`auth`, `security`, migrations, `.github/**` are never low-risk) used by delegations. Depends on: APPR-12, LEAD-8. Done when: a fixture list of PRs classifies as expected. Owner: backend.

**APPR-14 (phase 3) Next of kin (9.9).** `set_next_of_kin` (owner-signed, max two, can't name self), escalation timer (2 h default or owner away) with a 30-minute warning, undo-only default scope (revert merge, roll back deploy, pause routines), any owner answer cancels, return summary in the owner's direct chat. Depends on: APPR-12, TRIG-3. Done when: a simulated outage hands a revert to the next of kin after the wait, and an owner tap during the wait cancels it. Owner: backend.

**APPR-15 (phase 5) Two-key approvals for outside agents (9.8).** `admit_outside_agent` with a signed manifest; `requiredApprovers` = credential owner and resource owner; cards show "Waiting on Priya, then Nishchay"; an agent key can never be an approver key. Depends on: APPR-12, chat spec's outside-agent membership. Done when: an action from an outside agent needs both grants and fails with either one alone. Owner: backend.

## Design corrections

1. **T3's device key is not hardware-backed or biometric-gated.** DESIGN 9.2 says the grant is signed by "a DPoP-style key in the Secure Enclave or Keystore". The existing mobile DPoP key (`apps/mobile/src/features/cloud/dpop.ts`) is a software key in `expo-secure-store`, used only for the managed relay. Kin needs a new, separate approval key and a new native module (APPR-6).
2. **T3 sessions have no person or role.** `SessionClaims` carry scopes and a label `sub`. "The signer has the owner role" has to come from Kin's membership (chat spec), with keys bound to a person.

## Open questions

1. Desktop approvals: a Touch ID-gated Secure Enclave key on macOS through a native addon, or phone-only for good?
