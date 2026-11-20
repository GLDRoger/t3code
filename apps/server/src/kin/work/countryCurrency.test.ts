import { isKinCurrency, KinCountryCode } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { COUNTRY_CURRENCIES } from "./countryCurrency.ts";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const accepted = [...LETTERS]
  .flatMap((first) => [...LETTERS].map((second) => first + second))
  .filter(Schema.is(KinCountryCode));
const places = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
// Codes CLDR names that are no country of ISO 3166: reserved, withdrawn, groupings and test codes.
const NOT_COUNTRIES =
  "AC AN BU CP CQ CS DD DG DY EA EU EZ FX HV IC NH QO RH SU TA TP UK UN VD XA XB YD YU ZR ZZ";
// Antarctica keeps no currency of its own; a company can't be there.
const NO_CURRENCY = "AQ";

describe("the country currency table", () => {
  it("has a currency Kin keeps for every country a company can name", () => {
    const countries = accepted.filter(
      (code) =>
        places.of(code) !== undefined &&
        !NOT_COUNTRIES.split(" ").includes(code) &&
        code !== NO_CURRENCY,
    );
    expect(countries).toHaveLength(249);
    expect(countries.filter((code) => !Object.hasOwn(COUNTRY_CURRENCIES, code))).toEqual([]);
    expect(Object.keys(COUNTRY_CURRENCIES).filter((code) => !countries.includes(code))).toEqual([]);
    expect(
      Object.entries(COUNTRY_CURRENCIES).filter(([, currency]) => !isKinCurrency(currency)),
    ).toEqual([]);
  });
});
