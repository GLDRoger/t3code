import { KIN_WORK_NEW_COPY, type KinWorkRef } from "@t3tools/client-runtime/kin/kinWork";
import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import { KIN_PICKER_COPY, kinPickerSearchView } from "@t3tools/client-runtime/kin/kinWorkList";
import { useId } from "react";

import { Button } from "../components/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxStatus,
} from "../components/ui/combobox";
import { Label } from "../components/ui/label";
import { useKinPickerSearch, type KinWorkTarget } from "./useKinWork";

// Not a record key: those are a prefix, a dash and a number.
const NOTHING_KEY = "kin:nothing";

/**
 * A client or a project, or neither, found by typing part of its name: the first page shows at
 * once, and typing asks the host about every one the person may see.
 */
export function KinPlaceCombobox(props: {
  readonly target: KinWorkTarget;
  readonly noun: "client" | "project";
  readonly label: string;
  /** A toolbar's picker names itself to assistive tech only. */
  readonly labelHidden?: boolean;
  /** What an empty field says: what picking nothing means here, offered as a row of its own. */
  readonly placeholder?: string;
  readonly value: KinWorkRef | null;
  readonly choices: ReadonlyArray<KinWorkRef>;
  /** The only keys this viewer may pick (`kinTaskProjectsAllowed`); null or absent for any. */
  readonly only?: ReadonlySet<string> | null;
  /** One more choice that is not a client or project, such as "No client", offered untyped. */
  readonly extra?: KinWorkRef;
  readonly onChange: (value: KinWorkRef | null) => void;
}) {
  const id = useId();
  const search = useKinPickerSearch(
    props.target,
    props.noun === "client" ? "clients" : "projects",
    false,
  );
  const { extra } = props;
  const held = extra !== undefined && props.value?.key === extra.key ? null : props.value;
  const view = kinPickerSearchView({
    noun: props.noun,
    search: search.state,
    loaded: { open: props.choices, done: [] },
    held,
    only: props.only ?? null,
  });
  const typed = search.state.text.trim() !== "";
  const nothing =
    props.placeholder === undefined ? undefined : { key: NOTHING_KEY, title: props.placeholder };
  const items = typed
    ? view.open
    : [
        ...(nothing === undefined ? [] : [nothing]),
        ...view.open,
        ...(extra === undefined ? [] : [extra]),
      ];
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {props.labelHidden ? null : <Label htmlFor={id}>{props.label}</Label>}
      <Combobox
        items={items}
        filteredItems={items}
        filter={null}
        value={props.value}
        autoHighlight
        itemToStringLabel={(choice: KinWorkRef) => choice.title}
        isItemEqualToValue={(a: KinWorkRef, b: KinWorkRef) => a.key === b.key}
        onInputValueChange={(text, details) => {
          if (details.reason === "input-change" || details.reason === "input-clear")
            search.type(text);
        }}
        onOpenChange={(open) => {
          if (!open) search.type("");
        }}
        onValueChange={(choice: KinWorkRef | null) => {
          search.type("");
          props.onChange(choice?.key === NOTHING_KEY ? null : choice);
        }}
      >
        <ComboboxInput
          id={id}
          aria-label={props.label}
          placeholder={props.placeholder ?? KIN_WORK_NEW_COPY.none}
          showClear={props.value !== null}
        />
        <ComboboxPopup>
          <ComboboxEmpty>
            {view.failure !== null
              ? null
              : view.loading
                ? KIN_PICKER_COPY.searching
                : (view.note ?? KIN_WORK_NEW_COPY.noMatch)}
          </ComboboxEmpty>
          <ComboboxList>
            {(choice: KinWorkRef) => (
              <ComboboxItem key={choice.key} value={choice} title={choice.title}>
                <span className="min-w-0 flex-1 truncate">{choice.title}</span>
              </ComboboxItem>
            )}
          </ComboboxList>
          {view.failure !== null ? (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              {view.failure.text}
              {!view.failure.retry ? null : (
                <Button size="xs" variant="outline" onClick={() => void search.retry()}>
                  {KIN_RETRY}
                </Button>
              )}
            </div>
          ) : (
            <ComboboxStatus>
              {view.open.length === 0 ? null : view.loading ? KIN_PICKER_COPY.searching : view.note}
            </ComboboxStatus>
          )}
        </ComboboxPopup>
      </Combobox>
    </div>
  );
}
