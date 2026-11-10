import { describe, expect, it } from "vite-plus/test";

import { kinLeadDomainLabel, kinLeadDomainSlug } from "./kinLeadForm";

describe("kinLeadDomainSlug", () => {
  it.each([
    ["Growth", "growth"],
    ["  Customer support ", "customer-support"],
    ["Chief of Staff", "chief-of-staff"],
    ["R&D / Labs", "r-d-labs"],
    ["2024 Finance", "finance"],
    ["Social-media!", "social-media"],
    ["Café ops", "cafe-ops"],
  ])("turns %j into the host's slug %j", (area, slug) => {
    expect(kinLeadDomainSlug(area)).toBe(slug);
  });

  it("has no slug for an area with no letters", () => {
    expect(kinLeadDomainSlug("12345")).toBeNull();
    expect(kinLeadDomainSlug("  ")).toBeNull();
  });

  it("stays within the host's 40 characters without ending on a dash", () => {
    const slug = kinLeadDomainSlug("Enterprise customer success and onboarding operations");
    expect(slug).toBe("enterprise-customer-success-and-onboardi");
    expect(kinLeadDomainSlug(`${"a".repeat(39)} b`)).toBe("a".repeat(39));
  });

  it("reads a slug back the way the owner wrote it", () => {
    expect(kinLeadDomainLabel("chief-of-staff")).toBe("Chief of staff");
    expect(kinLeadDomainSlug(kinLeadDomainLabel("customer-support"))).toBe("customer-support");
  });
});
