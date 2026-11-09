import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as Kin from "./kinTriggers.ts";

const at = "2026-11-07T00:00:00.000Z";
const schedules = [
  { type: "once", runAt: at },
  { type: "fixed_time", timeOfDay: "03:00" },
  { type: "fixed_time", timeOfDay: "8:30", weekdays: [0, 6] },
  { type: "interval", everyMs: 60_000 },
];
const subjects = [
  { type: "deferral", itemId: "deferral-1", phase: "heads_up" },
  { type: "deferral", itemId: "deferral-1", phase: "due" },
  { type: "reminder", itemId: "reminder-1" },
  { type: "followup", itemId: "commitment-1", person: "person-1" },
  ...Kin.KinRoutine.literals.map((routine) => ({ type: "routine", routine })),
  ...Kin.KinWatchdog.literals.map((watchdog) => ({ type: "watchdog", watchdog })),
];
const trigger = {
  id: "trigger-1",
  orgId: "org-1",
  subject: subjects[0],
  schedule: schedules[0],
  timeZone: "Asia/Kolkata",
  enabled: true,
  nextRunAt: at,
  lastFireId: null,
  createdAt: at,
  updatedAt: at,
};
const fire = {
  fireId: "trigger-1:1794009600000",
  orgId: "org-1",
  dueAt: at,
  firedAt: at,
  lateByMs: 0,
  payload: { kind: "time", triggerId: "trigger-1", subject: subjects[0] },
};
const source = {
  id: "source-1",
  orgId: "org-1",
  repo: "owner/repo",
  scheduledTaskId: "scheduled-task-1",
  inboxThreadId: "thread-1",
  githubHookId: null,
  botLogin: "kin[bot]",
  status: "active",
};
const githubEvent = {
  orgId: "org-1",
  deliveryId: "github-delivery-1",
  event: "pull_request",
  action: "closed",
  repo: "owner/repo",
  number: 212,
  headSha: "abc123",
  sender: "owner",
  receivedAt: at,
  heldByRelay: false,
  bodyTruncated: false,
  payload: { action: "closed", pull_request: { merged: true } },
};
const settings = {
  orgId: "org-1",
  timeZone: "Asia/Kolkata",
  morningBrief: "08:30",
  eveningSummary: "18:30",
  dream: "03:00",
  fullRebuildWeekday: 0,
  ownerCheckWeekday: 1,
  ownerCheck: "09:00",
  quietHours: { from: "21:00", to: "08:00" },
};

type SchemaName = {
  [K in keyof typeof Kin]: (typeof Kin)[K] extends Schema.Top ? K : never;
}[keyof typeof Kin];

const samples = {
  KinTriggerId: [Kin.KinTriggerId, ["trigger-1"]],
  KinTriggerFireId: [Kin.KinTriggerFireId, [fire.fireId]],
  KinWebhookSourceId: [Kin.KinWebhookSourceId, [source.id]],
  KinRoutine: [Kin.KinRoutine, Kin.KinRoutine.literals],
  KinWatchdog: [Kin.KinWatchdog, Kin.KinWatchdog.literals],
  KinTriggerSchedule: [Kin.KinTriggerSchedule, schedules],
  KinTriggerSubject: [Kin.KinTriggerSubject, subjects],
  KinTrigger: [
    Kin.KinTrigger,
    [trigger, { ...trigger, enabled: false, nextRunAt: null, lastFireId: fire.fireId }],
  ],
  KinTriggerFired: [
    Kin.KinTriggerFired,
    [
      fire,
      {
        ...fire,
        fireId: "gh:org-1:delivery-1",
        lateByMs: 36_000_000,
        payload: {
          kind: "github",
          sourceId: "source-1",
          scheduledTaskId: "scheduled-task-1",
          deliveryId: "delivery-1",
        },
      },
    ],
  ],
  KinWebhookSource: [
    Kin.KinWebhookSource,
    ["active", "paused_in_t3", "blocked_by_policy", "missing"].map((status) => ({
      ...source,
      status,
      githubHookId: status === "active" ? null : 123,
    })),
  ],
  KinGithubEvent: [
    Kin.KinGithubEvent,
    [
      githubEvent,
      {
        ...githubEvent,
        event: "push",
        action: null,
        number: null,
        headSha: null,
        heldByRelay: true,
        bodyTruncated: true,
        payload: null,
      },
    ],
  ],
  KinTriggerSettings: [Kin.KinTriggerSettings, [settings, { ...settings, timeZone: "UTC" }]],
  KinOwnerTimeZoneGetInput: [Kin.KinOwnerTimeZoneGetInput, [{ orgId: "org-1" }]],
  KinOwnerTimeZone: [Kin.KinOwnerTimeZone, [{ orgId: "org-1", timeZone: "Asia/Kolkata" }]],
  KinGithubWebhookSetupInput: [
    Kin.KinGithubWebhookSetupInput,
    [{ orgId: "org-1", projectId: "project-1" }],
  ],
  KinGithubWebhookOrgInput: [Kin.KinGithubWebhookOrgInput, [{ orgId: "org-1" }]],
  KinGithubWebhookSecretInput: [
    Kin.KinGithubWebhookSecretInput,
    [{ orgId: "org-1", secret: "0123456789abcdef" }],
  ],
  KinGithubWebhookSetup: [
    Kin.KinGithubWebhookSetup,
    [
      { status: "needs_connect" },
      ...["configured", "needs_secret", "needs_url"].map((status) => ({
        status,
        sourceId: Kin.KIN_GITHUB_APP_SOURCE,
        url: "https://relay.example/v1/hooks/env/task/token",
      })),
    ],
  ],
} satisfies Record<SchemaName, readonly [Schema.Codec<unknown>, ReadonlyArray<unknown>]>;

const secretRejections = [
  "too-short",
  " 0123456789abcdef",
  "0123456789abcdef\n",
  "01234567 89abcdef",
  "0123456789\tabcdef",
];

const rejections = [
  ...[
    "1",
    "2026-11-07",
    "Nov 7 2026",
    "2026-11-07 00:00",
    "2026-11-07T00:00:00",
    "2026-11-07T01:00:00.000+01:00",
    "2026-02-30T00:00:00.000Z",
  ].flatMap((invalid) => [
    ...["nextRunAt", "createdAt", "updatedAt"].map((field) => ({
      schema: Kin.KinTrigger,
      value: { ...trigger, [field]: invalid },
    })),
    ...["dueAt", "firedAt"].map((field) => ({
      schema: Kin.KinTriggerFired,
      value: { ...fire, [field]: invalid },
    })),
    { schema: Kin.KinGithubEvent, value: { ...githubEvent, receivedAt: invalid } },
  ]),
  ...["", "  \n "].map((value) => ({ schema: Kin.KinTriggerId, value })),
  ...secretRejections.map((secret) => ({
    schema: Kin.KinGithubWebhookSecretInput,
    value: { orgId: "org-1", secret },
  })),
  ...[0, 59_999, 60_000.5].map((everyMs) => ({
    schema: Kin.KinTriggerSchedule,
    value: { type: "interval", everyMs },
  })),
  ...[-1, 7, 1.5].map((weekday) => ({
    schema: Kin.KinTriggerSchedule,
    value: { type: "fixed_time", timeOfDay: "03:00", weekdays: [weekday] },
  })),
  ...["24:00", "09:60", "9:0"].map((timeOfDay) => ({
    schema: Kin.KinTriggerSchedule,
    value: { type: "fixed_time", timeOfDay },
  })),
  ...["", "next friday", "2026-11-13T09:00", "2026-02-30T09:00:00Z"].map((runAt) => ({
    schema: Kin.KinTriggerSchedule,
    value: { type: "once", runAt },
  })),
  ...["", "Not/AZone", "+05:30"].flatMap((timeZone) => [
    { schema: Kin.KinTrigger, value: { ...trigger, timeZone } },
    { schema: Kin.KinTriggerSettings, value: { ...settings, timeZone } },
    { schema: Kin.KinOwnerTimeZone, value: { orgId: "org-1", timeZone } },
  ]),
  { schema: Kin.KinTriggerFired, value: { ...fire, fireId: "" } },
  { schema: Kin.KinTrigger, value: { ...trigger, lastFireId: "" } },
  { schema: Kin.KinWebhookSource, value: { ...source, id: "" } },
  {
    schema: Kin.KinTriggerFired,
    value: {
      ...fire,
      payload: {
        kind: "github",
        sourceId: "",
        scheduledTaskId: "scheduled-task-1",
        deliveryId: "delivery-1",
      },
    },
  },
  ...subjects
    .filter((subject) => "itemId" in subject)
    .map((subject) => ({
      schema: Kin.KinTriggerSubject,
      value: { ...subject, itemId: "" },
    })),
  { schema: Kin.KinRoutine, value: "weekly_check" },
  { schema: Kin.KinWatchdog, value: "unknown" },
  { schema: Kin.KinWebhookSource, value: { ...source, status: "unknown" } },
  { schema: Kin.KinGithubEvent, value: { ...githubEvent, deliveryId: "" } },
  { schema: Kin.KinTriggerSchedule, value: { type: "once" } },
  { schema: Kin.KinTriggerSchedule, value: { type: "webhook" } },
  ...[-1, 0.5].map((lateByMs) => ({ schema: Kin.KinTriggerFired, value: { ...fire, lateByMs } })),
  {
    schema: Kin.KinTriggerFired,
    value: { ...fire, payload: { kind: "github", sourceId: "source-1" } },
  },
  {
    schema: Kin.KinTriggerSubject,
    value: { type: "followup", itemId: "commitment-1", person: " " },
  },
  ...[-1, 7, 1.5].flatMap((weekday) => [
    { schema: Kin.KinTriggerSettings, value: { ...settings, fullRebuildWeekday: weekday } },
    { schema: Kin.KinTriggerSettings, value: { ...settings, ownerCheckWeekday: weekday } },
  ]),
  {
    schema: Kin.KinTriggerSettings,
    value: { ...settings, quietHours: { from: "21:00", to: "24:00" } },
  },
  ...[
    { schema: Kin.KinTrigger, value: trigger },
    { schema: Kin.KinTriggerFired, value: fire },
    { schema: Kin.KinWebhookSource, value: source },
    { schema: Kin.KinGithubEvent, value: githubEvent },
    { schema: Kin.KinTriggerSettings, value: settings },
  ].map(({ schema, value: { orgId: _orgId, ...value } }) => ({ schema, value })),
];

describe("Kin trigger contracts", () => {
  it.each(Object.entries(samples))("round-trips %s", (_name, [schema, values]) => {
    const decode = Schema.decodeUnknownSync(schema);
    const encode = Schema.encodeUnknownSync(schema);
    for (const wire of values) {
      const decoded = decode(wire);
      expect(encode(decoded)).toEqual(wire);
      expect(decode(encode(decoded))).toEqual(decoded);
    }
  });

  it.each(rejections)("rejects invalid trigger data %#", ({ schema, value }) => {
    expect(() => Schema.decodeUnknownSync(schema)(value)).toThrow();
  });

  it.each(secretRejections)("never echoes a rejected webhook secret %#", (secret) => {
    const decode = Schema.decodeUnknownSync(Kin.KinGithubWebhookSecretInput);
    expect(() => decode({ orgId: "org-1", secret })).toThrow(
      "A webhook secret needs at least 16 characters and no whitespace.",
    );
    expect(() => decode({ orgId: "org-1", secret })).not.toThrow(secret.trim());
  });
});
