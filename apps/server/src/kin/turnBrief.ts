import { CHRONICLE_RELATIVE_PATH, type KeeperEntry } from "@t3tools/keeper/chronicle";
import { renderBriefSlot } from "@t3tools/keeper/briefSlot";
import { loadOwnerRules, renderOwnerRules } from "@t3tools/keeper/ownerRules";
import { ThreadId, type ThreadId as ThreadIdValue } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import type { KinBriefInput } from "./brief.ts";
import * as HouseLineService from "./houseLine/HouseLineService.ts";
import { composeOrderedPrompt } from "./PromptComposer.ts";

export function renderKeeperSlot(input: {
  readonly house: string;
  readonly ownerRules: string;
  readonly houseMap: string;
  readonly chronicleText: string;
  readonly now: DateTime.DateTime;
  readonly task: string;
  readonly entries?: readonly KeeperEntry[];
}): string {
  return renderBriefSlot({
    house: input.house.length === 0 ? "this house" : input.house,
    ownerRules: input.ownerRules,
    houseMap: input.houseMap,
    chronicleText: input.chronicleText,
    now: input.now,
    entries: input.entries ?? [],
    notes: [],
    task: input.task,
  });
}

/** Drops an empty task heading so the system prompt can end before the user task. */
export function withoutEmptyTask(slot: string): string {
  return slot.replace(/\n?## Task\n*$/u, "").trimEnd();
}

export class KinTurnBrief extends Context.Service<
  KinTurnBrief,
  {
    readonly stableContext: (input: KinBriefInput) => Effect.Effect<string>;
    readonly brief: (input: KinBriefInput) => Effect.Effect<string>;
  }
>()("t3/kin/turnBrief/KinTurnBrief") {}

const make = Effect.gen(function* () {
  const houseLine = yield* HouseLineService.HouseLineService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  const readOptional = (filePath: string) =>
    fs.readFileString(filePath).pipe(Effect.catch(() => Effect.succeed("")));

  const load = Effect.fn("KinTurnBrief.load")(function* (input: KinBriefInput) {
    const described =
      input.threadId === undefined
        ? null
        : yield* houseLine
            .describeLane(ThreadId.make(input.threadId) as ThreadIdValue)
            .pipe(Effect.orElseSucceed(() => null));
    const projectRoot = input.projectRoot;
    const houseName = described?.houseName ?? input.houseId ?? "";
    const agentMapPath = described?.agentMapPath ?? null;
    let ownerRules = "";
    let houseMap = "";
    let chronicleText = "";
    if (projectRoot !== undefined) {
      const loaded = yield* loadOwnerRules({ projectRoot }).pipe(Effect.orElseSucceed(() => null));
      if (loaded !== null) ownerRules = renderOwnerRules(loaded);
      if (agentMapPath !== null && agentMapPath.length > 0) {
        const mapPath = path.isAbsolute(agentMapPath)
          ? agentMapPath
          : path.join(projectRoot, agentMapPath);
        houseMap = yield* readOptional(mapPath);
      }
      chronicleText = yield* readOptional(path.join(projectRoot, CHRONICLE_RELATIVE_PATH));
    }
    const houseLineText =
      described === null
        ? ""
        : yield* houseLine.briefFor(described.laneId).pipe(Effect.orElseSucceed(() => ""));
    const nowMillis = yield* Clock.currentTimeMillis.pipe(
      Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
    );
    const now = DateTime.makeUnsafe(nowMillis);
    return { houseName, agentMapPath, ownerRules, houseMap, chronicleText, houseLineText, now };
  });

  const stableContext = (input: KinBriefInput) =>
    Effect.gen(function* () {
      const loaded = yield* load(input);
      const lines = [
        loaded.houseName.length === 0 ? "" : `House: ${loaded.houseName}`,
        loaded.agentMapPath === null || loaded.agentMapPath.length === 0
          ? ""
          : `Agent map: ${loaded.agentMapPath}`,
      ].filter((line) => line.length > 0);
      return lines.join("\n");
    }).pipe(Effect.provideContext(services));

  const brief = (input: KinBriefInput) =>
    Effect.gen(function* () {
      const loaded = yield* load(input);
      if (
        loaded.houseLineText.trim().length === 0 &&
        loaded.ownerRules.trim().length === 0 &&
        loaded.chronicleText.trim().length === 0 &&
        loaded.houseMap.trim().length === 0
      ) {
        return "";
      }
      const keeper = withoutEmptyTask(
        renderKeeperSlot({
          house: loaded.houseName,
          ownerRules: loaded.ownerRules,
          houseMap: loaded.houseMap,
          chronicleText: loaded.chronicleText,
          now: loaded.now,
          task: "",
        }),
      );
      return composeOrderedPrompt({
        prefix: "",
        houseLine: loaded.houseLineText,
        keeper,
        task: "",
      }).brief;
    }).pipe(Effect.provideContext(services));

  return KinTurnBrief.of({ stableContext, brief });
});

export const layer = Layer.effect(KinTurnBrief, make);
