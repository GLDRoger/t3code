import type {
  KinGitHubAppReposResult,
  KinGitHubAppReposSetInput,
  KinGitHubRepo,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatError } from "@t3tools/contracts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { type ApiAnswer, KinGitHubApi } from "./GitHubWatch.ts";
import { knownRepos } from "./githubWatchStore.ts";
import type { AppState, KinGitHubApp } from "./KinGitHubApp.ts";

/**
 * The owner's choice of repos for Kin's App on an account picked repo by repo, made in Settings
 * with his own GitHub login (GitHub takes these only from a user, never from the App). Agents only
 * read the result: no Kin tool reaches this.
 */

const decodeMessage = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }));

/** GitHub's answer to one add or remove, in words for the owner; undefined when it worked. */
const refusal = (answer: ApiAnswer, repo: string, account: string, on: boolean) => {
  if (answer.status === 204 || answer.status === 304) return undefined;
  const said = Option.match(decodeMessage(answer.body), {
    onNone: () => "",
    onSome: ({ message }) => ` GitHub said: "${message}".`,
  });
  if (answer.status === 0)
    return `Kin couldn't reach GitHub, so ${repo} is as it was. Try again in a moment.`;
  if (answer.status === 422 && !on)
    return `GitHub keeps at least one repo on an App picked repo by repo, so ${repo} stays. To take the App off ${account} altogether, uninstall it on GitHub.`;
  if (answer.status === 403 || answer.status === 401)
    return `GitHub refused to change ${repo}: it takes this only from someone with admin on the repo, signed in with a login it accepts for it.${said} Change it on the App's page on GitHub instead.`;
  if (answer.status === 404)
    return `GitHub can't find ${repo} or the App's installation for your login.${said} Change it on the App's page on GitHub instead.`;
  return `GitHub refused to change ${repo} (status ${answer.status}).${said}`;
};

/** Who agents work as on each repo, for Connections and the agent's own `kin_github_watch`. */
export const withAgentsAs = (
  repos: ReadonlyArray<KinGitHubRepo>,
  state: AppState,
): ReadonlyArray<KinGitHubRepo> =>
  repos.map((repo) => ({
    ...repo,
    agentsAs:
      state._tag === "ok" &&
      state.app.installations.some(
        (entry) => !entry.suspended && entry.repos.has(repo.repo.toLowerCase()),
      )
        ? "app"
        : "owner",
  }));

export const setAppRepos = Effect.fn("KinGitHubApp.setRepos")(function* (
  app: KinGitHubApp["Service"],
  person: PersonIdentity,
  input: KinGitHubAppReposSetInput,
) {
  const api = yield* KinGitHubApi;
  const sql = yield* SqlClient.SqlClient;
  const refreshes = yield* KinRefreshObserver;
  const refuse = (message: string) => new KinChatError({ reason: "not_allowed", message });
  const state = yield* app.state();
  if (state._tag !== "ok")
    return yield* refuse("Kin has no working GitHub App, so there is nothing to put on a repo.");
  const account = input.account.toLowerCase();
  const installation = state.app.installations.find((entry) => entry.account === account);
  if (installation === undefined)
    return yield* refuse(
      `${state.app.name} isn't installed on ${input.account} yet. Install it there first, from its row.`,
    );
  if (installation.selection === "all")
    return yield* refuse(
      `${state.app.name} is on all of ${input.account}'s repositories already. To pick them one by one, choose Only select repositories on its page on GitHub.`,
    );
  if (installation.suspended)
    return yield* refuse(
      `${state.app.name} is suspended on ${input.account}. Unsuspend it on GitHub first.`,
    );
  const ids = new Map(
    (yield* knownRepos(input.orgId)).flatMap((entry) =>
      entry.id === undefined ? [] : [[entry.repo.toLowerCase(), entry.id] as const],
    ),
  );
  const [named] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
    WHERE org_id = ${input.orgId} AND person_id = ${person.personId}`;
  const verb = input.on ? "PUT" : "DELETE";
  let changed = 0;
  let problem: string | null = null;
  for (const repo of new Set(input.repos.map((name) => name.toLowerCase()))) {
    if (repo.split("/")[0] !== account) continue;
    if (installation.repos.has(repo) === input.on) continue;
    const id = ids.get(repo);
    if (id === undefined) {
      problem ??= `Kin doesn't know ${repo} yet; it lists repos again within a few hours.`;
      continue;
    }
    const answer = yield* api.call({
      method: verb,
      path: `user/installations/${installation.id}/repositories/${id}`,
    });
    const refused = refusal(answer, repo, input.account, input.on);
    if (refused !== undefined) {
      problem ??= refused;
      continue;
    }
    changed += 1;
    const at = yield* Clock.currentTimeMillis;
    yield* sql`INSERT INTO kin_github_owner_uses (org_id, use_id, at, agent_name, repo, command)
      VALUES (${input.orgId}, ${`app-${at}-${verb}-${repo}`}, ${at}, ${named?.name ?? null},
        ${repo}, ${`${input.on ? "Put" : "Took"} ${state.app.name} ${input.on ? "on" : "off"} this repo in Settings`})
      ON CONFLICT DO NOTHING`;
  }
  // What GitHub holds now, not what Kin asked for: the rows, the tokens and the shells follow.
  if (changed > 0) yield* app.lookAgain();
  yield* refreshes.touch(input.orgId, "connections");
  return { changed, problem } satisfies KinGitHubAppReposResult;
});
