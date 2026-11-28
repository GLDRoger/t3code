import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import Plist from "plist";

const APP_ATTEST = "com.apple.developer.devicecheck.appattest-environment";
const ACCESS_GROUPS = "keychain-access-groups";
const SIGNER_BUNDLE = "Kin Signer.app";
const SIGNER_EXECUTABLE = "kin-signer";
export const KIN_SIGNER_NESTED_PATH = `Helpers/${SIGNER_BUNDLE}`;
export const KIN_SIGNER_ENTITLEMENTS_ENV = "T3CODE_STAGED_KIN_SIGNER_ENTITLEMENTS";

export const KIN_SIGNER_EXCLUDED_ENTITLEMENTS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
  "com.apple.security.cs.allow-dyld-environment-variables",
  "com.apple.security.get-task-allow",
  "com.apple.security.automation.apple-events",
] as const;

type SignerIdentity = { readonly teamId: string; readonly signerId: string };
type AppAttestEnvironment = "development" | "production";

export const kinSignerId = (appId: string) => `${appId}.signer`;
export const kinApprovalAccessGroup = (teamId: string, signerId: string) =>
  `${teamId}.${signerId}.approvals`;

export const renderKinSignerEntitlements = (
  input: SignerIdentity & { readonly appAttestEnvironment: AppAttestEnvironment },
) =>
  Plist.build({
    "com.apple.application-identifier": `${input.teamId}.${input.signerId}`,
    "com.apple.developer.team-identifier": input.teamId,
    [APP_ATTEST]: input.appAttestEnvironment,
    [ACCESS_GROUPS]: [kinApprovalAccessGroup(input.teamId, input.signerId)],
  });

export const readMacProvisioningProfileEntitlements = (profile: string): unknown => {
  const start = profile.indexOf("<?xml");
  const end = profile.indexOf("</plist>", start);
  if (start === -1 || end === -1) return undefined;
  try {
    const parsed = Plist.parse(profile.slice(start, end + "</plist>".length));
    return parsed && typeof parsed === "object" && "Entitlements" in parsed
      ? parsed.Entitlements
      : undefined;
  } catch {
    return undefined;
  }
};

class KinSignerProfileEntitlementError extends Schema.TaggedError<
  KinSignerProfileEntitlementError,
  { readonly brand: unique symbol }
>()("KinSignerProfileEntitlementError", { entitlement: Schema.String, expected: Schema.String }) {
  override get message() {
    return `Kin signer provisioning profile does not authorize ${this.entitlement} (${this.expected}).`;
  }
}

const isSignerProfileEntitlements = Schema.is(
  Schema.Struct({
    [APP_ATTEST]: Schema.optional(Schema.Unknown),
    [ACCESS_GROUPS]: Schema.optional(Schema.Unknown),
  }),
);

export function resolveKinSignerEntitlements(
  profile: string,
  identity: SignerIdentity,
  expectedEnvironment?: AppAttestEnvironment,
) {
  const candidate = readMacProvisioningProfileEntitlements(profile);
  const entitlements = isSignerProfileEntitlements(candidate) ? candidate : undefined;
  const appAttestEnvironment = entitlements?.[APP_ATTEST];
  if (appAttestEnvironment !== "development" && appAttestEnvironment !== "production") {
    return new KinSignerProfileEntitlementError({
      entitlement: APP_ATTEST,
      expected: "development or production",
    });
  }
  if (expectedEnvironment !== undefined && expectedEnvironment !== appAttestEnvironment) {
    return new KinSignerProfileEntitlementError({
      entitlement: APP_ATTEST,
      expected: expectedEnvironment,
    });
  }
  const accessGroup = kinApprovalAccessGroup(identity.teamId, identity.signerId);
  const groups = entitlements?.[ACCESS_GROUPS];
  if (
    !Array.isArray(groups) ||
    !groups.some(
      (group: unknown) =>
        typeof group === "string" &&
        (group === accessGroup ||
          (group.endsWith("*") && accessGroup.startsWith(group.slice(0, -1)))),
    )
  ) {
    return new KinSignerProfileEntitlementError({
      entitlement: ACCESS_GROUPS,
      expected: "the signer approvals group",
    });
  }
  return { ...identity, appAttestEnvironment } satisfies SignerIdentity & {
    readonly appAttestEnvironment: AppAttestEnvironment;
  };
}

class KinSignerBuildError extends Schema.TaggedError<
  KinSignerBuildError,
  { readonly brand: unique symbol }
>()("KinSignerBuildError", {
  message: Schema.String,
}) {}

const runXcrun = Effect.fn("KinSigner.runXcrun")(function* (args: string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make("xcrun", args, { stdout: "inherit", stderr: "inherit" }),
  );
  const exitCode = yield* child.exitCode;
  if (exitCode !== 0) {
    return yield* new KinSignerBuildError({
      message: `xcrun ${args[0]} exited with code ${exitCode}.`,
    });
  }
});

export const buildKinSigner = Effect.fn("KinSigner.build")(function* (input: {
  readonly arch: "arm64" | "x64" | "universal";
  readonly outDir: string;
  readonly appId: string;
  readonly version: string;
  readonly signing?: {
    readonly teamId: string;
    readonly profilePath: string;
    readonly expectedEnvironment?: AppAttestEnvironment;
  };
}) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const source = yield* path.fromFileUrl(
    new URL("../../apps/desktop/native/kin-signer/", import.meta.url),
  );
  const signerId = kinSignerId(input.appId);
  const bundlePath = path.join(input.outDir, SIGNER_BUNDLE);
  const contents = path.join(bundlePath, "Contents");
  const executable = path.join(contents, "MacOS", SIGNER_EXECUTABLE);
  const template = Plist.parse(yield* fs.readFileString(path.join(source, "Info.plist")));
  if (
    typeof template !== "object" ||
    !template ||
    !("LSMinimumSystemVersion" in template) ||
    typeof template.LSMinimumSystemVersion !== "string"
  ) {
    return yield* new KinSignerBuildError({
      message: "The signer Info.plist lacks LSMinimumSystemVersion.",
    });
  }
  let entitlementsPath: string | undefined;
  if (input.signing) {
    const { teamId, profilePath, expectedEnvironment } = input.signing;
    const profile = yield* fs.readFile(profilePath);
    const signing = resolveKinSignerEntitlements(
      new TextDecoder().decode(profile),
      { teamId, signerId },
      expectedEnvironment,
    );
    if ("_tag" in signing) return yield* signing;
    yield* fs.makeDirectory(contents, { recursive: true });
    yield* fs.writeFile(path.join(contents, "embedded.provisionprofile"), profile);
    entitlementsPath = path.join(input.outDir, "kin-signer-entitlements.plist");
    yield* fs.writeFileString(entitlementsPath, renderKinSignerEntitlements(signing));
  }
  yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
  const version = input.version.split(/[+-]/u, 1)[0]!;
  yield* fs.writeFileString(
    path.join(contents, "Info.plist"),
    Plist.build({
      ...template,
      CFBundleIdentifier: signerId,
      CFBundleShortVersionString: version,
      CFBundleVersion: version,
    }),
  );
  const architectures =
    input.arch === "universal"
      ? ["arm64", "x86_64"]
      : [input.arch === "arm64" ? "arm64" : "x86_64"];
  const slices = [];
  for (const arch of architectures) {
    const output =
      input.arch === "universal" ? path.join(input.outDir, `kin-signer-${arch}`) : executable;
    yield* runXcrun([
      "swiftc",
      "-O",
      "-parse-as-library",
      "-target",
      `${arch}-apple-macos${template.LSMinimumSystemVersion}`,
      path.join(source, "Sources", "main.swift"),
      "-o",
      output,
    ]);
    slices.push(output);
  }
  if (input.arch === "universal") {
    yield* runXcrun(["lipo", "-create", ...slices, "-output", executable]);
  }
  return { bundlePath, executable, entitlementsPath };
}, Effect.scoped);

export function resolveKinSignerProfilePath(
  env: Readonly<Record<string, string | undefined>> | undefined,
) {
  return env?.KIN_MACOS_SIGNER_PROVISIONING_PROFILE?.trim() || undefined;
}
