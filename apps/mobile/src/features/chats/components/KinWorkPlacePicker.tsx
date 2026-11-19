import { LegendList } from "@legendapp/list/react-native";
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

type PickerRow =
  | { readonly type: "label"; readonly id: string; readonly label: string }
  | { readonly type: "choice"; readonly id: string; readonly ref: KinWorkRef | null };

// About seven rows: the picker scrolls within the form rather than lengthening it.
const LIST_MAX_HEIGHT = 340;

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
  /** What picking nothing means here; "None" unless the screen says otherwise. */
  readonly none?: string;
  /** One more choice that is not a client or project, such as "No client", offered untyped. */
  readonly extra?: KinWorkRef;
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
  const { held, side, extra } = props;
  const none = props.none ?? KIN_WORK_NEW_COPY.none;
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
    held: extra !== undefined && held?.key === extra.key ? null : held,
  });
  const groups = kinTaskProjectMenu({ projects: view.open, doneProjects: view.done });
  const typed = query.trim() !== "";
  const rows: ReadonlyArray<PickerRow> = [
    ...(typed || (props.clearable === false && held !== null)
      ? []
      : [{ type: "choice" as const, id: "none", ref: null }]),
    ...(extra === undefined || typed
      ? []
      : [{ type: "choice" as const, id: `extra:${extra.key}`, ref: extra }]),
    ...groups.flatMap((group) => [
      ...(group.label === null
        ? []
        : [{ type: "label" as const, id: `label:${group.label}`, label: group.label }]),
      ...group.choices.map((choice) => ({
        type: "choice" as const,
        id: `${group.label ?? ""}:${choice.key}`,
        ref: choice,
      })),
    ]),
  ];
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
        detail={held?.title ?? none}
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
          {/* oxlint-disable-next-line t3code/require-registered-list-scroll -- nested in the form's own registered scroll view */}
          <LegendList<PickerRow>
            style={{ maxHeight: LIST_MAX_HEIGHT }}
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            data={rows}
            keyExtractor={(row) => row.id}
            getItemType={(row) => row.type}
            extraData={held?.key ?? null}
            estimatedItemSize={48}
            recycleItems
            renderItem={({ item: row }) =>
              row.type === "label" ? (
                <Text textRole="footnote" className="px-4 pt-3 pb-1 text-foreground-muted">
                  {row.label}
                </Text>
              ) : (
                <ListChoiceRow
                  label={row.ref?.title ?? none}
                  selected={row.ref === null ? held === null : row.ref.key === held?.key}
                  separated
                  onPress={() => pick(row.ref)}
                />
              )
            }
          />
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
