import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinOrgId } from "./kinChat.ts";
import { KinGitHubStatus } from "./kinConnections.ts";

// The whole GitHub status as phone builds already in people's hands decode it: copied from kin at
// 5648c73163, before `instantOffer` and `elsewhere`.
const OldInstant = Schema.Struct({
  state: Schema.Literals(["on", "events", "address", "error"]),
  missing: Schema.Array(Schema.String),
  settingsUrl: Schema.NullOr(Schema.String),
  last: Schema.NullOr(Schema.Struct({ at: Schema.String, ok: Schema.Boolean })),
});
const OldAgents = Schema.Struct({
  as: Schema.Literals(["app", "owner"]),
  appName: Schema.optional(Schema.String),
  botLogin: Schema.optional(Schema.String),
  installUrl: Schema.optional(Schema.String),
  problem: Schema.NullOr(Schema.String),
  watched: NonNegativeInt,
  installed: NonNegativeInt,
  elsewhere: Schema.optional(NonNegativeInt),
  without: Schema.Array(Schema.String),
  ownerUses: Schema.Array(
    Schema.Struct({
      at: NonNegativeInt,
      agent: Schema.NullOr(Schema.String),
      repo: Schema.NullOr(Schema.String),
      command: Schema.String,
    }),
  ),
  canCreate: Schema.optional(Schema.Boolean),
  setUp: Schema.optional(
    Schema.Struct({
      source: Schema.Literals(["kin", "host"]),
      name: Schema.NullOr(Schema.String),
      at: Schema.NullOr(NonNegativeInt),
      by: Schema.NullOr(Schema.String),
      settingsUrl: Schema.NullOr(Schema.String),
    }),
  ),
  accounts: Schema.optional(
    Schema.Array(
      Schema.Struct({
        account: TrimmedNonEmptyString,
        organisation: Schema.Boolean,
        watched: NonNegativeInt,
        covered: NonNegativeInt,
        installation: Schema.Literals(["all", "selected", "none", "suspended"]),
        settingsUrl: Schema.NullOr(Schema.String),
        installUrl: Schema.NullOr(Schema.String),
        canManage: Schema.NullOr(Schema.Boolean),
        installable: Schema.Boolean,
        elsewhere: Schema.optional(NonNegativeInt),
      }),
    ),
  ),
  appOwner: Schema.optional(Schema.String),
  appSettingsUrl: Schema.optional(Schema.String),
  instant: Schema.optional(OldInstant),
});
const OldStatus = Schema.Struct({
  orgId: KinOrgId,
  account: Schema.NullOr(
    Schema.Struct({
      login: Schema.String,
      orgs: Schema.Array(Schema.String),
      scopes: Schema.Array(Schema.String),
      problem: Schema.NullOr(Schema.String),
    }),
  ),
  signIn: Schema.NullOr(
    Schema.Struct({ code: Schema.String, url: Schema.String, expiresAt: NonNegativeInt }),
  ),
  failed: Schema.NullOr(Schema.String),
  watch: Schema.optional(
    Schema.Struct({
      repos: NonNegativeInt,
      checkedAt: Schema.NullOr(NonNegativeInt),
      handledToday: NonNegativeInt,
      problem: Schema.NullOr(Schema.String),
      open: Schema.optional(NonNegativeInt),
    }),
  ),
  agents: Schema.optional(OldAgents),
});

const status = (agents: Partial<NonNullable<KinGitHubStatus["agents"]>>): KinGitHubStatus => ({
  orgId: KinOrgId.make("org"),
  account: { login: "invented-owner", orgs: ["invented-co"], scopes: ["repo"], problem: null },
  signIn: null,
  failed: null,
  watch: { repos: 2, checkedAt: 1, handledToday: 0, problem: null },
  agents: {
    as: "app",
    appName: "Invented Kin",
    botLogin: "invented-kin[bot]",
    problem: null,
    watched: 2,
    installed: 2,
    without: [],
    ownerUses: [{ at: 1, agent: "Tech lead", repo: "invented-co/app", command: "gh pr list" }],
    setUp: { source: "kin", name: "Invented Kin", at: null, by: null, settingsUrl: null },
    accounts: [
      {
        account: "invented-co",
        organisation: true,
        watched: 2,
        covered: 2,
        installation: "all",
        settingsUrl: null,
        installUrl: null,
        canManage: true,
        installable: true,
      },
    ],
    ...agents,
  },
});

const encodeNew = Schema.encodeSync(KinGitHubStatus);
const decodeOld = Schema.decodeUnknownSync(OldStatus);
const wire = (value: KinGitHubStatus) => JSON.parse(JSON.stringify(encodeNew(value)));

describe("KinGitHubStatus on an older phone", () => {
  it("carries the new fields, which an older phone decodes as no row and as the old error row", () => {
    const offer = wire(status({ instantOffer: true }));
    expect(offer.agents.instantOffer).toBe(true);
    expect(decodeOld(offer).agents?.instant).toBeUndefined();

    const instant = {
      state: "error" as const,
      missing: [],
      settingsUrl: "https://github.com/settings/apps/invented-kin/permissions",
      last: null,
    };
    const elsewhere = wire(status({ instant: { ...instant, elsewhere: true } }));
    expect(elsewhere.agents.instant.elsewhere).toBe(true);
    expect(decodeOld(elsewhere).agents?.instant).toEqual(instant);
  });
});
