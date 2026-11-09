#!/usr/bin/env node
// Ops only: replays a recorded Kin day through the full lead path at L0, with a scripted
// provider instead of a model, against a local mirror of the memory remote. Only after the
// checks pass, and only with --push, does it push kin/shadow/<agentId> to the real remote.
// Runbook: docs/operations/kin-shadow-dry-run.md.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
  KinAgentId,
  KinChatId,
  KinEvent,
  type KinLevel,
  KinOrgId,
  KinPersonId,
  KinRoutineCard,
  KinShadowReviewCard,
  KinShadowSummaryCard,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema } from "effect/ai";
// oxlint-disable-next-line t3code/no-raw-mcp-registration -- calls the Kin tools toolkitRegistration registered and registers none.
import { McpServer } from "effect/ai";
import { Command, Flag } from "effect/cli";

import { McpInvocationContext, type McpInvocationScope } from "../src/mcp/McpInvocationContext.ts";
import * as McpHttpServer from "../src/mcp/McpHttpServer.ts";
import { provideDeterministicTestRuntime } from "../src/orchestration-v2/testkit/DeterministicRuntime.ts";
import * as Sqlite from "../src/persistence/Sqlite.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { ProviderInstanceRegistry } from "../src/provider/ProviderInstanceRegistry.ts";
import * as Vcs from "../src/vcs/VcsProcess.ts";
import * as KinApprovalsMcp from "../src/kin/approvals/mcp.ts";
import * as RequestAction from "../src/kin/approvals/RequestAction.ts";
import { KinChatService } from "../src/kin/chat/KinChatService.ts";
import * as KinChatRepository from "../src/kin/chat/KinChatRepository.ts";
import { KinIdentity } from "../src/kin/chat/KinIdentity.ts";
import { environment } from "../src/kin/chat/TaskCard.testkit.ts";
import * as Kin from "../src/kin/layer.ts";
import { KinShadowSummary } from "../src/kin/lead/KinLevels.ts";
import * as KinEventQueue from "../src/kin/lead/KinEventQueue.ts";
import * as KinLeadRegistry from "../src/kin/lead/KinLeadRegistry.ts";
import * as LeadMemory from "../src/kin/lead/LeadMemory.ts";
import { KinLeadPrompt } from "../src/kin/lead/LeadPrompt.ts";
import * as RoutineContent from "../src/kin/lead/RoutineContent.ts";
import * as WakeupRunner from "../src/kin/lead/WakeupRunner.ts";
import { orchestrationStack } from "../src/kin/lead/WakeupRunner.testkit.ts";
import * as Workers from "../src/kin/lead/Workers.ts";
import { KinLeadToolkit } from "../src/kin/lead/mcp/tools.ts";
import { handlers as leadHandlers } from "../src/kin/lead/mcp/handlers.ts";
import { KinChatToolkit, handlers as chatHandlers } from "../src/kin/mcp/KinChatToolkit.ts";
import { memoryGit } from "../src/kin/memory/git.ts";
import * as Memory from "../src/kin/memory/Memory.ts";
import * as Cache from "../src/kin/memory/MemoryCache.ts";
import { MemoryConfig } from "../src/kin/memory/MemoryConfig.ts";
import * as Writer from "../src/kin/memory/MemoryWriter.ts";
import { isCredentialHelperReference, isSshCommandReference } from "../src/kin/memory/purgePush.ts";
import * as Scan from "../src/kin/memory/secretScan.ts";
import * as KinPersistence from "../src/kin/persistence/KinPersistence.ts";

const ToolCall = Schema.Struct({
  tool: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
});
const step = {
  id: Schema.String,
  at: Schema.String,
  /** What the lead does in the wake-up that handles this event, as recorded tool calls. */
  lead: Schema.optional(Schema.Array(ToolCall)),
};
const DayEvent = Schema.Union([
  Schema.TaggedStruct("message", {
    ...step,
    chat: Schema.String,
    from: Schema.String,
    body: Schema.String,
  }),
  Schema.TaggedStruct("routine", {
    ...step,
    routine: Schema.Literals(["morning_brief", "evening_summary"]),
  }),
  Schema.TaggedStruct("github", {
    ...step,
    eventName: Schema.String,
    repo: Schema.String,
    summary: Schema.String,
  }),
  Schema.TaggedStruct("watchdog", { ...step, finding: Schema.String }),
]);
type DayEvent = typeof DayEvent.Type;

/** A recorded day. Every value is synthetic; real organization data never goes in the repo. */
const RecordedDay = Schema.Struct({
  day: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  lead: Schema.Struct({ name: Schema.String }),
  people: Schema.Array(
    Schema.Struct({ personId: Schema.String, handle: Schema.String, displayName: Schema.String }),
  ),
  groups: Schema.Array(
    Schema.Struct({ chatId: Schema.String, members: Schema.Array(Schema.String) }),
  ),
  workerProjects: Schema.Array(Schema.String),
  github: Schema.Struct({
    reviews: Schema.Array(
      Schema.Struct({
        repo: Schema.String,
        number: Schema.Number,
        title: Schema.String,
        url: Schema.String,
      }),
    ),
    ciRed: Schema.Array(Schema.Struct({ repo: Schema.String, branch: Schema.String })),
  }),
  /** Seeds the local fixture remote; unused when --memory-url names a real repository. */
  memory: Schema.Record(Schema.String, Schema.String),
  events: Schema.Array(DayEvent),
});
type RecordedDay = typeof RecordedDay.Type;
const decodeDay = Schema.decodeUnknownEffect(Schema.fromJsonString(RecordedDay));
const decodeEvent = Schema.decodeUnknownEffect(KinEvent);
const decodeEventIds = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

class KinDryRunError extends Schema.TaggedError<KinDryRunError>()("KinDryRunError", {
  message: Schema.String,
}) {}

interface DryRunOptions {
  readonly dayFile: string;
  readonly stateDir: string;
  readonly agentId: string;
  /** Defaults to a bare repository seeded from the day's `memory` inside the state directory. */
  readonly memoryUrl?: string | undefined;
  readonly credentialHelper?: string | undefined;
  readonly sshCommand?: string | undefined;
  /** The home directory whose `.t3` is the live install; tests pass a temporary one. */
  readonly home: string | undefined;
  /** Push the shadow branch to the memory remote once every check passes. */
  readonly push?: boolean | undefined;
  /** Test seam for proving the push gate; the CLI always runs L0. */
  readonly level?: KinLevel | undefined;
}

interface RefChange {
  readonly ref: string;
  readonly before: string | null;
  readonly after: string | null;
}

interface DryRunReport {
  readonly lines: ReadonlyArray<string>;
  readonly refChanges: ReadonlyArray<RefChange>;
  readonly pushed: { readonly ref: string; readonly sha: string } | undefined;
  readonly violations: ReadonlyArray<string>;
  readonly toolCalls: ReadonlyArray<{ readonly tool: string; readonly outcome: string }>;
}

const orgId = KinOrgId.make("kin-default");
const instanceId = ProviderInstanceId.make("codex");
// Workers read only these fields to pick a model; at L0 no provider ever starts.
const codexInstance = {
  instanceId,
  driverKind: ProviderDriverKind.make("codex"),
  enabled: true,
} as Pick<ProviderInstance, "instanceId" | "driverKind" | "enabled"> as ProviderInstance;
const providers = Layer.mock(ProviderInstanceRegistry)({
  getInstance: Effect.fn("KinDryRun.getInstance")((id) =>
    Effect.succeed(id === instanceId ? codexInstance : undefined),
  ),
});
const ownerSession = {
  sessionId: AuthSessionId.make("kin-dry-run-owner"),
  subject: "kin-dry-run",
  method: "browser-session-cookie" as const,
  scopes: AuthStandardClientScopes,
};
const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const clockLabel = (ms: number) => isoAt(ms).slice(11, 16);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeRoutineCard = Schema.decodeOption(Schema.fromJsonString(KinRoutineCard));
const decodeSummaryCard = Schema.decodeOption(Schema.fromJsonString(KinShadowSummaryCard));
const decodeReviewCard = Schema.decodeOption(Schema.fromJsonString(KinShadowReviewCard));

/** Refuses the live install: the state directory may not be `~/.t3` or anything below it. */
const refuseLiveHome = Effect.fn("KinDryRun.refuseLiveHome")(function* (
  stateDir: string,
  home: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (home === undefined || !path.isAbsolute(home))
    return yield* new KinDryRunError({
      message: "HOME is unset or not absolute, so the live ~/.t3 can't be located. Set HOME.",
    });
  const real = (target: string) =>
    fs.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));
  // macOS and Windows volumes usually fold case, so ~/.T3 is the live ~/.t3 there.
  const platform = yield* HostProcess.Platform;
  const fold = (target: string) =>
    platform === "darwin" || platform === "win32" ? target.toLowerCase() : target;
  // Resolve the deepest existing ancestor, so a symlink into ~/.t3 is caught before creation.
  const resolve = Effect.fn("KinDryRun.resolve")(function* (target: string) {
    let existing = path.resolve(target);
    const rest: Array<string> = [];
    while (!(yield* fs.exists(existing))) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
    return path.join(yield* real(existing), ...rest);
  });
  const state = yield* resolve(stateDir);
  for (const live of new Set([
    path.join(path.resolve(home), ".t3"),
    yield* resolve(path.join(home, ".t3")),
  ]))
    if (fold(state) === fold(live) || fold(state).startsWith(fold(live) + path.sep))
      return yield* new KinDryRunError({
        message: `Refusing ${stateDir}: it is the live T3 home (${live}) or inside it. Use a temporary --state-dir.`,
      });
  return state;
});

/** Credential flags name a helper, a key file or a command, never a secret value. */
const refuseUnsafeFlags = Effect.fn("KinDryRun.refuseUnsafeFlags")(function* (
  options: DryRunOptions,
) {
  // The id becomes the one pushed ref, so it may not bend the refspec.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(options.agentId))
    return yield* new KinDryRunError({
      message: "--agent-id takes letters, digits, '-' and '_' only.",
    });
  if (
    options.credentialHelper !== undefined &&
    !isCredentialHelperReference(options.credentialHelper)
  )
    return yield* new KinDryRunError({
      message:
        "--credential-helper takes a helper name or an absolute path, never a token or an inline `!` script.",
    });
  if (options.sshCommand !== undefined && !isSshCommandReference(options.sshCommand))
    return yield* new KinDryRunError({
      message:
        "--ssh-command takes a plain ssh command naming a key file, such as `ssh -i /path/to/key -o IdentitiesOnly=yes`, with no shell syntax or secret.",
    });
});

const git = Effect.fn("KinDryRun.git")(function* (cwd: string, args: ReadonlyArray<string>) {
  const result = yield* (yield* Vcs.VcsProcess).run({
    operation: "kin.dryRun.git",
    command: "git",
    cwd,
    args: [
      "-c",
      "user.name=Kin dry run",
      "-c",
      "user.email=dry-run@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    allowNonZeroExit: true,
  });
  if (result.exitCode !== 0)
    return yield* new KinDryRunError({ message: `git ${args[0]} failed: ${result.stderr.trim()}` });
  return result.stdout;
});

/** A local bare remote holding the day's fixture memory, so no test touches a real repository. */
export const seedFixtureRemote = Effect.fn("KinDryRun.seedFixtureRemote")(function* (
  stateDir: string,
  memory: RecordedDay["memory"],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const seed = path.join(stateDir, "fixture-seed");
  const remote = path.join(stateDir, "fixture-memory.git");
  yield* fs.makeDirectory(seed, { recursive: true });
  yield* git(seed, ["init", "-q", "-b", "main"]);
  for (const [file, text] of Object.entries(memory)) {
    yield* fs.makeDirectory(path.dirname(path.join(seed, file)), { recursive: true });
    yield* fs.writeFileString(path.join(seed, file), text);
  }
  yield* git(seed, ["add", "--", "."]);
  yield* git(seed, ["commit", "-q", "-m", "Fixture memory"]);
  yield* git(stateDir, ["clone", "-q", "--bare", "--", seed, remote]);
  yield* fs.remove(seed, { recursive: true });
  return remote;
});

const listRefs = Effect.fn("KinDryRun.listRefs")(function* (stateDir: string, url: string) {
  const out = yield* memoryGit(stateDir, ["ls-remote", "--", url]);
  const refs = new Map<string, string>();
  for (const line of out.split("\n")) {
    const [sha, ref] = line.trim().split("\t");
    if (sha && ref) refs.set(ref, sha);
  }
  return refs;
});

const diffRefs = (before: Map<string, string>, after: Map<string, string>) =>
  [...new Set([...before.keys(), ...after.keys()])]
    .toSorted()
    .map((ref) => ({ ref, before: before.get(ref) ?? null, after: after.get(ref) ?? null }))
    .filter((change) => change.before !== change.after);

const substitute = (value: unknown, vars: Record<string, string>): unknown =>
  typeof value === "string" && value.startsWith("$") && vars[value.slice(1)] !== undefined
    ? vars[value.slice(1)]
    : Array.isArray(value)
      ? value.map((item) => substitute(item, vars))
      : typeof value === "object" && value !== null
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]))
        : value;
const substituteArguments = (
  args: Readonly<Record<string, unknown>>,
  vars: Record<string, string>,
) => Object.fromEntries(Object.entries(args).map(([key, value]) => [key, substitute(value, vars)]));

const outcomeOf = (result: McpSchema.CallToolResult) => {
  const text = result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join(" ")
    .slice(0, 160);
  const structured = JSON.stringify(result.structuredContent ?? {});
  if (result.isError === true) return `refused: ${text}`;
  return structured.includes('"shadowed":true') ? "shadowed" : "ok";
};

const renderWidget = (type: string, state: unknown): ReadonlyArray<string> => {
  const json = typeof state === "string" ? state : JSON.stringify(state);
  if (type === "routine") {
    const card = decodeRoutineCard(json);
    return Option.match(card, {
      onNone: () => ["    [routine card]"],
      onSome: (card) => [
        `    [${card.routine} card, ${card.day}]`,
        ...card.rows.map(
          (row) => `      ${row.section}: ${row.title}${row.note ? ` (${row.note})` : ""}`,
        ),
      ],
    });
  }
  const card =
    type === "shadow_summary"
      ? decodeSummaryCard(json)
      : type === "shadow_review"
        ? decodeReviewCard(json)
        : Option.none();
  return Option.match(card, {
    onNone: () => [`    [${type} card]`],
    onSome: (card) => [
      `    [${type} card] ${card.title}`,
      ...card.entries.map(
        (entry) =>
          `      - ${entry.tool} -> ${entry.wouldTarget || "(no target)"}: ${entry.preview.replaceAll("\n", " ")}`,
      ),
    ],
  });
};

/** Replays the day and returns the owner's view, the remote's ref changes and every violation. */
export const runDryRun = Effect.fn("KinDryRun.run")(
  function* (options: DryRunOptions) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* refuseUnsafeFlags(options);
    const stateDir = yield* refuseLiveHome(options.stateDir, options.home);
    if ((yield* fs.exists(stateDir)) && (yield* fs.readDirectory(stateDir)).length > 0)
      return yield* new KinDryRunError({
        message: `State directory ${stateDir} is not empty. Use a fresh one for each dry run.`,
      });
    yield* fs.makeDirectory(stateDir, { recursive: true });
    const day = yield* decodeDay(yield* fs.readFileString(options.dayFile)).pipe(
      Effect.mapError(
        (error) => new KinDryRunError({ message: `Invalid day file: ${error.message}` }),
      ),
    );
    const agentId = KinAgentId.make(options.agentId);
    const shadow = `refs/heads/kin/shadow/${agentId}`;
    const target = options.memoryUrl ?? (yield* seedFixtureRemote(stateDir, day.memory));
    const withCredentials = Effect.provideService(
      MemoryConfig,
      MemoryConfig.of({
        baseDirectory: path.join(stateDir, "kin"),
        repositories: [],
        ...(options.credentialHelper === undefined
          ? {}
          : { credentialHelper: options.credentialHelper }),
        ...(options.sshCommand === undefined ? {} : { sshCommand: options.sshCommand }),
      }),
    );
    const refuseExistingShadow = Effect.fn("KinDryRun.refuseExistingShadow")(function* () {
      const refs = yield* listRefs(stateDir, target).pipe(
        withCredentials,
        Effect.mapError(
          (error) =>
            new KinDryRunError({
              message: `Could not list refs on ${target}: ${error.message}. Run the runbook's ls-remote pre-check with the same credential to see git's own error.`,
            }),
        ),
      );
      const existing = refs.get(shadow);
      if (existing !== undefined)
        return yield* new KinDryRunError({
          message: `${shadow} already exists on ${target} at ${existing}. Delete it (see the runbook) or pick another --agent-id.`,
        });
    });
    yield* refuseExistingShadow();
    // The replay only ever sees this local mirror; the one write to the real remote comes after the checks.
    const memoryUrl = path.join(stateDir, "memory-mirror.git");
    yield* memoryGit(stateDir, ["clone", "-q", "--mirror", "--", target, memoryUrl]).pipe(
      withCredentials,
    );
    const memoryConfig = MemoryConfig.of({
      baseDirectory: path.join(stateDir, "kin"),
      repositories: [{ orgId, repoUrl: memoryUrl, path: encodeURIComponent(orgId) }],
    });
    const refsBefore = yield* listRefs(stateDir, memoryUrl);
    const events = day.events.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const byId = new Map(events.map((event) => [event.id, event]));
    const start = Date.parse(`${day.day}T00:00:00.000Z`);

    // The scripted provider: each lead turn replays the tool calls recorded for its events.
    const turn = { run: (_threadId: ThreadId): Effect.Effect<void> => Effect.void };
    const database = KinPersistence.layer.pipe(
      Layer.provideMerge(
        Sqlite.layerFromPath(path.join(stateDir, "userdata", "kin-dry-run.sqlite")),
      ),
      Layer.provide(NodeServices.layer),
    );
    const stack = orchestrationStack({
      database,
      onTurn: ({ threadId }) => Effect.suspend(() => turn.run(threadId)),
    });
    const kinServer = Kin.layer.pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
      Layer.provideMerge(environment),
      Layer.provideMerge(stack),
    );

    const lines: Array<string> = [];
    const toolCalls: Array<{ tool: string; outcome: string }> = [];
    const violations: Array<string> = [];

    yield* TestClock.setTime(start);
    yield* Effect.gen(function* () {
      const kin = yield* Kin.KinServer;
      const services = Option.getOrThrow(kin.services);
      const identity = Context.get(services, KinIdentity);
      const chats = Context.get(services, KinChatService);
      const queue = Context.get(services, KinEventQueue.KinEventQueue);
      const repo = yield* KinChatRepository.KinChatRepository;
      const sql = yield* SqlClient.SqlClient;

      const [owner] = yield* identity.resolve(ownerSession);
      if (owner === undefined || owner._tag !== "person")
        return yield* new KinDryRunError({ message: "No owner identity." });
      const createdAt = isoAt(start);
      yield* repo.insertAgent({
        orgId,
        agentId,
        displayName: day.lead.name,
        role: "lead",
        ownerPersonId: owner.personId,
        createdAt,
      });
      const direct = yield* chats.createDirect(owner, { orgId, agentId });
      const models = yield* encodeJson({
        strong: { instanceId, model: "dry-run-strong" },
        cheap: { instanceId, model: "dry-run-cheap" },
      });
      const workerProjects = yield* encodeJson(day.workerProjects);
      // Seeded at L0: the level the shadow week runs at, and the one this script checks.
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level, level_since, models_json, worker_projects_json, owner_chat_id)
      VALUES (${agentId}, ${orgId}, ${day.lead.name}, ${options.level ?? "L0"}, ${start}, ${models}, ${workerProjects}, ${direct.chatId})`;
      for (const person of day.people)
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES (${person.personId}, ${orgId}, ${person.handle}, ${person.displayName}, ${createdAt})`;
      for (const group of day.groups) {
        yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
        VALUES (${group.chatId}, ${orgId}, 'team_group', 0, ${createdAt})`;
        yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
        VALUES (${`${group.chatId}:${agentId}`}, ${orgId}, ${group.chatId}, 'agent', ${agentId}, 'member', ${createdAt})`;
        for (const personId of group.members)
          yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
          VALUES (${`${group.chatId}:${personId}`}, ${orgId}, ${group.chatId}, 'person', ${personId}, 'member', ${createdAt})`;
      }

      const recovery = Layer.succeed(Memory.MemoryRecoveryHooks, {
        notify: Effect.fn("KinDryRun.recoveryNotice")((notice) =>
          Effect.sync(() => violations.push(`Memory recovery: ${notice.reason}`)),
        ),
      });
      const memory = Memory.layer.pipe(Layer.provide(recovery));
      const writer = Writer.layer.pipe(
        Layer.provideMerge(LeadMemory.authority),
        Layer.provide(Cache.layer),
        Layer.provide(Scan.layer),
        Layer.provide(
          Layer.succeed(Writer.MemoryWriterHooks, {
            notify: Effect.fn("KinDryRun.writerNotice")((notice) =>
              Effect.sync(() =>
                violations.push(`Memory writer refused a commit: ${notice.error._tag}`),
              ),
            ),
          }),
        ),
        Layer.provide(recovery),
      );
      const github = Layer.succeed(RoutineContent.KinRoutineGithubReader, {
        read: Effect.fn("KinDryRun.githubSnapshot")(() =>
          Effect.succeed({
            reviews: day.github.reviews,
            ciRed: day.github.ciRed,
            failedRepos: 0,
            truncatedRepos: 0,
            repos: new Set([...day.github.reviews, ...day.github.ciRed].map((item) => item.repo))
              .size,
          }),
        ),
      });
      // The dry run never reads GitHub: below L3 a request needs only the project's spelling.
      const facts = Layer.succeed(RequestAction.KinPullRequestFacts, {
        canonical: Effect.fn("KinDryRun.canonicalTarget")(({ target }) => Effect.succeed(target)),
        read: Effect.fn("KinDryRun.readPullRequest")(function* () {
          return yield* Effect.die("The dry run never reads pull requests from GitHub.");
        }),
      });
      const tools = Layer.mergeAll(
        McpHttpServer.toolkitRegistration(KinLeadToolkit, leadHandlers),
        McpHttpServer.toolkitRegistration(KinChatToolkit, chatHandlers),
        KinApprovalsMcp.registrationWith(facts),
      ).pipe(Layer.provideMerge(McpHttpServer.layerInProcessMcpServer));
      const lead = Layer.mergeAll(WakeupRunner.layer, tools).pipe(
        Layer.provideMerge(Workers.layer),
        Layer.provideMerge(LeadMemory.layer),
        Layer.provideMerge(writer),
        Layer.provideMerge(RoutineContent.layer.pipe(Layer.provide(github))),
        Layer.provideMerge(KinLeadPrompt.layer),
        Layer.provideMerge(Layer.mergeAll(memory, KinChatRepository.layer, KinLeadRegistry.layer)),
        Layer.provide(Layer.succeed(MemoryConfig, memoryConfig)),
        Layer.provide(Layer.succeedContext(services)),
      );

      yield* Effect.gen(function* () {
        const runner = yield* WakeupRunner.WakeupRunner;
        const registry = yield* KinLeadRegistry.KinLeadRegistry;
        const server = yield* McpServer.McpServer;
        const context = yield* Effect.context<never>();
        const client = McpSchema.McpServerClient.of({
          clientId: 1,
          clientCapabilities: {},
          clientInfo: { name: "kin-dry-run", version: "1" },
          protocolVersion: "2025-06-18",
          initializePayload: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "kin-dry-run", version: "1" },
          },
          getClient: Effect.die("unused"),
        });
        const messages = new Map<string, { chatId: string; messageId: string }>();

        turn.run = Effect.fn("KinDryRun.leadTurn")(
          function* (threadId: ThreadId) {
            const caller = registry.lookup(threadId);
            if (caller === undefined) return;
            const [row] = yield* sql<{ eventIds: string }>`SELECT event_ids AS "eventIds"
            FROM kin_wakeups WHERE org_id = ${orgId} AND wakeup_id = ${caller.wakeupId}`;
            const scope: McpInvocationScope = {
              environmentId: EnvironmentId.make("kin-dry-run"),
              requestNamespace: "kin-dry-run",
              issuedAt: 0,
              capabilities: new Set(),
              client: undefined,
              thread: {
                threadId,
                providerSessionId: `dry-run:${caller.wakeupId}`,
                providerInstanceId: instanceId,
              },
            };
            for (const eventId of yield* decodeEventIds(row?.eventIds ?? "[]")) {
              const event = byId.get(eventId);
              const message = messages.get(eventId);
              const vars: Record<string, string> = {
                ownerChat: direct.chatId,
                event: eventId,
                ...(message === undefined
                  ? {}
                  : { chat: message.chatId, message: message.messageId }),
              };
              for (const call of event?.lead ?? []) {
                const result = yield* server
                  .callTool({
                    name: call.tool,
                    arguments: substituteArguments(call.arguments, vars),
                  })
                  .pipe(
                    Effect.provideService(McpInvocationContext, scope),
                    Effect.provideService(McpSchema.McpServerClient, client),
                    Effect.provideService(Kin.KinServer, kin),
                    Effect.provideService(KinIdentity, identity),
                    Effect.provideService(
                      KinShadowSummary,
                      Context.get(services, KinShadowSummary),
                    ),
                  );
                const outcome = outcomeOf(result);
                toolCalls.push({ tool: call.tool, outcome });
                lines.push(`         ${call.tool}: ${outcome}`);
              }
            }
          },
          Effect.provideContext(context),
          Effect.catchCause((cause) =>
            Effect.sync(() => violations.push(`Lead turn failed: ${Cause.pretty(cause)}`)),
          ),
        );

        const advanceTo = Effect.fn("KinDryRun.advanceTo")(function* (at: number) {
          const now = yield* Clock.currentTimeMillis;
          if (at > now) yield* TestClock.adjust(at - now);
        });
        let wakeups = 0;
        const drain = Effect.fn("KinDryRun.drain")(function* (limit: number) {
          while (true) {
            const next = yield* queue.nextReady(orgId);
            if (next === undefined || !Number.isFinite(next.readyAt) || next.readyAt > limit)
              return;
            if (++wakeups > 200)
              return yield* new KinDryRunError({ message: "The queue did not settle." });
            yield* advanceTo(next.readyAt);
            lines.push(`  ${clockLabel(yield* Clock.currentTimeMillis)} wake-up ${wakeups}`);
            yield* runner.runOnce(orgId, next.agentId);
          }
        });
        const replay = Effect.fn("KinDryRun.replay")(function* (event: DayEvent) {
          const at = isoAt(Date.parse(event.at));
          const base = { orgId, agentId, eventId: event.id, receivedAt: at, dedupeKey: event.id };
          lines.push(`  ${clockLabel(Date.parse(at))} ${event._tag} ${event.id}`);
          switch (event._tag) {
            case "message": {
              const chatId = event.chat === "owner" ? direct.chatId : KinChatId.make(event.chat);
              const sent = yield* chats.send(
                event.from === "owner"
                  ? owner
                  : { _tag: "person", orgId, personId: KinPersonId.make(event.from) },
                { chatId, body: event.body, clientMessageId: event.id },
              );
              messages.set(event.id, { chatId: sent.chatId, messageId: sent.messageId });
              return yield* decodeEvent({
                ...base,
                _tag: "chat.message",
                provenance: sent.author,
                chatId: sent.chatId,
                messageId: sent.messageId,
              });
            }
            case "routine":
              return yield* decodeEvent({
                ...base,
                _tag: "routine",
                provenance: { _tag: "system" },
                routine: event.routine,
                dueAt: at,
              });
            case "github":
              return yield* decodeEvent({
                ...base,
                _tag: "github",
                provenance: { _tag: "system" },
                deliveryId: event.id,
                eventName: event.eventName,
                repo: event.repo,
                summary: event.summary,
                scheduledTaskId: `kin-dry-run:${event.id}`,
                webhookDeliveryId: `kin-dry-run:${event.id}`,
              });
            case "watchdog":
              return yield* decodeEvent({
                ...base,
                _tag: "watchdog",
                provenance: { _tag: "system" },
                finding: event.finding,
                itemIds: [],
              });
          }
        });

        lines.push(
          `Kin shadow dry run: ${day.day}, lead ${agentId} at ${options.level ?? "L0"}`,
          `Memory remote: ${target}`,
          `Local mirror: ${memoryUrl}`,
          "",
          "Replay:",
        );
        for (const event of events) {
          yield* drain(Date.parse(event.at));
          yield* advanceTo(Date.parse(event.at));
          yield* queue.enqueue(yield* replay(event));
        }
        yield* drain(Infinity);

        const [running] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_wakeups
        WHERE org_id = ${orgId} AND status = 'running'`;
        if ((running?.n ?? 0) > 0) violations.push("A wake-up is still running.");
        const unfinished = yield* sql<{
          eventId: string;
          state: string;
        }>`SELECT event_id AS "eventId", state
        FROM kin_events WHERE org_id = ${orgId} AND state <> 'done' ORDER BY event_id`;
        for (const row of unfinished) violations.push(`Event ${row.eventId} ended ${row.state}.`);
        const failed = yield* sql<{
          wakeupId: string;
          status: string;
        }>`SELECT wakeup_id AS "wakeupId", status
        FROM kin_wakeups WHERE org_id = ${orgId} AND status <> 'completed' ORDER BY started_at, wakeup_id`;
        for (const row of failed) violations.push(`Wake-up ${row.wakeupId} ended ${row.status}.`);

        lines.push("", "Owner's direct chat:");
        const posted = yield* sql<{
          createdAt: string;
          authorKind: string;
          body: string;
          widgetId: string | null;
        }>`SELECT created_at AS "createdAt", author_kind AS "authorKind", body, widget_id AS "widgetId"
        FROM kin_messages WHERE org_id = ${orgId} AND chat_id = ${direct.chatId} ORDER BY seq`;
        const widgets = new Map(
          (yield* sql<{
            widgetId: string;
            type: string;
            state: string;
          }>`SELECT widget_id AS "widgetId", type, state_json AS state
          FROM kin_widgets WHERE org_id = ${orgId} AND chat_id = ${direct.chatId} ORDER BY widget_id`).map(
            (row) => [row.widgetId, row],
          ),
        );
        for (const message of posted) {
          const who =
            message.authorKind === "human"
              ? "Owner"
              : message.authorKind === "agent"
                ? day.lead.name
                : "Kin";
          const [first = "", ...rest] = message.body.split("\n");
          lines.push(
            `  ${message.createdAt.slice(11, 16)} ${who}: ${first}`,
            ...rest.map((line) => `         ${line}`),
          );
          const widget = message.widgetId === null ? undefined : widgets.get(message.widgetId);
          if (widget !== undefined) lines.push(...renderWidget(widget.type, widget.state));
        }

        // Check 2: at L0 nothing but people's own messages lands outside the owner's direct chat.
        const outside = yield* sql<{
          chatId: string;
          authorKind: string;
          status: string;
        }>`SELECT chat_id AS "chatId", author_kind AS "authorKind", status
        FROM kin_messages WHERE org_id = ${orgId} AND chat_id <> ${direct.chatId} AND author_kind <> 'human' ORDER BY seq`;
        for (const row of outside)
          violations.push(
            `A ${row.authorKind} message (${row.status}) reached ${row.chatId}, not the owner's direct chat.`,
          );
        // Check 3: nothing executed: no worker, no pending action, no thread but the lead's.
        const [workers] = yield* sql<{
          n: number;
        }>`SELECT COUNT(*) AS n FROM kin_workers WHERE org_id = ${orgId}`;
        if ((workers?.n ?? 0) > 0) violations.push(`${workers?.n} worker(s) launched.`);
        const actions = yield* sql<{
          actionId: string;
          state: string;
        }>`SELECT action_id AS "actionId", state
        FROM kin_pending_actions WHERE org_id = ${orgId} ORDER BY action_id`;
        for (const action of actions)
          violations.push(`Pending action ${action.actionId} exists (${action.state}).`);
        const strays = yield* sql<{ threadId: string }>`SELECT t.thread_id AS "threadId"
        FROM orchestration_v2_projection_threads t
        WHERE NOT EXISTS (SELECT 1 FROM kin_agent_threads a
          WHERE a.org_id = ${orgId} AND a.agent_id = ${agentId} AND a.thread_id = t.thread_id)
        ORDER BY t.thread_id`;
        for (const row of strays)
          violations.push(`Thread ${row.threadId} was started outside the lead.`);
      }).pipe(Effect.provide(lead));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(KinChatRepository.layer, providers, NodeCrypto.layer).pipe(
          Layer.provideMerge(kinServer),
        ),
      ),
      Effect.scoped,
    );

    // Check 1: the mirror gained or changed only this lead's shadow branch.
    const refChanges = diffRefs(refsBefore, yield* listRefs(stateDir, memoryUrl));
    lines.push("", "Local mirror refs:");
    if (refChanges.length === 0) lines.push("  (no change)");
    for (const change of refChanges) {
      lines.push(
        `  ${change.before === null ? "+" : change.after === null ? "-" : "~"} ${change.ref} ${change.before ?? "(new)"} -> ${change.after ?? "(deleted)"}`,
      );
      if (change.ref !== shadow)
        violations.push(`The mirror ref ${change.ref} changed; only ${shadow} may.`);
    }
    const sha = refChanges.find((change) => change.ref === shadow)?.after ?? undefined;
    if (sha === undefined) violations.push(`${shadow} was not written.`);

    lines.push("", "Checks:");
    lines.push(
      violations.length === 0
        ? `  PASS: only ${shadow} written, nothing posted outside the owner's direct chat, nothing executed.`
        : `  FAIL: ${violations.length} violation(s)`,
      ...violations.map((violation) => `  - ${violation}`),
    );

    lines.push("", "Push:");
    let pushed: DryRunReport["pushed"];
    if (violations.length > 0 || sha === undefined) lines.push(`  none: the checks failed.`);
    else if (options.push !== true)
      lines.push(`  none (no --push). With --push: ${sha} -> ${target} ${shadow}`);
    else {
      yield* refuseExistingShadow();
      const source = path.join(stateDir, "push-source");
      yield* memoryGit(stateDir, ["clone", "-q", "--no-checkout", "--", memoryUrl, source]);
      yield* memoryGit(source, ["push", "-q", "--", target, `${sha}:${shadow}`]).pipe(
        withCredentials,
      );
      const landed = (yield* listRefs(stateDir, target).pipe(withCredentials)).get(shadow);
      if (landed !== sha)
        return yield* new KinDryRunError({
          message: `Pushed ${sha} to ${shadow}, but the remote now reports ${landed ?? "no such ref"}.`,
        });
      pushed = { ref: shadow, sha };
      lines.push(`  + ${shadow} ${sha} -> ${target}`);
    }
    return { lines, refChanges, pushed, violations, toolCalls } satisfies DryRunReport;
  },
  (effect) => provideDeterministicTestRuntime(effect),
);

const command = Command.make(
  "kin-shadow-dry-run",
  {
    day: Flag.String("day").pipe(Flag.withDescription("Recorded day (JSON).")),
    stateDir: Flag.String("state-dir").pipe(
      Flag.withDescription("Fresh, empty directory for this run's database and checkouts."),
    ),
    agentId: Flag.String("agent-id").pipe(
      Flag.withDefault("kin-dry-run"),
      Flag.withDescription("Lead id. Writes go to kin/shadow/<id>; use one no real lead has."),
    ),
    memoryUrl: Flag.String("memory-url").pipe(
      Flag.withDescription(
        "Memory remote, mirrored into the state directory for the replay. Defaults to a local fixture remote.",
      ),
      Flag.optional,
    ),
    push: Flag.Boolean("push").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "After every check passes, push kin/shadow/<id> to the memory remote. Its only write.",
      ),
    ),
    credentialHelper: Flag.String("credential-helper").pipe(
      Flag.withDescription("Git credential helper name or absolute path. Never a token."),
      Flag.optional,
    ),
    sshCommand: Flag.String("ssh-command").pipe(
      Flag.withDescription("ssh command naming the deploy key file. Never a secret."),
      Flag.optional,
    ),
    verbose: Flag.Boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (flags) =>
    Effect.gen(function* () {
      const report = yield* runDryRun({
        dayFile: flags.day,
        stateDir: flags.stateDir,
        agentId: flags.agentId,
        memoryUrl: Option.getOrUndefined(flags.memoryUrl),
        credentialHelper: Option.getOrUndefined(flags.credentialHelper),
        sshCommand: Option.getOrUndefined(flags.sshCommand),
        home: Option.getOrUndefined(yield* Config.option(Config.String("HOME"))) || undefined,
        push: flags.push,
      }).pipe(Effect.provideService(References.MinimumLogLevel, flags.verbose ? "Info" : "Error"));
      yield* Console.log(report.lines.join("\n"));
      if (report.violations.length > 0)
        return yield* new KinDryRunError({ message: "The dry run found violations." });
    }),
);

if (import.meta.main) {
  Command.run(command, { version: "1" }).pipe(
    Effect.provide(Vcs.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    NodeRuntime.runMain,
  );
}
