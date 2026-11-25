import { KIN_TIME_ZONE_PLACEHOLDER } from "@t3tools/client-runtime/kin/kinTimeZone";
import { KIN_PROFILE_COPY, kinTimeZoneChoices } from "@t3tools/client-runtime/kin/kinProfiles";
import { useRef, useState } from "react";
import { View, type TextInputInstance } from "react-native";

import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { ListRow } from "../../../components/ui/ListRow";
import { ListSection } from "../../../components/ui/ListSection";
import { SearchField } from "../../../components/ui/SearchField";

/** A person's time zone, picked from a searchable list rather than typed. */
export function KinTimeZonePicker(props: {
  readonly value: string;
  readonly onChange: (timeZone: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<TextInputInstance>(null);
  return (
    <ListSection title={KIN_PROFILE_COPY.timeZoneLabel}>
      <ListRow
        icon="clock"
        label={props.value === "" ? "Pick a time zone" : props.value.replace(/_/g, " ")}
        detail={open ? "Done" : "Change"}
        onPress={() => {
          setOpen(!open);
          setQuery("");
        }}
      />
      {!open ? null : (
        <>
          <View className="flex-row px-4 py-2">
            {/* Unfocused: the keyboard would cover the zones it lists. */}
            <SearchField
              autoFocus={false}
              inputRef={inputRef}
              accessibilityLabel="Search time zones"
              clearAccessibilityLabel="Clear search"
              placeholder={KIN_TIME_ZONE_PLACEHOLDER}
              value={query}
              onChangeText={setQuery}
            />
          </View>
          {kinTimeZoneChoices(props.value, query).map((zone) => (
            <ListChoiceRow
              key={zone}
              label={zone.replace(/_/g, " ")}
              selected={zone === props.value}
              separated
              onPress={() => {
                props.onChange(zone);
                setOpen(false);
              }}
            />
          ))}
        </>
      )}
    </ListSection>
  );
}
