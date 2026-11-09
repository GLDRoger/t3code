import { KinOrgId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
   * Read-only and batched: one call per repo for all of its numbers. Numbers GitHub doesn't have,
   * or can't report in full, are left out. The caller bounds the time.
   */
  readonly readRepo: (
    orgId: KinOrgId,
    repo: string,
    numbers: ReadonlyArray<number>,
  ) => Effect.Effect<ReadonlyMap<number, Omit<GithubLinkState, "link">>, KinDeferralGithubError>;
}

// githubReaders.ts replaces this when the Kin App is configured. Without it every read fails,
// so a recheck with GitHub links reports "couldn't verify", which asks instead of starting.
export const KinDeferralGithubReader = Context.Reference<KinDeferralGithubReaderShape>(
  "t3/kin/triggers/deferralGithub/KinDeferralGithubReader",
  {
    defaultValue: () => ({
      readRepo: (orgId) =>
        Effect.fail(new KinDeferralGithubError({ orgId, reason: "unavailable" })),
    }),
  },
);

// Callers hold the org memory lock, so every GitHub read for one sync shares this budget.
const READ_BUDGET = "10 seconds";
const READ_CONCURRENCY = 4;

const urlRef = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)\/?$/;
const shortRef = /^([\w.-]+\/[\w.-]+)#(\d+)$/;

export function githubRef(link: string): GithubRef | undefined {
  const match = urlRef.exec(link) ?? shortRef.exec(link);
  if (match === null) return undefined;
  const number = Number(match[2]);
  return Number.isSafeInteger(number) && number > 0 ? { repo: match[1]!, number } : undefined;
}

const refKey = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;

/**
 * Reads the GitHub links of each list with one call per repo, all within one budget. A list is
 * `null` when any of its links couldn't be read in time.
 */
export const readGithubLinkSets = Effect.fn("KinDeferralGithub.readLinkSets")(function* (
  orgId: KinOrgId,
  linkSets: ReadonlyArray<ReadonlyArray<string>>,
) {
  const reader = yield* KinDeferralGithubReader;
  const byRepo = new Map<string, { readonly repo: string; readonly numbers: Set<number> }>();
  for (const links of linkSets)
    for (const link of links) {
      const ref = githubRef(link);
      if (ref === undefined) continue;
      const key = ref.repo.toLowerCase();
      const entry = byRepo.get(key) ?? { repo: ref.repo, numbers: new Set<number>() };
      entry.numbers.add(ref.number);
      byRepo.set(key, entry);
    }
  const read = new Map<string, Omit<GithubLinkState, "link">>();
  yield* Effect.forEach(
    byRepo.values(),
    ({ repo, numbers }) =>
      reader
        .readRepo(
          orgId,
          repo,
          [...numbers].toSorted((a, b) => a - b),
        )
        .pipe(
          Effect.tap((states) =>
            Effect.sync(() => {
              for (const [number, state] of states)
                if (numbers.has(number)) read.set(refKey(repo, number), state);
            }),
          ),
          Effect.catch((error) =>
            Effect.logWarning("Kin deferral GitHub read failed", {
              orgId,
              repo,
              reason: error.reason,
            }),
          ),
        ),
    { concurrency: READ_CONCURRENCY, discard: true },
  ).pipe(
    Effect.timeoutOption(READ_BUDGET),
    Effect.tap((done) =>
      Option.isNone(done)
        ? Effect.logWarning("Kin deferral GitHub reads ran out of time", { orgId })
        : Effect.void,
    ),
  );
  return linkSets.map((links): ReadonlyArray<GithubLinkState> | null => {
    const states: Array<GithubLinkState> = [];
    for (const link of links) {
      const ref = githubRef(link);
      if (ref === undefined) continue;
      const state = read.get(refKey(ref.repo, ref.number));
      if (state === undefined) return null;
      states.push({
        link,
        state: state.state,
        assignees: state.assignees.toSorted(),
        linkedPrs: state.linkedPrs.toSorted((a, b) => a - b),
      });
    }
    return states;
  });
});

/** Reads every GitHub link; `null` means at least one couldn't be read. */
export const readGithubLinks = (orgId: KinOrgId, links: ReadonlyArray<string>) =>
  readGithubLinkSets(orgId, [links]).pipe(Effect.map(([states]) => states ?? null));
