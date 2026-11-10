import * as Crypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  KinOrgId,
  KinWebhookSourceId,
  ProjectId,
  type KinGithubWebhookSecretInput,
  type KinGithubWebhookSetup,
  type KinGithubWebhookStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as TestConsole from "effect/testing/TestConsole";

import {
  type KinAppEvents,
  type KinWebhookRemote,
  readSecret,
  runSetSecret,
  runSetup,
  runStatus,
} from "./githubWebhook.ts";

const orgId = KinOrgId.make("kin-default");
const projectId = ProjectId.make("project-1");
const sourceId = KinWebhookSourceId.make("github-app");
const url = "https://relay.test/v1/hooks/env/hook-1/token-1";
const on = (secretBound: boolean): KinGithubWebhookStatus => ({
  status: "on",
  sourceId,
  projectId,
  url,
  enabled: true,
  secretBound,
  lastDelivery: null,
});

const fakeRemote = (options: {
  readonly before: KinGithubWebhookStatus;
  readonly setup: KinGithubWebhookSetup;
}) => {
  const secrets: KinGithubWebhookSecretInput[] = [];
  const remote: KinWebhookRemote = {
    status: () => Effect.succeed(options.before),
    setup: () => Effect.succeed(options.setup),
    setSecret: (input) =>
      Effect.sync(() => {
        secrets.push(input);
        return { status: "configured", sourceId, url } as const;
      }),
    rotate: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
  };
  return { remote, secrets };
};

// Every log line at every level, so a secret that reached the logger would show up here.
const captureLogs = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const lines: string[] = [];
  return effect.pipe(
    Effect.provide(
      Logger.layer([Logger.map(Logger.formatJson, (line) => void lines.push(line))], {
        mergeWithExisting: false,
      }),
    ),
    Effect.provideService(References.MinimumLogLevel, "All"),
    Effect.map((result) => ({ result, lines })),
  );
};

const output = Effect.map(
  Effect.all([TestConsole.logLines, TestConsole.errorLines]),
  ([logs, errors]) => [...logs, ...errors].map(String).join("\n"),
);

const occurrences = (text: string, part: string) => text.split(part).length - 1;

describe("kin github webhook", () => {
  it.effect(
    "setup binds a new secret and shows it once, only on stdout, when GitHub has none",
    () =>
      Effect.gen(function* () {
        const { remote, secrets } = fakeRemote({
          before: { status: "off" },
          setup: { status: "needs_secret", sourceId, url },
        });
        const { lines } = yield* captureLogs(
          runSetup(remote, { orgId, projectId, newSecret: false, interactive: true }),
        );
        assert.lengthOf(secrets, 1);
        const secret = Redacted.value(secrets[0]!.secret);
        assert.match(secret, /^[0-9a-f]{64}$/);
        const printed = yield* output;
        assert.strictEqual(occurrences(printed, secret), 1);
        assert.include(printed, url);
        assert.include(printed, "Pull request review comment");
        assert.include(printed, "Workflow run");
        assert.notInclude(lines.join("\n"), secret);
      }).pipe(Effect.provide(Crypto.layer)),
  );

  it.effect("setup keeps a bound secret unless --new-secret asks for one", () =>
    Effect.gen(function* () {
      const kept = fakeRemote({
        before: on(true),
        setup: { status: "needs_secret", sourceId, url },
      });
      yield* runSetup(kept.remote, { orgId, projectId, newSecret: false, interactive: true });
      assert.lengthOf(kept.secrets, 0);
      assert.include(yield* output, "the secret is unchanged");
      const rekeyed = fakeRemote({
        before: on(true),
        setup: { status: "needs_secret", sourceId, url },
      });
      yield* runSetup(rekeyed.remote, { orgId, projectId, newSecret: true, interactive: true });
      assert.lengthOf(rekeyed.secrets, 1);
      // A source whose secret no longer matches gets a new one without asking.
      const broken = fakeRemote({
        before: on(false),
        setup: { status: "needs_secret", sourceId, url },
      });
      yield* runSetup(broken.remote, { orgId, projectId, newSecret: false, interactive: true });
      assert.lengthOf(broken.secrets, 1);
    }).pipe(Effect.provide(Crypto.layer)),
  );

  it.effect("setup never makes or prints a secret off a terminal or without T3 Connect", () =>
    Effect.gen(function* () {
      const piped = fakeRemote({
        before: { status: "off" },
        setup: { status: "needs_secret", sourceId, url },
      });
      const offTerminal = yield* Effect.flip(
        runSetup(piped.remote, { orgId, projectId, newSecret: false, interactive: false }),
      );
      assert.lengthOf(piped.secrets, 0);
      assert.include(offTerminal.message, "set-secret");
      assert.include(offTerminal.message, url);
      const unlinked = fakeRemote({
        before: { status: "off" },
        setup: { status: "needs_connect" },
      });
      const connect = yield* Effect.flip(
        runSetup(unlinked.remote, { orgId, projectId, newSecret: false, interactive: true }),
      );
      assert.lengthOf(unlinked.secrets, 0);
      assert.include(connect.message, "T3 Connect");
    }).pipe(Effect.provide(Crypto.layer)),
  );

  it.effect("set-secret takes the piped secret and never echoes it", () =>
    Effect.gen(function* () {
      const secret = "owner-chosen-secret-0123456789";
      const text = yield* readSecret.pipe(
        // Test stdin is not a terminal, so the prompt's Terminal is never used.
        Effect.provide(
          Layer.provideMerge(
            Stdio.layerTest({ stdin: Stream.make(new TextEncoder().encode(`${secret}\n`)) }),
            NodeServices.layer,
          ),
        ),
      );
      const { remote, secrets } = fakeRemote({
        before: on(true),
        setup: { status: "needs_secret", sourceId, url },
      });
      const { lines } = yield* captureLogs(runSetSecret(remote, orgId, text));
      assert.strictEqual(Redacted.value(secrets[0]!.secret), secret);
      const short = "short secret";
      const refused = yield* Effect.flip(runSetSecret(remote, orgId, short));
      assert.lengthOf(secrets, 1);
      const printed = yield* output;
      assert.include(printed, url);
      for (const value of [secret, short]) {
        assert.notInclude(printed, value);
        assert.notInclude(lines.join("\n"), value);
        assert.notInclude(refused.message, value);
      }
    }),
  );

  it.effect("status names what stops deliveries, the App's missing events included", () =>
    Effect.gen(function* () {
      const remote = (status: KinGithubWebhookStatus) =>
        fakeRemote({ before: status, setup: { status: "needs_connect" } }).remote;
      const events = (missing: ReadonlyArray<string>): Effect.Effect<KinAppEvents> =>
        Effect.succeed({ _tag: "checked", slug: "kin-by-questili", missing, extra: [] });
      yield* runStatus(remote(on(true)), orgId, events([]));
      assert.include(yield* output, "all 8 subscribed");
      const missing = yield* Effect.flip(
        runStatus(remote(on(true)), orgId, events(["push", "workflow_run"])),
      );
      assert.include(missing.message, "App events missing");
      assert.include(yield* output, "missing push, workflow_run");
      const off = yield* Effect.flip(runStatus(remote({ status: "off" }), orgId, events([])));
      assert.include(off.message, "no GitHub source");
      const unbound = yield* Effect.flip(runStatus(remote(on(false)), orgId, events([])));
      assert.include(unbound.message, "no secret");
    }),
  );
});
