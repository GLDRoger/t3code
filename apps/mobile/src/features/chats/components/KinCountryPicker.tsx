import { LegendList } from "@legendapp/list/react-native";
import {
  KIN_COMPANY,
  kinCountryChoices,
  kinCountryName,
  type KinCountryChoice,
} from "@t3tools/client-runtime/kin/kinCompanyProfile";
import { type ComponentRef, use, useEffect, useRef, useState } from "react";
import { View, type TextInputInstance } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";

import { AppText as Text } from "../../../components/ui/AppText";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { ListRow } from "../../../components/ui/ListRow";
import { SearchField } from "../../../components/ui/SearchField";
import { KinWorkAboveKeyboard } from "./KinWorkPieces";

// About seven rows: the picker scrolls within the screen rather than lengthening it.
const LIST_MAX_HEIGHT = 340;
// Four rows: with the search field, they fit above the keyboard on the smallest iPhone.
const KEYBOARD_LIST_MAX_HEIGHT = 192;

/** A company's country, found by typing its name or code and picking from the matches. */
export function KinCountryPicker(props: {
  readonly label: string;
  readonly value: string | null;
  readonly disabled: boolean;
  readonly onPick: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<TextInputInstance>(null);
  const found = useRef<ComponentRef<typeof View>>(null);
  const aboveKeyboard = use(KinWorkAboveKeyboard);
  const keyboardUp = useKeyboardState((keyboard) => keyboard.isVisible);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the native scroll view so the search and its rows clear the keyboard once it is up
  useEffect(() => {
    if (open && keyboardUp && found.current !== null) aboveKeyboard?.(found.current);
  }, [open, keyboardUp, aboveKeyboard]);
  const choices = kinCountryChoices(query);
  const close = () => {
    setOpen(false);
    setQuery("");
  };
  return (
    <>
      <ListRow
        icon="globe"
        label={props.label}
        detail={props.value === null ? KIN_COMPANY.countryPick : kinCountryName(props.value)}
        detailEllipsizeMode="tail"
        disabled={props.disabled}
        onPress={() => (open ? close() : setOpen(true))}
      />
      {!open ? null : (
        <View ref={found} collapsable={false}>
          <View className="flex-row px-4 py-2">
            <SearchField
              autoFocus
              inputRef={inputRef}
              accessibilityLabel={KIN_COMPANY.countrySearch}
              clearAccessibilityLabel="Clear search"
              placeholder={KIN_COMPANY.countrySearch}
              value={query}
              onChangeText={setQuery}
            />
          </View>
          {choices.length === 0 ? (
            <Text textRole="footnote" className="px-4 py-3 text-foreground-muted">
              {KIN_COMPANY.countryNoMatch}
            </Text>
          ) : (
            /* oxlint-disable-next-line t3code/require-registered-list-scroll -- nested in the screen's own registered scroll view */
            <LegendList<KinCountryChoice>
              style={{ maxHeight: keyboardUp ? KEYBOARD_LIST_MAX_HEIGHT : LIST_MAX_HEIGHT }}
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
              data={choices}
              keyExtractor={(choice) => choice.code}
              extraData={props.value}
              estimatedItemSize={48}
              recycleItems
              renderItem={({ item: choice }) => (
                <ListChoiceRow
                  label={choice.name}
                  meta={
                    <Text textRole="footnote" className="text-foreground-muted">
                      {choice.code}
                    </Text>
                  }
                  selected={choice.code === props.value}
                  separated
                  onPress={() => {
                    props.onPick(choice.code);
                    close();
                  }}
                />
              )}
            />
          )}
        </View>
      )}
    </>
  );
}
