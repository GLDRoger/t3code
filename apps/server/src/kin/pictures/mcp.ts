import { KinChatError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { KIN_VISUAL_PAGE_BASE } from "@t3tools/shared/kinVisual";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import { ServerConfig } from "../../config.ts";
import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinDocRenderer } from "../gendocs/render.ts";
import { KinToolchain } from "../gendocs/toolchain.ts";
import * as Lead from "../lead/LeadMemory.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import { KinRecords } from "../work/KinRecords.ts";
import { makePicture, PictureInput, PictureResult } from "./picture.ts";
import { KinPictures } from "./KinPictures.ts";
import { KinPictureRenderer } from "./renderer.ts";
import { KIN_PICTURE_PAGE_GUIDE } from "./sizes.ts";

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

export const KinPictureToolkit = Toolkit.make(
  Tool.make("kin_picture", {
    failure: Schema.Union([KinChatError, OrchestratorMcpFailure]),
    failureMode: "return",
    dependencies: [
      Lead.LeadMemory,
      McpInvocationContext,
      ThreadManagementService,
      KinIdentity,
      KinRecords,
      KinDocRenderer,
      KinToolchain,
      KinLevelGate,
      KinPictureRenderer,
      KinPictures,
      SqlClient.SqlClient,
      FileSystem.FileSystem,
      ServerConfig,
    ],
    description: `Make a picture file to keep, download, share, attach to a mail or post: it shows under your reply and is kept in Docs. Give html or prompt, never both. html: you design a page, which Kin draws at the size you name and saves as a PNG; for anything made of words, numbers or layout (infographics, posters, quote cards, one-pagers, social images in the brand, charts or diagrams meant to leave the chat), its text exactly as written. prompt: an image model paints a photo-like or illustrated scene from plain words on subject, setting, style and light; never for words that must read exactly, a real person's likeness or a logo (draw those with html, which can show a painted picture by its file id). Each painted picture costs the company and counts toward its monthly limit: make only what was asked (count 1-4, prompt only). size: square or portrait for a feed post, story for a story, landscape, link for a link card, page for a printable one-pager. To change one, call again with doc, the earlier one's key: its next version. A figure that answers in chat is kin_chart or kin_visual. Only data you read or were given. A refused drawing says what to change. A prompt the picture service turns down made nothing: say so plainly, and don't send it again reworded. With no picture service, or this month's pictures used, say so in one line and offer to design it with html; when Kin can't draw pictures on this server, offer a kin_visual in the chat.\n${KIN_VISUAL_PAGE_BASE}\n${KIN_PICTURE_PAGE_GUIDE}`,
    parameters: PictureInput,
    success: PictureResult,
  }).annotate(McpSchema.EnabledWhen, enabled),
);

const isKinChatError = Schema.is(KinChatError);
const failure = (error: unknown) =>
  isKinChatError(error)
    ? error
    : new KinChatError({
        reason: "unavailable",
        message: "Kin can't make pictures right now, so nothing was made.",
      });

// Kin's service checks the persisted lead and wake-up, rather than T3 thread-control grants.
export const handlers = McpToolAccess.toLayer(KinPictureToolkit, {
  kin_picture: McpToolAccess.actsAsCaller(
    Effect.fn("KinPictureToolkit.picture")(function* (input) {
      return yield* makePicture(yield* McpInvocationContext, input);
    }, Effect.mapError(failure)),
  ),
});
