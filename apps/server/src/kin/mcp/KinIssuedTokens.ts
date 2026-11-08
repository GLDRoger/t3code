import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";

/** Whether text carries a T3 MCP bearer token that is still issued. Only hashes are kept. */
export class KinIssuedTokens extends Context.Service<
  KinIssuedTokens,
  { readonly containsIssuedToken: (text: string) => Effect.Effect<boolean> }
>()("t3/kin/mcp/KinIssuedTokens") {}

interface Owner {
  readonly providerSessionId: string;
  readonly threadId: ThreadId;
}

// McpSessionRegistry tokens are 32 random bytes in unpadded base64url.
const tokenLength = 43;
const candidateRuns = /[A-Za-z0-9_-]{43,}/g;

export const make = Effect.gen(function* () {
  const digest = yield* Digest.Digest;
  const issued = new Map<string, Owner>();
  const hash = (token: string) =>
    digest.digest(Digest.sha256, new TextEncoder().encode(token)).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString("hex")),
      Effect.orDie,
    );
  const revokeWhere = (matches: (owner: Owner) => boolean) =>
    Effect.sync(() => {
      for (const [key, owner] of issued) if (matches(owner)) issued.delete(key);
    });
  return {
    record: Effect.fn("KinIssuedTokens.record")(function* (
      authorizationHeader: string,
      owner: Owner,
    ) {
      const token = authorizationHeader.replace(/^Bearer /, "");
      if (token.length === tokenLength) issued.set(yield* hash(token), owner);
    }),
    revokeProviderSession: (providerSessionId: string) =>
      revokeWhere((owner) => owner.providerSessionId === providerSessionId),
    revokeThread: (threadId: ThreadId) => revokeWhere((owner) => owner.threadId === threadId),
    revokeAll: Effect.sync(() => issued.clear()),
    service: KinIssuedTokens.of({
      containsIssuedToken: Effect.fn("KinIssuedTokens.containsIssuedToken")(function* (text) {
        if (issued.size === 0) return false;
        for (const [run] of text.matchAll(candidateRuns))
          for (let start = 0; start + tokenLength <= run.length; start++)
            if (issued.has(yield* hash(run.slice(start, start + tokenLength)))) return true;
        return false;
      }),
    }),
  };
}).pipe(Effect.provide(NodeCrypto.layer));
