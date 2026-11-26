import {
  KIN_COMPANY,
  kinCountries,
  kinCountryChoices,
  kinCountryCodeOf,
  type KinCountryChoice,
} from "@t3tools/client-runtime/kin/kinCompanyProfile";
import { useState } from "react";

import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "../components/ui/combobox";

/** A country, found by typing its name or code and picking from the matches. */
export function KinCountryCombobox(props: {
  readonly id: string;
  readonly value: string;
  readonly placeholder?: string | undefined;
  readonly disabled: boolean;
  readonly invalid: boolean;
  readonly onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const countries = kinCountries();
  const code = kinCountryCodeOf(props.value);
  const selected = code === null ? null : (countries.find((one) => one.code === code) ?? null);
  const items = kinCountryChoices(query);
  return (
    <Combobox
      items={countries}
      filteredItems={items}
      filter={null}
      value={selected}
      inputValue={props.value}
      autoHighlight
      itemToStringLabel={(choice: KinCountryChoice) => choice.name}
      isItemEqualToValue={(a: KinCountryChoice, b: KinCountryChoice) => a.code === b.code}
      disabled={props.disabled}
      onInputValueChange={(text, details) => {
        if (details.reason === "input-change" || details.reason === "clear-press") {
          setQuery(text);
          props.onChange(text);
        }
      }}
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
      onValueChange={(choice: KinCountryChoice | null, details) => {
        setQuery("");
        if (choice !== null) props.onChange(choice.name);
        else if (details.reason === "clear-press") props.onChange("");
      }}
    >
      <ComboboxInput
        id={props.id}
        placeholder={props.placeholder}
        aria-invalid={props.invalid}
        showClear={props.value.trim() !== ""}
      />
      <ComboboxPopup>
        <ComboboxEmpty>{KIN_COMPANY.countryNoMatch}</ComboboxEmpty>
        <ComboboxList>
          {(choice: KinCountryChoice) => (
            <ComboboxItem key={choice.code} value={choice} title={choice.name}>
              <span className="min-w-0 flex-1 truncate">{choice.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{choice.code}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
