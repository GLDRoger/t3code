import { RepoSlug } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const GitHubLogin = Schema.String.check(
  Schema.makeFilter(
    (value: string) =>
      /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/.test(value),
    { expected: "a GitHub login" },
  ),
);

/** The owner's personal GitHub login; also read alone by the App setup command. */
export const KinGitHubOwnerLogin = Config.schema(GitHubLogin, "KIN_GITHUB_OWNER_LOGIN");

/** Who Kin acts for and where (approvals spec sections 10 and 12). */
export class KinGitHubScope extends Context.Service<
  KinGitHubScope,
  {
    /** The only login the owner merge token may belong to. */
    readonly ownerLogin: string;
    /** The only login T3 and the agent CLIs it spawns may use on github.com. */
    readonly botLogin: string;
    /** The repositories Kin works on. Tokens are minted and probed for these only. */
    readonly repos: ReadonlyArray<RepoSlug>;
  }
>()("t3/kin/github/KinGitHubScope") {
  static readonly layer = Layer.effect(
    KinGitHubScope,
    Config.all({
      ownerLogin: KinGitHubOwnerLogin,
      botLogin: Config.schema(GitHubLogin, "KIN_GITHUB_BOT_LOGIN"),
      // Comma-separated owner/name slugs. Empty means no repository is in scope.
      repos: Config.Array(RepoSlug, "KIN_GITHUB_REPOS"),
    }),
  );
}

export const isScopedRepo = (repos: ReadonlyArray<RepoSlug>, repo: string) =>
  repos.some((scoped) => scoped.toLowerCase() === repo.toLowerCase());
