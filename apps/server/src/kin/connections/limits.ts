import * as Duration from "effect/Duration";

/**
 * Every bound on the gateway, in one place. They keep a host responsive against a server that
 * floods; none counts or stops a turn's calls.
 */
export const CONNECTION_LIMITS = {
  /** One MCP message, read or written. */
  maxMessageBytes: 8 * 1024 * 1024,
  /** Initialization, one complete tool listing, and one tool call. */
  timeout: Duration.seconds(30),
  maxTools: 500,
  maxPages: 20,
  /** What one call returns to the agent; past it the result is cut with a marker. */
  resultChars: 80_000,
  /** Arguments kept in the call log, in UTF-8 bytes. */
  argsBytes: 8 * 1024,
  /** How long the call log keeps a call, and how much one prune pass deletes. */
  keepCalls: Duration.days(90),
  pruneBatch: 5_000,
  pruneBatches: 20,
  /** A listing older than this is refreshed when an agent asks for the tools. */
  relistAfter: Duration.minutes(10),
} as const;
