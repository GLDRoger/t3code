import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { assembleHouseLineBrief } from "./brief.ts";
import {
  KIN_PROMPT_STABLE_PREFIX,
  KinPromptBriefProvider,
  KinPromptComposer,
  layer,
} from "../prompt/KinPromptBrief.ts";

const source = {
  houseName: "web-ui",
  agentMapPath: ".kin/web.md",
  family: [
    {
      willId: "will-1",
      crowningId: "crown-1",
      houseName: "web-ui",
      regnalNumber: 1,
      body: "first reign",
    },
    {
      willId: "will-2",
      crowningId: "crown-2",
      houseName: "web-ui",
      regnalNumber: 2,
      body: "second reign",
    },
  ],
  court: [
    {
      willId: "will-server",
      crowningId: "crown-server",
      houseName: "server",
      regnalNumber: 1,
      body: "server will",
    },
  ],
  houseWills: [
    {
      willId: "will-other-line",
      crowningId: "crown-other",
      houseName: "web-ui",
      regnalNumber: 3,
      body: "other line",
    },
  ],
  notes: [
    { id: "note-b", body: "later", at: "2026-02-01T00:00:00.000Z" },
    { id: "note-a", body: "earlier", at: "2026-01-01T00:00:00.000Z" },
  ],
};

it("orders Start here, Your family, The court, then house wills", () => {
  const brief = assembleHouseLineBrief(source);
  const family = brief.indexOf("Your family");
  const court = brief.indexOf("The court");
  const house = brief.indexOf("House wills and notes");
  assert.ok(brief.startsWith("Start here\n"));
  assert.ok(family < court && court < house);
  assert.ok(brief.indexOf("second reign") < brief.indexOf("first reign"));
  assert.equal(brief, assembleHouseLineBrief(source));
  assert.equal(brief.endsWith("\n"), true);
});

it.effect("keeps the composer prefix byte-stable and puts the task last", () =>
  Effect.gen(function* () {
    const composer = yield* KinPromptComposer;
    const one = yield* composer.compose({ laneId: "lane", task: "task-one" });
    const two = yield* composer.compose({ laneId: "lane", task: "task-two" });
    assert.equal(one.prefix, KIN_PROMPT_STABLE_PREFIX);
    assert.equal(one.prefix, two.prefix);
    assert.equal(one.brief, two.brief);
    assert.ok(one.prompt.endsWith("\n\ntask-one"));
    assert.ok(two.prompt.endsWith("\n\ntask-two"));
    assert.equal(one.prompt.includes("task-two"), false);
  }).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide(
          Layer.succeed(KinPromptBriefProvider, {
            briefFor: () => Effect.succeed(assembleHouseLineBrief(source)),
          }),
        ),
      ),
    ),
  ),
);
