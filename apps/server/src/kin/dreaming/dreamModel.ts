import type { ModelSelection, ServerSettings } from "@t3tools/contracts";

import { driverOf } from "../lead/leadModels.ts";

export const isDreamDriver = (driver: string | undefined) => driver === "claudeAgent";

export const modelChangeNotice = (
  settings: ServerSettings,
  previous: ModelSelection,
  current: ModelSelection,
  name: string,
  model: string,
) => {
  if (previous.model === current.model) return undefined;
  const ran = isDreamDriver(driverOf(settings, previous));
  const runs = isDreamDriver(driverOf(settings, current));
  if (!runs)
    return ran
      ? `Kin's nightly memory update stops while ${name} runs on ${model}: it needs a Claude model. Switch ${name} back to a Claude model and it starts again that night.`
      : undefined;
  return ran
    ? `Kin's nightly memory update now runs on ${model}, the model ${name} uses.`
    : `Kin's nightly memory update starts again tonight on ${model}, the model ${name} uses.`;
};
