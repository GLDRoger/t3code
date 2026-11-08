import { assert, it } from "@effect/vitest";
import type { KinOrgId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";

import * as OwnerMergeClient from "./OwnerMergeClient.ts";
import { fakeGitHub, memoryKeychain } from "./testFakes.ts";

const ORG = "org_kin" as KinOrgId;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 8);
const TOKEN = Redacted.make("github_pat_fake_owner_merge_token");
const expiration = (at: number) =>
  `${DateTime.formatIso(DateTime.makeUnsafe(at)).slice(0, 19).replace("T", " ")} UTC`;

const setup = (headers: Record<string, string>) => {
  const keychain = memoryKeychain();
  const github = fakeGitHub(() => ({ status: 200, body: { login: "Nishchay" }, headers }));
  const layer = OwnerMergeClient.layer.pipe(
    Layer.provide(keychain.layer),
    Layer.provide(github.layer),
  );
  return { keychain, requests: github.requests, layer };
};

const save = (token = TOKEN) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const client = yield* OwnerMergeClient.OwnerMergeClient;
    return yield* client.save({ orgId: ORG, token });
  });

describe("OwnerMergeClient", () => {
  it.effect("stores a fine-grained token and warns in its last 7 days", () => {
    const { keychain, requests, layer } = setup({
      "github-authentication-token-expiration": expiration(NOW + 30 * DAY),
    });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* save(), { login: "Nishchay", expiresAt: NOW + 30 * DAY });
      assert.strictEqual(requests[0]?.authorization, `Bearer ${Redacted.value(TOKEN)}`);
      assert.include(keychain.items.get(`kin-owner-merge/${ORG}`), Redacted.value(TOKEN));

      const client = yield* OwnerMergeClient.OwnerMergeClient;
      assert.deepInclude(yield* client.status(ORG), { _tag: "active", expiringSoon: false });
      yield* TestClock.setTime(NOW + 23 * DAY);
      assert.deepInclude(yield* client.status(ORG), { _tag: "active", expiringSoon: true });
      assert.strictEqual(Redacted.value(yield* client.token(ORG)), Redacted.value(TOKEN));

      yield* TestClock.setTime(NOW + 30 * DAY);
      assert.deepInclude(yield* client.status(ORG), { _tag: "expired", login: "Nishchay" });
      const error = yield* client.token(ORG).pipe(Effect.flip);
      assert.deepInclude(error, { _tag: "OwnerMergeTokenMissingError", expired: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect.each([
    ["a classic token", Redacted.make("ghp_classic"), {}, "not_fine_grained"],
    ["no expiry", TOKEN, {}, "no_expiry"],
    [
      "an expiry past 90 days",
      TOKEN,
      { "github-authentication-token-expiration": expiration(NOW + 120 * DAY) },
      "lifetime_too_long",
    ],
    [
      "an expired token",
      TOKEN,
      { "github-authentication-token-expiration": "2026-11-01 00:00:00 +0000" },
      "expired",
    ],
  ] as const)("refuses %s and stores nothing", ([, token, headers, reason]) => {
    const { keychain, layer } = setup(headers);
    return Effect.gen(function* () {
      const error = yield* save(token).pipe(Effect.flip);
      assert.deepInclude(error, { _tag: "OwnerMergeTokenRefusedError", reason });
      assert.notInclude(error.message, Redacted.value(token));
      assert.strictEqual(keychain.items.size, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a missing token", () =>
    Effect.gen(function* () {
      const client = yield* OwnerMergeClient.OwnerMergeClient;
      assert.deepStrictEqual(yield* client.status(ORG), { _tag: "missing" });
      const error = yield* client.token(ORG).pipe(Effect.flip);
      assert.deepInclude(error, { _tag: "OwnerMergeTokenMissingError", expired: false });
    }).pipe(Effect.provide(setup({}).layer)),
  );
});
