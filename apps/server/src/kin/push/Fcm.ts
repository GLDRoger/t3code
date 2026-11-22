// @effect-diagnostics nodeBuiltinImport:off -- RS256 signing and the service-account key file.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import type { KinPushSendingStatus, KinPushToken } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

export const FCM_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const FCM_ORIGIN = "https://fcm.googleapis.com";
// Google's access tokens last an hour; one is renewed this long before it ends.
const ASSERTION_TTL_S = 60 * 60;
const RENEW_BEFORE_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT = "10 seconds";

export type KinFcmCredentials = {
  readonly projectId: string;
  readonly clientEmail: string;
  readonly key: NodeCrypto.KeyObject;
};

/** An FCM HTTP V1 `message` less its token: data-only, so the app shows it with its buttons. */
export type KinFcmPush = {
  readonly token: KinPushToken;
  readonly data: Readonly<Record<string, string>>;
  readonly priority: "HIGH" | "NORMAL";
};

/** `status` 0 means Google never answered; `reason` is FCM's `errorCode`, else the error's status. */
export type KinFcmResult = { readonly status: number; readonly reason: string | undefined };

export class KinFcmTransport extends Context.Service<
  KinFcmTransport,
  {
    readonly status: KinPushSendingStatus;
    readonly send: (push: KinFcmPush) => Effect.Effect<KinFcmResult>;
  }
>()("t3/kin/push/Fcm/KinFcmTransport") {}

const base64Url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** The signed JWT Google exchanges for an access token (OAuth 2.0 for service accounts). */
const fcmAssertion = (credentials: KinFcmCredentials, nowMs: number) => {
  const iat = Math.floor(nowMs / 1000);
  const signingInput = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(
    JSON.stringify({
      iss: credentials.clientEmail,
      scope: FCM_SCOPE,
      aud: FCM_TOKEN_URL,
      iat,
      exp: iat + ASSERTION_TTL_S,
    }),
  )}`;
  const signature = NodeCrypto.sign("sha256", Buffer.from(signingInput), credentials.key);
  return `${signingInput}.${base64Url(signature)}`;
};

const ServiceAccount = Schema.Struct({
  type: Schema.Literal("service_account"),
  project_id: Schema.NonEmptyString,
  client_email: Schema.NonEmptyString,
  private_key: Schema.NonEmptyString,
});
const decodeServiceAccount = Schema.decodeUnknownOption(Schema.fromJsonString(ServiceAccount));

/**
 * Reads `KIN_FCM_SERVICE_ACCOUNT_FILE`, the service-account key from the Firebase project, kept
 * outside the repo; the project id is the file's. Unset or unreadable leaves Android push off.
 */
export const loadFcmCredentials = Effect.fn("KinFcm.loadCredentials")(function* () {
  const file = yield* Config.String("KIN_FCM_SERVICE_ACCOUNT_FILE").pipe(
    Config.option,
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  if (Option.isNone(file)) return yield* Effect.fail("no FCM service account is configured");
  const path = file.value;
  // Errors name what failed, never the file's contents.
  const text = yield* Effect.try({
    try: () => NodeFS.readFileSync(path, "utf8"),
    catch: () => "KIN_FCM_SERVICE_ACCOUNT_FILE can't be read",
  });
  const account = decodeServiceAccount(text);
  if (Option.isNone(account))
    return yield* Effect.fail("KIN_FCM_SERVICE_ACCOUNT_FILE isn't a service-account key");
  const key = yield* Effect.try({
    try: () => NodeCrypto.createPrivateKey(account.value.private_key),
    catch: () => "KIN_FCM_SERVICE_ACCOUNT_FILE's private key doesn't load",
  });
  if (key.asymmetricKeyType !== "rsa")
    return yield* Effect.fail("KIN_FCM_SERVICE_ACCOUNT_FILE's key isn't an RSA key");
  return {
    projectId: account.value.project_id,
    clientEmail: account.value.client_email,
    key,
  } satisfies KinFcmCredentials;
});

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/** FCM's `errorCode` from `error.details`, else `error.status`. */
const fcmReason = (body: unknown) => {
  const error = field(body, "error");
  const details = field(error, "details");
  if (Array.isArray(details))
    for (const detail of details) {
      const code = field(detail, "errorCode");
      if (typeof code === "string") return code;
    }
  const status = field(error, "status");
  return typeof status === "string" ? status : undefined;
};

const unreachable: KinFcmResult = { status: 0, reason: "transport" };
// No answer, or Google's own trouble: worth one more try.
const RETRY_STATUSES = new Set([0, 500, 503]);

export const makeFcmTransport = Effect.fn("KinFcm.makeTransport")(function* (
  credentials: KinFcmCredentials,
) {
  const http = yield* HttpClient.HttpClient;
  let access: { readonly value: string; readonly until: number } | undefined;
  // Sends run side by side; one exchange serves them all.
  const lock = yield* Semaphore.make(1);

  const post = (request: HttpClientRequest.HttpClientRequest) =>
    http.execute(request).pipe(
      Effect.flatMap((response) =>
        response.json.pipe(
          Effect.orElseSucceed(() => null),
          Effect.map((body: unknown) => ({ status: response.status, body })),
        ),
      ),
      Effect.timeout(REQUEST_TIMEOUT),
    );

  const exchange = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const answer = yield* post(
      HttpClientRequest.post(FCM_TOKEN_URL).pipe(
        HttpClientRequest.bodyUrlParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: fcmAssertion(credentials, now),
        }),
      ),
    ).pipe(Effect.option);
    const token = Option.isSome(answer) ? field(answer.value.body, "access_token") : undefined;
    const lasts = Option.isSome(answer) ? field(answer.value.body, "expires_in") : undefined;
    if (Option.isNone(answer) || answer.value.status !== 200 || typeof token !== "string") {
      yield* Effect.logError(
        "Google refused Kin's FCM service account: check KIN_FCM_SERVICE_ACCOUNT_FILE.",
        { status: Option.isSome(answer) ? answer.value.status : 0 },
      );
      return undefined;
    }
    const seconds = typeof lasts === "number" && lasts > 0 ? lasts : ASSERTION_TTL_S;
    access = { value: token, until: now + seconds * 1000 - RENEW_BEFORE_MS };
    return access.value;
  });

  const accessToken = lock.withPermits(1)(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (access !== undefined && now < access.until) return access.value;
      return yield* exchange;
    }),
  );

  const url = `${FCM_ORIGIN}/v1/projects/${encodeURIComponent(credentials.projectId)}/messages:send`;
  const attempt = Effect.fnUntraced(function* (push: KinFcmPush, token: string) {
    const answer = yield* post(
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.bodyJsonUnsafe({
          message: { token: push.token, data: push.data, android: { priority: push.priority } },
        }),
      ),
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Kin push couldn't reach FCM.", { error: String(error) }).pipe(
          Effect.as(undefined),
        ),
      ),
    );
    if (answer === undefined) return unreachable;
    return {
      status: answer.status,
      reason: answer.status === 200 ? undefined : fcmReason(answer.body),
    } satisfies KinFcmResult;
  });

  return KinFcmTransport.of({
    status: "ready",
    // At most one retry per push, and one renewal of a token Google stopped taking.
    send: Effect.fn("KinFcmTransport.send")(function* (push: KinFcmPush) {
      const token = yield* accessToken;
      if (token === undefined) return { status: 0, reason: "auth" };
      const result = yield* attempt(push, token);
      if (RETRY_STATUSES.has(result.status)) return yield* attempt(push, token);
      if (result.status === 401) {
        if (access?.value === token) access = undefined;
        const renewed = yield* accessToken;
        if (renewed !== undefined) return yield* attempt(push, renewed);
      }
      return result;
    }),
  });
});

const make = Effect.gen(function* () {
  const loaded = yield* Effect.result(loadFcmCredentials());
  if (loaded._tag === "Failure") {
    yield* Effect.logInfo(`Kin push to Android is off: ${loaded.failure}.`);
    return KinFcmTransport.of({
      status: "unconfigured",
      send: Effect.fn("KinFcmTransport.sendUnconfigured")(function* () {
        return yield* Effect.succeed({ status: 0, reason: "unconfigured" });
      }),
    });
  }
  yield* Effect.logInfo("Kin push to Android is on.", { projectId: loaded.success.projectId });
  return yield* makeFcmTransport(loaded.success);
});

export const layer = Layer.effect(KinFcmTransport, make).pipe(Layer.provide(FetchHttpClient.layer));
