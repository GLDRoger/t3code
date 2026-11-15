import { assert, describe, it } from "@effect/vitest";

import { nextPullRow, type PullRow } from "./pullRequestState.ts";

// Invented repo and people; payloads carry only the fields GitHub's webhooks are read for.
const pull = (fields: Record<string, unknown> = {}) => ({
  number: 7,
  title: "Invented change",
  html_url: "https://github.com/acme/app/pull/7",
  state: "open",
  draft: false,
  user: { login: "mate" },
  created_at: "2026-11-01T00:00:00Z",
  head: { sha: "sha-1", ref: "feature", repo: { full_name: "acme/app" } },
  ...fields,
});
const at = (hour: number) => new Date(Date.UTC(2026, 10, 1, hour)).toISOString();
const step = (
  stored: PullRow | undefined,
  event: string,
  action: string | null,
  payload: unknown,
  hour: number,
) => nextPullRow(stored, { event, action, payload, receivedAt: at(hour) }, 7);

describe("nextPullRow", () => {
  it("follows a PR from opened through review and checks to ready, and a new push resets checks", () => {
    const opened = step(undefined, "pull_request", "opened", { pull_request: pull() }, 0)!;
    assert.include(opened, { state: "open", reviewRequestedAt: null, checks: null, readyAt: null });
    assert.strictEqual(opened.openedAt, Date.UTC(2026, 10, 1));

    const asked = step(opened, "pull_request", "review_requested", { pull_request: pull() }, 1)!;
    assert.strictEqual(asked.reviewRequestedAt, Date.UTC(2026, 10, 1, 1));

    const failing = step(
      asked,
      "check_suite",
      "completed",
      { check_suite: { head_sha: "sha-1", status: "completed", conclusion: "failure" } },
      2,
    )!;
    assert.include(failing, { checks: "failure", checksSha: "sha-1" });
    // A later passing suite on the same commit doesn't hide the failure.
    const stillFailing = step(
      failing,
      "check_suite",
      "completed",
      { check_suite: { head_sha: "sha-1", status: "completed", conclusion: "success" } },
      3,
    )!;
    assert.strictEqual(stillFailing.checks, "failure");

    const pushed = step(
      stillFailing,
      "pull_request",
      "synchronize",
      { pull_request: pull({ head: { sha: "sha-2", ref: "feature" } }) },
      4,
    )!;
    assert.include(pushed, { headSha: "sha-2", checks: null, checksSha: null });
    // A suite for the old commit says nothing about the new one.
    assert.isUndefined(
      step(
        pushed,
        "check_suite",
        "completed",
        { check_suite: { head_sha: "sha-1", status: "completed", conclusion: "success" } },
        5,
      ),
    );
    const green = step(
      pushed,
      "check_suite",
      "completed",
      { check_suite: { head_sha: "sha-2", status: "completed", conclusion: "success" } },
      5,
    )!;
    assert.include(green, { checks: "success", readyAt: null });

    const approved = step(
      green,
      "pull_request_review",
      "submitted",
      {
        pull_request: pull({ head: { sha: "sha-2", ref: "feature" } }),
        review: { state: "APPROVED" },
      },
      6,
    )!;
    assert.include(approved, {
      review: "approved",
      reviewRequestedAt: null,
      readyAt: Date.UTC(2026, 10, 1, 6),
    });

    const merged = step(
      approved,
      "pull_request",
      "closed",
      {
        pull_request: pull({
          state: "closed",
          merged: true,
          head: { sha: "sha-2", ref: "feature" },
        }),
      },
      7,
    )!;
    assert.include(merged, { state: "merged", readyAt: null });
  });

  it("ignores events about another PR and payloads it can't read", () => {
    assert.isUndefined(
      step(undefined, "pull_request", "opened", { pull_request: pull({ number: 8 }) }, 0),
    );
    assert.isUndefined(step(undefined, "pull_request", "opened", "not json", 0));
  });
});
