import { describe, expect, it } from "vite-plus/test";

import {
  kinContactFormCheck,
  kinProjectFormCheck,
  kinProjectTargetHint,
} from "./kinWorkFormChecks";

const project = { name: "Relaunch", party: null, repos: "", notes: "", private: false };
const contact = { name: "Ravi", role: "", email: "", phone: "", notes: "", private: false };
const now = new Date(2026, 10, 12);

describe("kinProjectFormCheck", () => {
  it.each([
    ["2026-02-30", "Enter a real date."],
    ["2026-13-01", "Enter a real date."],
    ["2025-02-29", "Enter a real date."],
    ["2028-02-29", null],
    ["2026-12-31", null],
  ])("target %s", (target, problem) => {
    expect(kinProjectFormCheck({ ...project, target })).toBe(problem);
  });
});

describe("kinProjectTargetHint", () => {
  it("names the year only outside this one, and never labels an impossible day", () => {
    expect(kinProjectTargetHint("2026-12-03", now)).not.toMatch(/2026/);
    expect(kinProjectTargetHint("2027-03-02", now)).toMatch(/2027$/);
    expect(kinProjectTargetHint("2026-02-30", now)).toBe("Enter a real date.");
  });
});

describe("kinContactFormCheck", () => {
  it.each([
    [{ email: "not-an-email" }, "Enter an email like name@example.com."],
    [{ phone: "abc" }, "Enter a phone number with at least 5 digits."],
    [{ email: "ravi@acme.in", phone: "+91 98450 12345" }, null],
    [{}, null],
  ])("%o", (details, problem) => {
    expect(kinContactFormCheck({ ...contact, ...details })).toBe(problem);
  });
});
