import { useTheme } from "../../hooks/useTheme";
import type { ThemePreferenceMode } from "../../themePalette";
import { KinSettingsChoice } from "./KinSettingsControls";
import { KinSettingsPage, KinSettingsRow, KinSettingsSection } from "./KinSettingsLayout";

const APPEARANCE_LABELS: Record<ThemePreferenceMode, string> = {
  system: "Match this device",
  light: "Light",
  dark: "Dark",
};

/** Light, dark or the device's own, for this browser; the app's theme library is under This computer. */
export function KinAppearancePage() {
  const { appearanceMode, setAppearanceMode } = useTheme();
  return (
    <KinSettingsPage purpose="How Kin looks on this browser. Your other devices keep their own.">
      <KinSettingsSection>
        <KinSettingsRow
          title="Theme"
          control={
            <KinSettingsChoice
              label="Theme"
              value={appearanceMode}
              options={(["system", "light", "dark"] as const).map((mode) => ({
                value: mode,
                label: APPEARANCE_LABELS[mode],
              }))}
              onChange={setAppearanceMode}
            />
          }
        />
      </KinSettingsSection>
    </KinSettingsPage>
  );
}
