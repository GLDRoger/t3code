import * as Context from "effect/Context";
import { Tool, Toolkit } from "effect/ai";

/**
 * The Kin tools a lead session loads up front, the same in every seat so that every agent's
 * request starts with the same cached bytes. Every other tool, Kin's or T3's, waits for the
 * provider's tool search, so a tool added later is deferred until it is named here.
 */
export const KIN_ALWAYS_LOADED: ReadonlySet<string> = new Set([
  "kin_ask",
  "kin_defer",
  "kin_cancel",
  "kin_react",
  "kin_hand_off",
  "kin_relay",
  "kin_ask_person",
  "memory_search",
  "memory_read",
  "memory_write",
  "records_query",
  "record_get",
  "record_create",
  "record_update",
  "client_read",
  "pulse_handle",
  "docs_search",
  "doc_read",
  "doc_edit",
  "doc_create",
  "pulse_read",
  "people_read",
  "kin_leads",
  "dates_query",
  "touch_log",
  "kin_recipes",
  "kin_connection_tools",
  "kin_connection_call",
]);

/** `Tool.Meta` that has Claude Code load a tool up front while ToolSearch holds the rest back. */
const alwaysLoadedMeta = { "anthropic/alwaysLoad": true } as const;

/** `toolkit` with its `KIN_ALWAYS_LOADED` tools marked to load up front; handlers match by name. */
export const withAlwaysLoaded = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
): Toolkit.Toolkit<Tools> =>
  Toolkit.make(
    ...Object.values(toolkit.tools).map((tool) =>
      KIN_ALWAYS_LOADED.has(tool.name)
        ? tool.annotate(Tool.Meta, {
            ...Context.getOrUndefined(tool.annotations, Tool.Meta),
            ...alwaysLoadedMeta,
          })
        : tool,
    ),
  ) as unknown as Toolkit.Toolkit<Tools>;
