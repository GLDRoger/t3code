import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

it("defaults session carry and upkeep off and accepts bounded compaction patches", () => {
  expect(decodeServerSettings({})).toMatchObject({
    kinSessionCarry: false,
    kinSessionUpkeep: false,
    kinSessionCompactAtTokens: 500_000,
  });
  expect(
    decodeServerSettingsPatch({
      kinSessionCarry: true,
      kinSessionUpkeep: true,
      kinSessionCompactAtTokens: 1,
    }),
  ).toEqual({
    kinSessionCarry: true,
    kinSessionUpkeep: true,
    kinSessionCompactAtTokens: 100_000,
  });
  expect(
    decodeServerSettings({ kinSessionCompactAtTokens: 900_000 }).kinSessionCompactAtTokens,
  ).toBe(800_000);
});
