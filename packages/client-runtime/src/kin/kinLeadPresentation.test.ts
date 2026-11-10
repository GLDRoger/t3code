import { describe, expect, it } from "vite-plus/test";

import {
  kinDomainLabel,
  kinDomainSlug,
  kinLeadChanges,
  kinLeadDraftCheck,
  kinLeadDraftOf,
  kinLeadModelName,
  kinLeadTrackingDetail,
} from "./kinLeadPresentation.ts";

describe("lead domains", () => {
  it.each([
    ["Chief of staff", "chief-of-staff"],
    ["  Growth & marketing ", "growth-marketing"],
    ["2026 hiring", "hiring"],
    ["Ops!", "ops"],
    ["R&D / Labs", "r-d-labs"],
    ["Café ops", "cafe-ops"],
    ["x".repeat(60), "x".repeat(40)],
    [`${"a".repeat(39)} b`, "a".repeat(39)],
  ])("turns %j into the slug %j", (typed, slug) => {
    expect(kinDomainSlug(typed)).toBe(slug);
  });

  it.each(["", "   ", "123", "—"])("has no slug for %j", (typed) => {
    expect(kinDomainSlug(typed)).toBeNull();
  });

  it("reads a slug back as words that make the same slug", () => {
    expect(kinDomainLabel("chief-of-staff")).toBe("Chief of staff");
    expect(kinDomainSlug(kinDomainLabel("chief-of-staff"))).toBe("chief-of-staff");
  });
});

describe("lead draft", () => {
  const profile = { name: "Growth", domain: "growth", charter: "Grow signups." };

  it("names the first field to fix", () => {
    expect(kinLeadDraftCheck({ name: " ", area: "growth", charter: "" })).toMatchObject({
      ok: false,
      field: "name",
    });
    expect(kinLeadDraftCheck({ name: "Growth", area: "42", charter: "" })).toMatchObject({
      ok: false,
      field: "area",
    });
    expect(
      kinLeadDraftCheck({ name: "Growth", area: "growth", charter: "x".repeat(1_001) }),
    ).toMatchObject({ ok: false, field: "charter" });
  });

  it("takes a blank area from the name", () => {
    expect(kinLeadDraftCheck({ name: "Hiring lead", area: " ", charter: "" })).toMatchObject({
      ok: true,
      domain: "hiring-lead",
    });
    expect(kinLeadDraftCheck({ name: "招聘", area: "", charter: "" })).toMatchObject({
      ok: false,
      field: "area",
    });
  });

  it("trims what it sends", () => {
    expect(kinLeadDraftCheck({ name: " Growth ", area: "Growth", charter: " Grow. " })).toEqual({
      ok: true,
      name: "Growth",
      domain: "growth",
      charter: "Grow.",
    });
  });

  it("sends only what changed", () => {
    const same = kinLeadDraftCheck(kinLeadDraftOf(profile));
    if (!same.ok) throw new Error("expected a valid draft");
    expect(kinLeadChanges(profile, same)).toBeNull();
    const edited = kinLeadDraftCheck({ ...kinLeadDraftOf(profile), charter: "Grow revenue." });
    if (!edited.ok) throw new Error("expected a valid draft");
    expect(kinLeadChanges(profile, edited)).toEqual({ charter: "Grow revenue." });
  });
});

describe("what a lead has in hand", () => {
  it("adds the due time when there is one", () => {
    expect(kinLeadTrackingDetail({ kind: "work" })).toBe("Working on it now");
    expect(kinLeadTrackingDetail({ kind: "scheduled" })).toBe("Repeats");
    expect(
      kinLeadTrackingDetail({ kind: "reminder", dueAt: "2026-11-13T09:00:00.000Z" }, "UTC"),
    ).toBe("Reminder, Fri 13 Nov, 9:00");
  });
});

describe("lead model", () => {
  const providers = [
    { models: [{ slug: "gpt-5.1-codex", name: "GPT-5.1 Codex" }] },
    { models: [{ slug: "claude-opus-4-6", name: "Claude Opus 4.6", aliases: ["opus"] }] },
  ];

  it("names a lead's model the way the model picker does, never by its raw id", () => {
    expect(kinLeadModelName("claude-opus-4-6", providers)).toBe("Claude Opus 4.6");
    expect(kinLeadModelName("opus", providers)).toBe("Claude Opus 4.6");
    // A model no provider lists yet, or providers that haven't loaded.
    expect(kinLeadModelName("claude-sonnet-4-5", providers)).toBe("Claude Sonnet 4.5");
    expect(kinLeadModelName("claude-opus-4-6", undefined)).toBe("Claude Opus 4.6");
  });
});
