import type { KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import { gitHubJson, type KinGitHubRequestError } from "./githubRest.ts";
import * as Keychain from "./Keychain.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Spec section 6: the token is made with a 90-day expiry; one day of slack for time zones. */
const MAX_LIFETIME_MS = 91 * DAY_MS;
const OWNER_MERGE_TOKEN_WARN_MS = 7 * DAY_MS;

/** Keychain item `kin-owner-merge` / `<orgId>`. `login` lets the hygiene check spot T3 using it. */
const StoredMergeToken = Schema.Struct({
  token: Schema.String,
  login: Schema.String,
  expiresAt: Schema.Int,
  savedAt: Schema.Int,
});
const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(StoredMergeToken));
const encodeStored = Schema.encodeSync(Schema.fromJsonString(StoredMergeToken));

export class OwnerMergeTokenRefusedError extends Schema.TaggedError<OwnerMergeTokenRefusedError>()(
  "OwnerMergeTokenRefusedError",
  { reason: Schema.Literals(["not_fine_grained", "no_expiry", "expired", "lifetime_too_long"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_fine_grained":
        return "Use a fine-grained personal access token (github_pat_…) with Contents: Read and write and Metadata: Read only.";
      case "no_expiry":
        return "The token has no expiry. Make one that expires in 90 days.";
      case "expired":
        return "The token has already expired.";
      case "lifetime_too_long":
        return "The token expires more than 90 days from now. Make one that expires in 90 days.";
    }
  }
}

export class OwnerMergeTokenMissingError extends Schema.TaggedError<OwnerMergeTokenMissingError>()(
  "OwnerMergeTokenMissingError",
  { orgId: Schema.String, expired: Schema.Boolean },
) {
  override get message(): string {
    return this.expired
      ? "The owner's merge token has expired. Make a new one and run scripts/kin-github-app.ts --merge-token."
      : "No owner merge token is set. Run scripts/kin-github-app.ts --merge-token on the Kin host.";
  }
}

export type OwnerMergeTokenStatus =
  | { readonly _tag: "missing" }
  | {
      readonly _tag: "active";
      readonly login: string;
      readonly expiresAt: number;
      /** Inside the last 7 days: the owner gets a card asking for a new token. */
      readonly expiringSoon: boolean;
    }
  | { readonly _tag: "expired"; readonly login: string; readonly expiresAt: number };

/** GitHub sends `2026-12-01 00:00:00 UTC` or `… +0000` on fine-grained token responses. */
function parseTokenExpiration(header: string | undefined): number | null {
  if (header === undefined) return null;
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{2}:?\d{2})$/.exec(
    header.trim(),
  );
  if (match === null) return null;
  const [, date, time, zone] = match as unknown as [string, string, string, string];
  const offset = zone === "UTC" ? "Z" : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  const at = Date.parse(`${date}T${time}${offset}`);
  return Number.isFinite(at) ? at : null;
}

/**
 * The owner's merge credential (spec section 6): read per execution and never logged, put in an
 * environment variable or handed to a child process. APPR-9 adds the merge call here.
 */
export class OwnerMergeClient extends Context.Service<
  OwnerMergeClient,
  {
    /** Checks the token with `GET /user` (its own login and expiry) and stores it in the keychain. */
    readonly save: (input: {
      readonly orgId: KinOrgId;
      readonly token: Redacted.Redacted<string>;
    }) => Effect.Effect<
      { readonly login: string; readonly expiresAt: number },
      OwnerMergeTokenRefusedError | KinGitHubRequestError | Keychain.KinKeychainError
    >;
    readonly status: (
      orgId: KinOrgId,
    ) => Effect.Effect<OwnerMergeTokenStatus, Keychain.KinKeychainError>;
    readonly token: (
      orgId: KinOrgId,
    ) => Effect.Effect<
      Redacted.Redacted<string>,
      OwnerMergeTokenMissingError | Keychain.KinKeychainError
    >;
  }
>()("t3/kin/github/OwnerMergeClient") {}

const make = Effect.gen(function* () {
  const keychain = yield* Keychain.KinKeychain;
  const client = yield* HttpClient.HttpClient;

  const stored = (orgId: KinOrgId) =>
    keychain
      .get("kin-owner-merge", orgId)
      .pipe(Effect.map(Option.flatMap((value) => decodeStored(Redacted.value(value)))));

  const save = Effect.fn("OwnerMergeClient.save")(function* (input: {
    readonly orgId: KinOrgId;
    readonly token: Redacted.Redacted<string>;
  }) {
    // Classic tokens carry repo-wide scopes that can submit reviews; fine-grained ones are checked below.
    if (!Redacted.value(input.token).startsWith("github_pat_")) {
      return yield* new OwnerMergeTokenRefusedError({ reason: "not_fine_grained" });
    }
    const user = yield* gitHubJson({
      client,
      operation: "user.get",
      method: "GET",
      path: "/user",
      token: input.token,
      schema: Schema.Struct({ login: Schema.String }),
    });
    const expiresAt = parseTokenExpiration(user.headers["github-authentication-token-expiration"]);
    const now = yield* Clock.currentTimeMillis;
    if (expiresAt === null) return yield* new OwnerMergeTokenRefusedError({ reason: "no_expiry" });
    if (expiresAt <= now) return yield* new OwnerMergeTokenRefusedError({ reason: "expired" });
    if (expiresAt - now > MAX_LIFETIME_MS) {
      return yield* new OwnerMergeTokenRefusedError({ reason: "lifetime_too_long" });
    }
    const login = user.body.login;
    yield* keychain.set(
      "kin-owner-merge",
      input.orgId,
      Redacted.make(
        encodeStored({ token: Redacted.value(input.token), login, expiresAt, savedAt: now }),
      ),
    );
    return { login, expiresAt };
  });

  const status = Effect.fn("OwnerMergeClient.status")(function* (orgId: KinOrgId) {
    const item = yield* stored(orgId);
    if (Option.isNone(item)) return { _tag: "missing" } satisfies OwnerMergeTokenStatus;
    const now = yield* Clock.currentTimeMillis;
    const { login, expiresAt } = item.value;
    return (
      expiresAt <= now
        ? { _tag: "expired", login, expiresAt }
        : {
            _tag: "active",
            login,
            expiresAt,
            expiringSoon: expiresAt - now <= OWNER_MERGE_TOKEN_WARN_MS,
          }
    ) satisfies OwnerMergeTokenStatus;
  });

  const token = Effect.fn("OwnerMergeClient.token")(function* (orgId: KinOrgId) {
    const item = yield* stored(orgId);
    if (Option.isNone(item)) {
      return yield* new OwnerMergeTokenMissingError({ orgId, expired: false });
    }
    if (item.value.expiresAt <= (yield* Clock.currentTimeMillis)) {
      return yield* new OwnerMergeTokenMissingError({ orgId, expired: true });
    }
    return Redacted.make(item.value.token);
  });

  return OwnerMergeClient.of({ save, status, token });
});

export const layer = Layer.effect(OwnerMergeClient, make);
