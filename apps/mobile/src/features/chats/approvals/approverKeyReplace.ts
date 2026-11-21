import type { EnvironmentId, KinKeyThumbprint, KinOrgId } from "@t3tools/contracts";

/** One approval key as a host knows it. */
export interface KinApproverKeyRef {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly thumbprint: KinKeyThumbprint;
}

/** `done`: the host dropped it or never had it; `final`: it refused for good; `retry`: no answer. */
export type KinRevokeAnswer = "done" | "final" | "retry";

type Stopped<F> = { readonly ok: false; readonly failure: F } | null;

export type KinEnrolOutcome<F> =
  /** Another setup is running on this phone. */
  | { readonly _tag: "busy" }
  /** The key the person confirmed replacing is no longer the one this phone holds. */
  | { readonly _tag: "changed" }
  /** The new host refused or the person cancelled; the old host's key was not revoked. */
  | { readonly _tag: "stopped"; readonly failure: F | null }
  /** `cleanup`: whether the old host dropped the replaced key, or will be asked again. */
  | {
      readonly _tag: "done";
      readonly cleanup: "none" | "done" | "pending";
      readonly replaced: KinApproverKeyRef | null;
    };

const sameRef = (a: KinApproverKeyRef | null, b: KinApproverKeyRef | null) =>
  a === null || b === null
    ? a === b
    : a.environmentId === b.environmentId && a.orgId === b.orgId && a.thumbprint === b.thumbprint;

/**
 * Sets up this phone's one approval key, one setup at a time. Replacing checks the key is still
 * the one the person confirmed, and revokes it on its host only once the new host has the new
 * key; an unanswered revoke stays pending for the next time that host connects.
 */
export function createKinApproverKeyEnrolment<T, S, F>(deps: {
  readonly readRecord: () => Promise<KinApproverKeyRef | null>;
  /** Asks the new host for a challenge before anything on the phone changes. */
  readonly begin: (target: T) => Promise<{ readonly ok: true; readonly value: S } | Stopped<F>>;
  /** Deletes this phone's key and its record. */
  readonly discardLocal: () => Promise<void>;
  /** Makes the key, registers it with the new host and saves its record. */
  readonly finish: (target: T, started: S) => Promise<{ readonly ok: true } | Stopped<F>>;
  readonly revoke: (ref: KinApproverKeyRef) => Promise<KinRevokeAnswer>;
  readonly addPending: (ref: KinApproverKeyRef) => Promise<void>;
}) {
  let running = false;
  return async (input: {
    readonly target: T;
    /** Null to set up from nothing; otherwise the key the person confirmed replacing. */
    readonly replace: { readonly confirmed: KinApproverKeyRef | null } | null;
  }): Promise<KinEnrolOutcome<F>> => {
    if (running) return { _tag: "busy" };
    running = true;
    try {
      const replaced = input.replace === null ? null : await deps.readRecord();
      if (input.replace !== null && !sameRef(replaced, input.replace.confirmed))
        return { _tag: "changed" };
      const started = await deps.begin(input.target);
      if (started === null || !started.ok)
        return { _tag: "stopped", failure: started?.failure ?? null };
      if (input.replace !== null) await deps.discardLocal();
      const finished = await deps.finish(input.target, started.value);
      if (finished === null || !finished.ok)
        return { _tag: "stopped", failure: finished?.failure ?? null };
      if (replaced === null) return { _tag: "done", cleanup: "none", replaced };
      // Refused or unanswered, the old host still lists this phone: ask it again later.
      if ((await deps.revoke(replaced)) !== "done") {
        await deps.addPending(replaced);
        return { _tag: "done", cleanup: "pending", replaced };
      }
      return { _tag: "done", cleanup: "done", replaced };
    } finally {
      running = false;
    }
  };
}

/**
 * Asks each connected host again to drop a key this phone replaced. A key leaves the list once its
 * host drops it or refuses for good, so retries end; one being asked isn't asked twice.
 */
export function createKinApproverKeyCleanup(deps: {
  readonly pending: () => Promise<ReadonlyArray<KinApproverKeyRef>>;
  readonly connected: (environmentId: EnvironmentId) => boolean;
  readonly revoke: (ref: KinApproverKeyRef) => Promise<KinRevokeAnswer>;
  readonly removePending: (ref: KinApproverKeyRef) => Promise<void>;
}) {
  const asking = new Set<string>();
  return async () => {
    for (const ref of await deps.pending()) {
      const key = `${ref.environmentId}\u0000${ref.orgId}\u0000${ref.thumbprint}`;
      if (asking.has(key) || !deps.connected(ref.environmentId)) continue;
      asking.add(key);
      try {
        if ((await deps.revoke(ref)) !== "retry") await deps.removePending(ref);
      } finally {
        asking.delete(key);
      }
    }
  };
}
