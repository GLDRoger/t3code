import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * The coding agent key a call came through, set only by the key's own endpoint around each call
 * (`tasksKey/mcp.ts`): every entry change and comment the call writes names the key.
 */
export const CodingAgentCall = Context.Reference<string | undefined>(
  "t3/kin/work/keyCall/CodingAgentCall",
  { defaultValue: () => undefined },
);

/** The key a write is marked with: the writer's own, else the call's. */
export const markedKey = Effect.fnUntraced(function* (writer: {
  readonly codingAgentKey?: string | undefined;
}) {
  return writer.codingAgentKey ?? (yield* CodingAgentCall);
});
