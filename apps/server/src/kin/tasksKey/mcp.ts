import * as KinShell from "../shell/KinShell.ts";
import type { SectionId } from "../shell/sections.ts";
import { MATERIAL } from "../you/projection.ts";
import {
  KinChatError,
  KinChatId,
  KinDay,
  KinDocumentLine,
  KinFieldValue,
  KinMoney,
  KinNumber,
  KinNumberDecimal,
  KinSignedMoney,
  KinTouchKind,
  KinMoneySummary,
  KinMoneyTotals,
  KinRecordKey,
  KinRecordState,
  KinTrimmedText,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { parseBearerToken } from "../../auth/EnvironmentAuth.ts";
import { SessionStore } from "../../auth/SessionStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { clean } from "../connections/ResultText.ts";
import { KinServer, type Services } from "../KinServer.ts";
import { toolVisibility } from "../mcp/toolPolicy.ts";
import { orgOwner, toolName, toolNamesOf } from "../work/toolNames.ts";
import {
  findDocs,
  listClients,
  listProjects,
  moneySummary,
  openClient,
  openProject,
  readDoc,
  readsClients,
  readsDocs,
  readsMemory,
  readsMoney,
  searchMemory,
} from "./reads.ts";
import { CodingAgentCall } from "../work/keyCall.ts";
import * as Acts from "./acts.ts";
import { askAgent, readChat } from "./chat.ts";
import { listPeople } from "./people.ts";
import {
  commentMine,
  createProject,
  createTask,
  getMine,
  listMine,
  listSeenBy,
  setStateMine,
  updateProject,
  updateTask,
} from "./tasks.ts";
import { admit, type TasksKeyHolder } from "./TasksKeys.ts";

/** Who this request's key acts as, and Kin's services: provided per request by `auth` below. */
class TasksKeyCaller extends Context.Service<
  TasksKeyCaller,
  {
    readonly holder: TasksKeyHolder;
    readonly services: Context.Context<Services>;
    /** The host's files, where a document is made, as Kin's own MCP gives them. */
    readonly files: Option.Option<Context.Context<FileSystem.FileSystem | ServerConfig>>;
  }
>()("t3/kin/tasksKey/mcp/TasksKeyCaller") {}

const TaskSummary = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  state: KinRecordState,
  due: Schema.NullOr(Schema.String),
  dueDay: Schema.optional(Schema.String),
  project: Schema.NullOr(Schema.String),
  holder: Schema.optional(Schema.String),
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

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120));
const PersonName = Name.annotate({ description: "A name as list_people gives it, or me." });
const Day = KinDay.annotate({ description: "A day, YYYY-MM-DD." });
const TaskTitle = KinTrimmedText.check(Schema.isMinLength(1), Schema.isMaxLength(280));
const Brief = Schema.String.check(Schema.isMaxLength(4_000)).annotate({
  description: "What the task is, in plain words; replaces the brief.",
});
const AlsoOn = Schema.Array(PersonName)
  .check(Schema.isMaxLength(20))
  .annotate({ description: "Everyone else on it, by name; [] takes everyone off." });
const ProjectKey = KinRecordKey.annotate({ description: "A project's key, such as P-3." });
const ClientKey = KinRecordKey.annotate({ description: "A client's key, such as C-4." });
const ProjectFields = {
  client: Schema.optional(ClientKey),
  lead: Schema.optional(PersonName.annotate({ description: "Who leads it, by name." })),
  target: Schema.optional(Day.annotate({ description: "The day it should be done, YYYY-MM-DD." })),
  notes: Schema.optional(
    Schema.String.check(Schema.isMaxLength(4_000)).annotate({ description: "Replaces its notes." }),
  ),
};

const ClientRef = Schema.NullOr(Schema.Struct({ key: Schema.String, title: Schema.String }));
const Contact = {
  name: Name,
  role: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
  email: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  phone: Schema.optional(Schema.String.check(Schema.isMaxLength(60))),
};
const Notes = Schema.String.check(Schema.isMaxLength(4_000));
const Step = Schema.Struct({
  title: TaskTitle,
  due: Schema.optional(Day),
}).annotate({ description: "The next step: a task for whoever is doing it, with its day." });
const DealRow = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  client: ClientRef,
  state: Schema.String,
  stage: Schema.NullOr(Schema.String),
  value: Schema.NullOr(KinMoney),
  expected: Schema.NullOr(Schema.String),
  holder: Schema.String,
});
const MoneyRow = {
  key: Schema.String,
  title: Schema.String,
  state: Schema.String,
  client: ClientRef,
  amount: Schema.NullOr(KinSignedMoney),
  due: Schema.NullOr(Schema.String),
};
const Fields = Schema.Record(Schema.String, Schema.NullOr(KinFieldValue));
const Entry = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  state: Schema.String,
  fields: Fields,
});
const ListId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(60)).annotate({
  description: "A list's id, as list_lists gives it.",
});
const EntryState = Schema.Literals(["open", "doing", "waiting", "done"]);
const Cursor = Schema.String.check(Schema.isMaxLength(200)).annotate({
  description: "The next value of the page before, for the page after it.",
});
const ChatLine = Schema.Struct({
  seq: Schema.Int,
  by: Schema.String,
  at: Schema.String,
  text: Schema.String,
});

const TasksKeyToolkit = Toolkit.make(
  Tool.make("list_people", {
    ...shared,
    description:
      "List the company's people and the agents the person this key belongs to may message, by name: kind is person or agent, and role is owner, co-owner, teammate or you for a person, what it does for an agent. Wherever a tool takes a holder, lead or someone on a task, pass a name from here.",
    success: Schema.Struct({
      people: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          kind: Schema.Literals(["person", "agent"]),
          role: Schema.String,
        }),
      ),
    }),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("list_tasks", {
    ...shared,
    description:
      "List the tasks the person this key belongs to can see in Kin, everyone's, soonest due first: by holder (a name from list_people), project key, or state (open, doing, waiting or done; all but done when left out). Each row gives the task's key, and its holder when that is not the person. A page at a time: pass next back as cursor.",
    parameters: Schema.Struct({
      holder: Schema.optional(PersonName.annotate({ description: "Only tasks this one holds." })),
      project: Schema.optional(ProjectKey),
      state: Schema.optional(Schema.Literals(["open", "doing", "waiting", "done"])),
      cursor: Schema.optional(
        Schema.String.check(Schema.isMaxLength(200)).annotate({
          description: "The next value of the page before, for the page after it.",
        }),
      ),
    }),
    success: Schema.Struct({
      tasks: Schema.Array(TaskSummary),
      more: Schema.Boolean,
      next: Schema.NullOr(Schema.String),
      material: Schema.String,
    }),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("create_task", {
    ...shared,
    description:
      "Make a task in Kin as the person this key belongs to, marked as from their coding agent, as they would in the app: whoever holds it is told, and an agent given it starts on it. holder is a name from list_people; left out, the task is the person's own. The same request again from this key makes nothing new and answers with the same task, by its key.",
    parameters: Schema.Struct({
      title: TaskTitle.annotate({ description: "What to do, in a few words." }),
      brief: Schema.optional(Brief),
      holder: Schema.optional(PersonName.annotate({ description: "Who it is for, by name." })),
      project: Schema.optional(ProjectKey),
      client: Schema.optional(ClientKey),
      due: Schema.optional(Day.annotate({ description: "The day it is due, YYYY-MM-DD." })),
      alsoOn: Schema.optional(AlsoOn),
    }),
    success: TaskDetail,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("update_task", {
    ...shared,
    description:
      "Change a task as the person this key belongs to may in the app, marked as from their coding agent: title, brief, due day, project, client, who else is on it, and holder to give it to someone (they are told, as in the app). What is left out stays; null clears a due day, project or client. A change their app refuses them is refused here, saying who can; they may comment instead.",
    parameters: Schema.Struct({
      key: TaskKey,
      title: Schema.optional(TaskTitle),
      brief: Schema.optional(Brief),
      holder: Schema.optional(PersonName.annotate({ description: "Give it to this one." })),
      due: Schema.optional(Schema.NullOr(Day)),
      project: Schema.optional(Schema.NullOr(ProjectKey)),
      client: Schema.optional(Schema.NullOr(ClientKey)),
      alsoOn: Schema.optional(AlsoOn),
    }),
    success: TaskDetail,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("create_project", {
    ...shared,
    description:
      "For owners and co-owners: make a project as the person, marked as from their coding agent: title, client key, lead (a name from list_people; the person when left out), target day and notes. The same request again from this key makes nothing new. Answers as open_project does, with the project's key.",
    parameters: Schema.Struct({ title: Name, ...ProjectFields }),
    success: ProjectSheet,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("update_project", {
    ...shared,
    description:
      "For owners and co-owners: change a project by its key, as the person, marked as from their coding agent: title, client, lead, target day, notes, or state (done, or open to reopen it; done is refused while open tasks point at it). What is left out stays. Answers as open_project does.",
    parameters: Schema.Struct({
      key: ProjectKey,
      title: Schema.optional(Name),
      ...ProjectFields,
      state: Schema.optional(Schema.Literals(["open", "done"])),
    }),
    success: ProjectSheet,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  // No `parameters`: an empty Struct serializes to a schema MCP clients reject.
  Tool.make("create_client", {
    ...shared,
    description:
      "Add a client, a prospect or a vendor in Kin as the person this key belongs to, marked as from their coding agent, as their Clients screen adds one, with its first contact if given. The same request again adds nothing new. Answers as open_client does, with the client's key.",
    parameters: Schema.Struct({
      name: Name,
      prospect: Schema.optional(
        Schema.Boolean.annotate({ description: "A client we haven't sold to yet." }),
      ),
      vendor: Schema.optional(
        Schema.Boolean.annotate({ description: "Someone we buy from, not a client." }),
      ),
      notes: Schema.optional(Notes),
      contact: Schema.optional(Schema.Struct(Contact)),
    }),
    success: ClientSheet,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("update_client", {
    ...shared,
    description:
      "Change a client by its key as the person may on its page, marked as from their coding agent: name, notes, prospect or client, who looks after it (a name from list_people), add a contact (newContact) or change one by its key (contact). What is left out stays. Answers as open_client does.",
    parameters: Schema.Struct({
      key: ClientKey,
      name: Schema.optional(Name),
      notes: Schema.optional(Notes),
      prospect: Schema.optional(Schema.Boolean),
      lookedAfterBy: Schema.optional(PersonName),
      newContact: Schema.optional(Schema.Struct({ ...Contact, notes: Schema.optional(Notes) })),
      contact: Schema.optional(
        Schema.Struct({
          key: KinRecordKey.annotate({ description: "The contact's key, from open_client." }),
          name: Schema.optional(Name),
          role: Schema.optional(Schema.NullOr(Contact.role.schema)),
          email: Schema.optional(Schema.NullOr(Contact.email.schema)),
          phone: Schema.optional(Schema.NullOr(Contact.phone.schema)),
          notes: Schema.optional(Notes),
        }),
      ),
    }),
    success: ClientSheet,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("log_contact", {
    ...shared,
    description:
      "Log a call, meeting, email or message with a client, as the person, marked as from their coding agent, as their client page logs one; with next, the follow-up becomes their task in the same step. The same request again logs nothing new.",
    parameters: Schema.Struct({
      client: ClientKey,
      kind: KinTouchKind,
      note: Schema.optional(Notes),
      day: Schema.optional(Day.annotate({ description: "When it happened; today if left out." })),
      next: Schema.optional(Step),
    }),
    success: Schema.Struct({ client: Schema.String, logged: Schema.Boolean }),
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("list_deals", {
    ...shared,
    description:
      "List the deals the person can see in Kin, open ones unless a state is asked: by client key, holder (a name from list_people) or state (open, won or lost). Each gives its key, client, stage, value, expected day and holder.",
    parameters: Schema.Struct({
      client: Schema.optional(ClientKey),
      holder: Schema.optional(PersonName),
      state: Schema.optional(Schema.Literals(["open", "won", "lost"])),
    }),
    success: Schema.Struct({
      deals: Schema.Array(DealRow),
      more: Schema.Boolean,
      material: Schema.String,
    }),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("create_deal", {
    ...shared,
    description:
      "Add a deal for a client or prospect as the person, marked as from their coding agent, as their Deals screen adds one: title, stage (a stage id; the first if left out), value, expected day, notes and a first next step. The same request again adds nothing new. Answers with the deal and its key.",
    parameters: Schema.Struct({
      client: ClientKey,
      title: TaskTitle,
      stage: Schema.optional(Schema.String.check(Schema.isMaxLength(60))),
      value: Schema.optional(KinMoney),
      expected: Schema.optional(Day),
      notes: Schema.optional(Notes),
      nextStep: Schema.optional(Step),
    }),
    success: Schema.Struct({ ...DealRow.fields, material: Schema.String }),
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("update_deal", {
    ...shared,
    description:
      "Change a deal by its key as the person may, marked as from their coding agent: title, notes, value, expected day, its stage, won, lost (with lostReason) or reopen, and a next step. What is left out stays; null clears value or expected day.",
    parameters: Schema.Struct({
      key: KinRecordKey.annotate({ description: "The deal's key." }),
      title: Schema.optional(TaskTitle),
      notes: Schema.optional(Notes),
      value: Schema.optional(Schema.NullOr(KinMoney)),
      expected: Schema.optional(Schema.NullOr(Day)),
      stage: Schema.optional(Schema.String.check(Schema.isMaxLength(60))),
      outcome: Schema.optional(Schema.Literals(["won", "lost", "reopen"])),
      lostReason: Schema.optional(TaskTitle),
      nextStep: Schema.optional(Step),
    }),
    success: Schema.Struct({ ...DealRow.fields, material: Schema.String }),
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("add_promise", {
    ...shared,
    description:
      "Record a promise to or from a client as the person, marked as from their coding agent, as their client page adds one: what was promised, by when, and theyOwe when the client owes it (then whoever looks after the client chases it). It is a task: close it with close_promise. The same request again adds nothing new.",
    parameters: Schema.Struct({
      client: ClientKey,
      what: TaskTitle,
      due: Schema.optional(Day),
      theyOwe: Schema.optional(Schema.Boolean),
      deal: Schema.optional(KinRecordKey.annotate({ description: "The deal it sits on." })),
      where: Schema.optional(
        Schema.String.check(Schema.isMaxLength(280)).annotate({
          description: "Where it was promised, in the person's words.",
        }),
      ),
    }),
    success: TaskDetail,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("close_promise", {
    ...shared,
    description:
      "Mark a promise kept, by its key, as the person, marked as from their coding agent; who may is as in the app.",
    parameters: Schema.Struct({ key: TaskKey }),
    success: TaskDetail,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("write_doc", {
    ...shared,
    description:
      'Write a new version of one section of a text doc, as the person may in their Docs editor, marked as from their coding agent: section is its heading as the doc has it ("" for the text before the first heading), text its new words. Pass the version read_doc gave: if the doc changed since, nothing is written and you are told to read it again. Every earlier version stays in its history. New docs are made by an agent: ask_agent.',
    parameters: Schema.Struct({
      key: KinRecordKey.annotate({ description: "The doc's key, such as D-7." }),
      version: Schema.Int.annotate({ description: "The version read_doc gave." }),
      section: Schema.String.check(Schema.isMaxLength(200)),
      text: Schema.String.check(Schema.isMaxLength(100_000)),
    }),
    success: Schema.Struct({ key: Schema.String, title: Schema.String, version: Schema.Int }),
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("list_invoices", {
    ...shared,
    description:
      "List the invoices the person's Money screens show, newest due first, by client key or state; each with its key, client, amount and due day. A page at a time: pass next back as cursor.",
    parameters: Schema.Struct({
      client: Schema.optional(ClientKey),
      state: Schema.optional(EntryState),
      cursor: Schema.optional(Cursor),
    }),
    success: Schema.Struct({
      invoices: Schema.Array(Schema.Struct(MoneyRow)),
      more: Schema.Boolean,
      next: Schema.NullOr(Schema.String),
      material: Schema.String,
    }),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("open_invoice", {
    ...shared,
    description:
      "Open one invoice by its key: client, amount, state, due day, notes and its lines. Issuing it, sending it and recording a payment stay a tap in Kin.",
    parameters: Schema.Struct({
      key: KinRecordKey.annotate({ description: "The invoice's key." }),
    }),
    success: Schema.Struct({
      ...MoneyRow,
      notes: Schema.String,
      lines: Schema.NullOr(Schema.Array(KinDocumentLine)),
      material: Schema.String,
    }),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("draft_invoice", {
    ...shared,
    description:
      "For owners and co-owners with Money: draft an invoice for a client from its lines, as their New invoice form does, marked as from their coding agent. It stays a draft that nobody owes until the person issues it in Kin; nothing is numbered or sent. problems says what the draft lacks. The same request again drafts nothing new.",
    parameters: Schema.Struct({
      client: ClientKey,
      title: TaskTitle,
      lines: Schema.Array(KinDocumentLine).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
      due: Schema.optional(Day),
      notes: Schema.optional(Notes),
      project: Schema.optional(ProjectKey),
    }),
    success: Schema.Struct({ key: Schema.String, problems: Schema.Array(Schema.String) }),
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("record_expense", {
    ...shared,
    description:
      "For owners and co-owners with Money: record an expense the company had, as their New expense form does, marked as from their coding agent: what, amount, the day it was paid (a day ahead makes it to pay), who was paid and its category. The same request again records nothing new.",
    parameters: Schema.Struct({
      title: TaskTitle,
      amount: KinSignedMoney,
      day: Day,
      vendor: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
      category: Schema.optional(Schema.String.check(Schema.isMaxLength(60))),
    }),
    success: Schema.Struct({ key: Schema.String }),
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("list_lists", {
    ...shared,
    description:
      "List the company's own lists the person can see in Kin (not tasks, clients or money, which have their own tools): each list's id, name, states, categories and fields, for list_entries, add_entry and update_entry.",
    success: Schema.Struct({
      lists: Schema.Array(
        Schema.Struct({
          list: Schema.String,
          name: Schema.String,
          states: Schema.Array(Schema.String),
          categories: Schema.Array(Schema.String),
          fields: Schema.Array(
            Schema.Struct({
              key: Schema.String,
              label: Schema.String,
              type: Schema.String,
              choices: Schema.optional(Schema.Array(Schema.String)),
            }),
          ),
        }),
      ),
    }),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("list_entries", {
    ...shared,
    description:
      "List the entries of one of the company's lists that the person can see, by state, a page at a time: each with its key, title, state and fields.",
    parameters: Schema.Struct({
      list: ListId,
      state: Schema.optional(EntryState),
      cursor: Schema.optional(Cursor),
    }),
    success: Schema.Struct({
      entries: Schema.Array(Schema.Struct({ ...MoneyRow, fields: Fields })),
      more: Schema.Boolean,
      next: Schema.NullOr(Schema.String),
      material: Schema.String,
    }),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("add_entry", {
    ...shared,
    description:
      "Add an entry to one of the company's lists as the person, marked as from their coding agent: its title and fields by their keys from list_lists. The same request again adds nothing new.",
    parameters: Schema.Struct({
      list: ListId,
      title: TaskTitle,
      fields: Schema.optional(Fields),
    }),
    success: Entry,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("update_entry", {
    ...shared,
    description:
      "Change an entry of one of the company's lists by its key as the person may, marked as from their coding agent: title, state or fields (null clears one). What is left out stays.",
    parameters: Schema.Struct({
      key: KinRecordKey.annotate({ description: "The entry's key." }),
      title: Schema.optional(TaskTitle),
      state: Schema.optional(EntryState),
      fields: Schema.optional(Fields),
    }),
    success: Entry,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("read_numbers", {
    ...shared,
    description:
      "The numbers the company watches that the person can see: without number, each with its key, latest value and whether it is late; with a number's key, its values between from and to.",
    parameters: Schema.Struct({
      number: Schema.optional(KinRecordKey.annotate({ description: "A number's key." })),
      from: Schema.optional(Day),
      to: Schema.optional(Day),
    }),
    success: Schema.Struct({
      numbers: Schema.NullOr(
        Schema.Array(
          Schema.Struct({
            key: Schema.String,
            name: Schema.String,
            unit: Schema.NullOr(Schema.String),
            value: KinNumber.fields.value,
            asOf: Schema.NullOr(Schema.String),
            late: Schema.Boolean,
            canRecord: Schema.Boolean,
          }),
        ),
      ),
      values: Schema.NullOr(
        Schema.Array(
          Schema.Struct({ value: Schema.String, asOf: Schema.String, by: Schema.String }),
        ),
      ),
    }),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("record_number", {
    ...shared,
    description:
      "Record a watched number's value for a day as the person, as their Numbers screen does, where read_numbers says canRecord. The same value again records nothing new.",
    parameters: Schema.Struct({
      number: KinRecordKey.annotate({ description: "The number's key." }),
      value: KinNumberDecimal.annotate({ description: "The value, such as 42 or 3.5." }),
      day: Day,
    }),
    success: Schema.Struct({ number: Schema.String, recorded: Schema.Boolean }),
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("list_waiting", {
    ...shared,
    description:
      "What waits on the person now, as their Needs you list shows it: cards to answer, their late or due tasks, overdue money and news, each saying what it is. Cards are answered by the person in Kin, never here.",
    success: Schema.Struct({
      waiting: Schema.Array(
        Schema.Struct({
          what: Schema.Literals(["task", "card", "money", "news"]),
          key: Schema.NullOr(Schema.String),
          text: Schema.String,
          late: Schema.Boolean,
          answer: Schema.NullOr(Schema.String),
        }),
      ),
      material: Schema.String,
    }),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("ask_agent", {
    ...shared,
    description:
      "Send a message to one of Kin's agents (a name from list_people), as the person, in their own chat with it; it starts that agent's turn as their message would, and the chat shows it came from their coding agent. Use it for what an agent does for them: remember something, set a reminder, draft a quote or a new doc, look into something. Waits up to 45 seconds for the reply; if the agent is still working, read it later with read_chat and the chat's id. Anything the agent then wants that needs the person's Confirm becomes a card for them in Kin.",
    parameters: Schema.Struct({
      agent: PersonName.annotate({ description: "The agent's name, as list_people gives it." }),
      text: KinTrimmedText.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)).annotate({
        description: "The message, in plain words.",
      }),
    }),
    success: Schema.Struct({
      chat: Schema.String,
      sent: Schema.Int,
      replied: Schema.Boolean,
      reply: Schema.NullOr(ChatLine),
      note: Schema.NullOr(Schema.String),
      material: Schema.String,
    }),
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("read_chat", {
    ...shared,
    description:
      "Read the newest messages of one of the person's chats, newest last, text only: by chat id (as ask_agent gives it), or their chat with an agent by its name. A page at a time: pass before back for older messages.",
    parameters: Schema.Struct({
      chat: Schema.optional(KinChatId.annotate({ description: "The chat's id." })),
      agent: Schema.optional(PersonName.annotate({ description: "An agent's name." })),
      before: Schema.optional(
        Schema.Int.annotate({ description: "The before value of the page after, for older ones." }),
      ),
    }),
    success: Schema.Struct({
      chat: Schema.String,
      messages: Schema.Array(ChatLine),
      more: Schema.Boolean,
      before: Schema.NullOr(Schema.Int),
      material: Schema.String,
    }),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
  Tool.make("list_my_tasks", {
    ...shared,
    description:
      "List the open Kin tasks the person this key belongs to holds or is on, soonest due first: key, title, state, due date, project, and holder when someone else holds it. For everyone's tasks, or by holder, project or state: list_tasks.",
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
      "Read one task the person this key belongs to can see in Kin, by its key: title, brief, state, due date, project, holder and the newest comments. One they can't see is not found.",
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
      "Add a comment to a task the person this key belongs to can see in Kin. It is posted as them, marked as from their coding agent, and whoever holds the task and whoever asked for it are told, as for a comment made in the app. The same text again posts nothing new.",
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
      "Set a task to doing (started), done, or open (not started), as the person this key belongs to, marked as from their coding agent. Who may is as in the app: its holder, an owner or co-owner, or its project's lead; anyone else is told who can, and may comment instead.",
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

/** The one standing line an outside agent reads on connecting: who it acts as, and what it can't. */
export const TASKS_KEY_INSTRUCTIONS =
  "Kin, as the person this key belongs to: every tool acts as them, with what they can see and do in the Kin app, and what it writes is marked as from their coding agent. Name people and agents as list_people gives them; what an agent does for the person (remember, remind, draft) goes through ask_agent. These stay a tap in the Kin app and have no tool here: answering a card (Confirm, a choice, an approval, Post it); anything that sends money or mail out of the company or records money as paid or received; people, roles, places and invitations (Settings → Team); connections, sign-ins and coding agent keys (Settings → Connections, Settings → Profile); updates, backups and the company's settings (Settings → Company details); deleting or archiving anything. When asked for one of these, say it is a tap in Kin and where, and don't look for a tool.";
/** Listed, and callable, only for a person whose own screens open Money or Memory now. */
const ownerWithMoney = (holder: TasksKeyHolder) =>
  Effect.zipWith(readsMoney(holder), readsMemory(holder), (money, owner) => money && owner);
const GATED: Partial<
  Record<string, (holder: TasksKeyHolder) => Effect.Effect<boolean, KinChatError, Services>>
> = {
  money_summary: readsMoney,
  search_memory: readsMemory,
  create_project: readsMemory,
  update_project: readsMemory,
  list_invoices: readsMoney,
  open_invoice: readsMoney,
  draft_invoice: ownerWithMoney,
  record_expense: ownerWithMoney,
  create_client: readsClients,
  update_client: readsClients,
  log_contact: readsClients,
  add_promise: readsClients,
  close_promise: readsClients,
  list_deals: readsClients,
  create_deal: readsClients,
  update_deal: readsClients,
  write_doc: readsDocs,
};

const TOOL_SECTIONS: Readonly<Partial<Record<string, SectionId>>> = {
  money_summary: "money",
  open_client: "clients",
  open_project: "clients",
  create_project: "clients",
  update_project: "clients",
  create_client: "clients",
  update_client: "clients",
  log_contact: "clients",
  add_promise: "clients",
  close_promise: "clients",
  list_deals: "deals",
  create_deal: "deals",
  update_deal: "deals",
  write_doc: "docs",
  list_invoices: "invoices",
  open_invoice: "invoices",
  draft_invoice: "invoices",
  record_expense: "money",
};
const shellOf = Effect.fn("KinTasksKeyTools.shell")((holder: TasksKeyHolder) =>
  KinShell.get(holder.orgId).pipe(Effect.mapError(() => unavailable)),
);
const requireSection = Effect.fn("KinTasksKeyTools.requireSection")(function* (
  holder: TasksKeyHolder,
  section: SectionId,
) {
  const shell = yield* shellOf(holder);
  if (!KinShell.sectionOn(shell, section))
    return yield* new KinChatError({
      reason: "invalid_state",
      message: `${KinShell.sectionName(shell, section)} is turned off for this company.`,
    });
});

// Read from the request, not declared: tool services are built with the server, and the holder
// exists only per request. Without `auth` in front there is none, and every call fails.
// Every answer passes here: text a reader can't see but a model reads is taken out of it.
const asHolder = Effect.fnUntraced(function* <A, R>(
  run: (holder: TasksKeyHolder) => Effect.Effect<A, KinChatError, R>,
) {
  const caller = yield* Effect.serviceOption(TasksKeyCaller);
  if (Option.isNone(caller)) return yield* unavailable;
  const { holder, services } = caller.value;
  return cleaned(
    yield* run(holder).pipe(
      Effect.provideContext(services),
      Effect.provideService(CodingAgentCall, holder.sessionId),
    ),
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
/** What makes a document needs the host's files; a server without them makes none. */
const withFiles = <A, R>(
  run: Effect.Effect<A, KinChatError, R>,
): Effect.Effect<A, KinChatError, Exclude<R, FileSystem.FileSystem | ServerConfig>> =>
  Effect.flatMap(Effect.serviceOption(TasksKeyCaller), (caller) =>
    Option.isNone(caller) || Option.isNone(caller.value.files)
      ? Effect.fail(unavailable)
      : run.pipe(Effect.provide(caller.value.files.value)),
  );
/** A tool listed under a section runs only while it is on, as the screen opens only then. */
const inSection = <A, R>(
  name: string,
  holder: TasksKeyHolder,
  run: Effect.Effect<A, KinChatError, R>,
) => {
  const section = TOOL_SECTIONS[name];
  return section === undefined ? run : requireSection(holder, section).pipe(Effect.andThen(run));
};
const namesFor = Effect.fn("KinTasksKeyTools.names")(function* (holder: TasksKeyHolder) {
  const names = yield* orgOwner(holder.orgId).pipe(
    Effect.flatMap((owner) => toolNamesOf(holder.orgId, owner)),
    Effect.mapError(() => unavailable),
  );
  return (who: KinWorkPrincipal) =>
    toolName(who, names, { _tag: "person", personId: holder.personId });
});

const handlers = McpToolAccess.toLayer(TasksKeyToolkit, {
  ask_agent: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.askAgent")((input) =>
      asHolder((holder) => askAgent(holder, input)),
    ),
  ),
  read_chat: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.readChat")((input) =>
      asHolder((holder) => readChat(holder, input)),
    ),
  ),
  create_client: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.createClient")((input) =>
      asHolder((holder) =>
        inSection(
          "create_client",
          holder,
          Acts.createClient(holder, input).pipe(Effect.flatMap((key) => openClient(holder, key))),
        ),
      ),
    ),
  ),
  update_client: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.updateClient")((input) =>
      asHolder((holder) =>
        inSection(
          "update_client",
          holder,
          Acts.updateClient(holder, input).pipe(Effect.flatMap((key) => openClient(holder, key))),
        ),
      ),
    ),
  ),
  log_contact: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.logContact")((input) =>
      asHolder((holder) =>
        inSection(
          "log_contact",
          holder,
          Acts.logContact(holder, input).pipe(Effect.map((client) => ({ client, logged: true }))),
        ),
      ),
    ),
  ),
  list_deals: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.listDeals")((input) =>
      asHolder((holder) =>
        inSection(
          "list_deals",
          holder,
          namesFor(holder).pipe(Effect.flatMap((name) => Acts.listDeals(holder, input, name))),
        ),
      ),
    ),
  ),
  create_deal: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.createDeal")((input) =>
      asHolder((holder) =>
        inSection(
          "create_deal",
          holder,
          namesFor(holder).pipe(Effect.flatMap((name) => Acts.createDeal(holder, input, name))),
        ),
      ),
    ),
  ),
  update_deal: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.updateDeal")((input) =>
      asHolder((holder) =>
        inSection(
          "update_deal",
          holder,
          namesFor(holder).pipe(Effect.flatMap((name) => Acts.updateDeal(holder, input, name))),
        ),
      ),
    ),
  ),
  add_promise: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.addPromise")((input) =>
      asHolder((holder) => inSection("add_promise", holder, Acts.addPromise(holder, input))),
    ),
  ),
  close_promise: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.closePromise")((input) =>
      asHolder((holder) =>
        inSection("close_promise", holder, Acts.closePromise(holder, input.key)),
      ),
    ),
  ),
  write_doc: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.writeDoc")((input) =>
      asHolder((holder) => inSection("write_doc", holder, Acts.writeDoc(holder, input))),
    ),
  ),
  list_invoices: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.listInvoices")((input) =>
      asHolder((holder) => inSection("list_invoices", holder, Acts.listInvoices(holder, input))),
    ),
  ),
  open_invoice: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.openInvoice")((input) =>
      asHolder((holder) => inSection("open_invoice", holder, Acts.openInvoice(holder, input.key))),
    ),
  ),
  draft_invoice: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.draftInvoice")((input) =>
      asHolder((holder) =>
        inSection("draft_invoice", holder, withFiles(Acts.draftInvoice(holder, input))),
      ),
    ),
  ),
  record_expense: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.recordExpense")((input) =>
      asHolder((holder) => inSection("record_expense", holder, Acts.recordExpense(holder, input))),
    ),
  ),
  list_lists: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.listLists")(() =>
      asHolder((holder) => inSection("list_lists", holder, Acts.listLists(holder))),
    ),
  ),
  list_entries: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.listEntries")((input) =>
      asHolder((holder) => inSection("list_entries", holder, Acts.listEntries(holder, input))),
    ),
  ),
  add_entry: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.addEntry")((input) =>
      asHolder((holder) => inSection("add_entry", holder, Acts.addEntry(holder, input))),
    ),
  ),
  update_entry: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.updateEntry")((input) =>
      asHolder((holder) => inSection("update_entry", holder, Acts.updateEntry(holder, input))),
    ),
  ),
  read_numbers: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.readNumbers")((input) =>
      asHolder((holder) => inSection("read_numbers", holder, Acts.readNumbers(holder, input))),
    ),
  ),
  record_number: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.recordNumber")((input) =>
      asHolder((holder) => inSection("record_number", holder, Acts.recordNumber(holder, input))),
    ),
  ),
  list_waiting: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.listWaiting")(() =>
      asHolder((holder) => inSection("list_waiting", holder, Acts.listWaiting(holder))),
    ),
  ),
  list_people: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.people")(() => asHolder(listPeople)),
  ),
  list_tasks: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.listTasks")((input) =>
      asHolder((holder) => listSeenBy(holder, input)),
    ),
  ),
  create_task: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.createTask")((input) =>
      asHolder((holder) => createTask(holder, input)),
    ),
  ),
  update_task: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.updateTask")((input) =>
      asHolder((holder) => updateTask(holder, input)),
    ),
  ),
  create_project: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.createProject")((input) =>
      asHolder((holder) =>
        requireSection(holder, "clients").pipe(
          Effect.andThen(createProject(holder, input)),
          Effect.flatMap((made) => openProject(holder, made.key)),
        ),
      ),
    ),
  ),
  update_project: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.updateProject")((input) =>
      asHolder((holder) =>
        requireSection(holder, "clients").pipe(
          Effect.andThen(updateProject(holder, input)),
          Effect.andThen(openProject(holder, input.key)),
        ),
      ),
    ),
  ),
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
      if (kind === "projects" || kind === "clients")
        return yield* asHolder((holder) =>
          Effect.gen(function* () {
            if (!KinShell.sectionOn(yield* shellOf(holder), "clients")) {
              const page = { more: false, next: null, material: MATERIAL };
              return kind === "projects" ? { ...page, projects: [] } : { ...page, clients: [] };
            }
            return kind === "projects"
              ? yield* listProjects(holder, input)
              : yield* listClients(holder, input);
          }),
        );
      return yield* asHolder((holder) => findDocs(holder, input));
    }),
  ),
  open_project: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.openProject")((input) =>
      asHolder((holder) =>
        requireSection(holder, "clients").pipe(Effect.andThen(openProject(holder, input.key))),
      ),
    ),
  ),
  open_client: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.openClient")((input) =>
      asHolder((holder) =>
        requireSection(holder, "clients").pipe(Effect.andThen(openClient(holder, input.key))),
      ),
    ),
  ),
  read_doc: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.readDoc")((input) => asHolder((holder) => readDoc(holder, input))),
  ),
  money_summary: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.money")(() =>
      asHolder((holder) =>
        requireSection(holder, "money").pipe(Effect.andThen(moneySummary(holder))),
      ),
    ),
  ),
  search_memory: McpToolAccess.reads(
    Effect.fn("KinTasksKeyTools.memory")((input) =>
      asHolder((holder) => searchMemory(holder, input.text)),
    ),
  ),
});

// Untraced: it runs for every tool on each list and call.
const listed = toolVisibility(
  Effect.fnUntraced(function* (name, method) {
    const gate = GATED[name];
    const section = method === "tools/call" ? undefined : TOOL_SECTIONS[name];
    if (gate === undefined && section === undefined) return true;
    return yield* asHolder((holder) =>
      Effect.gen(function* () {
        if (gate !== undefined && !(yield* gate(holder))) return false;
        return section === undefined || KinShell.sectionOn(yield* shellOf(holder), section);
      }),
    ).pipe(Effect.orElseSucceed(() => false));
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
    const files = Option.map(
      Option.all({
        fs: yield* Effect.serviceOption(FileSystem.FileSystem),
        config: yield* Effect.serviceOption(ServerConfig),
      }),
      ({ fs, config }) =>
        Context.make(FileSystem.FileSystem, fs).pipe(Context.add(ServerConfig, config)),
    );
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
        Effect.provideService(TasksKeyCaller, { holder: holder.value, services, files }),
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
  { instructions: TASKS_KEY_INSTRUCTIONS },
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
