import * as NodeServices from "@effect/platform-node/NodeServices";
import { sign } from "@electron/osx-sign";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";
import signMac from "../sign-macos.ts";
import { assert, it } from "@effect/vitest";
import Plist from "plist";
import {
  KIN_SIGNER_ENTITLEMENTS_ENV,
  KIN_SIGNER_EXCLUDED_ENTITLEMENTS,
  kinApprovalAccessGroup,
  kinSignerId,
  renderKinSignerEntitlements,
  resolveKinSignerEntitlements,
  resolveKinSignerProfilePath,
} from "./kin-signer.ts";

vi.mock("@electron/osx-sign", () => ({ sign: vi.fn() }));

const teamId = "TIDEWATER1";
const appId = "example.tidewater";
const signerId = `${appId}.signer`;
const approvalGroup = `${teamId}.${signerId}.approvals`;
const appAttestKey = "com.apple.developer.devicecheck.appattest-environment";
const accessGroupsKey = "keychain-access-groups";

it("renders only the signer's four entitlements", () => {
  assert.equal(kinSignerId(appId), signerId);
  assert.equal(kinApprovalAccessGroup(teamId, signerId), approvalGroup);
  for (const appAttestEnvironment of ["development", "production"] as const) {
    const entitlements = Plist.parse(
      renderKinSignerEntitlements({ teamId, signerId, appAttestEnvironment }),
    );
    assert.deepEqual(entitlements, {
      "com.apple.application-identifier": `${teamId}.${signerId}`,
      "com.apple.developer.team-identifier": teamId,
      [appAttestKey]: appAttestEnvironment,
      [accessGroupsKey]: [approvalGroup],
    });
    for (const excluded of KIN_SIGNER_EXCLUDED_ENTITLEMENTS) {
      assert.notProperty(entitlements, excluded);
    }
  }
});

it("requires the profile to authorize App Attest and the approvals group", () => {
  const check = (
    entitlements: Record<string, string | string[]>,
    expectedEnvironment?: "development" | "production",
  ) =>
    resolveKinSignerEntitlements(
      `CMS${Plist.build({ Entitlements: entitlements })}\0`,
      { teamId, signerId },
      expectedEnvironment,
    );
  const groups = { [accessGroupsKey]: [approvalGroup] };
  const attest = { [appAttestKey]: "production" };
  for (const [entitlements, missing] of [
    [groups, appAttestKey],
    [attest, accessGroupsKey],
    [{ ...groups, [appAttestKey]: "unknown" }, appAttestKey],
    [{ ...attest, [accessGroupsKey]: ["OTHERTEAM1.*"] }, accessGroupsKey],
  ] satisfies [Record<string, string | string[]>, string][]) {
    assert.include(check(entitlements), {
      _tag: "KinSignerProfileEntitlementError",
      entitlement: missing,
    });
  }
  assert.include(check({ ...attest, ...groups }, "development"), {
    _tag: "KinSignerProfileEntitlementError",
    entitlement: appAttestKey,
    expected: "development",
  });
  assert.deepEqual(check({ ...attest, ...groups }), {
    teamId,
    signerId,
    appAttestEnvironment: "production",
  });
  assert.deepEqual(check({ ...attest, [accessGroupsKey]: [`${teamId}.*`] }), {
    teamId,
    signerId,
    appAttestEnvironment: "production",
  });
});

it("opts in to staging the signer only for a configured signer profile", () => {
  assert.isUndefined(resolveKinSignerProfilePath(undefined));
  assert.isUndefined(resolveKinSignerProfilePath({}));
  assert.isUndefined(resolveKinSignerProfilePath({ KIN_MACOS_SIGNER_PROVISIONING_PROFILE: " " }));
  assert.equal(
    resolveKinSignerProfilePath({ KIN_MACOS_SIGNER_PROVISIONING_PROFILE: " tidewater.profile " }),
    "tidewater.profile",
  );
});

it.layer(NodeServices.layer)("signing hook", (it) => {
  it.effect(
    "signs both nested code paths with signer-only options and seals the profile as a resource",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stage = yield* fs.makeTempDirectoryScoped();
        const app = path.join(stage, "Tidewater.app");
        const bundle = path.join(app, "Contents", "Helpers", "Kin Signer.app");
        const executable = path.join(bundle, "Contents", "MacOS", "kin-signer");
        const profile = path.join(bundle, "Contents", "embedded.provisionprofile");
        const entitlements = path.join(stage, "signer.plist");
        yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
        for (const fixture of [executable, profile, entitlements]) {
          yield* fs.writeFileString(fixture, "");
        }

        const context = { platform: "darwin" } as const;
        const inherited = {
          entitlements: "electron.plist",
          hardenedRuntime: false,
          additionalArguments: ["--deep"],
        };
        vi.stubEnv(KIN_SIGNER_ENTITLEMENTS_ENV, entitlements);
        try {
          yield* Effect.promise(() =>
            signMac({
              app,
              ignore: (file) => file === executable || file.endsWith(".kext"),
              optionsForFile: () => inherited,
            }),
          );
        } finally {
          vi.unstubAllEnvs();
        }
        const options = vi.mocked(sign).mock.lastCall?.[0];
        for (const file of [bundle, executable]) {
          assert.deepEqual(options?.optionsForFile?.(file, context), {
            entitlements,
            hardenedRuntime: true,
          });
        }
        assert.deepEqual(options?.optionsForFile?.(app, context), inherited);
        const ignore = options?.ignore;
        assert.isFunction(ignore);
        if (typeof ignore !== "function") return;
        assert.isTrue(ignore(profile));
        assert.isTrue(ignore(path.join(app, "example.kext")));
        assert.isFalse(ignore(executable));
      }),
  );
});
