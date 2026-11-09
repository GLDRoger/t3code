// Kin's GitHub App: create it (manifest flow), `--check` its permissions against the approvals
// spec table, or `--merge-token` to store the owner's token. Run on the Kin host as the server's
// OS user; secrets go only to that user's keychain. The command is apps/server/src/kin/github/
// appSetup.ts, loaded by URL because the scripts project can't include server files.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { Command } from "effect/cli";

const setup: {
  readonly kinGitHubAppCommand: Command.Command<"kin-github-app", unknown, never, never>;
} = await import(new URL("../apps/server/src/kin/github/appSetup.ts", import.meta.url).href);

Command.run(setup.kinGitHubAppCommand, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
