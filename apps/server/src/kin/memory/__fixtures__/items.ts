export const fixtureItem = (overrides: Record<string, unknown> = {}) => {
  const fields = {
    id: "def-001",
    kind: "deferral",
    title: "Invented service maintenance",
    status: "open",
    due: "2026-11-13T09:00+05:30",
    on_due: "start",
    owner: "demo-lead",
    recorded_at: "2026-11-01T00:00:00.000Z",
    valid_from: "2026-11-01T00:00:00.000Z",
    invalid_at: null,
    superseded_by: null,
    review_by: "2026-11-13",
    source: "https://example.invalid/messages/1",
    said_by: "demo-owner",
    trust: "owner",
    links: ["issue #12"],
    ...overrides,
  };
  return `---\n${Object.entries(fields)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n")}\n---\nInvented fixture body.\n`;
};
