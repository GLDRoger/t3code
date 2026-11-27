// @effect-diagnostics nodeBuiltinImport:off -- reads Kin's own sources for the boundary check.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";

it("keeps the looks store out of tools, agent turns and scheduled work", () => {
  const root = NodePath.resolve(import.meta.dirname, "..");
  const sources = NodeFS.readdirSync(root, { recursive: true, encoding: "utf8" });
  const agentSources = sources.filter(
    (file) =>
      /^(?:mcp|lead|pulse|tasksKey|work\/mcp|triggers)\//.test(file) &&
      file.endsWith(".ts") &&
      !/\.test(?:kit)?\.ts$/.test(file),
  );
  assert.deepStrictEqual(
    agentSources.filter((file) =>
      /\bkin_looks\b|from\s+["'][^"']*\/looks\.ts["']/.test(
        NodeFS.readFileSync(NodePath.join(root, file), "utf8"),
      ),
    ),
    [],
  );
});
