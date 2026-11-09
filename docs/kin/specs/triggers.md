# Kin spec: triggers

Status: draft, 7 Nov 2026. Covers DESIGN.md section 4 (staying fresh, dreaming), section 6, section 12 gaps 5 and 7, and "Where Kin runs".

## Goal

Make leads act on their own, on time, without a person asking:

- GitHub events wake the right lead within seconds, once per delivery, even after a short outage.
- Deferrals fire at their due time, recheck first, give a 30-minute heads-up, then start, ask, remind or chase.
- Routines run in the owner's timezone: morning brief, evening summary, nightly dreaming at 03:00, a weekly full rebuild and a weekly owner check.
- Watchdogs compare memory with GitHub and catch what events missed.
- Nightly dreaming lands as pull requests on the memory repo. Housekeeping merges by itself; anything that matters waits for the owner.
- No secret reaches the memory repo, and the owner can purge one item from history with a signed action.
- A small contract test per T3 piece Kin depends on fails loudly when upstream changes it.
- All of this runs on the always-on Kin host. A trigger missed while it was off runs on wake-up and says when it was due.

## What exists in T3

Verified on branch `kin` (upstream `main`, 7 Nov 2026).

**Scheduled tasks.** `packages/contracts/src/scheduledTask.ts` defines `ScheduledTaskSchedule` with four types: `interval` (`everyMs`, min 60 000), `fixed_time` (`timeOfDay` "HH:MM", optional `weekdays` 0–6), `once` (`runAt`, ISO with offset) and `webhook` (`signature`, `maxDeliveryAgeMinutes`, `dedupe`, `filters`). `ScheduledTaskService` (`apps/server/src/scheduledTasks/ScheduledTaskService.ts`) has `upsert`, `setEnabled`, `delete`, `runNow`, `rotateWebhookToken`, `listWebhookDeliveries`, `getWebhookDelivery`, `triggerWebhook`.

- **A run always goes to an agent thread.** `runTask` calls `ThreadLaunchService.launch` with `initialMessage.scheduledTaskId` for unbound tasks, or `ThreadManagementService.sendToThread` for bound ones. There is no callback for server code. The command id is `scheduled-task:<taskId>:<startedAtMs>:scheduled` for time runs and `scheduled-task:<taskId>:webhook:<deliveryId>` for webhooks.
- **Time math.** `nextScheduledRunAt(schedule, from)` in `scheduledTasks/Schedule.ts` is a pure function. `fixed_time` sets wall-clock parts on `from`, so its zone decides the time. The service passes `localNow = DateTime.withCurrentZoneLocal(...)`: the server machine's zone.
- **Missed runs.** `runDueTasks` picks rows with `next_run_at <= now`. A `fixed_time` run more than 10 minutes late is skipped and rescheduled (`isMissedFixedTimeRun`, `MISSED_FIXED_TIME_GRACE_MS`). A late `once` runs. An `interval` runs once, then counts from completion. `requireFutureOnce` rejects saving an enabled `once` in the past. After a crash mid-run, startup recovery marks the row failed and a `once` gets no next run (`nextRunAfterRun`).
- **Ticks.** `Scheduler` (`apps/server/src/scheduling/Scheduler.ts`) runs every registered source every 5 s, one at a time per source, after startup recovery (`forkParked`). `UsageLimitRecoveryWorker` registers with it the same way Kin will.

**Webhooks.**

- Route `/api/hooks/:hookId/:token` (`packages/contracts/src/environmentHttp.ts`, `scheduledTasks/webhookRoute.ts`). Body cap 1 MiB.
- Signature: `verifyWebhookSignature` (`scheduledTasks/webhookVerification.ts`) does HMAC-SHA256 over raw bytes. GitHub's settings are `x-hub-signature-256`, hex, prefix `sha256=` (`apps/web/src/components/settings/scheduledTasksSettings.logic.ts`, `docs/user/project-settings.md`).
- Dedupe (`webhookDedupe.ts`): `replayKey` is ignored for 7 days per task; `coalesceKey` merges a burst into one run with the **latest** payload only. For `github` events, `KinEvent.dedupeKey` is `KinGithubEvent.deliveryId` (GitHub's `x-github-delivery`), so a redelivery after T3's 7-day replay window still collapses in the lead's queue.
- Filters (`webhookFilter.ts`): `equals`, `notEquals`, `startsWith`, `in`, `exists` on `headers.*`, `body.*`, `query.*`; at most 16; all must match.
- Limits: 60 accepted per task per minute, 20 queued per task. The delivery log keeps 50 per task, with bodies cut at 64 KB (`WEBHOOK_DELIVERY_LOG_BODY_LIMIT`) and credential headers redacted (`redactHeaders`).
- Prompt values are framed in `<webhook-data-…>` tags with mentions broken (`webhookTemplate.ts`). Code must not parse the prompt.
- Managed policy `webhookTasks: false` blocks webhook tasks (`packages/contracts/src/managedPolicy.ts`, `blockedByPolicy`).

**Relay (T3 Connect).**

- A public hook URL exists only with a managed tunnel (`relayHookBaseUrl`; the MCP tool says "No `webhookUrl`: T3 Connect remote access is off").
- The relay forwards `/v1/hooks/…` to the environment's `/api/hooks/…` (`infra/relay/src/hooks/HookForwarder.ts`, `upstream.ts`). Relay limits: 60 per hook per minute, 600 per endpoint.
- Holding while offline is opt-in: **Hold webhooks while offline** in Settings → Sharing & access (`holdWebhooksWhileOffline`, default false in `apps/server/src/cloud/CloudLink.ts`). Held requests live up to 24 h (`HOOK_INBOX_TTL_MS`), at most 1 000 requests or 50 MB per environment and 100 per hook (`HookInboxStore.ts`).
- On reconnect, `HeldHooksWaker` asks the relay to deliver. Each held delivery carries a signed proof (`RelayDeliveryProof`, max age 25 h). The environment then uses the relay's `receivedAt` for `maxDeliveryAgeMinutes`, and `delivery:relay:<id>` as the delivery id.

**MCP tools.** `schedule_task`, `list_scheduled_tasks`, `delete_scheduled_task` (`apps/server/src/mcp/toolkits/orchestrator/tools.ts`) go through `OrchestratorMcpService.scheduleTask`, which:

- loads the calling thread (`loadCaller(scope)`);
- inherits its model and mode limits;
- stamps `createdBy: "agent"`, `creationSource: "mcp"`;
- calls `ScheduledTaskService.upsert`.

Webhook secrets come in either as `secret` or as a `secretRef` from `request_secret`.

**Running a host.** `docs/user/background-service.md`: `t3 up`, `t3 service install`; on macOS the service runs only while the user is logged in; "Keep the Mac logged in and awake". `docs/user/install.md`: a source build runs as `node apps/server/dist/bin.mjs`, and "`t3 update` and the background service do not apply to a server run this way". `docs/user/remote-access.md` and `docs/internals/remote.md` cover T3 Connect, LAN/Tailscale pairing (`t3 pair`), routes, and peer links (`apps/server/src/peer/PeerLinks.ts`, behind the Linked environments beta). State lives at `~/.t3/userdata/statev2.sqlite`, secrets at `~/.t3/userdata/secrets/*.bin` (`apps/server/src/config.ts`, `auth/ServerSecretStore.ts`). The production relay URL comes from `.env` (`.env.example`: `T3CODE_RELAY_URL=https://relay.t3.codes`).

## Design

### MCP tools or services: services

Kin calls `ScheduledTaskService` and `Scheduler` directly from `apps/server/src/kin/`, never the MCP tools. Reasons:

1. **No calling thread.** The MCP path needs a caller thread scope and copies that thread's model and modes. Kin's trigger code is server code with no thread.
2. **Secrets stay in-process.** `upsert` takes the webhook `secret` in-process. Over MCP the secret passes through a model, or needs a `request_secret` card for each repo.
3. **Authority never passes through a model** (section 9). If a lead could call `schedule_task`, it could create scheduled agent runs with any prompt, outside its provenance ceiling. Lead and worker sessions get Kin's own `kin_defer` tool (LEAD), which calls `KinTriggerService`. They must not get T3's scheduling tools (see Security).
4. **Idempotency.** Kin passes its own stable `commandId`.

### Two receive paths, one inbox

Every trigger, whatever its source, ends up as one row in the **new** durable table `kin_trigger_inbox`. LEAD's per-org queue consumes it.

```
GitHub ──relay──▶ /api/hooks (T3) ─▶ ScheduledTaskService ─▶ ThreadLaunchService.launch
                                                               │ KinTriggerSink wrapper:
                                                               │ Kin task? write inbox row, no agent
                                                               ▼
KinTriggerScheduler (Scheduler tick, kin_triggers) ────────▶ kin_trigger_inbox ─▶ LEAD queue
```

- **Webhooks use T3's scheduled tasks**, because the relay only forwards to `/api/hooks/:hookId/:token`, and signature, replay, filters, the offline hold and the delivery log all live there. Kin owns one unbound T3 webhook task per org, fed by the GitHub App's own webhook.
- **Time triggers use Kin's own table** on T3's `Scheduler`, reusing `nextScheduledRunAt`. T3's runs always start an agent, `fixed_time` uses the server's zone, late `fixed_time` runs are dropped, and a crash can lose a `once`. Kin needs the owner's zone per org, a late policy per kind, multi-step deferrals, `orgId`, and priority for the budget. Those trigger rows are derived from memory (deferrals) and org settings (routines), so they can be rebuilt.
- **Why a durable inbox.** The sink sits inside `ScheduledTaskService`'s dependencies, so it depends only on `SqlClient`, `ThreadManagementService`, and Kin's SQL-backed inbox/store. Its layer runs Kin migrations before looking up sources. Otherwise the Kin layer, which itself needs `ScheduledTaskService`, would form a cycle. The inbox row also survives a crash between receipt and processing.

### Data shapes (new, `packages/contracts/src/kinTriggers.ts`)

The schemas reuse `KinOrgId` and `KinPersonId` from `kinChat.ts` and T3's existing task, delivery and thread IDs. Follow-up `person` is a Kin person ID, not a handle. Every top-level record carries `orgId`; nested schedules, subjects and payloads inherit their envelope's org. These contracts are independent of LEAD's `KinEvent`.

Schedules reuse the same shapes as T3's upsert schedules, minus webhook; `fixed_time` is read in `timeZone`, not the server's zone. Schedule unions keep T3's `type` discriminator, and fire payloads keep `kind`. Intervals are at least 60 000 ms, weekdays are integers 0–6, and lateness is non-negative. `TimeOfDay` follows T3's local-time pattern (H:MM or HH:MM). Server-generated record timestamps use LEAD's canonical UTC schema (`YYYY-MM-DDTHH:mm:ss.sssZ`); `once.runAt` uses T3's stricter ISO date-time with an explicit offset. Timezone fields validate IANA zones, including `UTC`.

The exported schemas and types are defined in [`kinTriggers.ts`](../../../packages/contracts/src/kinTriggers.ts).

Each fire has a stable `fireId`: `${triggerId}:${dueAtMs}` for time triggers or `gh:${orgId}:${deliveryId}` for webhooks. `lateByMs` is zero on time; more than 10 minutes late shows "This was due at 9:00". Repository strings are `owner/name`. `KinGithubEvent.deliveryId` is GitHub's `x-github-delivery`, not T3's branded delivery-log ID; the consumer constructs this event for LEAD.

Defaults: brief 08:30 daily, summary 18:30 Mon–Fri, dream 03:00 daily, full rebuild on Sunday (it replaces that night's dream), owner check Monday 09:00, quiet hours 21:00–08:00. Morning brief and dream days are fixed to daily, and evening summary days are fixed to Mon–Fri; their settings change only the time.

**Tables (new, Kin migrations):** `kin_triggers` (primary key `(org_id, trigger_id)`), `kin_trigger_fires` (primary key `(org_id, fire_id)`, 30-day retention), `kin_trigger_inbox` (primary key `(org_id, fire_id)`), `kin_webhook_sources`, `kin_trigger_settings`, `kin_deferral_runs`, `kin_ping_ledger`, `kin_dream_runs`, `kin_prepared_briefs`. Every row has `org_id NOT NULL`. TRIG-2 creates the trigger, fire, inbox, source, settings and ping tables; the deferral and dream tasks own their remaining tables.

- `kin_triggers` stores the `KinTrigger` fields, with `subject_json` and `schedule_json`. Trigger and fire IDs are unique within an org; fire and event deduplication are org-scoped. CRUD is org-scoped; due scans span orgs. `next_run_at`, `created_at` and `updated_at` are integer epoch milliseconds. Indexed due scans use keyset paging on `(next_run_at, org_id, trigger_id)`; a concurrent fire cannot shift an OFFSET page. Time trigger IDs may not start with `gh:`, which is reserved for webhook fires.
- `kin_trigger_fires` stores `fire_id`, `org_id` and indexed integer `fired_at`. Retention deletes only rows strictly older than `now - 30 days`, not inbox work. Pending inbox rows continue to reject replays after fire retention; consumed inbox rows are separately removed after 7 days, so the inbox does not generally outlive the fire ledger.
- `kin_trigger_inbox` stores the full `KinTriggerFired` envelope in `payload_json`, integer `received_at` and nullable integer `consumed_at`. Both receive paths insert with `ON CONFLICT (org_id, fire_id) DO NOTHING RETURNING fire_id`; other constraint failures raise. `listPending(orgId, limit)` reads unconsumed rows in `received_at, fire_id` order using an org-scoped pending index. The lead consumer reads pending rows, performs read-only or idempotent I/O (which can run again on replay), then in one transaction inserts into `kin_events` with `ON CONFLICT DO NOTHING` on `(org_id, dedupe_key)` and calls `markConsumed(orgId, fireIds)`. A crash replays pending work; durable event dedupe absorbs it. There are no claims or recovery loop. Reconciliation deletes consumed rows strictly older than 7 days using the `consumed_at` index.
- `kin_webhook_sources` stores the `KinWebhookSource` fields, keyed by `(org_id, source_id)`, unique by `(org_id, repo)` and by `scheduled_task_id` for the sink lookup. The App source's `repo` is the marker `github-app` (`KIN_GITHUB_APP_SOURCE`), which can't collide with an `owner/name` slug; its id is also `github-app` and its `githubHookId` is null. Task and thread IDs have no upstream foreign keys. `kin_trigger_settings` stores one `KinTriggerSettings` per org, including `quiet_hours_json`.
- `kin_ping_ledger` has the unique key `(org_id, person, item_id, day)`, where `day` is the owner's local calendar date, plus integer `pinged_at` and nullable integer `escalated_at`. TRIG-11 owns sending, batching and escalation.

### Time triggers: `KinTriggerScheduler`

- Registers with `scheduler.register("kin-triggers", runDue)`, reusing T3's scoped, non-overlapping 5-second tick and startup activation. Each tick reads `Clock` once and visits all rows where `enabled AND next_run_at <= now`, in batches of 100 ordered by `(next_run_at, org_id, trigger_id)`. A failed fire is logged without blocking other rows or later batches.
- **Firing.** The scheduler passes a next-run function to `KinTriggerStore.fire`, which rejects a time fire unless its `fireId` is `${triggerId}:${dueAtMs}`. In one transaction the store inserts into `kin_trigger_fires` and `kin_trigger_inbox` with `ON CONFLICT (org_id, fire_id) DO NOTHING RETURNING fire_id` and advances `next_run_at` (always clears it for `once`). An existing inbox row must be a time fire for the same trigger; a different identity fails with `identity_conflict`, never a false duplicate. `updated_at` never moves backwards on fire. A duplicate still runs the guarded schedule update, so an already-fired due row cannot stay armed. The store reads the trigger in the same write transaction and computes its next run from that row, so settings recompute cannot commit between the read and update. The update requires the same org, an enabled trigger and the original `dueAt` still in `next_run_at` (compared as integer milliseconds); a new stale, missing or disarmed fire rolls back both inserts. A crash before commit simply refires. The single scheduler scans due rows across orgs with a limit, logging and skipping undecodable rows. Store numeric inputs are non-negative safe integers.
- **Next run.** Reuse `nextScheduledRunAt` with `DateTime.makeZonedUnsafe(now, { timeZone: trigger.timeZone })`, where the stored zone is the validated org owner-zone snapshot. Compute strictly after the tick's **now**, not the old due slot: fixed times stay at the owner's wall-clock time across DST; intervals add elapsed milliseconds; neither replays missed slots. `once` rows get `next_run_at = null` after firing. Startup recovery has nothing to fix, because there is no "running" state.
- **Settings changes.** The settings write path calls `KinTriggerScheduler.recompute(settings)` with the validated new settings. In one transaction it refreshes that org's trigger zone snapshots, routine schedules and next times from `Clock` now. Routine weekdays follow the defaults above; `dream_full` uses the configured full-rebuild day and dream time. Disabled triggers stay disarmed, consumed `once` triggers stay cleared, and armed `once` triggers keep their absolute due instant (including past-due times). Armed overdue slots keep their stored due instant and fire late on the next tick, then advance using the new settings. Intervals keep their existing next run. Unchanged rows are not written. The caller owns persisting the settings and creating any missing routine rows; this method only recomputes existing rows.
- Catch-up fires share `received_at`, so consumers must not rely on inbox order between a deferral's `heads_up` and `due`; skipping heads-up when due has also passed is the consumer's job.
- **Lateness.** `lateByMs = now − dueAt`. The scheduler never drops a fire, even more than 10 minutes late. It emits exactly one envelope for the stored overdue slot and advances recurring triggers beyond now, with no backfill. Each kind's late policy is applied when the fire is handled:

| Kind                | Late policy (decided by the consumer, using `lateByMs` and owner time)                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Deferral `heads_up` | If `due` has also passed, skip the heads-up and handle `due` as late.                                                               |
| Deferral `due`      | Within the 30-minute grace, run the due flow with "This was due at 9:00"; the grace starts from now. Older fires ask, never start.  |
| Reminder, follow-up | Deliver with "This was due at …". Pings respect quiet hours.                                                                        |
| Morning brief       | Post if before the evening summary time; otherwise fold into the evening summary.                                                   |
| Evening summary     | Post if before the next dream; otherwise fold into the next morning brief.                                                          |
| Dream, full rebuild | Run if before 08:00 owner time; otherwise skip, because the next dream reads everything since the last good dream. Nothing is lost. |
| Owner check         | Run on wake-up at any time, lowest priority.                                                                                        |
| Watchdog            | Run once now; no backfill.                                                                                                          |

**Wake-up after the machine was off.** The first tick after startup sees every overdue row at once. It fires all of them in `next_run_at` order. The consumer then groups same-org fires into one wake-up (LEAD's merge window) with one line: "I was offline from 02:10 to 07:40. Catching up: 1 deferral, morning brief." `trigger_reconcile` also runs at startup (below).

### GitHub webhooks

**One App webhook, not per-repo hooks.** The GitHub App's own webhook covers every repo it is installed on, so Kin needs no `admin:repo_hook` token. An App has one hook config, so there is **one App webhook source per host**: setup refuses with `conflict` while another org holds it, checked again inside `registerSource`'s transaction. Routing one App to several orgs by `installation.id` is a later option. The App covers every repo it is installed on, so TRIG-6 must drop events for repos outside the org's allowlist before anything reaches a prompt. Trade-off: one T3 task's limits (60 accepted per minute, 20 queued) are shared by all of those repos. That is enough for one team; `github_recheck` covers anything the limit drops.

**Setup** (`KinGithubWebhooks.setup`, owner-only RPC `kin.webhooks.github.setup({ orgId, projectId })`, in `githubWebhooks.ts`):

1. Check the caller is the org's owner (the `KinBudget.set` rule). `kin_orgs` has no project, so the owner passes `projectId`; it must exist and have a default model, which the task and inbox thread use. A second setup naming another project fails. Choosing a quiet project does not fence the task: any live agent can edit or delete it through the orchestrator MCP tools, including agents in other projects (`assertLiveCallerForOtherProject` lets a running caller through). The sink's shape check and secret binding (below) are what keep those edits from authoring deliveries.
2. Generate a 32-byte secret with `SecureRandom`. `botLogin` comes from `KIN_GITHUB_BOT_LOGIN`, the same key APPR-8's `KinGitHubScope` reads; it must end in `[bot]`, or setup fails with a config error.
3. Call `ScheduledTaskService.upsert` **disabled**, with `commandId: kin:webhook:${orgId}:github-app`:

```ts
{ title: `Kin · GitHub App · ${orgId}`, prompt: KIN_SINK_PROMPT, enabled: false, projectId,
  threadId: null, threadMode: "new_thread", workspaceStrategy: { type: "root" },
  modelSelection: <project default>, runtimeMode: "approval-required", interactionMode: "plan",
  createdBy: "system", creationSource: "server",
  schedule: { type: "webhook",
    signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=", secret },
    maxDeliveryAgeMinutes: null,            // run held requests too; the consumer re-reads state
    dedupe: { replayKey: "{{headers.x-github-delivery}}" },   // no coalesceKey, see below
    filters: [
      { path: "headers.x-github-event", op: "in", value: [ "pull_request", "pull_request_review",
        "pull_request_review_comment", "issue_comment", "issues", "check_suite", "workflow_run",
        "push" ] },
      { path: "body.sender.login", op: "notEquals", value: botLogin },  // no loops
    ] } }
```

4. If `task.webhook.url` is null, T3 Connect is off: delete the task, post "GitHub events need T3 Connect on the Kin host" to the owner chat as a system notice, return `needs_connect` and stop.
5. Create the org's inbox thread once: `ThreadLaunchService.launch` without a message (its `commandId` includes org and project, so launch receipts return the same thread on every setup), then archive it. It is never registered in `kin_agent_threads`; `registerSource` and `registerAgentThread` each reject the overlap inside their own write transaction.
6. `registerSource`, bind the secret's hash, and only then enable the task, so no delivery can reach a real launch with `KIN_SINK_PROMPT`. If registering or binding fails, setup deletes the disabled task.
7. Point the App at the URL with the executor action `github.app_hook.configure` (`PATCH /app/hook/config` with `url`, `secret`, `content_type: json`). It needs the App's private key, so it is **gated until APPR-9** (`appHookConfigureReady = false`; while off it refuses with `GithubAppHookRefused { reason: "gated" }`). The secret travels in-process as `Redacted`, never through a model, a chat message or a log. The call times out after 30 s (`reason: "timeout"`), because it runs under the host-wide lock. Success returns `configured`.
8. **Fallback while gated:** return `needs_secret` with the URL to the owner-only surface. The owner sets that URL and a new secret in the GitHub App's webhook settings, then sends the secret with `kin.webhooks.github.setSecret`, which re-saves the task in the shape above with that secret and binds its hash. The secret arrives on the owner's authenticated session (`AuthSettingsWriteScope`, owner check) and stays in-process; a `request_secret` card would hand an agent a ref instead. Until then deliveries fail closed with `rejected_signature`.

Setup, setSecret, rotate and remove take one host-wide lock (`KinGithubWebhookLock`, in Kin's services), so the cross-org check and each source change run one at a time. A repeated setup returns the same source. Before offering GitHub a secret, it re-saves the task in Kin's shape without a secret, so T3 keeps the stored one and the bound hash stays valid; this repairs a task someone edited, or one saved with an older event list, even while gated. A task saved unsigned has no secret to keep, so only a re-key or `setSecret` repairs it. With the gate on setup then re-keys: GitHub takes a fresh secret first, then T3, then the hash binding.

`KIN_SINK_PROMPT` = "Kin trigger. If you are reading this, Kin's trigger sink is not installed. Do nothing and stop." Plan mode plus approval-required keeps an accidental run harmless.

**Why no coalescing.** T3 coalescing keeps only the latest payload, so two PRs in one window would lose one. LEAD's per-org merge window does the batching without dropping events.

**Rotate** (`kin.webhooks.github.rotate`): `rotateWebhookToken`, then `github.app_hook.configure` with the new URL only. While gated it returns `needs_url` and the owner updates the URL in the App settings. The old URL stops working at once, so deliveries fail until GitHub has the new one.

**Remove** (`kin.webhooks.github.remove`): disable the task, `unregisterSource`, then delete the task. The archived inbox thread stays for a later setup. `unregisterSource` refuses (`task_active`) while the task is enabled or a delivery is in flight (`last_run_status = 'running'`, or a `dispatching`/`running` pending row), so a delivery can't lose its source mid-dispatch. A delivery that read the task just before remove has no source by the time it launches; the sink refuses any task whose id starts with `scheduled-task:kin:webhook:` (upstream names a commandId-created task `scheduled-task:${commandId}`), so it fails with `dispatch_failed` instead of launching. With no source row, remove still deletes that deterministic task if it exists.

**Receiving: `KinTriggerSink`.** It wraps the `ThreadLaunchService` and `ThreadManagementService` given only to `ScheduledTaskService`:

```ts
receive: (input) => {
  const taskId = input.initialMessage?.scheduledTaskId;
  if (taskId === undefined) return undefined;                 // caller falls through to inner.launch
  const source = store.sourceByTaskId(taskId);                // SQL, kin_webhook_sources
  if (source === undefined) {
    if (taskId starts with "scheduled-task:kin:webhook:") fail(KinTriggerSinkRefused);  // racing remove
    return undefined;                                         // not Kin's: unchanged
  }
  // From here every failure is a ThreadLaunchError("dispatch-message"): no real launch.
  require(input.commandId starts with `scheduled-task:${taskId}:webhook:`);  // status is advisory, below
  const deliveryId = input.commandId.slice(prefix.length);
  const delivery = findLaunchDelivery(sql, { taskId, deliveryId, projectId: input.projectId,
    botLogin: source.botLogin });
  require(delivery);  // unbound new_thread webhook task in this project, signed, with Kin's replay
                      // dedupe object, event list and bot-sender filter: any live agent can re-save it
  require(sha256(delivery.secret) equals source.secret_sha256);   // timingSafeEqual; NULL refuses
  require(delivery.receivedAt > source.secret_bound_at);          // verified under this secret
  const projection = threads.getThreadProjection(source.inboxThreadId);
  require(projection.thread.projectId === input.projectId && projection.thread.deletedAt === null);
  inbox.put({ fireId: `gh:${source.orgId}:${deliveryId}`, dueAt: delivery.receivedAt, firedAt: now,
    payload: { kind: "github", sourceId: source.id, scheduledTaskId: taskId, deliveryId } }, now);
  return { threadId: source.inboxThreadId, projection, resumed: false };
}
```

A registered Kin task never falls through to a real launch. The wrapper is local to scheduled tasks and is given the existing thread-management layer explicitly; other callers retain the original launch and thread-management services. Bound Kin sends, including a `scheduled-task:kin:webhook:` task with no source, and failed source lookups are rejected before dispatch; ordinary sends pass through. If parsing, source validation or inbox persistence fails, the launch fails, and T3 logs `dispatch_failed` in Deliveries.

**Secret binding.** Every Kin save that sets a secret (create, the re-key with the gate on, `setSecret`) is followed under the lock by `bindSecret`, which stores the secret's SHA-256 in `kin_webhook_sources.secret_sha256` and the bind time from `Clock` in `secret_bound_at` (migration K019). The sink hashes the task's current `webhook_secret` and compares the two with `timingSafeEqual`, and it requires the delivery's `received_at` to be later than `secret_bound_at`. T3 verifies a signature when the request arrives, but the sink reads the secret at launch, and a queued delivery can launch after a re-key; the time check ties each delivery to the secret it was verified against. `received_at` is the server clock, or the relay's receive time only with its signed proof (`RelayDeliveryProof`), capped at now, so a caller can backdate it only with the relay's signature. A NULL hash (a source made before K019), a mismatch (an agent swapped the secret, or a re-key is between its save and its bind, when the old hash is still bound) or an early delivery refuses the same way a weakened task does: each fails closed. The way out is `kin.webhooks.github.setSecret`, which re-saves and re-binds. A legitimate delivery the relay held while the host was offline and received before a re-key also refuses; `github_recheck` picks up what it carried. So an agent that re-saves the task with a secret it chose can get forged deliveries accepted upstream, but none reaches the inbox, even if the owner re-keys while one is queued. Neither value is logged, traced or put in an error. The sink also requires Kin's exact dedupe object (`{"replayKey":"{{headers.x-github-delivery}}"}`, no coalesce key or window) and event list, so an edit can't switch off dedupe to replay a delivery or hold one in a coalesce window.

What stays open: an agent can still delete, disable or re-key the task. That stops deliveries (denial of service) but cannot author an inbox row. `trigger_reconcile` (TRIG-10) reports a missing, disabled or policy-blocked task, or a hash mismatch, to the owner. Fencing the MCP tools off Kin's task is still an open question.

`KinTriggerStore.registerSource` requires an existing org and an unbound `new_thread` webhook task. It reads the inbox projection before opening its transaction, then checks that the thread is not deleted and its project matches the task's. Identical registration returns the stored source; conflicting identity fails. Sources have no upstream org column: the `kin_webhook_sources` row establishes ownership; registration rejects task or inbox IDs already owned by another org.

The sink verifies the delivery-log row belongs to the scheduled task. `dueAt` is the log's `received_at`, `firedAt` comes from `Clock`, and `lateByMs` is their nonnegative difference. `KinTriggerFired` carries only T3's delivery-log id, not GitHub's delivery header; TRIG-6 reads `x-github-delivery` through `getWebhookDelivery` as described below. No contract change or payload parsing is needed here.

**Consuming (Kin layer, outside the cycle)** ([`githubEvents.ts`](../../../apps/server/src/kin/triggers/githubEvents.ts), on the shared 5-second tick for every org with a pending `github` inbox row, so rows left behind by a removed source still drain). Like routines, it does the read-only I/O first, then one transaction re-checks that the source still owns the task, enqueues, and marks the fire consumed:

1. For each pending `github` inbox row, check the delivery-log row belongs to the task, then call `ScheduledTaskService.getWebhookDelivery({ id, deliveryId, acceptAnyOutcome: true })`.
2. Build a `KinGithubEvent` from `headers["x-github-event"]`, `x-github-delivery` and the parsed body (`repository.full_name`, `action`, the PR or issue `number`, the head SHA, `sender.login`). `heldByRelay` is true when the delivery id starts with `delivery:relay:`. The event name must match `^[a-z_]{1,64}$` and the body must carry that event's object (`pull_request` for the three PR events, `issue` for `issues` and `issue_comment`, `check_suite`, `workflow_run`, `after` for `push`); `number` and the head SHA come from that object only. Org-level events (`ping`, `installation`, `installation_repositories`, `github_app_authorization`, `meta`) are dropped.
3. Keep only repos in `KIN_GITHUB_REPOS` (comma-separated `owner/name`, entries trimmed, compared case-insensitively; the same setting APPR-8's `KinGitHubScope` reads). The App webhook covers every installed repo, and an unset, empty or invalid list drops every event, with one warning at startup. Dropped fires are consumed.
4. The event is a hint. The lead re-reads the PR, issue or run from GitHub before acting, because a held request can be 24 h old, a body over 64 KB is truncated, and the log keeps only 50 deliveries. If the delivery is gone, the body (truncated or not) can't be parsed or doesn't match its event header, or it names no repo, the consumer puts a `github_recheck` request in the inbox instead: `KinTriggerFired` with payload `{ kind: "github_recheck", repo, reason: "delivery_missing" | "body_unparseable" | "repo_unknown" | "stale", sourceFireId }` and fire id `gh:<org>:recheck:<T3 delivery id>`, one per fire. `repo: null` means every scoped repo; it is always null today, since none of these cases names a repo. TRIG-10's `github_recheck` watchdog consumes these rows (`listPending(orgId, limit, undefined, ["github_recheck"])`) and marks them consumed.
5. Enqueue a `github` `KinEvent` with `dedupeKey` = `x-github-delivery`, `provenance: { _tag: "system" }` and a code-built one-line `summary` of at most 300 characters that ends in `(hint; verify on GitHub)`. System provenance is how LEAD marks outside text: memory written from it gets `trust: external`, and the prompt quotes all event data, never obeying it (section 9.4).
6. Failures: decode errors and `KinEventQueueConflict` consume the fire at once. Other errors back that fire off in memory, per org, from 1 minute doubling to 15, so it does not block newer fires while fewer than a page (100) are failing at once. A fire still failing more than 24 h past its `dueAt` becomes a `stale` `github_recheck` and is consumed. Memory is read once per drain, only when some fire is in scope; if that read fails, events still go through without condition matches, and TRIG-10's recheck matches them later. With no active lead, the event is dropped and the fire consumed.

**Conditions** ("when #212 merges"): no extra T3 task. A condition is a memory item with `on: { event: "pull_request", action: "closed", merged: true, number: 212 }`, plus an optional `repo: owner/name`; unknown keys fail the item's parse. The pure `matchConditions(facts, items)` returns open, valid, unsuperseded items whose `event`, `action` and `number` equal the facts, and whose `merged` and `repo`, when set, match too. A condition without `repo` matches the same number in any scoped repo. The consumer matches every in-scope event against the org's open memory items. Matches become a second, code-only `watchdog` event in the same transaction (`itemIds` = the matched items, `dedupeKey` = `github-condition:<x-github-delivery>`, a `finding` that starts "GitHub event suggests condition met (hint; verify on GitHub before acting)"), not a field on the `github` event: the `KinEvent` union already has a code-finding event, its text is server-written, and `github_recheck` will emit the same shape when it matches a condition against GitHub state.

**Missed while off.** The Kin host should be on, so outages are short:

- **Hold on (recommended):** GitHub's request reaches the relay, the relay holds it up to 24 h, and `HeldHooksWaker` delivers it on reconnect. Replay keys stop doubles.
- **Hold off, or longer than 24 h:** GitHub gets a 530 or 502 and does not retry by itself. `github_recheck` runs at startup and every 10 minutes, compares memory with GitHub state, and finds what changed. It needs the GitHub reader below; without the Kin App its requests wait in the inbox.

Webhooks are a fast path; the sweep is the guarantee.

### Deferrals on `once`

Arming comes from memory. When the front-matter cache (LEAD) sees a `deferrals/*.md` item with `status: open` and a `due`, `KinTriggerService.syncItem(item)` upserts its triggers and records a recheck snapshot. The snapshot holds linked issue/PR state, assignees, linked PRs, and the item's `recorded_at`/`superseded_by`. The triggers per `on_due` value:

| `on_due` | Triggers armed (owner time from `due`)   | At due                         |
| -------- | ---------------------------------------- | ------------------------------ |
| `start`  | `heads_up` at due − 30 min, `due` at due | recheck, then start work       |
| `remind` | `due` only                               | post reminder                  |
| `ask`    | `due` only                               | post a decision card           |
| `chase`  | `due` only                               | ping the promiser (ping rules) |

Item edits move or disarm the triggers: a new `due` re-arms; `status` other than `open` or a set `invalid_at` disables them. A due time already past at save fires at once, marked late; no "pick a future time" error. A missing `on_due` means `remind`, so silence never starts work.

The cache hook is `MemorySyncHooks` in [`Memory.ts`](../../../apps/server/src/kin/memory/Memory.ts): each new head goes once to `KinTriggerService.syncOrg`, which also disarms armed deferrals missing from the snapshot or sharing a duplicate id. A failing item is logged without blocking the others, and the head retries on the next two loads, then waits for the next head. `trigger_reconcile` (below) also re-syncs the whole org every 15 minutes and at startup, so a head that gave up is retried there. A due time whose fires would land before 1970 never arms; `kin_defer` accepts only years 2000–2099. A commit to the default branch moves the cache to the new head and reloads it, so a `kin_defer` item arms when its wake-up commits, not at the next wake-up; shadow (L0) commits never arm. Trigger ids are `deferral:<itemId>:heads_up|due`. Re-syncing an unchanged `due` writes nothing, so a fired `once` is never re-armed. The run row in `kin_deferral_runs` (migration K016) holds the snapshot and the flow state (below). The snapshot holds the item half (`recorded_at`, `superseded_by`, links) and the GitHub half (state, assignees and linked PRs of each `github.com/<owner>/<repo>/issues|pull/<n>` or `<owner>/<repo>#<n>` link), read at arm time through `KinDeferralGithubReader` in [`deferralGithub.ts`](../../../apps/server/src/kin/triggers/deferralGithub.ts). The GitHub half is `null` when any link couldn't be read. That reader is a narrow read-only seam: one batched call per repo for all of a sync's numbers. Because `syncOrg` runs under the org memory lock, every GitHub read in one sync shares a single 10 s budget, and all reads finish before any row is written. A link GitHub doesn't have, that fails, or that isn't read within the budget makes its item's GitHub half `null`, so the deferral asks. Both readers are backed by [`githubReaders.ts`](../../../apps/server/src/kin/triggers/githubReaders.ts) when the Kin App is configured, and otherwise keep their defaults (below).

**Confirm.** When the lead calls `kin_defer` (LEAD), Kin writes the item, arms the triggers, and the lead posts a `KinDeferralCard` widget (CHAT envelope): "Deferred to Fri 13 Nov, 9:00. I'll start then." [Change] [Just remind me]. [Just remind me] sets `on_due: remind`, and the triggers re-arm. [Change] writes nothing: it hands the item to the lead, which asks the owner what to change, marks the old item `cancelled` and calls `kin_defer` for the new one.

Code posts the card, never the model. It goes to the item's `chat` when that chat belongs to the item's org; deferrals without a chat arm without a card. Times use the owner's zone. A re-arm updates the card text in place, a disarm closes the card, and reopening the item reopens it. The card awaits nobody.

**Deferral card release gate (TRIG-7):** cards post live, but `KinChatService.act` refuses deferral-card taps (`deferralCardActionsReady = false`) until the owner-tap dispatcher from the owner-check gate exists. `Deferrals.act` already verifies the tap with the same `verifyOwnerTap` as the owner check. Before enabling taps:

- the owner-check gate's dispatcher steps must land (chat act enqueues `widget.action`; `WakeupRunner` intercepts card actions without showing them to the model);
- `WakeupRunner` must run `Deferrals.act` for `deferral` actions, then `MemoryWriter.commitWakeup` (the commit re-arms through the cache hook), then queue `finish`. [Change] goes to the lead as an owner message about the item. `act` accepts only the current card's actions: [Change] and [Just remind me] on the confirm card, [Start now], [Monday] and [Cancel] on heads-up and asked cards;
- production `MemoryWriterAuthority.resolve` must grant `kind: "deferral_card"` only after verifying the claimed owner tap: action `remind` lets `on_due` change, and only to `remind`; action `monday` carries the `due` that `act` returned and lets `due` change only to that value. [Cancel] sets `status: cancelled`, which any owner write may do;
- web and mobile must render the native card and its closed state.

**Flow for `start`** (`kin_deferral_runs.state`):

```
armed ──heads_up fire──▶ recheck ──changed──▶ asked   (decision card, no auto start)
                          │ unchanged
                          ▼
                      heads_up  card: "Starting Rate limiting at 9:00." [Start now] [Monday] [Cancel]
                          │ silence until due          [Start now] → started now
                          ▼                            [Monday] → due := next Mon 09:00, re-arm
                     due fire ─▶ recheck again          [Cancel] → item status cancelled
                          │ unchanged and not stopped and level ≥ L2
                          ▼
                       started ─▶ worker via delegate_task (LEAD) ─▶ closed with PR and proof
```

- **Consumer.** `KinDeferralFlow` in [`deferralFlow.ts`](../../../apps/server/src/kin/triggers/deferralFlow.ts) drains each org's pending deferral fires on its own `Scheduler` tick, in due order. Like routines, it does read-only or idempotent I/O first (memory read, GitHub reads, gate checks), then one transaction that rechecks the run row, writes the state and card, puts the chase's ping, enqueues, and marks the fire consumed. That transaction does no memory or GitHub I/O: the memory org lock is held while a new head syncs triggers, so a memory read while holding the SQLite writer can deadlock. The chase hands `KinPings.put` the item head it already read. Every run-state change is guarded on the state that was read. A failing fire retries after 1 minute, doubling to at most 15 minutes, held per process; its first failure logs a warning. One that fails to decode, or still fails 24 hours past due, is consumed after a best-effort server notice to the owner ("I couldn't handle the deferral …"). After the fires, even when listing them fails, the tick runs `KinPings.sweep` for the org: at once when a chase just put a ping, otherwise at most once a minute. A chase that lands in quiet hours delivers when they end. Code posts every card: the item's card is updated in place, or posted to the item's chat, else the owner's direct chat.
- **The recheck is code.** It reads the memory item and every GitHub link through `KinDeferralGithubReader`. Any difference from the snapshot means "changed": an issue closed, an assignee added or removed, another linked PR, or the item edited or superseded. A GitHub half that couldn't be read, at arm time or now, counts as "changed: couldn't verify". The ask names what changed.
- **Late.** If `due` has passed when the `heads_up` fire is consumed, it is skipped. A `due` fire more than 10 minutes late notes "This was due at 9:00". A `start` due fire within the 30-minute grace window, or one with no heads-up shown, posts the heads-up card again with a grace from now: the `due` trigger re-arms at the grace end (state `grace`, `graceEndsAt` on the card and in the run's snapshot), and silence still means go. An older fire asks instead of starting. `remind`, `ask` and `chase` act at due only and carry the same note.
- **Stale fires.** Fires wait in the inbox until the consumer handles them. It consumes, and otherwise ignores, a fire whose run row is missing or `disarmed`, whose `due_at` no longer equals the fire's due instant (a grace fire is the one exception, and only when its instant equals the recorded grace end), or whose run already left the state that fire expects.
- **Gates.** `start` becomes `ask` below L2, with the org's stop switch on, while `workerLaunchReady` is false, or with no active lead. LEAD-11 isn't built, so `KinDeferralStopSwitch` defaults to stopped. With today's defaults, silence never starts work. [Start now] is an owner tap, not a level grant: it refuses, leaving the run and card as they were, while stopped, while `workerLaunchReady` is false, or below L2.
- **Idempotent start.** Starting sets `started` and enqueues `deferral.due` (phase `due`) for the lead to delegate, deduplicated by the due fire's id `deferral:<itemId>:due:<dueAtMs>`. A fire's event takes its time fields from the fire, so a replay enqueues the identical event; a start that finds another path's `deferral.due` under the same key counts it as already started. A replay, a grace fire and a [Start now] tap can't start two workers.
- **States.** `armed`, `heads_up`, `grace`, `asked`, `started` (`start`); `reminded`, `asked`, `chased` (`remind`, `ask`, `chase`); `disarmed`. A re-arm from memory returns the run to `armed`.
- **Bring it up early.** When a message touches the topic before the due time, the lead mentions it (LEAD, using the cache). The Monday morning brief lists deferrals due this week.

**Follow-ups (deferred to TRIG-8/10; not implemented by TRIG-11).** A ping with no answer creates a follow-up trigger (`followup`, `once`, next working morning at the owner's brief time). That is the "follow-up = a deferral created by a ping" row of section 6.

### Pings

`kin_ping_ledger(org_id, person, item_id, day)` carries a unique key, so a person is pinged at most once per item per owner day. Pings to one person within one sweep are batched into one message, up to the 16,000-character body limit; overflow goes out on later sweeps. Quiet hours come from `people/<handle>.md` (`tz`, `quiet_hours`) or the org default; a ping due in quiet hours waits for its end. Every ping names a next step. A second day without an answer escalates once to the owner's **Waiting on you**, ignoring quiet hours because Waiting on you is passive. Delivery goes through the chat service (CHAT).

TRIG-11 persists requests in `kin_ping_items` before delivery; quiet sweeps leave them pending, with no sent ledger row. Each later sweep rechecks the current owner day, item state and person settings. Delivery and the sent ledger commit in one SQLite transaction, so restart retries cannot duplicate a committed batch. Equal quiet-hour bounds disable quiet hours; windows include the start and exclude the end. Missing or invalid person zones use the org zone; missing or invalid windows use the org quiet hours (21:00–08:00 before settings exist).

An answer is a posted human message by that recipient replying (`reply_to`) to a ping containing the item, or any later message by that recipient in the chat when that ping contained exactly one item. Reads, system notices and agent messages are not answers. Answering stops only that recipient's item; other recipients stop through their own answers or item closure. A non-open, invalid or deleted item stops all recipients. The escalation resolves when the item closes or no recipients remain pending. A new `put` for a stopped, open item starts a fresh lifecycle for that recipient, resetting delivery membership but preserving the daily ledger: at most once per item per owner day; resolved escalation anchors can then be replaced. Day two means a later owner-calendar date, not 24 elapsed hours. Notices are server-only `KinChatService.notice` system messages, never model-authored or human-impersonated posts. Watchdog and deferral callers compose the ping service with Memory. TRIG-11 starts no sweeper of its own; the deferral flow's `kin-deferrals` tick (TRIG-8) runs `KinPings.sweep` for every org.

### Routines (`fixed_time` in the owner's zone)

The dream consumer suppresses a `dream` fire whose `dueAt`, in owner time, falls on `fullRebuildWeekday`.

| Routine           | Does                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `morning_brief`   | Posts `kin_prepared_briefs` for today (prepared by the dream), refreshed with events since 03:00. Until the dream prepares one, the server builds it live (LEAD-13). On Mondays, adds deferrals and commitments due this week.                                                                                                        |
| `evening_summary` | What was decided, merged, deferred and promised today, plus tomorrow's due items.                                                                                                                                                                                                                                                     |
| `dream`           | The dreaming pipeline below, lowest budget priority.                                                                                                                                                                                                                                                                                  |
| `dream_full`      | The same pipeline over all items, not just new material.                                                                                                                                                                                                                                                                              |
| `owner_check`     | Code picks 5 items: past `review_by`, flagged misleading, low-trust claims older than 30 days, and evidence-free status claims, in that order. It posts a native card with Keep (push `review_by` out one period), Update (opens the direct chat on the item) and Drop (set `invalid_at` now). Taps are owner-authored memory writes. |

Routine delivery is a lead-queue request, not a second posting path: TRIG-9 enqueues `routine`; LEAD-13 owns the brief/summary message and prepared-brief content. Late boundaries are measured from the scheduled owner's calendar date (a summary expires at the first dream after its due time). Folds retain the original routine and due instant, survive restart, and move with an expired summary into the next brief. Same-tick fires are handled by due time, not inbox receipt order. Disabling a routine expires its queued requests; enabling it schedules the next slot without backfill. Pause/resume preserves individual opt-outs.

Routine processing consumes schema/decode failures immediately. Other failures (including SQLite contention, enqueue failure and unavailable memory checkouts) stay pending for the next tick; a failing fire more than 24 hours past its due instant is consumed to bound poison retries. Successful late fires still follow the normal fold/post policy. Owner-check selection runs before the enqueue transaction, which rechecks consumption and event identity.

Owner-check ties use review date (missing last), then item id and path. Invalid, superseded and duplicate-id items are excluded. Low trust means any trust below owner; with no status-claim subtype in memory, evidence-free means a claim with no evidence links. Keep sets the next review to now +90 days for people or +30 days otherwise, so repeated Keeps do not grow the review interval. Update returns the owner direct-chat/item target; Keep and Drop stage through the writer with the verified, claimed owner action as their source, never model-supplied provenance. Native clients own presenting the three actions; the server owns their authorization.

**Owner-check release gate (TRIG-9):** selection and routine enqueue are live, but
`WakeupRunner` keeps native card posting explicitly disabled until the dispatcher
lands. Before enabling it:

- chat act must enqueue `widget.action`;
- `WakeupRunner` must intercept `owner_check` actions, run `OwnerCheck.act`,
  then `MemoryWriter.commitWakeup`, then queue `finish`, without exposing these
  actions to the model prompt;
- production `MemoryWriterAuthority.resolve` must grant `kind: "owner_check"`
  only after verifying the claimed owner tap, binding its item id and action.
  An owner chat citation is not review-date authority;
- web and mobile must render the native card, its handled items, and closed state;
- a revision conflict after Keep or Drop is staged must unstage only that item's path. Today it discards the whole wake-up session, which would drop the lead's other staged writes.

Each accepted action advances the card revision and marks that item handled;
the last handled item closes it. Misleading-memory selection reads reports
ended in the last 90 days.

### Watchdogs (`interval`)

All are plain code in [`watchdogs.ts`](../../../apps/server/src/kin/triggers/watchdogs.ts). They write memory only through the LEAD queue as code-only events, which keeps one writer per org (gap 1). They run on the shared 5-second tick (`kin-watchdogs`) with in-process intervals, not `kin_triggers` rows: a watchdog has no slot to keep, and the late policy is "run once now; no backfill". So every watchdog runs once at startup, then on its interval. Memory is read outside any SQLite transaction.

| Watchdog            | Every  | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github_recheck`    | 10 min | For open commitments and deferrals whose scoped GitHub links are all done (issue closed, PR merged), queues a `watchdog` event naming each evidence link and asking the lead to mark the item done. Matches conditions against current state (below). Then consumes the org's pending `github_recheck` rows, but only after a sweep that read every repo it needed.                                                                                                    |
| `stale_review`      | 30 min | Open items linking an open PR with a review requested over 24 h ago: chase the reviewer, matched by `kin_people.github_login`, in the item's chat (ping rules).                                                                                                                                                                                                                                                                                                        |
| `promise_overdue`   | 30 min | Open commitments past `due`: chase whoever promised (`owner`, else `said_by`) in the item's chat (ping rules).                                                                                                                                                                                                                                                                                                                                                         |
| `objective_at_risk` | 6 h    | Open objectives due within 3 days with an open linked issue or PR: one owner notice per objective and due date. The objective's `due` stands in for its milestone.                                                                                                                                                                                                                                                                                                     |
| `index_freshness`   | 1 h    | `INDEX.md` "As of" missing, in the future or 36 h old: `Memory.rebuildIndex` (code, below), the same check wake-up preparation runs.                                                                                                                                                                                                                                                                                                                                   |
| `trigger_reconcile` | 15 min | Re-syncs deferral triggers from the whole memory snapshot (`KinTriggerService.syncOrg`). Checks every `KinWebhookSource` task exists, is enabled and isn't `blockedByPolicy`, records what it saw in `status` and tells the owner when it changes; a task whose secret doesn't match the bound hash gets one notice per binding. It never re-enables a task, re-keys or rebinds. Clears consumed inbox rows older than 7 days and fire-ledger rows older than 30 days. |

- **GitHub reads.** Through `KinWatchdogGithubReader` only: one read-only, batched call per repo for all the numbers the sweep needs, each bounded to 30 s. Only repos in `KIN_GITHUB_REPOS` are read. A repo that fails, times out or is rate-limited skips the items that need it and keeps the rows pending; nothing retries before the next sweep.
- **The real readers.** With `KIN_GITHUB_APP_ID` set and the App's key in the keychain, Kin's server layer provides both readers over `KinGitHubApp` (approvals spec section 10). Each repo gets one `server`-holder installation token narrowed to `issues: read` and `pull_requests: read`, reused until five minutes before it expires and dropped on a 401 or a 403 "Resource not accessible by integration". Reads go through GitHub GraphQL, up to 50 issues or PRs per query. An item whose assignees, closing PRs, review requests or review-request events run past one page is left out (read as unavailable) rather than reported in part, and closing PRs from another repo are dropped. Time bounds belong to the callers. A repo outside `KIN_GITHUB_REPOS`, or one the App can't mint a token for, fails closed without a GitHub call. A 429, a rate-limit 403 or a GraphQL `RATE_LIMITED` fails the repo for this read. The readers make no writes. Without the App, or if it can't be built, startup logs one warning and the defaults stay: the deferral reader fails `unavailable` (deferrals ask) and the watchdog reader is `null`, so `github_recheck`, `stale_review` and `objective_at_risk` do nothing and `github_recheck` rows stay pending; nothing is lost while it waits.
- **Conditions from state.** A PR gives `pull_request` with action `opened` or `closed` and `merged`; an issue gives `issues` with `opened` or `closed`. `matchConditions` then applies as for events, so a condition on another event or action matches only through webhooks. A match queues a `watchdog` event whose finding starts "GitHub state shows condition met (read from GitHub by code)".
- **Repeats.** Findings dedupe on `kin_events.dedupe_key` (item, links and state), so a later sweep queues nothing new. A chase is skipped while the person's ping for the item is active, or when it was stopped after what prompted the chase last changed (the commitment's due date, or the review request's time), so an answered chase stays answered until the due date moves.
- **Source status is advisory.** The sink does not refuse on `status`: the task's shape and bound secret are the gate, and a delivery after the owner turns the task back on must not wait 15 minutes for reconcile. A hash mismatch has no status value; the sink already refuses it, and `setSecret` or setup is the way out. Routine rows are kept by the routines tick's own 15-minute reconcile and dream rows by `DreamRunner`, so `trigger_reconcile` doesn't repeat them.

### Staying fresh (section 4)

**`review_by` defaults** are filled at write time by `freshness.ts`:

- person: +90 days;
- objective: next milestone date supplied by the writer, falling back to `due`, then +30 days from `recorded_at`;
- commitment and deferral: `due`;
- decision: null;
- claim: +30 days.

**`INDEX.md` is built by code**, not by the model (`buildIndex.ts`), from the front-matter cache. It has at most 200 lines and an `As of <ISO>` first line. Sections: Waiting on owner, due in 7 days, open objectives, open commitments, overdue (flagged `⚠ review`). Items flagged misleading drop to the end with a mark. Items unread for 8 weeks are left out, using last-read timestamps that LEAD's Memory read path records in Kin's DB (`kin_memory_reads`), not in git. Never-read items use `recorded_at` as the baseline.

The builder takes item heads (optionally marked `misleading` by the caller), last-read integer milliseconds, caller-supplied `now` and the owner's IANA zone. Each item appears once, in the first matching section; open, valid `on_due: ask` items with `due <= now` mean Waiting on owner (asked but not yet answered); future-due ask items stay in their normal section. Due in 7 days includes today through the seventh following owner-calendar date (exclusive midnight of day 8); front-matter date-only values still mean UTC midnight. Other items remain in Other memory; misleading items go last. Within each section, order is due, review date (missing dates last), id, path, then title, using ordinal string order. Overdue due dates on open items and overdue review dates are flagged. The cap includes headings and the omitted-item count. Memory reads the owner's zone from `kin_trigger_settings`, using UTC before settings exist or when the zone is invalid or cannot be read. `defaultReviewBy` is the pure helper LEAD-3's `stage` calls on the lead's staged input, before it becomes front matter, with `recordedAt` in integer milliseconds; it applies defaults only when the input omitted `review_by` and preserves explicit dates and null. Committed front matter always carries `review_by` (the schema requires it), so the helper never runs on parsed files. The truncation line is "N more items not listed; use memory_search".

**Contradiction checks** at write time are LEAD's (Memory writer). Dreams list the ones they find.

### Dreaming pipeline (one per org per night)

`DreamRunner.run(orgId, { full })`, keyed by `(orgId, ownerDate)` in `kin_dream_runs`, so a rerun replaces that night's branch:

1. **Collect originals** since the last successful dream's `materialUntil`: `journal/` files, chat messages (CHAT store), worker reports (LEAD), `KinGithubEvent`s, and the dream rejections list. No briefs, summaries or earlier dream output. `full` adds every item.
2. **Branch.** A scratch checkout of `main`'s hash-verified tree (not a `git worktree`: memory git runs with a private git directory, so worktree metadata cannot persist). The branch `dream/<YYYY-MM-DD>` exists only once the writer commits on that `main` head and force-pushes it.
3. **Extract and merge** with a cheap model in a lead session in dream mode (LEAD runs it). The model may edit only item files and `journal/`. It also writes `.kin-dream/dream.json` (beside the code-built `.kin-dream/material.json`), which is not committed; `kin_dream_runs.dream_json` keeps the checked copy: each change with `source` refs into the material, merges, supersessions (`invalid_at`, `superseded_by`) and contradictions. Contradictions go to a stronger model, which proposes a resolution or a question for the owner.
4. **Code checks**, all of which must pass or the dream fails:
   - every changed file parses against the item schema;
   - no deletions, symlinks or hard links;
   - `rules.md` and `INDEX.md` are unchanged, and nothing outside item folders and `journal/` changes;
   - every changed file is listed in `dream.json`, and each `source` there exists in the material;
   - the secret scan is clean (the changes and `dream.json`; the writer scans the commit again);
   - neither contains a T3 MCP bearer token that is still issued (the Kin registry wrapper keeps only their SHA-256 hashes);
   - a new item, or one whose `source`, `said_by` or `trust` changed, has `source` set to a material ref whose verified author gives exactly its `said_by` and `trust`;
   - every contradiction has a `resolution` or a `question`.

   The dream may propose `decisions/`, `people/` and `objectives/` changes; they only ever reach `main` through the review PR (step 7). Nothing in TRIG-13 merges.

5. **Recheck** evidence and `review_by`, then rebuild `INDEX.md` (code).
6. **Prepare the morning brief** into `kin_prepared_briefs`.
7. **Split and deliver.** Code classifies every changed file:

| Goes to `dream/<date>` (label `dream:auto`, merges itself)                                                                                | Goes to `dream/<date>-review` (label `dream:review`)      |
| ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `journal/**` folding                                                                                                                      | anything in `decisions/`, `people/`, `objectives/`        |
| `INDEX.md`                                                                                                                                | any item whose new content has `trust` other than `owner` |
| status, `invalid_at`, `superseded_by` or `review_by` changes on commitments and deferrals whose evidence link the code verified on GitHub | contradictions and their proposed resolutions             |
| new commitments and deferrals said by the owner (`trust: owner`, source is an owner-authored message)                                     | anything else                                             |

- **Provenance of auto-merged edits.** A changed item may go to `dream/<date>` only if at least one of its listed sources has trust at least the item's trust (`owner` > `member` > `agent` > `external`); otherwise it goes to review. This covers edits that keep `trust`, `said_by` and `source` but change the body, `status`, `due`, `invalid_at` or `superseded_by`, which step 4 accepts unchecked; a `due` edit re-arms a deferral. TRIG-14 acts only on the `head` of a `succeeded` `kin_dream_runs` row, never on a remote `dream/*` branch alone, since a branch can outlive its row.
- **Auto PR.** The bot opens it, waits for the memory repo check (below), and merges it with squash. Merging is privileged under section 9.1, so this rests on a standing owner-signed **delegation** (section 9.6, APPR): "Kin may merge PRs labelled `dream:auto` in `<memory repo>` that touch only `journal/**`, `INDEX.md`, `commitments/**`, `deferrals/**`". The executor re-checks the paths at the head SHA before merging.
- **Review PR.** It is based on `main`, and `INDEX.md` is excluded (rebuilt after any merge). It becomes one `KinPendingAction` (`memory.dream_review`) and one **Waiting on you** card: "Last night's memory changes: 3 decisions, 1 person, 2 contradictions" with a per-item list. Approve merges at the bound head SHA with a signed grant (APPR). Reject closes the PR and records each item in `kin_dream_rejections`, so the next dream doesn't propose it again.

8. **Failure.** Any failed step deletes the branch, merges nothing, and posts what went wrong to the owner's direct chat (withheld if the text fails the secret scan). The next night retries from the same `materialUntil`. `DreamRunner.cancel(orgId)` interrupts the provider turn, deletes the branch and ends the row `cancelled`; a row still `running` after a restart ends `failed`. Rows end `succeeded`, `failed` or `cancelled`.

**Consumer (TRIG-13).** `DreamRunner` registers on the Kin scheduler: it creates the `routine:dream` and `routine:dream_full` triggers and drains their fires. A fire is skipped (consumed) past 08:00 owner time or when suppressed by `fullRebuildWeekday`; it waits while the org is paused, `KinBudget.admit(orgId, "P4")` refuses, or a dream is already running. The dream turn is an ordinary thread in a per-dream scratch repo (its own `git init`) and gets no MCP credential on `/mcp` or `/kin/mcp`, because its material holds untrusted text. The checkout holds only item files, `journal/`, `rules.md` and `INDEX.md`, so a `.mcp.json`, `.claude/` or `CLAUDE.md` committed to the memory repo never reaches the provider. Dreams run only on Claude: a turn on any other driver, or on a Claude instance whose launch arguments set a permission or skip-permissions flag, fails before it starts. For `kin-dream:` threads, [`DreamIsolation.ts`](../../../apps/server/src/kin/dreaming/DreamIsolation.ts) wraps the Claude query runner so the query loads no settings sources or flag settings beyond model selection, uses a strict empty MCP config, adds no directories, forces `acceptEdits`, and offers only Read, Edit, Write, Glob and Grep. `DreamSession` declines every approval, and a request it cannot decline ends the run. Codex is refused: its shell sandbox still reads files outside the checkout, and no per-thread option removes the shell or the user's MCP servers. Material is bounded by INTEGER ms in `(materialFrom, materialUntil]`. Dream provider usage is not yet charged to the budget (charges key on wake-ups). The rejections list joins the material with `kin_dream_rejections` (TRIG-14). Step 5's evidence recheck and steps 6 and 7 are TRIG-14 or later; TRIG-13 rebuilds `INDEX.md` in the dream commit.

**Memory repo guard rails** (in `kin-memory`, outside this fork; templates in [`ops/kin/memory-repo/`](../../../ops/kin/memory-repo/README.md)):

- A `CODEOWNERS` file that denies by default: `* @<owner>` first, then owner-less lines for only the paths Kin writes alone (`/commitments/`, `/deferrals/`, `/claims/`, `/journal/`, `/INDEX.md`). GitHub applies the last matching line, so `rules.md`, `decisions/`, `people/`, `objectives/`, `.github/` and any root file a lead turn would load from the read checkout (`CLAUDE.md`, `AGENTS.md`, `.claude/`, `.mcp.json`, `.codex/`) stay with the owner. `.github/` stops a PR from dropping the owner rule or the check itself. The lint fails when the file is missing, still names `@OWNER`, or differs from that shape. CODEOWNERS can't carve a path back out of an owner-less line, so the lint walks the whole tree from git's index and allows only Kin's own shapes there: `<folder>/<id>.md` one level deep in the three item folders (no `CLAUDE.md`, `AGENTS.md` or `GEMINI.md`), `journal/YYYY/MM-DD.md` and a root `INDEX.md` file. A dot segment such as `.claude/` under those paths, a symlink or a submodule anywhere fails it.
- A ruleset on `main` that requires PRs and code-owner review, with no bypass for Kin's bot.
- A required check `.github/workflows/memory-check.yml` that runs schema lint and gitleaks. The lint is `apps/server/src/kin/memory/lintCli.ts`, which uses the server's own front-matter parser; the gitleaks config is generated from `KinSecretScan`'s rules. Both come from a pinned commit of this repo, never from the PR. `MemoryWriter` and the dream check use the lint's path shapes, so Kin never writes a path `memory-check` refuses. Before making the check required, run the lint against the memory repo's `main`, which may already hold older paths. Gitleaks parity is best effort: it misses a value swallowed by an allowed `secret-assignment` match (`secret=https://x/?db_password=…`), tokens split across lines or hidden with zero-width or fullwidth characters, and file paths.

GitHub then blocks a bad auto-merge even if Kin's classifier is wrong.

**Daytime lead writes (decided).** Because `main` requires PRs, LEAD's daytime memory writes and the owner's Keep land as PRs that Kin merges itself once `memory-check` passes; changes to an owner path go to a separate PR that waits for the owner's review and that Kin never merges. A passing `memory-check` alone isn't trusted (see the memory repo README, Workflow permissions): Kin merges only a PR whose head is the commit it pushed, with REST `sha` pinned to it, after every `memory-check` check run on that commit turned out to be a job of a `pull_request` run of `.github/workflows/memory-check.yml` for that PR, branch and commit, and those jobs passed. Review PRs carry the pushed commit in their body and notice, and a periodic sweep closes them if their head moves, along with any other `kin/write/*` PR no write waits on. GitHub's auto-merge would accept any workflow's check, so it isn't used. The writer side is in the lead spec (Memory writes). `MemoryPullRequests` needs the Kin App and the memory repo in `KIN_GITHUB_REPOS`; without the App, writes to `main` are refused unless `KIN_MEMORY_DIRECT_PUSH=true`, which suits only a memory repo without this ruleset. The ruleset itself comes from `KIN_REPOS` with `kind: "memory"` (#85).

### Secret scan before memory commits (gap 5)

`apps/server/src/kin/memory/secretScan.ts` defines `KinSecretScan.scan({ orgId, files: ReadonlyArray<{ path: string; content: Uint8Array }> })`, returning an Effect of `{ path, ruleId, line }[]` with typed `KinSecretScanError`. LEAD-3 supplies an explicitly named no-findings stub; TRIG-16 replaces that layer with the real scanner. Fingerprints stay internal to the scanner allowlist, never matched secrets in findings.

**Rules:**

- GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`);
- Anthropic `sk-ant-`; OpenAI legacy `sk-` with the `T3BlbkFJ` marker and `sk-proj-`/`sk-svcacct-`/`sk-admin-` containing an uppercase letter;
- AWS `AKIA…`/`ASIA…`;
- Slack `xox[abposr]-`;
- Stripe `sk_live_`/`rk_live_`;
- Google `AIza`;
- PEM `-----BEGIN … PRIVATE KEY-----`, including `PGP PRIVATE KEY BLOCK`;
- JWTs (`eyJ…`, three base64url parts);
- URLs with a password in them (`scheme://user:pass@`);
- `password|secret|token|api_key = <value of ≥ 20 chars and high entropy>`.

**Hooks:**

- LEAD's git writer calls it before every commit.
- The dream runs it before pushing.
- The memory repo CI runs gitleaks as a second, independent check.

**On a finding**, the writer blocks the entire commit, discards staged text and emits a typed owner-notification hook. The runner journals the refusal without secret content and tells the owner to review and rotate the affected credential. Automatic redaction is not part of the writer contract.

**False positives:** the owner adds the fingerprint to `kin_secret_allow` through a signed action. A model can never add to it. Entries are scoped to organization, exact path, rule and SHA-256 of `ruleId + "\0" + normalized matched value`, with `created_at` in integer milliseconds and `signed_action_id` reserved for the future APPR executor id. The scanner is read-only; the APPR executor must verify the owner grant before inserting. Until that executor lands, there is no agent or MCP allowlist-write path. Migration K012 is provisional and will be renumbered at merge.

The scanner checks paths as well as content, redacts paths that contain a finding, normalizes NFKC, common Cyrillic/Greek/Latin lookalikes and Default Ignorable code points, checks newline-wrapped tokens, and decodes URL/base64 content up to two levels. Base64 decoding tries all four alignments; malformed percent bytes and non-ASCII decoded bytes become separators. Prefix rules use alphanumeric left boundaries and body-specific right boundaries (fixed-width Google keys also tolerate underscore metadata suffixes); each precompiled regex sees at most 8192 characters plus one character of boundary context on each side, with 4096-character overlap. JWT detection matches a bounded prefix: an eyJ header followed by 5–2048 base64url characters, then an eyJ payload prefix followed by 8–1024 characters, without requiring the signature or the payload end. Its maximum match is 3080 characters, within the overlap. Wrapped tokens are inspected after each appended fragment once the joined run has 20 characters or an anchor, retaining up to eight fragments and 4 KiB. A prose line closes the prior run with its first word and opens a new run with its last word, so adjacent prose and trailing words do not hide a wrapped token. Merge scanning covers only bytes changed from the fetched remote plus the rebuilt `INDEX.md`, not pre-existing remote content. Scanner failures notify through the writer hook, just like findings. Staged YAML parser errors omit source-bearing diagnostics and filesystem path errors omit the underlying path-bearing cause. Merge blocks use the recovery hook; production owner delivery still waits on a notifier. It fails closed above 1 MiB per file, 8 MiB or 1024 files per call, 4096 allowlist entries per organization, or 64 MiB of weighted work (inspected characters, encoded candidate characters, window characters, and 64 units per regex match). A cheap anchor pre-filter skips rule execution on irrelevant windows, including decoded candidates; recursive decoding remains active to find double-encoded tokens. Scanning yields between windows and decoder candidates so multi-file batches do not monopolize the event loop. Base64 runs shorter than 27 characters and fully percent-encoded runs shorter than 60 characters are not decoded; mixed percent/plain runs retain a 20-byte minimum to prevent partial-encoding bypasses. Wrapped runs beyond eight fragments or 4 KiB, splits by a space, `\r`, U+2028, across journal bullets, markdown or HTML comments, `\u` escapes, and hex encoding remain out of scope. These are conservative detectors, not a guarantee against arbitrary encryption or steganography.

Known gaps, accepted for phase 1: JWE (five-part) tokens and JWT headers longer than 2051 characters; multi-part secrets (JWT, PEM header, URL password, `KEY=value`) with only some bytes percent-encoded; lookalikes outside the folding table (for example Greek `ρ`, Cyrillic `І`/`Ј`/`к`, small caps, U+2800, combining marks inside an anchor). A file of about 1 MiB made only of long whitespace-free lines (such as one path per line) exhausts the work budget after about 15 s and fails closed, blocking that commit; realistic journals up to 1 MiB pass.

### Owner-signed purge (gap 5)

Pending action `memory_purge`. The plan is `{ orgId, repo, mode: "drop_file", paths }` or `{ orgId, repo, mode: "redact_text", patterns }`; `redact_text` rewrites every blob and commit message in history, so it takes no paths. `KinPurge.storePlan` writes `purgePlanJson(plan)` to `<kin state>/purge-plans/<sha256>.json` and returns the action's `content` target, whose path and sha256 come from that same serialization, so the grant binds the exact plan; `discardPlan` deletes it once the action is terminal, since it can hold the secret, and refuses while that plan's purge marker exists. The owner opens the action from an item's menu, or Kin proposes it when the weekly `dream_full` scans full history and finds a secret. Approval uses a native card and a signed grant (APPR). `memoryPurgeHandler` in `apps/server/src/kin/memory/purge.ts` is APPR-9's `KinActionHandler` (`precheck`, `run`, `reconcile`) and the only entry point; no model, MCP tool or RPC reaches `KinPurge`. Every `KinPurge` method refuses with `KinPurgeExecutorNotReady` until APPR-9, APPR-10 and LEAD-11 land.

Before anything runs, the stored plan must re-serialize to the same bytes and match the target; the grant, action and plan must share the org; the grant must bind the action id, revision, kind, `targetDigest` and plan digest; and `repo` must equal the org's configured memory URL. Paths: 1–64, unique, NFC, relative `.md` files other than `rules.md`, with no `..`, `.`, empty, `-`-leading or `.git` segment, backslash or control character, and each must exist in history (literal pathspecs), so a typo or an NFD name fails instead of purging nothing. `redact_text` takes 1–64 literal patterns of 8–1024 characters without control characters or `==>`; each becomes one `literal:` rule, so a pattern can't add a rule or switch to regex. Every argument goes to git and `git-filter-repo` as an argv entry, never through a shell, with inherited `GIT_*` variables removed.

`run` then:

1. Pauses the org's lead queue through `KinPurgeQueue`. The default fails `KinPurgePauseUnavailable` until LEAD-11 builds the pause, because a reclone deletes the read checkout a running lead uses as its workspace. `pause` must not return while a wake-up or dream is running: their staged files and dream copies predate the rewrite. As a backstop, every quarantine and reclone bumps `Memory.historyGeneration`, and a `MemoryWriter` session started under an older generation fails `MemorySyncConflict` and drops its staged changes instead of committing them onto the rewritten head. It takes the memory writer lock through `Memory.withHistoryRewrite`, which is the only way to reach the quarantine and reclone operations.
2. Lists the remote's refs with `git ls-remote` under the owner credential `KinPurgePush` uses, and fails closed at the clone stage if it advertises anything other than `HEAD`, `refs/heads/*`, `refs/tags/*` and `refs/pull/*`: `refs/notes/*` or a custom namespace such as `refs/custom/*` would keep the old history out of reach. It then bare-clones `refs/heads/*` and `refs/tags/*` into `<kin state>/<org>/purge-scratch` (stale clones from a crashed purge are swept first) and runs `git filter-repo --invert-paths --path <p>` (`drop_file`) or `--replace-text <rules> --replace-message <rules>` (`redact_text`). It also fails closed at the clone stage on any tag that doesn't peel to a commit, because filter-repo leaves tags on blobs and trees alone. A plan that changes no ref fails.
3. For `drop_file`, checks that no reachable commit touches the paths, then commits a tombstone on the default branch for each item path present at the old head: the original `id` and the folder's kind, `title: Purged item`, `status: cancelled`, `invalid_at: now`, `source: kin-action:<action id>`, `said_by` the approving owner, body "Purged on <date> by the owner (action <id>)". Memory still shows that something was there. Journal and other non-item paths get no tombstone.
4. Reads every blob ever introduced at every path, merge sides included, every commit object and every tag object (tagger idents survive `--replace-message`). It fails if a redacted pattern remains, then runs `KinSecretScan` over all of it and fails closed on **any** finding: findings carry no fingerprint, so the purge can't prove one unrelated, and a copy under an older path would otherwise survive. Allowlisted fingerprints don't count.
5. Records the tombstones' blob ids in `purge-plans/<sha256>.tombstones.json`, writes the durable marker `<kin state>/<org>/purge-in-flight` (plan digest, action id, old head, the plan itself and the tombstone ids), and deletes the writer and read checkouts, any half-finished `memory.clone-*` and the dream scratch `<org>/dreams/`, before the push. A push can land and still report failure (a timeout, a crash, a restart), and those checkouts hold the old history: `Memory.preserve` would push it back as a `kin/conflict/*` branch, and a dream as `dream/<date>`. While the marker exists, `ensureCheckouts` and `recover` won't clone (until the push lands the remote still has the old history), and `preserve`, the wake-up merge, `commitWakeup`, `commitDream` and `deleteDreamBranch` refuse to push. Only the purge's own reclone clones.
6. Force-pushes the changed `refs/heads/*` and `refs/tags/*` in one atomic push, each leased at its cloned value, through `KinPurgePush`. Failures are classified from `--porcelain` output (`lease_rejected`, `remote_rejected`, `auth`, `network`, `timeout`) without the cause, so neither the URL nor helper output is logged. `kin-main` has no bypass actors and blocks force-pushes, so the purge runs in an owner window instead: with their own credential, on their own device (never a stored owner credential on the Kin host), the owner sets `kin-main` to `enforcement: disabled`; step 6 pushes; the owner re-applies with `scripts/kin-rulesets.ts --repo GLDRoger/kin-memory`, and `--check` must pass before the queue resumes. Closing open dream PRs that touch the paths waits on the GitHub client.
7. Re-lists and re-mirrors the remote and runs the same history check as `reconcile`; a ref created during the purge that still holds the content fails at the push stage with `queueHeld: true`. Then reclones: clones fresh, records the rewritten anchors without preserving the old ones, rebuilds the read checkout, cache and `INDEX.md`, clears the marker, and resumes the queue. A failure or interruption before step 5 resumes the queue with nothing changed; from step 5 on, any failure, defect or interruption leaves `KinPurgeFailed` with `queueHeld: true` and the queue paused.
8. Returns the `execution_finished` audit input (grant `jti`, key thumbprint, new head; APPR-10 adds the device label from the key) with the paths, old head, new head and rewritten refs; APPR-10 writes it as a `KinAuditEntry`.
9. Tells the owner what a purge can't reach: GitHub keeps `refs/pull/*` (read-only, so the clone leaves them out and `reconcile` doesn't wait on them) and cached PR diffs (removing those needs a GitHub Support request); forks, local backups (Time Machine) and the chat database keep their copies. It won't rewrite `refs/notes/*` or custom refs such as `refs/custom/*` either: their presence fails the purge in step 2 and makes `reconcile` answer `unknown`, so the owner deletes them on the remote first. A leaked credential must be rotated whatever happens.

`reconcile` bare-clones the remote the same way and checks whether the plan's paths or patterns are still in history, counting only blobs whose ids match this purge's recorded tombstones as purged, so a look-alike tombstone counts as old content; it reads the plan from the marker if the plan file is gone. Gone is `done`; still there with the default branch at the marker's old head is `not_done`; anything else, an unreachable remote, or a remote advertising refs outside heads, tags and pulls is `unknown` and changes nothing. `done` and `not_done` reclone, clear the marker and resume the queue. A re-run of the same plan while its marker exists reclones instead of resuming against old checkouts, and reports success when the push had already landed. [Kin memory purge](../../operations/kin-memory-purge.md) covers clearing a stuck marker by hand.

**Owner credential.** `gitPushLayer` takes a reference to the owner's credential, never the secret: a git credential helper name or absolute path (no inline `!` script), or an SSH command naming its key file (no shell metacharacters; T3 appends `-F none`, `BatchMode`, `IdentitiesOnly` and `IdentityAgent=none`). An `https://` remote needs the helper and an SSH remote the command; `file://` takes neither, and any other transport fails `unsupported_remote`. git runs with an empty scratch `HOME`, so `~/.netrc` and `~/.ssh/config` can't supply another credential. This is the one exception to APPR's rule that the owner credential never reaches a child process: the helper or key is read by git or ssh, not by T3. With neither configured the push fails `credential_unavailable`, SSH without an owner command is refused rather than using the host's keys or agent, and `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS`, `SSH_ASKPASS` and `SSH_ASKPASS_REQUIRE=never` keep anything from prompting.

**Dependency:** `git-filter-repo` (git's recommended history rewriter; MIT, also usable under git's GPL), checked at v2.47.0. TRIG-20 installs it on the Kin host; `GitFilterRepoCommand` overrides the binary path. The real-rewrite tests skip on machines without it.

### Upstream contract tests (gap 7)

These are files named `*.kin-contract.test.ts`. Run them after every upstream sync, next to the branding drift check:

```sh
cd apps/server && vp test run kin-contract
cd apps/mobile && vp test run kin-contract
```

Each test pins only what Kin uses. `scheduledTask.kin-contract.test.ts` must pin the upstream columns Kin reads: `scheduled_tasks.task_id`, `project_id`, `thread_id`, `thread_mode`, `schedule_json`, and `scheduled_task_webhook_deliveries.task_id`, `delivery_id`, `received_at`.

| Piece               | File                                                                         | Asserts                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Triggers: schedule  | `apps/server/src/kin/contract/scheduledTask.kin-contract.test.ts`            | `ScheduledTaskUpsertSchedule` decodes Kin's webhook shape. `nextScheduledRunAt` with a `Asia/Kolkata` and an `America/New_York` zoned `from` gives 03:00 wall time, including a DST day. `MAX_WEBHOOK_DELIVERY_AGE_MINUTES === 1440`.                                                                                                                                                                                                             |
| Triggers: dispatch  | same file                                                                    | With `ScheduledTaskService.layer` and a mocked `ThreadLaunchService` (the pattern in `ScheduledTaskService.test.ts`), a signed GitHub request to an unbound task calls `launch` once. The call has `initialMessage.scheduledTaskId === task.id` and `commandId === \`scheduled-task:${id}:webhook:${deliveryId}\``. A replay with the same `x-github-delivery`is`duplicate`. `getWebhookDelivery`returns the`x-github-event` header and the body. |
| Triggers: scheduler | `scheduler.kin-contract.test.ts`                                             | `Scheduler.register` runs a source after `TestClock.adjust("5 seconds")`.                                                                                                                                                                                                                                                                                                                                                                         |
| Relay               | `relay.kin-contract.test.ts`                                                 | `RelayDeliveryProof.verify` accepts a signed proof and yields `receivedAt`. Header names `x-t3-relay-delivery-id` and `x-t3-relay-received-at` are unchanged.                                                                                                                                                                                                                                                                                     |
| `delegate_task`     | `delegateTask.kin-contract.test.ts`                                          | `OrchestratorMcpDelegateTaskInput` decodes the brief shape LEAD sends; the result carries the child thread id.                                                                                                                                                                                                                                                                                                                                    |
| Managed policy      | `managedPolicy.kin-contract.test.ts`                                         | `ManagedPolicyDocument` decodes a document with `locked: true` settings and `webhookTasks: false`; a blocked webhook task reports `blockedByPolicy`.                                                                                                                                                                                                                                                                                              |
| `McpAppWebView`     | `apps/mobile/src/features/chats/contract/mcpAppWebView.kin-contract.test.ts` | `tools/call` reaches `callTool` and `ui/message` reaches `sendMessage` through `makeMcpAppHost`, with results and refusals; the outer document marks `active` only for a real tap with focus on the app frame, relays only the frame's messages, and sandboxes it without `allow-same-origin`.                                                                                                                                                    |

Failure means: stop the sync merge, fix Kin's adapter, then merge.

### Running on the Kin host

Kin runs on one always-on machine, the **Kin host**. The laptop and phone are clients. For now the host is `nishchay-linux` (Linux, 8 cores, 14 GB RAM, reached over SSH). A Kin host may replace it later; the macOS notes are at the end of this section.

**Install (Linux):**

- `git`, `gh`, `git-filter-repo` and `gitleaks` from the distribution or their release binaries.
- Node 26 (the repo's `engines`) through `mise`, which the host already uses, and `vp`.
- A dedicated `kin` user (`sudo useradd -m kin`). The Kin server runs as this user, never as the owner's account. Its only GitHub credentials are the GitHub App's and a memory repo deploy key kept outside `~/.ssh` and passed to memory git alone through `KIN_MEMORY_SSH_COMMAND` ([host README](../../../ops/kin/host/README.md#memory-repo-access)), so agents never see the owner's `gh` login (lead spec, security notes).
- The providers' CLIs (Claude Code, Codex) installed for the `kin` user and signed in to the owner's plans.
- As `kin`: clone `GLDRoger/t3code` to `~/t3code`, `git switch kin`, `cp .env.example .env` (it holds the production relay URL), then `ops/kin/host/update.sh`, which makes the first build.
- `sudo ops/kin/host/setup.sh` creates the user, turns on linger, masks sleep, installs and enables the units, and prints a pass/fail checklist of everything above. It is safe to re-run, and `--dry-run` shows every action. Steps: [`ops/kin/host/README.md`](../../../ops/kin/host/README.md).

**Run:**

- The upstream background service installs upstream releases and does not apply to source builds (`docs/user/install.md`). Kin ships its own systemd user unit, [`ops/kin/host/kin-server.service`](../../../ops/kin/host/kin-server.service), which runs `serve --base-dir ~/.t3` from `~/kin-current` with `KIN_ENABLED=true`, under the Node version in the build's `engines.node`. Owner overrides go in `~/.t3/service.env`; the unit reads it first, so it can't change the build, `PATH` or Node.
- `loginctl enable-linger kin` makes the unit start at boot without anyone logging in.
- Update with `ops/kin/host/update.sh` as `kin`. Rebuilding the running checkout in place breaks the live server (the build cleans `dist`, which the server lazy-loads from) and a failed build leaves nothing to boot. So each update builds in its own worktree, `~/kin-builds/<sha>`: `vp i`, the server's contract tests, `vp run build:desktop`. Only then does `~/kin-current` switch to it and the unit restart. The last 3 builds stay for rollback.

**Link the laptop and phone:**

- On the host, as `kin`, run `node ~/kin-current/apps/server/dist/bin.mjs connect link --base-dir ~/.t3 --headless`, approve the code from any device, then `systemctl --user restart kin-server`. Don't use `up --connect`: on Linux with systemd it installs the upstream background service (it downloads the matching upstream release and writes `t3.service`), which would be a second server on kin's state. `connect link` only authorizes the environment.
- Turn on **Hold webhooks while offline**.
- On the laptop (T3 desktop) and phone (Kin mobile), sign in to the same T3 Connect account and pick the host.
- On the home network or tailnet, set `T3CODE_LAN=true` in `~/.t3/service.env`, `systemctl --user restart kin-server`, then pair a client with `node ~/kin-current/apps/server/dist/bin.mjs pair --base-dir ~/.t3`. That gives a direct route. Don't use `up --lan`: like `up --connect`, it installs the upstream service. Clients learn LAN and tailnet routes and prefer them (`docs/internals/remote.md`). The account allows 3 machines.
- To let the laptop's agents hand work to the host, use a peer link (Linked environments beta, `t3_environment_link`).

**Keep it up:**

- Turn off suspend: `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`.
- Turn on restart after power loss in the firmware settings if the machine has it. If the disk asks for a passphrase at boot, someone must unlock it after a power cut; a UPS makes that rare, and missed triggers run when it's back.
- Unattended security updates are fine; reboot by hand.

**If the host becomes the Kin host:** use a LaunchAgent instead of the systemd unit (`launchctl bootstrap gui/$(id -u)`), `sudo pmset -a sleep 0 disksleep 0 womp 1 autorestart 1 powernap 0`, and automatic login for the `kin` user, because a LaunchAgent runs only while its user is logged in. FileVault conflicts with automatic login: keep FileVault on and use `sudo fdesetup authrestart` for planned restarts.

**Backups:**

- Memory is in GitHub, the source of truth.
- Kin's own state: [`ops/kin/host/backup.sh`](../../../ops/kin/host/backup.sh), run nightly by `kin-backup.timer` as `kin`, writes `kin-<date>/userdata/` and `kin-<date>/service.env` and keeps 14 days. `userdata` is copied whole, so `environment-id`, `secrets/` and attachments come back, except logs and files the server rebuilds; `statev2.sqlite` comes from `sqlite3 .backup`, a consistent snapshot of the live database. It holds chats, trigger tables and T3's `webhook_secret` column in plain text, so the script refuses a destination on kin's own disk or the root filesystem, and one that isn't on LUKS/dm-crypt unless passed `--i-know-dest-is-encrypted`.
- Time Machine to an encrypted disk, excluding `~/.t3/worktrees`.
- After a restore ([`ops/kin/host/restore.md`](../../../ops/kin/host/restore.md)), `trigger_reconcile` rebuilds triggers from memory.

## Files

**New:**

- `packages/contracts/src/kinTriggers.ts`
- `apps/server/src/kin/triggers/KinTriggerStore.ts`, `KinTriggerScheduler.ts`, `KinTriggerService.ts`, `KinTriggerSink.ts`, `KinTriggerInbox.ts`
- `apps/server/src/kin/triggers/githubWebhooks.ts`, `githubEvents.ts`, `deferrals.ts`, `deferralFlow.ts`, `deferralGithub.ts`, `routines.ts`, `watchdogs.ts`, `pings.ts`, `ownerCheck.ts`
- `apps/server/src/kin/memory/freshness.ts`, `buildIndex.ts`, `secretScan.ts`, `purge.ts`
- `apps/server/src/kin/dreaming/DreamRunner.ts`, `DreamSession.ts`, `material.ts`, `checkDream.ts`, `classifyDream.ts`
- `apps/server/src/kin/contract/*.kin-contract.test.ts`, `apps/mobile/src/features/chats/contract/mcpAppWebView.kin-contract.test.ts`
- `ops/kin/host/kin-server.service`, `ops/kin/host/setup.sh` (user, linger, suspend off, and checks), `ops/kin/host/backup.sh` with `kin-backup.service`/`.timer`, `ops/kin/host/update.sh`, `ops/kin/host/restore.md`, `ops/kin/host/README.md`
- In `GLDRoger/kin-memory`: `CODEOWNERS`, `.github/workflows/memory-check.yml`

**Upstream files touched:**

- `apps/server/src/orchestration-v2/runtimeLayer.ts`, inside `layerScheduledTaskProvided`'s `Layer.mergeAll(...)`: replace the `layerThreadLaunchProvided,` and `layerThreadManagementProvided,` entries with `KinTriggerSink.wrapTaskDispatch(layerThreadLaunchProvided, layerThreadManagementProvided),`. Add the `KinTriggerSink` namespace import in the same file: one import plus one replacement call for the two dependency entries. Only `ScheduledTaskService` sees the wrapper. Effect memoises `layerThreadLaunchProvided` by reference, so the rest of the server keeps the same instance.
- Kin's server layer and migration list: added by CHAT-2 and CHAT-6. This spec adds no new upstream hook for them.
- `apps/mobile/src/features/threads/McpAppWebView.tsx`: `export` on `function outerDocument`, so the TRIG-19 contract test can run the outer document's script. The test mirrors the WebView's `onMessage` secret check rather than exporting it, keeping the hook to one line.
- `KIN.md` sync steps (Kin's own file): add the two `kin-contract` commands after `vp run check:changed`.

## Interfaces to other specs

- **LEAD:**
  - consumes `kin_trigger_inbox` (`KinTriggerFired`) into the per-org queue and merges a window into one `KinEvent`;
  - applies the late-policy table;
  - runs dream-mode sessions;
  - provides the front-matter cache (`syncItem` callback), `lastReadAt`, the `Memory` git writer (calls `secretScan.scan`), the budget priority (owner message > due deferral > chase > dream) and the stop switch;
  - provides the `kin_defer` tool.
- **CHAT:** `KinOrgId`; delivering messages and pings; `KinWidget` payloads `KinDeferralCard`, `KinHeadsUpCard`, `KinOwnerCheckCard`, `KinDreamReviewCard`; the chat message store for dream material; verified authors for trust checks.
- **APPR:**
  - action kinds `github.app_hook.configure`, `memory.dream_review`, `memory_purge`, `kin.secret_allow`;
  - the standing `dream:auto` delegation;
  - the executor merging at a bound SHA;
  - `KinAuditEntry`;
  - the GitHub App `botLogin`, used by the webhook filter.
- **MOB:** renders the cards above; settings for routine times, quiet hours and timezone.

## Security notes

- **Webhooks.** Every Kin webhook task requires the HMAC signature, and the URL token is the second factor. A missing secret is a setup error, not "token only". Payload text is untrusted (`trust: external`) and is quoted into briefs, never obeyed. The bot-sender filter stops Kin reacting to itself.
- **Relay hold.** With hold on, request bodies, including private PR text, sit on T3 Connect's relay (operated by upstream) for up to 24 h. The owner chooses; the setup screen says so.
- **Lead and worker sessions must not have T3's `schedule_task` tools.** Otherwise a prompt injection could create a recurring agent run with full prompts. LEAD must disable the orchestrator scheduling tools for Kin threads, or Kin must refuse tasks whose `creationSource` is `mcp` in Kin projects. See Open questions.
- **Secrets.** The webhook secret is passed to `upsert` and, once APPR-9 lands, to the `github.app_hook.configure` action as `Redacted`; it is never logged. While that action is gated, the owner's secret arrives only through the owner-only `setSecret` RPC. T3 stores it in SQLite as plain text, so backups are encrypted.
- **Auto-merge.** It is bounded twice: Kin's classifier and executor path check, then GitHub `CODEOWNERS` with code-owner review.

## Tests and acceptance criteria

- `cd apps/server && vp test run src/kin/triggers src/kin/memory src/kin/dreaming` passes. Use `TestClock`; no sleeps (`docs/internals/testing.md`).
- **Scheduler:** a deferral due 09:00 +05:30 fires once at 09:00. Two ticks at the same instant give one inbox row. Advancing the clock 10 h with the scheduler stopped, then starting it, gives one inbox fire with `lateByMs = 10 h`; the deferral consumer (TRIG-8) posts the "This was due at 9:00" card. Recurring downtime emits one stored slot, not every missed occurrence.
- **Timezone:** with the server zone `UTC` and the org zone `Asia/Kolkata`, the dream fires at 21:30 UTC. A 09:00 routine in `America/New_York` stays at 09:00 across both DST transitions; weekdays are owner-local. Two orgs with different zones fire independently; changing one org's zone or routine times recomputes only its schedules.
- **Sink:** a signed GitHub `pull_request` request through the real `ScheduledTaskService` gives exactly one inbox row and no thread launch. A replay gives `duplicate` and no new row. A bot-sender request gives `filtered`. A non-Kin task still launches normally.
- **Deferral:** unchanged recheck, then heads-up, then silence, then `started` at due. A linked issue closed before due leads to `asked`, and nothing starts. With the stop switch on, it asks. [Monday] re-arms to next Monday 09:00. A `due` fire consumed two hours late asks; a queued fire for a disarmed or moved deferral is dropped.
- **Dream:** a dream touching `rules.md` fails, and `main` is unchanged. A dream with one journal fold and one `decisions/` change opens two PRs, and only the auto one merges.
- **Secret scan:** a journal line holding `ghp_` plus 36 characters blocks the entire commit, and the owner gets one typed notification without the value.
- **Purge:** on a fixture repo, the file is gone from `git log --all -p` and the recloned checkout, a tombstone exists and parses, and the returned audit input carries the old and new heads. A surviving secret fails closed before the push. A push that lands and then errors, crashes or is interrupted never republishes the old history through the next wake-up, a dream branch or a checkout cloned during the push, and `reconcile` reports `done` with a `refs/pull/*` ref still holding it. A `refs/notes/*` ref fails the purge at the clone and makes `reconcile` answer `unknown`; a wake-up that staged before the purge can't commit after it; a look-alike tombstone makes `reconcile` answer `not_done`.
- **Contract tests:** `vp test run kin-contract` passes on today's upstream. Renaming `scheduledTaskId` in a scratch branch makes it fail.

## Tasks

**TRIG-4 constraints.** A Kin source task bound to a thread fails each delivery with `OrchestratorCommandRejectedError`; unbind it to resume. TRIG-4 is where Kin persistence first joins boot; CHAT-6/7's boot containment must cover it.

| Id      | What                                                                                                           | Files                                                               | Depends on                                                                                          | Done when                                                                                                                                                                                                                | Owner   |
| ------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| TRIG-1  | Trigger contracts                                                                                              | `kinTriggers.ts`                                                    | CHAT-1                                                                                              | `vp run typecheck` passes; schema round-trip test                                                                                                                                                                        | backend |
| TRIG-2  | Trigger tables and store                                                                                       | `KinTriggerStore.ts`, `KinTriggerInbox.ts`, Kin migrations          | TRIG-1, CHAT-2 (Kin migration list)                                                                 | store tests: idempotent `put`, `orgId` on every row                                                                                                                                                                      | backend |
| TRIG-3  | `KinTriggerScheduler`: owner zone, firing, lateness                                                            | `KinTriggerScheduler.ts`                                            | TRIG-2                                                                                              | scheduler and timezone tests above pass                                                                                                                                                                                  | backend |
| TRIG-4  | `KinTriggerSink` and the runtime-layer hook                                                                    | `KinTriggerSink.ts`, `runtimeLayer.ts` (1 line)                     | TRIG-2                                                                                              | sink tests pass; non-Kin tasks unchanged (existing `ScheduledTaskService*.test.ts` green)                                                                                                                                | backend |
| TRIG-5  | GitHub App webhook source: setup, secret, rotate, remove, inbox thread; App hook via executor (gated)          | `githubWebhooks.ts`, `webhookRpcHandlers.ts`                        | TRIG-4; APPR-9 opens the gate                                                                       | test against a fake GitHub App creates a task with signature, replay key and filters; a null URL posts the T3 Connect message                                                                                            | backend |
| TRIG-6  | GitHub event consumer and conditions                                                                           | `githubEvents.ts`                                                   | TRIG-5, LEAD-4                                                                                      | delivery turns into a `KinGithubEvent`; a trimmed delivery falls back to `github_recheck`; a condition on #212 matches a merge                                                                                           | backend |
| TRIG-7  | Deferral arming from memory (including items written by `kin_defer`), and the confirm card                     | `KinTriggerService.ts`, `deferrals.ts`                              | TRIG-3, LEAD-2, LEAD-7 (`kin_defer`), CHAT-7                                                        | editing `due` in an item re-arms; `status: done` disarms                                                                                                                                                                 | backend |
| TRIG-8  | Deferral due flow: recheck, heads-up, grace, start/ask/remind/chase, late                                      | `deferrals.ts`                                                      | TRIG-7, TRIG-11, LEAD-8, LEAD-9, LEAD-11                                                            | the deferral tests above pass                                                                                                                                                                                            | backend |
| TRIG-9  | Routines: brief, summary, owner check                                                                          | `routines.ts`, `ownerCheck.ts`                                      | TRIG-3, TRIG-12                                                                                     | at 08:30 owner time a brief is posted; late after 18:30 it folds into the summary; the owner check picks 5 by the stated order                                                                                           | backend |
| TRIG-10 | Watchdogs                                                                                                      | `watchdogs.ts`                                                      | TRIG-3, TRIG-6, TRIG-11                                                                             | closing a linked issue on a fake GitHub queues a code-only `watchdog` event naming the commitment and the closed issue as evidence, so the lead marks it done; a paused T3 task sets `paused_in_t3` and isn't re-enabled | backend |
| TRIG-11 | Ping ledger, batching, quiet hours, escalation                                                                 | `pings.ts`                                                          | TRIG-2, CHAT-7                                                                                      | two pings for one item on one day send one; a ping in quiet hours waits; day 2 escalates once                                                                                                                            | backend |
| TRIG-12 | Freshness defaults and code-built `INDEX.md`                                                                   | `freshness.ts`, `buildIndex.ts`                                     | LEAD-2                                                                                              | golden-file test: ≤ 200 lines, As-of line, overdue flagged, 8-week-unread left out                                                                                                                                       | backend |
| TRIG-13 | Dream runner: material, branch, dream session, checks                                                          | `DreamRunner.ts`, `DreamSession.ts`, `material.ts`, `checkDream.ts` | TRIG-12, TRIG-16, LEAD-5, LEAD-6                                                                    | fixture dream produces a branch and `dream.json`; `rules.md` edit fails it                                                                                                                                               | backend |
| TRIG-14 | Dream split, auto-merge under delegation, review card, rejections; full weekly variant                         | `classifyDream.ts`, `DreamRunner.ts`                                | TRIG-13, APPR-4; auto-merge waits for APPR-12 (phase 3), and until then the owner approves both PRs | the two-PR test passes; a rejected item is not proposed again                                                                                                                                                            | backend |
| TRIG-15 | Memory repo guard rails                                                                                        | `kin-memory`: `CODEOWNERS`, `memory-check.yml`, ruleset             | APPR-11                                                                                             | a PR touching `decisions/` can't merge without owner review; a planted token fails the check                                                                                                                             | backend |
| TRIG-16 | Secret scanner, writer hook, allowlist                                                                         | `secretScan.ts`                                                     | LEAD-3                                                                                              | rule fixtures (one hit and one near-miss per rule) pass; commit refusal and typed owner notification tested                                                                                                              | backend |
| TRIG-17 | Owner-signed purge                                                                                             | `purge.ts`                                                          | TRIG-16, APPR-9, APPR-10, LEAD-11                                                                   | purge test passes on a fixture repo; `git-filter-repo` provenance noted in the PR                                                                                                                                        | backend |
| TRIG-18 | Server contract tests: triggers, relay, `delegate_task`, managed policy                                        | `apps/server/src/kin/contract/*`                                    | TRIG-4                                                                                              | `cd apps/server && vp test run kin-contract` passes                                                                                                                                                                      | backend |
| TRIG-19 | `McpAppWebView` contract test                                                                                  | `apps/mobile/src/features/chats/contract/*`                         | —                                                                                                   | `cd apps/mobile && vp test run kin-contract` passes                                                                                                                                                                      | UI      |
| TRIG-20 | Kin host setup: systemd unit, `kin` user, `setup.sh`, `backup.sh`, verify source-build `up --connect` and hold | `ops/kin/host/*`                                                    | —                                                                                                   | after a reboot, the server is reachable from the phone over T3 Connect; a GitHub redelivery while it's stopped arrives on start; a restore drill from backup works                                                       | backend |

## Design corrections

1. **T3 scheduled tasks can't call server code.** Every run launches or posts to an agent thread (`runTask` → `ThreadLaunchService.launch` / `sendToThread`). Kin receives webhooks through a one-line layer wrapper and runs its own time triggers on `Scheduler`. "Deferrals on `once`" means Kin's `once`, with T3's schedule math.
2. **`fixed_time` uses the server's timezone**, with no per-task zone (`localNow`). Kin computes routines in each org's zone.
3. **T3 drops a `fixed_time` run that is more than 10 minutes late** (`isMissedFixedTimeRun`). Only `once` runs on wake-up. A crash mid-run can lose a T3 `once`. Kin's table never drops a fire and applies a late policy per kind.
4. **The relay's offline hold is opt-in and capped.** It is off by default; when on, it holds up to 24 h, 1 000 requests and 50 MB, and 100 per hook. Bodies are stored on upstream's relay. A public hook URL needs T3 Connect. Beyond the hold, events are lost, so `github_recheck` is the real guarantee.
5. **Webhook coalescing keeps only the latest payload**, so it can't be used for "20 events → one session" across PRs. LEAD's merge window does that. T3 also caps 60 per task per minute and 20 queued.
6. **The delivery log keeps 50 deliveries per task, with bodies cut at 64 KB**, and prompt values are framed and mention-broken. Kin reads the delivery record, not the prompt, and treats every webhook as a hint to re-read GitHub.
7. **Housekeeping auto-merge is a merge**, which section 9.1 makes privileged. It needs a standing owner-signed delegation scoped to the memory repo, label and paths.
8. **Heads-up timing.** Section 6 reads as heads-up at due, then start 30 minutes later. This spec sends the heads-up 30 minutes before due and starts at due, so "I'll start at 9:00" holds. A late wake-up gives a 30-minute grace from wake.
9. **`INDEX.md` and its 36-hour rebuild are code**, not a lead session: cheaper, deterministic, and testable.
10. **A purge can't remove what GitHub keeps** for PRs (`refs/pull/*`, cached diffs) or copies elsewhere. Rotation is the fix for leaked credentials; the purge cleans the repo.
11. **The upstream background service doesn't run a source build**, and on macOS it runs only while the user is logged in. The fork needs its own LaunchAgent and automatic login.

## Open questions

- **Fencing T3's scheduling tools.** Can `McpToolAccess` remove `schedule_task` for specific threads, or does Kin need a check on `creationSource: "mcp"` in Kin projects? Decide with LEAD.
- **Owner-check day.** Should the weekly owner check move to the owner's quietest weekday, learned from activity?
- **Dream schedule per org.** Should one Kin host serving several orgs space their dreams, for example 15 minutes apart, so they don't compete for plan headroom?
