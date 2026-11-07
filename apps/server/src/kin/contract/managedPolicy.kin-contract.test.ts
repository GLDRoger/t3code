import { assert, it } from "@effect/vitest";
import { ManagedPolicyDocument } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { webhookInput, withScheduledTasks } from "./fixtures.ts";

const decodePolicy = Schema.decodeEffect(ManagedPolicyDocument);

it.effect("decodes locked settings and marks existing webhook tasks blocked by policy", () =>
  Effect.gen(function* () {
    const policy = yield* decodePolicy({
      schemaVersion: 1,
      organization: "Kin",
      settings: { "storageCleanup.logsAfterDays": { value: 14, locked: true } },
      limits: { webhookTasks: false },
    });
    assert.deepEqual(policy.settings?.["storageCleanup.logsAfterDays"], {
      value: 14,
      locked: true,
    });
    assert.equal(policy.limits?.webhookTasks, false);
    const task = yield* withScheduledTasks(({ service }) =>
      webhookInput().pipe(
        Effect.flatMap(service.upsert),
        Effect.map(({ task }) => task),
      ),
    );
    yield* withScheduledTasks(
      ({ service, launches }) =>
        Effect.gen(function* () {
          const listed = (yield* service.list()).tasks.find(({ id }) => id === task.id);
          assert.isString(listed?.blockedByPolicy);
          assert.isNotEmpty(listed?.blockedByPolicy);
          const response = yield* service.triggerWebhook({
            hookId: task.id,
            token: task.webhook?.path.split("/").at(-1) ?? "",
            method: "POST",
            path: `/api/hooks/${task.id}`,
            query: "",
            headers: {},
            body: new TextEncoder().encode("{}"),
            bodyText: "{}",
          });
          assert.equal(response._tag, "blocked_by_policy");
          assert.equal(yield* Queue.size(launches), 0);
        }),
      policy,
    );
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);
