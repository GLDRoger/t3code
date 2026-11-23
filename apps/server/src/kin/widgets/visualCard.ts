import { KinChatError } from "@t3tools/contracts";
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
 * refusal can say how to fix the call. The frame, not the lookalike check, keeps it sealed.
 */
export const VisualInput = Schema.Struct({
  title: Schema.String,
  html: Schema.String,
  height: Schema.optional(Schema.Finite),
});
export type VisualInput = typeof VisualInput.Type;
export { ChartResult as VisualResult } from "./chartCard.ts";

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const MIB = 1024 * 1024;

const actionLabel = /^\s*(confirm|approve|send|pay)\b/i;
const attr = (attrs: string, name: string) => {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(
    attrs,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
};
function hasLookalike(html: string) {
  const tags = /<([a-z][a-z0-9:-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
  for (const match of html.matchAll(tags)) {
    const tag = match[1]!.toLowerCase();
    const attrs = match[2]!;
    if (
      tag !== "button" &&
      tag !== "a" &&
      attr(attrs, "role").toLowerCase() !== "button" &&
      !(tag === "input" && /^(submit|button)$/i.test(attr(attrs, "type")))
    )
      continue;
    if (actionLabel.test(attr(attrs, "value")) || actionLabel.test(attr(attrs, "aria-label")))
      return true;
    if (tag === "input") continue;
    const start = match.index + match[0].length;
    const rest = html.slice(start, start + 1024);
    const end = new RegExp(`</${tag}\\s*>`, "i").exec(rest);
    if (
      end !== null &&
      actionLabel.test(
        rest
          .slice(0, end.index)
          .replace(/<[^>]*>/g, "")
          .replace(/&nbsp;/gi, " "),
      )
    )
      return true;
  }
  return false;
}

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
  if (hasLookalike(input.html))
    return yield* invalid(
      "A page can't draw Confirm, Approve, Send or Pay: Kin shows those itself under your reply. Take the button out.",
    );
  return {
    title,
    html: input.html,
    height: clampHtmlRenderHeight(input.height ?? KIN_VISUAL_DEFAULT_HEIGHT),
  };
});
