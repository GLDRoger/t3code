import { type KinGitHubAgents, type KinGitHubInstant, KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import { publicAddress } from "../publicAddress.ts";
import { hookSecretName, hookSetName } from "./appKey.ts";
import { repoList } from "./githubWatchStore.ts";
import { appSettingsPage, KinGitHubApp } from "./KinGitHubApp.ts";
import { HOUR_MS, MINUTE_MS } from "../durations.ts";

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
/** Looks waiting at once, across every org; past it a delivery is dropped for the poll to find. */
export const LOOKS_PENDING = 100;
const ENSURE_EVERY_MS = 24 * HOUR_MS;
const ENSURE_RETRY_MS = HOUR_MS;
const STATUS_KEPT_MS = 3 * MINUTE_MS;

const HookConfig = Schema.Struct({ url: Schema.optional(Schema.NullOr(Schema.String)) });
const decodeHookConfig = Schema.decodeUnknownOption(HookConfig);
const decodeAbout = Schema.decodeUnknownOption(
  Schema.Struct({ events: Schema.optional(Schema.Array(Schema.String)) }),
);
const decodeDeliveries = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ delivered_at: Schema.String, status_code: Schema.Int })),
);

/**
 * A webhook address is Kin's own only if it is this Kin's hook address now, or the one GitHub last
 * confirmed for this App here; any other is someone else's, left as it is.
 */
const theirs = (url: string, ours: string, confirmed: string | undefined) =>
  url !== "" && url !== ours && url !== confirmed;

type Shown = Pick<KinGitHubAgents, "instant" | "instantOffer">;

interface Look {
  readonly key: string;
  /** The App whose delivery asked for it: a look outlives no Disconnect. */
  readonly appId: string;
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
    readonly ensure: () => Effect.Effect<"set" | "address" | "none" | "elsewhere" | "error">;
    /**
     * The one fence for changing the App or its webhook: every `ensure` holds it, and so must the
     * yes, Disconnect and a new App replacing this one. Not reentrant: never `ensure` inside it.
     */
    readonly exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /** The scheduler's tick: `ensure` for a new App or address, and once a day. */
    readonly tick: () => Effect.Effect<void>;
    /** For the owner's Settings: whether GitHub tells Kin at once, or that Kin may once allowed. */
    readonly instant: (
      people: ReadonlyArray<PersonIdentity>,
      orgId: KinOrgId,
    ) => Effect.Effect<Shown | undefined>;
  }
>()("t3/kin/github/appHook/KinGitHubHook") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const app = yield* KinGitHubApp;
  const queue = yield* Queue.unbounded<Look>();
  const fence = yield* Semaphore.make(1);
  const exclusive = <A, E, R>(effect: Effect.Effect<A, E, R>) => fence.withPermits(1)(effect);
  /** A thread's look queued or running, and whether another waits behind the running one. */
  const pending = new Map<string, { running: boolean; again: boolean }>();
  let hour = -1;
  let spent = 0;
  let ensured: { readonly key: string; readonly at: number; readonly ok: boolean } | undefined;
  let status:
    | { readonly key: string; readonly at: number; readonly value: KinGitHubInstant }
    | undefined;

  /**
   * Settings' App, for the hook's key and the owner's settings page, and whether Kin may set its
   * webhook: one Kin made, or one adopted from the host's environment once an owner allowed it.
   * An App the host was only seeded with may serve something else: Kin never touches its webhook.
   */
  const stored = Effect.fn("KinGitHubHook.stored")(function* () {
    if (app.hook === undefined || app.origin === undefined) return undefined;
    const origin = yield* app.origin();
    if (origin.source !== "kin") return undefined;
    const state = yield* app.state();
    return {
      id: String(origin.app.appId),
      page:
        state._tag === "ok"
          ? appSettingsPage(state.app.slug, state.app.ownerOrg, state.app.ownerLogin ?? "")
          : appSettingsPage(origin.app.slug, false, origin.app.owner),
      ours: origin.app.at !== null || origin.app.hookAllowed !== undefined,
    };
  });
  /** The App whose webhook Kin may set. */
  const named = Effect.fn("KinGitHubHook.named")(function* () {
    const found = yield* stored();
    return found?.ours === true ? found : undefined;
  });

  /** The active App's own secret; a zero-length value is no secret. */
  const held = Effect.fn("KinGitHubHook.held")(function* (appId: string) {
    const kept = yield* store
      .get(hookSecretName(appId))
      .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
    return Option.filter(kept, (bytes) => bytes.byteLength > 0);
  });
  /** The address GitHub last accepted Kin's secret for. */
  const confirmed = Effect.fn("KinGitHubHook.confirmed")(function* (appId: string) {
    const kept = yield* store
      .get(hookSetName(appId))
      .pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
    return Option.getOrUndefined(Option.map(kept, (bytes) => new TextDecoder().decode(bytes)));
  });
  const secret = Effect.fn("KinGitHubHook.secret")(function* () {
    const active = yield* named();
    if (active === undefined) return Option.none<Redacted.Redacted<string>>();
    return Option.map(yield* held(active.id), (bytes) => Redacted.make(Hex.encode(bytes)));
  });

  const offer = (look: Look, now: number) =>
    Effect.suspend(() => {
      const entry = pending.get(look.key);
      if (entry !== undefined && (!entry.running || entry.again)) return Effect.void;
      if (entry === undefined && pending.size >= LOOKS_PENDING) return Effect.void;
      if (Math.floor(now / HOUR_MS) !== hour) {
        hour = Math.floor(now / HOUR_MS);
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
      // Full before any lookup, so a flood costs nothing more.
      if (pending.size >= LOOKS_PENDING) return;
      const active = yield* named();
      if (active === undefined) return;
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
              appId: active.id,
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
      // Asked for by an App since disconnected: dropped.
      const current = yield* named().pipe(Effect.orElseSucceed(() => undefined));
      if (current?.id === next.appId)
        yield* look(next.orgId, next.repo, next.number).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Kin's look for a GitHub delivery failed", { cause }),
          ),
        );
      if (entry?.again === true && current?.id === next.appId) {
        entry.running = false;
        entry.again = false;
        yield* Queue.offer(queue, next);
      } else pending.delete(next.key);
    }).pipe(Effect.forever);
  });

  const ensure = Effect.fn("KinGitHubHook.ensure")(function* () {
    status = undefined;
    const address = yield* publicAddress();
    if (address === undefined) return "address" as const;
    // Both hook calls go to the App checked here, whatever is current by then.
    const active = yield* named();
    if (active === undefined || app.hook === undefined) return "none" as const;
    const hook = app.hook;
    const url = `${address}${KIN_GITHUB_HOOK_ROUTE}`;
    const before = yield* confirmed(active.id);
    const kept = yield* held(active.id);
    const read = Effect.gen(function* () {
      const config = yield* hook.config(active.id);
      if (config === undefined) return "none" as const;
      const current = config.status === 200 ? decodeHookConfig(config.body) : Option.none();
      if (Option.isNone(current)) return "error" as const;
      const now = current.value.url ?? "";
      if (theirs(now, url, before)) return "elsewhere" as const;
      return now === url && before === url ? ("ours" as const) : ("move" as const);
    });
    const first = yield* read;
    if (first !== "ours" && first !== "move") return first;
    if (first === "ours" && Option.isSome(kept)) return "set" as const;
    // A PATCH whose answer was lost may have taken: the same secret is sent again, never a new one.
    const bytes = Option.isSome(kept)
      ? kept
      : yield* store.getOrCreateRandom(hookSecretName(active.id), 32).pipe(Effect.option);
    if (Option.isNone(bytes) || bytes.value.byteLength === 0) return "error" as const;
    const made = Option.isNone(kept);
    const drop = made ? store.remove(hookSecretName(active.id)).pipe(Effect.ignore) : Effect.void;
    // Making the secret was a wait: the App's webhook is read again right before the write.
    if (made) {
      const again = yield* read;
      if (again !== "ours" && again !== "move") return yield* drop.pipe(Effect.as(again));
    }
    // GitHub has no conditional write: an edit there between that read and this write is lost.
    const patched = yield* hook.setConfig(active.id, {
      url,
      content_type: "json",
      insecure_ssl: "0",
      secret: Hex.encode(bytes.value),
    });
    // Retired while the write was out: nothing confirmed, and a secret this ensure made goes too.
    if ((yield* named())?.id !== active.id) return yield* drop.pipe(Effect.as("none" as const));
    if (patched?.status !== 200) return "error" as const;
    const set = yield* store
      .set(hookSetName(active.id), new TextEncoder().encode(url))
      .pipe(Effect.option);
    return Option.isSome(set) ? ("set" as const) : ("error" as const);
  }, exclusive);

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
    ensured = { key, at: now, ok: outcome !== "error" && outcome !== "elsewhere" };
    // Fixed lines: the request and answer carry the secret.
    if (outcome === "error")
      yield* Effect.logWarning("Kin couldn't set up its GitHub App's webhook; it keeps polling.");
    if (outcome === "elsewhere")
      yield* Effect.logWarning(
        "Kin's GitHub App's webhook points somewhere else, so Kin leaves it; it keeps polling.",
      );
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
    const known = yield* stored();
    if (known === undefined || app.hook === undefined) return undefined;
    const settingsUrl = `${known.page}/permissions`;
    const address = yield* publicAddress();
    if (address === undefined)
      return {
        instant: { state: "address", missing: [], settingsUrl, last: null },
      } satisfies Shown;
    // Until an owner allows it, GitHub isn't asked about an App Kin didn't make.
    if (!known.ours) return { instantOffer: true } satisfies Shown;
    const key = `${known.id}\u0000${address}`;
    const now = yield* Clock.currentTimeMillis;
    if (status !== undefined && status.key === key && now - status.at < STATUS_KEPT_MS)
      return { instant: status.value } satisfies Shown;
    const [config, about, deliveries] = [
      yield* app.hook.config(known.id),
      yield* app.hook.about(known.id),
      yield* app.hook.latestDelivery(known.id),
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
    const url = `${address}${KIN_GITHUB_HOOK_ROUTE}`;
    const before = yield* confirmed(known.id);
    // Set only once GitHub took Kin's secret for this address; until then, an error.
    const set =
      Option.isSome(hook) &&
      hook.value.url === url &&
      Option.isSome(yield* held(known.id)) &&
      before === url;
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
      ...(!set && Option.isSome(hook) && theirs(hook.value.url ?? "", url, before)
        ? { elsewhere: true }
        : {}),
    };
    status = { key, at: now, value };
    return { instant: value } satisfies Shown;
  });

  return KinGitHubHook.of({ secret, deliver, serve, ensure, exclusive, tick, instant });
});

export const layer = Layer.effect(KinGitHubHook, make);
