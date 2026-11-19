import { KIN_WORK_NEW_COPY, type KinWorkRef } from "@t3tools/client-runtime/kin/kinWork";
import { kinTaskProjectMenu } from "@t3tools/client-runtime/kin/kinWorkForms";
import { KIN_PICKER_COPY, kinPickerSearchView } from "@t3tools/client-runtime/kin/kinWorkList";
import { useRef, useState } from "react";
import { View, type TextInputInstance } from "react-native";

import type { AppSymbolName } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { ListRow } from "../../../components/ui/ListRow";
import { SearchField } from "../../../components/ui/SearchField";
import { useKinPickerSearch, type KinWorkTarget } from "../state/useKinWork";

/**
 * A client or project, found by typing part of its name: the row opens a search field over the
 * choices, as the time zone picker does, typing asks the host about every one the person may see,
 * and a pick closes it.
 */
export function KinWorkPlacePicker(props: {
  readonly target: KinWorkTarget;
  readonly noun: "client" | "project";
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly held: KinWorkRef | null;
  readonly choices: ReadonlyArray<KinWorkRef>;
  /** A task's done projects, offered after the open ones so a late task can still be filed there. */
  readonly done?: ReadonlyArray<KinWorkRef>;
  readonly disabled: boolean;
  readonly onPick: (ref: KinWorkRef | null) => void;
  /** Whether "None" is offered: the host may let a value change but not be cleared. */
  readonly clearable?: boolean;
  readonly onOpen?: () => void;
  /** A client's: who owes the task, us or them. */
  readonly side?: {
    readonly value: "ours" | "theirs";
    readonly onPick: (side: "ours" | "theirs") => void;
  };
}) {
  const { held, side } = props;
  const [open, setOpen] = useState(false);
  const inputRef = useRef<TextInputInstance>(null);
  const search = useKinPickerSearch(
    props.target,
    props.noun === "client" ? "clients" : "projects",
    props.done !== undefined,
  );
  const query = search.state.text;
  const view = kinPickerSearchView({
    noun: props.noun,
    search: search.state,
    loaded: { open: props.choices, done: props.done ?? [] },
    held,
  });
  const groups = kinTaskProjectMenu({ projects: view.open, doneProjects: view.done });
  const close = () => {
    setOpen(false);
    search.type("");
  };
  const pick = (ref: KinWorkRef | null) => {
    props.onPick(ref);
    close();
  };
  return (
    <>
      <ListRow
        icon={props.icon}
        label={props.label}
        detail={held?.title ?? KIN_WORK_NEW_COPY.none}
        {...(held !== null && side?.value === "theirs"
          ? { description: KIN_WORK_NEW_COPY.sideTheirs }
          : {})}
        disabled={props.disabled}
        onPress={() => (open ? close() : setOpen(true))}
      />
      {!open ? null : (
        <>
          {held === null || props.onOpen === undefined ? null : (
            <ListChoiceRow
              label={`Open ${held.title}`}
              selected={false}
              separated
              onPress={() => {
                close();
                props.onOpen?.();
              }}
            />
          )}
          {held === null || side === undefined ? null : (
            <ListChoiceRow
              label={
                side.value === "theirs"
                  ? KIN_WORK_NEW_COPY.sideOurs
                  : `${KIN_WORK_NEW_COPY.sideTheirs}, not us`
              }
              selected={false}
              separated
              disabled={props.disabled}
              onPress={() => {
                side.onPick(side.value === "theirs" ? "ours" : "theirs");
                close();
              }}
            />
          )}
          <View className="flex-row px-4 py-2">
            <SearchField
              autoFocus
              inputRef={inputRef}
              accessibilityLabel={`Find a ${props.noun}`}
              clearAccessibilityLabel="Clear search"
              placeholder={`Find a ${props.noun}`}
              value={query}
              onChangeText={search.type}
            />
          </View>
          {query.trim() !== "" || (props.clearable === false && held !== null) ? null : (
            <ListChoiceRow
              label={KIN_WORK_NEW_COPY.none}
              selected={held === null}
              separated
              onPress={() => pick(null)}
            />
          )}
          {groups.map((group) => (
            <View key={group.label ?? ""}>
              {group.label === null ? null : (
                <Text textRole="footnote" className="px-4 pt-3 pb-1 text-foreground-muted">
                  {group.label}
                </Text>
              )}
              {group.choices.map((choice) => (
                <ListChoiceRow
                  key={choice.key}
                  label={choice.title}
                  selected={choice.key === held?.key}
                  separated
                  onPress={() => pick(choice)}
                />
              ))}
            </View>
          ))}
          {view.failure !== null ? (
            <ListChoiceRow
              label={view.failure.text}
              selected={false}
              disabled={!view.failure.retry}
              onPress={() => void search.retry()}
            />
          ) : view.loading || view.note !== null || groups.length === 0 ? (
            <Text textRole="footnote" className="px-4 py-3 text-foreground-muted">
              {view.loading ? KIN_PICKER_COPY.searching : (view.note ?? KIN_WORK_NEW_COPY.noMatch)}
            </Text>
          ) : null}
        </>
      )}
    </>
  );
}
