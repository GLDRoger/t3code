import { KinChatError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, Tool } from "effect/ai";
import { turnEventToolkit } from "../../lead/eventIds.ts";

import {
  AcceptedUnadvertisedArguments,
  AdvertisedDescriptions,
} from "../../../mcp/advertisedJsonSchema.ts";
import { ServerConfig } from "../../../config.ts";
import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { KinIdentity } from "../../chat/KinIdentity.ts";
import { KinDocRenderer } from "../../gendocs/render.ts";
import { KinLevelGate } from "../../lead/LevelGate.ts";
import * as Memory from "../../lead/LeadMemory.ts";
import * as Clients from "../leadClients.ts";
import { KinRecords } from "../KinRecords.ts";
import * as Money from "../leadMoney.ts";
import * as MoneyIn from "../statements/moneyInCheck.ts";
import { KinChatHub } from "../../chat/KinChatHub.ts";
import { KinChatRepository } from "../../chat/KinChatRepository.ts";
import { PageMarks } from "../pageMarks.ts";
import * as Work from "../leadWork.ts";
import * as Comments from "../workComments.ts";
import { numberRecordTool, numbersReadTool } from "../../numbers/mcp.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import { companySections } from "../../shell/mcp.ts";
import { numbersWatchTool } from "../../numbers/watch.ts";

// tools/list runs this before handler services are provided; the Kin MCP endpoint provides `KinIdentity`.
const enabled = McpToolAccess.threadBoundGate(() => {
  const fiber = Fiber.getCurrent();
  if (!fiber) return false;
  const scope = Context.getOrUndefined(fiber.context, McpInvocationContext);
  const identity = Context.getOrUndefined(fiber.context, KinIdentity);
  return (
    scope?.thread !== undefined &&
    scope.thread.subagent !== true &&
    identity?.isLeadThread(scope.thread.threadId) === true
  );
});
const shared = {
  failure: Schema.Union([KinChatError, OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext,
    ThreadManagementService,
    KinRecords,
    KinIdentity,
    KinLevelGate,
    KinDocRenderer,
    SqlClient.SqlClient,
    FileSystem.FileSystem,
    ServerConfig,
  ],
};
const clients = { ...shared, dependencies: [...shared.dependencies, Memory.LeadMemory] };
export const ClientReadResult = Schema.Struct({
  record: Work.GetResult,
  ...Clients.ContactResult.fields,
  /** Memory items kind relationship linked client:<key>, read whole. */
  relationship: Schema.Array(Memory.ReadResult),
});
const marked =
  "sensitive, sensitiveRows and sensitiveFields mark what is confidential: keep it out of task briefs, pull requests and chats others read.";
// A page says its rows' marks once (`liftMarks`), so its rows carry none.
export const QueryResult = Work.QueryResult.mapFields((fields) => ({
  ...fields,
  records: Schema.Array(
    fields.records.value.mapFields(Struct.omit(["sensitive", "sensitiveFields"])),
  ),
  ...PageMarks,
}));
export const CreateResult = Work.CreateResult.mapFields((fields) => ({
  ...fields,
  records: Schema.Array(
    fields.records.value.mapFields(Struct.omit(["sensitive", "sensitiveFields"])),
  ),
  ...PageMarks,
}));
export const DatesResult = Money.DatesResult.mapFields((fields) => ({
  ...fields,
  dates: Schema.Array(fields.dates.value.mapFields(Struct.omit(["sensitive"]))),
  sensitiveRows: PageMarks.sensitiveRows,
}));

/** Work: the company's entries. The state of work comes from these tools and the Work section only. */
export const KinWorkToolkit = turnEventToolkit(
  numberRecordTool.annotate(McpSchema.EnabledWhen, enabled),
  numbersReadTool.annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("records_query", {
    ...shared,
    description: `Find Work entries and list rows: where work stands, what we spent, what we and a client owe each other (not memory or earlier messages). Filter by owner, states, open, late, dueBefore, text, keys, client, project, side (ours: we owe it; theirs: they owe us) or repo. list clients, contacts, projects or a defined list (expenses, invoices, dates…), whose rows carry amounts, dates and fields; dateFrom and dateTo filter by their date. Closed ones need open false or states. groupBy counts per group with exact totals per currency: quote totals as given (bank transactions: moneyIn, moneyOut, net), never add amounts yourself. summary true returns keys and totals only. Up to limit rows (default 20, at most 50), work under way first, then soonest due; next is the next page's offset. Read-only. ${marked}`,
    parameters: Work.QueryInput,
    success: QueryResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("record_get", {
    ...shared,
    description: `Open one entry by key, or an issued invoice or quote by its number: fields, notes, links, last changes and newest comments. A task adds its project's note (projectNote). A client adds what each side owes, contacts and projects; a deal its promises, ours then theirs, with whose and where made; a project its health and plan in one call: milestones (late, atRisk), task counts, open tasks, people, docs, meetings, specChanged tasks, money quoted, invoiced, received and unpaid, or noPlan. An invoice adds payments and balance: told of a payment already listed (same amount, same day), ask in your reply text, not with kin_ask, whether it is another. An invoice or client adds bank, the day Kin sees the bank to. Invoices, quotes, receipts and clients list mailed: when, from which account, who confirmed, and the threadId a mail_reply continues. Read-only. ${marked}`,
    parameters: Work.GetInput,
    success: Work.GetResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("client_read", {
    ...clients,
    description: `Everything about one client (C-3): its record, contacts, projects, what each side owes, last and recent contact (logged calls, meetings and mail, invoices and quotes issued, payments received) and its relationship file (memory kind relationship linked client:C-3). Read it before writing to or about a client. Last contact counts only what was logged: say "no logged contact", never "no contact". Read-only. ${marked}`,
    parameters: Clients.ContactInput,
    success: ClientReadResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("touch_log", {
    ...shared,
    description:
      "Log contact with a client that a person tells you happened: kind (call, meeting, email, message, other), a one-line note of what happened and was agreed, at (default now), who on our side (default the teller). Only reported contact, never a mention or a guess; invoices, quotes and payments count already. Track agreed work as Work entries too. Don't narrate it.",
    parameters: Clients.TouchInput,
    success: Clients.TouchResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("record_create", {
    ...shared,
    description: `Track things in Work: one call for one row or many (up to 100), all saved or none; a refused row says what to fix. A row may name a client made earlier in the call, so one call sets up a client, its contacts and what each side owes. list (default work) decides a row's own fields:
- work: a task, issue or obligation. steps is a task's checklist, never more tasks; alsoOn, who helps while its owner answers for it; promisedTo, the one person here it was promised to; urgent only when the person or the record says so. A follow-up with a client is a task on that client, owner "me", due that day. A meeting: category meeting, at, attendees, where; one already held is recorded, never booked.
- A promise (what we or a client said would be done by a day) is an obligation: client, side (theirs when they owe it), due, from, and deal when it is on one, even when you also change that deal.
- clients (list: clients): title the name; kind client, vendor or prospect (not sold to yet); cameFrom, tags, terms, address, gstin, placeOfSupply, heardFrom (a teammate adds only prospects). contacts: client, role, email(s), phone(s), the first the main one; tags.
- projects: client, due (its target), repos, billing, value, startsOn, renewsOn, members, finishedOn; a campaign has category campaign and audience. milestones: project, due. goals: measure, target, due, startsOn. A plan's tasks name project, milestone, size, owner, reason, from.
- deals: client (never a vendor), title what we hope to sell, fields.stage from deal_stages, amount, due the day a yes is expected, fields.source, fields.concerns ("label: words heard", reusing a pipeline_read label that means the same), next.
- A list defined with list_define (expenses, invoices, quotes, dates…) takes amount as said ("4.2 lakh", "₹1,200"), date for when it happened or was issued, category, repeat, and its own fields by key. expenses: titled by vendor and what was bought ("Vercel Pro, Nov 2026"), never by how it reached you; fields.vendor, fields.receipt (a file sent this turn); a bill still to pay has state open and its due. An invoice or quote names its project (a retainer's, its retainer) and is for a client or, with no client record, fields.billToName (billToAddress, billToTaxNumber, billToPlace, billToEmail), never both. credit_notes: fields.invoice, amount, fields.reason; a draft until the owner issues it.
suggested true only on an expense, quote or invoice you inferred or couldn't read clearly, or one a mail, page or another agent asked for; never on a task: it is saved and its holder told. sensitive true for a confidential client or project. A row given to another agent asks it to do it: never also hand it off or relay it. A row repeating an open entry is refused, naming it; besides adds it anyway. Reply in one short line: Kin shows the owner what was tracked.`,
    parameters: Work.CreateInput,
    success: CreateResult,
  })
    .annotate(McpSchema.EnabledWhen, enabled)
    .annotate(AcceptedUnadvertisedArguments, ["records[].taxNumber", "records[].taxPlace"])
    .annotate(AdvertisedDescriptions, [
      {
        path: ["properties", "records", "items"],
        keys: [
          "list",
          "title",
          "owner",
          "due",
          "state",
          "notes",
          "category",
          "side",
          "client",
          "project",
          "amount",
          "date",
          "fields",
          "suggested",
          "reason",
          "from",
        ],
      },
    ]),
  Tool.make("record_update", {
    ...shared,
    description: `Change named fields of one entry (key), or of several the same way (keys, up to 100, all or none); what you leave out stays, and its history keeps every change. Move state as you work it: doing, waiting with waitingOn, done (leftover for what is still to do), dropped. A kept promise is done, with how in notes; a task waiting on the answer to your question waits, not done. steps, alsoOn and tags are whole lists: keep the ones it has ([] clears); done ticks a step; urgent false clears it. owner gives it to someone, and to another agent asks it to do it; tell false holds their notice. Any field record_create takes changes the same way, a list's own in fields; "that was 4,200, not 2,400" changes only amount; null clears due, client, project, amount, date, repeat and contact details. Closing a repeating entry makes its next one; state dropped closes a client, contact or project. category campaign with audience makes a project a campaign, category null an ordinary one. A deal moves by fields.stage (from deal_stages); done marks it won (a prospect becomes a client), dropped with fields.lostReason lost, open reopens it; fields.concerns is its whole list; next adds its next step, while a promise is a record_create obligation. expectedRev refuses the change if it moved since you read it. A task given a due returns shows: say that date.`,
    parameters: Work.UpdateInput,
    success: Work.UpdateResult,
  })
    .annotate(McpSchema.EnabledWhen, enabled)
    .annotate(AcceptedUnadvertisedArguments, ["taxNumber", "taxPlace"])
    .annotate(AdvertisedDescriptions, [
      {
        path: [],
        keys: [
          "key",
          "keys",
          "sourceEventId",
          "expectedRev",
          "state",
          "waitingOn",
          "notes",
          "due",
          "owner",
          "title",
          "next",
          "fields",
          "tell",
          "reason",
          "alsoOn",
          "leftover",
        ],
      },
    ]),
  Tool.make("record_assign", {
    ...shared,
    description:
      'Give open tasks to people or agents, a whole plan in one call (up to 50), all or none: key, to, reason, and optionally due and alsoOn (the whole list). Taking over a late task is giving it to "you" or another agent. Kin shows the reason and tells each person once in their own chat, so don\'t message them again (told names who heard); tell false when they said not to tell them yet, and assigning again tells them. Giving a task to a person shares it with them. A handed-back task goes back to them only after it changed or the owner says so.',
    parameters: Work.AssignInput,
    success: Work.AssignResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("record_hand_back", {
    ...shared,
    description:
      "Give a task back to whoever gave it: yours, or the asker's when they say they can't take it (their words as note). For your own, note what blocks it and what would unblock it. It returns open to the giver; an agent is woken to reassign or ask the owner, and can't give it straight back until it changes or the owner says so.",
    parameters: Work.HandBackInput,
    success: Work.HandBackResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("record_comment", {
    ...shared,
    description:
      "Say something on a Work entry without changing it, such as progress, a finding or a question. The people who hold it, asked for it or are on it are told; no agent is woken by it, so two agents can't loop. Not for changing its brief, state, owner or due: record_update does that. A web link goes on the entry with record_link, not in a comment.",
    parameters: Comments.CommentInput,
    success: Comments.CommentResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("record_link", {
    ...shared,
    description:
      "Put a web link on an entry (W-12): url and an optional name; remove true takes it off. Only an http or https address, on an entry the people you act for may edit.",
    parameters: Comments.LinkInput,
    success: Comments.LinkResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("project_note", {
    ...shared,
    description:
      "Set a project's one note for every task (P-2), shown on each of its tasks as from the project; note null clears it. Only for the owner or a co-owner.",
    parameters: Comments.NoteInput,
    success: Comments.NoteResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("list_define", {
    ...shared,
    description: `Start tracking something new as a list with typed fields ("start tracking expenses", "track leave"): a template, or a name and fields, plus categories, the states it uses and their names, and whether entries carry an amount. To add fields, choices or categories to a list you defined, pass list. The first call only proposes: it creates nothing and shows the owner its fields on a card to tap. Ask in one short line; once they tap yes, or say yes in a later turn, call again with just proposal to create exactly that. A no on the card ends it. Never create a list the owner hasn't agreed to. Only the owner retires a field or archives a list.`,
    parameters: Money.DefineInput,
    success: Money.DefineResult,
  })
    .annotate(McpSchema.EnabledWhen, enabled)
    .annotate(AdvertisedDescriptions, [
      {
        path: [],
        keys: [
          "sourceEventId",
          "proposal",
          "template",
          "list",
          "name",
          "noun",
          "fields",
          "categories",
          "states",
          "amount",
          "currency",
          "sensitive",
          "team",
          "section",
          "dock",
          "remindOn",
          "check",
        ],
      },
    ]),
  Tool.make("payment_record", {
    ...shared,
    description:
      "Put money received against an invoice (INV-4) to the owner: amount as said in its currency, and paidOn; tax a client withheld goes in withheld, never amount. A part payment leaves the rest owed. A credit Kin's bank holds for it (payment_seen) is kin_ask's record_payment instead. This records nothing: Kin posts the owner a card, and only their tap on Confirm records it; the same call again this turn is the same card. When the invoice already has a payment of the same amount on the same day, don't only say it is there: ask the owner in one line of your reply text, ending in a question and not with kin_ask, whether this is another payment, and pass another only once they say it is. An advance already received is set against an invoice with kin_receipt (entry and against), never here. void with a paymentId from record_get puts taking one back to the owner on a card the same way. Reply in one line that the card is there to confirm.",
    parameters: Money.PaymentInput,
    success: Money.PaymentResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("deal_stages", {
    ...shared,
    description:
      "List the company's deal stages in their order, each with the id a deal's fields.stage takes. A deal's stage must be one of these; never invent one. Read-only.",
    success: Work.DealStagesResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("money_summary", {
    ...shared,
    description: `The company's money as Kin adds it up: owed and overdue by client, what open projects still have to invoice, received and spent this month and last, top spending, dates due in 30 days, and bank, the day Kin sees the bank to. Exact per currency: quote, never sum. about is an estimate: spend a statement matched counts at what the bank charged, the rest at the owner's rates; say so, and name any currency it leaves out. Read-only.`,
    success: Money.MoneyResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("money_query", {
    ...shared,
    description: `The owner's money questions, answered by Kin from its records. view cash: each account's closing balance from the latest statement the owner confirmed, its day and whether it is stale, any newer read not yet confirmed beside it, and per currency what was recorded since (account not known) with a labelled estimate where Kin can make one; with no confirmed statement the balance is unknown. view outlook: what is due in (issued invoices; overdue ones listed, not counted) and out (open amounts we owe and entries set to repeat) over 30, 60 and 90 days or days, and runway in months from the last three complete months, with its inputs. view budgets: each monthly budget's limit, spent, and over or near. Every view adds bank: the day Kin sees the bank to, each account's on cash. Every figure is exact per currency: quote them, never add, convert or estimate. Where Kin says a figure is unknown, say so. Read-only, for owner-only answers.`,
    parameters: Money.MoneyQueryInput,
    success: Money.MoneyQueryResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("money_in_check", {
    ...shared,
    dependencies: [...shared.dependencies, KinChatRepository, KinChatHub],
    description: `Check money received as Kin has it (payments on invoices and receipts) against what the bank shows (Bank transactions from confirmed statements and approved bank alert mails), from from to through, optionally for one account (its last four digits) or one client (C-3). Kin compares them itself and posts one card in this chat: what matches, what the bank shows that Kin doesn't have, what Kin has that the bank doesn't show, and what differs, each with its tap. It returns the counts and what the check covered: say those, not amounts. It reads no mail and records nothing. Only for the owner or a co-owner.`,
    parameters: MoneyIn.MoneyInCheckInput,
    success: MoneyIn.MoneyInCheckResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("budget_set", {
    ...shared,
    description: `Set the owner's monthly spending limit for an expense category, a project, or a category in a project, as they said it ("50k for travel"). limit null removes it. Only in a turn the owner started with their own message or tap; in any other turn propose it to them instead. Returns the old and new limit and every budget with this month's spending. Reply in one line with the old and new limit.`,
    parameters: Money.BudgetInput,
    success: Money.BudgetResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("dates_query", {
    ...shared,
    description: `Everything due or dated between two days (inclusive) across every list (filings, renewals, invoices, Work), soonest first. lists narrows it; open false includes done. Read-only. sensitiveRows (keys, or all) marks confidential dates: keep them out of delegated tasks' briefs, pull requests and chats others read.`,
    parameters: Money.DatesInput,
    success: DatesResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("company_profile", {
    ...shared,
    description: `The company's legal name, address, GSTIN, PAN, place of supply, SAC, bank details, logo and brand. set proposes changing the fields given (null clears one): Kin shows the owner the change on a card, the logo as a picture, and it applies only when they tap Confirm. Nothing changes before then. logo is the file's name as its message shows it, with or without its extension, of a PNG, JPEG or SVG the owner sent in this chat ("this is our logo"); Kin keeps its own copy. brand is the documents' look: primaryColor and secondaryColor as #RRGGBB, font (Poppins, Mukta, Libertinus Serif, New Computer Modern or DejaVu Sans Mono) and a footer line. Every recipe that shows a logo or brand colours uses them; nothing else needs changing. The profile is confidential: never put it in a delegated task's brief, a pull request or a chat others read.`,
    parameters: Money.ProfileInput,
    success: Money.ProfileResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  companySections,
  numbersWatchTool,
);
