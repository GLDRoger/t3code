// A model writing long arguments often sends them as JSON text, at times swallowing the sibling
// `reason` too: `{…},"reason":"…"}` or without the last brace, neither valid JSON as a whole.
const SWALLOWED_REASON = /^(\{[\s\S]*\})\s*,\s*"reason"\s*:\s*("(?:[^"\\]|\\.)*")\s*\}?$/;
const REASON_CHARS = 500;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const withReason = (args: Record<string, unknown> | undefined, reason: string | undefined) => ({
  ...(args === undefined ? {} : { arguments: args }),
  ...(reason === undefined ? {} : { reason }),
});

/** What a connection call's `arguments` and `reason` are once text forms are read; undefined when the text holds no object. */
export const readCallArguments = (
  given: unknown,
  reason: string | undefined,
): { readonly arguments?: Record<string, unknown>; readonly reason?: string } | undefined => {
  if (given === undefined || given === null) return withReason(undefined, reason);
  if (isPlainObject(given)) return withReason(given, reason);
  if (typeof given !== "string") return undefined;
  const text = given.trim();
  const whole = parsed(text);
  if (isPlainObject(whole)) return withReason(whole, reason);
  const match = SWALLOWED_REASON.exec(text);
  if (match === null) return undefined;
  const args = parsed(match[1]!);
  const swallowed = parsed(match[2]!);
  if (!isPlainObject(args) || typeof swallowed !== "string") return undefined;
  return withReason(args, reason ?? swallowed.slice(0, REASON_CHARS));
};
