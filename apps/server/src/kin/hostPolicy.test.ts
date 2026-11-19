import { assert, it } from "@effect/vitest";
import { KIN_HOST_POLICY, type ManagedPolicyDocument } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as HostPolicy from "./hostPolicy.ts";

const warningsUnder = (document: ManagedPolicyDocument | undefined) =>
  Effect.gen(function* () {
    const warnings: Array<unknown> = [];
    yield* HostPolicy.check().pipe(
      Effect.provide(
        Layer.merge(
          ManagedPolicy.layerTest(document),
          Logger.layer([Logger.make(({ message }) => warnings.push(message))], {
            mergeWithExisting: false,
          }),
        ),
      ),
    );
    return warnings.map(String);
  });

it.effect("is quiet when T3 enforces Kin's policy, and names each lock and limit it lacks", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* warningsUnder(KIN_HOST_POLICY), []);
    const warnings = yield* warningsUnder(undefined);
    assert.lengthOf(warnings, 1);
    assert.include(
      warnings[0],
      "settings.linkedEnvironmentsEnabled, settings.guestSharingEnabled, limits.telemetry, limits.browserCookieImport, limits.updates",
    );
    const { guestSharingEnabled: _, ...settings } = KIN_HOST_POLICY.settings;
    const partial = yield* warningsUnder({ ...KIN_HOST_POLICY, settings });
    assert.lengthOf(partial, 1);
    assert.include(partial[0], "not in force: settings.guestSharingEnabled.");
  }),
);
