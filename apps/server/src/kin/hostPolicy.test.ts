import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  KIN_HOST_POLICY,
  type ManagedPolicyDocument,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";

import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as HostPolicy from "./hostPolicy.ts";

const policyUnder = (enabled: boolean, document?: ManagedPolicyDocument) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "kin-host-policy-" });
    const file = path.join(directory, "policy.json");
    if (document !== undefined) yield* fs.writeFileString(file, JSON.stringify(document));
    return yield* ManagedPolicy.ManagedPolicy.pipe(
      Effect.provide(
        ManagedPolicy.layer.pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                KIN_ENABLED: enabled,
                T3CODE_DEV_MANAGED_POLICY_PATH: file,
              }),
            ),
          ),
        ),
      ),
    );
  });

it.layer(NodeServices.layer)("Kin's managed policy", (it) => {
  it.effect(
    "locks linked environments and guest sharing off and disables telemetry with no policy file",
    () =>
      Effect.gen(function* () {
        const policy = yield* policyUnder(true);
        const patched = {
          ...DEFAULT_SERVER_SETTINGS,
          linkedEnvironmentsEnabled: true,
          guestSharingEnabled: true,
        };
        assert.include(policy.settings.applyLocks(patched), {
          linkedEnvironmentsEnabled: false,
          guestSharingEnabled: false,
        });
        assert.sameMembers(
          [...(policy.summary?.lockedSettings ?? [])],
          ["linkedEnvironmentsEnabled", "guestSharingEnabled"],
        );
        assert.deepEqual(
          policy.settings.vetWrite(policy.settings.applyLocks(patched), patched, {
            linkedEnvironmentsEnabled: true,
          }),
          { _tag: "Locked", path: "linkedEnvironmentsEnabled" },
        );
        assert.equal(ManagedPolicy.deniedBy(policy, "telemetry"), "Kin");
        assert.deepEqual(policy.summary?.limits, KIN_HOST_POLICY.limits);
      }),
  );

  it.effect("allows a policy file to add restrictions while preserving Kin's restrictions", () =>
    Effect.gen(function* () {
      const policy = yield* policyUnder(true, {
        schemaVersion: 1,
        organization: "Tidewater Freight",
        settings: {
          linkedEnvironmentsEnabled: { value: true, locked: true },
          guestSharingEnabled: { value: true, locked: false },
          defaultRuntimeMode: { value: "approval-required", locked: true },
        },
        limits: {
          telemetry: true,
          updates: { mode: "auto", allowNightly: false },
          connect: false,
        },
      });
      assert.include(policy.settings.applyLocks(DEFAULT_SERVER_SETTINGS), {
        linkedEnvironmentsEnabled: false,
        guestSharingEnabled: false,
        defaultRuntimeMode: "approval-required",
      });
      assert.deepEqual(policy.summary?.limits, {
        ...KIN_HOST_POLICY.limits,
        updates: { mode: "off", allowNightly: false },
        connect: false,
      });
    }),
  );

  it.effect("leaves a T3 host without Kin unmanaged when the file is missing", () =>
    Effect.gen(function* () {
      assert.isUndefined((yield* policyUnder(false)).summary);
    }),
  );
});

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

it.effect("warns about the missing policy file and identifies the built-in policy", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* warningsUnder(KIN_HOST_POLICY), []);
    const warnings = yield* warningsUnder(undefined);
    assert.lengthOf(warnings, 1);
    assert.include(
      warnings[0],
      "Kin is using its built-in host policy because /test/policy.json is missing. ops/kin/host/setup.sh installs the host policy at /etc/t3code/policy.json.",
    );
  }),
);
