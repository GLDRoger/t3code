import * as Context from "effect/Context";
import { Tool, Toolkit } from "effect/ai";

import { KIN_SEARCH_HINTS } from "./searchHints.ts";

/** Codex's up-front partition. */
export const KIN_ALWAYS_LOADED: ReadonlySet<string> = new Set([
  "record_update",
  "record_assign",
  "kin_ask_person",
  "kin_relay",
  "kin_defer",
  "records_query",
]);

/** Claude adds schemas for everyday reads and writes without moving Codex's partition. */
export const KIN_CLAUDE_ALWAYS_LOADED: ReadonlySet<string> = new Set([
  ...KIN_ALWAYS_LOADED,
  "record_get",
  "docs_search",
  "client_read",
  "doc_create",
  "record_create",
]);

const SEARCH_HINT = "anthropic/searchHint";

/** Claude Code reads these MCP annotations when it builds the tool search inventory. */
export const withAlwaysLoaded = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  hints = KIN_SEARCH_HINTS,
): Toolkit.Toolkit<Tools> =>
  Toolkit.make(
    ...Object.values(toolkit.tools).map((tool) => {
      const meta = Context.getOrUndefined(tool.annotations, Tool.Meta);
      if (KIN_CLAUDE_ALWAYS_LOADED.has(tool.name)) {
        const { [SEARCH_HINT]: _hint, ...rest } = meta ?? {};
        return tool.annotate(Tool.Meta, { ...rest, "anthropic/alwaysLoad": true });
      }
      const hint = Object.hasOwn(hints, tool.name) ? hints[tool.name] : undefined;
      return hint === undefined ? tool : tool.annotate(Tool.Meta, { ...meta, [SEARCH_HINT]: hint });
    }),
  ) as unknown as Toolkit.Toolkit<Tools>;
