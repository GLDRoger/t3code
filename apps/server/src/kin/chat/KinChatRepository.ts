import { ACTIVE_RUN_STATUSES } from "../../orchestration-v2/ThreadManagementService.ts";
import type { McpThreadCaller } from "../../mcp/McpInvocationContext.ts";
import { wakeupOfRuns } from "./wakeupRuns.ts";
import {
  KIN_MONEY_SECTION,
  KIN_TEAM_ROOM_TEAM_ID,
  KIN_MESSAGE_FIGURES_MAX,
  KIN_MESSAGE_BODY_MAX_LENGTH,
  KIN_FIGURE_SCHEME,
  KinEmbed,
  KinWakeupId,
  KinOrg,
  KinOrgId,
  KinPerson,
  KinPersonId,
  KinAgent,
  KinAttachment,
  KinAgentId,
  KinChat,
  KinChatId,
  KinChatMember,
  KinMemberId,
  KinDiscussionId,
  KinMessage,
  KinMessageOrigin,
  KinMessageRelay,
  KinMessageWhen,
  KinMessageRef,
  type KinMessageRefInput,
  KIN_MESSAGE_REFS_CAP,
  KinMessageId,
  KinWidget,
  KinWidgetId,
  KinWaitingAsk,
  KinWaitingItem,
  KinWaitingId,
  KinChatError,
  KinChatHistoryInput,
  type KinChatHistoryResult,
  kinIsPage,
  ThreadId,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
  kinPageWithLines,
} from "@t3tools/contracts";
import { kinDocBlocks } from "@t3tools/shared/kinDocBlocks";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { isOrgOwner } from "../lead/orgState.ts";
import { sectionsOf } from "../work/docBody.ts";
import { sensitiveNow } from "../work/recordRows.ts";
import { viewVisible } from "../work/teamView.ts";
import { encodeNames, nameKeys, withLinks } from "./messageLinks.ts";
import { messageForViewer } from "./messageView.ts";
import { chatShared, readableBy, readableFrom, recordJoin } from "./sharing.ts";
import { accessSql } from "../people/KinAccess.ts";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
import * as SqlSchema from "effect/sql/SqlSchema";
import {
  PersistenceDecodeError,
  PersistenceSqlError,
  toPersistenceSqlError,
} from "../../persistence/Errors.ts";

const KinAgentThread = Schema.Struct({
  orgId: KinOrgId,
  threadId: ThreadId,
  agentId: KinAgentId,
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
});
type KinAgentThread = typeof KinAgentThread.Type;
const KinReadState = Schema.Struct({
  orgId: KinOrgId,
  chatId: KinChatId,
  memberId: KinMemberId,
  lastReadSeq: NonNegativeInt,
  updatedAt: IsoDateTime,
});
type KinReadState = typeof KinReadState.Type;
export type RepositoryError = PersistenceSqlError | PersistenceDecodeError | KinChatError;
type Scope = { readonly orgId: KinOrgId };
const AttachmentChat = Schema.Struct({
  orgId: KinOrgId,
  chatId: KinChatId,
  messageId: KinMessageId,
});
type AttachmentChat = typeof AttachmentChat.Type;
const ChatFile = Schema.Struct({
  attachmentId: Schema.String,
  messageId: KinMessageId,
  mimeType: Schema.NullOr(Schema.String),
});
type ChatFile = typeof ChatFile.Type;
type ChatScope = Scope & { readonly chatId: KinChatId };
type MemberScope = ChatScope & { readonly memberId: KinMemberId };
/**
 * Who a write's words are for. Invariant: `owner` words never land where anyone else reads; this
 * write's transaction checks the chat, and a join moves or closes the owner's things in its own
 * (`onPersonJoined`, `settleCards`), so no commit order puts them above a new member's floor.
 */
export type WriteAudience = "owner" | "chat";
const PRIVATE_WRITE_REFUSED = "Kin withheld this: someone besides the owner reads that chat.";
export const isPrivateWriteRefused = (error: unknown) =>
  isKinChatError(error) && error.message === PRIVATE_WRITE_REFUSED;
type Audience = { readonly audience: WriteAudience };
type InsertMessage = Omit<KinMessage, "seq" | "authorRole" | "clientMessageId" | "refs"> & {
  readonly audience: WriteAudience;
  /** Resolved here, in the write's transaction, against this org's docs. */
  readonly refs?: ReadonlyArray<KinMessageRefInput> | undefined;
  readonly caller?: McpThreadCaller | undefined;
  // The reply bridge posts for a wake-up it resolved itself; its running row is the authority.
  readonly wakeupId?: KinWakeupId | undefined;
  readonly placeReplyFigures?: true | undefined;
  /** Pictures Kin drew for this agent: each doc version is read here, in the write's transaction. */
  readonly pictureRefs?: ReadonlyArray<PictureDoc> | undefined;
  // Only Kin itself (worker task cards, a failed send's mail again) posts outside a wake-up.
  readonly serverPosted?: true;
  /** Shown in the chat, but never pushed and never counted as unread or on the badge. */
  readonly silent?: true;
  readonly clientMessageId: {
    readonly kind: "send" | "act" | "task-card";
    readonly id: typeof TrimmedNonEmptyString.Type;
  } | null;
};
/** The stored form of a message's client id: one column holds every kind's. */
export const storedClientId = (kind: "send" | "act" | "task-card", id: string) => `${kind}:${id}`;

const isKinChatError = Schema.is(KinChatError);
const isDecodeError = Schema.is(PersistenceDecodeError);
const isSqlError = Schema.is(PersistenceSqlError);
const encodeMentions = Schema.encodeEffect(Schema.fromJsonString(KinMessage.fields.mentions));
const encodeWidgetState = Schema.encodeEffect(Schema.fromJsonString(KinWidget.fields.state));
const encodeAwaiting = Schema.encodeEffect(Schema.fromJsonString(KinWidget.fields.awaiting));
const decodeChatTitle = Schema.decodeEffect(KinChat.fields.title);
const decodeWidgetText = Schema.decodeEffect(
  Schema.Struct({ type: KinWidget.fields.type, feed: KinWidget.fields.feed }),
);
const decodeWidgetFeed = Schema.decodeEffect(KinWidget.fields.feed);
const decodeBody = Schema.decodeEffect(KinMessage.fields.body);
const decodeHistory = Schema.decodeEffect(KinChatHistoryInput);
const decodeSeq = Schema.decodeEffect(NonNegativeInt);
const decodeResume = Schema.decodeEffect(
  Schema.Struct({
    afterSeq: NonNegativeInt,
    limit: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(200)),
  }),
);

function toRepositoryError(operation: string) {
  return (cause: unknown): RepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(operation, cause)
      : isKinChatError(cause) || isDecodeError(cause) || isSqlError(cause)
        ? cause
        : toPersistenceSqlError(operation)(cause);
}
export class KinIdentityBootstrapError extends Schema.TaggedError<KinIdentityBootstrapError>()(
  "KinIdentityBootstrapError",
  { message: Schema.String },
) {}
const isBootstrapError = Schema.is(KinIdentityBootstrapError);
const defaultOrgId = Schema.decodeSync(KinOrgId)("kin-default");
const defaultOwnerId = Schema.decodeSync(KinPersonId)("kin-default-owner");
const OrgRow = KinOrg;
const orgColumns = `org_id AS "orgId", name AS "name", created_at AS "createdAt"`;
const PersonRow = KinPerson;
const personColumns = `person_id AS "personId", org_id AS "orgId", handle AS "handle", display_name AS "displayName", github_login AS "githubLogin", ${accessSql("kin_people")} AS access`;
const AgentIdentityRow = Schema.Struct({
  ...KinAgent.fields,
  retiredAt: Schema.NullOr(IsoDateTime),
});
const agentColumns = `agent_id AS "agentId", org_id AS "orgId", display_name AS "displayName", role AS "role", owner_person_id AS "ownerPersonId"`;
const ChatRow = KinChat;
const chatColumns = `org_id AS "orgId", chat_id AS "chatId", kind AS "kind", title AS "title", team_id AS "teamId", last_seq AS "lastSeq", last_message_at AS "lastMessageAt", created_at AS "createdAt", archived_at AS "archivedAt", lead_agent_id AS "leadAgentId"`;
const MemberRow = Schema.Struct({
  ...KinChatMember.fields,
  principal: Schema.fromJsonString(KinChatMember.fields.principal),
  // An unpinned member's row carries no `pinnedAt` at all, as before pins.
  pinnedAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)).pipe(
    Schema.decodeTo(
      Schema.optionalKey(IsoDateTime),
      SchemaTransformation.transformOptional<IsoDateTime, IsoDateTime | null>({
        decode: Option.filter((at) => at !== null),
        encode: (at) => at,
      }),
    ),
  ),
});
const memberColumns = `org_id AS "orgId", chat_id AS "chatId", member_id AS "memberId", role AS "role", joined_at AS "joinedAt", left_at AS "leftAt", muted_until AS "mutedUntil", strftime('%Y-%m-%dT%H:%M:%fZ', pinned_at / 1000.0, 'unixepoch') AS "pinnedAt", CASE principal_kind WHEN 'person' THEN json_object('_tag', 'person', 'personId', person_id)
 ELSE json_object('_tag', principal_kind, 'agentId', agent_id) END AS principal`;
const StoredAttachments = Schema.Array(KinAttachment);
const encodeAttachments = Schema.encodeEffect(Schema.fromJsonString(StoredAttachments));
const StoredEmbeds = Schema.Array(KinEmbed).check(Schema.isMaxLength(KIN_MESSAGE_FIGURES_MAX));
const encodeEmbeds = Schema.encodeEffect(Schema.fromJsonString(StoredEmbeds));
const StoredFigure = Schema.Struct({
  id: Schema.String,
  embed: Schema.fromJsonString(KinEmbed),
  attachmentId: Schema.NullOr(Schema.String),
});
const decodeFigures = Schema.decodeUnknownEffect(Schema.Array(StoredFigure));
/** A picture staged for a reply: its chat image and the doc version it was filed as. */
export const StagedPicture = Schema.Struct({
  attachment: KinAttachment,
  doc: Schema.Struct({ key: Schema.String, version: Schema.Number }),
});
export type PictureDoc = typeof StagedPicture.Type.doc;
const decodePictures = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      picture: Schema.fromJsonString(StagedPicture),
      attachmentId: Schema.NullOr(Schema.String),
    }),
  ),
);
type ReplyScope = ChatScope & {
  readonly agentId: KinAgentId;
  readonly threadId: ThreadId;
  readonly wakeupId: KinWakeupId;
};
const figureToken = new RegExp(`!?\\[([^\\]\\n]*)\\]\\(${KIN_FIGURE_SCHEME}([^\\s)]*)\\)`, "g");
const figureBlock = (figure: typeof StoredFigure.Type) => {
  const info =
    figure.embed._tag === "visual"
      ? `kin_visual ${figure.embed.title.replace(/[\s`]+/g, " ").trim()}`
      : figure.embed._tag === "chart"
        ? `kin_chart ${figure.embed.chart.title.replace(/[\s`]+/g, " ").trim()}`
        : "kin_visual";
  return `\`\`\`${info}\n${figure.id}\n\`\`\``;
};
const StoredRefs = Schema.Array(KinMessageRef);
const encodeRefs = Schema.encodeEffect(Schema.fromJsonString(StoredRefs));
const {
  attachments: _attachments,
  refs: _refs,
  discussionId: _discussionId,
  relay: _relay,
  origin: _origin,
  when: _when,
  links: _links,
  embeds: _embeds,
  form: _form,
  turnChanges: _turnChanges,
  ...messageRowFields
} = KinMessage.fields;
const encodeRelay = Schema.encodeEffect(Schema.fromJsonString(KinMessageRelay));
const encodeOrigin = Schema.encodeEffect(Schema.fromJsonString(KinMessageOrigin));
const encodeWhen = Schema.encodeEffect(Schema.fromJsonString(KinMessageWhen));
const MessageRow = Schema.Struct({
  ...messageRowFields,
  storedDiscussionId: Schema.NullOr(KinDiscussionId),
  storedRelay: Schema.NullOr(Schema.fromJsonString(KinMessageRelay)),
  storedOrigin: Schema.NullOr(Schema.fromJsonString(KinMessageOrigin)),
  storedWhen: Schema.NullOr(Schema.fromJsonString(KinMessageWhen)),
  storedClientMessageId: Schema.NullOr(Schema.String),
  storedAttachments: Schema.NullOr(Schema.fromJsonString(StoredAttachments)),
  storedRefs: Schema.NullOr(Schema.fromJsonString(StoredRefs)),
  storedEmbeds: Schema.NullOr(Schema.fromJsonString(StoredEmbeds)),
  storedForm: Schema.NullOr(Schema.Literal("brief")),
  author: Schema.fromJsonString(KinMessage.fields.author),
  mentions: Schema.fromJsonString(KinMessage.fields.mentions),
}).pipe(
  Schema.decodeTo(
    Schema.toType(KinMessage),
    SchemaTransformation.transform({
      decode: ({
        storedClientMessageId,
        storedAttachments,
        storedRefs,
        storedDiscussionId,
        storedRelay,
        storedOrigin,
        storedWhen,
        storedForm,
        storedEmbeds,
        ...message
      }): KinMessage => ({
        ...message,
        ...(storedWhen === null ? {} : { when: storedWhen }),
        ...(storedDiscussionId === null ? {} : { discussionId: storedDiscussionId }),
        ...(storedRelay === null ? {} : { relay: storedRelay }),
        ...(storedOrigin === null ? {} : { origin: storedOrigin }),
        ...(storedEmbeds === null ? {} : { embeds: storedEmbeds }),
        ...(storedForm === null ? {} : { form: storedForm }),
        ...(storedAttachments === null ? {} : { attachments: storedAttachments }),
        ...(storedRefs === null ? {} : { refs: storedRefs }),
        ...(storedClientMessageId?.startsWith("send:")
          ? { clientMessageId: storedClientMessageId.slice(5) }
          : {}),
      }),
      encode: ({
        attachments,
        refs,
        discussionId,
        relay,
        origin,
        when,
        links: _links,
        turnChanges: _turnChanges,
        form,
        embeds,
        ...message
      }) => ({
        ...message,
        storedWhen: when ?? null,
        storedDiscussionId: discussionId ?? null,
        storedRelay: relay ?? null,
        storedOrigin: origin ?? null,
        storedEmbeds: embeds ?? null,
        storedForm: form ?? null,
        storedAttachments: attachments ?? null,
        storedRefs: refs ?? null,
        storedClientMessageId:
          message.clientMessageId === undefined ? null : `send:${message.clientMessageId}`,
      }),
    }),
  ),
);
const messageColumns = `org_id AS "orgId", chat_id AS "chatId", message_id AS "messageId", seq AS "seq", change_seq AS "changeSeq", client_message_id AS "storedClientMessageId", author_role AS "authorRole", kind AS "kind", body AS "body", attachments_json AS "storedAttachments", refs_json AS "storedRefs", form AS "storedForm", embeds_json AS "storedEmbeds", intent AS "intent", mentions_json AS "mentions", reply_to AS "replyTo", widget_id AS "widgetId", floor_run_id AS "floorRunId", status AS "status", sent_by AS "sentBy", created_at AS "createdAt", edited_at AS "editedAt", discussion_id AS "storedDiscussionId", relay_json AS "storedRelay", origin_json AS "storedOrigin", when_json AS "storedWhen", CASE author_kind WHEN 'human' THEN json_object('_tag', 'human', 'personId', author_person_id, 'memberId', author_member_id)
 WHEN 'agent' THEN json_object('_tag', 'agent', 'agentId', author_agent_id, 'memberId', author_member_id,
 'ownerPersonId', author_owner_person_id, 'threadId', author_thread_id)
 ELSE json_object('_tag', author_kind) END AS author`;
const WidgetRow = Schema.Struct({
  ...KinWidget.fields,
  state: Schema.fromJsonString(KinWidget.fields.state),
  awaiting: Schema.fromJsonString(KinWidget.fields.awaiting),
  source: Schema.fromJsonString(KinWidget.fields.source),
  feed: Schema.fromJsonString(KinWidget.fields.feed),
});
const widgetColumns = `org_id AS "orgId", chat_id AS "chatId", widget_id AS "widgetId", message_id AS "messageId", widget_class AS "widgetClass", type AS "type", revision AS "revision", state_json AS "state", awaiting_json AS "awaiting", pinned_at AS "pinnedAt", closed_at AS "closedAt", updated_at AS "updatedAt", CASE WHEN source_thread_id IS NULL AND source_item_id IS NULL THEN 'null'
 ELSE json_object('threadId', source_thread_id, 'itemId', source_item_id) END AS source,
 CASE WHEN feed_kind IS NULL AND feed_key IS NULL THEN 'null'
 ELSE json_object('kind', feed_kind, 'key', feed_key) END AS feed`;
const WaitingRow = KinWaitingItem;
const waitingBaseColumns = `waiting_id AS "waitingId", org_id AS "orgId", person_id AS "personId", chat_id AS "chatId", message_id AS "messageId", widget_id AS "widgetId", reason AS "reason", created_at AS "createdAt", resolved_at AS "resolvedAt", resolution AS "resolution"`;
// A card's question names what is waiting, as its message (a card's body is empty) cannot.
// An agent's open question on the card adds what it does on which day unless answered.
const waitingColumns = `${waitingBaseColumns}, (SELECT json_extract(g.state_json, '$.question') FROM kin_widgets g WHERE g.widget_id = kin_waiting.widget_id) AS "question",
 (SELECT json_object('agent', COALESCE(l.name, a.display_name, q.agent_id),
   'default', CASE WHEN q.safe = 1 THEN q.default_label END,
   'by', strftime('%Y-%m-%dT%H:%M:%fZ', q.due_at / 1000.0, 'unixepoch'),
   'revision', g.revision,
   -- A subquery's value loses its JSON subtype, so json() keeps the options an array.
   'options', json((SELECT json_group_array(json_object('optionId', json_extract(o.value, '$.optionId'),
     'label', json_extract(o.value, '$.label'))) FROM json_each(g.state_json, '$.options') o)))
  FROM kin_questions q JOIN kin_widgets g ON g.widget_id = kin_waiting.widget_id
  LEFT JOIN kin_leads l ON l.org_id = q.org_id AND l.agent_id = q.agent_id
  LEFT JOIN kin_agents a ON a.org_id = q.org_id AND a.agent_id = q.agent_id
  WHERE q.org_id = kin_waiting.org_id AND q.state = 'open'
    AND (q.widget_id = kin_waiting.widget_id OR q.raise_widget_id = kin_waiting.widget_id)) AS "ask",
 (SELECT CASE WHEN json_extract(g.state_json, '$.send.action') IN ('email', 'reply') THEN 'mail'
    WHEN EXISTS (SELECT 1 FROM kin_questions q WHERE q.org_id = g.org_id AND q.draft_json IS NOT NULL
      AND (q.widget_id = g.widget_id OR q.raise_widget_id = g.widget_id)) THEN 'draft' END
  FROM kin_widgets g WHERE g.org_id = kin_waiting.org_id AND g.widget_id = kin_waiting.widget_id) AS "card",
 (SELECT json_object('detail', json_extract(g.state_json, '$.detail'),
    'askedBy', json_extract(g.state_json, '$.askedBy'), 'whileOpen', json_extract(g.state_json, '$.whileOpen'))
  FROM kin_widgets g WHERE g.org_id = kin_waiting.org_id AND g.widget_id = kin_waiting.widget_id
    AND json_extract(g.state_json, '$.send') IS NULL) AS "about"`;
const WaitingAskRow = Schema.Struct({
  ...KinWaitingItem.fields,
  ask: Schema.optional(Schema.NullOr(Schema.fromJsonString(KinWaitingAsk))),
  card: Schema.optional(Schema.NullOr(KinWaitingItem.fields.card)),
  about: Schema.optional(
    Schema.NullOr(
      Schema.fromJsonString(
        Schema.Struct({
          detail: Schema.NullOr(Schema.String),
          askedBy: Schema.NullOr(Schema.String),
          whileOpen: Schema.NullOr(Schema.String),
        }),
      ),
    ),
  ),
  waitsForName: Schema.optional(Schema.NullOr(Schema.String)),
});
const EXCERPT_LINES = 3;
const EXCERPT_CHARS = 300;
/** A card's first lines of what it asks about, past the asker's and while-open lines. */
const excerptOf = (about: {
  detail: string | null;
  askedBy: string | null;
  whileOpen: string | null;
}) => {
  let text = about.detail ?? "";
  for (const lead of [about.askedBy, about.whileOpen])
    if (lead !== null && text.startsWith(lead)) text = text.slice(lead.length);
  const lines = text
    .split("\n")
    .map((line) => line.replace(/^[\s#>*-]+/, "").trim())
    .filter((line) => line !== "")
    .slice(0, EXCERPT_LINES)
    .join("\n");
  if (lines === "") return undefined;
  return lines.length <= EXCERPT_CHARS ? lines : `${lines.slice(0, EXCERPT_CHARS - 1).trimEnd()}…`;
};
const withoutNoQuestion = ({
  question,
  ask,
  card,
  about,
  waitsForName,
  ...item
}: typeof WaitingAskRow.Type): KinWaitingItem => {
  const excerpt = about == null ? undefined : excerptOf(about);
  return {
    ...item,
    ...(question == null ? {} : { question }),
    ...(ask == null ? {} : { ask }),
    ...(card == null ? {} : { card }),
    ...(excerpt === undefined ? {} : { excerpt }),
    ...(waitsForName == null ? {} : { waitsFor: { personId: item.personId, name: waitsForName } }),
  };
};
const AgentThreadRow = KinAgentThread;
const ActiveAgentThreadRow = Schema.Struct({
  ...KinAgentThread.fields,
  role: KinAgent.fields.role,
});
const agentThreadColumns = `org_id AS "orgId", thread_id AS "threadId", agent_id AS "agentId", started_at AS "startedAt", ended_at AS "endedAt"`;
const ReadStateRow = KinReadState;
const readStateColumns = `org_id AS "orgId", chat_id AS "chatId", member_id AS "memberId", last_read_seq AS "lastReadSeq", updated_at AS "updatedAt"`;

export const activeMemberStatement = (
  sql: SqlClient.SqlClient,
  input: ChatScope & { readonly principal: KinChatMember["principal"] },
) =>
  input.principal._tag === "person"
    ? sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND person_id = ${input.principal.personId} AND left_at IS NULL`
    : sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND agent_id = ${input.principal.agentId} AND left_at IS NULL`;

export class KinChatRepository extends Context.Service<
  KinChatRepository,
  {
    readonly getOrg: (input: Scope) => Effect.Effect<Option.Option<KinOrg>, RepositoryError>;
    readonly getPerson: (
      input: Scope & { readonly personId: KinPersonId },
    ) => Effect.Effect<Option.Option<KinPerson>, RepositoryError>;
    readonly getAgent: (
      input: Scope & { readonly agentId: KinAgentId },
    ) => Effect.Effect<Option.Option<typeof AgentIdentityRow.Type>, RepositoryError>;
    readonly getChat: (
      input: Scope & { readonly chatId: KinChatId },
    ) => Effect.Effect<Option.Option<KinChat>, RepositoryError>;
    readonly getMember: (
      input: Scope & { readonly memberId: KinMemberId },
    ) => Effect.Effect<Option.Option<KinChatMember>, RepositoryError>;
    readonly getMessage: (
      input: Scope & { readonly messageId: KinMessageId },
    ) => Effect.Effect<Option.Option<KinMessage>, RepositoryError>;
    /** The chat whose message carries a stored file, unless that message was deleted. */
    readonly attachmentChat: (
      attachmentId: string,
    ) => Effect.Effect<Option.Option<AttachmentChat>, RepositoryError>;
    /** Files on undeleted messages of one chat, with the type each was sent as. */
    readonly chatFiles: (
      input: ChatScope,
    ) => Effect.Effect<ReadonlyArray<ChatFile>, RepositoryError>;
    /** Records a file a card of this message draws, so reading it follows the message. */
    readonly attachCardFile: (
      input: ChatScope & { readonly messageId: KinMessageId; readonly attachmentId: string },
    ) => Effect.Effect<void, RepositoryError>;
    readonly openTaskCards: (
      input: Scope,
    ) => Effect.Effect<ReadonlyArray<KinWidget>, RepositoryError>;
    readonly getWidget: (
      input: Scope & { readonly widgetId: KinWidgetId },
    ) => Effect.Effect<Option.Option<KinWidget>, RepositoryError>;
    readonly getWaiting: (
      input: Scope & { readonly waitingId: KinWaitingId },
    ) => Effect.Effect<Option.Option<KinWaitingItem>, RepositoryError>;
    readonly getAgentThread: (
      input: Scope & { readonly threadId: ThreadId },
    ) => Effect.Effect<Option.Option<KinAgentThread>, RepositoryError>;
    readonly bootstrapIdentity: (input: {
      readonly orgName: string;
      readonly ownerHandle: string;
      readonly ownerDisplayName: string;
      readonly createdAt: IsoDateTime;
      /** The company profile a company created by this call starts with; none when absent. */
      readonly companyProfileJson?: string | undefined;
    }) => Effect.Effect<KinPerson, RepositoryError | KinIdentityBootstrapError>;
    readonly hasRunningWakeup: (
      input: Scope & {
        readonly agentId: KinAgentId;
        readonly threadId: ThreadId;
        readonly caller: McpThreadCaller;
      },
    ) => Effect.Effect<boolean, RepositoryError>;
    /** Whether this exact wake-up is still running for the agent's thread. */
    readonly wakeupRunning: (
      input: Scope & {
        readonly agentId: KinAgentId;
        readonly threadId: ThreadId;
        readonly wakeupId: KinWakeupId;
      },
    ) => Effect.Effect<boolean, RepositoryError>;
    /** What the thread's running wake-up has posted in the chat so far. */
    readonly wakeupPosts: (
      input: ChatScope & { readonly agentId: KinAgentId; readonly threadId: ThreadId },
    ) => Effect.Effect<{ readonly messages: number; readonly chars: number }, RepositoryError>;
    readonly findAgentThread: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<KinAgentThread>, RepositoryError>;
    readonly listActiveAgentThreads: () => Effect.Effect<
      ReadonlyArray<typeof ActiveAgentThreadRow.Type>,
      RepositoryError
    >;
    readonly listAllOrgs: () => Effect.Effect<ReadonlyArray<KinOrg>, RepositoryError>;
    readonly listPeople: (input: Scope) => Effect.Effect<ReadonlyArray<KinPerson>, RepositoryError>;
    readonly listAgents: (
      input: Scope,
    ) => Effect.Effect<
      ReadonlyArray<KinAgent & { readonly retiredAt: IsoDateTime | null }>,
      RepositoryError
    >;
    readonly listChats: (input: Scope) => Effect.Effect<ReadonlyArray<KinChat>, RepositoryError>;
    readonly listMembers: (
      input: ChatScope,
    ) => Effect.Effect<ReadonlyArray<KinChatMember>, RepositoryError>;
    readonly listMembersByPerson: (
      input: Scope & { readonly personId: KinPersonId },
    ) => Effect.Effect<ReadonlyArray<KinChatMember>, RepositoryError>;
    readonly listMembersByAgent: (
      input: Scope & { readonly agentId: KinAgentId },
    ) => Effect.Effect<ReadonlyArray<KinChatMember>, RepositoryError>;
    readonly activeMember: (
      input: ChatScope & { readonly principal: KinChatMember["principal"] },
    ) => Effect.Effect<Option.Option<KinChatMember>, RepositoryError>;
    readonly waitingForWidget: (
      input: Scope & { readonly widgetId: KinWidgetId },
    ) => Effect.Effect<ReadonlyArray<KinWaitingItem>, RepositoryError>;
    readonly approvalAtMessage: (
      input: ChatScope & { readonly messageId: KinMessageId },
    ) => Effect.Effect<boolean, RepositoryError>;
    readonly resume: (
      input: ChatScope & {
        readonly memberId: KinMemberId;
        readonly afterSeq: number;
        readonly afterChangeSeq?: number | undefined;
      },
    ) => Effect.Effect<
      {
        readonly reset: boolean;
        /** The reset is a clear made after the caller's cursor: nothing it holds survives. */
        readonly cleared?: boolean;
        /** The chat's `last_seq` at its last clear; 0 when it never was. */
        readonly clearedSeq: number;
        readonly lastSeq: number;
        readonly lastChangeSeq: number;
        readonly messages: ReadonlyArray<KinMessage>;
        readonly widgets: ReadonlyArray<KinWidget>;
      },
      RepositoryError
    >;
    readonly listOpenWaiting: (
      input: Scope & { readonly personId: KinPersonId },
    ) => Effect.Effect<ReadonlyArray<KinWaitingItem>, RepositoryError>;
    /** What waits on the owner that this viewer, a co-owner, may see (`ownersWaiting`). */
    readonly listOwnersOpenWaiting: (
      input: Scope & { readonly personId: KinPersonId },
    ) => Effect.Effect<ReadonlyArray<KinWaitingItem>, RepositoryError>;
    /** One row of `listOwnersOpenWaiting`, by the same rule: none once she may not see it. */
    readonly getOwnersOpenWaiting: (
      input: Scope & { readonly personId: KinPersonId; readonly waitingId: KinWaitingId },
    ) => Effect.Effect<Option.Option<KinWaitingItem>, RepositoryError>;
    /** Whether `ownersWaiting` gives this viewer any row at all: a co-owner, not removed. */
    readonly seesOwnersWaiting: (
      input: Scope & { readonly personId: KinPersonId },
    ) => Effect.Effect<boolean, RepositoryError>;
    readonly insertOrg: (input: KinOrg) => Effect.Effect<void, RepositoryError>;
    readonly insertPerson: (
      input: KinPerson & { readonly createdAt: IsoDateTime },
    ) => Effect.Effect<void, RepositoryError>;
    readonly insertAgent: (
      input: KinAgent & { readonly createdAt: IsoDateTime },
    ) => Effect.Effect<void, RepositoryError>;
    readonly addMember: (input: KinChatMember) => Effect.Effect<KinChatMember, RepositoryError>;
    /** Sets an active member's mute; `null` unmutes. None when the member isn't active. */
    readonly setMute: (
      input: MemberScope & { readonly mutedUntil: IsoDateTime | null },
    ) => Effect.Effect<Option.Option<KinChatMember>, RepositoryError>;
    /** Pins an active member's chat at `pinnedAt` (epoch ms); `null` unpins. None when not active. */
    readonly setPin: (
      input: MemberScope & { readonly pinnedAt: number | null },
    ) => Effect.Effect<Option.Option<KinChatMember>, RepositoryError>;
    /** A person's role in a chat they are in; never to or from the chat's owner. */
    readonly setRole: (
      input: MemberScope & { readonly role: "member" | "guest" },
    ) => Effect.Effect<Option.Option<KinChatMember>, RepositoryError>;
    readonly leaveChat: (
      input: MemberScope & { readonly leftAt: IsoDateTime },
    ) => Effect.Effect<ReadonlyArray<KinWaitingItem>, RepositoryError>;
    readonly addApprovalWaiting: (
      input: KinWaitingItem & { readonly reason: "approval"; readonly widgetId: KinWidgetId },
    ) => Effect.Effect<boolean, RepositoryError>;
    readonly addWaiting: (input: KinWaitingItem) => Effect.Effect<boolean, RepositoryError>;
    readonly registerAgentThread: (
      input: KinAgentThread & { readonly chatId?: string | undefined },
    ) => Effect.Effect<KinAgentThread, RepositoryError>;
    readonly createChat: (
      input: Omit<KinChat, "lastSeq"> & {
        readonly directKey: typeof TrimmedNonEmptyString.Type | null;
      },
    ) => Effect.Effect<KinChat, RepositoryError>;
    /** Changes a group's name, lead or archived time; fields left out stay as they are. */
    readonly updateChat: (
      input: ChatScope & {
        readonly title?: KinChat["title"];
        readonly leadAgentId?: KinAgentId | null;
        readonly archivedAt?: IsoDateTime;
      },
    ) => Effect.Effect<KinChat, RepositoryError>;
    readonly findClientMessage: (
      input: MemberScope & {
        readonly kind: "send" | "act" | "task-card";
        readonly clientId: string;
      },
    ) => Effect.Effect<Option.Option<KinMessage>, RepositoryError>;
    readonly insertMessage: (input: InsertMessage) => Effect.Effect<KinMessage, RepositoryError>;
    /**
     * A wake-up's one reply grows by its next segment: the same lead thread's posted text, while
     * that wake-up runs. The new body keeps the old one as its start.
     */
    readonly replyCard: (input: ReplyScope) => Effect.Effect<KinMessageId | null, RepositoryError>;
    readonly extendAgentReply: (
      input: ChatScope & {
        readonly messageId: KinMessageId;
        readonly agentId: KinAgentId;
        readonly threadId: ThreadId;
        readonly wakeupId: KinWakeupId;
        readonly audience: WriteAudience;
        readonly body: string;
        /** The body ends with the page as stored: Kin's own section goes before it, unshaped. */
        readonly lead?: true;
        /** The body is the page as stored with these lines in its Money section (`kinPageWithLines`). */
        readonly money?: ReadonlyArray<string>;
      },
    ) => Effect.Effect<KinMessage, RepositoryError>;
    readonly history: (
      input: Scope &
        KinChatHistoryInput & {
          readonly viewerMemberId?: KinMemberId;
          readonly receipts?: false;
          /** The caller links the messages it keeps, as a chat list does once for all its rows. */
          readonly links?: false;
        },
    ) => Effect.Effect<KinChatHistoryResult, RepositoryError>;
    readonly messagesAfter: (
      input: ChatScope & {
        readonly afterSeq: typeof NonNegativeInt.Type;
        readonly beforeSeq?: number;
        /** The newest `limit` in range rather than the oldest, still returned oldest first. */
        readonly latest?: boolean;
        readonly limit: number;
        readonly viewerMemberId?: KinMemberId;
        /** A shared turn's read: nothing below the chat's history floor (`historyFloor`). */
        readonly fromHistoryFloor?: boolean;
      },
    ) => Effect.Effect<ReadonlyArray<KinMessage>, RepositoryError>;
    readonly insertWidget: (
      input: Omit<KinWidget, "revision"> & Audience,
    ) => Effect.Effect<void, RepositoryError>;
    readonly updateWidget: (
      input: Omit<KinWidget, "revision" | "type" | "widgetClass" | "chatId" | "messageId"> &
        Audience & {
          readonly expectedRevision: typeof NonNegativeInt.Type;
        },
    ) => Effect.Effect<KinWidget, RepositoryError>;
    readonly getReadState: (
      input: MemberScope,
    ) => Effect.Effect<Option.Option<KinReadState>, RepositoryError>;
    readonly markRead: (
      input: MemberScope & {
        readonly seq: typeof NonNegativeInt.Type;
        readonly updatedAt: IsoDateTime;
      },
    ) => Effect.Effect<void, RepositoryError>;
    readonly unreadCount: (input: MemberScope) => Effect.Effect<number, RepositoryError>;
    /** `unreadCount` of each chat the person is in, by chat id. */
    readonly unreadCounts: (
      input: Scope & { readonly personId: KinPersonId },
    ) => Effect.Effect<ReadonlyMap<KinChatId, number>, RepositoryError>;
    /** The app badge: `unreadCount` summed over the chats the Chats list shows the person. */
    readonly unreadTotal: (
      input: Scope & { readonly personId: KinPersonId },
    ) => Effect.Effect<number, RepositoryError>;
    readonly resolveWaiting: (
      input: Scope & {
        readonly waitingId: KinWaitingId;
        readonly resolvedAt: IsoDateTime;
        readonly resolution: typeof TrimmedNonEmptyString.Type;
      },
    ) => Effect.Effect<boolean, RepositoryError>;
    readonly endAgentThread: (
      input: Scope & { readonly threadId: ThreadId; readonly endedAt: IsoDateTime },
    ) => Effect.Effect<boolean, RepositoryError>;
    /**
     * Deletes everything said in a chat and every row keyed by one of its messages; the chat, its
     * members, read positions and `last_seq` stay. Turns answering those messages are marked
     * aborted and what was queued about them never runs. Returns what the caller finishes after
     * the commit.
     */
    /** How many of the chat's files a doc of its org uses: a clear leaves these. */
    readonly docKeptFiles: (input: ChatScope) => Effect.Effect<number, RepositoryError>;
    readonly clearChat: (
      input: ChatScope & { readonly clearedAt: IsoDateTime; readonly clearedAtMs: number },
    ) => Effect.Effect<
      {
        readonly lastSeq: number;
        readonly lastChangeSeq: number;
        readonly attachmentIds: ReadonlyArray<string>;
        /** The chat's files that stay because a doc uses them. */
        readonly keptFiles: number;
        /** The open items it closed. */
        readonly waiting: ReadonlyArray<KinWaitingItem>;
        readonly taskCards: ReadonlyArray<KinWidget>;
        readonly abortedWakeupIds: ReadonlyArray<KinWakeupId>;
        /** Leads whose queued events were dropped. */
        readonly agentIds: ReadonlyArray<KinAgentId>;
        /** A suggestion of Kin's waiting here ended unanswered (`kin_recommendations`). */
        readonly endedSuggestion: boolean;
      },
      RepositoryError
    >;
  }
>()("t3/kin/chat/KinChatRepository") {}

// Record validation shares the enclosing repository operation span.
const requireRecord = Effect.fnUntraced(function* <A, E, R>(
  effect: Effect.Effect<Option.Option<A>, E, R>,
) {
  const record = yield* effect;
  return Option.isSome(record)
    ? record.value
    : yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
});
const sameRefs = (
  stored: ReadonlyArray<KinMessageRefInput>,
  asked: ReadonlyArray<KinMessageRefInput>,
) =>
  stored.length === asked.length &&
  stored.every(
    (ref, index) =>
      ref.key === asked[index]?.key &&
      ref.version === asked[index]?.version &&
      ref.section === asked[index]?.section,
  );
const refRefused = (message: string) => new KinChatError({ reason: "not_allowed", message });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const linked = (...args: Parameters<typeof withLinks>) =>
    withLinks(...args).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const named_ = (orgId: KinOrgId, chatId: KinChatId, body: string) =>
    nameKeys(orgId, chatId, body).pipe(
      Effect.map((named) => ({
        body: named.body,
        json: named.names.length === 0 ? null : encodeNames(named.names),
      })),
      Effect.provideService(SqlClient.SqlClient, sql),
    );
  const keepNames = (orgId: KinOrgId, messageId: string, json: string | null) =>
    json === null
      ? sql`DELETE FROM kin_message_names WHERE org_id = ${orgId} AND message_id = ${messageId}`
      : sql`INSERT INTO kin_message_names (org_id, message_id, names_json)
          VALUES (${orgId}, ${messageId}, ${json})
          ON CONFLICT (org_id, message_id) DO UPDATE SET names_json = excluded.names_json`;
  // A doc of the org shows the file, by `kin-file:` or as a generated version; docs are archived,
  // never deleted, so any doc row keeps it.
  const docUses = (orgId: KinOrgId) =>
    sql`(attachment_id IN (SELECT attachment_id FROM kin_doc_files WHERE org_id = ${orgId})
      OR attachment_id IN (SELECT file_attachment_id FROM kin_doc_versions
        WHERE org_id = ${orgId} AND file_attachment_id IS NOT NULL))`;
  /**
   * The doc sections a message points at, checked in the write's transaction: a person's own
   * message, docs of this org at a version they have that everyone in the chat reads (any doc for
   * the org owner), and nothing sensitive where others read.
   */
  const resolveRefs = Effect.fnUntraced(function* (
    input: Scope & { readonly chatId: KinChatId },
    author: InsertMessage["author"],
    refs: ReadonlyArray<KinMessageRefInput>,
  ) {
    if (refs.length === 0) return [];
    if (author._tag !== "human") return yield* refRefused("Only a person can point at a doc.");
    const owner = yield* isOrgOwner(input.orgId, author.personId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    const readers = yield* sql<{ personId: KinPersonId }>`SELECT person_id AS "personId"
      FROM kin_chat_members WHERE org_id = ${input.orgId}
      AND chat_id = ${input.chatId} AND principal_kind = 'person' AND left_at IS NULL
      ORDER BY person_id`;
    const others = readers.filter((reader) => reader.personId !== author.personId);
    const resolved: Array<KinMessageRef> = [];
    for (const ref of refs) {
      const [doc] = yield* sql<{
        recordId: string;
        title: string;
        body: string;
        sensitive: number;
      }>`
        SELECT r.record_id AS "recordId", v.title, v.body, ${sensitiveNow(sql)} AS sensitive
        FROM kin_records r JOIN kin_doc_versions v ON v.org_id = r.org_id
          AND v.record_id = r.record_id AND v.version = ${ref.version}
        WHERE r.org_id = ${input.orgId} AND r.key = ${ref.key} AND r.register_id = 'docs'
        ORDER BY r.record_id`;
      // A teammate points only at a doc everyone in the chat already reads; one they can't is none.
      const seen =
        doc !== undefined &&
        (owner ||
          (doc.sensitive === 0 &&
            (yield* viewVisible(
              input.orgId,
              readers.map((reader) => reader.personId),
              doc.recordId,
            ).pipe(Effect.provideService(SqlClient.SqlClient, sql)))));
      if (doc === undefined || !seen)
        return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
      if (doc.sensitive === 1 && others.length > 0)
        return yield* refRefused("That doc is sensitive: point at it in a chat only you read.");
      const section =
        ref.section === null
          ? undefined
          : sectionsOf(doc.body).find((part) => part.id === ref.section);
      if (ref.section !== null && section === undefined)
        return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
      resolved.push({
        ...ref,
        title: doc.title as KinMessageRef["title"],
        sectionTitle: section === undefined ? null : section.title,
      });
    }
    return resolved;
  });
  const orgOne = Effect.fn("KinChatRepository.getOrg")(
    function (input: Scope) {
      return SqlSchema.findOneOption({
        Request: Schema.Unknown,
        Result: OrgRow,
        execute: () =>
          sql`SELECT ${sql.literal(orgColumns)} FROM kin_orgs WHERE org_id = ${input.orgId}`,
      })(input).pipe(NodeSqliteClient.readOnly);
    },
    Effect.mapError(toRepositoryError("KinChatRepository.getOrg")),
  );
  const personOne = Effect.fn("KinChatRepository.getPerson")(
    function (input: Scope & { readonly personId: KinPersonId }) {
      return SqlSchema.findOneOption({
        Request: Schema.Unknown,
        Result: PersonRow,
        execute: () =>
          sql`SELECT ${sql.literal(personColumns)} FROM kin_people WHERE org_id = ${input.orgId} AND person_id = ${input.personId}`,
      })(input).pipe(NodeSqliteClient.readOnly);
    },
    Effect.mapError(toRepositoryError("KinChatRepository.getPerson")),
  );
  const agentOne = Effect.fn("KinChatRepository.getAgent")(
    function (input: Scope & { readonly agentId: KinAgentId }) {
      return SqlSchema.findOneOption({
        Request: Schema.Unknown,
        Result: AgentIdentityRow,
        execute: () =>
          sql`SELECT ${sql.literal(agentColumns)}, retired_at AS "retiredAt" FROM kin_agents WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId}`,
      })(input).pipe(NodeSqliteClient.readOnly);
    },
    Effect.mapError(toRepositoryError("KinChatRepository.getAgent")),
  );
  const chatOne = Effect.fn("KinChatRepository.getChat")(
    function (input: Scope & { readonly chatId: KinChatId }) {
      return SqlSchema.findOneOption({
        Request: Schema.Unknown,
        Result: ChatRow,
        execute: () =>
          sql`SELECT ${sql.literal(chatColumns)} FROM kin_chats WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}`,
      })(input).pipe(NodeSqliteClient.readOnly);
    },
    Effect.mapError(toRepositoryError("KinChatRepository.getChat")),
  );
  const memberOne = Effect.fn("KinChatRepository.getMember")(
    function (input: Scope & { readonly memberId: KinMemberId }) {
      return SqlSchema.findOneOption({
        Request: Schema.Unknown,
        Result: MemberRow,
        execute: () =>
          sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members WHERE org_id = ${input.orgId} AND member_id = ${input.memberId}`,
      })(input).pipe(NodeSqliteClient.readOnly);
    },
    Effect.mapError(toRepositoryError("KinChatRepository.getMember")),
  );
  const messageOne = Effect.fn("KinChatRepository.getMessage")(
    function (input: Scope & { readonly messageId: KinMessageId }) {
      return SqlSchema.findOneOption({
        Request: Schema.Unknown,
        Result: MessageRow,
        execute: () =>
          sql`SELECT ${sql.literal(messageColumns)} FROM kin_messages WHERE org_id = ${input.orgId} AND message_id = ${input.messageId}`,
      })(input).pipe(NodeSqliteClient.readOnly);
    },
    Effect.mapError(toRepositoryError("KinChatRepository.getMessage")),
  );
  const attachmentChat = Effect.fn("KinChatRepository.attachmentChat")(
    function (attachmentId: string) {
      return SqlSchema.findOneOption({
        Request: Schema.String,
        Result: AttachmentChat,
        execute: (id) =>
          sql`SELECT a.org_id AS "orgId", a.chat_id AS "chatId", a.message_id AS "messageId" FROM kin_message_attachments a
 JOIN kin_messages m ON m.org_id = a.org_id AND m.message_id = a.message_id
 WHERE a.attachment_id = ${id} AND m.status <> 'deleted'`,
      })(attachmentId).pipe(NodeSqliteClient.readOnly);
    },
    Effect.mapError(toRepositoryError("KinChatRepository.attachmentChat")),
  );
  const widgetOne = Effect.fn("KinChatRepository.getWidget")(
    function (input: Scope & { readonly widgetId: KinWidgetId }) {
      return SqlSchema.findOneOption({
        Request: Schema.Unknown,
        Result: WidgetRow,
        execute: () =>
          sql`SELECT ${sql.literal(widgetColumns)} FROM kin_widgets WHERE org_id = ${input.orgId} AND widget_id = ${input.widgetId}`,
      })(input).pipe(NodeSqliteClient.readOnly);
    },
    Effect.mapError(toRepositoryError("KinChatRepository.getWidget")),
  );
  const waitingOne = Effect.fn("KinChatRepository.getWaiting")(
    function (input: Scope & { readonly waitingId: KinWaitingId }) {
      return SqlSchema.findOneOption({
        Request: Schema.Unknown,
        Result: WaitingAskRow,
        execute: () =>
          sql`SELECT ${sql.literal(waitingColumns)} FROM kin_waiting WHERE org_id = ${input.orgId} AND waiting_id = ${input.waitingId}`,
      })(input).pipe(NodeSqliteClient.readOnly, Effect.map(Option.map(withoutNoQuestion)));
    },
    Effect.mapError(toRepositoryError("KinChatRepository.getWaiting")),
  );
  const coOwnerViewer = (input: Scope & { readonly personId: KinPersonId }) =>
    sql`EXISTS (SELECT 1 FROM kin_people v WHERE v.org_id = ${input.orgId}
      AND v.person_id = ${input.personId} AND v.removed_at IS NULL
      AND ${sql.literal(accessSql("v"))} = 'co_owner')`;
  /**
   * The one rule for seeing what waits on someone else: a co-owner, not removed, sees the owner's
   * open asks in chats he is still in, to look at only. A mention is between people, and a card
   * already waiting on her shows once, as hers. Nobody else gets a row.
   */
  const ownersWaiting = (input: Scope & { readonly personId: KinPersonId }) =>
    sql`SELECT ${sql.literal(waitingColumns)},
        (SELECT p.display_name FROM kin_people p WHERE p.org_id = kin_waiting.org_id
          AND p.person_id = kin_waiting.person_id) AS "waitsForName"
      FROM kin_waiting
      WHERE org_id = ${input.orgId} AND resolved_at IS NULL AND reason <> 'mention'
        AND person_id <> ${input.personId} AND ${coOwnerViewer(input)}
        AND EXISTS (SELECT 1 FROM kin_people o WHERE o.org_id = kin_waiting.org_id
          AND o.person_id = kin_waiting.person_id AND o.removed_at IS NULL
          AND ${sql.literal(accessSql("o"))} = 'owner')
        AND EXISTS (SELECT 1 FROM kin_chat_members m WHERE m.org_id = kin_waiting.org_id
          AND m.chat_id = kin_waiting.chat_id AND m.person_id = kin_waiting.person_id
          AND m.left_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM kin_waiting mine JOIN kin_chat_members mm
            ON mm.org_id = mine.org_id AND mm.chat_id = mine.chat_id
              AND mm.person_id = mine.person_id AND mm.left_at IS NULL
          WHERE mine.org_id = kin_waiting.org_id AND mine.person_id = ${input.personId}
            AND mine.resolved_at IS NULL
            AND COALESCE(mine.widget_id, mine.message_id)
              = COALESCE(kin_waiting.widget_id, kin_waiting.message_id))`;
  const agentThreadOne = Effect.fn("KinChatRepository.getAgentThread")(
    function (input: Scope & { readonly threadId: ThreadId }) {
      return SqlSchema.findOneOption({
        Request: Schema.Unknown,
        Result: AgentThreadRow,
        execute: () =>
          sql`SELECT ${sql.literal(agentThreadColumns)} FROM kin_agent_threads WHERE org_id = ${input.orgId} AND thread_id = ${input.threadId}`,
      })(input).pipe(NodeSqliteClient.readOnly);
    },
    Effect.mapError(toRepositoryError("KinChatRepository.getAgentThread")),
  );
  const hasRunningWakeup = Effect.fn("KinChatRepository.hasRunningWakeup")(
    function* (
      input: Scope & {
        readonly agentId: KinAgentId;
        readonly threadId: ThreadId;
        readonly caller: McpThreadCaller;
      },
    ) {
      if (input.caller.subagent === true || input.caller.threadId !== input.threadId) return false;
      const rows = yield* wakeupOfRuns(
        sql,
        sql`SELECT run_id, thread_id, ordinal, payload_json
          FROM orchestration_v2_projection_runs INDEXED BY orchestration_v2_projection_runs_thread_status_idx
          WHERE thread_id = ${input.threadId} AND status IN ${sql.in(ACTIVE_RUN_STATUSES)}`,
        sql`w.org_id = ${input.orgId} AND w.agent_id = ${input.agentId}
          AND w.thread_id = ${input.threadId} AND w.status = 'running'`,
      );
      return rows.length > 0;
    },
    Effect.mapError(toRepositoryError("KinChatRepository.hasRunningWakeup")),
  );
  const wakeupPosts = Effect.fn("KinChatRepository.wakeupPosts")(
    function* (input: ChatScope & { readonly agentId: KinAgentId; readonly threadId: ThreadId }) {
      const rows = yield* sql<{ messages: number; chars: number }>`
        SELECT COUNT(m.message_id) AS messages, COALESCE(SUM(length(m.body)), 0) AS chars
        FROM kin_wakeups w JOIN kin_messages m ON m.org_id = w.org_id AND m.chat_id = ${input.chatId}
          AND m.author_kind = 'agent' AND m.author_agent_id = w.agent_id
          AND m.author_thread_id = w.thread_id
          AND m.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', w.started_at / 1000.0, 'unixepoch')
        WHERE w.org_id = ${input.orgId} AND w.agent_id = ${input.agentId}
          AND w.thread_id = ${input.threadId} AND w.status = 'running'
        GROUP BY w.wakeup_id ORDER BY w.wakeup_id LIMIT 1`;
      return { messages: rows[0]?.messages ?? 0, chars: rows[0]?.chars ?? 0 };
    },
    Effect.mapError(toRepositoryError("KinChatRepository.wakeupPosts")),
  );
  const wakeupRunning = Effect.fn("KinChatRepository.wakeupRunning")(
    function* (input: Scope & { agentId: KinAgentId; threadId: ThreadId; wakeupId: KinWakeupId }) {
      const rows = yield* sql`SELECT 1 FROM kin_wakeups WHERE org_id = ${input.orgId}
        AND wakeup_id = ${input.wakeupId} AND agent_id = ${input.agentId}
        AND thread_id = ${input.threadId} AND status = 'running' ORDER BY wakeup_id LIMIT 1`;
      return rows.length > 0;
    },
    Effect.mapError(toRepositoryError("KinChatRepository.wakeupRunning")),
  );
  // A check-in or routine's own turn reads as a brief. The morning and weekly brief's turn has one
  // page ("page"): the first text it stores in its owner's chat; all else it stores is ordinary.
  const briefForm = Effect.fn("KinChatRepository.briefForm")(function* (input: {
    orgId: KinOrgId;
    chatId: KinChatId;
    messageId: KinMessageId;
    wakeupId?: KinWakeupId | undefined;
    audience: WriteAudience;
    kind: KinMessage["kind"];
    author: KinMessage["author"];
  }) {
    if (
      input.author._tag !== "agent" ||
      input.kind !== "text" ||
      input.wakeupId === undefined ||
      input.audience === "chat"
    )
      return null;
    const [brief] = yield* sql<{ page: number; lane: number }>`SELECT
        json_extract(e.json, '$.checkIn.scheduleId') IN ('checkin-morning', 'checkin-weekly') AS page,
        EXISTS (SELECT 1 FROM kin_leads l WHERE l.org_id = e.org_id AND l.agent_id = e.agent_id
          AND l.owner_chat_id = ${input.chatId}) AS lane
      FROM kin_events e WHERE e.org_id = ${input.orgId} AND e.wakeup_id = ${input.wakeupId}
        AND ((e.tag = 'pulse' AND json_extract(e.json, '$.checkIn') IS NOT NULL)
          OR (e.tag = 'routine' AND json_extract(e.json, '$.routine') IN ('morning_brief', 'evening_summary')))
        AND NOT EXISTS (SELECT 1 FROM kin_events m WHERE m.org_id = e.org_id
          AND m.wakeup_id = e.wakeup_id AND m.tag = 'chat.message')
      ORDER BY e.event_id LIMIT 1`;
    if (brief === undefined) return null;
    if (brief.page !== 1) return "brief" as const;
    if (brief.lane !== 1) return null;
    const earlier = yield* sql`SELECT 1 FROM kin_messages m
      JOIN kin_wakeups w ON w.org_id = m.org_id AND w.wakeup_id = ${input.wakeupId}
      WHERE m.org_id = ${input.orgId} AND m.chat_id = ${input.chatId} AND m.author_kind = 'agent'
        AND m.author_agent_id = w.agent_id AND m.author_thread_id = w.thread_id
        AND m.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', w.started_at / 1000.0, 'unixepoch')
        AND m.kind = 'text' AND m.body <> '' AND m.status = 'posted'
        AND m.message_id <> ${input.messageId}
      LIMIT 1`;
    return earlier.length === 0 ? ("page" as const) : null;
  });
  /** The stored form and body: the brief's page, or a card's empty message it joins, opens headed. */
  const briefed = (form: "page" | "brief" | null, body: string, prior = "") => ({
    form: form === "page" ? ("brief" as const) : form,
    body:
      form === "page" && prior === "" && body !== "" && !kinIsPage(body)
        ? `## Today\n\n${body}`
        : body,
  });
  const replyCard = Effect.fn("KinChatRepository.replyCard")(
    function* (input: ReplyScope) {
      const cards = yield* sql<{ id: KinMessageId; eligible: number }>`SELECT m.message_id AS id,
          (m.seq = c.last_seq AND m.body = '' AND m.status = 'posted' AND m.kind = 'text' AND w.type <> 'approval') AS eligible
        FROM kin_messages m JOIN kin_chats c ON c.org_id = m.org_id AND c.chat_id = m.chat_id
        JOIN kin_widgets w ON w.org_id = m.org_id AND w.widget_id = m.widget_id
        WHERE m.org_id = ${input.orgId} AND m.chat_id = ${input.chatId}
          AND m.author_agent_id = ${input.agentId} AND m.author_thread_id = ${input.threadId}
          AND m.source_wakeup_id = ${input.wakeupId}
        LIMIT 2`;
      if (cards.length === 1 && cards[0]?.eligible === 1) return cards[0].id;
      if (cards.length > 0) yield* Effect.logDebug("Kin skipped joining a reply to its card");
      return null;
    },
    Effect.mapError(toRepositoryError("KinChatRepository.replyCard")),
  );
  const placeFigures = Effect.fn("KinChatRepository.placeFigures")(function* (
    input: ReplyScope & { readonly body: string; readonly previous?: KinMessage },
  ) {
    const { body: prior = "", embeds: existing = [] } = input.previous ?? {};
    const figures = yield* decodeFigures(
      yield* sql`SELECT figure_id AS id, embed_json AS embed, attachment_id AS "attachmentId"
      FROM kin_turn_figures WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId}
        AND agent_id = ${input.agentId} AND chat_id = ${input.chatId} AND message_id IS NULL
        AND kind <> 'picture'
      ORDER BY created_at, rowid`,
    );
    const pictures = yield* decodePictures(
      yield* sql`SELECT figure_id AS id, embed_json AS picture, attachment_id AS "attachmentId"
      FROM kin_turn_figures WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId}
        AND agent_id = ${input.agentId} AND chat_id = ${input.chatId} AND message_id IS NULL
        AND kind = 'picture'
      ORDER BY created_at, rowid`,
    );
    const tail = input.body
      .slice(prior.length)
      .replace(/^([ ]{0,3}(?:`{3,}|~{3,})[ \t]*)kin_(?:chart|visual)\b/gm, "$1text");
    const candidates = new Map(figures.map((figure) => [figure.id, figure]));
    let body = prior + tail.replace(figureToken, (_token, title: string) => title);
    const placed = new Map<string, typeof StoredFigure.Type>();
    const room = KIN_MESSAGE_FIGURES_MAX - existing.length;
    const accept = (next: string, figure: typeof StoredFigure.Type) => {
      if (
        placed.size >= room ||
        next.length > KIN_MESSAGE_BODY_MAX_LENGTH ||
        !kinDocBlocks(next).some((block) => block.content === figure.id)
      )
        return false;
      body = next;
      placed.set(figure.id, figure);
      return true;
    };
    let at = prior.length;
    for (const line of tail.split("\n")) {
      const stripped = line.replace(figureToken, (_token, title: string) => title);
      const token = [...line.trim().matchAll(figureToken)][0];
      const figure = token?.[0] === line.trim() ? candidates.get(token?.[2] ?? "") : undefined;
      const block = figure === undefined ? "" : figureBlock(figure);
      const next =
        figure !== undefined &&
        !placed.has(figure.id) &&
        accept(body.slice(0, at) + block + body.slice(at + stripped.length), figure);
      at += (next ? block.length : stripped.length) + 1;
    }
    for (const figure of figures)
      if (!placed.has(figure.id))
        accept(`${body}${body === "" ? "" : "\n\n"}${figureBlock(figure)}`, figure);
    const ordered = kinDocBlocks(body).flatMap((block) => {
      const figure = placed.get(block.content);
      return figure === undefined ? [] : [figure];
    });
    return {
      body,
      embeds: [...existing, ...ordered.map((figure) => figure.embed)],
      figures: [...ordered, ...pictures],
      pictures: pictures.map((one) => one.picture),
    };
  });
  /** Each picture's doc version as the reply's chip, titled as stored; one that isn't there is none. */
  const pictureRefsOf = Effect.fn("KinChatRepository.pictureRefsOf")(function* (
    orgId: KinOrgId,
    docs: ReadonlyArray<PictureDoc>,
  ) {
    const refs: Array<KinMessageRef> = [];
    for (const doc of docs) {
      const [row] = yield* sql<{ title: string }>`SELECT v.title FROM kin_records r
        JOIN kin_doc_versions v ON v.org_id = r.org_id AND v.record_id = r.record_id
          AND v.version = ${doc.version}
        WHERE r.org_id = ${orgId} AND r.key = ${doc.key} AND r.register_id = 'docs'
        ORDER BY r.record_id`;
      if (row === undefined)
        return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
      refs.push({
        _tag: "doc",
        key: doc.key,
        version: doc.version,
        section: null,
        title: row.title,
        sectionTitle: null,
      });
    }
    return refs;
  });
  /** The pictures placed on a message: their images and their docs' versions. */
  const drawnOn = Effect.fn("KinChatRepository.drawnOn")(function* (
    orgId: KinOrgId,
    messageId: KinMessageId,
  ) {
    const rows = yield* decodePictures(
      yield* sql`SELECT figure_id AS id, embed_json AS picture, attachment_id AS "attachmentId"
        FROM kin_turn_figures WHERE org_id = ${orgId} AND message_id = ${messageId}
          AND kind = 'picture' ORDER BY created_at, rowid`,
    );
    return {
      attachments: new Set(rows.map((row) => row.picture.attachment.id)),
      refs: new Set(rows.map((row) => `${row.picture.doc.key}@${row.picture.doc.version}`)),
    };
  });
  /** A message's chips with these added once each, up to the cap. */
  const withRefs = (existing: ReadonlyArray<KinMessageRef>, added: ReadonlyArray<KinMessageRef>) =>
    [
      ...existing,
      ...added.filter(
        (ref) => !existing.some((one) => one.key === ref.key && one.version === ref.version),
      ),
    ].slice(0, KIN_MESSAGE_REFS_CAP);
  const keepFigures = Effect.fn("KinChatRepository.keepFigures")(function* (
    input: ChatScope & { readonly messageId: KinMessageId },
    figures: ReadonlyArray<{ readonly id: string; readonly attachmentId: string | null }>,
  ) {
    for (const figure of figures) {
      yield* sql`UPDATE kin_turn_figures SET message_id = ${input.messageId}
        WHERE org_id = ${input.orgId} AND figure_id = ${figure.id} AND message_id IS NULL`;
      if (figure.attachmentId !== null)
        yield* sql`INSERT INTO kin_message_attachments (attachment_id, org_id, chat_id, message_id)
          VALUES (${figure.attachmentId}, ${input.orgId}, ${input.chatId}, ${input.messageId})`;
    }
  });
  // Inside the write's transaction, so a join commits wholly before or after this write.
  const ownerOnly = Effect.fn("KinChatRepository.ownerOnly")(function* (
    audience: WriteAudience,
    input: ChatScope,
  ) {
    if (audience === "owner" && (yield* chatShared(sql, input)))
      return yield* new KinChatError({ reason: "not_allowed", message: PRIVATE_WRITE_REFUSED });
  });
  const validateWidgetReferences = Effect.fn("KinChatRepository.validateWidgetReferences")(
    function* (input: Pick<KinWidget, "orgId" | "chatId" | "awaiting" | "source">) {
      for (const personId of input.awaiting) {
        yield* requireRecord(personOne({ orgId: input.orgId, personId }));
        yield* requireRecord(
          SqlSchema.findOneOption({
            Request: Schema.Unknown,
            Result: MemberRow,
            execute: () => sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members
 WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND person_id = ${personId} AND left_at IS NULL`,
          })(input),
        );
      }
      if (input.source !== null) {
        const thread = yield* requireRecord(
          agentThreadOne({ orgId: input.orgId, threadId: input.source.threadId }),
        );
        yield* requireRecord(
          SqlSchema.findOneOption({
            Request: Schema.Unknown,
            Result: MemberRow,
            execute: () => sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members
 WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND agent_id = ${thread.agentId}`,
          })(input),
        );
      }
    },
  );
  const addWaiting = Effect.fn("KinChatRepository.addWaiting")(
    function* (input: KinWaitingItem, approval: boolean) {
      if (input.resolvedAt !== null || input.resolution !== null)
        return yield* new KinChatError({
          reason: "invalid_state",
          message: "New waiting items must be open.",
        });
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* requireRecord(chatOne(input));
          yield* requireRecord(personOne(input));
          yield* requireRecord(
            SqlSchema.findOneOption({
              Request: Schema.Unknown,
              Result: MemberRow,
              execute: () => sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members
 WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND person_id = ${input.personId} AND left_at IS NULL`,
            })(input),
          );
          if (input.messageId !== null) {
            const message = yield* requireRecord(
              messageOne({ orgId: input.orgId, messageId: input.messageId }),
            );
            if (message.chatId !== input.chatId)
              return yield* new KinChatError({
                reason: "not_found",
                message: "Kin record not found.",
              });
          }
          if (input.widgetId !== null) {
            const widget = yield* requireRecord(
              widgetOne({ orgId: input.orgId, widgetId: input.widgetId }),
            );
            if (widget.chatId !== input.chatId)
              return yield* new KinChatError({
                reason: "not_found",
                message: "Kin record not found.",
              });
          }
          const approvalWidgets =
            yield* sql`SELECT widget_id FROM kin_widgets WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND type = 'approval' AND (widget_id = ${input.widgetId} OR message_id = ${input.messageId} OR message_id IN (SELECT message_id FROM kin_widgets WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND widget_id = ${input.widgetId})) ORDER BY widget_id`;
          if (
            approval
              ? input.reason !== "approval" ||
                input.widgetId === null ||
                (yield* requireRecord(widgetOne({ orgId: input.orgId, widgetId: input.widgetId })))
                  .type !== "approval"
              : input.reason === "approval" || approvalWidgets.length > 0
          )
            return yield* new KinChatError({
              reason: "not_allowed",
              message: "Chat operation not allowed.",
            });
          const existing = yield* SqlSchema.findOneOption({
            Request: Schema.Unknown,
            Result: WaitingRow,
            execute: () =>
              sql`SELECT ${sql.literal(waitingBaseColumns)} FROM kin_waiting WHERE waiting_id = ${input.waitingId}`,
          })(input);
          if (Option.isSome(existing)) {
            if (existing.value.orgId !== input.orgId)
              return yield* new KinChatError({
                reason: "not_found",
                message: "Kin record not found.",
              });
            if (
              !(
                [
                  "orgId",
                  "personId",
                  "chatId",
                  "messageId",
                  "widgetId",
                  "reason",
                  "createdAt",
                ] as const
              ).every((key) => existing.value[key] === input[key])
            )
              return yield* new KinChatError({
                reason: "not_allowed",
                message: "Kin waiting identity conflict.",
              });
            return true;
          }
          const inserted =
            yield* sql`INSERT INTO kin_waiting (waiting_id, org_id, person_id, chat_id, message_id, widget_id, reason, created_at, resolved_at, resolution) VALUES (${input.waitingId}, ${input.orgId}, ${input.personId}, ${input.chatId}, ${input.messageId}, ${input.widgetId}, ${input.reason}, ${input.createdAt}, ${input.resolvedAt}, ${input.resolution}) ON CONFLICT (widget_id, person_id) WHERE resolved_at IS NULL AND widget_id IS NOT NULL DO NOTHING RETURNING waiting_id`;
          return inserted.length > 0;
        }),
      );
    },
    Effect.mapError(toRepositoryError("KinChatRepository.addWaiting")),
  );
  // A card with no words of its own, once closed (answered, replaced, run out), is Kin's status
  // of it, not a message: it leaves the unread count. A card that carries words still counts.
  const notStatusLine = sql`NOT (kin_messages.body = '' AND EXISTS (SELECT 1 FROM kin_widgets w
 WHERE w.org_id = kin_messages.org_id AND w.message_id = kin_messages.message_id
 AND w.closed_at IS NOT NULL))`;
  // `unreadCount` for each of a person's chats in one read, each from its own member row's join.
  const unreadByChat = (
    input: Scope & { readonly personId: KinPersonId },
    chats: Statement.Fragment,
  ) =>
    sql<{ chatId: KinChatId; count: number }>`SELECT m.chat_id AS "chatId",
 COUNT(kin_messages.message_id) AS count
 FROM kin_chat_members m JOIN kin_chats c ON c.org_id = m.org_id AND c.chat_id = m.chat_id
 LEFT JOIN kin_messages ON kin_messages.org_id = m.org_id AND kin_messages.chat_id = m.chat_id
 AND kin_messages.status = 'posted' AND kin_messages.silent = 0 AND ${notStatusLine}
 AND (kin_messages.author_member_id IS NULL OR kin_messages.author_member_id != m.member_id)
 AND ${readableFrom(sql, input.orgId, sql`COALESCE(m.joined_seq, 0)`)}
 AND kin_messages.seq > COALESCE((SELECT r.last_read_seq FROM kin_read_state r WHERE r.org_id = m.org_id
 AND r.chat_id = m.chat_id AND r.member_id = m.member_id), 0)
 WHERE m.org_id = ${input.orgId} AND m.person_id = ${input.personId} AND m.principal_kind = 'person'
 AND m.left_at IS NULL AND ${chats}
 GROUP BY m.chat_id ORDER BY m.chat_id`.pipe(NodeSqliteClient.readOnly);
  const unreadCount = Effect.fn("KinChatRepository.unreadCount")(
    function* (input: MemberScope) {
      const row = yield* SqlSchema.findOneOption({
        Request: Schema.Unknown,
        Result: Schema.Struct({ count: NonNegativeInt }),
        execute: () => sql`SELECT COUNT(*) AS count FROM kin_messages WHERE org_id = ${input.orgId}
 AND chat_id = ${input.chatId} AND status = 'posted' AND silent = 0 AND ${notStatusLine}
 AND (author_member_id IS NULL OR author_member_id != ${input.memberId})
 AND ${readableBy(sql, input.orgId, input.memberId)}
 AND seq > COALESCE((SELECT last_read_seq FROM kin_read_state WHERE org_id = ${input.orgId}
 AND chat_id = ${input.chatId} AND member_id = ${input.memberId}), 0)`,
      })(input).pipe(NodeSqliteClient.readOnly);
      return Option.isSome(row) ? row.value.count : 0;
    },
    Effect.mapError(toRepositoryError("KinChatRepository.unreadCount")),
  );
  return KinChatRepository.of({
    hasRunningWakeup,
    wakeupRunning,
    wakeupPosts,
    getOrg: orgOne,
    getPerson: personOne,
    getAgent: agentOne,
    getChat: chatOne,
    getMember: memberOne,
    getMessage: messageOne,
    attachmentChat,
    chatFiles: Effect.fn("KinChatRepository.chatFiles")(
      function (input) {
        return SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: ChatFile,
          execute: () => sql`SELECT a.attachment_id AS "attachmentId", a.message_id AS "messageId",
   (SELECT json_extract(j.value, '$.mimeType') FROM json_each(COALESCE(m.attachments_json, '[]')) j
     WHERE json_extract(j.value, '$.id') = a.attachment_id) AS "mimeType"
 FROM kin_message_attachments a
 JOIN kin_messages m ON m.org_id = a.org_id AND m.message_id = a.message_id
 WHERE a.org_id = ${input.orgId} AND a.chat_id = ${input.chatId} AND m.status <> 'deleted'
 ORDER BY a.attachment_id`,
        })(input).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.chatFiles")),
    ),
    attachCardFile: Effect.fn("KinChatRepository.attachCardFile")(
      function* (input) {
        const message = yield* requireRecord(messageOne(input));
        if (message.chatId !== input.chatId)
          return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
        yield* sql`INSERT INTO kin_message_attachments (attachment_id, org_id, chat_id, message_id)
 VALUES (${input.attachmentId}, ${input.orgId}, ${input.chatId}, ${input.messageId})`;
      },
      Effect.mapError(toRepositoryError("KinChatRepository.attachCardFile")),
    ),
    openTaskCards: Effect.fn("KinChatRepository.openTaskCards")(
      (input) =>
        SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: WidgetRow,
          execute: () =>
            sql`SELECT ${sql.literal(widgetColumns)} FROM kin_widgets WHERE org_id = ${input.orgId} AND type = 'task' AND closed_at IS NULL ORDER BY widget_id`,
        })(input),
      Effect.mapError(toRepositoryError("KinChatRepository.openTaskCards")),
    ),
    getWidget: widgetOne,
    getWaiting: waitingOne,
    getAgentThread: agentThreadOne,
    bootstrapIdentity: Effect.fn("KinChatRepository.bootstrapIdentity")(
      function* (input) {
        const orgId = defaultOrgId;
        const personId = defaultOwnerId;
        const inserted = yield* sql`INSERT INTO kin_orgs (org_id, name, created_at)
 SELECT ${orgId}, ${input.orgName}, ${input.createdAt} WHERE NOT EXISTS (SELECT 1 FROM kin_orgs)
 ON CONFLICT (org_id) DO NOTHING RETURNING org_id`;
        if (inserted.length > 0) {
          yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, github_login, created_at, access)
 VALUES (${personId}, ${orgId}, ${input.ownerHandle}, ${input.ownerDisplayName}, NULL, ${input.createdAt}, 'owner')
 ON CONFLICT (person_id) DO NOTHING RETURNING person_id`;
          if (input.companyProfileJson !== undefined)
            yield* sql`INSERT INTO kin_company_profile (org_id, profile_json, rev, updated_at,
   updated_by_kind, updated_by_id)
 VALUES (${orgId}, ${input.companyProfileJson}, 1, 0, 'person', ${personId})
 ON CONFLICT (org_id) DO NOTHING`;
        }
        // Never infer ownership from a handle or whichever person happens to sort first.
        const org = yield* orgOne({ orgId });
        if (Option.isNone(org))
          return yield* new KinIdentityBootstrapError({
            message:
              "Kin tables contain an unknown org instead of reserved org `kin-default`; restore the reserved identity or recreate the Kin tables.",
          });
        const owner = yield* personOne({ orgId, personId });
        if (Option.isNone(owner))
          return yield* new KinIdentityBootstrapError({
            message:
              "Kin org `kin-default` exists without owner person `kin-default-owner`; restore it or recreate the Kin tables.",
          });
        if (org.value.name !== input.orgName || owner.value.handle !== input.ownerHandle)
          yield* Effect.logInfo(
            "Kin identity configuration differs from stored org name or owner handle; keeping stored identity.",
          );
        return owner.value;
      },
      (effect) => sql.withTransaction(effect),
      Effect.mapError((cause) =>
        isBootstrapError(cause)
          ? cause
          : toRepositoryError("KinChatRepository.bootstrapIdentity")(cause),
      ),
    ),
    // Only trusted caller-thread discovery crosses orgs; subsequent identity reads use the stored org.
    findAgentThread: Effect.fn("KinChatRepository.findAgentThread")(
      function* (threadId) {
        return yield* SqlSchema.findOneOption({
          Request: Schema.Unknown,
          Result: AgentThreadRow,
          execute: () =>
            sql`SELECT ${sql.literal(agentThreadColumns)} FROM kin_agent_threads WHERE thread_id = ${threadId}`,
        })(threadId).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.findAgentThread")),
    ),
    listActiveAgentThreads: Effect.fn("KinChatRepository.listActiveAgentThreads")(
      function* () {
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: ActiveAgentThreadRow,
          execute: () =>
            sql`SELECT t.org_id AS "orgId", t.thread_id AS "threadId", t.agent_id AS "agentId", t.started_at AS "startedAt", t.ended_at AS "endedAt", a.role AS "role"
 FROM kin_agent_threads t JOIN kin_agents a ON a.org_id = t.org_id AND a.agent_id = t.agent_id
 WHERE t.ended_at IS NULL AND a.retired_at IS NULL
 ORDER BY t.org_id, t.thread_id`,
        })(undefined).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.listActiveAgentThreads")),
    ),
    listAllOrgs: Effect.fn("KinChatRepository.listAllOrgs")(
      function* () {
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: OrgRow,
          execute: () =>
            sql`SELECT ${sql.literal(orgColumns)} FROM kin_orgs ORDER BY created_at, org_id`,
        })(undefined).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.listAllOrgs")),
    ),
    listPeople: Effect.fn("KinChatRepository.listPeople")(
      function* (input) {
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: PersonRow,
          execute: () =>
            sql`SELECT ${sql.literal(personColumns)} FROM kin_people WHERE org_id = ${input.orgId} ORDER BY handle, person_id`,
        })(input).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.listPeople")),
    ),
    listAgents: Effect.fn("KinChatRepository.listAgents")(
      function* (input) {
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: AgentIdentityRow,
          execute: () =>
            sql`SELECT ${sql.literal(agentColumns)}, retired_at AS "retiredAt" FROM kin_agents WHERE org_id = ${input.orgId} ORDER BY display_name, agent_id`,
        })(input).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.listAgents")),
    ),
    listChats: Effect.fn("KinChatRepository.listChats")(
      function* (input) {
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: ChatRow,
          execute: () =>
            sql`SELECT ${sql.literal(chatColumns)} FROM kin_chats WHERE org_id = ${input.orgId} ORDER BY last_message_at DESC, chat_id`,
        })(input).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.listChats")),
    ),
    listMembers: Effect.fn("KinChatRepository.listMembers")(
      function* (input) {
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: MemberRow,
          execute: () =>
            sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} ORDER BY joined_at, member_id`,
        })(input).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.listMembers")),
    ),
    listMembersByPerson: Effect.fn("KinChatRepository.listMembersByPerson")(
      function* (input) {
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: MemberRow,
          execute: () =>
            sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members WHERE org_id = ${input.orgId} AND person_id = ${input.personId} ORDER BY joined_at, member_id`,
        })(input).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.listMembersByPerson")),
    ),
    listMembersByAgent: Effect.fn("KinChatRepository.listMembersByAgent")(
      function* (input) {
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: MemberRow,
          execute: () =>
            sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} ORDER BY joined_at, member_id`,
        })(input).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.listMembersByAgent")),
    ),
    activeMember: Effect.fn("KinChatRepository.activeMember")(
      function (input) {
        return SqlSchema.findOneOption({
          Request: Schema.Unknown,
          Result: MemberRow,
          execute: () => activeMemberStatement(sql, input),
        })(input).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.activeMember")),
    ),
    waitingForWidget: Effect.fn("KinChatRepository.waitingForWidget")(
      function (input) {
        return SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: WaitingAskRow,
          execute: () =>
            sql`SELECT ${sql.literal(waitingColumns)} FROM kin_waiting WHERE org_id = ${input.orgId} AND widget_id = ${input.widgetId} AND resolved_at IS NULL ORDER BY created_at, waiting_id`,
        })(input).pipe(
          NodeSqliteClient.readOnly,
          Effect.map((rows) => rows.map(withoutNoQuestion)),
        );
      },
      Effect.mapError(toRepositoryError("KinChatRepository.waitingForWidget")),
    ),
    approvalAtMessage: Effect.fn("KinChatRepository.approvalAtMessage")(
      function* (input) {
        const rows =
          yield* sql`SELECT widget_id FROM kin_widgets WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND message_id = ${input.messageId} AND type = 'approval' ORDER BY widget_id LIMIT 1`;
        return rows.length > 0;
      },
      Effect.mapError(toRepositoryError("KinChatRepository.approvalAtMessage")),
    ),
    resume: Effect.fn("KinChatRepository.resume")(
      function* (input) {
        const member = yield* requireRecord(memberOne(input));
        if (member.chatId !== input.chatId || member.leftAt !== null)
          return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
        const chat = yield* requireRecord(chatOne(input));
        const counters = yield* sql<{
          change_seq: number;
          cleared_change_seq: number;
          clearedSeq: number;
        }>`SELECT change_seq, cleared_change_seq, cleared_seq AS "clearedSeq" FROM kin_chats WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}`;
        const lastChangeSeq = counters[0]!.change_seq;
        const clearedSeq = counters[0]!.clearedSeq;
        // Deleted rows can't be replayed as changes: a cursor from before the clear starts over.
        if (
          input.afterChangeSeq !== undefined &&
          input.afterChangeSeq < counters[0]!.cleared_change_seq
        )
          return {
            reset: true,
            cleared: true,
            clearedSeq,
            lastSeq: chat.lastSeq,
            lastChangeSeq,
            messages: [],
            widgets: [],
          };
        // Without a change cursor, replay only new messages; change_seq runs ahead of seq.
        const afterChangeSeq = input.afterChangeSeq ?? lastChangeSeq;
        const visible = sql`(${member.role === "owner" ? 1 : 0} = 1 OR status NOT IN ('suggested', 'dismissed') OR author_member_id = ${member.memberId}) AND ${readableBy(sql, input.orgId, member.memberId)}`;
        const messages = yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: MessageRow,
          execute: () =>
            sql`SELECT ${sql.literal(messageColumns)} FROM kin_messages
              WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND message_id IN (
                SELECT message_id FROM (SELECT message_id FROM kin_messages
                  WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND seq > ${input.afterSeq} AND ${visible}
                  ORDER BY seq LIMIT 201)
                UNION
                SELECT message_id FROM (SELECT message_id FROM kin_messages
                  WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND change_seq > ${afterChangeSeq} AND ${visible}
                  ORDER BY change_seq, seq LIMIT 201)
              ) ORDER BY seq LIMIT 201`,
        })(input);
        if (messages.length > 200)
          return {
            reset: true,
            clearedSeq,
            lastSeq: chat.lastSeq,
            lastChangeSeq,
            messages: [],
            widgets: [],
          };
        const widgets =
          messages.length === 0
            ? []
            : yield* SqlSchema.findAll({
                Request: Schema.Unknown,
                Result: WidgetRow,
                execute: () =>
                  sql`SELECT ${sql.literal(widgetColumns)} FROM kin_widgets WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND (message_id IN ${sql.in(messages.map((m) => m.messageId))} OR widget_id IN ${sql.in(messages.flatMap((m) => (m.widgetId === null ? [] : [m.widgetId])))}) ORDER BY message_id, widget_id`,
              })(input);
        return {
          reset: false,
          messages: yield* linked(
            input.orgId,
            member.principal,
            messages.map((m) => messageForViewer(m, member.principal)),
          ),
          widgets,
          clearedSeq,
          lastSeq: chat.lastSeq,
          lastChangeSeq,
        };
      },
      (effect) => sql.withTransaction(effect).pipe(NodeSqliteClient.readOnly),
      Effect.mapError(toRepositoryError("KinChatRepository.resume")),
    ),
    listOpenWaiting: Effect.fn("KinChatRepository.listOpenWaiting")(
      function* (input) {
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: WaitingAskRow,
          execute: () =>
            sql`SELECT ${sql.literal(waitingColumns)} FROM kin_waiting WHERE org_id = ${input.orgId} AND person_id = ${input.personId} AND resolved_at IS NULL ORDER BY created_at, waiting_id`,
        })(input).pipe(
          NodeSqliteClient.readOnly,
          Effect.map((rows) => rows.map(withoutNoQuestion)),
        );
      },
      Effect.mapError(toRepositoryError("KinChatRepository.listOpenWaiting")),
    ),
    listOwnersOpenWaiting: Effect.fn("KinChatRepository.listOwnersOpenWaiting")(
      function* (input) {
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: WaitingAskRow,
          execute: () => sql`${ownersWaiting(input)} ORDER BY created_at, waiting_id`,
        })(input).pipe(
          NodeSqliteClient.readOnly,
          Effect.map((rows) => rows.map(withoutNoQuestion)),
        );
      },
      Effect.mapError(toRepositoryError("KinChatRepository.listOwnersOpenWaiting")),
    ),
    getOwnersOpenWaiting: Effect.fn("KinChatRepository.getOwnersOpenWaiting")(
      function* (input) {
        return yield* SqlSchema.findOneOption({
          Request: Schema.Unknown,
          Result: WaitingAskRow,
          execute: () => sql`${ownersWaiting(input)} AND waiting_id = ${input.waitingId}`,
        })(input).pipe(NodeSqliteClient.readOnly, Effect.map(Option.map(withoutNoQuestion)));
      },
      Effect.mapError(toRepositoryError("KinChatRepository.getOwnersOpenWaiting")),
    ),
    seesOwnersWaiting: Effect.fn("KinChatRepository.seesOwnersWaiting")(
      function* (input) {
        const [row] = yield* sql<{ sees: number }>`SELECT ${coOwnerViewer(input)} AS sees`.pipe(
          NodeSqliteClient.readOnly,
        );
        return row?.sees === 1;
      },
      Effect.mapError(toRepositoryError("KinChatRepository.seesOwnersWaiting")),
    ),
    insertOrg: Effect.fn("KinChatRepository.insertOrg")(
      function* (input) {
        yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES (${input.orgId}, ${input.name}, ${input.createdAt})`;
      },
      Effect.mapError(toRepositoryError("KinChatRepository.insertOrg")),
    ),
    insertPerson: Effect.fn("KinChatRepository.insertPerson")(
      function* (input) {
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, github_login, created_at) VALUES (${input.personId}, ${input.orgId}, ${input.handle}, ${input.displayName}, ${input.githubLogin}, ${input.createdAt})`;
      },
      Effect.mapError(toRepositoryError("KinChatRepository.insertPerson")),
    ),
    insertAgent: Effect.fn("KinChatRepository.insertAgent")(
      function* (input) {
        yield* requireRecord(personOne({ orgId: input.orgId, personId: input.ownerPersonId }));
        yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at) VALUES (${input.agentId}, ${input.orgId}, ${input.displayName}, ${input.role}, ${input.ownerPersonId}, ${input.createdAt})`;
      },
      (effect) => sql.withTransaction(effect),
      Effect.mapError(toRepositoryError("KinChatRepository.insertAgent")),
    ),
    addMember: Effect.fn("KinChatRepository.addMember")(
      function* (input) {
        if (input.leftAt !== null)
          return yield* new KinChatError({
            reason: "invalid_state",
            message: "New Kin members must be active.",
          });
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* requireRecord(chatOne(input));
            if (input.principal._tag === "person") {
              yield* requireRecord(
                personOne({ orgId: input.orgId, personId: input.principal.personId }),
              );
            } else {
              yield* requireRecord(
                agentOne({ orgId: input.orgId, agentId: input.principal.agentId }),
              );
            }
            if (input.principal._tag === "agent" && input.role !== "member")
              return yield* new KinChatError({
                reason: "not_allowed",
                message: "Chat operation not allowed.",
              });
            // Global ids must detect hidden cross-org collisions without exposing their rows.
            const existing = yield* SqlSchema.findAll({
              Request: Schema.Unknown,
              Result: MemberRow,
              execute: () => sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members
 WHERE member_id = ${input.memberId} OR (chat_id = ${input.chatId} AND (person_id = ${input.principal._tag === "person" ? input.principal.personId : null} OR agent_id = ${input.principal._tag === "agent" ? input.principal.agentId : null}))`,
            })(input);
            if (existing.some((member) => member.orgId !== input.orgId))
              return yield* new KinChatError({
                reason: "not_found",
                message: "Kin record not found.",
              });
            if (input.role === "owner") {
              if (input.principal._tag !== "person")
                return yield* new KinChatError({
                  reason: "not_allowed",
                  message: "Chat operation not allowed.",
                });
              const owners =
                yield* sql`SELECT member_id FROM kin_chat_members WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND role = 'owner' AND member_id <> ${input.memberId} ORDER BY member_id LIMIT 1`;
              if (owners.length > 0)
                return yield* new KinChatError({
                  reason: "not_allowed",
                  message: "Chat operation not allowed.",
                });
            }
            for (const member of existing) {
              if (
                member.chatId !== input.chatId ||
                member.memberId !== input.memberId ||
                member.principal._tag !== input.principal._tag ||
                (member.principal._tag === "person" &&
                  input.principal._tag === "person" &&
                  member.principal.personId !== input.principal.personId) ||
                (member.principal._tag === "agent" &&
                  input.principal._tag === "agent" &&
                  member.principal.agentId !== input.principal.agentId)
              )
                return yield* new KinChatError({
                  reason: "not_allowed",
                  message: "Kin member identity conflict.",
                });
              if (member.leftAt === null) {
                if (
                  member.role !== input.role ||
                  member.joinedAt !== input.joinedAt ||
                  member.mutedUntil !== input.mutedUntil
                )
                  return yield* new KinChatError({
                    reason: "not_allowed",
                    message: "Kin member identity conflict.",
                  });
                return member;
              }
              yield* sql`UPDATE kin_chat_members SET left_at = NULL, joined_at = ${input.joinedAt}, role = ${input.role}
 WHERE org_id = ${input.orgId} AND member_id = ${input.memberId}`;
              yield* recordJoin(sql, input);
              return yield* requireRecord(memberOne(input));
            }
            yield* sql`INSERT INTO kin_chat_members (org_id, chat_id, member_id, role, joined_at, left_at, muted_until, principal_kind, person_id, agent_id) VALUES (${input.orgId}, ${input.chatId}, ${input.memberId}, ${input.role}, ${input.joinedAt}, ${input.leftAt}, ${input.mutedUntil}, ${input.principal._tag}, ${input.principal._tag === "person" ? input.principal.personId : null}, ${input.principal._tag === "agent" ? input.principal.agentId : null}) ON CONFLICT DO NOTHING RETURNING member_id`;
            yield* recordJoin(sql, input);
            return yield* requireRecord(memberOne(input));
          }),
        );
      },
      Effect.mapError(toRepositoryError("KinChatRepository.addMember")),
    ),
    setMute: Effect.fn("KinChatRepository.setMute")(
      function* (input) {
        const changed = yield* sql`UPDATE kin_chat_members SET muted_until = ${input.mutedUntil}
 WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND member_id = ${input.memberId} AND left_at IS NULL RETURNING member_id`;
        return changed.length === 0 ? Option.none() : yield* memberOne(input);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.setMute")),
    ),
    setPin: Effect.fn("KinChatRepository.setPin")(
      function* (input) {
        const changed = yield* sql`UPDATE kin_chat_members SET pinned_at = ${input.pinnedAt}
 WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND member_id = ${input.memberId} AND left_at IS NULL RETURNING member_id`;
        return changed.length === 0 ? Option.none() : yield* memberOne(input);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.setPin")),
    ),
    setRole: Effect.fn("KinChatRepository.setRole")(
      function* (input) {
        const changed = yield* sql`UPDATE kin_chat_members SET role = ${input.role}
 WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND member_id = ${input.memberId}
 AND principal_kind = 'person' AND role <> 'owner' AND left_at IS NULL RETURNING member_id`;
        return changed.length === 0 ? Option.none() : yield* memberOne(input);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.setRole")),
    ),
    leaveChat: Effect.fn("KinChatRepository.leaveChat")(
      function* (input) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const changed = yield* sql`UPDATE kin_chat_members SET left_at = ${input.leftAt}
 WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND member_id = ${input.memberId} AND left_at IS NULL RETURNING member_id`;
            if (changed.length === 0) return [];
            const member = yield* requireRecord(memberOne(input));
            if (member.principal._tag !== "person") return [];
            const personId = member.principal.personId;
            return yield* SqlSchema.findAll({
              Request: Schema.Unknown,
              Result: WaitingRow,
              execute:
                () => sql`UPDATE kin_waiting SET resolved_at = ${input.leftAt}, resolution = 'cancelled'
 WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND person_id = ${personId} AND resolved_at IS NULL RETURNING ${sql.literal(waitingBaseColumns)}`,
            })(input).pipe(
              Effect.map((rows) => rows.toSorted((a, b) => a.waitingId.localeCompare(b.waitingId))),
            );
          }),
        );
      },
      Effect.mapError(toRepositoryError("KinChatRepository.leaveChat")),
    ),
    addWaiting: Effect.fn("KinChatRepository.addWaiting")((input) => addWaiting(input, false)),
    addApprovalWaiting: Effect.fn("KinChatRepository.addApprovalWaiting")((input) =>
      addWaiting(input, true),
    ),
    registerAgentThread: Effect.fn("KinChatRepository.registerAgentThread")(
      function* (input) {
        if (input.endedAt !== null)
          return yield* new KinChatError({
            reason: "invalid_state",
            message: "New Kin agent threads must be active.",
          });
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const agent = yield* requireRecord(
              agentOne({ orgId: input.orgId, agentId: input.agentId }),
            );
            if (agent.retiredAt !== null)
              return yield* new KinChatError({
                reason: "not_allowed",
                message: "Retired Kin agents cannot register threads.",
              });
            const existing = yield* SqlSchema.findOneOption({
              Request: Schema.Unknown,
              Result: AgentThreadRow,
              execute: () =>
                sql`SELECT ${sql.literal(agentThreadColumns)} FROM kin_agent_threads WHERE thread_id = ${input.threadId}`,
            })(input);
            if (Option.isSome(existing)) {
              if (existing.value.orgId !== input.orgId)
                return yield* new KinChatError({
                  reason: "not_found",
                  message: "Kin record not found.",
                });
              if (
                existing.value.agentId !== input.agentId ||
                existing.value.endedAt !== null ||
                input.endedAt !== existing.value.endedAt
              )
                return yield* new KinChatError({
                  reason: "not_allowed",
                  message: "Kin agent thread identity conflict.",
                });
              return existing.value;
            }
            yield* sql`INSERT INTO kin_agent_threads (org_id, thread_id, agent_id, started_at, ended_at, chat_id) VALUES (${input.orgId}, ${input.threadId}, ${input.agentId}, ${input.startedAt}, ${input.endedAt}, ${input.chatId ?? null})
 ON CONFLICT (thread_id) DO NOTHING RETURNING thread_id`;
            return yield* requireRecord(agentThreadOne(input));
          }),
        );
      },
      Effect.mapError(toRepositoryError("KinChatRepository.registerAgentThread")),
    ),
    createChat: Effect.fn("KinChatRepository.createChat")(
      function* (input) {
        yield* decodeChatTitle(input.title);
        if ((input.kind === "direct") !== (input.directKey !== null))
          return yield* new KinChatError({
            reason: "invalid_state",
            message: "Kin chat kind and direct key must agree.",
          });
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* requireRecord(orgOne(input));
            yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, title, team_id, direct_key, last_seq, last_message_at, created_at, archived_at, lead_agent_id)
 VALUES (${input.chatId}, ${input.orgId}, ${input.kind}, ${input.title}, ${input.teamId}, ${input.directKey}, 0, ${input.lastMessageAt}, ${input.createdAt}, ${input.archivedAt}, ${input.leadAgentId ?? null})
 ON CONFLICT DO NOTHING`;
            return yield* requireRecord(
              SqlSchema.findOneOption({
                Request: Schema.Unknown,
                Result: ChatRow,
                execute:
                  () => sql`SELECT ${sql.literal(chatColumns)} FROM kin_chats WHERE org_id = ${input.orgId}
 AND ${input.kind === "direct" ? sql`kind = 'direct' AND direct_key = ${input.directKey}` : sql`chat_id = ${input.chatId} AND kind = ${input.kind}`}`,
              })(input),
            );
          }),
        );
      },
      Effect.mapError(toRepositoryError("KinChatRepository.createChat")),
    ),
    updateChat: Effect.fn("KinChatRepository.updateChat")(
      function* (input) {
        if (input.title !== undefined) yield* decodeChatTitle(input.title);
        yield* sql`UPDATE kin_chats SET
            title = ${input.title === undefined ? sql`title` : input.title},
            lead_agent_id = ${input.leadAgentId === undefined ? sql`lead_agent_id` : input.leadAgentId},
            archived_at = ${input.archivedAt === undefined ? sql`archived_at` : input.archivedAt}
          WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}`;
        return yield* requireRecord(chatOne(input));
      },
      Effect.mapError(toRepositoryError("KinChatRepository.updateChat")),
    ),
    findClientMessage: Effect.fn("KinChatRepository.findClientMessage")(
      function (input) {
        return SqlSchema.findOneOption({
          Request: Schema.Unknown,
          Result: MessageRow,
          execute: () => sql`SELECT ${sql.literal(messageColumns)} FROM kin_messages
 WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND author_member_id = ${input.memberId}
 AND client_message_id = ${`${input.kind}:${input.clientId}`}`,
        })(input).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.findClientMessage")),
    ),
    replyCard,
    extendAgentReply: Effect.fn("KinChatRepository.extendAgentReply")(
      function* (input) {
        yield* decodeBody(input.body);
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const message = yield* requireRecord(messageOne(input));
            if (
              message.chatId !== input.chatId ||
              message.author._tag !== "agent" ||
              message.author.agentId !== input.agentId ||
              message.author.threadId !== input.threadId ||
              message.status !== "posted" ||
              message.kind !== "text" ||
              (input.money !== undefined
                ? message.form !== "brief" ||
                  input.body !== kinPageWithLines(message.body, KIN_MONEY_SECTION, input.money)
                : input.lead === true
                  ? message.form !== "brief" || !input.body.endsWith(message.body)
                  : !input.body.startsWith(message.body)) ||
              (message.widgetId !== null &&
                message.body === "" &&
                (yield* replyCard(input)) !== input.messageId) ||
              (message.widgetId !== null &&
                message.body !== "" &&
                (yield* sql`SELECT 1 FROM kin_messages
                WHERE org_id = ${input.orgId} AND message_id = ${input.messageId} AND source_wakeup_id = ${input.wakeupId}`)
                  .length === 0)
            )
              return yield* new KinChatError({
                reason: "not_found",
                message: "Kin record not found.",
              });
            if (!(yield* wakeupRunning(input)))
              return yield* new KinChatError({
                reason: "not_allowed",
                message: "Kin wake-up is not running.",
              });
            yield* ownerOnly(input.audience, input);
            if (input.lead === true || input.money !== undefined) {
              yield* sql`UPDATE kin_messages SET body = ${input.body}
                WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND message_id = ${input.messageId}`;
              return yield* requireRecord(messageOne(input));
            }
            const kept =
              message.form === "brief" && message.body !== ""
                ? message.form
                : yield* briefForm({ ...input, kind: message.kind, author: message.author });
            const shaped = briefed(kept, input.body, message.body);
            const placed = yield* placeFigures({ ...input, body: shaped.body, previous: message });
            const named = yield* named_(input.orgId, input.chatId, placed.body);
            yield* sql`UPDATE kin_messages SET body = ${named.body}, form = ${shaped.form},
              embeds_json = ${placed.embeds.length === 0 ? null : yield* encodeEmbeds(placed.embeds)}
              WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND message_id = ${input.messageId}`;
            if (placed.pictures.length > 0) {
              const attachments = [
                ...(message.attachments ?? []),
                ...placed.pictures.map((picture) => picture.attachment),
              ];
              const refs = withRefs(
                message.refs ?? [],
                yield* pictureRefsOf(
                  input.orgId,
                  placed.pictures.map((picture) => picture.doc),
                ),
              );
              yield* sql`UPDATE kin_messages SET attachments_json = ${yield* encodeAttachments(attachments)},
                refs_json = ${refs.length === 0 ? null : yield* encodeRefs(refs)}
                WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND message_id = ${input.messageId}`;
            }
            yield* keepFigures(input, placed.figures);
            yield* keepNames(input.orgId, input.messageId, named.json);
            return yield* requireRecord(messageOne(input));
          }),
        );
      },
      Effect.mapError(toRepositoryError("KinChatRepository.extendAgentReply")),
    ),
    insertMessage: Effect.fn("KinChatRepository.insertMessage")(
      function* (input) {
        yield* decodeBody(input.body);
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const author = input.author;
            const attachments = input.attachments ?? [];
            const memberId = author._tag === "system" ? null : author.memberId;
            const clientId =
              input.clientMessageId === null
                ? null
                : storedClientId(input.clientMessageId.kind, input.clientMessageId.id);
            const member =
              author._tag === "system"
                ? null
                : yield* requireRecord(
                    memberOne({ orgId: input.orgId, memberId: author.memberId }),
                  );
            if (member !== null) {
              if (
                member.chatId !== input.chatId ||
                (author._tag === "human" &&
                  (member.principal._tag !== "person" ||
                    member.principal.personId !== author.personId)) ||
                (author._tag === "agent" &&
                  (member.principal._tag !== "agent" ||
                    member.principal.agentId !== author.agentId))
              )
                return yield* new KinChatError({
                  reason: "not_found",
                  message: "Kin record not found.",
                });
            }
            if (memberId !== null && clientId !== null) {
              const existing = yield* SqlSchema.findOneOption({
                Request: Schema.Unknown,
                Result: MessageRow,
                execute:
                  () => sql`SELECT ${sql.literal(messageColumns)} FROM kin_messages WHERE org_id = ${input.orgId}
 AND chat_id = ${input.chatId} AND author_member_id = ${memberId} AND client_message_id = ${clientId}`,
              })(input);
              if (Option.isSome(existing)) {
                // Pictures placed on a reply since are Kin's, not the retry's to repeat.
                const drawn = yield* drawnOn(input.orgId, existing.value.messageId);
                const sent = (existing.value.attachments ?? []).filter(
                  (attachment) => !drawn.attachments.has(attachment.id),
                );
                const pointed = (existing.value.refs ?? []).filter(
                  (ref) => !drawn.refs.has(`${ref.key}@${ref.version}`),
                );
                if (
                  author._tag === "agent" &&
                  (existing.value.author._tag !== "agent" ||
                    existing.value.author.threadId !== author.threadId ||
                    existing.value.author.ownerPersonId !== author.ownerPersonId)
                )
                  return yield* new KinChatError({
                    reason: "not_allowed",
                    message: "Kin message author identity conflict.",
                  });
                if (
                  // The brief's page is stored under the heading Kin gave it (`briefed`).
                  (existing.value.body !== input.body &&
                    existing.value.body !== `## Today\n\n${input.body}`) ||
                  existing.value.intent !== input.intent ||
                  existing.value.replyTo !== input.replyTo ||
                  existing.value.widgetId !== input.widgetId ||
                  existing.value.kind !== input.kind ||
                  sent.length !== attachments.length ||
                  !attachments.every((attachment, index) => attachment.id === sent[index]?.id) ||
                  existing.value.mentions.length !== input.mentions.length ||
                  !existing.value.mentions.every((id, index) => id === input.mentions[index]) ||
                  !sameRefs(pointed, input.refs ?? [])
                )
                  return yield* new KinChatError({
                    reason: "not_allowed",
                    message: "Kin message retry conflict.",
                  });
                return existing.value;
              }
            }
            if (member !== null && member.leftAt !== null)
              return yield* new KinChatError({
                reason: "not_found",
                message: "Kin record not found.",
              });
            const agent =
              author._tag === "agent"
                ? yield* requireRecord(agentOne({ orgId: input.orgId, agentId: author.agentId }))
                : null;
            if (author._tag === "agent" && agent !== null) {
              const thread = yield* requireRecord(
                agentThreadOne({ orgId: input.orgId, threadId: author.threadId }),
              );
              if (
                agent.ownerPersonId !== author.ownerPersonId ||
                thread.agentId !== agent.agentId ||
                thread.endedAt !== null ||
                agent.retiredAt !== null
              )
                return yield* new KinChatError({
                  reason: "not_found",
                  message: "Kin record not found.",
                });
            }
            if (
              author._tag === "agent" &&
              input.serverPosted !== true &&
              !(input.wakeupId !== undefined
                ? yield* wakeupRunning({
                    orgId: input.orgId,
                    agentId: author.agentId,
                    threadId: author.threadId,
                    wakeupId: input.wakeupId,
                  })
                : input.caller !== undefined &&
                  (yield* hasRunningWakeup({
                    ...input,
                    agentId: author.agentId,
                    threadId: author.threadId,
                    caller: input.caller,
                  })))
            )
              return yield* new KinChatError({
                reason: "not_allowed",
                message: "Kin wake-up is not running.",
              });
            if (input.replyTo !== null) {
              const reply = yield* requireRecord(
                messageOne({ orgId: input.orgId, messageId: input.replyTo }),
              );
              if (reply.chatId !== input.chatId)
                return yield* new KinChatError({
                  reason: "not_found",
                  message: "Kin record not found.",
                });
            }
            if (input.widgetId !== null) {
              const widget = yield* requireRecord(
                widgetOne({ orgId: input.orgId, widgetId: input.widgetId }),
              );
              if (widget.chatId !== input.chatId)
                return yield* new KinChatError({
                  reason: "not_found",
                  message: "Kin record not found.",
                });
            }
            if (input.sentBy !== null) {
              yield* requireRecord(personOne({ orgId: input.orgId, personId: input.sentBy }));
              yield* requireRecord(
                SqlSchema.findOneOption({
                  Request: Schema.Unknown,
                  Result: MemberRow,
                  execute: () => sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members
 WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND person_id = ${input.sentBy}
 AND principal_kind = 'person' AND role = 'owner' AND left_at IS NULL`,
                })(input),
              );
            }
            for (const mention of input.mentions) {
              const mentioned = yield* requireRecord(
                memberOne({ orgId: input.orgId, memberId: mention }),
              );
              if (mentioned.chatId !== input.chatId || mentioned.leftAt !== null)
                return yield* new KinChatError({
                  reason: "not_found",
                  message: "Kin record not found.",
                });
            }
            yield* ownerOnly(input.audience, input);
            const asked = yield* resolveRefs(input, author, input.refs ?? []);
            const mentions = yield* encodeMentions(input.mentions);
            const allocated = yield* SqlSchema.findOneOption({
              Request: Schema.Unknown,
              Result: Schema.Struct({ last_seq: NonNegativeInt }),
              execute:
                () => sql`UPDATE kin_chats SET last_seq = last_seq + 1, last_message_at = ${input.createdAt}
 WHERE chat_id = ${input.chatId} AND org_id = ${input.orgId} RETURNING last_seq`,
            })(input);
            const seq = (yield* requireRecord(Effect.succeed(allocated))).last_seq;
            const { form, body } =
              author._tag === "system" && input.form === "brief"
                ? { form: "brief" as const, body: input.body }
                : briefed(yield* briefForm(input), input.body);
            const placed =
              author._tag === "agent" &&
              input.kind === "text" &&
              input.wakeupId !== undefined &&
              input.placeReplyFigures === true &&
              body !== "" &&
              input.widgetId === null
                ? yield* placeFigures({
                    ...input,
                    body,
                    agentId: author.agentId,
                    threadId: author.threadId,
                    wakeupId: input.wakeupId,
                  })
                : { body, embeds: input.embeds ?? [], figures: [], pictures: [] };
            // A picture rides on the reply as an image of its own, with its doc's chip.
            const drawn = author._tag === "agent" ? (input.pictureRefs ?? []) : [];
            const stored = [
              ...attachments,
              ...placed.pictures.map((picture) => picture.attachment),
            ];
            const attachmentsJson = stored.length === 0 ? null : yield* encodeAttachments(stored);
            const refs = withRefs(
              asked,
              yield* pictureRefsOf(input.orgId, [
                ...drawn,
                ...placed.pictures.map((picture) => picture.doc),
              ]),
            );
            // People read an entry by its name, not Kin's key for it.
            const named =
              author._tag === "agent" && input.kind === "text"
                ? yield* named_(input.orgId, input.chatId, placed.body)
                : { body: placed.body, json: null };
            const inserted =
              yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id, author_agent_id,
 author_owner_person_id, author_thread_id, author_member_id, author_role, kind, body, attachments_json, refs_json, intent, mentions_json, reply_to,
 widget_id, floor_run_id, status, sent_by, client_message_id, created_at, edited_at, silent, form, discussion_id, relay_json, origin_json, when_json, embeds_json, source_wakeup_id)
 VALUES (${input.messageId}, ${input.orgId}, ${input.chatId}, ${seq}, ${author._tag},
 ${member?.principal._tag === "person" ? member.principal.personId : null}, ${member?.principal._tag === "agent" ? member.principal.agentId : null},
 ${agent?.ownerPersonId ?? null}, ${author._tag === "agent" ? author.threadId : null},
 ${memberId}, ${member?.role ?? "member"}, ${input.kind}, ${named.body}, ${attachmentsJson}, ${refs.length === 0 ? null : yield* encodeRefs(refs)}, ${input.intent}, ${mentions}, ${input.replyTo},
 ${input.widgetId}, ${input.floorRunId}, ${input.status}, ${input.sentBy}, ${clientId}, ${input.createdAt}, ${input.editedAt},
 ${input.silent === true ? 1 : 0}, ${form}, ${input.discussionId ?? null},
 ${input.relay === undefined ? null : yield* encodeRelay(input.relay)},
 ${input.origin === undefined ? null : yield* encodeOrigin(input.origin)},
 ${input.when === undefined ? null : yield* encodeWhen(input.when)},
 ${placed.embeds.length === 0 ? null : yield* encodeEmbeds(placed.embeds)}, ${(input.body === "" || input.placeReplyFigures === true) && author._tag === "agent" ? (input.wakeupId ?? null) : null})
 ON CONFLICT DO NOTHING RETURNING message_id`;
            if (inserted.length === 0)
              return yield* new KinChatError({
                reason: "not_found",
                message: "Kin record not found.",
              });
            yield* keepNames(input.orgId, input.messageId, named.json);
            yield* keepFigures(input, placed.figures);
            // Which chat owns each file: what reading one by id is checked against.
            for (const attachment of attachments)
              yield* sql`INSERT INTO kin_message_attachments (attachment_id, org_id, chat_id, message_id)
 VALUES (${attachment.id}, ${input.orgId}, ${input.chatId}, ${input.messageId})`;
            return yield* requireRecord(messageOne(input));
          }),
        );
      },
      Effect.mapError(toRepositoryError("KinChatRepository.insertMessage")),
    ),
    history: Effect.fn("KinChatRepository.history")(
      function* (input) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const request = yield* decodeHistory(input);
              const viewer =
                input.viewerMemberId === undefined
                  ? null
                  : yield* requireRecord(
                      memberOne({ orgId: input.orgId, memberId: input.viewerMemberId }),
                    );
              if (viewer !== null && (viewer.chatId !== input.chatId || viewer.leftAt !== null))
                return yield* new KinChatError({
                  reason: "not_found",
                  message: "Kin record not found.",
                });
              const rows = yield* SqlSchema.findAll({
                Request: Schema.Unknown,
                Result: MessageRow,
                execute:
                  () => sql`SELECT ${sql.literal(messageColumns)} FROM kin_messages WHERE org_id = ${input.orgId}
 AND chat_id = ${input.chatId} AND seq < ${request.beforeSeq}
 AND (${viewer === null || viewer.role === "owner" ? 1 : 0} = 1 OR status NOT IN ('suggested', 'dismissed') OR author_member_id = ${viewer?.memberId ?? null})
 AND ${readableBy(sql, input.orgId, viewer?.memberId)}
 ORDER BY seq DESC LIMIT ${request.limit + 1}`,
              })(input);
              const shaped = rows
                .slice(0, request.limit)
                .reverse()
                .map((m) => messageForViewer(m, viewer?.principal));
              const messages =
                input.links === false
                  ? shaped
                  : yield* linked(input.orgId, viewer?.principal, shaped, {
                      receipts: input.receipts !== false,
                    });
              const widgets =
                messages.length === 0
                  ? []
                  : yield* SqlSchema.findAll({
                      Request: Schema.Unknown,
                      Result: WidgetRow,
                      execute:
                        () => sql`SELECT ${sql.literal(widgetColumns)} FROM kin_widgets WHERE org_id = ${input.orgId}
 AND chat_id = ${input.chatId} AND (message_id IN ${sql.in(messages.map((message) => message.messageId))} OR widget_id IN ${sql.in(messages.flatMap((message) => (message.widgetId === null ? [] : [message.widgetId])))}) ORDER BY message_id, widget_id`,
                    })(input);
              return { messages, widgets, hasMore: rows.length > request.limit };
            }),
          )
          .pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.history")),
    ),
    messagesAfter: Effect.fn("KinChatRepository.messagesAfter")(
      function* (input) {
        const request = yield* decodeResume(input);
        const viewer =
          input.viewerMemberId === undefined
            ? undefined
            : yield* requireRecord(
                memberOne({ orgId: input.orgId, memberId: input.viewerMemberId }),
              );
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: MessageRow,
          execute:
            () => sql`SELECT ${sql.literal(messageColumns)} FROM kin_messages WHERE org_id = ${input.orgId}
 AND chat_id = ${input.chatId} AND seq > ${request.afterSeq}${input.beforeSeq === undefined ? sql`` : sql` AND seq < ${input.beforeSeq}`}
 AND (${input.viewerMemberId ?? null} IS NULL OR status NOT IN ('suggested', 'dismissed') OR author_member_id = ${input.viewerMemberId ?? null} OR EXISTS (SELECT 1 FROM kin_chat_members WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND member_id = ${input.viewerMemberId ?? null} AND role = 'owner'))
 AND ${readableBy(sql, input.orgId, input.viewerMemberId, input.fromHistoryFloor === true ? input.chatId : undefined)} ORDER BY seq ${input.latest === true ? sql`DESC` : sql`ASC`} LIMIT ${request.limit}`,
        })(input).pipe(
          NodeSqliteClient.readOnly,
          Effect.flatMap((messages) =>
            linked(
              input.orgId,
              viewer?.principal,
              (input.latest === true ? messages.toReversed() : messages).map((m) =>
                messageForViewer(m, viewer?.principal),
              ),
            ),
          ),
        );
      },
      Effect.mapError(toRepositoryError("KinChatRepository.messagesAfter")),
    ),
    insertWidget: Effect.fn("KinChatRepository.insertWidget")(
      function* (input) {
        yield* decodeWidgetText(input);
        yield* requireRecord(chatOne(input));
        yield* ownerOnly(input.audience, input);
        const message = yield* requireRecord(messageOne(input));
        if (message.chatId !== input.chatId)
          return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
        yield* validateWidgetReferences(input);
        const state = yield* encodeWidgetState(input.state);
        const awaiting = yield* encodeAwaiting(input.awaiting);
        const inserted =
          yield* sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class, type, revision, state_json,
 source_thread_id, source_item_id, feed_kind, feed_key, awaiting_json, pinned_at, closed_at, updated_at)
 VALUES (${input.widgetId}, ${input.orgId}, ${input.chatId}, ${input.messageId}, ${input.widgetClass}, ${input.type},
 1, ${state}, ${input.source?.threadId ?? null}, ${input.source?.itemId ?? null},
 ${input.feed?.kind ?? null}, ${input.feed?.key ?? null}, ${awaiting}, ${input.pinnedAt}, ${input.closedAt}, ${input.updatedAt})
 ON CONFLICT DO NOTHING RETURNING widget_id`;
        if (inserted.length === 0)
          return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
        yield* sql`UPDATE kin_messages SET widget_id = ${input.widgetId}
 WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND message_id = ${input.messageId} AND widget_id IS NULL`;
      },
      (effect) => sql.withTransaction(effect),
      Effect.mapError(toRepositoryError("KinChatRepository.insertWidget")),
    ),
    updateWidget: Effect.fn("KinChatRepository.updateWidget")(
      function* (input) {
        yield* decodeWidgetFeed(input.feed);
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const widget = yield* requireRecord(widgetOne(input));
            yield* ownerOnly(input.audience, widget);
            yield* validateWidgetReferences({ ...input, chatId: widget.chatId });
            const state = yield* encodeWidgetState(input.state);
            const awaiting = yield* encodeAwaiting(input.awaiting);
            const updated = yield* SqlSchema.findOneOption({
              Request: Schema.Unknown,
              Result: WidgetRow,
              execute:
                () => sql`UPDATE kin_widgets SET revision = revision + 1, state_json = ${state}, awaiting_json = ${awaiting},
 source_thread_id = ${input.source?.threadId ?? null},
 source_item_id = ${input.source?.itemId ?? null}, feed_kind = ${input.feed?.kind ?? null}, feed_key = ${input.feed?.key ?? null},
 pinned_at = ${input.pinnedAt}, closed_at = ${input.closedAt}, updated_at = ${input.updatedAt}
 WHERE org_id = ${input.orgId} AND widget_id = ${input.widgetId} AND revision = ${input.expectedRevision}
 RETURNING ${sql.literal(widgetColumns)}`,
            })(input);
            if (Option.isNone(updated))
              return yield* new KinChatError({
                reason: "widget_changed",
                message: "This card changed or was answered. Look at it again.",
              });
            return updated.value;
          }),
        );
      },
      Effect.mapError(toRepositoryError("KinChatRepository.updateWidget")),
    ),
    getReadState: Effect.fn("KinChatRepository.getReadState")(
      function* (input) {
        return yield* SqlSchema.findOneOption({
          Request: Schema.Unknown,
          Result: ReadStateRow,
          execute:
            () => sql`SELECT ${sql.literal(readStateColumns)} FROM kin_read_state WHERE org_id = ${input.orgId}
 AND chat_id = ${input.chatId} AND member_id = ${input.memberId}`,
        })(input).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.getReadState")),
    ),
    markRead: Effect.fn("KinChatRepository.markRead")(
      function* (input) {
        const seq = yield* decodeSeq(input.seq);
        const member = yield* requireRecord(memberOne(input));
        if (member.chatId !== input.chatId)
          return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
        yield* sql`INSERT INTO kin_read_state (org_id, chat_id, member_id, last_read_seq, updated_at)
 VALUES (${input.orgId}, ${input.chatId}, ${input.memberId}, MIN(${seq}, (SELECT last_seq FROM kin_chats WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId})), ${input.updatedAt})
 ON CONFLICT (chat_id, member_id) DO UPDATE SET last_read_seq = excluded.last_read_seq, updated_at = excluded.updated_at
 WHERE kin_read_state.org_id = excluded.org_id AND excluded.last_read_seq > kin_read_state.last_read_seq`;
      },
      (effect) => sql.withTransaction(effect),
      Effect.mapError(toRepositoryError("KinChatRepository.markRead")),
    ),
    unreadCount,
    unreadCounts: Effect.fn("KinChatRepository.unreadCounts")(
      function* (input) {
        const rows = yield* unreadByChat(input, sql`1 = 1`);
        return new Map(rows.map((row) => [row.chatId, row.count]));
      },
      Effect.mapError(toRepositoryError("KinChatRepository.unreadCounts")),
    ),
    unreadTotal: Effect.fn("KinChatRepository.unreadTotal")(
      function* (input) {
        const rows = yield* unreadByChat(
          input,
          sql`c.archived_at IS NULL AND (c.team_id IS NULL OR c.team_id <> ${KIN_TEAM_ROOM_TEAM_ID})`,
        );
        return rows.reduce((total, row) => total + row.count, 0);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.unreadTotal")),
    ),
    resolveWaiting: Effect.fn("KinChatRepository.resolveWaiting")(
      function* (input) {
        const changed =
          yield* sql`UPDATE kin_waiting SET resolved_at = ${input.resolvedAt}, resolution = ${input.resolution}
 WHERE org_id = ${input.orgId} AND waiting_id = ${input.waitingId} AND resolved_at IS NULL RETURNING waiting_id`;
        return changed.length > 0;
      },
      Effect.mapError(toRepositoryError("KinChatRepository.resolveWaiting")),
    ),
    endAgentThread: Effect.fn("KinChatRepository.endAgentThread")(
      function* (input) {
        const changed = yield* sql`UPDATE kin_agent_threads SET ended_at = ${input.endedAt}
 WHERE org_id = ${input.orgId} AND thread_id = ${input.threadId} AND ended_at IS NULL RETURNING thread_id`;
        return changed.length > 0;
      },
      Effect.mapError(toRepositoryError("KinChatRepository.endAgentThread")),
    ),
    docKeptFiles: Effect.fn("KinChatRepository.docKeptFiles")(
      function* (input) {
        const [row] = yield* sql<{ count: number }>`SELECT COUNT(DISTINCT attachment_id) AS count
          FROM kin_message_attachments
          WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}
            AND ${docUses(input.orgId)}`;
        return row?.count ?? 0;
      },
      Effect.mapError(toRepositoryError("KinChatRepository.docKeptFiles")),
    ),
    clearChat: Effect.fn("KinChatRepository.clearChat")(
      function* (input) {
        yield* requireRecord(chatOne(input));
        const said = sql`SELECT message_id FROM kin_messages
          WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}`;
        const about = sql`tag IN ('chat.message', 'widget.action', 'chat.reaction')
          AND json_extract(json, '$.messageId') IN (${said})`;
        const attachments = yield* sql<{ id: string; kept: number }>`
          SELECT DISTINCT attachment_id AS id, ${docUses(input.orgId)} AS kept
          FROM kin_message_attachments
          WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}
          ORDER BY attachment_id`;
        const unplaced = yield* sql<{ id: string }>`SELECT attachment_id AS id FROM kin_turn_figures
          WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}
            AND message_id IS NULL AND attachment_id IS NOT NULL`;
        const taskCards = yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: WidgetRow,
          execute: () => sql`SELECT ${sql.literal(widgetColumns)} FROM kin_widgets
            WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND type = 'task'
            ORDER BY widget_id`,
        })(input);
        // A turn answering a deleted message has nothing left to answer: it stops like one
        // aborted for its audience, and no later wake-up is given the message again.
        const aborted = yield* sql<{ wakeupId: string }>`
          UPDATE kin_wakeups SET aborted_at = ${input.clearedAtMs}
          WHERE org_id = ${input.orgId} AND status = 'running' AND aborted_at IS NULL
            AND settled_at IS NULL
            AND wakeup_id IN (SELECT wakeup_id FROM kin_events
              WHERE org_id = ${input.orgId} AND state = 'claimed' AND ${about})
          RETURNING wakeup_id AS "wakeupId"`;
        const dropped = yield* sql<{ agentId: string }>`
          UPDATE kin_events SET state = 'expired'
          WHERE org_id = ${input.orgId} AND state IN ('queued', 'claimed') AND ${about}
          RETURNING agent_id AS "agentId"`;
        const open = yield* sql<{ id: string }>`SELECT waiting_id AS id FROM kin_waiting
          WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND resolved_at IS NULL
          ORDER BY waiting_id`;
        // Waiting rows stay as history of what was asked, without the message or card they named.
        yield* sql`UPDATE kin_waiting SET message_id = NULL, widget_id = NULL,
            resolved_at = COALESCE(resolved_at, ${input.clearedAt}),
            resolution = COALESCE(resolution, 'cancelled')
          WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}`;
        const waiting =
          open.length === 0
            ? []
            : yield* SqlSchema.findAll({
                Request: Schema.Unknown,
                Result: WaitingRow,
                execute: () => sql`SELECT ${sql.literal(waitingBaseColumns)} FROM kin_waiting
                  WHERE org_id = ${input.orgId} AND waiting_id IN ${sql.in(open.map((row) => row.id))}
                  ORDER BY waiting_id`,
              })(input);
        yield* sql`DELETE FROM kin_floor_grants WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}`;
        yield* sql`DELETE FROM kin_floor_notices WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}`;
        yield* sql`DELETE FROM kin_floor_runs WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}`;
        yield* sql`DELETE FROM kin_ping_deliveries WHERE org_id = ${input.orgId} AND message_id IN (${said})`;
        yield* sql`DELETE FROM kin_handoffs WHERE org_id = ${input.orgId} AND message_id IN (${said})`;
        yield* sql`DELETE FROM kin_reaction_wakes WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}`;
        yield* sql`DELETE FROM kin_reactions WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}`;
        yield* sql`DELETE FROM kin_message_attachments WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}`;
        // A removed card runs nothing: its sealed plans go, and the questions it asks close.
        const cards = sql`SELECT widget_id FROM kin_widgets
          WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}`;
        yield* sql`UPDATE kin_questions SET state = 'withdrawn', closed_at = ${input.clearedAtMs}
          WHERE org_id = ${input.orgId} AND state = 'open'
            AND (widget_id IN (${cards}) OR raise_widget_id IN (${cards}))`;
        // A suggestion whose card goes now ended unanswered here: Settings reads its own row.
        const ended = yield* sql`UPDATE kin_recommendations SET ended_at = ${input.clearedAtMs}
          WHERE org_id = ${input.orgId} AND state = 'open' AND ended_at IS NULL
            AND widget_id IN (${cards})
          RETURNING rec_id`;
        yield* sql`DELETE FROM kin_card_plans WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}`;
        yield* sql`DELETE FROM kin_widgets WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}`;
        yield* sql`DELETE FROM kin_turn_figures WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}`;
        yield* sql`DELETE FROM kin_messages WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}`;
        // `last_seq` keeps counting: members' read and join positions are seqs of this chat.
        const [counters] = yield* sql<{ lastSeq: number; lastChangeSeq: number }>`
          UPDATE kin_chats SET last_message_at = NULL, change_seq = change_seq + 1,
            cleared_change_seq = change_seq + 1, cleared_seq = last_seq
          WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}
          RETURNING last_seq AS "lastSeq", change_seq AS "lastChangeSeq"`;
        return {
          lastSeq: counters!.lastSeq,
          lastChangeSeq: counters!.lastChangeSeq,
          attachmentIds: [
            ...attachments.flatMap((row) => (row.kept === 1 ? [] : [row.id])),
            ...unplaced.map((row) => row.id),
          ],
          keptFiles: attachments.filter((row) => row.kept === 1).length,
          waiting,
          taskCards,
          abortedWakeupIds: aborted.map((row) => KinWakeupId.make(row.wakeupId)),
          agentIds: [...new Set(dropped.map((row) => KinAgentId.make(row.agentId)))],
          endedSuggestion: ended.length > 0,
        };
      },
      (effect) => sql.withTransaction(effect),
      Effect.mapError(toRepositoryError("KinChatRepository.clearChat")),
    ),
  });
});
export const layer = Layer.effect(KinChatRepository, make);
