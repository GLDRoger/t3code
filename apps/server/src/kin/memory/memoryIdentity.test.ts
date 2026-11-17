import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { AppState, KinGitHubApp } from "../github/KinGitHubApp.ts";
import { BOT_EMAIL, BOT_LOGIN } from "../github/KinGitHubApp.testkit.ts";
import { memoryIdentity } from "./memoryIdentity.ts";

const appIn = (state: AppState) =>
  Option.some<KinGitHubApp["Service"]>({
    state: () => Effect.succeed(state),
    on: () => Effect.undefined,
    refresh: () => Effect.void,
    lookAgain: () => Effect.void,
  });

const working: AppState = {
  _tag: "ok",
  app: {
    name: "Invented Kin",
    botLogin: BOT_LOGIN,
    botEmail: BOT_EMAIL,
    slug: "invented-kin",
    installUrl: "https://github.com/apps/invented-kin/installations/new",
    owner: "invented-owner",
    public: true,
    installations: [],
  },
};

const author = (identity: { GIT_AUTHOR_NAME: string; GIT_AUTHOR_EMAIL: string }) =>
  `${identity.GIT_AUTHOR_NAME} <${identity.GIT_AUTHOR_EMAIL}>`;

describe("memory commits' author", () => {
  it.effect("is the App's bot in GitHub's form while the App works, else Kin's local name", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        author(yield* memoryIdentity({}, appIn(working))),
        `${BOT_LOGIN} <${BOT_EMAIL}>`,
      );
      for (const app of [
        Option.none<KinGitHubApp["Service"]>(),
        appIn({ _tag: "none" }),
        appIn({ _tag: "broken", problem: "no key" }),
      ])
        assert.strictEqual(
          author(yield* memoryIdentity({}, app)),
          "Kin Memory Bot <kin-memory@localhost>",
        );
      const configured = yield* memoryIdentity(
        { botName: "Invented Writer", botEmail: "writer@invented.example" },
        appIn(working),
      );
      assert.strictEqual(author(configured), "Invented Writer <writer@invented.example>");
      assert.strictEqual(configured.GIT_COMMITTER_EMAIL, "writer@invented.example");
    }),
  );
});
