// Kin's GitHub rulesets (approvals spec section 10): apply them, `--check` them for drift,
// `--codeowners`, or `--test-23` on a scratch repo. Runs on the owner's own GitHub sign-in
// (GH_TOKEN or a hidden prompt) and refuses the bot's. The command is apps/server/src/kin/github/
// rulesetsSetup.ts, loaded by URL because the scripts project can't include server files.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { Command } from "effect/cli";

const setup: {
  readonly kinRulesetsCommand: Command.Command<"kin-rulesets", unknown, never, never>;
} = await import(new URL("../apps/server/src/kin/github/rulesetsSetup.ts", import.meta.url).href);

Command.run(setup.kinRulesetsCommand, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
