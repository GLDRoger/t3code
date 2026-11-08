// @effect-diagnostics nodeBuiltinImport:off -- ES256 signing, the .p8 file and APNs' HTTP/2 API.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp2 from "node:http2";

import type { KinApsEnvironment, KinPushSendingStatus, KinPushToken } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const ORIGINS: Record<KinApsEnvironment, string> = {
  development: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};
// APNs refuses tokens older than an hour and throttles ones renewed more often than every 20 minutes.
const JWT_TTL_MS = 40 * 60 * 1000;
const REQUEST_TIMEOUT = "10 seconds";

export type KinApnsCredentials = {
  readonly keyId: string;
  readonly teamId: string;
  /** The Kin build's bundle id, sent as `apns-topic`. */
  readonly topic: string;
  readonly key: NodeCrypto.KeyObject;
};

export type KinApnsPush = {
  readonly token: KinPushToken;
  readonly environment: KinApsEnvironment;
  readonly payload: unknown;
};

/** `status` 0 means APNs never answered (network, timeout); nothing was delivered. */
export type KinApnsResult = { readonly status: number; readonly reason: string | undefined };

export class KinApnsTransport extends Context.Service<
  KinApnsTransport,
  {
    readonly status: KinPushSendingStatus;
    readonly send: (push: KinApnsPush) => Effect.Effect<KinApnsResult>;
  }
>()("t3/kin/push/Apns/KinApnsTransport") {}

const base64Url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** APNs provider token: ES256 over `{alg, kid}.{iss, iat}`. */
export const apnsProviderToken = (credentials: KinApnsCredentials, nowMs: number) => {
  const signingInput = `${base64Url(JSON.stringify({ alg: "ES256", kid: credentials.keyId }))}.${base64Url(
    JSON.stringify({ iss: credentials.teamId, iat: Math.floor(nowMs / 1000) }),
  )}`;
  const signature = NodeCrypto.sign("sha256", Buffer.from(signingInput), {
    key: credentials.key,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64Url(signature)}`;
};

export const apnsRequestHeaders = (
  credentials: KinApnsCredentials,
  push: KinApnsPush,
  jwt: string,
) => ({
  ":method": "POST",
  ":path": `/3/device/${push.token}`,
  authorization: `bearer ${jwt}`,
  "apns-topic": credentials.topic,
  "apns-push-type": "alert",
  "apns-priority": "10",
  "content-type": "application/json",
});

/**
 * Reads `KIN_APNS_KEY_FILE` (the `.p8` from Apple, kept outside the repo), `KIN_APNS_KEY_ID`,
 * `KIN_APNS_TEAM_ID` and `KIN_APNS_TOPIC`. Anything missing or unreadable leaves push off;
 * it never stops Kin from starting.
 */
export const loadApnsCredentials = Effect.fn("KinApns.loadCredentials")(function* () {
  const config = yield* Config.all({
    keyFile: Config.String("KIN_APNS_KEY_FILE").pipe(Config.option),
    keyId: Config.String("KIN_APNS_KEY_ID").pipe(Config.option),
    teamId: Config.String("KIN_APNS_TEAM_ID").pipe(Config.option),
    topic: Config.String("KIN_APNS_TOPIC").pipe(Config.option),
  }).pipe(Effect.orElseSucceed(() => undefined));
  if (config === undefined) return yield* Effect.fail("invalid APNs configuration");
  const values = [config.keyFile, config.keyId, config.teamId, config.topic];
  if (values.every(Option.isNone)) return yield* Effect.fail("no APNs key is configured");
  if (
    Option.isNone(config.keyFile) ||
    Option.isNone(config.keyId) ||
    Option.isNone(config.teamId) ||
    Option.isNone(config.topic)
  )
    return yield* Effect.fail(
      "set all of KIN_APNS_KEY_FILE, KIN_APNS_KEY_ID, KIN_APNS_TEAM_ID and KIN_APNS_TOPIC",
    );
  const path = config.keyFile.value;
  const key = yield* Effect.try({
    try: () => NodeCrypto.createPrivateKey(NodeFS.readFileSync(path, "utf8")),
    // The message would name the file's contents on a parse error; say only what failed.
    catch: () => "KIN_APNS_KEY_FILE isn't a readable .p8 key",
  });
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    return yield* Effect.fail("KIN_APNS_KEY_FILE isn't an APNs (P-256) key");
  return {
    keyId: config.keyId.value,
    teamId: config.teamId.value,
    topic: config.topic.value,
    key,
  } satisfies KinApnsCredentials;
});

const post = (
  session: NodeHttp2.ClientHttp2Session,
  headers: NodeHttp2.OutgoingHttpHeaders,
  body: string,
) =>
  Effect.callback<KinApnsResult, Error>((resume) => {
    const request = session.request(headers);
    let status = 0;
    const chunks: Array<Buffer> = [];
    request.on("response", (response) => {
      status = Number(response[":status"] ?? 0);
    });
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let reason: string | undefined;
      try {
        const parsed: unknown = text.length > 0 ? JSON.parse(text) : undefined;
        if (typeof parsed === "object" && parsed !== null && "reason" in parsed)
          reason = String(parsed.reason);
      } catch {
        reason = undefined;
      }
      resume(Effect.succeed({ status, reason }));
    });
    request.on("error", (error: Error) => resume(Effect.fail(error)));
    request.end(body);
    return Effect.sync(() => request.close(NodeHttp2.constants.NGHTTP2_CANCEL));
  });

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const unconfigured = (reason: string) =>
  Effect.logInfo(`Kin push is off: ${reason}.`).pipe(
    Effect.as(
      KinApnsTransport.of({
        status: "unconfigured",
        send: Effect.fn("KinApnsTransport.sendUnconfigured")(function* () {
          return yield* Effect.succeed({ status: 0, reason: "unconfigured" });
        }),
      }),
    ),
  );

const make = Effect.gen(function* () {
  const loaded = yield* Effect.result(loadApnsCredentials());
  if (loaded._tag === "Failure") return yield* unconfigured(loaded.failure);
  const credentials = loaded.success;
  const sessions = new Map<KinApsEnvironment, NodeHttp2.ClientHttp2Session>();
  let jwt: { readonly value: string; readonly at: number } | undefined;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const session of sessions.values()) session.close();
      sessions.clear();
    }),
  );

  const sessionFor = (environment: KinApsEnvironment) => {
    const open = sessions.get(environment);
    if (open !== undefined && !open.closed && !open.destroyed) return open;
    const session = NodeHttp2.connect(ORIGINS[environment]);
    const drop = () => {
      if (sessions.get(environment) === session) sessions.delete(environment);
    };
    session.on("error", drop);
    session.on("close", drop);
    session.on("goaway", drop);
    session.unref();
    sessions.set(environment, session);
    return session;
  };

  const providerToken = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (jwt === undefined || now - jwt.at >= JWT_TTL_MS)
      jwt = { value: apnsProviderToken(credentials, now), at: now };
    return jwt.value;
  });

  yield* Effect.logInfo("Kin push is on.", { topic: credentials.topic, keyId: credentials.keyId });
  return KinApnsTransport.of({
    status: "ready",
    send: Effect.fn("KinApnsTransport.send")(function* (push: KinApnsPush) {
      const headers = apnsRequestHeaders(credentials, push, yield* providerToken);
      return yield* encodeJson(push.payload).pipe(
        Effect.flatMap((body) => post(sessionFor(push.environment), headers, body)),
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.catch((error) =>
          Effect.logWarning("Kin push couldn't reach APNs.", { error: String(error) }).pipe(
            Effect.as({ status: 0, reason: "transport" }),
          ),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(KinApnsTransport, make);
