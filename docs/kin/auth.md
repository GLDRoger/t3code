# Kin's sign-in rules

What Kin changes in [environment authentication](../internals/environment-auth.md) and [T3 Connect](../internals/t3-connect.md). Read it with them before changing auth on a Kin host.

## Two scopes

- **`kin:chat`** is a teammate's session: it reaches Kin's chats and nothing of the coding app. An invite grants it alone. A session holding only `kin:chat` may call Kin's `kin.*` methods plus a short allowlist it needs to connect and to send files on Kin messages (`chatOnlyMayCall` in [chatOnlyConfig.ts](../../apps/server/src/auth/chatOnlyConfig.ts)), and connects with a config snapshot built from constants (`chatOnlyServerConfig`). Every other method is refused.
- **A standard session holds `kin:chat` implicitly.** `sessionGrantsScope` in [auth.ts](../../packages/contracts/src/auth.ts) grants it to any session holding all of `AuthStandardClientScopes`, so the owner's paired devices reach Kin without a new grant.
- **`kin:tasks`** is a person's coding-agent key. Only Kin's tasks endpoint accepts it ([audience.ts](../../apps/server/src/kin/tasksKey/audience.ts)); pairing never grants it (`AuthGrantScope` leaves it out).
- Older clients don't know either scope, so a refusal for one names `orchestration:read` (`authScopeRequiredResponse`).
- The server calls a session chat-only when every scope it holds is `kin:chat` (`isChatOnly`); the clients' `sessionIsChatOnly` says chat-only for `kin:chat` without `orchestration:read`. They differ only for a session holding `kin:chat` and some other scope, which nothing grants today.

## Revoking and blocking a device

With Kin on, `SessionHooks` ([sessionHooks.ts](../../apps/server/src/kin/auth/sessionHooks.ts), implemented in [ProofKeySessions.ts](../../apps/server/src/kin/auth/ProofKeySessions.ts)) changes T3's rules:

- **The host CLI's revoke ends only the session.** T3 Code revokes a key-bound session's key with it; on a Kin host a revoke with no caller, or from the `cli` session, signs out that session and leaves the device's key trusted (`revokesSessionOnly`).
- **A revoked key stays blocked.** An individual revoke that ended an active session, or "sign out other devices", blocks that proof key: a fresh exchange with it, a cloud re-mint included, is refused (`checkExchange`) until the owner re-pairs it with `t3 auth pairing create --repair-proof-key`.

The full rules, races and the approver keys they reach are in [the approvals spec, section 4](./specs/approvals.md#4-approver-keys-what-t3-has-and-what-kin-adds).
