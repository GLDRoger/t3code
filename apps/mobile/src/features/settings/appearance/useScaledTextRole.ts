import { Platform, useWindowDimensions } from "react-native";

import { resolveComposerTextRole, resolveScaledTextRole } from "../../../lib/appearancePreferences";
import { MOBILE_TYPOGRAPHY } from "../../../lib/typography";
import { useAppearancePreferences } from "./AppearancePreferencesProvider";

export interface ScaledTextRole {
  readonly fontSize: number;
  readonly lineHeight: number;
}

/** Avoid CSS-variable subscriptions so palette-only setTheme calls remain native-only. */
export function useScaledTextRole(role: keyof typeof MOBILE_TYPOGRAPHY): ScaledTextRole {
  const { appearance } = useAppearancePreferences();
  return resolveScaledTextRole(role, appearance.baseFontSize);
}

/**
 * The system text size as a multiplier for iOS views that set their own font and so ignore
 * Dynamic Type, like the native composer and stack bar. React Native text scales itself.
 */
export function useNativeFontScale(max: number): number {
  const { fontScale } = useWindowDimensions();
  return Platform.OS === "ios" ? Math.min(fontScale, max) : 1;
}

export function useComposerTextRole(): ScaledTextRole {
  const body = useScaledTextRole("body");
  const { fontScale } = useWindowDimensions();
  return resolveComposerTextRole(body, fontScale, Platform.OS);
}
