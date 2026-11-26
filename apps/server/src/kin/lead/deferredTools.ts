import * as Context from "effect/Context";
import { Tool, Toolkit } from "effect/ai";

/**
 * Claude lead sessions wait for ToolSearch before loading any Kin schema, including both
 * look-alike pairs: `web_page` and `WebFetch`, `record_assign` and `record_update`.
 */
export const KIN_ALWAYS_LOADED: ReadonlySet<string> = new Set<string>();

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
