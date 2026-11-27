import { KinChatError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import { McpInvocationContext } from "../../../mcp/McpInvocationContext.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { KinIdentity } from "../../chat/KinIdentity.ts";
import { KinLevelGate } from "../../lead/LevelGate.ts";
import { KinRecords } from "../KinRecords.ts";
import * as Docs from "../leadDocs.ts";
import { PageMarks } from "../pageMarks.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";

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
    SqlClient.SqlClient,
  ],
};
const marked =
  "sensitive true marks a confidential doc: keep it out of task briefs, pull requests and chats others read.";
export const SearchResult = Docs.SearchResult.mapFields((fields) => ({
  ...fields,
  hits: Schema.Array(fields.hits.value.mapFields(Struct.omit(["sensitive"]))),
  sensitiveRows: PageMarks.sensitiveRows,
}));
const shows =
  "It can show an image sent in this chat or shown in another doc, ![what it shows](kin-file:<id>), a ```kin_chart block of kin_chart's JSON, and a ```kin_visual <title> block of sealed HTML; Kin checks them.";
const writes = "The same call again in this turn returns what it made.";

/** Docs: what agents write for a reader and keep current. People read them; only agents write. */
export const KinDocsToolkit = Toolkit.make(
  Tool.make("doc_create", {
    ...shared,
    description: `Write a new doc (a plan, brief, runbook, statement of work, meeting notes or research) in markdown with ## headings, so it edits by section. File it: kind, and a client and project, or company true for the company's own; if you can't tell whose it is, ask in your reply and file it later with doc_move. links ties it to entries or docs. A post, mail or proposal to draft is one doc each, with draft. whatWeSell true starts the company's one What we sell doc (one ## per offering, with what it does, who it's for, its price and what it doesn't do as ### under it), or gives the existing one's key to change with doc_edit. ${shows} Returns its key and outline; the same call again in this turn returns it. Asked for a doc, reply in one short sentence on what you wrote: its card opens it. ${marked}`,
    parameters: Docs.CreateInput,
    success: Docs.WriteResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("doc_read", {
    ...shared,
    description: `Read a doc by key (D-4). A short doc comes back whole with its outline; a long one as its outline only: each section's id, size and hash. Then read the sections you need by id. Read before you edit: an edit names the hash it read. Read-only. ${marked}`,
    parameters: Docs.ReadInput,
    success: Docs.ReadResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("doc_edit", {
    ...shared,
    description: `Change part of a doc; summary is one line the reader sees. Operations run in order, all or none: replace_section (id and the hash you read; text with no heading keeps the heading, empty removes it), insert_after a section, append, replace_phrase (exact text found once), retitle. Edit only what changes: "move the deadline to the 14th" is one replace_phrase or one section. If a section changed since you read it, nothing changes and you get its text now: redo the edit on it. ${shows} Returns the new outline. ${writes}`,
    parameters: Docs.EditInput,
    success: Docs.WriteResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("doc_rewrite", {
    ...shared,
    description: `Replace a doc's whole body, only when most of it changes, with baseVersion the version you read and summary saying why. Kin refuses a rewrite that changes under a third of the lines and names the sections that differ: change those with doc_edit instead. ${writes}`,
    parameters: Docs.RewriteInput,
    success: Docs.WriteResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("doc_move", {
    ...shared,
    description: `File a doc under another client or project (null clears) or as the company's own (company true), change its kind, give it to another owner, mark it sensitive, or delete it with archived true (it can be restored from Docs › Deleted; archived false brings it back). Rename with doc_edit retitle. ${writes}`,
    parameters: Docs.MoveInput,
    success: Docs.MoveResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("doc_link", {
    ...shared,
    description: `Link a doc to entries (W-12) or other docs (D-3), both ways, so each shows the other: a plan to the entries it became, notes to the client's work. ${writes}`,
    parameters: Docs.LinkInput,
    success: Docs.LinkResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("docs_search", {
    ...shared,
    description: `Search docs, Work entries, clients, contacts, projects and deals by words (a deal also by its key), best match first; a doc hit names its section. Find a doc before writing a new one. Read-only. sensitiveRows marks confidential hits: keep them out of task briefs, pull requests and chats others read.`,
    parameters: Docs.SearchInput,
    success: SearchResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("doc_history", {
    ...shared,
    description: `List a doc's versions, newest first: when, by whom, the one-line summary and the sections each touched. Read-only.`,
    parameters: Docs.HistoryInput,
    success: Docs.HistoryResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
  Tool.make("doc_restore", {
    ...shared,
    description: `Undo a doc's changes: brings back version as a new latest version, so nothing is lost and it can be undone again. latest is the newest version from doc_history; if it moved, nothing changes. ${writes}`,
    parameters: Docs.RestoreInput,
    success: Docs.WriteResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
);
