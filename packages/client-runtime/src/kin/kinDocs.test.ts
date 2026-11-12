// @effect-diagnostics globalDate:off - Fixtures build ISO times relative to a fixed clock.
import {
  KinAgentId,
  KinChatError,
  KinPersonId,
  KinRecordId,
  type KinDocRow,
  type KinDocSection,
  type KinDocVersion,
  type KinSearchResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import type { AtomCommandResult } from "../state/runtime.ts";
import {
  createKinSearch,
  kinDocChangeLine,
  kinSearchHit,
  kinDocGroups,
  kinDocRef,
  kinDocRefLabel,
  kinDocRestoreOutcome,
  kinDocSections,
  type KinSearchState,
} from "./kinDocs.ts";
import type { KinWorkNames } from "./kinWork.ts";

const me = { _tag: "person", personId: KinPersonId.make("invented-owner") } as const;
const growth = { _tag: "agent", agentId: KinAgentId.make("invented-growth") } as const;
const names: KinWorkNames = {
  people: new Map([[me.personId, "Invented Owner"]]),
  agents: new Map([[growth.agentId, "Growth"]]),
  me: me.personId,
  zone: "UTC",
};
const now = new Date(2026, 10, 11, 16, 0);
const version = (patch: Partial<KinDocVersion> = {}): KinDocVersion => ({
  version: 2,
  at: new Date(2026, 10, 11, 14, 2).toISOString(),
  kind: "edited",
  title: "Launch plan",
  summary: "Moved the launch to 14 Dec",
  baseVersion: 1,
  restoredFrom: null,
  operations: [],
  chars: 100,
  provenance: {
    by: growth,
    via: "lead",
    wakeupId: null,
    chatId: null,
    answered: null,
    audience: "owner_only",
  },
  ...patch,
});
const row = (key: string, patch: Partial<KinDocRow> = {}): KinDocRow => ({
  recordId: KinRecordId.make(`rec-${key}`),
  key,
  title: `Doc ${key}`,
  owner: growth,
  sensitive: false,
  archived: false,
  bodyKind: "markdown",
  latest: version(),
  createdAt: version().at,
  updatedAt: version().at,
  rev: 1,
  ...patch,
});
const section = (id: string, title: string, level: number): KinDocSection => ({
  id,
  title,
  level,
  chars: 1,
  hash: "h",
});

describe("kinDocChangeLine", () => {
  it("says when, who and what changed", () => {
    const line = kinDocChangeLine(
      { at: version().at, kind: "edited", summary: " Moved the launch\nto 14 Dec ", by: growth },
      names,
      now,
    );
    expect(line.lead).toMatch(/^Updated today \S*:02.* by Growth$/);
    expect(line.summary).toBe("Moved the launch to 14 Dec");
    expect(
      kinDocChangeLine({ at: version().at, kind: "restored", summary: "", by: me }, names, now)
        .text,
    ).toMatch(/^Restored today .* by you$/);
    expect(
      kinDocChangeLine(
        { at: version().at, kind: "restored", summary: "Restored version 10", by: me },
        names,
        now,
      ).text,
    ).toMatch(/^Restored version 10 today .* by you$/);
    expect(
      kinDocChangeLine(
        { at: version().at, kind: "created", summary: "Created", by: growth },
        names,
        now,
      ).summary,
    ).toBeNull();
  });
});

describe("kinSearchHit", () => {
  it("reads a snippet of markdown source as prose", () => {
    const hit = kinSearchHit({
      recordId: KinRecordId.make("d1"),
      key: "D-1",
      kind: "docs",
      title: "Launch plan",
      snippet:
        "…to everyone ## Risks - [x] Tins **late** | Box | Price | | :-- | --: | see [the brief](https://example.invalid)…",
      section: { id: "risks", title: "Risks" },
      sensitive: false,
      closed: false,
      updatedAt: version().at,
    });
    expect(hit.snippet).toBe("…to everyone Risks · Tins late Box Price see the brief…");
  });
});

describe("kinDocGroups", () => {
  it("groups by client with the unlinked docs last", () => {
    const acme = { recordId: KinRecordId.make("c1"), key: "C-1", title: "Acme" };
    const zed = { recordId: KinRecordId.make("c2"), key: "C-2", title: "Zed" };
    const groups = kinDocGroups(
      [
        row("D-1"),
        row("D-2", { party: zed }),
        row("D-3", { party: acme }),
        row("D-4", { party: zed }),
      ],
      "client",
      names,
    );
    expect(groups.map((group) => [group.title, group.rows.map((held) => held.key)])).toEqual([
      ["Acme", ["D-3"]],
      ["Zed", ["D-2", "D-4"]],
      ["No client", ["D-1"]],
    ]);
    expect(kinDocGroups([row("D-1")], "agent", names)[0]?.title).toBe("Growth");
  });
});

describe("kinDocSections", () => {
  const body = [
    "Opening words.",
    "",
    "# Plan",
    "Intro",
    "```md",
    "# not a heading",
    "```",
    "## Pricing ##",
    "Two plans.",
    "",
  ].join("\n");

  it("cuts the body where the host's outline does, skipping code fences", () => {
    const sections = kinDocSections(body, [
      section("top", "", 0),
      section("plan", "Plan", 1),
      section("pricing", "Pricing", 2),
    ]);
    expect(sections?.map((held) => [held.id, held.text])).toEqual([
      ["top", "Opening words.\n"],
      ["plan", "# Plan\nIntro\n```md\n# not a heading\n```"],
      ["pricing", "## Pricing ##\nTwo plans."],
    ]);
  });

  it("gives up when the outline disagrees, so nothing is mislabelled", () => {
    expect(kinDocSections(body, [section("plan", "Plan", 1)])).toBeNull();
    expect(
      kinDocSections(body, [section("plan", "Plan", 1), section("pricing", "Pricing", 2)]),
    ).toBeNull();
  });
});

describe("kinDocRef", () => {
  it("names the doc and the section at the version on screen", () => {
    const doc = {
      key: "D-7",
      title: "Launch plan",
      version: version({ version: 4 }),
      outline: [section("pricing", "Pricing", 2)],
    };
    const ref = kinDocRef(doc, "pricing");
    expect(ref).toMatchObject({ key: "D-7", version: 4, section: "pricing" });
    expect(kinDocRefLabel(ref)).toBe("Launch plan › Pricing");
    // A section that is no longer in the doc points at the doc, not at nothing.
    expect(kinDocRefLabel(kinDocRef(doc, "gone"))).toBe("Launch plan");
  });
});

describe("kinDocRestoreOutcome", () => {
  it("tells a newer version from a plain failure", () => {
    const refused = kinDocRestoreOutcome(
      AsyncResult.failure(
        Cause.fail(new KinChatError({ reason: "conflict", message: "newer" })),
      ) as AtomCommandResult<never, unknown>,
    );
    expect(refused).toMatchObject({ _tag: "refused", moved: true });
    expect(
      kinDocRestoreOutcome(
        AsyncResult.failure(Cause.fail(new Error("offline"))) as AtomCommandResult<never, unknown>,
      ),
    ).toMatchObject({ _tag: "refused", moved: false });
  });
});

describe("createKinSearch", () => {
  it("keeps only the latest words' answer", async () => {
    const states: Array<KinSearchState> = [];
    const waiting: Array<{
      readonly text: string;
      readonly answer: (result: AtomCommandResult<KinSearchResult, unknown>) => void;
    }> = [];
    const timers: Array<() => void> = [];
    const search = createKinSearch({
      read: ({ text }) => new Promise((answer) => waiting.push({ text, answer })),
      onChange: (state) => states.push(state),
      schedule: (run) => {
        timers.push(run);
        return () => timers.splice(timers.indexOf(run), 1);
      },
    });
    const hit = (key: string): KinSearchResult => ({
      hits: [
        {
          recordId: KinRecordId.make(key),
          key,
          kind: "docs",
          title: key,
          snippet: "",
          sensitive: false,
          closed: false,
          updatedAt: version().at,
        },
      ],
      indexed: true,
      asOf: version().at,
    });
    search.setText("lau");
    timers.shift()?.();
    search.setText("launch");
    timers.shift()?.();
    expect(waiting.map((held) => held.text)).toEqual(["lau", "launch"]);
    waiting[1]!.answer(AsyncResult.success(hit("D-2")));
    await Promise.resolve();
    waiting[0]!.answer(AsyncResult.success(hit("D-1")));
    await Promise.resolve();
    expect(states.at(-1)).toMatchObject({ answered: "launch", loading: false });
    expect(states.at(-1)?.hits?.map((held) => held.key)).toEqual(["D-2"]);
    search.setText("  ");
    expect(states.at(-1)).toMatchObject({ hits: null, loading: false });
  });
});
