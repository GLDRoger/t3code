import { type KinGitHubInstant, KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import { publicAddress } from "../publicAddress.ts";
import { HOOK_SECRET_NAME } from "./appKey.ts";
import { repoList } from "./githubWatchStore.ts";
import { appSettingsPage, KinGitHubApp } from "./KinGitHubApp.ts";

/**
 * GitHub telling Kin at once: the App's webhook, which Kin sets up itself where it has a public
 * address. A delivery is only a reason to look at one thread now (`KinGitHubWatch.look`); the
 * poll goes on, finds the same keys handled, and covers whatever a delivery never brings.
 */

export const KIN_GITHUB_HOOK_ROUTE = "/kin/github/hook";

/**
 * The events the watch's triggers come from, as GitHub's page words them. `pull_request_review`
 * is left out: no trigger reads a review's body, and its line comments arrive as
 * `pull_request_review_comment`.
 */
export const HOOK_EVENTS = {
  pull_request: "Pull request",
  pull_request_review_comment: "Pull request review comment",
  issue_comment: "Issue comment",
  issues: "Issues",
  check_suite: "Check suite",
} as const;

/** Looks deliveries may start in an hour, across every org; past it they wait for the poll. */
export const LOOKS_PER_HOUR = 300;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ENSURE_EVERY_MS = 24 * HOUR;
const ENSURE_RETRY_MS = HOUR;
const STATUS_KEPT_MS = 3 * MINUTE;

const HookConfig = Schema.Struct({ url: Schema.optional(Schema.NullOr(Schema.String)) });
const decodeHookConfig = Schema.decodeUnknownOption(HookConfig);
const decodeAbout = Schema.decodeUnknownOption(
  Schema.Struct({ events: Schema.optional(Schema.Array(Schema.String)) }),
);
const decodeDeliveries = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ delivered_at: Schema.String, status_code: Schema.Int })),
);

interface Look {
  readonly key: string;
  readonly orgId: KinOrgId;
  readonly repo: string;
  readonly number: number;
}

export class KinGitHubHook extends Context.Service<
  KinGitHubHook,
  {
    /** The secret GitHub signs deliveries with; none until Kin set the hook up. */
    readonly secret: () => Effect.Effect<Option.Option<Redacted.Redacted<string>>>;
    /** A verified delivery's repo and threads: a look queued for each org watching the repo. */
    readonly deliver: (repo: string, numbers: ReadonlyArray<number>) => Effect.Effect<void>;
    /** Runs the queued looks, one at a time, for as long as it runs. */
    readonly serve: (
      look: (orgId: KinOrgId, repo: string, number: number) => Effect.Effect<void>,
    ) => Effect.Effect<never>;
    /** Points the App's webhook at Kin's public address with Kin's own secret, when it doesn't. */
    readonly ensure: () => Effect.Effect<"set" | "address" | "none" | "error">;
    /** The scheduler's tick: `ensure` for a new App or address, and once a day. */
    readonly tick: () => Effect.Effect<void>;
    /** For the owner's Settings: whether GitHub tells Kin at once. */
    readonly instant: (
      people: ReadonlyArray<PersonIdentity>,
      orgId: KinOrgId,
    ) => Effect.Effect<KinGitHubInstant | undefined>;
  }
>()("t3/kin/github/appHook/KinGitHubHook") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const app = yield* KinGitHubApp;
  const queue = yield* Queue.unbounded<Look>();
  /** A thread's look queued or running, and whether another waits behind the running one. */
  const pending = new Map<string, { running: boolean; again: boolean }>();
  let hour = -1;
  let spent = 0;
  let ensured: { readonly key: string; readonly at: number; readonly ok: boolean } | undefined;
  let status:
    | { readonly key: string; readonly at: number; readonly value: KinGitHubInstant }
    | undefined;

  const held = store
    .get(HOOK_SECRET_NAME)
    .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
  const secret = Effect.fn("KinGitHubHook.secret")(function* () {
    return Option.map(yield* held, (bytes) => Redacted.make(Hex.encode(bytes)));
  });

  const offer = (look: Look, now: number) =>
    Effect.suspend(() => {
      const entry = pending.get(look.key);
      if (entry !== undefined && (!entry.running || entry.again)) return Effect.void;
      if (Math.floor(now / HOUR) !== hour) {
        hour = Math.floor(now / HOUR);
        spent = 0;
      }
      if (spent >= LOOKS_PER_HOUR) return Effect.void;
      spent += 1;
      if (entry !== undefined) {
        entry.again = true;
        return Effect.void;
      }
      pending.set(look.key, { running: false, again: false });
      return Queue.offer(queue, look).pipe(Effect.asVoid);
    });

  const deliver = Effect.fn("KinGitHubHook.deliver")(
    function* (repo: string, numbers: ReadonlyArray<number>) {
      const now = yield* Clock.currentTimeMillis;
      const orgs = yield* sql<{ orgId: string }>`SELECT DISTINCT org_id AS "orgId" FROM kin_leads
        ORDER BY org_id`;
      for (const org of orgs) {
        const orgId = KinOrgId.make(org.orgId);
        const entry = (yield* repoList(orgId)).find(
          (one) => one.watched && one.repo.toLowerCase() === repo.toLowerCase(),
        );
        if (entry === undefined) continue;
        for (const number of numbers)
          yield* offer(
            {
              key: `${orgId}\u0000${entry.repo.toLowerCase()}#${number}`,
              orgId,
              repo: entry.repo,
              number,
            },
            now,
          );
      }
    },
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.catchCause((cause) =>
      Effect.logWarning("Kin couldn't queue a GitHub delivery's look", { cause }),
    ),
  );

  const serve = Effect.fn("KinGitHubHook.serve")(function* (
    look: (orgId: KinOrgId, repo: string, number: number) => Effect.Effect<void>,
  ) {
    return yield* Effect.gen(function* () {
      const next = yield* Queue.take(queue);
      const entry = pending.get(next.key);
      if (entry !== undefined) entry.running = true;
      yield* look(next.orgId, next.repo, next.number).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Kin's look for a GitHub delivery failed", { cause }),
        ),
      );
      if (entry?.again === true) {
        entry.running = false;
        entry.again = false;
        yield* Queue.offer(queue, next);
      } else pending.delete(next.key);
    }).pipe(Effect.forever);
  });

  /** The App as Kin holds it now, for the hook's key and the owner's settings page. */
  const named = Effect.fn("KinGitHubHook.named")(function* () {
    const state = yield* app.state();
    if (state._tag === "ok")
      return {
        id: String(state.app.id),
        page: appSettingsPage(state.app.slug, state.app.ownerOrg, state.app.ownerLogin ?? ""),
      };
    const origin = app.origin === undefined ? undefined : yield* app.origin();
    return origin?.source === "kin"
      ? {
          id: String(origin.app.appId),
          page: appSettingsPage(origin.app.slug, false, origin.app.owner),
        }
      : undefined;
  });

  const ensure = Effect.fn("KinGitHubHook.ensure")(function* () {
    status = undefined;
    const address = yield* publicAddress();
    if (address === undefined) return "address" as const;
    if (app.asApp === undefined || (yield* named()) === undefined) return "none" as const;
    const url = `${address}${KIN_GITHUB_HOOK_ROUTE}`;
    const config = yield* app.asApp({ path: "app/hook/config" });
    if (config === undefined) return "none" as const;
    const current = config.status === 200 ? decodeHookConfig(config.body) : Option.none();
    if (Option.isNone(current)) return "error" as const;
    const kept = yield* held;
    if (Option.isSome(kept) && current.value.url === url) return "set" as const;
    const bytes = Option.isSome(kept)
      ? kept
      : yield* store.getOrCreateRandom(HOOK_SECRET_NAME, 32).pipe(Effect.option);
    if (Option.isNone(bytes)) return "error" as const;
    const patched = yield* app.asApp({
      method: "PATCH",
      path: "app/hook/config",
      body: {
        url,
        content_type: "json",
        insecure_ssl: "0",
        secret: Hex.encode(bytes.value),
      },
    });
    return patched?.status === 200 ? ("set" as const) : ("error" as const);
  });

  const tick = Effect.fn("KinGitHubHook.tick")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const key = `${(yield* named())?.id ?? "none"}\u0000${(yield* publicAddress()) ?? ""}`;
    if (
      ensured !== undefined &&
      ensured.key === key &&
      now - ensured.at < (ensured.ok ? ENSURE_EVERY_MS : ENSURE_RETRY_MS)
    )
      return;
    const outcome = yield* ensure();
    ensured = { key, at: now, ok: outcome !== "error" };
    // Only GitHub's status: the request and answer carry the secret.
    if (outcome === "error")
      yield* Effect.logWarning("Kin couldn't set up its GitHub App's webhook; it keeps polling.");
  });

  const instant = Effect.fn("KinGitHubHook.instant")(function* (
    people: ReadonlyArray<PersonIdentity>,
    orgId: KinOrgId,
  ) {
    const person = people.find((entry) => entry.orgId === orgId);
    if (
      person === undefined ||
      !(yield* ownerLevel(orgId, person.personId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.orElseSucceed(() => false),
      ))
    )
      return undefined;
    const known = yield* named();
    if (known === undefined || app.asApp === undefined) return undefined;
    const settingsUrl = `${known.page}/permissions`;
    const address = yield* publicAddress();
    if (address === undefined)
      return { state: "address", missing: [], settingsUrl, last: null } satisfies KinGitHubInstant;
    const key = `${known.id}\u0000${address}`;
    const now = yield* Clock.currentTimeMillis;
    if (status !== undefined && status.key === key && now - status.at < STATUS_KEPT_MS)
      return status.value;
    const [config, about, deliveries] = [
      yield* app.asApp({ path: "app/hook/config" }),
      yield* app.asApp({ path: "app" }),
      yield* app.asApp({ path: "app/hook/deliveries?per_page=1" }),
    ];
    const hook = config?.status === 200 ? decodeHookConfig(config.body) : Option.none();
    const events = about?.status === 200 ? decodeAbout(about.body) : Option.none();
    const ticked = new Set(Option.isSome(events) ? (events.value.events ?? []) : []);
    const missing = Object.entries(HOOK_EVENTS)
      .filter(([event]) => !ticked.has(event))
      .map(([, words]) => words);
    const latest = Option.flatMap(
      deliveries?.status === 200 ? decodeDeliveries(deliveries.body) : Option.none(),
      (list) => Option.fromUndefinedOr(list[0]),
    );
    const set =
      Option.isSome(hook) &&
      hook.value.url === `${address}${KIN_GITHUB_HOOK_ROUTE}` &&
      Option.isSome(yield* held);
    const value: KinGitHubInstant = {
      state: !set || Option.isNone(events) ? "error" : missing.length === 0 ? "on" : "events",
      missing: Option.isSome(events) ? missing : [],
      settingsUrl,
      last: Option.match(latest, {
        onNone: () => null,
        onSome: (one) => ({
          at: one.delivered_at,
          ok: one.status_code >= 200 && one.status_code < 300,
        }),
      }),
    };
    status = { key, at: now, value };
    return value;
  });

  return KinGitHubHook.of({ secret, deliver, serve, ensure, tick, instant });
});

export const layer = Layer.effect(KinGitHubHook, make);
