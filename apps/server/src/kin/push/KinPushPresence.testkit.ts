import { type AuthSessionId, AuthStandardClientScopes } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { KinPushCaller } from "./KinPushDevices.ts";
import { KinPushPresence, makeWith } from "./KinPushPresence.ts";

/** Presence that lets every caller watch every chat, for tests about suppression timing. */
export const layerTrusting = Layer.effect(
  KinPushPresence,
  makeWith(() => Effect.void),
);

export const watcher = (sessionId: AuthSessionId): KinPushCaller => ({
  session: {
    sessionId,
    subject: "phone",
    method: "browser-session-cookie",
    scopes: AuthStandardClientScopes,
  },
  people: [],
});
