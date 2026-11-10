import { DEFAULT_UNIFIED_SETTINGS, type KinStartList } from "@t3tools/contracts/settings";

import { useKinHost } from "../../kin/useKinHost";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const KIN_START_LIST_LABELS: Record<KinStartList, string> = {
  lastUsed: "Last used",
  threads: "Coding threads",
  kin: "Kin chats",
};

/** Shown only while a host runs Kin; without Kin the app always opens to threads. */
export function KinStartListSetting() {
  const host = useKinHost();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  if (host._tag !== "host") return null;
  return (
    <SettingsRow
      {...searchableSetting("kin-start-list")}
      description="The list the app opens to. The T3 mark in the sidebar switches between them."
      resetAction={
        settings.kinStartList !== DEFAULT_UNIFIED_SETTINGS.kinStartList ? (
          <SettingResetButton
            label="start list"
            onClick={() => updateSettings({ kinStartList: DEFAULT_UNIFIED_SETTINGS.kinStartList })}
          />
        ) : null
      }
      control={
        <Select
          value={settings.kinStartList}
          onValueChange={(value) => {
            if (value === "lastUsed" || value === "threads" || value === "kin") {
              updateSettings({ kinStartList: value });
            }
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Open to">
            <SelectValue>{KIN_START_LIST_LABELS[settings.kinStartList]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(KIN_START_LIST_LABELS).map(([value, label]) => (
              <SelectItem hideIndicator key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
