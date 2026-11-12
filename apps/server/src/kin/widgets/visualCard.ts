import { KinChatError, KinTrimmedText } from "@t3tools/contracts";
import { clampHtmlRenderHeight } from "@t3tools/shared/htmlRender";
import {
  KIN_VISUAL_DEFAULT_HEIGHT,
  KIN_VISUAL_MAX_BYTES,
  KIN_VISUAL_MAX_TITLE_LENGTH,
} from "@t3tools/shared/kinVisual";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * What `kin_visual` takes. Only shapes are checked here: `visualPage` applies the limits, so a
 * refusal can say how to fix the call. What the page contains is never judged: the frame it is
 * served in is what keeps it sealed.
 */
export const VisualInput = Schema.Struct({
  title: Schema.String,
  html: Schema.String,
  height: Schema.optional(Schema.Finite),
});
export type VisualInput = typeof VisualInput.Type;
export const VisualResult = Schema.Struct({
  widgetId: KinTrimmedText,
  messageId: KinTrimmedText,
});

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const MIB = 1024 * 1024;

/** The page as it will be stored, or a refusal that tells the agent what to change. */
export const visualPage = Effect.fn("KinVisualCard.page")(function* (input: VisualInput) {
  const title = input.title.replace(/\s+/g, " ").trim();
  if (title === "") return yield* invalid("A visual needs a title that says what it shows.");
  if (title.length > KIN_VISUAL_MAX_TITLE_LENGTH)
    return yield* invalid(
      `The title is ${title.length} characters; keep it to ${KIN_VISUAL_MAX_TITLE_LENGTH} or fewer.`,
    );
  if (input.html.trim() === "") return yield* invalid("The page is empty: send its HTML in html.");
  if (input.html.includes("\0")) return yield* invalid("The page holds a NUL character.");
  const bytes = Buffer.byteLength(input.html);
  if (bytes > KIN_VISUAL_MAX_BYTES)
    return yield* invalid(
      `The page is ${(bytes / MIB).toFixed(1)} MiB; the limit is ${KIN_VISUAL_MAX_BYTES / MIB} MiB. Send fewer rows, summarise the data, or use smaller images.`,
    );
  return {
    title,
    html: input.html,
    height: clampHtmlRenderHeight(input.height ?? KIN_VISUAL_DEFAULT_HEIGHT),
  };
});
