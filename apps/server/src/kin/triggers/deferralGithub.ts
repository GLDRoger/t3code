import { KinOrgId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const GithubLinkState = Schema.Struct({
  link: Schema.String,
  state: Schema.Literals(["open", "closed", "merged"]),
  assignees: Schema.Array(Schema.String),
  linkedPrs: Schema.Array(Schema.Int),
});
export type GithubLinkState = typeof GithubLinkState.Type;

export interface GithubRef {
  readonly repo: string;
  readonly number: number;
}

export class KinDeferralGithubError extends Schema.TaggedError<KinDeferralGithubError>()(
  "KinDeferralGithubError",
  { orgId: KinOrgId, reason: Schema.Literals(["unavailable", "not_found"]) },
) {}

export interface KinDeferralGithubReaderShape {
  /**
   * Read-only: one issue or PR's state, assignees and linked PR numbers.
   * Called under the org memory lock from syncOrg, so a real reader must be time-bounded.
   */
  readonly read: (
    orgId: KinOrgId,
    ref: GithubRef,
  ) => Effect.Effect<Omit<GithubLinkState, "link">, KinDeferralGithubError>;
}

// Kin has no GitHub client yet, so production reads fail and every recheck with
// GitHub links reports "couldn't verify", which asks instead of starting.
export const KinDeferralGithubReader = Context.Reference<KinDeferralGithubReaderShape>(
  "t3/kin/triggers/deferralGithub/KinDeferralGithubReader",
  {
    defaultValue: () => ({
      read: (orgId) => Effect.fail(new KinDeferralGithubError({ orgId, reason: "unavailable" })),
    }),
  },
);

const urlRef = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)\/?$/;
const shortRef = /^([\w.-]+\/[\w.-]+)#(\d+)$/;

export function githubRef(link: string): GithubRef | undefined {
  const match = urlRef.exec(link) ?? shortRef.exec(link);
  if (match === null) return undefined;
  const number = Number(match[2]);
  return Number.isSafeInteger(number) && number > 0 ? { repo: match[1]!, number } : undefined;
}

/** Reads every GitHub link; `null` means at least one couldn't be read. */
export const readGithubLinks = Effect.fn("KinDeferralGithub.readLinks")(function* (
  orgId: KinOrgId,
  links: ReadonlyArray<string>,
) {
  const reader = yield* KinDeferralGithubReader;
  const states: Array<GithubLinkState> = [];
  for (const link of links) {
    const ref = githubRef(link);
    if (ref === undefined) continue;
    const state = yield* reader.read(orgId, ref).pipe(Effect.option);
    if (state._tag === "None") return null;
    states.push({
      link,
      state: state.value.state,
      assignees: state.value.assignees.toSorted(),
      linkedPrs: state.value.linkedPrs.toSorted((a, b) => a - b),
    });
  }
  return states;
});
