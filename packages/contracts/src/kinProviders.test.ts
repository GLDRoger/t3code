import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { kinAgentDriverAllowed } from "./kinProviders.ts";

it.effect.each([
  ["antigravity", true, true, true],
  ["antigravity", false, true, false],
  ["antigravity", true, false, false],
  ["antigravity", false, false, false],
  ["acpRegistry", false, true, true],
  ["acpRegistry", true, false, false],
  ["codex", true, false, true],
  ["codex", false, true, false],
] as const)("admission for %s (switch %s, dev %s)", ([driver, enabled, devServer, allowed]) =>
  Effect.sync(() => assert.strictEqual(kinAgentDriverAllowed(driver, enabled, devServer), allowed)),
);
