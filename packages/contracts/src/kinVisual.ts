import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthSettingsWriteScope, EnvironmentAuthorizationError } from "./auth.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinChatError, KinOrgId, KinTrimmedText } from "./kinChat.ts";

/**
 * A `visual` card: a page an agent wrote, kept as one of the chat's files and drawn in a sealed
 * frame. The card holds no markup, only where the page is and how tall to start.
 */
export const KinVisualCardState = Schema.Struct({
  title: KinTrimmedText.check(Schema.isMaxLength(120)),
  attachmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  height: Schema.Finite.check(Schema.isBetween({ minimum: 80, maximum: 2000 })),
});
export type KinVisualCardState = typeof KinVisualCardState.Type;

/** A bare DNS name, lower case: `tile.example.com`. The server normalises and checks it. */
export const KinVisualHost = TrimmedNonEmptyString.check(Schema.isMaxLength(253));

export const KinVisualHostsInput = Schema.Struct({ orgId: KinOrgId });
export type KinVisualHostsInput = typeof KinVisualHostsInput.Type;
export const KinVisualHostInput = Schema.Struct({ orgId: KinOrgId, host: KinVisualHost });
export type KinVisualHostInput = typeof KinVisualHostInput.Type;
/** The hosts a visual in this organization may load images, fonts, styles, media and data from. */
export const KinVisualHosts = Schema.Struct({
  orgId: KinOrgId,
  hosts: Schema.Array(KinVisualHost),
});
export type KinVisualHosts = typeof KinVisualHosts.Type;

const KinVisualError = Schema.Union([KinChatError, EnvironmentAuthorizationError]);

/** Owner only: a host on this list is somewhere a page can send what it holds. */
export const KinVisualRpcs = [
  Rpc.make("kin.visuals.hosts.list", {
    payload: KinVisualHostsInput,
    success: KinVisualHosts,
    error: KinVisualError,
  }),
  Rpc.make("kin.visuals.hosts.allow", {
    payload: KinVisualHostInput,
    success: KinVisualHosts,
    error: KinVisualError,
  }),
  Rpc.make("kin.visuals.hosts.remove", {
    payload: KinVisualHostInput,
    success: KinVisualHosts,
    error: KinVisualError,
  }),
] as const;

export const KIN_VISUAL_RPC_SCOPES = {
  "kin.visuals.hosts.list": AuthSettingsWriteScope,
  "kin.visuals.hosts.allow": AuthSettingsWriteScope,
  "kin.visuals.hosts.remove": AuthSettingsWriteScope,
} as const;
