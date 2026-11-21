import { useNavigation } from "@react-navigation/native";
import { KIN_SETTINGS_PAGE_TITLES } from "@t3tools/client-runtime/kin/kinNavigation";
import { Platform, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { AndroidNavigationAppearanceSection } from "../settings/appearance/sections/AndroidNavigationAppearanceSection";
import { TextAppearanceSection } from "../settings/appearance/sections/TextAppearanceSection";
import { ThemeAppearanceSection } from "../settings/appearance/sections/ThemeAppearanceSection";

/** T3's Appearance without its coding sections (terminal, code and diffs, tool calls). */
export function KinAppearanceScreen() {
  const navigation = useNavigation();
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={KIN_SETTINGS_PAGE_TITLES.appearance} onBack={() => navigation.goBack()} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          <ThemeAppearanceSection />
          {Platform.OS === "android" ? <AndroidNavigationAppearanceSection /> : null}
          <TextAppearanceSection />
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}
