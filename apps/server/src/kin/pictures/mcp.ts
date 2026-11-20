import { KinChatError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { KIN_VISUAL_PAGE_GUIDE } from "@t3tools/shared/kinVisual";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import { ServerConfig } from "../../config.ts";
import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinDocRenderer } from "../gendocs/render.ts";
import { KinToolchain } from "../gendocs/toolchain.ts";
import { deferredMeta } from "../lead/deferredTools.ts";
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
    description: `Make a picture file the person can keep, download, share, attach to a mail or use in a social post. It shows under your reply as a picture and is kept in Docs. Give html or prompt, never both. With html you design it: one page of HTML, CSS and JavaScript, the same as a kin_visual page, which Kin draws at the size you name and saves as a PNG. Draw anything made of words, numbers or layout: infographics, posters, quote cards, one-pagers, social images in the brand, and charts or diagrams meant to leave the chat; its text comes out exactly as written. With prompt an image model paints it, for a photo-like or illustrated scene: describe the subject, setting, style and light in plain words. Never use prompt for words that must read exactly, a real person's likeness or a logo: draw those with html, which can show a painted picture by its file id. Each generated picture costs the company and counts toward its monthly limit, so make only what was asked; count, with prompt only, is 1 to 4. size is square, portrait, story, landscape, link or page: square or portrait for a feed post, story for a story, link for a link or LinkedIn card, page for a printable one-pager. title names it. To change a picture, call again with doc, the key of the earlier one: it becomes that doc's next version and the old one stays; asked for in another chat, it starts a new doc there. A chart or figure that answers a question in chat is kin_chart or kin_visual, not this. Only data you have read or been given, never estimates. When a drawing is refused, the refusal says what to change: fix that and call again. When the picture service turns a prompt down, nothing was made: tell the person plainly, and don't send it again reworded. When no picture service is connected or this month's generated pictures are used, say so in one line and offer to design the picture with html instead. When Kin says it can't draw pictures on this server, nothing was made: say so in one line and offer it as a kin_visual in the chat.\n${KIN_VISUAL_PAGE_GUIDE}\n${KIN_PICTURE_PAGE_GUIDE}`,
    parameters: PictureInput,
    success: PictureResult,
  })
    .annotate(McpSchema.EnabledWhen, enabled)
    .annotate(Tool.Meta, deferredMeta),
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
