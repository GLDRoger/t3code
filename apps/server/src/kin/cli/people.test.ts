import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { KinChatError, KinInviteId } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Runtime from "effect/Runtime";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";

import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../../serverRuntimeState.ts";
import { peopleCommand } from "./people.ts";

const invite = {
  inviteId: KinInviteId.make("inv-1"),
  personId: null,
  displayName: "Asha",
  handle: "asha",
  createdAt: "2026-11-25T10:00:00.000Z",
  expiresAt: "2026-12-02T10:00:00.000Z",
};
const notFound = new KinChatError({ reason: "not_found", message: "Kin record not found." });
const client = {
  "kin.people.listInvites": vi.fn(({ orgId }: { readonly orgId: string }) =>
    orgId === "nope" ? Effect.fail(notFound) : Effect.succeed({ invites: [invite] }),
  ),
  "kin.people.revokeInvite": vi.fn(() => Effect.fail(notFound)),
  "kin.people.createInvite": vi.fn(({ personId }: { readonly personId?: string }) =>
    personId === undefined ? Effect.die("no invite expected") : Effect.fail(notFound),
  ),
};

vi.mock("./openRemote.ts", () => ({
  openRemote: () => Effect.succeed(client),
  remoteLayer: () => Layer.empty,
}));

const layer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  NetService.layer,
  TestConsole.layer,
  ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true })),
);

const run = (args: ReadonlyArray<string>) =>
  Command.runWith(peopleCommand, { version: "0.0.0" })(args);

const runningHost = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "kin-people-cli-" });
  yield* persistServerRuntimeState({
    path: path.join(baseDir, "userdata", "server-runtime.json"),
    state: yield* makePersistedServerRuntimeState({
      config: { host: "127.0.0.1", devUrl: undefined },
      port: 3_773,
    }),
  });
  return baseDir;
});

it.effect("describes the command and each subcommand in --help", () =>
  Effect.gen(function* () {
    yield* run(["--help"]);
    const help = (yield* TestConsole.logLines).join("\n");
    for (const line of [
      "Invite people to this host's Kin",
      "invites          List the org's invites",
      "revoke-invite    Revoke an invite",
      "invite           Create an invite and print its link",
    ])
      expect(help).toContain(line);
  }).pipe(Effect.provide(layer)),
);

it.effect("invites prints a plain list, and JSON only with --json", () =>
  Effect.gen(function* () {
    const baseDir = yield* runningHost;
    yield* run(["invites", "--base-dir", baseDir]);
    expect((yield* TestConsole.logLines).at(-1)).toBe(
      "Asha (@asha), invite inv-1, expires 2026-12-02T10:00:00.000Z",
    );
    yield* run(["invites", "--json", "--base-dir", baseDir]);
    expect(JSON.parse(String((yield* TestConsole.logLines).at(-1)))).toEqual({
      invites: [invite],
    });
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("a refusal is one plain stderr line the runtime does not report again", () =>
  Effect.gen(function* () {
    const baseDir = yield* runningHost;
    for (const [args, line] of [
      [["invites", "--org", "nope"], "No org nope on this host."],
      [["revoke-invite", "missing"], "No open invite missing in org kin-default."],
      [
        ["invite", "Asha", "--person", "typo", "--url", "https://kin.example"],
        "No person typo in org kin-default on this host.",
      ],
    ] as const) {
      const before = (yield* TestConsole.errorLines).length;
      const error = yield* run([...args, "--base-dir", baseDir]).pipe(Effect.flip);
      expect((yield* TestConsole.errorLines).slice(before)).toEqual([line]);
      expect((error as { readonly [Runtime.errorReported]?: boolean })[Runtime.errorReported]).toBe(
        false,
      );
    }
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("invite refuses a blank name before reaching the server", () =>
  Effect.gen(function* () {
    const baseDir = yield* runningHost;
    yield* run(["invite", "", "--base-dir", baseDir]).pipe(Effect.ignore);
    expect(client["kin.people.createInvite"]).not.toHaveBeenCalled();
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
