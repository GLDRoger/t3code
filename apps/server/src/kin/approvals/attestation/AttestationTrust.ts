// @effect-diagnostics nodeBuiltinImport:off -- X509Certificate for the pinned roots.
import * as NodeCrypto from "node:crypto";

import type { KinApproverKeyPlatform } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { APPLE_APP_ATTEST_ROOT, GOOGLE_HARDWARE_ATTESTATION_ROOTS } from "./roots.ts";
import type { AttestationTrust } from "./verify.ts";

const STATUS_URL = "https://android.googleapis.com/attestation/status";
const STATUS_TTL = Duration.hours(1);
const StatusList = Schema.Struct({
  entries: Schema.Record(Schema.String, Schema.Struct({ status: Schema.String })),
});

export class KinAttestationTrustError extends Schema.TaggedError<KinAttestationTrustError>()(
  "KinAttestationTrustError",
  { message: Schema.String },
) {}

export class KinAttestationTrust extends Context.Service<
  KinAttestationTrust,
  {
    /** Android fails rather than trust a chain it couldn't check for revocation. */
    readonly load: (
      platform: KinApproverKeyPlatform,
    ) => Effect.Effect<AttestationTrust, KinAttestationTrustError>;
  }
>()("t3/kin/approvals/attestation/AttestationTrust/KinAttestationTrust") {}

const hexList = (name: string) =>
  Config.String(name).pipe(
    Config.withDefault(""),
    Config.map((value) =>
      value
        .split(",")
        .map((entry) => entry.trim().toLowerCase().replaceAll(":", ""))
        .filter((entry) => entry.length > 0),
    ),
  );

/** Production trust: pinned roots, the release app identity from config, Google's status list. */
export const layer = Layer.effect(
  KinAttestationTrust,
  Effect.gen(function* () {
    const config = yield* Config.all({
      androidPackage: Config.String("KIN_ANDROID_PACKAGE").pipe(Config.option),
      androidSigners: hexList("KIN_ANDROID_SIGNING_CERT_SHA256"),
      appleAppId: Config.String("KIN_IOS_APP_ID").pipe(Config.option),
      appleDevelopment: Config.Boolean("KIN_IOS_APP_ATTEST_DEVELOPMENT").pipe(
        Config.withDefault(false),
      ),
    });
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const cache = yield* Ref.make(Option.none<{ at: number; serials: ReadonlySet<string> }>());
    const fixed = {
      googleRoots: GOOGLE_HARDWARE_ATTESTATION_ROOTS.map(
        (pem) => new NodeCrypto.X509Certificate(pem),
      ),
      appleRoot: new NodeCrypto.X509Certificate(APPLE_APP_ATTEST_ROOT),
      androidApps: Option.isSome(config.androidPackage)
        ? [{ packageName: config.androidPackage.value, signingCertSha256: config.androidSigners }]
        : [],
      appleAppIds: Option.isSome(config.appleAppId) ? [config.appleAppId.value] : [],
      appleEnvironments: config.appleDevelopment
        ? (["production", "development"] as const)
        : (["production"] as const),
    };
    const revoked = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = yield* Ref.get(cache);
      if (Option.isSome(cached) && now - cached.value.at < Duration.toMillis(STATUS_TTL))
        return cached.value.serials;
      const list = yield* http
        .get(STATUS_URL)
        .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(StatusList)), Effect.scoped);
      const serials = new Set(
        Object.entries(list.entries)
          .filter(([, entry]) => entry.status === "REVOKED" || entry.status === "SUSPENDED")
          .map(([serial]) => serial.toLowerCase().replace(/^0+(?=.)/, "")),
      );
      yield* Ref.set(cache, Option.some({ at: now, serials }));
      return serials as ReadonlySet<string>;
    }).pipe(
      Effect.timeout(Duration.seconds(10)),
      Effect.mapError(
        () =>
          new KinAttestationTrustError({
            message: "Couldn't load Google's attestation revocation list.",
          }),
      ),
    );
    return KinAttestationTrust.of({
      load: Effect.fn("KinAttestationTrust.load")(function* (platform: KinApproverKeyPlatform) {
        const androidRevokedSerials = platform === "ios" ? new Set<string>() : yield* revoked;
        return { ...fixed, androidRevokedSerials };
      }),
    });
  }),
);
