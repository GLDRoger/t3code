import {
  chaosActive,
  injectText,
  liveChaosArmed,
  readProviderChunk,
  readToolJson,
} from "@t3tools/kin-reliability";

/**
 * Chaos injection seams, compiled into the server and inert unless
 * `KIN_CHAOS=1` and the process is not production. Call these at the
 * provider-stream and tool-JSON boundaries; do not sprinkle faults
 * through the orchestrator.
 */
export const chaosSeams = {
  chaosActive,
  injectText,
  liveChaosArmed,
  readProviderChunk,
  readToolJson,
};
