import * as Duration from "effect/Duration";

/**
 * Every bound on the gateway, in one place. They keep a host and a turn responsive, not a model
 * in check: a looping agent or a server that floods are what they stop.
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
  /** What one turn may read from connections, counted from its call rows. */
  turnChars: 400_000,
  turnCalls: 200,
  /** Arguments kept in the call log. */
  argsBytes: 8 * 1024,
  /** A listing older than this is refreshed when an agent asks for the tools. */
  relistAfter: Duration.minutes(10),
} as const;
