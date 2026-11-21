// @effect-diagnostics nodeBuiltinImport:off - random state for GitHub's manifest flow.
import * as NodeCrypto from "node:crypto";

import {
  KinChatError,
  type KinGitHubAppLooked,
  type KinGitHubHookAllowed,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpClient, HttpClientRequest } from "effect/http";

import { ServerConfig } from "../../config.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import { readStoredApp, removeStoredApp, writeSeedTaken, writeStoredApp } from "./appStore.ts";
import { knownRepos } from "./githubWatchStore.ts";
import { HOOK_EVENTS, KIN_GITHUB_HOOK_ROUTE, KinGitHubHook } from "./appHook.ts";
import { publicAddress } from "../publicAddress.ts";
import { KinGitHubAppKey } from "./appKey.ts";
import { appSettingsPage, KinGitHubApp, KinGitHubAppConfig } from "./KinGitHubApp.ts";

/**
 * Making Kin's GitHub App from Settings with GitHub's manifest flow: an owner-level call mints a
 * one-hour state; Kin's page posts the manifest from the owner's browser; GitHub sends that browser
 * back with a one-time code, which Kin exchanges once for the App's id and key. The key goes only
 * to the server's secret store; nothing here returns it.
 */

export const APP_SETUP_ROUTE = "/api/kin/github-app";
const STATE_TTL_MS = 55 * 60_000;
/** Part of the look is unsigned, and GitHub's unsigned allowance is small. */
const LOOK_EVERY_MS = 30_000;
const NAME_MAX = 34;

/**
 * What agents need and no more: code, pull requests, issues and checks, and reading Actions runs
 * for memory's checks. Tokens Kin mints leave out admin-like permissions too.
 */
const PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  checks: "write",
  actions: "read",
  metadata: "read",
} as const;

const Conversion = Schema.Struct({
  id: Schema.Int,
  slug: Schema.String,
  name: Schema.String,
  owner: Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.String) })),
  pem: Schema.String,
});
const decodeConversion = Schema.decodeUnknownOption(Conversion);
const Json = Schema.fromJsonString(Schema.Unknown);
const toJson = Schema.encodeSync(Json);
const fromJson = Schema.decodeUnknownOption(Json);

/** What the owner's browser shows when GitHub sends it back. */
export interface SetupOutcome {
  readonly ok: boolean;
  readonly title: string;
  readonly detail: string;
  readonly link?: { readonly label: string; readonly url: string };
}

interface Pending {
  readonly orgId: KinOrgId;
  readonly by: string;
  readonly expiresAt: number;
  readonly defaultName: string;
  readonly public: boolean;
}

export class KinGitHubAppSetup extends Context.Service<
  KinGitHubAppSetup,
  {
    /** Owner-level: a state for the manifest page, and the name it suggests. */
    readonly start: (
      people: ReadonlyArray<PersonIdentity>,
      orgId: KinOrgId,
    ) => Effect.Effect<{ readonly path: string; readonly name: string }, KinChatError>;
    /** The page that posts the manifest to GitHub; none for an unknown or spent state. */
    readonly page: (
      state: string,
      name: string,
      origin: string,
    ) => Effect.Effect<Option.Option<string>>;
    /** GitHub's redirect: the state once, then the code once. */
    readonly complete: (state: string, code: string) => Effect.Effect<SetupOutcome>;
    /**
     * Forgets Settings' App, made here or adopted from the host's environment, which then stays
     * unused across restarts. The App itself stays on GitHub, and an old keyring item stays put.
     */
    readonly disconnect: (
      people: ReadonlyArray<PersonIdentity>,
      orgId: KinOrgId,
    ) => Effect.Effect<{ readonly settingsUrl: string | null }, KinChatError>;
    /**
     * An owner's yes to Kin setting the webhook of Settings' App, kept with the App's record, then
     * set up right away. Disconnecting the App is the way back.
     */
    readonly allowHook: (
      people: ReadonlyArray<PersonIdentity>,
      orgId: KinOrgId,
    ) => Effect.Effect<KinGitHubHookAllowed, KinChatError>;
    /** Owner-level: looks at the App on GitHub now, at most once in 30 seconds. */
    readonly look: (
      people: ReadonlyArray<PersonIdentity>,
      orgId: KinOrgId,
    ) => Effect.Effect<KinGitHubAppLooked, KinChatError>;
  }
>()("t3/kin/github/appSetup/KinGitHubAppSetup") {}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

export const setupHtml = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.25rem;color:#1f2328}h1{font-size:1.25rem}button,a.button{font:inherit;padding:.5rem 1rem;border:1px solid #d0d7de;border-radius:6px;background:#f6f8fa;color:inherit;text-decoration:none;cursor:pointer}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;

export const make = Effect.gen(function* () {
  const config = yield* KinGitHubAppConfig;
  const appKey = yield* KinGitHubAppKey;
  const client = yield* HttpClient.HttpClient;
  const sql = yield* SqlClient.SqlClient;
  const app = yield* KinGitHubApp;
  const refreshes = yield* KinRefreshObserver;
  const hook = yield* KinGitHubHook;
  /** The App's record is read and written whole: a yes never brings back one being disconnected. */
  const record = yield* Semaphore.make(1);
  const files = Context.make(FileSystem.FileSystem, yield* FileSystem.FileSystem).pipe(
    Context.add(Path.Path, yield* Path.Path),
    Context.add(ServerConfig, yield* ServerConfig),
  );
  const pending = new Map<string, Pending>();
  let lookedAt: number | undefined;
  const refuse = (message: string) => new KinChatError({ reason: "not_allowed", message });

  const ownerAt = Effect.fn("KinGitHubAppSetup.ownerAt")(function* (
    people: ReadonlyArray<PersonIdentity>,
    orgId: KinOrgId,
  ) {
    const person = people.find((entry) => entry.orgId === orgId);
    const allowed =
      person !== undefined &&
      (yield* ownerLevel(orgId, person.personId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.orElseSucceed(() => false),
      ));
    if (person === undefined || !allowed)
      return yield* refuse("Only the owner or a co-owner can set up Kin's GitHub App.");
    const [named] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
      WHERE org_id = ${orgId} AND person_id = ${person.personId}`.pipe(
      Effect.orElseSucceed(() => []),
    );
    return named?.name ?? "the owner";
  });

  const start = Effect.fn("KinGitHubAppSetup.start")(function* (
    people: ReadonlyArray<PersonIdentity>,
    orgId: KinOrgId,
  ) {
    const by = yield* ownerAt(people, orgId);
    const named =
      app.origin === undefined
        ? Option.isSome(yield* readStoredApp.pipe(Effect.provideContext(files)))
        : (yield* app.origin()).source !== "none";
    if (named)
      return yield* refuse("Kin already has a GitHub App. Disconnect it first to make another.");
    const [company] = yield* sql<{ name: string }>`SELECT name FROM kin_orgs
      WHERE org_id = ${orgId}`.pipe(Effect.orElseSucceed(() => []));
    const known = yield* knownRepos(orgId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.orElseSucceed(() => []),
    );
    const now = yield* Clock.currentTimeMillis;
    for (const [key, entry] of pending) if (entry.expiresAt <= now) pending.delete(key);
    const state = NodeCrypto.randomBytes(24).toString("base64url");
    const defaultName = `Kin for ${company?.name ?? "my company"}`.slice(0, NAME_MAX).trim();
    pending.set(state, {
      orgId,
      by,
      expiresAt: now + STATE_TTL_MS,
      defaultName,
      // A private App installs only on the account that owns it; organisations need it public.
      public: known.some((entry) => entry.ownerOrg === true),
    });
    return { path: `${APP_SETUP_ROUTE}/new?state=${state}`, name: defaultName };
  });

  const page = Effect.fn("KinGitHubAppSetup.page")(function* (
    state: string,
    name: string,
    origin: string,
  ) {
    const entry = pending.get(state);
    if (entry === undefined || entry.expiresAt <= (yield* Clock.currentTimeMillis))
      return Option.none<string>();
    const chosen = name.trim().replace(/\s+/g, " ").slice(0, NAME_MAX).trim();
    const address = yield* publicAddress();
    const manifest = toJson({
      name: chosen === "" ? entry.defaultName : chosen,
      url: origin,
      description: "Kin's agents work on GitHub as this App.",
      redirect_url: `${origin}${APP_SETUP_ROUTE}/created`,
      public: entry.public,
      default_permissions: PERMISSIONS,
      // GitHub delivers to a public address only; without one Kin polls, as it always also does.
      ...(address === undefined
        ? { default_events: [] }
        : {
            hook_attributes: { url: `${address}${KIN_GITHUB_HOOK_ROUTE}`, active: true },
            default_events: Object.keys(HOOK_EVENTS),
          }),
    });
    const action = `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;
    return Option.some(
      setupHtml(
        "Create Kin's GitHub App",
        `<p>GitHub opens with the App filled in. Check its name, then choose <b>Create GitHub App</b>. GitHub then sends you back here.</p><form method="post" action="${escapeHtml(action)}"><input type="hidden" name="manifest" value="${escapeHtml(manifest)}"><button type="submit">Continue on GitHub</button></form>`,
      ),
    );
  });

  const complete = Effect.fn("KinGitHubAppSetup.complete")(function* (state: string, code: string) {
    const entry = pending.get(state);
    // Spent before anything else, so a replayed redirect never reaches GitHub.
    pending.delete(state);
    if (entry === undefined || entry.expiresAt <= (yield* Clock.currentTimeMillis))
      return {
        ok: false,
        title: "This set-up link has run out",
        detail:
          "It was used already or is over an hour old. Start again from Kin's Settings → Connections → GitHub.",
      } satisfies SetupOutcome;
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(code))
      return {
        ok: false,
        title: "GitHub sent no usable code",
        detail: "Start again from Kin's Settings → Connections → GitHub.",
      } satisfies SetupOutcome;
    const answer = yield* client
      .execute(
        HttpClientRequest.post(`https://api.github.com/app-manifests/${code}/conversions`).pipe(
          HttpClientRequest.setHeaders({
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "kin",
          }),
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          response.text.pipe(Effect.map((text) => ({ status: response.status, text }))),
        ),
        Effect.timeout("30 seconds"),
        // No cause: the answer holds the App's key.
        Effect.orElseSucceed(() => ({ status: 0, text: "" })),
      );
    const made =
      answer.status === 201
        ? Option.flatMap(fromJson(answer.text), decodeConversion)
        : Option.none();
    if (Option.isNone(made))
      return {
        ok: false,
        title: "GitHub didn't hand the new App to Kin",
        detail: `GitHub answered ${answer.status === 0 ? "nothing" : `status ${answer.status}`}. If the App was made, delete it on GitHub, then start again from Kin's settings.`,
        link: { label: "Your GitHub Apps", url: "https://github.com/settings/apps" },
      } satisfies SetupOutcome;
    const { id, slug, name, owner, pem } = made.value;
    const settingsUrl = `https://github.com/settings/apps/${slug}`;
    const stored = yield* appKey
      .set(String(id), Redacted.make(toJson({ privateKeyPem: pem })))
      .pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    if (!stored)
      return {
        ok: false,
        title: `GitHub made ${name}, but Kin couldn't keep its key`,
        detail:
          "Kin's secret store on this computer refused it, so Kin can't use the App. Delete it on GitHub, then start again.",
        link: { label: "The App on GitHub", url: settingsUrl },
      } satisfies SetupOutcome;
    yield* writeStoredApp({
      appId: id,
      slug,
      name,
      owner: owner?.login ?? "",
      at: yield* Clock.currentTimeMillis,
      by: entry.by,
    }).pipe(Effect.provideContext(files), Effect.orDie);
    yield* app.lookAgain();
    yield* refreshes.touch(entry.orgId, "connections");
    return {
      ok: true,
      title: `${name} is set up`,
      detail:
        "Kin keeps its key on this computer. In Kin, Settings → Connections → GitHub now has a row per account to put it on all your repositories. You can close this tab.",
    } satisfies SetupOutcome;
  });

  const disconnect = Effect.fn("KinGitHubAppSetup.disconnect")(function* (
    people: ReadonlyArray<PersonIdentity>,
    orgId: KinOrgId,
  ) {
    yield* ownerAt(people, orgId);
    const state = yield* app.state();
    const stored = yield* record.withPermits(1)(
      Effect.gen(function* () {
        // Declined before removing the record, so no restart in between adopts the host's App again.
        if (Option.isSome(config.appId))
          yield* writeSeedTaken(config.appId.value).pipe(
            Effect.provideContext(files),
            Effect.orDie,
          );
        const stored = yield* readStoredApp.pipe(Effect.provideContext(files));
        if (Option.isSome(stored)) {
          yield* appKey.remove(String(stored.value.appId));
          yield* removeStoredApp.pipe(Effect.provideContext(files), Effect.orDie);
        }
        return stored;
      }),
    );
    yield* app.lookAgain();
    yield* refreshes.touch(orgId, "connections");
    return {
      settingsUrl: Option.isNone(stored)
        ? null
        : state._tag === "ok"
          ? appSettingsPage(
              state.app.slug,
              state.app.ownerOrg,
              state.app.ownerLogin ?? stored.value.owner,
            )
          : appSettingsPage(stored.value.slug, false, stored.value.owner),
    };
  });

  const allowHook = Effect.fn("KinGitHubAppSetup.allowHook")(function* (
    people: ReadonlyArray<PersonIdentity>,
    orgId: KinOrgId,
  ) {
    const by = yield* ownerAt(people, orgId);
    const now = yield* Clock.currentTimeMillis;
    const kept = yield* record.withPermits(1)(
      Effect.gen(function* () {
        const stored = yield* readStoredApp.pipe(Effect.provideContext(files));
        if (Option.isNone(stored)) return false;
        if (stored.value.hookAllowed === undefined)
          yield* writeStoredApp({ ...stored.value, hookAllowed: { by, at: now } }).pipe(
            Effect.provideContext(files),
            Effect.orDie,
          );
        return true;
      }),
    );
    if (!kept)
      return yield* new KinChatError({
        reason: "invalid_state",
        message: "Kin has no GitHub App in Settings yet. Look again in a minute.",
      });
    const outcome = yield* hook.ensure();
    yield* refreshes.touch(orgId, "connections");
    return { outcome } satisfies KinGitHubHookAllowed;
  });

  const look = Effect.fn("KinGitHubAppSetup.look")(function* (
    people: ReadonlyArray<PersonIdentity>,
    orgId: KinOrgId,
  ) {
    yield* ownerAt(people, orgId);
    const now = yield* Clock.currentTimeMillis;
    if (lookedAt !== undefined && now - lookedAt < LOOK_EVERY_MS)
      return { looked: false } satisfies KinGitHubAppLooked;
    lookedAt = now;
    yield* app.lookAgain();
    yield* refreshes.touch(orgId, "connections");
    return { looked: true } satisfies KinGitHubAppLooked;
  });

  return KinGitHubAppSetup.of({ start, page, complete, disconnect, allowHook, look });
});

export const layer = Layer.effect(KinGitHubAppSetup, make);
