import { KinOrgId, type KinCompanyBrand } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinBrandInput, kinContrastHint, kinHexColor } from "./kinBrand.ts";

const orgId = KinOrgId.make("org");
const brand: KinCompanyBrand = {
  primaryColor: "#1F4E79",
  secondaryColor: null,
  font: null,
  footer: null,
};

describe("brand", () => {
  it.each([
    ["#1f4e79", "#1F4E79"],
    ["1F4E79", "#1F4E79"],
    [" #abc ", "#AABBCC"],
    ["", null],
    ["#12345", undefined],
    ["blue", undefined],
  ])("reads %j as %j", (text, hex) => {
    expect(kinHexColor(text)).toBe(hex);
  });

  it("says whether a colour reads on white", () => {
    expect(kinContrastHint("#000000")).toEqual({ ok: true, text: "Reads well on white (21.0:1)." });
    expect(kinContrastHint("#FFEE00")?.ok).toBe(false);
    expect(kinContrastHint("")).toBeNull();
    expect(kinContrastHint("nope")).toMatchObject({ ok: false });
  });

  it("sends only what changed, clears with null, and refuses a bad colour", () => {
    const draft = {
      primaryColor: "#1f4e79",
      secondaryColor: "fff",
      font: "Mukta",
      footer: " ",
    } as const;
    expect(kinBrandInput(orgId, { rev: 3, brand }, draft)).toEqual({
      ok: true,
      input: { orgId, rev: 3, brand: { secondaryColor: "#FFFFFF", font: "Mukta" } },
    });
    expect(
      kinBrandInput(orgId, { rev: 3, brand }, { ...draft, primaryColor: "", secondaryColor: "" }),
    ).toEqual({ ok: true, input: { orgId, rev: 3, brand: { primaryColor: null, font: "Mukta" } } });
    expect(
      kinBrandInput(
        orgId,
        { rev: 3, brand },
        { primaryColor: "#1F4E79", secondaryColor: "", font: null, footer: "" },
      ),
    ).toEqual({ ok: true, input: null });
    expect(
      kinBrandInput(orgId, { rev: 3, brand }, { ...draft, primaryColor: "#12" }),
    ).toMatchObject({
      ok: false,
      problems: { primaryColor: "Use a colour like #1F4E79." },
    });
  });
});
