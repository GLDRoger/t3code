# Kin spec: mobile (phase 1)

Status: draft, 7 Nov 2026. Covers DESIGN.md sections 5, 7 and 8 for the phase 1 mobile app. Prefix: MOB.

## Goal

The owner opens Kin on the phone and sees one chat list, with **Waiting on you** as the only highlighted thing. They message their lead in a direct chat. The lead's messages carry native cards: a task card that opens the T3 thread doing the work, an approval card drawn from the server's pending action, and a deferral card with its buttons. The same buttons appear on the notification and the lock screen.

Out of scope for phase 1: groups and the floor manager (phase 2), generated HTML widgets (phase 2), live widgets, Live Activities and the home screen agenda widget (phase 3), the space switcher (phase 5). The biometric prompt and grant signing belong to the approvals spec. This spec only calls them.

## What exists in T3

All paths are under `apps/mobile/src` unless noted. Each was read for this spec.

**Navigation.** The app does not use expo-router. It uses React Navigation 7 static config.

- `Stack.tsx` builds `RootStack` with `createWorkspaceStackNavigator({ screens: { ... } })`. Every page is a `createNativeStackScreen({ screen, linking, options })` entry, with presentation presets from `features/layout/route-options.ts` (`pageRoute`, `sheetRoute`, `modalRoute`). `SETTINGS_SCREENS` is already spread into the screen map, which is the pattern Kin copies.
- `App.tsx` derives deep links from the static config (`createPathConfigForStaticNavigation`), so a screen with a `linking` path is reachable by URL with no further change. It also holds `appServiceDisposers`, the list of app-lifetime installers (`installAgentNotificationNavigation(linkToAppPath)` is one of them).
- The top-level tabs are `NAVIGATION_TAB_ORDER = ["threads", "pullRequests", "usage"]` in `features/layout/workspace/navigation-tab-order.ts`. On iOS, `WORKSPACE_TAB_LABELS` in `navigation-tabs.ts` already relabels `threads` as **"Chats"**.
- `features/layout/useOpenWorkspaceDetail.ts` opens a thread from another page: it selects the detail on Android and pushes `Thread` on iOS. The `Thread` route's path is `threads/:environmentId?/:threadId?`.
- `features/home/HomeScreen.tsx` composes the thread list's header in `v2ListHeader` (line ~728), passed to `LegendList` as `ListHeaderComponent`.

**Thread and composer components.**

- `features/threads/ThreadComposer.tsx` and `features/threads/ThreadFeed.tsx` are tied to T3 threads. Their props require `EnvironmentThreadShell`, `ThreadId`, the thread outbox, and turn state. They can't render a Kin chat.
- `components/ComposerEditor.tsx` is the reusable editor. It is keyed by an arbitrary `draftKey` (`state/use-composer-drafts.ts`, `useComposerDraft(draftKey)`), and draft pruning only removes keys prefixed with an environment id (`removeComposerDraftsForEnvironment`). A `kin:` prefix is safe.
- `native/SelectableMarkdownText.tsx` renders message markdown. `components/RelativeTime.tsx` renders times. `components/ProviderIcon.tsx` draws provider marks.
- `features/threads/PendingApprovalCard.tsx` is T3's provider-approval card. It is the visual reference for Kin's approval card (`rounded-[20px] border border-border bg-card-alt p-4`, uppercase eyebrow, full-width `Button`s with `primary` and `danger` tones). Kin doesn't reuse it: its data is a provider runtime request.
- `features/threads/CustomSnoozeSheet.tsx` is a date and time picker with `onSnooze(snoozedUntil: string)`. Kin reuses it for "Change" on a deferral.
- UI kit in `components/ui/`: `AppText` (`textRole`), `Button` (`tone: primary | secondary | danger | text | contrast`), `EmptyState` (`card | plain`), `ErrorBanner`, `Notice`, `LoadingStrip`, `ListRow`, `Toast`, `Sheet`, `Dialog`.

**Theming.** Uniwind (Tailwind classes) with tokens generated into `generated-uniwind-themes.css`: `bg-screen`, `bg-card`, `bg-card-alt`, `border-border`, `text-foreground`, `text-foreground-secondary`, `text-foreground-muted`, `bg-primary`, `text-primary-foreground`, `bg-secondary`, `text-warning-foreground`, `bg-danger`, `bg-user-bubble`, `text-user-bubble-foreground`. Fonts are DM Sans via `font-sans`, `font-t3-medium` and `font-t3-bold` (`global.css`). Shape and motion constants are in `lib/designTokens.ts` (`MOBILE_SHAPE`, `MOBILE_MOTION`). Kin adds no tokens.

**RPC client.** `packages/client-runtime/src/rpc/protocol.ts` builds the client from `WsRpcGroup` (`packages/contracts/src/rpc.ts`). Mobile wraps calls in environment-scoped atoms from `packages/client-runtime/src/state/runtime.ts`:

- `createEnvironmentRpcQueryAtomFamily(runtime, { label, tag, persistence?, staleTimeMs? })`
- `createEnvironmentRpcSubscriptionAtomFamily(runtime, { label, tag })`
- `createEnvironmentRpcCommand(runtime, { label, tag, concurrency? })`

The runtime is `connectionAtomRuntime` (`connection/runtime.ts`). Screens read atoms with `useEnvironmentQuery` (`state/query.ts`), which returns `{ data, error, isPending, refresh }`. Scheduled tasks are the closest analog (`serverEnvironment.scheduledTasksLive` in `state/server.ts`, used in `features/settings/SettingsScheduledTasksRouteScreen.tsx`). Two typing details matter:

- Stream tags must be listed in the `EnvironmentSubscriptionRpcTag` union in `packages/client-runtime/src/rpc/client.ts`, or the subscription helper won't accept them.
- `persistQuery(schema)` (`packages/client-runtime/src/state/queryPersistence.ts`) caches a query result on the device.

Connection state per environment is an `EnvironmentConnectionPhase`: `available | offline | connecting | reconnecting | connected | error | unsupported` (`packages/client-runtime/src/connection/presentation.ts`), read through `useEnvironments()` (`state/environments.ts`).

**Notifications** (`features/agent-awareness/`).

- `remoteRegistration.ts` gets the native APNs token (`Notifications.getDevicePushTokenAsync`) and registers it with T3's hosted relay (`makeRelayDeviceRegistrationRequest` in `registrationPayload.ts`, including `bundleId` and `apsEnvironment`).
- The server publishes thread-shaped `RelayAgentActivityState` (`environmentId`, `threadId`, `phase`, `headline`, `deepLink`) to the relay from `apps/server/src/relay/AgentAwarenessRelay.ts`. The relay builds the APNs push.
- `notificationNavigation.ts` owns the one global `Notifications.setNotificationHandler` and adds a response listener. `notificationPayload.ts` only routes deep links of the form `/threads/:environmentId/:threadId` and ignores anything else.
- No notification categories or action buttons exist anywhere in the app (`rg setNotificationCategoryAsync` finds nothing). `expo-notifications ~58.1.5` ships `setNotificationCategoryAsync`.

**Widgets for later.**

- `features/threads/McpAppWebView.tsx` exports `ThreadMcpApp`, bound to a thread turn item (`threadId`, `itemId`, `enqueueThreadOutboxMessage`). Its `outerDocument` (exported for the contract test) and its WebView `onMessage` secret check mark whether a real person tapped, which upstream uses only to allow full screen (Design correction 9). The reusable host is `makeMcpAppHost` in `packages/client-runtime/src/mcpApps/host.ts` (`@t3tools/client-runtime/mcp-apps`).
- `features/threads/HtmlRenderWebView.tsx` exports `HtmlRenderWebView({ uri, title, nested })`, which is reusable as is.
- `widgets/` holds `expo-widgets` Live Activities (`AgentActivity.tsx`) and the usage widget. Phase 3 adds the agenda widget and Live Activities there.

**Test and build rules that bind Kin code.** `dependency-graph.test.ts` fails on import cycles, so Kin files must never import `Stack.tsx` or `App.tsx`. `reactCompilerCoverage.test.ts` compiles every file with the React Compiler, so no ref reads during render and no manual memoization. Lint rule `t3code/no-unreasoned-state-sync` requires a reason comment on state-syncing effects. React component tests must be listed in `reactTests` in `apps/mobile/vite.config.ts`. Plain `*.test.ts` files run in the `unit` project.

## Design

### Where Chats goes

All Kin code lives in `apps/mobile/src/features/chats/`. It reaches upstream through three hooks:

1. **Routes.** `Stack.tsx` spreads `...KIN_SCREENS` into the root `screens` map, next to `...SETTINGS_SCREENS`. That is one import and one line. Kin's routes:

| Route         | Linking path                          | Preset                                     | Screen                                            |
| ------------- | ------------------------------------- | ------------------------------------------ | ------------------------------------------------- |
| `KinChats`    | `kin`                                 | `pageRoute({ title: "Kin" })`              | Chat list                                         |
| `KinWaiting`  | `kin/waiting`                         | `pageRoute({ title: "Waiting on you" })`   | Waiting on you                                    |
| `KinChat`     | `kin/:orgId/chats/:chatId`            | `pageRoute({ duoMinimize: "onScrollUp" })` | Direct chat                                       |
| `KinApproval` | `kin/:orgId/actions/:pendingActionId` | `sheetRoute({ detent: 0.75 })`             | Approval detail (also opened from a notification) |

2. **Entry row.** `features/home/HomeScreen.tsx` renders `<KinHomeEntry />` as the first child of `v2ListHeader`. That is one import and one line. The row reads "Kin" with the latest preview, or "Waiting on you · 2" in the highlighted style when anything waits. A tap pushes `KinChats`. It renders nothing when no connected environment hosts a Kin organization, so upstream T3 users see no change.
3. **Notifications.** `App.tsx` adds `installKinNotifications(linkToAppPath),` to `appServiceDisposers`, plus its import.

Why not a fourth workspace tab: it isn't a one-line hook. A `"kin"` tab needs edits in `navigation-tab-order.ts` (order and labels), `navigation-tabs.ts` (icon), `workspace-tabs-state.ts` (`initialWorkspaceTabsState`), `WorkspaceExtraTab.tsx` (render), `WorkspaceToolbar.ios.tsx` (`SEARCH_LABELS`), `workspace-tab-navigation.ts` (the `tab !== "usage"` column rule), and `createWorkspaceStackNavigator.ios.tsx` (its hard-coded tab list), along with their tests. Revisit in phase 3, when Kin is the main surface.

### Which environment hosts Kin

Kin runs on the Kin host, which the phone reaches as an ordinary T3 environment. `useKinHost()` (**new**) picks it this way:

1. Use the environment id saved under Kin's own preference key (`kin.hostEnvironmentId`, via `persistence/mobile-storage.ts`) if it is still in the catalog.
2. Otherwise, use the first `connected` environment whose `kin.orgs.list` call (chat spec) succeeds, and save its id.
3. An environment whose server lacks the Kin RPC answers with an RPC error. Treat that as "no Kin here", not as a failure.

Phase 1 has one organization. `orgId` is carried in every route param and atom input anyway, so the space switcher (phase 5) only changes which `orgId` is passed.

### Client state (`features/chats/state/kinClient.ts`, new)

Atoms are built on `connectionAtomRuntime` with the helpers above. The tags are the chat spec's methods. The names here are placeholders, and the chat spec's names win.

```ts
export const kinClient = {
  orgs: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:orgs",
    tag: KIN_CHAT_WS_METHODS.orgsList,
    staleTimeMs: 60_000,
  }),
  // Chat list plus Waiting on you, as one snapshot-then-deltas stream.
  inbox: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "kin:inbox",
    tag: KIN_CHAT_WS_METHODS.chatsSubscribe,
  }),
  chat: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "kin:chat",
    tag: KIN_CHAT_WS_METHODS.chatSubscribe,
  }),
  history: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "kin:history",
    tag: KIN_CHAT_WS_METHODS.chatHistory,
  }),
  send: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:send",
    tag: KIN_CHAT_WS_METHODS.messagesSend,
  }),
  widgetAction: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:widget-action",
    tag: KIN_CHAT_WS_METHODS.widgetsAct,
    concurrency: { mode: "singleFlight", key: ({ input }) => input.clientActionId },
  }),
  pendingAction: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "kin:pending-action",
    tag: KIN_METHODS.subscribePendingAction, // approvals spec
  }),
  registerPush: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "kin:register-push",
    tag: KIN_PUSH_METHODS.registerDevice,
  }),
};
```

Offline cache: the last inbox snapshot, and the last 50 messages of each opened chat, are saved with `persistQuery(...)` through a query atom that mirrors the stream (the same pattern as `pullRequests.ts` line ~445). On a cold start, the cache renders at once, marked "Offline · last updated 9:41".

### Shapes mobile reads (owned by the chat and approvals specs)

These are the fields mobile needs. If the chat or approvals spec names them differently, theirs win and this list becomes a checklist.

```ts
// chat spec
KinChatSummary = { orgId, chatId, kind: "direct" | "team" | "project" | "router",
  title, members: KinChatMember[], last?: { authorLabel, preview, sentAt },
  unreadCount, waitingCount }
KinChatMember = { memberId, kind: "human" | "agent", displayName, initials,
  role: "owner" | "member" | "guest" }
KinMessage = { orgId, chatId, messageId, seq, author: KinAuthor, sentAt,
  text?: string, widget?: KinWidget, clientMessageId?: string }
KinAuthor = { _tag: "human"; userId; displayName } | { _tag: "agent"; agentId; displayName }
KinWidget = { widgetId, revision, kind: "task" | "approval" | "deferral" | ..., data }
KinWaitingItem = { orgId, chatId, widgetId, kind: "approval" | "deferral" | "decision" | "question",
  title, dueAt?, createdAt }
// viewer context, from the inbox snapshot: { viewerUserId, viewerRole }
// approvals spec
KinPendingAction (view) = { orgId, pendingActionId, kind: "merge" | ..., status:
  "pending" | "approved" | "declined" | "expired" | "stale" | "executed" | "failed",
  repo, prNumber, prTitle, headSha, baseBranch, mergeMethod,
  diff: { files, additions, deletions }, checks: { passed, failed, pending, required: CheckRow[] },
  requestedBy: { agentId, displayName }, startedBy: { userId, displayName, role },
  afterNonOwnerMessage?: { displayName }, approvers: Array<{ userId, displayName }>,
  expiresAt? }
```

Mobile-owned data (**new**, `features/chats/notifications/kinPushPayload.ts`, decoded with Effect Schema):

```ts
export const KinPushData = Schema.Struct({
  kin: Schema.Literal(1),
  orgId: KinOrgId,
  chatId: Schema.String,
  widgetId: Schema.optional(Schema.String),
  revision: Schema.optional(Schema.Number),
  pendingActionId: Schema.optional(Schema.String),
  deepLink: Schema.String, // must match /kin/... ; anything else is dropped
});
```

### Screens and states

Every screen handles the same seven states. Each state's copy is fixed below.

| State                   | Chat list                                                                                         | Direct chat                                                                 | Waiting on you                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Loading (no cache)      | 6 skeleton rows                                                                                   | `LoadingStrip` at the top, no bubbles                                       | 3 skeleton cards                                                       |
| Loaded, cached, offline | Rows plus a `Notice`: "Offline. Last updated 9:41."                                               | Same notice; composer still accepts text, which is queued                   | Same notice; buttons disabled with "Reconnect to answer"               |
| Empty                   | `EmptyState`: "No chats yet" / "Your lead's chat appears here once Kin is set up."                | "Say hello to your lead. It reads every message here."                      | "Nothing is waiting on you." (plain variant)                           |
| No Kin host             | Hidden entry row; deep link shows "Kin isn't set up on this environment" with "Open environments" | Same                                                                        | Same                                                                   |
| Error                   | `ErrorBanner` with the RPC message and Retry (`refresh()`)                                        | Same, above the list                                                        | Same                                                                   |
| Not authorized          | "This device can't read Kin chats. Pair it again from the Mac."                                   | Same                                                                        | Same                                                                   |
| Many items              | `LegendList` with `recycleItems`; chats sorted by waiting first, then `last.sentAt`               | Paged history: 50 per page, "Load earlier" at top, list anchored to the end | Sorted by `dueAt`, then `createdAt`; org label once there are two orgs |

**Chat list (`KinChatsScreen`, new).** Matches the mockup.

- **Waiting on you** sits at the top as one full-width banner: `bg-primary`, `text-primary-foreground`, radius `MOBILE_SHAPE.group`. It names up to two items ("Merge #212 · Pick a caching option") and shows a count. A tap opens `KinWaiting`. With nothing waiting, the banner is not rendered; nothing else in the list is ever highlighted (DESIGN 8.1).
- Each row shows the avatar, title, time (`RelativeTime`), a one-line preview prefixed with the author ("Lead: Payments test fixed"), and an unread count badge.
- **Avatars** (DESIGN 8.7): an agent gets an outlined rounded square (`rounded-[12px]`, 1.5 pt `border-primary`, `text-primary`). A person gets a filled circle (`rounded-full bg-secondary`). Both are 40 pt, with initials. A shared `KinAvatar` component draws both.
- The footer row reads "Ask anything. It goes to the right team." In phase 1 it opens the direct chat with the lead. The router arrives in phase 3.

**Direct chat (`KinChatScreen`, new).**

- The header shows the lead's avatar, its name, and a subtitle of live status from widgets ("Working on 2 tasks"). Status never comes from message text (DESIGN 8.2).
- **Bubbles.** The owner's own messages sit on the right (`bg-user-bubble`). Others sit on the left, with a small author line. Text renders through `SelectableMarkdownText`. Links open through the existing link handling.
- **Folded agent talk** (DESIGN 8.3) renders as one dashed-border line: "QA and Tech lead disagreed on retries. **Settled on a fixed timeout.** 4 messages". A tap expands it. Phase 1 shows it if the server sends it.
- **Composer (`KinComposer`).** It wraps `ComposerEditor` with `draftKey = kin:${orgId}:${chatId}`, plus a send `Button`. The placeholder is "Message Tech lead". There are no model, attachment or slash controls in phase 1.
- **Sending.** Send creates a `clientMessageId` (`lib/uuid.ts`) and shows the bubble at once as "Sending". When the server echoes it on the stream, the bubble settles. If the send fails, the bubble shows "Not sent. Tap to retry". Offline sends wait in a Kin outbox (`features/chats/state/kinOutbox.ts`, persisted, keyed by `clientMessageId`) and go out on reconnect. The server dedupes by `clientMessageId`.
- New messages arrive on the stream. While the reader is at the end, the list follows; otherwise a "New messages" pill appears.

**Waiting on you (`KinWaitingScreen`, new).** A list of the same native cards the chat shows, each with its buttons. Each card links to its message in the chat: "Open in chat" scrolls to it.

### Native cards (`features/chats/widgets/`, new)

`KinWidgetView` switches on `widget.kind`. An unknown kind renders "This card needs a newer version of Kin." and never falls back to HTML. Every card uses the `PendingApprovalCard` frame and `Button`s. Button labels are plain words (DESIGN 8.6).

**A click posts a structured action, not text.** `widgetAction({ orgId, chatId, widgetId, revision, actionId, clientActionId })`. While the action is in flight, the button shows a spinner and the other buttons are disabled. The server rejects an action whose `revision` is stale. The card then shows "This card changed. Check it again." and re-renders from the newer revision.

**Task card.** Data: `{ title, status: "queued" | "running" | "blocked" | "needs_decision" | "done" | "failed", progressText, startedAt, model: { provider, label }, thread: { environmentId, threadId }, pr?: { number, url } }`.

- Layout: the title, then progress text ("Codex · running tests · 4 min"). The model appears only here, small: a `ProviderIcon` at size 12 plus the label in `text-2xs text-foreground-muted` (DESIGN 8.6). An indeterminate bar shows while the task runs.
- The card updates in place when a new `revision` arrives. A new card is never appended for the same task.
- **Tap opens the thread:** `useOpenWorkspaceDetail()({ name: "Thread", params: { environmentId, threadId } })`. Diffs, logs and terminals stay there (DESIGN 8.8). Three cases change this:
  - The thread's environment isn't in the catalog: show a toast, "That thread is on an environment this phone doesn't know."
  - The environment is offline: navigate anyway. The thread screen already handles offline.
  - The thread was deleted: the thread screen shows its not-found state.
- A PR chip, if present, opens the PR with the existing `useOpenPullRequest` (`native/useOpenPullRequest.ts`).

**Deferral card.** Data: `{ what, dueAt, onDue: "remind" | "start" | "ask" | "chase", phase: "confirmed" | "heads_up" | "done" | "cancelled", graceEndsAt? }`.

- In the `confirmed` phase it reads "Deferred to Fri 13 Nov, 9:00. I'll start then." with buttons **Change** and **Just remind me**. **Change** opens `CustomSnoozeSheet`, and `onSnooze(iso)` posts `actionId: "change"` with `{ dueAt: iso }`.
- In the `heads_up` phase it reads "Starting rate limiting at 9:00", followed by the server's recheck line ("Issue #88 is still open."), with buttons **Start now**, **Monday** and **Cancel**. A countdown reads "Starts in 24 min unless you stop it".
- All times are in the device timezone, written as "Fri 13 Nov, 9:00" (`Intl.DateTimeFormat`).

**Approval card.** It renders **only** from `kinClient.pendingAction({ pendingActionId })`, the server's pending action. The widget carries nothing but `pendingActionId`. Any agent-supplied text is shown last, quoted and labelled, and never as a title or a button. The exact content, top to bottom:

1. Eyebrow: "Approval needed" (owner) or "Waiting on Nishchay" (anyone else, using `approvers[].displayName`).
2. Title: a fixed template per `kind`. For example, merge reads "Merge #212 into main". Only `prNumber` and `baseBranch` fill it.
3. `prTitle` on its own line, plain text, limited to 2 lines.
4. Facts list, one line each:
   - Repository: `GLDRoger/t3code`
   - Commit: first 16 characters of `headSha`, with the full SHA in the accessibility label and on long-press copy
   - Merge method: Squash
   - Changes: 4 files, +120 −30
   - Checks: 12 passed, 0 failed, 1 pending, with each required check underneath
5. Provenance: "Requested by Tech lead, for your message." If `afterNonOwnerMessage` is set, it reads "Asked for after Priya's message." in `text-warning-foreground` (DESIGN 9.4).
6. Buttons, shown only when `viewerUserId` is in `approvers` and `status === "pending"`: **Approve** (primary) and **Decline** (danger), then **View changes** (text tone), which opens the PR.
   - **Approve** calls the approvals spec's client entry point, `approvePendingAction({ orgId, pendingActionId, headSha })`. That function owns the Face ID prompt, the device-key signature and the grant RPC. This card shows only its pending, success and failure results.
   - Approve stays disabled while any required check is pending or failed. The card then reads "Waiting for checks".
7. Status line by `status`:
   - `approved`: "Approved by you · merging"
   - `executed`: "Merged · a1b2c3d"
   - `stale`: "New commit since this was asked. The lead will ask again." No buttons.
   - `expired`: "Expired." No buttons.
   - `failed`: the server's error text.
8. The agent's free text, if any, sits in a quoted block labelled "Tech lead says:", in `text-foreground-muted`.

Hiding the buttons is a convenience, not the protection (DESIGN 9.3). The server rejects approvals by role and signature, and the approvals spec tests that.

### Notifications with action buttons

**Sending (backend, this spec).** T3's relay can't carry Kin's pushes (see Design corrections). `apps/server/src/kin/push/KinPushSender.ts` (**new**) sends APNs pushes directly from the Kin server, over HTTP/2 with token auth. The `.p8` key is in the Kin host's keychain via `ServerSecretStore` (`apps/server/src/auth/ServerSecretStore.ts`).

- Device tokens are registered through `kin.push.registerDevice` (**new**, contracts in `packages/contracts/src/kinPush.ts`).
- The payload carries `aps.category` and `KinPushData`. Its text stays short and contains no PR body or agent free text, for example "Merge #212 is waiting on you".
- The sender skips a push when the device holds a live subscription to that chat and the app is in the foreground. Upstream owns the foreground handler, so this check has to happen on the server.
- Approval pushes go only to the approvers' devices (DESIGN 9.3).

**Receiving (`features/chats/notifications/installKinNotifications.ts`, new).**

- It registers categories once at install, with `Notifications.setNotificationCategoryAsync`:

| Category id              | Actions (identifier: title)                                              | Action `options` (set on each action)                          |
| ------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `kin.approval`           | `open: Review`                                                           | `opensAppToForeground: true`, `isAuthenticationRequired: true` |
| `kin.deferral.confirmed` | `change: Change`, `remind: Just remind me`                               | foreground                                                     |
| `kin.deferral.heads_up`  | `start: Start now`, `monday: Monday`, `cancel: Cancel` (`isDestructive`) | foreground, auth required                                      |
| `kin.message`            | none (tap opens chat)                                                    | n/a                                                            |

- There is no "Approve" action on the notification. Approving needs the in-app biometric prompt and signature (approvals spec), so the lock screen offers **Review**, which opens `KinApproval`.
- In phase 1 every action opens the app. Background actions are not reliable when the app has been killed.
- It adds its own `addNotificationResponseReceivedListener` and reads `getLastNotificationResponseAsync()` synchronously at install, so the cold-start tap is seen before upstream's consumer clears it. It decodes `KinPushData` and drops anything that fails or whose `deepLink` doesn't start with `/kin/`. Then it navigates with `linkToAppPath(deepLink)`.
- For an action id other than the default, it also posts `widgetAction` with a `clientActionId` derived from the notification identifier plus the action id, so a replayed response can't act twice. Upstream's thread router ignores these responses, because they carry no `/threads/` link.
- It registers the APNs token from `Notifications.getDevicePushTokenAsync()` with `kinClient.registerPush`. It reuses the existing permission prompt (`notificationPermissions.ts`) and never asks twice.

### Accessibility

- Every row and card is one accessibility element with a full label. A row reads "Tech lead, agent. Payments test fixed, PR 212 ready. 9:30. 3 unread." The shape of an avatar is not the only signal: the label says "agent" or "person".
- The Waiting on you banner has `accessibilityRole="button"` and the label "Waiting on you, 2 items: Merge 212, Pick a caching option".
- Card buttons are at least 44 pt tall. Destructive buttons say what they do ("Cancel deferral" in the accessibility label).
- The approval card's facts list reads in order. The commit's label spells out the full SHA. Status changes are announced with `AccessibilityInfo.announceForAccessibility` ("Merged").
- Text uses `AppText` with `textRole`, so Dynamic Type applies. Rows grow instead of truncating at the accessibility sizes, and previews may wrap to 2 lines.
- Motion follows `MOBILE_MOTION`, with `ReduceMotion.System` on every Reanimated animation, as `ThreadComposer.tsx` does. The progress bar becomes static under Reduce Motion.
- Colour is never the only state signal: warnings carry text, and unread badges carry a number.

## Files

New, all under `apps/mobile/src/features/chats/` unless noted:

- `routes.tsx`: `KIN_SCREENS` (the four routes above)
- `KinHomeEntry.tsx`, `KinChatsScreen.tsx`, `KinChatScreen.tsx`, `KinWaitingScreen.tsx`, `KinApprovalRouteScreen.tsx`
- `components/KinAvatar.tsx`, `KinChatRow.tsx`, `KinWaitingBanner.tsx`, `KinMessageBubble.tsx`, `KinFoldLine.tsx`, `KinComposer.tsx`, `KinScreenState.tsx` (the state table as one component)
- `widgets/KinWidgetView.tsx`, `KinTaskCard.tsx`, `KinDeferralCard.tsx`, `KinApprovalCard.tsx`, `kinCardPresentation.ts` (pure copy and format functions, unit-tested)
- `state/kinClient.ts`, `state/useKinHost.ts`, `state/kinOutbox.ts`, `state/kinInboxModel.ts` (sorting, merge of deltas, unit-tested)
- `notifications/installKinNotifications.ts`, `notifications/kinPushPayload.ts`, `notifications/kinCategories.ts`
- `packages/contracts/src/kinPush.ts`, `apps/server/src/kin/push/KinPushSender.ts`, `apps/server/src/kin/push/KinPushDevices.ts` (backend)

Upstream files touched, one hook each:

| File                                                 | Hook                                                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `apps/mobile/src/Stack.tsx`                          | `import { KIN_SCREENS } from "./features/chats/routes";` and `...KIN_SCREENS,` in `screens`                     |
| `apps/mobile/src/features/home/HomeScreen.tsx`       | `import { KinHomeEntry } ...` and `<KinHomeEntry />` first in `v2ListHeader`                                    |
| `apps/mobile/src/App.tsx`                            | `import { installKinNotifications } ...` and `installKinNotifications(linkToAppPath),` in `appServiceDisposers` |
| `packages/client-runtime/src/rpc/client.ts`          | add Kin stream tags to `EnvironmentSubscriptionRpcTag` (one line per tag; may be done by the chat spec)         |
| `apps/mobile/vite.config.ts`                         | `"src/features/chats/**/*.test.tsx",` in `reactTests` (only if Kin adds component tests)                        |
| `apps/mobile/src/features/threads/McpAppWebView.tsx` | `export` on `function outerDocument` (TRIG-19)                                                                  |

## Interfaces to other specs

- **Chat spec:** owns `kinChat.ts` and the methods mobile calls: `listOrgs`, `subscribeInbox` (chat summaries, `KinWaitingItem`s, viewer id and role), `subscribeChat`, `listMessages` (paged by `seq`), `sendMessage` (dedupe on `clientMessageId`), and `sendWidgetAction` (dedupe on `clientActionId`; rejects a stale `revision`). It also owns adding them to `WsRpcGroup`, and the `CLIENT_GUARDED_RPC_SCOPES` entry for the write methods in `packages/contracts/src/clientRpcPermissions.ts`. Mobile needs `KinAuthor` resolved on the server, never from message text.
- **Approvals spec:** owns `KinPendingAction`, its view stream (`subscribePendingAction`) and the client function `approvePendingAction`. That function does the biometric prompt, the device-key signature and the grant RPC, and lives under `features/chats/approvals/` or wherever that spec says. Mobile renders the card and calls the function.
- **Lead spec:** posts task, deferral and approval widgets, and updates them by `widgetId` plus a new `revision`. Folded agent talk arrives as a message kind.
- **Triggers spec:** the `once` trigger moves a deferral from `confirmed` to `heads_up` and then starts it. Its upstream contract tests should include the three mobile hooks, and the `/threads/` normalizer in `notificationPayload.ts` that Kin relies on to ignore Kin pushes.

## Security notes

- The approval card never renders agent HTML or agent-chosen titles. Facts come from the pending action, which the server builds from GitHub, not from the agent.
- No widget kind falls back to a WebView in phase 1. Generated widgets (phase 2) go through `makeMcpAppHost`, and Kin adds its own real-tap gate on actions (Design correction 9).
- Push payloads hold ids and short fixed text only. Apple sees them.
- Deep links from notifications are checked (`/kin/` prefix, schema decode) before navigation. Route params are treated as untrusted: a `KinApproval` link for an action the viewer can't approve shows the read-only card.
- The `.p8` APNs key stays in the server secret store, never in the repo or logs.

## Tests and acceptance criteria

Commands, from `apps/mobile`: `vp run typecheck` and `vp test run --project unit src/features/chats`. Server: `vp test run apps/server/src/kin/push`.

- `kinInboxModel.test.ts`: waiting chats sort first, deltas merge by `seq`, a duplicate `clientMessageId` replaces the pending bubble.
- `kinCardPresentation.test.ts`: the approval title template, the SHA short form, the checks summary, every `status` line, owner vs member eyebrow, Approve disabled while checks are pending, deferral time format across timezones.
- `kinPushPayload.test.ts`: valid payloads route; `/threads/...`, `//evil`, query strings and malformed JSON are dropped; an action response produces one `widgetAction` per notification id.
- `KinPushSender.test.ts`: category per widget kind; approval pushes only reach approver devices; skipped when a foreground subscription exists.
- Upstream tests still pass: `dependency-graph.test.ts`, `reactCompilerCoverage.test.ts`, `notificationNavigation.test.ts`.
- Manual, on a device against the Kin host, captured as screenshots in the PR:
  1. The entry row appears on Home only when Kin is reachable.
  2. A message sent offline goes out on reconnect.
  3. Tapping a task card opens the T3 thread, and Back returns to the chat.
  4. A member account sees "Waiting on Nishchay" and no buttons.
  5. A lock-screen deferral heads-up with **Monday** reschedules it.
  6. VoiceOver reads a row and the approval card in order.

## Tasks

**MOB-1 Kin client state and host discovery** (UI)

- What: `kinClient.ts`, `useKinHost.ts`, `kinInboxModel.ts`, the offline cache with `persistQuery`, and the `EnvironmentSubscriptionRpcTag` hook.
- Files: `features/chats/state/*`, `packages/client-runtime/src/rpc/client.ts`.
- Depends on: CHAT-1.
- Done when: unit tests pass, and a dev screen logs the inbox snapshot from the Kin host.

**MOB-2 Routes and entry hooks** (UI)

- What: `KIN_SCREENS` with placeholder screens, the `Stack.tsx` and `HomeScreen.tsx` hooks, and `KinHomeEntry`.
- Files: `routes.tsx`, `KinHomeEntry.tsx`, the two upstream files.
- Depends on: MOB-1.
- Done when: `t3code-dev://kin` and `t3code-dev://kin/waiting` open their screens, the row is hidden against a plain T3 server, and typecheck and dependency-graph pass.

**MOB-3 Chat list screen** (UI)

- What: rows, `KinAvatar`, the Waiting on you banner, the footer row, and all seven states.
- Files: `KinChatsScreen.tsx`, `components/KinChatRow.tsx`, `KinWaitingBanner.tsx`, `KinAvatar.tsx`, `KinScreenState.tsx`.
- Depends on: MOB-2.
- Done when: the screen matches the mockup in light and dark, each state is reachable from fixtures in `ComponentCatalogScreen` (dev), and the VoiceOver labels match this spec.

**MOB-4 Direct chat: feed** (UI)

- What: bubbles, markdown, author lines, the fold line, paging, follow-the-end and the "New messages" pill.
- Files: `KinChatScreen.tsx`, `KinMessageBubble.tsx`, `KinFoldLine.tsx`.
- Depends on: MOB-2.
- Done when: 500 fixture messages scroll smoothly, "Load earlier" pages by 50, and the list stays anchored.

**MOB-5 Composer and outbox** (UI)

- What: `KinComposer` on `ComposerEditor`, the pending, failed and retry bubble states, and the persisted outbox.
- Files: `KinComposer.tsx`, `state/kinOutbox.ts`.
- Depends on: MOB-4, CHAT-6.
- Done when: a message sent in airplane mode is delivered once on reconnect (the server shows one message), and the draft survives an app restart.

**MOB-6 Widget switch and task card** (UI)

- What: `KinWidgetView`, `KinTaskCard`, in-place updates, opening the thread and PR, and the unknown-kind fallback.
- Files: `widgets/KinWidgetView.tsx`, `KinTaskCard.tsx`, `kinCardPresentation.ts`.
- Depends on: MOB-4, CHAT-8.
- Done when: tapping a live task card opens its T3 thread on iOS and Android, and a revision bump updates the same card.

**MOB-7 Deferral card** (UI)

- What: the `confirmed` and `heads_up` phases, the countdown, and Change through `CustomSnoozeSheet`.
- Files: `widgets/KinDeferralCard.tsx`.
- Depends on: MOB-6, TRIG-7.
- Done when: Change, Just remind me, Start now, Monday and Cancel each post one action, and a stale revision shows "This card changed".

**MOB-8 Approval card and sheet** (UI)

- What: `KinApprovalCard` from the pending action, owner gating, every status line, and the `KinApproval` route. It calls `approvePendingAction`.
- Files: `widgets/KinApprovalCard.tsx`, `KinApprovalRouteScreen.tsx`.
- Depends on: MOB-6, APPR-1, APPR-7.
- Done when: presentation tests pass, a member fixture shows no buttons, and a new commit turns the card stale within one stream update.

**MOB-9 Waiting on you screen** (UI)

- What: the list of waiting cards, sorting, "Open in chat" with scroll-to-message, and the states.
- Files: `KinWaitingScreen.tsx`.
- Depends on: MOB-3, MOB-7, MOB-8.
- Done when: answering a card removes it from the list and from the banner count without a refresh.

**MOB-10 Push sender and device registration** (backend)

- What: `kinPush.ts` contracts, device storage per `orgId`, an APNs HTTP/2 sender with categories, approver-only routing, and foreground suppression.
- Files: `packages/contracts/src/kinPush.ts`, `apps/server/src/kin/push/*`.
- Depends on: CHAT-6, APPR-5.
- Done when: `KinPushSender.test.ts` passes, and a test push reaches a development build.

**MOB-11 Notification categories and routing** (UI)

- What: `installKinNotifications`, categories, token registration, cold-start handling, action-to-`widgetAction`, and the `App.tsx` hook.
- Files: `features/chats/notifications/*`, `App.tsx`.
- Depends on: MOB-2, MOB-10.
- Done when: payload tests pass; on a device, a lock-screen **Review** opens `KinApproval` after Face ID unlock, and **Monday** reschedules from a killed app.

**MOB-12 Accessibility and polish pass** (UI)

- What: audit every screen against the accessibility section, Dynamic Type at the largest size, Reduce Motion, and Android TalkBack.
- Files: all of `features/chats`.
- Depends on: MOB-3 to MOB-9.
- Done when: a recorded VoiceOver walk-through covers list to chat to approval, and nothing truncates at the largest accessibility size.

## Design corrections

1. **No expo-router.** Navigation is React Navigation 7 static config in `Stack.tsx`. "Route map" in KIN.md means its `screens` object.
2. **"Chats" is taken on iOS.** `WORKSPACE_TAB_LABELS` already labels T3's thread tab "Chats". Kin can't rename it ("never rename in source"), so Kin's entry is labelled "Kin", with "Waiting on you" when it has items.
3. **A Kin tab is not a one-line hook.** It touches seven upstream files (listed above). Phase 1 uses a Home list row and root routes instead.
4. **Notification buttons can't ride T3's relay.**
   - Pushes are built by T3's hosted relay from thread-shaped `RelayAgentActivityState`. There are no categories.
   - The mobile router only accepts `/threads/...` links.
   - Kin's build gets its own bundle id (KIN.md), which the hosted relay most likely can't push to, since its APNs key belongs to T3's Apple team. Not verified, because the relay service isn't in this repo.
   - So Kin needs its own APNs sender (MOB-10) and an Apple Developer key from the owner.
5. **Phase mismatch.** DESIGN section 11 puts notification actions in phase 2. This spec puts them in phase 1 as asked. Decide which phase.
6. **No approve button on the lock screen.** Approval needs the in-app biometric prompt and signature, so the lock screen offers **Review**, not Approve. "Every request carries its buttons" (DESIGN 8.4) holds for deferrals and decisions only.
7. **Widgets aren't drop-in reusable.** `ThreadMcpApp` and `ThreadFeed` are bound to T3 threads. Generated widgets (phase 2) must build on `makeMcpAppHost` and reuse `outerDocument`, which TRIG-19 exports.
8. **The foreground handler is single-owner.** Upstream owns `setNotificationHandler`, so Kin suppresses pushes for the chat on screen from the server.
9. **The real-tap check doesn't gate actions.** DESIGN 7 says generated widgets act "only on a real tap". Upstream's outer document sets `active` only for a real tap with focus on the app frame, but React Native reads it only to allow full screen. `callTool` is gated by tool type (read-only runs, changing tools ask to confirm) and `sendMessage` always asks to confirm. Phase 2's generated widgets add their own gate in Kin's host callbacks:
   - Read `active` synchronously when the callback is entered, before any `await`. It reaches the host through a ref set around a synchronous `host.receive`, so it is only valid then. TRIG-19 pins both the flag and the synchronous dispatch.
   - `active` means a real tap on this frame within the browser's transient-activation window, which lasts seconds and isn't consumed. So one tap can cover several posts. Kin allows one action per activation, and keeps upstream's confirm dialogs.
   - The gate covers `callTool`, `sendMessage`, `openLink`, `downloadFile` and `updateModelContext`. `updateModelContext` changes what the agent sees and has no upstream gate.

## Open questions

- Which Apple Developer team signs the Kin build, and who creates its APNs key? Its App ID also needs the App Attest capability, or approval keys can't be activated (approvals spec, section 4). Android FCM waits until someone uses Android.
- Is "Kin" the right label for the entry row, or should it carry the lead's name?
- Should the Waiting on you banner also show on T3's Home list when the Kin row is scrolled away (for example, as a pinned header)?
- Does phase 1 need folded agent talk, given there is one agent in a direct chat?
