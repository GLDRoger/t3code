#!/usr/bin/env node
// Dev only: one test push through the server's own APNs transport. From apps/server, with the
// KIN_APNS_* variables set:
// node scripts/kin-push-test.ts <device token hex> <host environment id> [development|production]
// The mobile spec's "Test push" step has the full runbook.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import {
  EnvironmentId,
  KinApsEnvironment,
  KinChatId,
  KinOrgId,
  KinPushData,
  KinPushToken,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { KinApnsTransport, layer } from "../src/kin/push/Apns.ts";
import { kinPushDeviceId } from "../src/kin/push/KinPushDevices.ts";
import { kinPushChatLink } from "../src/kin/push/KinPushSender.ts";

class KinPushTestError extends Schema.TaggedError<KinPushTestError>()("KinPushTestError", {
  message: Schema.String,
}) {}

const decodeToken = Schema.decodeUnknownEffect(KinPushToken);
const decodeEnvironment = Schema.decodeUnknownEffect(KinApsEnvironment);
const decodeEnvironmentId = Schema.decodeUnknownEffect(EnvironmentId);
const decodeData = Schema.decodeEffect(KinPushData);

const program = Effect.gen(function* () {
  const [rawToken, rawEnvironmentId, rawEnvironment = "development"] = process.argv.slice(2);
  const token = yield* decodeToken(rawToken?.toLowerCase());
  const environmentId = yield* decodeEnvironmentId(rawEnvironmentId);
  const environment = yield* decodeEnvironment(rawEnvironment);
  const apns = yield* KinApnsTransport;
  if (apns.status === "unconfigured")
    return yield* new KinPushTestError({ message: "APNs isn't configured; see the log above." });
  const orgId = KinOrgId.make("kin-default");
  const body = yield* decodeData({
    kin: 1,
    orgId,
    deepLink: kinPushChatLink(environmentId, orgId, KinChatId.make("test")),
  });
  const result = yield* apns.send({
    token,
    environment,
    payload: {
      aps: {
        alert: { title: "Kin", body: "Test push from the Kin host" },
        category: "kin.message",
        sound: "default",
      },
      body,
    },
  });
  yield* Effect.log("APNs answered.", { deviceId: kinPushDeviceId(token), ...result });
  if (result.status !== 200)
    return yield* new KinPushTestError({ message: "APNs refused the push." });
});

program.pipe(Effect.provide(layer), Effect.scoped, NodeRuntime.runMain);
