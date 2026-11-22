// @effect-diagnostics nodeBuiltinImport:off
/**
 * Kin's part of the MCP tool-use runner: its toolkits, which of them a lead's seat lists, the rule
 * lines its cases write as placeholders, and what Kin's bridge shows or asks after a turn. run.ts
 * reaches each through one call. Runs no `./run.ts` code, only its types, so either loads first.
 */
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as Contracts from "@t3tools/contracts";
import {
  isProviderNativeImageAttachment,
  providerMessageTextWithAttachmentPaths,
} from "@t3tools/provider-core/server/attachmentPrompt";
import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import {
  createDeterministicAttachmentId,
  resolveAttachmentPath,
} from "../../apps/server/src/attachmentStore.ts";
import * as ServerConfig from "../../apps/server/src/config.ts";
import * as DocumentText from "../../apps/server/src/provider/DocumentText.ts";
import { KinTurnContent } from "../../apps/server/src/kin/lead/turn/content.ts";

import {
  groupRules as kinGroupRules,
  instructions as kinLeadInstructions,
  teamRules as kinTeamRules,
} from "../../apps/server/src/kin/lead/instructions.ts";
import { kinInstructions } from "../../apps/server/src/kin/lead/turn/session.ts";
import { LEAD_T3_TOOLS } from "../../apps/server/src/kin/lead/t3Tools.ts";
import { KinLeadToolkit } from "../../apps/server/src/kin/lead/mcp/tools.ts";
import { KIN_ALWAYS_LOADED } from "../../apps/server/src/kin/lead/deferredTools.ts";
import { listedOnSharedThread } from "../../apps/server/src/kin/lead/SharedTools.ts";
import { KinChatToolkit } from "../../apps/server/src/kin/mcp/KinChatToolkit.ts";
import { KinStatementToolkit } from "../../apps/server/src/kin/work/mcp/statementTools.ts";
import { KinWorkToolkit } from "../../apps/server/src/kin/work/mcp/tools.ts";
import { KinDocsToolkit } from "../../apps/server/src/kin/work/mcp/docTools.ts";
import { KinDocumentToolkit } from "../../apps/server/src/kin/gendocs/mcp.ts";
import { KinConnectionsToolkit } from "../../apps/server/src/kin/connections/mcp.ts";
import { socialRules as kinSocialRules } from "../../apps/server/src/kin/social/instructions.ts";
import { KinSocialToolkit } from "../../apps/server/src/kin/social/mcp.ts";
import { KinSalesToolkit } from "../../apps/server/src/kin/sales/mcp.ts";
import { salesRulesFor } from "../../apps/server/src/kin/sales/seat.ts";
import { KinPulseToolkit } from "../../apps/server/src/kin/pulse/mcp.ts";
import {
  MONEY_RULE,
  WITHDRAWN_WORK,
  WORK_RULE,
} from "../../apps/server/src/kin/work/workPrompt.ts";
import {
  githubTriggerEvent,
  HANDED_BACK_WORK,
  REPLY_SHAPE,
  SHARED_TURN_LINE,
  workForText,
} from "../../apps/server/src/kin/lead/LeadPrompt.ts";
import { CHECK_IN_PULSE_RULE, PULSE_RULE } from "../../apps/server/src/kin/pulse/prompt.ts";
import { WEEKLY_RULE } from "../../apps/server/src/kin/pulse/weekly.ts";
import { STARTED_RULE } from "../../apps/server/src/kin/lead/startedSection.ts";
import { DECLINED_RULE } from "../../apps/server/src/kin/lead/declinedSection.ts";
import { UNDO_RULE } from "../../apps/server/src/kin/lead/undoSection.ts";
import { defaultCharacterFor } from "../../apps/server/src/kin/lead/characterDefaults.ts";
import { characterForTurn, colleagueLine } from "../../apps/server/src/kin/lead/characters.ts";
import {
  CAPTION_PROMPT,
  classifySegment,
  repeats,
  RESCUE_PROMPT,
} from "../../apps/server/src/kin/reply/classify.ts";
import { TURN_EVENT_TOOLS } from "../../apps/server/src/kin/lead/eventIds.ts";
import type { McpToolUseCase } from "./run.ts";

export { kinInstructions, kinLeadInstructions };

const T3_PREFIX = "mcp__t3-code__";
type Block = { readonly type: string; readonly [key: string]: unknown };
type ApiTool = { readonly name: string; readonly [key: string]: unknown };
export const isText = Schema.is(
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
);
const isToolUse = Schema.is(
  Schema.Struct({
    type: Schema.Literal("tool_use"),
    id: Schema.String,
    name: Schema.String,
    input: Schema.Unknown,
  }),
);
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: string): Block => ({ type: "text", text: value });

/** Kin's toolkits, in the order T3's tool list carries them. */
export const KIN_TOOLKITS = [
  KinChatToolkit,
  KinLeadToolkit,
  KinWorkToolkit,
  KinStatementToolkit,
  KinDocsToolkit,
  KinDocumentToolkit,
  KinConnectionsToolkit,
  KinPulseToolkit,
  KinSocialToolkit,
  KinSalesToolkit,
] as const;

/** The world flags that shape a Kin turn's tool list and system text. */
export type KinSeatOptions = {
  readonly kinAgent?: boolean;
  readonly kinLead?: boolean;
  readonly kinSession?: boolean;
  readonly kinShared?: boolean;
  /** The lead's remit is social media, so Social's tools join (AgentSession). */
  readonly kinSocial?: boolean;
};

const names = (...toolkits: ReadonlyArray<{ readonly tools: object }>) =>
  new Set(toolkits.flatMap((toolkit) => Object.keys(toolkit.tools)));
const LEAD_T3: ReadonlySet<string> = new Set(LEAD_T3_TOOLS);
const CHAT = names(KinChatToolkit);
const LEAD = names(
  KinLeadToolkit,
  KinWorkToolkit,
  KinStatementToolkit,
  KinDocsToolkit,
  KinDocumentToolkit,
  KinPulseToolkit,
  KinConnectionsToolkit,
  KinSalesToolkit,
);
const SOCIAL = names(KinSocialToolkit);
const ANY_KIN = names(
  KinChatToolkit,
  KinLeadToolkit,
  KinWorkToolkit,
  KinDocsToolkit,
  KinDocumentToolkit,
  KinPulseToolkit,
  KinConnectionsToolkit,
  KinSocialToolkit,
  KinSalesToolkit,
);

/** Whether a T3 tool, by bare name, is listed to this turn as far as Kin decides (AgentSession). */
export const kinToolVisible = (name: string, options: KinSeatOptions) => {
  // A turn others read runs on a shared thread, which lists only what it may run.
  if (options.kinShared === true && !listedOnSharedThread(name)) return false;
  if (options.kinAgent !== true && options.kinLead !== true) return !ANY_KIN.has(name);
  // An owner-only turn's session: T3's lead tools join.
  return (
    (options.kinSession === true && LEAD_T3.has(name)) ||
    CHAT.has(name) ||
    (options.kinLead === true &&
      (LEAD.has(name) || (options.kinSocial === true && SOCIAL.has(name))))
  );
};

export const KIN_SHARED_PROMPT = /\{\{(SHARED_TURN|GROUP_RULES)\}\}/;
/**
 * A Kin lead's turn on a thread nobody else reads has the owner's seat, as `lead/turn/session.ts`
 * plans it; a case says `kinSession: false` only to model a turn without it on purpose.
 */
export const kinSessionOf = ({ setup, prompt }: McpToolUseCase) => {
  const stated = setup.world?.kinSession;
  return typeof stated === "boolean"
    ? stated
    : setup.world?.kinLead === true && !KIN_SHARED_PROMPT.test(prompt);
};

/**
 * A lead's request as Kin plans its session (`lead/turn/session.ts`): its instructions are the
 * whole system prompt and only Kin's core loads up front; every other tool waits behind ToolSearch. A turn
 * with the owner's seat (kinSession, not shared) has Claude Code's own tools too; a confined one,
 * only its web search.
 */
export const kinLeadBase = <M, E>(input: {
  readonly model: M;
  readonly options: KinSeatOptions;
  readonly environment: E;
  readonly templateTools: ReadonlyArray<ApiTool>;
  readonly t3: ReadonlyArray<ApiTool>;
  /** The captured harness's ToolSearch list header, when it has one. */
  readonly deferredHeader: string | undefined;
  readonly nativeDeferred: ReadonlyArray<string>;
  readonly nativeSchema: (name: string) => object;
  readonly isT3Name: (name: string) => boolean;
}) => {
  const { options, t3 } = input;
  const ownerSeat = options.kinSession === true && options.kinShared !== true;
  const deferredKin = t3.filter(
    (tool) => !KIN_ALWAYS_LOADED.has(tool.name.slice(T3_PREFIX.length)),
  );
  const toolSearch = input.templateTools.filter((tool) => tool.name.endsWith("ToolSearch"));
  return {
    model: input.model,
    system: [text(kinInstructions(ownerSeat ? "owner" : "confined", "claudeAgent"))],
    reminders:
      deferredKin.length > 0 && input.deferredHeader !== undefined
        ? [text(`${input.deferredHeader}${deferredKin.map((tool) => tool.name).join("\n")}\n`)]
        : [],
    gitStatusAt: undefined,
    environment: input.environment,
    nativeTools: [
      ...(ownerSeat
        ? [
            ...input.templateTools.filter(
              (tool) => !input.isT3Name(tool.name) && !tool.name.endsWith("ToolSearch"),
            ),
            ...input.nativeDeferred.map((name): ApiTool => ({ name, ...input.nativeSchema(name) })),
          ]
        : // A confined Claude session keeps the provider's own web search (`claude.ts`).
          [{ name: "WebSearch", ...input.nativeSchema("WebSearch") }]),
      ...(deferredKin.length > 0 ? toolSearch : []),
      ...t3.filter((tool) => !deferredKin.includes(tool)),
    ],
    t3,
    deferred: deferredKin,
  };
};

/** A Kin tool an earlier turn of the thread loaded through ToolSearch is still loaded. */
export const kinLoadedBefore = <T extends ApiTool>(
  deferred: ReadonlyArray<T>,
  priorCalls: ReadonlyArray<{ readonly tool: string }>,
) =>
  deferred.filter((tool) => {
    const bare = tool.name.replace(T3_PREFIX, "");
    return !KIN_ALWAYS_LOADED.has(bare) && priorCalls.some((call) => call.tool === bare);
  });

// Decoding wraps secrets such as a statement password in Redacted; grade the value the agent sent.
export const unredact = (value: unknown): unknown =>
  Redacted.isRedacted(value)
    ? Redacted.value(value)
    : Array.isArray(value)
      ? value.map(unredact)
      : isRecord(value)
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unredact(item)]))
        : value;

/** What follows a text block, as Kin's bridge reads it (`classifySegment`). */
const nextAfter = (blocks: ReadonlyArray<unknown>, index: number) => {
  const following = blocks.slice(index + 1).find((next) => isText(next) || isToolUse(next));
  return following === undefined ? "end" : isText(following) ? "text" : "tool";
};
/**
 * The text a chat shows from a turn's responses: every text block, status lines included, less
 * one that only repeats the reply so far, which Kin's bridge drops (`repeats`).
 */
export const shownText = (responses: ReadonlyArray<ReadonlyArray<unknown>>) => {
  const blocks = responses.flat();
  const said: Array<string> = [];
  let reply = "";
  blocks.forEach((block, index) => {
    if (!isText(block) || (reply !== "" && repeats(block.text, reply))) return;
    said.push(block.text);
    if (classifySegment(block.text, nextAfter(blocks, index)) === "post")
      reply = reply === "" ? block.text : `${reply}\n\n${block.text}`;
  });
  return said.join("\n\n");
};
/** Whether any text block posts as a message: short text before a tool is a status line. */
const postsText = (responses: ReadonlyArray<ReadonlyArray<unknown>>) => {
  const blocks = responses.flat();
  return blocks.some(
    (block, index) =>
      isText(block) && classifySegment(block.text, nextAfter(blocks, index)) === "post",
  );
};

/**
 * A lead case writes `{{WORK_RULE}}`, `{{SHARED_TURN}}` and Kin's other rule lines where Kin puts
 * them, in its prompt or a prior turn, so it tests the current text.
 */
const STANDARD_SEATS = ["chief-of-staff", "finance", "engineering", "growth", "social"];
const seatCharacter = (domain: string) => {
  // The eval company keeps rupees in India, so Finance's text is the one Kin's tests know.
  const body = defaultCharacterFor(domain, { homeCurrency: "INR", country: "IN", tax: null });
  if (body === undefined) throw new Error(`No default character for ${domain}.`);
  return { body, name: /^# (.+)$/m.exec(body)?.[1] ?? domain };
};
/** A standard agent's character with Kin's part and the owner's (`own`, empty by default). */
const seatParts = (domain: string, own = "") => {
  const { body, name } = seatCharacter(domain);
  return { agentId: domain, name, key: "D-12", body: own, kin: body.trim() };
};
/**
 * `{{CHARACTER:<domain>}}` is that default character as its agent's own owner-only turn carries
 * it, and `{{CHARACTER:<domain>|<owner's part>}}` with the owner's part too;
 * `{{COLLEAGUES:<domain>}}` the other standard agents' lines, as Kin gives them.
 */
const fillCharacters = (prompt: string) =>
  prompt
    .replace(/\{\{CHARACTER:([a-z-]+)(?:\|([^}]*))?\}\}/g, (_, domain: string, own?: string) =>
      characterForTurn(seatParts(domain, own), true),
    )
    .replace(/\{\{COLLEAGUES:([a-z-]+)\}\}/g, (_, domain: string) =>
      STANDARD_SEATS.filter((seat) => seat !== domain)
        .map((seat) => colleagueLine(seatParts(seat)))
        .join("\n"),
    );

/** `{{GITHUB_TRIGGER}}` is the event Kin builds for the case's `world.githubTrigger`. */
const fillGitHubTrigger = (prompt: string, world: McpToolUseCase["setup"]["world"]) => {
  if (!prompt.includes("{{GITHUB_TRIGGER}}")) return prompt;
  const given = world?.githubTrigger as
    | {
        readonly event: string;
        readonly repo: string;
        readonly trigger: Contracts.KinGithubTrigger;
      }
    | undefined;
  if (given === undefined) throw new Error("{{GITHUB_TRIGGER}} needs setup.world.githubTrigger.");
  return prompt.replaceAll(
    "{{GITHUB_TRIGGER}}",
    githubTriggerEvent(given.event, given.repo, given.trigger),
  );
};

export const fillKinRules = (prompt: string, world?: McpToolUseCase["setup"]["world"]) =>
  fillCharacters(fillGitHubTrigger(prompt, world))
    .replaceAll("{{UNDO_RULE}}", UNDO_RULE)
    .replaceAll("{{WORK_RULE}}", WORK_RULE)
    .replaceAll("{{MONEY_RULE}}", MONEY_RULE)
    .replaceAll("{{PULSE_RULE}}", PULSE_RULE)
    .replaceAll("{{CHECK_IN_PULSE_RULE}}", CHECK_IN_PULSE_RULE)
    .replaceAll("{{WEEKLY_RULE}}", WEEKLY_RULE)
    .replaceAll("{{GROUP_RULES}}", kinGroupRules)
    .replaceAll("{{TEAM_RULES}}", kinTeamRules)
    .replaceAll("{{SOCIAL_RULES}}", kinSocialRules)
    // The seat's rules as the prompt builder picks them, by the agent's domain.
    .replace(/\{\{SALES_RULES:([a-z-]+)\}\}/g, (_, domain: string) =>
      salesRulesFor(domain).join("\n\n"),
    )
    .replaceAll("{{REPLY_SHAPE}}", REPLY_SHAPE)
    .replaceAll("{{HANDED_BACK_WORK}}", HANDED_BACK_WORK)
    .replaceAll("{{STARTED_RULE}}", STARTED_RULE)
    .replaceAll("{{DECLINED_RULE}}", DECLINED_RULE)
    .replaceAll("{{SHARED_TURN}}", SHARED_TURN_LINE)
    .replaceAll("{{WITHDRAWN_WORK}}", WITHDRAWN_WORK)
    .replace(/\{\{WORK_FOR:([^}]+)\}\}/g, (_, names: string) => workForText(names));

// Tools whose card or reaction answers the person in the chat, as Kin's own message would.
const ANSWERS_IN_CHAT = new Set([
  "kin_ask",
  "kin_chart",
  "kin_visual",
  "kin_react",
  "kin_connection_call",
  "kin_connection_offer",
  "kin_document",
  "kin_issue",
  "kin_receipt",
  "list_define",
  "company_profile",
  "statement_read",
  "doc_create",
  "doc_edit",
  "doc_rewrite",
]);
// Cards that show a chart, visual or file: Kin asks once for a line saying what it is. A doc
// tool shows its doc as a card only when asked to (`card`); otherwise it posts nothing.
const SHOWS_ONLY = new Set(["kin_chart", "kin_visual", "kin_document", "kin_issue", "kin_receipt"]);
const DOC_TOOLS = new Set(["doc_create", "doc_edit", "doc_rewrite"]);
/**
 * Every teammate message of the turn passed on by kin_hand_off (its mocked results, in call
 * order): Kin's own line in the chat answers each, so the turn owes no words (`answered`).
 */
const passedOnEach = (testCase: McpToolUseCase, used: ReadonlyArray<{ readonly tool: string }>) => {
  if (!testCase.prompt.includes("your direct chat with a teammate")) return false;
  const asked = testCase.prompt.match(/BEGIN QUOTE: member human message/g)?.length ?? 0;
  const mock = testCase.setup.mocks?.kin_hand_off;
  const results = isRecord(mock) && Array.isArray(mock.$sequence) ? mock.$sequence : [mock];
  const passed = used
    .filter((one) => one.tool === "kin_hand_off")
    .filter((_, n) => {
      const result: unknown = results[Math.min(n, results.length - 1)];
      return isRecord(result) && result.passed === true;
    });
  return asked > 0 && passed.length >= asked;
};
/**
 * What Kin asks a lead whose finished turn left a person's message without words
 * (KinReplyBridge `complete`): the rescue prompt, the caption prompt when its only answer was a
 * chart, visual or file, or undefined when the turn answered. `normalize` is the grading name.
 */
export const rescuePrompt = (
  sample: {
    readonly testCase: McpToolUseCase;
    readonly responses: ReadonlyArray<ReadonlyArray<unknown>>;
  },
  normalize: (name: string) => string,
) => {
  if (sample.testCase.setup.world?.kinLead !== true) return undefined;
  if (
    !/BEGIN QUOTE: (?:owner|co-owner|member human|guest human) message/.test(sample.testCase.prompt)
  )
    return undefined;
  if (postsText(sample.responses)) return undefined;
  const used = sample.responses
    .flat()
    .filter(isToolUse)
    .map((block) => ({
      tool: normalize(block.name),
      card: isRecord(block.input) && block.input.card === true,
    }));
  if (passedOnEach(sample.testCase, used)) return undefined;
  const shows = ({ tool, card }: (typeof used)[number]) =>
    SHOWS_ONLY.has(tool) || (DOC_TOOLS.has(tool) && card);
  if (used.some((one) => ANSWERS_IN_CHAT.has(one.tool) && !DOC_TOOLS.has(one.tool) && !shows(one)))
    return undefined;
  return used.some(shows) ? CAPTION_PROMPT : RESCUE_PROMPT;
};

/**
 * A Kin tool's event as Kin's tool gate fills it (`KinToolGate.turnEvents`): left out, the turn's
 * latest message, else its first event; a message id, that message's event.
 */
export const filledEvent = <U extends { readonly name: string; readonly input: unknown }>(
  testCase: McpToolUseCase,
  use: U,
  normalize: (name: string) => string,
): U => {
  const name = normalize(use.name);
  if (testCase.setup.world?.kinLead !== true || !TURN_EVENT_TOOLS.has(name) || !isRecord(use.input))
    return use;
  const events = [
    ...testCase.prompt.matchAll(/"event":\s*"([^"]+)"(?:,\s*"message":\s*"([^"]+)")?/g),
  ].map((match) => ({ eventId: match[1]!, messageId: match[2] }));
  const given = use.input.sourceEventId;
  if (events.some((event) => event.eventId === given)) return use;
  const chosen =
    events.find((event) => event.messageId !== undefined && event.messageId === given) ??
    (given === undefined
      ? (events.findLast((event) => event.messageId !== undefined) ?? events[0])
      : undefined);
  return chosen === undefined
    ? use
    : { ...use, input: { ...use.input, sourceEventId: chosen.eventId } };
};

/** Kin's runs have no step limit, so a sample is named in the log at each this many model calls. */
export const LONG_TURN_CALLS = 40;
export const longTurnNote = (id: string, modelCalls: number) =>
  modelCalls > 0 && modelCalls % LONG_TURN_CALLS === 0
    ? `${id}: one sample has made ${modelCalls} model calls and is still going. Nothing stops it.`
    : undefined;

/** A no-limit run's summary lines: model calls per finished sample, and the cases that took most. */
export const modelCallLines = (
  rows: ReadonlyArray<{
    readonly id: string;
    readonly modelCalls?: number | undefined;
    readonly error?: string | undefined;
  }>,
) => {
  const counted = rows.flatMap(({ id, modelCalls, error }) =>
    error === undefined && modelCalls !== undefined ? [{ id, modelCalls }] : [],
  );
  if (counted.length === 0) return ["- No step limit. No sample recorded its model calls."];
  const sorted = counted.map((row) => row.modelCalls).toSorted((a, b) => a - b);
  const mean = sorted.reduce((sum, calls) => sum + calls, 0) / sorted.length;
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(0.9 * sorted.length))]!;
  const top = [...Map.groupBy(counted, (row) => row.id)]
    .map(([id, members]) => ({
      id,
      largest: Math.max(...members.map((row) => row.modelCalls)),
      mean: members.reduce((sum, row) => sum + row.modelCalls, 0) / members.length,
    }))
    .toSorted((a, b) => b.largest - a.largest || b.mean - a.mean || a.id.localeCompare(b.id))
    .slice(0, 5);
  return [
    `- No step limit. Model calls per sample: mean ${mean.toFixed(1)}, p90 ${p90}, largest ${sorted.at(-1)}, over ${sorted.length} samples.`,
    `- Most model calls: ${top.map((one) => `\`${one.id}\` (largest ${one.largest}, mean ${one.mean.toFixed(1)})`).join(", ")}.`,
  ];
};

/** A file on the turn's message (`setup.attachments`): its name in the chat and a fixture. */
export const KinCaseAttachment = Schema.Struct({
  /** As the chat shows it and the quoted event's `attachments` name it. */
  name: Schema.String,
  /** Repository-relative path of the invented fixture whose bytes are the file. */
  file: Schema.String,
  /** Defaults from the name's extension. */
  mimeType: Schema.optional(Schema.String),
});
type KinCaseAttachment = typeof KinCaseAttachment.Type;
/** What a turn with files carries beside its prompt, as Kin and the provider adapters build it. */
export type KinTurnFiles = {
  /** Appended to the prompt: Kin's file lines and the adapter's saved-at lines. */
  readonly text: string;
  readonly images: ReadonlyArray<{ readonly mimeType: string; readonly data: string }>;
};

const REPO = new URL("../../", import.meta.url);
const MIME_TYPES: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
  csv: "text/csv",
  txt: "text/plain",
};
// The turn's text names where files are saved; a fixed place keeps every request the same.
const SHOWN_ATTACHMENTS_DIR = "/home/user/.t3/userdata/attachments";
const PROMPT_MARK = "\u0000";
// Office files get no text here: the eval starts no extraction process. No fixture is one.
const noExtraction = Layer.succeed(
  DocumentText.DocumentText,
  DocumentText.DocumentText.of({
    ensure: Effect.fn("DocumentText.ensure")(() => Effect.undefined),
  }),
);

const storedAttachment = (caseId: string, given: KinCaseAttachment, sizeBytes: number) => {
  const mimeType =
    given.mimeType ?? MIME_TYPES[given.name.split(".").at(-1)?.toLowerCase() ?? ""] ?? "";
  const id = createDeterministicAttachmentId("kin-chat", `${caseId}:${given.name}`);
  if (id === null || mimeType === "") throw new Error(`${caseId}: can't attach ${given.name}.`);
  return mimeType.startsWith("image/")
    ? ({ type: "image", id, name: given.name, mimeType, sizeBytes } as const)
    : ({ type: "file", id, name: given.name, mimeType, sizeBytes } as const);
};

/**
 * The case's files handed to its turn as a wake-up hands a message's files (`WakeupRunner`):
 * `KinTurnContent.prepare` turns each into text and pictures, then the provider adapter names
 * every file it passes and sends the pictures (`providerMessageTextWithAttachmentPaths`).
 */
export const kinTurnFiles = Effect.fn("evaluateMcpToolUse.kinTurnFiles")(function* (
  testCase: McpToolUseCase,
) {
  const given = testCase.setup.attachments ?? [];
  if (given.length === 0) return undefined;
  return yield* Effect.gen(function* () {
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const stored = yield* Effect.forEach(given, (one) =>
      Effect.gen(function* () {
        const bytes = yield* fs.readFile(NodeURL.fileURLToPath(new URL(one.file, REPO)));
        const attachment = storedAttachment(testCase.id, one, bytes.byteLength);
        const path = resolveAttachmentPath({ attachmentsDir, attachment });
        if (path === null) return yield* Effect.die(new Error(`${testCase.id}: ${one.name}`));
        yield* fs.writeFile(path, bytes);
        return attachment;
      }),
    );
    const prepared = yield* (yield* KinTurnContent).prepare({
      text: PROMPT_MARK,
      attachments: stored,
    });
    const text = yield* providerMessageTextWithAttachmentPaths({
      text: prepared.text,
      attachments: prepared.attachments,
      resolveAttachmentPath: (attachment) => resolveAttachmentPath({ attachmentsDir, attachment }),
      resolveExtractedTextPath: (path) =>
        DocumentText.resolveExtractedTextPath(path).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        ),
    });
    const images = yield* Effect.forEach(
      prepared.attachments.filter(isProviderNativeImageAttachment),
      (attachment) =>
        fs
          .readFile(resolveAttachmentPath({ attachmentsDir, attachment }) ?? "")
          .pipe(
            Effect.map((bytes) => ({ mimeType: attachment.mimeType, data: Base64.encode(bytes) })),
          ),
    );
    const files: KinTurnFiles = {
      text: text.slice(PROMPT_MARK.length).replaceAll(attachmentsDir, SHOWN_ATTACHMENTS_DIR),
      images,
    };
    return files;
  }).pipe(
    Effect.provide(
      KinTurnContent.layer.pipe(
        Layer.provideMerge(noExtraction),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-eval-files-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  );
});

/** The turn's first user message: Claude's adapter puts its pictures ahead of the text. */
export const kinTurnBlocks = (files: KinTurnFiles | undefined, prompt: string, codex: boolean) =>
  files === undefined
    ? [text(prompt)]
    : [
        ...(codex
          ? []
          : files.images.map((image): Block => ({
              type: "image",
              source: { type: "base64", media_type: image.mimeType, data: image.data },
            }))),
        text(`${prompt}${files.text}`),
      ];

/** Kin's tools, by bare name. */
const KIN_TOOLS = names(...KIN_TOOLKITS);
const unmocked = (testCase: McpToolUseCase, tool: string) => {
  const mock = testCase.setup.mocks?.[tool];
  return KIN_TOOLS.has(tool) && (mock === undefined || mock === "default");
};
/** The Kin tools a sample called that its case has no mock for, each once. */
export const kinUnmocked = (
  testCase: McpToolUseCase,
  calls: ReadonlyArray<{ readonly tool: string }>,
) => [...new Set(calls.map((call) => call.tool).filter((tool) => unmocked(testCase, tool)))];
/** The summary's list, per case, of Kin tools called with no mock and in how many samples. */
export const unmockedLines = (
  rows: ReadonlyArray<{ readonly id: string; readonly unmocked?: ReadonlyArray<string> }>,
) => {
  const byCase = [...Map.groupBy(rows, (row) => row.id)]
    .map(([id, members]) => {
      const counts = new Map<string, number>();
      for (const tool of members.flatMap((row) => row.unmocked ?? []))
        counts.set(tool, (counts.get(tool) ?? 0) + 1);
      return { id, counts: [...counts].toSorted(([left], [right]) => left.localeCompare(right)) };
    })
    .filter((one) => one.counts.length > 0)
    .toSorted((left, right) => left.id.localeCompare(right.id));
  if (byCase.length === 0) return [];
  return [
    "## Kin tools called with no mock\n",
    `Each answered {"ok":true}, which no Kin tool returns. Give the case a mock for every read its turn depends on.\n`,
    "| Case | Tool: samples |",
    "| --- | --- |",
    ...byCase.map(
      ({ id, counts }) =>
        `| ${id} | ${counts.map(([tool, samples]) => `${tool}: ${samples}`).join(", ")} |`,
    ),
    "",
  ];
};

/** How much of one call a Kin rubric's judge reads, in UTF-8 bytes. */
export const JUDGED_CALL_BYTES = 16_384;
const encoder = new TextEncoder();
/** A Kin call as the judge reads it: whole, up to the bound, and then marked cut. */
export const kinJudgedCall = (call: { readonly tool: string; readonly input: unknown }) => {
  const line = `${call.tool} ${typeof call.input === "string" ? call.input : (JSON.stringify(call.input) ?? "")}`;
  const bytes = encoder.encode(line);
  if (bytes.byteLength <= JUDGED_CALL_BYTES) return line;
  const kept = new TextDecoder()
    .decode(bytes.subarray(0, JUDGED_CALL_BYTES))
    .replace(/\uFFFD$/, "");
  return `${kept} [cut: this call is ${bytes.byteLength} bytes; only its first ${JUDGED_CALL_BYTES} are shown]`;
};
export const isKinCase = ({ setup }: McpToolUseCase) =>
  setup.world?.kinAgent === true || setup.world?.kinLead === true;
