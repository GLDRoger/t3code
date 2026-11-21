import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { KinOrgId } from "./kinChat.ts";
import { KinGitHubStatus } from "./kinConnections.ts";

// The GitHub status as phone builds already in people's hands decode it, before `instantOffer`
// and `elsewhere`: what they never read stays `Unknown`.
const OldInstant = Schema.Struct({
  state: Schema.Literals(["on", "events", "address", "error"]),
  missing: Schema.Array(Schema.String),
  settingsUrl: Schema.NullOr(Schema.String),
  last: Schema.NullOr(Schema.Struct({ at: Schema.String, ok: Schema.Boolean })),
});
const OldStatus = Schema.Struct({
  orgId: KinOrgId,
  account: Schema.NullOr(Schema.Unknown),
  signIn: Schema.NullOr(Schema.Unknown),
  failed: Schema.NullOr(Schema.String),
  watch: Schema.optional(Schema.Unknown),
  agents: Schema.optional(
    Schema.Struct({
      as: Schema.Literals(["app", "owner"]),
      problem: Schema.NullOr(Schema.String),
      watched: Schema.Number,
      installed: Schema.Number,
      without: Schema.Array(Schema.String),
      ownerUses: Schema.Array(Schema.Unknown),
      instant: Schema.optional(OldInstant),
    }),
  ),
});

const status = (agents: Partial<NonNullable<KinGitHubStatus["agents"]>>): KinGitHubStatus => ({
  orgId: KinOrgId.make("org"),
  account: null,
  signIn: null,
  failed: null,
  agents: {
    as: "app",
    appName: "Invented Kin",
    problem: null,
    watched: 2,
    installed: 2,
    without: [],
    ownerUses: [],
    ...agents,
  },
});

const encodeNew = Schema.encodeSync(KinGitHubStatus);
const decodeOld = Schema.decodeUnknownSync(OldStatus);
const onAnOldPhone = (value: KinGitHubStatus) =>
  decodeOld(JSON.parse(JSON.stringify(encodeNew(value))));

describe("KinGitHubStatus on an older phone", () => {
  it("decodes the offer as no row, and another's address as the error it showed before", () => {
    expect(onAnOldPhone(status({ instantOffer: true })).agents?.instant).toBeUndefined();
    const instant = {
      state: "error" as const,
      missing: [],
      settingsUrl: "https://github.com/settings/apps/invented-kin/permissions",
      last: null,
    };
    expect(
      onAnOldPhone(status({ instant: { ...instant, elsewhere: true } })).agents?.instant,
    ).toEqual(instant);
  });
});
