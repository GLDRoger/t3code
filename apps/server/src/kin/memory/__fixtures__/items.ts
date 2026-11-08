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

export const readmeItem = `---
id: def-demo-142
kind: deferral            # objective | commitment | deferral | decision | person | claim
title: Invented queue maintenance
status: open              # open | done | cancelled | superseded
due: 2026-12-13T09:00+05:30
on_due: start             # deferrals: remind | start | ask | chase
owner: demo-lead
recorded_at: 2026-12-10T16:20+05:30
valid_from: 2026-12-10T16:20+05:30
invalid_at: null          # set when it stops being true; never delete
superseded_by: null
review_by: 2026-12-13       # when to check it's still true; decisions: null
source: https://example.invalid/messages/demo
said_by: demo-owner         # the person, not the agent that wrote it down
trust: owner              # owner | member | external | agent
links: [issue #88, dec-031]
---

Invented maintenance deferred until the demo queue is drained.
`;
