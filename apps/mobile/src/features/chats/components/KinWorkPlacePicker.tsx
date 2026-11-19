import {
  KIN_WORK_NEW_COPY,
  kinWorkRefsMatching,
  type KinWorkRef,
} from "@t3tools/client-runtime/kin/kinWork";
import { useRef, useState } from "react";
import { View, type TextInputInstance } from "react-native";

import type { AppSymbolName } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { ListRow } from "../../../components/ui/ListRow";
import { SearchField } from "../../../components/ui/SearchField";

/**
 * A client or project for a new task, found by typing part of its name: the row opens a search
 * field over the choices, as the time zone picker does, and a pick closes it.
 */
export function KinWorkPlacePicker(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly held: KinWorkRef | null;
  readonly choices: ReadonlyArray<KinWorkRef>;
  readonly disabled: boolean;
  readonly onPick: (ref: KinWorkRef | null) => void;
}) {
  const { held } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<TextInputInstance>(null);
  // What the form opened about stays pickable whatever the list of choices holds.
  const choices =
    held === null || props.choices.some((choice) => choice.key === held.key)
      ? props.choices
      : [held, ...props.choices];
  const found = kinWorkRefsMatching(choices, query);
  const pick = (ref: KinWorkRef | null) => {
    props.onPick(ref);
    setOpen(false);
    setQuery("");
  };
  return (
    <>
      <ListRow
        icon={props.icon}
        label={props.label}
        detail={held?.title ?? KIN_WORK_NEW_COPY.none}
        disabled={props.disabled}
        onPress={() => {
          setOpen(!open);
          setQuery("");
        }}
      />
      {!open ? null : (
        <>
          <View className="flex-row px-4 py-2">
            <SearchField
              autoFocus
              inputRef={inputRef}
              accessibilityLabel={`Find a ${props.label.toLowerCase()}`}
              clearAccessibilityLabel="Clear search"
              placeholder={`Find a ${props.label.toLowerCase()}`}
              value={query}
              onChangeText={setQuery}
            />
          </View>
          {query.trim() !== "" ? null : (
            <ListChoiceRow
              label={KIN_WORK_NEW_COPY.none}
              selected={held === null}
              separated
              onPress={() => pick(null)}
            />
          )}
          {found.map((choice) => (
            <ListChoiceRow
              key={choice.key}
              label={choice.title}
              selected={choice.key === held?.key}
              separated
              onPress={() => pick(choice)}
            />
          ))}
          {found.length > 0 ? null : (
            <Text textRole="footnote" className="px-4 py-3 text-foreground-muted">
              {KIN_WORK_NEW_COPY.noMatch}
            </Text>
          )}
        </>
      )}
    </>
  );
}
