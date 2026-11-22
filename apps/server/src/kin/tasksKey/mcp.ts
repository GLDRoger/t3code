import {
  KinChatError,
  KinMoney,
  KinMoneySummary,
  KinMoneyTotals,
  KinRecordKey,
  KinRecordState,
  KinTrimmedText,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { parseBearerToken } from "../../auth/EnvironmentAuth.ts";
import { SessionStore } from "../../auth/SessionStore.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { clean } from "../connections/ResultText.ts";
import { KinServer, type Services } from "../KinServer.ts";
import { toolVisibility } from "../mcp/toolPolicy.ts";
import {
  findDocs,
  listClients,
  listProjects,
  moneySummary,
  openClient,
  openProject,
  readDoc,
  readsMemory,
  readsMoney,
  searchMemory,
} from "./reads.ts";
import { commentMine, getMine, listMine, setStateMine } from "./tasks.ts";
import { admit, type TasksKeyHolder } from "./TasksKeys.ts";

/** Who this request's key acts as, and Kin's services: provided per request by `auth` below. */
class TasksKeyCaller extends Context.Service<
  TasksKeyCaller,
  { readonly holder: TasksKeyHolder; readonly services: Context.Context<Services> }
>()("t3/kin/tasksKey/mcp/TasksKeyCaller") {}

const TaskSummary = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  state: KinRecordState,
  due: Schema.NullOr(Schema.String),
  dueDay: Schema.optional(Schema.String),
  project: Schema.NullOr(Schema.String),
});
const TaskDetail = Schema.Struct({
  ...TaskSummary.fields,
  brief: Schema.String,
  material: Schema.String,
  comments: Schema.Array(
    Schema.Struct({ by: Schema.String, at: Schema.String, text: Schema.String }),
  ),
});
const shared = { failure: KinChatError, failureMode: "return" as const };
const TaskKey = KinRecordKey.annotate({ description: "The task's key, such as W-12." });
const Ref = Schema.NullOr(Schema.Struct({ key: Schema.String, title: Schema.String }));
const Words = Schema.String.check(Schema.isMaxLength(200));
const ProjectRow = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  client: Ref,
  state: Schema.String,
  lead: Schema.String,
});
const ClientRow = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  prospect: Schema.Boolean,
  active: Schema.Boolean,
});
const DocRow = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  kind: Schema.String,
  client: Ref,
  project: Ref,
  updatedAt: Schema.String,
});
/** A list's page: `next`, passed back as `cursor`, reads the next page. */
const Page = { more: Schema.Boolean, next: Schema.NullOr(Schema.String), material: Schema.String };
const ProjectSheet = Schema.Struct({
  ...ProjectRow.fields,
  target: Schema.NullOr(Schema.String),
  repos: Schema.Array(Schema.String),
  notes: Schema.String,
  pinned: Schema.NullOr(Schema.String),
  material: Schema.String,
  myOpenTasks: Schema.Array(TaskSummary),
  moreTasks: Schema.Boolean,
  docs: Schema.NullOr(Schema.Array(Schema.Struct({ key: Schema.String, title: Schema.String }))),
  moreDocs: Schema.Boolean,
});
const ClientSheet = Schema.Struct({
  ...ClientRow.fields,
  lookedAfterBy: Schema.String,
  notes: Schema.String,
  material: Schema.String,
  contacts: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      name: Schema.String,
      role: Schema.NullOr(Schema.String),
      email: Schema.NullOr(Schema.String),
      phone: Schema.NullOr(Schema.String),
      notes: Schema.String,
    }),
  ),
  moreContacts: Schema.Boolean,
  projects: Schema.Array(
    Schema.Struct({ key: Schema.String, title: Schema.String, state: Schema.String }),
  ),
  moreProjects: Schema.Boolean,
  deals: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        key: Schema.String,
        title: Schema.String,
        state: Schema.String,
        value: Schema.NullOr(KinMoney),
        expected: Schema.NullOr(Schema.String),
      }),
    ),
  ),
  moreDeals: Schema.Boolean,
});
const DocPage = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  client: Ref,
  project: Ref,
  updatedAt: Schema.String,
  version: Schema.Int,
  page: Schema.Int,
  pages: Schema.Int,
  material: Schema.String,
  text: Schema.String,
});
const { owed, received, spent } = KinMoneySummary.fields;
const MoneySheet = Schema.Struct({
  privateLeftOut: Schema.Boolean,
  material: Schema.String,
  asOf: Schema.String,
  thisMonth: Schema.String,
  lastMonth: Schema.String,
  financialYear: Schema.String,
  owed: Schema.Struct({
    total: owed.fields.total,
    overdue: owed.fields.overdue,
    invoices: owed.fields.invoices,
    overdueInvoices: owed.fields.overdueInvoices,
    byClient: Schema.Array(
      Schema.Struct({
        client: Ref,
        owed: KinMoneyTotals,
        overdue: KinMoneyTotals,
        invoices: Schema.Int,
        oldestOverdueDays: Schema.NullOr(Schema.Int),
      }),
    ),
    moreClients: Schema.Int,
  }),
  received: Schema.Struct({ ...received.fields, thisFinancialYear: KinMoneyTotals }),
  spent: Schema.Struct({ ...spent.fields, thisFinancialYear: KinMoneyTotals }),
  coming: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      title: Schema.String,
      list: Schema.String,
      state: Schema.String,
      what: Schema.String,
      at: Schema.String,
      amount: Schema.NullOr(Schema.Struct({ minor: Schema.Number, currency: Schema.String })),
      late: Schema.Boolean,
    }),
  ),
  moreComing: Schema.Int,
});
const MemoryLines = Schema.Struct({
  material: Schema.String,
  lines: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      text: Schema.String,
      from: Schema.String,
      day: Schema.String,
    }),
  ),
  more: Schema.Boolean,
});

const unavailable = new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });

const TasksKeyToolkit = Toolkit.make(
  // No `parameters`: an empty Struct serializes to a schema MCP clients reject.
  Tool.make("list_my_tasks", {
    ...shared,
    description:
      "List the open Kin tasks held by the person this key belongs to, soonest due first: key, title, state, due date and project.",
    success: Schema.Struct({
      tasks: Schema.Array(TaskSummary),
      more: Schema.Boolean,
      material: Schema.String,
    }),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("get_task", {
    ...shared,
    description:
      "Read one of that person's tasks: title, brief, state, due date, project and the newest comments. A task they don't hold is not found.",
    parameters: Schema.Struct({ key: TaskKey }),
    success: TaskDetail,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("comment_on_task", {
    ...shared,
    description:
      "Add a comment to one of that person's tasks. It is posted as them, marked as from their coding agent. The same text again posts nothing new.",
    parameters: Schema.Struct({
      key: TaskKey,
      text: KinTrimmedText.check(Schema.isMaxLength(4_000)).annotate({
        description: "The comment, in plain words.",
      }),
    }),
    success: Schema.Struct({ key: Schema.String, posted: Schema.Boolean }),
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("set_task_state", {
    ...shared,
    description:
      "Set one of that person's tasks to doing (started), done, or open (not started). The change is theirs, marked as from their coding agent.",
    parameters: Schema.Struct({
      key: TaskKey,
      state: Schema.Literals(["open", "doing", "done"]),
    }),
    success: TaskDetail,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("find", {
    ...shared,
    description:
      "Find projects, clients or docs the person this key belongs to can see in Kin: by words in a name or title (docs: also in their text), and docs or projects by client key, docs by project key. Returns keys and titles a page at a time; pass next back as cursor for the next page. Open one with open_project, open_client or read_doc. Clients, projects, deals and docs marked private, and everything under a private client or project, stay in Kin and are not shown here.",
    parameters: Schema.Struct({
      kind: Schema.Literals(["projects", "clients", "docs"]),
      text: Schema.optional(
        Words.annotate({ description: "Words in a name or title; for docs, also in the text." }),
      ),
      client: Schema.optional(
        KinRecordKey.annotate({ description: "Projects or docs: only this client's, by key." }),
      ),
      project: Schema.optional(
        KinRecordKey.annotate({ description: "Docs: only this project's, by key." }),
      ),
      mine: Schema.optional(
        Schema.Boolean.annotate({ description: "Projects: only those the person is on." }),
      ),
      cursor: Schema.optional(
        Schema.String.check(Schema.isMaxLength(200)).annotate({
          description: "The next value of the page before, for the page after it.",
        }),
      ),
      limit: Schema.optional(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).annotate({
          description: "Rows on a page, 50 at most (the default).",
        }),
      ),
    }),
    success: Schema.Union([
      Schema.Struct({ projects: Schema.Array(ProjectRow), ...Page }),
      Schema.Struct({ clients: Schema.Array(ClientRow), ...Page }),
      Schema.Struct({ docs: Schema.Array(DocRow), ...Page }),
    ]),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("open_project", {
    ...shared,
    description:
      "Open one project by its key, such as a task's project: client, state, lead, repositories, notes, the person's own open tasks on it and its docs. moreTasks or moreDocs is true when a list was cut. One they can't see is not found. Clients, projects, deals and docs marked private, and everything under a private client or project, stay in Kin and are not shown here.",
    parameters: Schema.Struct({
      key: KinRecordKey.annotate({ description: "The project's key, such as P-3." }),
    }),
    success: ProjectSheet,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("open_client", {
    ...shared,
    description:
      "Open one client by its key: notes, contacts, projects, and deals when the person can see deals. moreContacts, moreProjects or moreDeals is true when a list was cut. One they can't see is not found. Clients, projects, deals and docs marked private, and everything under a private client or project, stay in Kin and are not shown here.",
    parameters: Schema.Struct({
      key: KinRecordKey.annotate({ description: "The client's key, such as C-4." }),
    }),
    success: ClientSheet,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("read_doc", {
    ...shared,
    description:
      "Read a text doc by its key, one page at a time: the answer gives page, pages and version. For the next page pass page and that version; if the doc changed meanwhile you are told to start again. A doc that is a file has no text here. Clients, projects, deals and docs marked private, and everything under a private client or project, stay in Kin and are not shown here.",
    parameters: Schema.Struct({
      key: KinRecordKey.annotate({ description: "The doc's key, such as D-7." }),
      page: Schema.optional(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
          description: "Which page, from 1 (the default).",
        }),
      ),
      version: Schema.optional(
        Schema.Int.annotate({ description: "After page 1: the version page 1 gave." }),
      ),
    }),
    success: DocPage,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("money_summary", {
    ...shared,
    description:
      "What the person's Money page shows: what clients owe and what is overdue (and the first owing clients), money in and out this month, last month and this financial year, and money coming due in the next 30 days, each by its entry's key. Listed only for people who have Money. Entries a person marked private, and entries under a private client or project, stay in Kin: they are in no figure or line here, and privateLeftOut is true when leaving them out changed this answer.",
    success: MoneySheet,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("search_memory", {
    ...shared,
    description:
      "For owners and co-owners: search what Kin remembers that the whole team may know, by words. Anything kept to one person stays in Kin and is not shown here. Each line says who it came from and the day it was recorded; more is true when there are more lines than shown.",
    parameters: Schema.Struct({
      text: Words.check(Schema.isMinLength(1)).annotate({ description: "Words to look for." }),
    }),
    success: MemoryLines,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
);
export const TASKS_KEY_TOOLS = Object.keys(TasksKeyToolkit.tools);
/** Listed, and callable, only for a person whose own screens open Money or Memory now. */
const GATED: Partial<
  Record<string, (holder: TasksKeyHolder) => Effect.Effect<boolean, KinChatError, Services>>
> = {
  money_summary: readsMoney,
  search_memory: readsMemory,
};

// Read from the request, not declared: tool services are built with the server, and the holder
// exists only per request. Without `auth` in front there is none, and every call fails.
// Every answer passes here: text a reader can't see but a model reads is taken out of it.
const asHolder = Effect.fnUntraced(function* <A, R extends Services>(
  run: (holder: TasksKeyHolder) => Effect.Effect<A, KinChatError, R>,
) {
  const caller = yield* Effect.serviceOption(TasksKeyCaller);
  if (Option.isNone(caller)) return yield* unavailable;
  return cleaned(
    yield* run(caller.value.holder).pipe(Effect.provideContext(caller.value.services)),
  );
});

/** `value` with every string in it cleaned (`ResultText.ts` `clean`): same shape, same types. */
const cleaned = <A>(value: A): A => cleanedValue(value) as A;
const cleanedValue = (value: unknown): unknown =>
  typeof value === "string"
    ? clean(value)
    : Array.isArray(value)
      ? value.map(cleanedValue)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([key, one]) => [key, cleanedValue(one)]))
        : value;

// The key's holder is the only authority here, checked by the service; T3's caller
// declarations describe threads and clients, which a person's key is neither.
const handlers = McpToolAccess.toLayer(TasksKeyToolkit, {
  list_my_tasks: McpToolAccess.reads(Effect.fn("KinTasksKeyTools.list")(() => asHolder(listMine))),
  get_task: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.get")((input) => asHolder((holder) => getMine(holder, input.key))),
  ),
  comment_on_task: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.comment")((input) =>
      asHolder((holder) => commentMine(holder, input)),
    ),
  ),
  set_task_state: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.setState")((input) =>
      asHolder((holder) => setStateMine(holder, input)),
    ),
  ),
  find: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.find")(function* ({ kind, ...input }) {
      if (kind === "projects") return yield* asHolder((holder) => listProjects(holder, input));
      if (kind === "clients") return yield* asHolder((holder) => listClients(holder, input));
      return yield* asHolder((holder) => findDocs(holder, input));
    }),
  ),
  open_project: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.openProject")((input) =>
      asHolder((holder) => openProject(holder, input.key)),
    ),
  ),
  open_client: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.openClient")((input) =>
      asHolder((holder) => openClient(holder, input.key)),
    ),
  ),
  read_doc: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.readDoc")((input) => asHolder((holder) => readDoc(holder, input))),
  ),
  money_summary: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.money")(() => asHolder(moneySummary)),
  ),
  search_memory: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.memory")((input) =>
      asHolder((holder) => searchMemory(holder, input.text)),
    ),
  ),
});

// Untraced: it runs for every tool on each list and call.
const listed = toolVisibility(
  Effect.fnUntraced(function* (name: string) {
    const gate = GATED[name];
    if (gate === undefined) return true;
    return yield* asHolder(gate).pipe(Effect.orElseSucceed(() => false));
  }),
);

const refused = HttpServerResponse.jsonUnsafe(
  { error: "invalid_kin_key", message: "A live Kin coding agent key is required." },
  { status: 401, headers: { "cache-control": "no-store", "www-authenticate": "Bearer" } },
);

type Admitted = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  TasksKeyCaller
>;
/** Every request, every tool call: a bearer key only, re-read each time, so revoking is at once. */
// Stated, not inferred: inferred, the checker's file order can leave these as `unknown`.
const auth = HttpRouter.middleware<{ provides: TasksKeyCaller }>()<
  Types.unhandled,
  HttpServerRequest.HttpServerRequest,
  never,
  KinServer
>(
  Effect.gen(function* () {
    const kin = yield* KinServer;
    const sessions = yield* Effect.serviceOption(SessionStore);
    // Untraced: a span here would wrap the tool call; the HTTP server span already covers it.
    return Effect.fnUntraced(function* (effect: Admitted) {
      if (Option.isNone(kin.services) || Option.isNone(sessions))
        return HttpServerResponse.empty({ status: 503 });
      const services = kin.services.value;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const holder = yield* admit(parseBearerToken(request) ?? "").pipe(
        Effect.provideContext(services),
        Effect.provideService(SessionStore, sessions.value),
        Effect.orElseSucceed(() => Option.none<TasksKeyHolder>()),
      );
      if (Option.isNone(holder)) return refused;
      return yield* effect.pipe(
        Effect.provideService(TasksKeyCaller, { holder: holder.value, services }),
      );
    });
  }),
).layer;

/**
 * The T3 transport admits only what `auth` would: no agent token (the registry resolves none
 * here) and no outside MCP client, only a live key, as a caller with no thread.
 */
const keyAsClient = Layer.mergeAll(
  Layer.effect(
    McpSessionRegistry.McpSessionRegistry,
    Effect.gen(function* () {
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      return {
        ...registry,
        resolve: Effect.fn("KinTasksKey.resolveNoAgent")(() => Effect.undefined),
      };
    }),
  ),
  Layer.effect(
    McpHttpServer.McpClientAuthenticator,
    Effect.gen(function* () {
      const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
      return McpHttpServer.McpClientAuthenticator.of({
        // The holder `auth` admitted for this request; with none in front, nobody is.
        authenticate: Effect.fn("KinTasksKey.authenticate")(function* () {
          const caller = yield* Effect.serviceOption(TasksKeyCaller);
          if (Option.isNone(caller)) return undefined;
          return {
            environmentId,
            requestNamespace: `kin-tasks:${caller.value.holder.sessionId}`,
            thread: undefined,
            client: undefined,
            capabilities: new Set(),
            issuedAt: yield* Clock.currentTimeMillis,
          };
        }),
      });
    }),
  ),
);

/** `/kin/you/mcp`: these tools and nothing else, for a person's own coding agent. */
const endpoint = McpHttpServer.layerMcpTransport(
  Layer.mergeAll(McpHttpServer.toolkitRegistration(TasksKeyToolkit, handlers), listed),
).pipe(
  Layer.provide(keyAsClient),
  Layer.fresh,
  Layer.updateService(HttpRouter.HttpRouter, (router) => router.prefixed("/kin/you")),
  Layer.provide(auth),
);

/** Mounted only while Kin runs, as `/kin/mcp` is. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const kin = yield* KinServer;
    return Option.isSome(kin.services) ? endpoint : Layer.empty;
  }),
);
