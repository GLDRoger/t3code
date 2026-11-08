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

- **Webhooks use T3's scheduled tasks**, because the relay only forwards to `/api/hooks/:hookId/:token`, and signature, replay, filters, the offline hold and the delivery log all live there. Kin owns one unbound T3 webhook task per (org, repo).
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
- `kin_webhook_sources` stores the `KinWebhookSource` fields, keyed by `(org_id, source_id)`, unique by `(org_id, repo)` and by `scheduled_task_id` for the sink lookup. Task and thread IDs have no upstream foreign keys. `kin_trigger_settings` stores one `KinTriggerSettings` per org, including `quiet_hours_json`.
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
| Deferral `due`      | Run the due flow with "This was due at 9:00"; the grace starts from now.                                                            |
| Reminder, follow-up | Deliver with "This was due at …". Pings respect quiet hours.                                                                        |
| Morning brief       | Post if before the evening summary time; otherwise fold into the evening summary.                                                   |
| Evening summary     | Post if before the next dream; otherwise fold into the next morning brief.                                                          |
| Dream, full rebuild | Run if before 08:00 owner time; otherwise skip, because the next dream reads everything since the last good dream. Nothing is lost. |
| Owner check         | Run on wake-up at any time, lowest priority.                                                                                        |
| Watchdog            | Run once now; no backfill.                                                                                                          |

**Wake-up after the machine was off.** The first tick after startup sees every overdue row at once. It fires all of them in `next_run_at` order. The consumer then groups same-org fires into one wake-up (LEAD's merge window) with one line: "I was offline from 02:10 to 07:40. Catching up: 1 deferral, morning brief." `trigger_reconcile` also runs at startup (below).

### GitHub webhooks

**Creating a source** (`KinWebhookSources.add(orgId, repo)`):

1. Generate a 32-byte secret with `SecureRandom`.
2. Create the org's inbox thread once. It is a real thread, launched with `ThreadLaunchService.launch` without a message, then archived and stored as `inboxThreadId`. The inbox thread is never an agent thread and is never registered in `kin_agent_threads`. The sink can read an archived inbox projection without posting a message to it.
3. Call `ScheduledTaskService.upsert`. Kin holds the secret only for this call:

```ts
{ title: `Kin · GitHub · ${repo}`, prompt: KIN_SINK_PROMPT, enabled: true, projectId: org.projectId,
  threadId: null, threadMode: "new_thread", workspaceStrategy: { type: "root" },
  modelSelection: <project default>, runtimeMode: "approval-required", interactionMode: "plan",
  createdBy: "system", creationSource: "server", commandId: `kin:webhook:${orgId}:${repo}`,
  schedule: { type: "webhook",
    signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=", secret },
    maxDeliveryAgeMinutes: null,            // run held requests too; the consumer re-reads state
    dedupe: { replayKey: "{{headers.x-github-delivery}}" },   // no coalesceKey, see below
    filters: [
      { path: "headers.x-github-event", op: "in", value: [ "pull_request", "pull_request_review",
        "pull_request_review_comment", "issue_comment", "issues", "check_suite", "workflow_run",
        "push" ] },
      { path: "body.sender.login", op: "notEquals", value: org.botLogin },  // no loops
    ] } }
```

4. Create the hook on GitHub: `POST /repos/{owner}/{repo}/hooks` with the returned `task.webhook.url`, the secret, `content_type: json` and the same events. This needs `admin:repo_hook`, so it is a privileged action: `request_action({ kind: "github.repo_hook.create", target: repo })` (APPR), and the executor runs it. The secret goes from Kin's create step to the executor through the pending action's sealed payload, never through a model or a chat message. **Fallback:** the setup screen shows the URL, and the owner pastes it in GitHub with a secret they paste into a `request_secret` card.
5. If `task.webhook.url` is null, T3 Connect is off. Kin posts "GitHub events need T3 Connect on the Kin host" and stops.

`KIN_SINK_PROMPT` = "Kin trigger. If you are reading this, Kin's trigger sink is not installed. Do nothing and stop." Plan mode plus approval-required keeps an accidental run harmless.

**Why no coalescing.** T3 coalescing keeps only the latest payload, so two PRs in one window would lose one. LEAD's per-org merge window does the batching without dropping events. Rotation: `rotateWebhookToken`, then update the GitHub hook URL through the same executor action.

**Receiving: `KinTriggerSink`.** It wraps the `ThreadLaunchService` and `ThreadManagementService` given only to `ScheduledTaskService`:

```ts
launch: (input) => {
  const taskId = input.initialMessage?.scheduledTaskId;
  const source = taskId && sources.byTaskId(taskId);          // SQL, kin_webhook_sources
  if (!source) return inner.launch(input);                    // not Kin's: unchanged
  const deliveryId = parseDelivery(input.commandId, taskId);  // suffix after `${taskId}:webhook:`
  if (deliveryId === null) return Effect.fail(launchError(input, "dispatch-message"));
  return inbox.put({ fireId: `gh:${source.orgId}:${deliveryId}`, ... })   // ON CONFLICT (org_id, fire_id) DO NOTHING
    .pipe(Effect.andThen(threads.getThreadProjection(source.inboxThreadId)),
          Effect.map((projection) => ({ threadId: source.inboxThreadId, projection, resumed: false })));
}
```

A registered Kin task never falls through to a real launch. The wrapper is local to scheduled tasks and is given the existing thread-management layer explicitly; other callers retain the original launch and thread-management services. Bound Kin sends and failed source lookups are rejected before dispatch; ordinary sends pass through. If parsing, source validation or inbox persistence fails, the launch fails, and T3 logs `dispatch_failed` in Deliveries.

`KinTriggerStore.registerSource` requires an existing org and an unbound `new_thread` webhook task. `getThreadProjection` checks that the inbox thread is not deleted and its project matches the task's project. Identical registration returns the stored source; conflicting identity fails. TRIG-5 must retain this unbound task shape on edits and disable/delete the upstream task before unregistering its source. Sources have no upstream org column: the `kin_webhook_sources` row establishes ownership; registration rejects task or inbox IDs already owned by another org.

The sink verifies the delivery-log row belongs to the scheduled task. `dueAt` is the log's `received_at`, `firedAt` comes from `Clock`, and `lateByMs` is their nonnegative difference. `KinTriggerFired` carries only T3's delivery-log id, not GitHub's delivery header; TRIG-6 reads `x-github-delivery` through `getWebhookDelivery` as described below. No contract change or payload parsing is needed here.

**Consuming (Kin layer, outside the cycle).**

1. For each `github` inbox row, call `ScheduledTaskService.getWebhookDelivery({ id, deliveryId, acceptAnyOutcome: true })`.
2. Build a `KinGithubEvent` from `headers["x-github-event"]`, `x-github-delivery` and the parsed body. `heldByRelay` is true when the delivery id starts with `delivery:relay:`.
3. The event is a hint. The lead re-reads the PR, issue or run from GitHub before acting, because a held request can be 24 h old, a body over 64 KB is truncated, and the log keeps only 50 deliveries. If the delivery is gone, or `bodyTruncated` is set and the payload can't be parsed, emit a `github_recheck` for that repo instead.
4. Hand the event to the LEAD queue. Payload text is untrusted (section 9.4): `trust: external`, quoted, never obeyed.

**Conditions** ("when #212 merges"): no extra T3 task. A condition is a memory item with `on: { event: "pull_request", action: "closed", merged: true, number: 212 }`. The consumer matches it against each `KinGithubEvent`, and `github_recheck` matches it against state.

**Missed while off.** The Kin host should be on, so outages are short:

- **Hold on (recommended):** GitHub's request reaches the relay, the relay holds it up to 24 h, and `HeldHooksWaker` delivers it on reconnect. Replay keys stop doubles.
- **Hold off, or longer than 24 h:** GitHub gets a 530 or 502 and does not retry by itself. `github_recheck` runs at startup and every 10 minutes, compares memory with GitHub state, and finds what changed.

Webhooks are a fast path; the sweep is the guarantee.

### Deferrals on `once`

Arming comes from memory. When the front-matter cache (LEAD) sees a `deferrals/*.md` item with `status: open` and a `due`, `KinTriggerService.syncItem(item)` upserts its triggers and records a recheck snapshot. The snapshot holds linked issue/PR state, assignees, linked PRs, and the item's `recorded_at`/`superseded_by`. The triggers per `on_due` value:

| `on_due` | Triggers armed (owner time from `due`)   | At due                         |
| -------- | ---------------------------------------- | ------------------------------ |
| `start`  | `heads_up` at due − 30 min, `due` at due | recheck, then start work       |
| `remind` | `due` only                               | post reminder                  |
| `ask`    | `due` only                               | post a decision card           |
| `chase`  | `due` only                               | ping the promiser (ping rules) |

Item edits move or disarm the triggers: a new `due` re-arms; `status` other than `open` or a set `invalid_at` disables them. A due time already past at save fires at once, marked late; no "pick a future time" error.

**Confirm.** When the lead calls `kin_defer` (LEAD), Kin writes the item, arms the triggers, and the lead posts a `KinDeferralCard` widget (CHAT envelope): "Deferred to Fri 13 Nov, 9:00. I'll start then." [Change] [Just remind me]. [Just remind me] sets `on_due: remind`, and the triggers re-arm.

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

- **The recheck is code.** It runs `gh api` reads for every GitHub link plus a read of the memory item. Any difference from the snapshot means "changed": an issue closed, an assignee added, another linked PR, or the item superseded. The ask then names what changed.
- **Late.** If the machine woke after `due`, the `heads_up` fire is skipped. The `due` fire posts the same card with "This was due at 9:00" and a 30-minute grace from now; silence still means go.
- **Level and stop switch.** Below L2, or with the org's stop switch on, `start` becomes `ask`. Silence never starts work then.
- **Idempotent start.** Starting is a Work-class action keyed by `fireId`, so a replay can't start two workers.
- **Bring it up early.** When a message touches the topic before the due time, the lead mentions it (LEAD, using the cache). The Monday morning brief lists deferrals due this week.

**Follow-ups.** A ping with no answer creates a follow-up trigger (`followup`, `once`, next working morning at the owner's brief time). That is the "follow-up = a deferral created by a ping" row of section 6.

### Pings

`kin_ping_ledger(org_id, person, item_id, day)` carries a unique key, so a person is pinged at most once per item per owner day. Pings to one person within one sweep are batched into one message. Quiet hours come from `people/<handle>.md` (`tz`, `quiet_hours`) or the org default; a ping due in quiet hours waits for its end. Every ping names a next step. A second day without an answer escalates once to the owner's **Waiting on you**. Delivery goes through the chat service (CHAT).

### Routines (`fixed_time` in the owner's zone)

The dream consumer suppresses a `dream` fire whose `dueAt`, in owner time, falls on `fullRebuildWeekday`.

| Routine           | Does                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `morning_brief`   | Posts `kin_prepared_briefs` for today (prepared by the dream), refreshed with events since 03:00. If no dream ran, the lead builds one live. On Mondays, adds deferrals and commitments due this week.                                                                                                                                |
| `evening_summary` | What was decided, merged, deferred and promised today, plus tomorrow's due items.                                                                                                                                                                                                                                                     |
| `dream`           | The dreaming pipeline below, lowest budget priority.                                                                                                                                                                                                                                                                                  |
| `dream_full`      | The same pipeline over all items, not just new material.                                                                                                                                                                                                                                                                              |
| `owner_check`     | Code picks 5 items: past `review_by`, flagged misleading, low-trust claims older than 30 days, and evidence-free status claims, in that order. It posts a native card with Keep (push `review_by` out one period), Update (opens the direct chat on the item) and Drop (set `invalid_at` now). Taps are owner-authored memory writes. |

### Watchdogs (`interval`)

All are plain code. They write memory only through the LEAD queue as code-only events, which keeps one writer per org (gap 1).

| Watchdog            | Every                  | Does                                                                                                                                                                                                                                                                                  |
| ------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github_recheck`    | 10 min, and at startup | For open items with GitHub links: a closed issue marks its commitment done, a merged PR closes its deferral, and the evidence link is recorded. Matches conditions. Batches GraphQL reads per repo.                                                                                   |
| `stale_review`      | 30 min                 | PRs with a review requested over 24 h ago: chase the reviewer (ping rules).                                                                                                                                                                                                           |
| `promise_overdue`   | 30 min                 | Open commitments past `due`: chase whoever promised.                                                                                                                                                                                                                                  |
| `objective_at_risk` | 6 h                    | Milestone due within 3 days with open linked issues: flag to the owner.                                                                                                                                                                                                               |
| `index_freshness`   | 1 h                    | `INDEX.md` "As of" older than 36 h: rebuild it (code, below).                                                                                                                                                                                                                         |
| `trigger_reconcile` | 15 min, and at startup | Every open deferral has armed triggers; every routine exists. Every `KinWebhookSource` task exists, is enabled and isn't `blockedByPolicy`; if not, set `status` and tell the owner. It never re-enables a task the owner paused in T3. Clears consumed inbox rows older than 7 days. |

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
2. **Branch.** A worktree of the memory repo on `dream/<YYYY-MM-DD>` from `main`.
3. **Extract and merge** with a cheap model in a lead session in dream mode (LEAD runs it). The model may edit only item files and `journal/`. It also writes `dream.json`, which is not committed: each change with `source` refs into the material, merges, supersessions (`invalid_at`, `superseded_by`) and contradictions. Contradictions go to a stronger model, which proposes a resolution or a question for the owner.
4. **Code checks**, all of which must pass or the dream fails:
   - every changed file parses against the item schema;
   - no deletions;
   - `rules.md` is unchanged;
   - each `source` exists in the material;
   - the secret scan is clean;
   - each change's `trust` matches the material's verified author.
5. **Recheck** evidence and `review_by`, then rebuild `INDEX.md` (code).
6. **Prepare the morning brief** into `kin_prepared_briefs`.
7. **Split and deliver.** Code classifies every changed file:

| Goes to `dream/<date>` (label `dream:auto`, merges itself)                                                                                | Goes to `dream/<date>-review` (label `dream:review`)      |
| ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `journal/**` folding                                                                                                                      | anything in `decisions/`, `people/`, `objectives/`        |
| `INDEX.md`                                                                                                                                | any item whose new content has `trust` other than `owner` |
| status, `invalid_at`, `superseded_by` or `review_by` changes on commitments and deferrals whose evidence link the code verified on GitHub | contradictions and their proposed resolutions             |
| new commitments and deferrals said by the owner (`trust: owner`, source is an owner-authored message)                                     | anything else                                             |

- **Auto PR.** The bot opens it, waits for the memory repo check (below), and merges it with squash. Merging is privileged under section 9.1, so this rests on a standing owner-signed **delegation** (section 9.6, APPR): "Kin may merge PRs labelled `dream:auto` in `<memory repo>` that touch only `journal/**`, `INDEX.md`, `commitments/**`, `deferrals/**`". The executor re-checks the paths at the head SHA before merging.
- **Review PR.** It is based on `main`, and `INDEX.md` is excluded (rebuilt after any merge). It becomes one `KinPendingAction` (`memory.dream_review`) and one **Waiting on you** card: "Last night's memory changes: 3 decisions, 1 person, 2 contradictions" with a per-item list. Approve merges at the bound head SHA with a signed grant (APPR). Reject closes the PR and records each item in `kin_dream_rejections`, so the next dream doesn't propose it again.

8. **Failure.** Any failed step deletes the branch, merges nothing, and posts what went wrong to the owner's direct chat. The next night retries from the same `materialUntil`.

**Memory repo guard rails** (in `kin-memory`, outside this fork):

- A `CODEOWNERS` file with `/rules.md /decisions/ /people/ /objectives/ @<owner>`.
- A ruleset on `main` that requires code-owner review.
- A required check `.github/workflows/memory-check.yml` that runs schema lint and gitleaks.

GitHub then blocks a bad auto-merge even if Kin's classifier is wrong. This forces daytime lead writes onto PRs as well; see Open questions.

### Secret scan before memory commits (gap 5)

`secretScan.ts` exposes `scan(files: ReadonlyArray<{ path; content }>) → Finding[]`. Each finding has `rule`, `path`, `line` and a `fingerprint` (sha256 of the match).

**Rules:**

- GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`);
- Anthropic `sk-ant-`, OpenAI `sk-`/`sk-proj-`;
- AWS `AKIA…`/`ASIA…`;
- Slack `xox[abposr]-`;
- Stripe `sk_live_`/`rk_live_`;
- Google `AIza`;
- PEM `-----BEGIN … PRIVATE KEY-----`;
- JWTs (`eyJ…`, three base64url parts);
- URLs with a password in them (`scheme://user:pass@`);
- `password|secret|token|api_key = <value of ≥ 20 chars and high entropy>`.

**Hooks:**

- LEAD's git writer calls it before every commit.
- The dream runs it before pushing.
- The memory repo CI runs gitleaks as a second, independent check.

**On a finding**, the writer replaces the matched span with `[redacted:<rule>]`, commits the redacted text, and posts to the owner: "I removed what looked like a GitHub token from journal 8 Nov before saving. It is still in chat #tech, message 8812; rotate it." Redacting beats blocking, because blocking would lose the memory write.

**False positives:** the owner adds the fingerprint to `kin_secret_allow` through a signed action. A model can never add to it.

### Owner-signed purge (gap 5)

Pending action `memory.purge` with `{ orgId, repo, paths, mode: "drop_file" | "redact_text", patterns? }`. The owner opens it from an item's menu, or Kin proposes it when the weekly `dream_full` scans full history and finds a secret. Approval uses a native card and a signed grant (APPR). The executor then:

1. Pauses the org's lead queue and takes the memory writer lock.
2. Makes a fresh mirror clone and runs `git filter-repo --invert-paths --path <p>` (`drop_file`) or `--replace-text <rules>` (`redact_text`), then re-runs the scan over all history.
3. Force-pushes the rewritten branches with the owner's credential. This needs the owner as a bypass actor on the memory repo's ruleset. It closes open dream PRs that touch the paths.
4. For `drop_file`, commits a tombstone at the same path: `status: cancelled`, `invalid_at: now`, body "Purged on <date> by the owner (audit <id>)". Memory still shows that something was there.
5. Re-clones every local checkout and worktree of the memory repo, rebuilds the cache and `INDEX.md`, and resumes the queue.
6. Writes a `KinAuditEntry` (APPR) with the grant, device, paths, old head, new head and the refs rewritten.
7. Tells the owner what a purge can't reach: GitHub keeps `refs/pull/*` and cached PR diffs (removing those needs a GitHub Support request), forks, local backups (Time Machine), and the chat database. A leaked credential must be rotated whatever happens.

**Dependency:** `git-filter-repo` (git's recommended history rewriter; `brew install git-filter-repo`). Check its licence and release activity when installing (TRIG-17).

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
- A dedicated `kin` user (`sudo useradd -m kin`). The Kin server runs as this user, never as the owner's account. Its only GitHub credential is the GitHub App's, so agents never see the owner's `gh` login (lead spec, security notes).
- The providers' CLIs (Claude Code, Codex) installed for the `kin` user and signed in to the owner's plans.
- As `kin`: clone `GLDRoger/t3code`, `git switch kin`, `cp .env.example .env` (it holds the production relay URL), then `vp i && vp run build:desktop`.

**Run:**

- The upstream background service installs upstream releases and does not apply to source builds (`docs/user/install.md`). Kin ships its own systemd user unit, `ops/kin/host/kin-server.service`: `ExecStart=node <checkout>/apps/server/dist/bin.mjs serve`, `Restart=always`, `WantedBy=default.target`.
- `sudo loginctl enable-linger kin` makes the unit start at boot without anyone logging in. Then, as `kin`, `systemctl --user enable --now kin-server`.
- Update with `git pull && vp i && vp run build:desktop && systemctl --user restart kin-server`, after the contract tests pass.

**Link the laptop and phone:**

- On the host, run `node apps/server/dist/bin.mjs up --connect`; TRIG-20 verifies it doesn't try to install the upstream service. Sign in to T3 Connect; approve the code from any device.
- Turn on **Hold webhooks while offline**.
- On the laptop (T3 desktop) and phone (Kin mobile), sign in to the same T3 Connect account and pick the host.
- On the home network or tailnet, `up --lan` plus `pair` gives a direct route. Clients learn LAN and tailnet routes and prefer them (`docs/internals/remote.md`). The account allows 3 machines.
- To let the laptop's agents hand work to the host, use a peer link (Linked environments beta, `t3_environment_link`).

**Keep it up:**

- Turn off suspend: `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target`.
- Turn on restart after power loss in the firmware settings if the machine has it. If the disk asks for a passphrase at boot, someone must unlock it after a power cut; a UPS makes that rare, and missed triggers run when it's back.
- Unattended security updates are fine; reboot by hand.

**If the host becomes the Kin host:** use a LaunchAgent instead of the systemd unit (`launchctl bootstrap gui/$(id -u)`), `sudo pmset -a sleep 0 disksleep 0 womp 1 autorestart 1 powernap 0`, and automatic login for the `kin` user, because a LaunchAgent runs only while its user is logged in. FileVault conflicts with automatic login: keep FileVault on and use `sudo fdesetup authrestart` for planned restarts.

**Backups:**

- Memory is in GitHub, the source of truth.
- Kin's own DB: a nightly `sqlite3 ~/.t3/userdata/statev2.sqlite ".backup <encrypted volume>/kin-$(date +%F).sqlite"`, keeping 14 days. It holds the trigger tables, chats, and T3's `webhook_secret` column in plain text.
- Also back up `~/.t3/userdata/secrets/` and `~/.t3/service.env` to the same encrypted volume.
- Time Machine to an encrypted disk, excluding `~/.t3/worktrees`.
- After a restore, `trigger_reconcile` rebuilds triggers from memory.

## Files

**New:**

- `packages/contracts/src/kinTriggers.ts`
- `apps/server/src/kin/triggers/KinTriggerStore.ts`, `KinTriggerScheduler.ts`, `KinTriggerService.ts`, `KinTriggerSink.ts`, `KinTriggerInbox.ts`
- `apps/server/src/kin/triggers/githubWebhooks.ts`, `githubEvents.ts`, `deferrals.ts`, `routines.ts`, `watchdogs.ts`, `pings.ts`, `ownerCheck.ts`
- `apps/server/src/kin/memory/freshness.ts`, `buildIndex.ts`, `secretScan.ts`, `purge.ts`
- `apps/server/src/kin/dreaming/DreamRunner.ts`, `classifyDream.ts`
- `apps/server/src/kin/contract/*.kin-contract.test.ts`, `apps/mobile/src/features/chats/contract/mcpAppWebView.kin-contract.test.ts`
- `ops/kin/host/kin-server.service`, `ops/kin/host/setup.sh` (user, linger, suspend off, and checks), `ops/kin/host/backup.sh`
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
  - action kinds `github.repo_hook.create`, `memory.dream_review`, `memory.purge`, `kin.secret_allow`;
  - the standing `dream:auto` delegation;
  - the executor merging at a bound SHA;
  - `KinAuditEntry`;
  - the GitHub App `botLogin`, used by the webhook filter.
- **MOB:** renders the cards above; settings for routine times, quiet hours and timezone.

## Security notes

- **Webhooks.** Every Kin webhook task requires the HMAC signature, and the URL token is the second factor. A missing secret is a setup error, not "token only". Payload text is untrusted (`trust: external`) and is quoted into briefs, never obeyed. The bot-sender filter stops Kin reacting to itself.
- **Relay hold.** With hold on, request bodies, including private PR text, sit on T3 Connect's relay (operated by upstream) for up to 24 h. The owner chooses; the setup screen says so.
- **Lead and worker sessions must not have T3's `schedule_task` tools.** Otherwise a prompt injection could create a recurring agent run with full prompts. LEAD must disable the orchestrator scheduling tools for Kin threads, or Kin must refuse tasks whose `creationSource` is `mcp` in Kin projects. See Open questions.
- **Secrets.** The webhook secret is passed once to `upsert` and to the executor's sealed payload; it is never logged. T3 stores it in SQLite as plain text, so backups are encrypted.
- **Auto-merge.** It is bounded twice: Kin's classifier and executor path check, then GitHub `CODEOWNERS` with code-owner review.

## Tests and acceptance criteria

- `cd apps/server && vp test run src/kin/triggers src/kin/memory src/kin/dreaming` passes. Use `TestClock`; no sleeps (`docs/internals/testing.md`).
- **Scheduler:** a deferral due 09:00 +05:30 fires once at 09:00. Two ticks at the same instant give one inbox row. Advancing the clock 10 h with the scheduler stopped, then starting it, gives one inbox fire with `lateByMs = 10 h`; the deferral consumer (TRIG-8) posts the "This was due at 9:00" card. Recurring downtime emits one stored slot, not every missed occurrence.
- **Timezone:** with the server zone `UTC` and the org zone `Asia/Kolkata`, the dream fires at 21:30 UTC. A 09:00 routine in `America/New_York` stays at 09:00 across both DST transitions; weekdays are owner-local. Two orgs with different zones fire independently; changing one org's zone or routine times recomputes only its schedules.
- **Sink:** a signed GitHub `pull_request` request through the real `ScheduledTaskService` gives exactly one inbox row and no thread launch. A replay gives `duplicate` and no new row. A bot-sender request gives `filtered`. A non-Kin task still launches normally.
- **Deferral:** unchanged recheck, then heads-up, then silence, then `started` at due. A linked issue closed before due leads to `asked`, and nothing starts. With the stop switch on, it asks. [Monday] re-arms to next Monday 09:00.
- **Dream:** a dream touching `rules.md` fails, and `main` is unchanged. A dream with one journal fold and one `decisions/` change opens two PRs, and only the auto one merges.
- **Secret scan:** a journal line holding `ghp_` plus 36 characters is committed as `[redacted:github-token]`, and the owner gets one message.
- **Purge:** on a fixture repo, the file is gone from `git log --all -p`, a tombstone exists, and an audit row exists.
- **Contract tests:** `vp test run kin-contract` passes on today's upstream. Renaming `scheduledTaskId` in a scratch branch makes it fail.

## Tasks

**TRIG-4 constraints.** A Kin source task bound to a thread fails each delivery with `OrchestratorCommandRejectedError`; unbind it to resume. TRIG-4 is where Kin persistence first joins boot; CHAT-6/7's boot containment must cover it.

| Id      | What                                                                                                           | Files                                                      | Depends on                                                                                          | Done when                                                                                                                                                          | Owner   |
| ------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| TRIG-1  | Trigger contracts                                                                                              | `kinTriggers.ts`                                           | CHAT-1                                                                                              | `vp run typecheck` passes; schema round-trip test                                                                                                                  | backend |
| TRIG-2  | Trigger tables and store                                                                                       | `KinTriggerStore.ts`, `KinTriggerInbox.ts`, Kin migrations | TRIG-1, CHAT-2 (Kin migration list)                                                                 | store tests: idempotent `put`, `orgId` on every row                                                                                                                | backend |
| TRIG-3  | `KinTriggerScheduler`: owner zone, firing, lateness                                                            | `KinTriggerScheduler.ts`                                   | TRIG-2                                                                                              | scheduler and timezone tests above pass                                                                                                                            | backend |
| TRIG-4  | `KinTriggerSink` and the runtime-layer hook                                                                    | `KinTriggerSink.ts`, `runtimeLayer.ts` (1 line)            | TRIG-2                                                                                              | sink tests pass; non-Kin tasks unchanged (existing `ScheduledTaskService*.test.ts` green)                                                                          | backend |
| TRIG-5  | GitHub webhook sources: create, rotate, inbox thread, hook via executor                                        | `githubWebhooks.ts`                                        | TRIG-4, APPR-9                                                                                      | test against a fake GitHub creates a task with signature, replay key and filters; a null URL posts the T3 Connect message                                          | backend |
| TRIG-6  | GitHub event consumer and conditions                                                                           | `githubEvents.ts`                                          | TRIG-5, LEAD-4                                                                                      | delivery turns into a `KinGithubEvent`; a trimmed delivery falls back to `github_recheck`; a condition on #212 matches a merge                                     | backend |
| TRIG-7  | Deferral arming from memory, and the confirm card                                                              | `KinTriggerService.ts`, `deferrals.ts`                     | TRIG-3, LEAD-2, LEAD-7 (`kin_defer`), CHAT-7                                                        | editing `due` in an item re-arms; `status: done` disarms                                                                                                           | backend |
| TRIG-8  | Deferral due flow: recheck, heads-up, grace, start/ask/remind/chase, late                                      | `deferrals.ts`                                             | TRIG-7, TRIG-11, LEAD-8, LEAD-9, LEAD-11                                                            | the deferral tests above pass                                                                                                                                      | backend |
| TRIG-9  | Routines: brief, summary, owner check                                                                          | `routines.ts`, `ownerCheck.ts`                             | TRIG-3, TRIG-12                                                                                     | at 08:30 owner time a brief is posted; late after 18:30 it folds into the summary; the owner check picks 5 by the stated order                                     | backend |
| TRIG-10 | Watchdogs                                                                                                      | `watchdogs.ts`                                             | TRIG-3, TRIG-6, TRIG-11                                                                             | closing a linked issue on a fake GitHub marks the commitment done with an evidence link; a paused T3 task sets `paused_in_t3` and isn't re-enabled                 | backend |
| TRIG-11 | Ping ledger, batching, quiet hours, escalation                                                                 | `pings.ts`                                                 | TRIG-2, CHAT-7                                                                                      | two pings for one item on one day send one; a ping in quiet hours waits; day 2 escalates once                                                                      | backend |
| TRIG-12 | Freshness defaults and code-built `INDEX.md`                                                                   | `freshness.ts`, `buildIndex.ts`                            | LEAD-2                                                                                              | golden-file test: ≤ 200 lines, As-of line, overdue flagged, 8-week-unread left out                                                                                 | backend |
| TRIG-13 | Dream runner: material, branch, dream session, checks                                                          | `DreamRunner.ts`                                           | TRIG-12, TRIG-16, LEAD-5, LEAD-6                                                                    | fixture dream produces a branch and `dream.json`; `rules.md` edit fails it                                                                                         | backend |
| TRIG-14 | Dream split, auto-merge under delegation, review card, rejections; full weekly variant                         | `classifyDream.ts`, `DreamRunner.ts`                       | TRIG-13, APPR-4; auto-merge waits for APPR-12 (phase 3), and until then the owner approves both PRs | the two-PR test passes; a rejected item is not proposed again                                                                                                      | backend |
| TRIG-15 | Memory repo guard rails                                                                                        | `kin-memory`: `CODEOWNERS`, `memory-check.yml`, ruleset    | APPR-11                                                                                             | a PR touching `decisions/` can't merge without owner review; a planted token fails the check                                                                       | backend |
| TRIG-16 | Secret scanner, writer hook, allowlist                                                                         | `secretScan.ts`                                            | LEAD-3                                                                                              | rule fixtures (one hit and one near-miss per rule) pass; redaction and owner message tested                                                                        | backend |
| TRIG-17 | Owner-signed purge                                                                                             | `purge.ts`                                                 | TRIG-16, APPR-9, APPR-10                                                                            | purge test passes on a fixture repo; `git-filter-repo` provenance noted in the PR                                                                                  | backend |
| TRIG-18 | Server contract tests: triggers, relay, `delegate_task`, managed policy                                        | `apps/server/src/kin/contract/*`                           | TRIG-4                                                                                              | `cd apps/server && vp test run kin-contract` passes                                                                                                                | backend |
| TRIG-19 | `McpAppWebView` contract test                                                                                  | `apps/mobile/src/features/chats/contract/*`                | —                                                                                                   | `cd apps/mobile && vp test run kin-contract` passes                                                                                                                | UI      |
| TRIG-20 | Kin host setup: systemd unit, `kin` user, `setup.sh`, `backup.sh`, verify source-build `up --connect` and hold | `ops/kin/host/*`                                           | —                                                                                                   | after a reboot, the server is reachable from the phone over T3 Connect; a GitHub redelivery while it's stopped arrives on start; a restore drill from backup works | backend |

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

- **GitHub App webhook vs. per-repo hooks.** One App webhook URL would avoid `admin:repo_hook`, but it shares one T3 task's 60-per-minute limit across all repos and orgs. Decide with APPR.
- **Daytime lead writes.** With the memory repo's `main` requiring PRs (needed for the CODEOWNERS guard), LEAD's daytime writes must land as auto-merged PRs too. Otherwise drop the ruleset and rely on Kin's checks only.
- **Fencing T3's scheduling tools.** Can `McpToolAccess` remove `schedule_task` for specific threads, or does Kin need a check on `creationSource: "mcp"` in Kin projects? Decide with LEAD.
- **Owner-check day.** Should the weekly owner check move to the owner's quietest weekday, learned from activity?
- **Dream schedule per org.** Should one Kin host serving several orgs space their dreams, for example 15 minutes apart, so they don't compete for plan headroom?
