// @effect-diagnostics nodeBuiltinImport:off - a one-shot loopback server and random state for GitHub's manifest flow.
// The CLI behind scripts/kin-github-app.ts. It lives in the server project so it typechecks with
// the modules it shares; the script only launches it.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import { KinOrgId } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Command, Flag, Prompt } from "effect/cli";
import { FetchHttpClient, HttpClient } from "effect/http";

import { gitHubJson } from "./githubRest.ts";
import * as Keychain from "./Keychain.ts";
import * as KinGitHubApp from "./KinGitHubApp.ts";
import {
  KIN_GITHUB_APP_EVENTS,
  buildAppManifest,
  diffAppPermissions,
  type KinPermissionDiffLine,
} from "./KinGitHubPermissions.ts";
import { KinGitHubOwnerLogin, KinGitHubScope } from "./KinGitHubScope.ts";
import * as OwnerMergeClient from "./OwnerMergeClient.ts";

const DEFAULT_PORT = 47821;

export interface SetupResult {
  readonly ok: boolean;
  readonly lines: ReadonlyArray<string>;
}

const ConversionResponse = Schema.Struct({
  id: Schema.Int,
  slug: Schema.String,
  owner: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  pem: Schema.String,
  webhook_secret: Schema.NullOr(Schema.String),
  client_id: Schema.String,
  client_secret: Schema.String,
  permissions: Schema.Record(Schema.String, Schema.String),
});
const encodeSecrets = Schema.encodeEffect(Schema.fromJsonString(KinGitHubApp.KinGitHubAppSecrets));
const decodeOrgId = Schema.decodeEffect(KinOrgId);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const formatDiff = (lines: ReadonlyArray<KinPermissionDiffLine>) =>
  lines.map((line) => {
    const verdict = line.status === "ok" ? "ok  " : "FAIL";
    const detail = line.status === "ok" ? "" : ` ${line.status}${line.why ? `: ${line.why}` : ""}`;
    return `  ${verdict} ${line.permission.padEnd(28)} ${line.actual.padEnd(5)} (table: ${line.expected})${detail}`;
  });

/** `--check`: the App's and each installation's permissions against the table. */
export const checkApp = Effect.gen(function* () {
  const github = yield* KinGitHubApp.KinGitHubApp;
  const app = yield* github.app;
  const installations = yield* github.installations;
  const appDiff = diffAppPermissions(app.permissions);
  let ok = appDiff.every((line) => line.status === "ok");
  const missingEvents = KIN_GITHUB_APP_EVENTS.filter((event) => !app.events.includes(event));
  const lines = [
    `App ${app.slug} (${app.id}), owned by ${app.owner?.login ?? "unknown"}`,
    "Permissions:",
    ...formatDiff(appDiff),
    `Webhook events: ${app.events.length === 0 ? "none" : app.events.toSorted().join(", ")}${missingEvents.length === 0 ? "" : ` (not subscribed: ${missingEvents.join(", ")})`}`,
  ];
  if (installations.length === 0) {
    ok = false;
    lines.push("FAIL not installed: install it on the Kin repositories only.");
  }
  for (const installation of installations) {
    const diff = diffAppPermissions(installation.permissions);
    const selected = installation.repository_selection === "selected";
    const matches = diff.every((line) => line.status === "ok");
    ok &&= selected && matches;
    lines.push(
      `Installation ${installation.id} on ${installation.account?.login ?? "unknown"}: ${selected ? "selected repositories" : "FAIL all repositories (choose Only select repositories)"}`,
    );
    if (!matches) {
      lines.push(
        "  FAIL its accepted permissions differ from the table (review the pending request in the installation's settings):",
        ...formatDiff(diff).map((line) => `  ${line}`),
      );
    }
  }
  lines.push(ok ? "PASS: permissions match the approvals spec table." : "FAIL: see above.");
  return { ok, lines } satisfies SetupResult;
}).pipe(Effect.withSpan("kinGitHubApp.check"));

/**
 * Finishes the manifest flow. Secrets go to the keychain only when the App's permissions match the
 * table and its owner is `expectedOwner`; only public facts come back.
 */
export const completeManifest = Effect.fn("kinGitHubApp.completeManifest")(function* (
  code: string,
  expectedOwner: string,
) {
  const client = yield* HttpClient.HttpClient;
  const keychain = yield* Keychain.KinKeychain;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(code)) {
    return {
      ok: false,
      lines: ["GitHub's redirect carried no usable code."],
    } satisfies SetupResult;
  }
  const converted = yield* gitHubJson({
    client,
    operation: "appManifests.conversion",
    method: "POST",
    path: `/app-manifests/${code}/conversions`,
    schema: ConversionResponse,
    okStatuses: [201],
  });
  const app = converted.body;
  const diff = diffAppPermissions(app.permissions);
  const owner = app.owner?.login ?? "unknown";
  const ownerMatches = owner.toLowerCase() === expectedOwner.toLowerCase();
  if (!ownerMatches || !diff.every((line) => line.status === "ok")) {
    return {
      ok: false,
      lines: [
        `GitHub created ${app.slug} (App id ${app.id}) owned by ${owner}, but Kin did not store its keys:`,
        ...(ownerMatches ? [] : [`  FAIL owner ${owner} is not ${expectedOwner}`]),
        ...formatDiff(diff),
        `Delete it at https://github.com/settings/apps/${app.slug}/advanced (or the org's settings) and run this again.`,
      ],
    } satisfies SetupResult;
  }
  const secrets = yield* encodeSecrets({
    privateKeyPem: app.pem,
    ...(app.webhook_secret === null ? {} : { webhookSecret: app.webhook_secret }),
    clientId: app.client_id,
    clientSecret: app.client_secret,
  });
  yield* keychain.set("kin-github-app", String(app.id), Redacted.make(secrets));
  return {
    ok: true,
    lines: [
      `Created ${app.slug} (App id ${app.id}) owned by ${owner}.`,
      "Its private key, webhook secret and client secret are in this user's OS keychain (kin-github-app).",
      "Permissions:",
      ...formatDiff(diff),
      `Next: install it on the Kin repositories only (Only select repositories): https://github.com/apps/${app.slug}/installations/new`,
      `Then set KIN_GITHUB_APP_ID=${app.id} for the Kin server and run: node scripts/kin-github-app.ts --check`,
    ],
  } satisfies SetupResult;
});

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** Loopback only; a forwarded port over SSH still arrives with one of these hosts. */
export const isLoopbackHost = (host: string | undefined, port: number) =>
  host === `127.0.0.1:${port}` || host === `localhost:${port}`;

// Local race: any process on this host can reach the port. Another user could read `state` from
// the form and send a callback with a code for an App they made; the owner and permission checks
// in completeManifest refuse that App. A process that holds the port first makes listen fail.
const createApp = Effect.fn("kinGitHubApp.create")(function* (input: {
  readonly port: number;
  readonly org: Option.Option<string>;
  readonly name: string;
  readonly webhookUrl: Option.Option<string>;
}) {
  // Before GitHub makes the key: the conversion answer is the only copy of it.
  yield* (yield* Keychain.KinKeychain).ready("kin-github-app");
  const expectedOwner = Option.isSome(input.org) ? input.org.value : yield* KinGitHubOwnerLogin;
  const state = NodeCrypto.randomBytes(32).toString("base64url");
  const origin = `http://127.0.0.1:${input.port}`;
  const manifest = yield* encodeJson(
    buildAppManifest({
      name: input.name,
      homepageUrl: "https://github.com/GLDRoger/t3code",
      redirectUrl: `${origin}/callback`,
      webhookUrl: Option.getOrUndefined(input.webhookUrl),
    }),
  );
  const action = Option.match(input.org, {
    onNone: () => "https://github.com/settings/apps/new",
    onSome: (org) =>
      `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`,
  });
  const form = `<!doctype html><meta charset="utf-8"><title>Create Kin GitHub App</title>
<form method="post" action="${escapeHtml(`${action}?state=${state}`)}">
<input type="hidden" name="manifest" value="${escapeHtml(manifest)}">
<p>Creates a private GitHub App with the permissions in docs/kin/specs/approvals.md section 10.</p>
<button type="submit">Create the Kin GitHub App on GitHub</button></form>`;
  const context = yield* Effect.context<HttpClient.HttpClient | Keychain.KinKeychain>();
  const finish = (code: string) =>
    Effect.runPromiseWith(context)(
      completeManifest(code, expectedOwner).pipe(
        Effect.catch((error) => Effect.succeed({ ok: false, lines: [error.message] })),
      ),
    );

  yield* Console.log(
    `Open ${origin}/ in a browser signed in to GitHub as the App's owner${Option.isSome(input.org) ? ` (an admin of ${input.org.value})` : ""}.\nOver SSH, forward the port first: ssh -L ${input.port}:127.0.0.1:${input.port} <kin-host>`,
  );
  return yield* Effect.callback<SetupResult>((resume) => {
    let used = false;
    const server = NodeHttp.createServer((request, response) => {
      const url = new URL(request.url ?? "/", origin);
      const send = (status: number, body: string) => {
        response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
        response.end(body);
      };
      if (!isLoopbackHost(request.headers.host, input.port)) return send(421, "Wrong host");
      if (url.pathname === "/" && request.method === "GET") return send(200, form);
      if (url.pathname !== "/callback") return send(404, "Not found");
      // One redirect, from the form this run served; anything else is a stale or forged link.
      if (used || url.searchParams.get("state") !== state) {
        return send(400, "This link is stale or was not started by this script.");
      }
      used = true;
      void finish(url.searchParams.get("code") ?? "").then((done) => {
        send(done.ok ? 200 : 500, `<pre>${escapeHtml(done.lines.join("\n"))}</pre>`);
        server.close();
        resume(Effect.succeed(done));
      });
    });
    server.once("error", (error) => {
      resume(
        Effect.succeed({ ok: false, lines: [`Could not listen on ${origin}: ${error.message}`] }),
      );
    });
    server.listen(input.port, "127.0.0.1");
    return Effect.sync(() => server.close());
  });
});

const storeMergeToken = Effect.fn("kinGitHubApp.storeMergeToken")(function* (
  orgId: KinOrgId,
  probePr: number | undefined,
) {
  yield* (yield* Keychain.KinKeychain).ready("kin-owner-merge");
  yield* Console.log(
    "Make a fine-grained token at https://github.com/settings/personal-access-tokens/new\n" +
      "  Resource owner: the account that owns the Kin repositories.\n" +
      "  Repository access: Only select repositories, exactly KIN_GITHUB_REPOS. Expiration: 90 days.\n" +
      "  Permissions: Contents: Read and write, Metadata: Read. Nothing else, so it can't review.\n" +
      "Kin checks that GitHub refuses the token administration, webhooks, secrets and reviews\n" +
      "before storing it. The review check uses PR #1 unless --probe-pr names an existing PR.",
  );
  const token = yield* Prompt.run(Prompt.Hidden({ message: "Paste the token (hidden)" }));
  const merge = yield* OwnerMergeClient.OwnerMergeClient;
  const saved = yield* merge.save({ orgId, token, probePr });
  return {
    ok: true,
    lines: [
      `Stored the merge token for ${saved.login} in the OS keychain (kin-owner-merge/${orgId}).`,
      `It expires ${DateTime.formatIso(DateTime.makeUnsafe(saved.expiresAt))}; Kin warns 7 days before.`,
    ],
  } satisfies SetupResult;
});

const failed = (error: { readonly message: string }) =>
  Effect.succeed({ ok: false, lines: [error.message] } satisfies SetupResult);

/** @public Run by scripts/kin-github-app.ts, which loads this file by URL. */
export const kinGitHubAppCommand = Command.make(
  "kin-github-app",
  {
    check: Flag.Boolean("check").pipe(
      Flag.withDescription("Diff the App's permissions against the approvals spec table."),
      Flag.withDefault(false),
    ),
    mergeToken: Flag.Boolean("merge-token").pipe(
      Flag.withDescription("Store the owner's fine-grained merge token in the OS keychain."),
      Flag.withDefault(false),
    ),
    probePr: Flag.Int("probe-pr").pipe(
      Flag.withDescription(
        "An existing PR number in every Kin repo for --merge-token's review check.",
      ),
      Flag.optional,
    ),
    appId: Flag.String("app-id").pipe(
      Flag.withDescription("The App id for --check; defaults to KIN_GITHUB_APP_ID."),
      Flag.optional,
    ),
    kinOrg: Flag.String("kin-org").pipe(
      Flag.withDescription("The Kin org id the merge token belongs to."),
      Flag.optional,
    ),
    org: Flag.String("org").pipe(
      Flag.withDescription("Create the App under this GitHub organization, not your account."),
      Flag.optional,
    ),
    name: Flag.String("name").pipe(
      Flag.withDescription("The App's name on GitHub, which must be unique across GitHub."),
      Flag.withDefault("Kin GLDRoger"),
    ),
    webhookUrl: Flag.String("webhook-url").pipe(
      Flag.withDescription("Subscribe the App's webhook to Kin's events at this URL."),
      Flag.optional,
    ),
    port: Flag.Int("port").pipe(
      Flag.withDescription("Loopback port for the manifest redirect."),
      Flag.withDefault(DEFAULT_PORT),
    ),
  },
  (input) => {
    const appConfig = Option.match(input.appId, {
      onNone: () => KinGitHubApp.KinGitHubAppConfig.layer,
      onSome: (appId) => Layer.succeed(KinGitHubApp.KinGitHubAppConfig, { appId }),
    });
    const program = input.check
      ? checkApp.pipe(
          Effect.provide(
            KinGitHubApp.layer.pipe(Layer.provide(Layer.mergeAll(appConfig, KinGitHubScope.layer))),
          ),
          Effect.catch(failed),
        )
      : input.mergeToken
        ? Option.match(input.kinOrg, {
            onNone: () => failed({ message: "--merge-token needs --kin-org <org-id>." }),
            onSome: (org) =>
              decodeOrgId(org).pipe(
                Effect.flatMap((orgId) =>
                  storeMergeToken(orgId, Option.getOrUndefined(input.probePr)),
                ),
                Effect.provide(OwnerMergeClient.layer.pipe(Layer.provide(KinGitHubScope.layer))),
                Effect.catch(failed),
              ),
          })
        : createApp(input).pipe(Effect.catch(failed));
    return program.pipe(
      Effect.provide(Layer.mergeAll(Keychain.layer, FetchHttpClient.layer)),
      Effect.flatMap(({ ok, lines }) =>
        Console.log(lines.join("\n")).pipe(
          // exitCode, not a failed exit, so piped output is not cut off.
          Effect.andThen(
            Effect.sync(() => {
              if (!ok) process.exitCode = 1;
            }),
          ),
        ),
      ),
    );
  },
).pipe(
  Command.withDescription("Create and check Kin's GitHub App, and store the owner's merge token."),
);
