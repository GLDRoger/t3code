import { KinOrgId, type KinPicturesSetInput, type KinPicturesView } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Redacted from "effect/Redacted";
import { AsyncResult } from "effect/reactivity";

import { createKinPicturesActions, kinPicturesRows } from "./kinPictures.ts";

const orgId = KinOrgId.make("org");
const view = (overrides: Partial<KinPicturesView> = {}): KinPicturesView => ({
  orgId,
  vendor: { label: "OpenAI", keyUrl: "https://platform.openai.com/api-keys" },
  connected: true,
  // 23:30 on 19 Nov in UTC is already 20 Nov in Kolkata.
  savedAt: "2026-11-19T23:30:00.000Z",
  model: "gpt-image-2.5-flare",
  monthlyLimit: 50,
  usedThisMonth: 12,
  resetsOn: "2026-12-01",
  ...overrides,
});
const options = { locale: "en-GB", zone: "Asia/Kolkata" };

describe("kinPicturesRows", () => {
  it("says the key's day where the reader is and the count against the limit", () => {
    const rows = kinPicturesRows(view(), options);
    expect([rows.keyLine, rows.usage, rows.limitLabel]).toEqual([
      "Key saved 20 Nov",
      "12 of 50 this month, resets on 1 Dec",
      "50 a month",
    ]);
    expect(rows.choices.filter((choice) => choice.selected).map((one) => one.value)).toEqual([50]);
  });

  it("with No limit still shows the count, and keeps a limit set elsewhere among the choices", () => {
    expect(kinPicturesRows(view({ monthlyLimit: null }), options).usage).toBe(
      "12 this month · No limit",
    );
    const choices = kinPicturesRows(view({ monthlyLimit: 75 }), options).choices;
    expect(choices.map((choice) => choice.label)).toEqual([
      "No limit",
      "10 a month",
      "25 a month",
      "50 a month",
      "75 a month",
      "100 a month",
      "250 a month",
      "500 a month",
    ]);
    expect(kinPicturesRows(view({ connected: false, savedAt: null }), options).keyLine).toBeNull();
  });
});

describe("createKinPicturesActions", () => {
  it("sends a pasted key once, redacted, with the chosen limit, and refuses an empty one", async () => {
    const sent: Array<KinPicturesSetInput> = [];
    let reloads = 0;
    const actions = createKinPicturesActions({
      orgId,
      set: (input) => {
        sent.push(input);
        return Promise.resolve(AsyncResult.success(view()));
      },
      reload: () => {
        reloads += 1;
      },
    });
    expect(await actions.connect("   ", 50)).toEqual({
      ok: false,
      problem: "Paste the key to connect.",
    });
    expect(sent).toEqual([]);
    expect((await actions.connect(" sk-invented ", null)).ok).toBe(true);
    await actions.disconnect();
    expect(
      sent.map((input) => [
        input.key === undefined ? null : Redacted.value(input.key),
        input.monthlyLimit,
        input.disconnect,
      ]),
    ).toEqual([
      ["sk-invented", null, undefined],
      [null, undefined, true],
    ]);
    expect(String(sent[0]!.key)).not.toContain("sk-invented");
    expect(reloads).toBe(2);
  });
});
