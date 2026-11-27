import { MOBILE_THEME_IDS } from "@t3tools/shared/themePalettes";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_MOBILE_THEME_ID,
  getMobileThemeVariables,
  themeColorContrastRatio,
} from "./mobileTheme";
import { readDefaultMobileThemeVariables } from "./mobileTheme.test-support";

describe("outline buttons", () => {
  // A card's Undo is an outline button: its edge must show on the card in dark; light keeps its hairline.
  it.each(MOBILE_THEME_IDS)("shows the edge on a card in %s", (themeId) => {
    for (const appearance of ["light", "dark"] as const) {
      const variables =
        themeId === DEFAULT_MOBILE_THEME_ID
          ? readDefaultMobileThemeVariables(appearance)
          : getMobileThemeVariables(themeId, appearance);
      if (appearance === "light")
        expect(variables["--color-secondary-border"]).toBe(variables["--color-border"]);
      else
        expect(
          themeColorContrastRatio(
            variables["--color-secondary-border"],
            variables["--color-grouped-card"],
          ),
        ).toBeGreaterThanOrEqual(1.6);
    }
  });
});
