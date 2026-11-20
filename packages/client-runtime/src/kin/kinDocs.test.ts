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
  KIN_DOCS,
  kinDocChangeLine,
  kinDocPieces,
  kinSearchHit,
  KIN_DOCS_DEFAULT_FILTER,
  kinDocFileDraft,
  kinDocFileInput,
  kinDocLibrary,
  kinDocsChip,
  kinDocsQuery,
  kinDocRef,
  kinDocRefLabel,
  kinDocRestoreOutcome,
  kinDocSections,
  kinDocRow,
  kinWhatWeSellAgent,
  kinWhatWeSellShown,
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
    const hitInput = {
      recordId: KinRecordId.make("d1"),
      key: "D-1",
      kind: "docs" as const,
      title: "Launch plan",
      snippet:
        "…to everyone ## Risks - [x] Tins **late** | Box | Price | | :-- | --: | see [the brief](https://example.invalid)…",
      section: { id: "risks", title: "Risks" },
      sensitive: false,
      closed: false,
      updatedAt: version().at,
    };
    const hit = kinSearchHit(hitInput);
    expect(hit.snippet).toBe("…to everyone Risks · Tins late Box Price see the brief…");
    // A hit on the title alone has no words to add.
    expect(
      kinSearchHit({ ...hitInput, title: "Booking app", snippet: "Booking app" }).snippet,
    ).toBeNull();
    // A deal comes back among entries, under its own name, so an older app opens it as one.
    expect(kinSearchHit({ ...hitInput, key: "DL-4", kind: "work" }).kindLabel).toBe("Deal");
    // A contact carries its client, whose page opens for it; an older host sends none.
    expect(hit.clientKey).toBeNull();
    expect(
      kinSearchHit({ ...hitInput, key: "CT-2", kind: "contacts", clientKey: "C-1" }).clientKey,
    ).toBe("C-1");
  });
});

describe("kinDocLibrary", () => {
  it("files docs by home: clients latest first with their projects, then Company, then Unfiled", () => {
    const acme = { recordId: KinRecordId.make("c1"), key: "C-1", title: "Acme" };
    const zed = { recordId: KinRecordId.make("c2"), key: "C-2", title: "Zed" };
    const loose = { recordId: KinRecordId.make("p9"), key: "P-9", title: "Loose project" };
    const at = (day: number) => new Date(2026, 10, day).toISOString();
    const library = kinDocLibrary([
      row("D-1", { updatedAt: at(1) }),
      row("D-2", { party: zed, updatedAt: at(2) }),
      row("D-3", { party: acme, updatedAt: at(3) }),
      row("D-4", { party: zed, updatedAt: at(9) }),
      row("D-5", { company: true, kind: "playbook", updatedAt: at(4) }),
      row("D-6", { project: loose, updatedAt: at(5) }),
      row("D-7", { company: true, updatedAt: at(8) }),
    ]);
    expect(library.homes.map((home) => [home.title, home.rows.map((held) => held.key)])).toEqual([
      ["Zed", ["D-4", "D-2"]],
      ["No client", ["D-6"]],
      ["Acme", ["D-3"]],
      ["Company", ["D-7"]],
      ["Unfiled", ["D-1"]],
    ]);
    // The playbooks fold into one row of their own.
    expect(library.playbooks.map((held) => held.key)).toEqual(["D-5"]);
    // Seven docs read fine by home; the recent strip only repeats them.
    expect(library.recent).toEqual([]);
    const many = Array.from({ length: 13 }, (_, index) =>
      row(`D-${index + 1}`, { updatedAt: at(index + 1) }),
    );
    expect(kinDocLibrary(many).recent.map((held) => held.key)).toEqual([
      "D-13",
      "D-12",
      "D-11",
      "D-10",
    ]);
  });

  it("pins What we sell first in Company, from its own read or the page, once, reading like any doc", () => {
    const at = (day: number) => new Date(2026, 10, day).toISOString();
    const sells = row("D-9", {
      title: "What we sell",
      company: true,
      updatedAt: at(1),
      whatWeSell: true,
    });
    const page = [
      row("D-7", { company: true, updatedAt: at(8) }),
      row("D-8", { company: true, updatedAt: at(9) }),
    ];
    const company = (library: ReturnType<typeof kinDocLibrary>) =>
      library.homes.find((home) => home.kind === "company")?.rows.map((held) => held.key);
    // Read on its own, as the page may not hold it; and the page's own copy shows once.
    expect(company(kinDocLibrary(page, sells))).toEqual(["D-9", "D-8", "D-7"]);
    expect(company(kinDocLibrary([...page, sells], sells))).toEqual(["D-9", "D-8", "D-7"]);
    expect(company(kinDocLibrary([...page, sells]))).toEqual(["D-9", "D-8", "D-7"]);
    const changed = { ...sells, latest: version({ summary: "Added the single-site start" }) };
    const view = kinDocRow(changed, names, now);
    const { whatWeSell: _pin, ...unpinned } = changed;
    const plain = kinDocRow(unpinned, names, now);
    // No count Kin can't vouch for: what last changed and who, as any doc, plus Pinned.
    expect(view.pinned).toBe(true);
    expect(view.line).toBe(plain.line);
    expect(view.line).toMatch(/^Updated today .* by Growth · Added the single-site start$/);
    expect(view.accessibilityLabel).toBe(
      plain.accessibilityLabel.replace(/^What we sell\. /, "What we sell. Pinned. "),
    );
    expect(kinDocRow(page[0]!, names, now).pinned).toBe(false);
    // Pinned, or offered when missing, only where the company's current docs show.
    expect(kinWhatWeSellShown(KIN_DOCS_DEFAULT_FILTER)).toBe(true);
    expect(kinWhatWeSellShown({ ...KIN_DOCS_DEFAULT_FILTER, show: { _tag: "company" } })).toBe(
      true,
    );
    expect(kinWhatWeSellShown({ ...KIN_DOCS_DEFAULT_FILTER, archived: true })).toBe(false);
    expect(kinWhatWeSellShown({ ...KIN_DOCS_DEFAULT_FILTER, text: "price" })).toBe(false);
    expect(
      kinWhatWeSellShown({ ...KIN_DOCS_DEFAULT_FILTER, show: { _tag: "kind", kind: "playbook" } }),
    ).toBe(false);
  });

  it("opens What we sell's ways in with the agent the host makes its keeper", () => {
    const lead = (agentId: string, domain: string, retired?: true) => ({
      agentId,
      domain,
      name: agentId,
      ...(retired ? { retired } : {}),
    });
    expect(
      kinWhatWeSellAgent([lead("b", "chief-of-staff"), lead("c", "growth"), lead("a", "finance")])
        ?.agentId,
    ).toBe("c");
    expect(
      kinWhatWeSellAgent([lead("c", "growth", true), lead("b", "chief-of-staff")])?.agentId,
    ).toBe("b");
    expect(kinWhatWeSellAgent([lead("z", "finance"), lead("y", "social")])?.agentId).toBe("y");
    expect(kinWhatWeSellAgent([])).toBeNull();
  });

  it("asks the host for one shelf at a time and leaves made files out unless asked", () => {
    const orgId = "org" as Parameters<typeof kinDocsQuery>[0];
    const filter = { ...KIN_DOCS_DEFAULT_FILTER, text: " plan " };
    expect(kinDocsQuery(orgId, filter)).toEqual({
      orgId,
      archived: false,
      text: "plan",
      files: false,
    });
    expect(
      kinDocsQuery(orgId, { ...filter, show: { _tag: "kind", kind: "playbook" } }),
    ).toMatchObject({ kind: "playbook", files: false });
    expect(kinDocsQuery(orgId, { ...filter, show: { _tag: "unfiled" } })).toMatchObject({
      home: "unfiled",
    });
    expect(kinDocsQuery(orgId, { ...filter, show: { _tag: "files" } })).toMatchObject({
      files: true,
    });
    expect(kinDocsChip(KIN_DOCS_DEFAULT_FILTER)).toBeNull();
    expect(
      kinDocsChip({ ...KIN_DOCS_DEFAULT_FILTER, archived: true, show: { _tag: "company" } }),
    ).toBe("Company · Archived");
  });

  it("files a doc under a client, the company, or nowhere", () => {
    const orgId = "org" as Parameters<typeof kinDocFileInput>[0];
    const doc = row("D-1", { rev: 4 });
    expect(kinDocFileDraft(doc)).toEqual({ kind: "other", home: "none", project: null });
    expect(
      kinDocFileInput(orgId, doc, { kind: "policy", home: "company", project: "P-1" }),
    ).toEqual({ orgId, key: "D-1", rev: 4, kind: "policy", company: true });
    expect(kinDocFileInput(orgId, doc, { kind: "quote", home: "C-1", project: null })).toEqual({
      orgId,
      key: "D-1",
      rev: 4,
      kind: "quote",
      company: false,
      party: "C-1",
      project: null,
    });
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

describe("kinDocPieces", () => {
  const visual = (title: string, attachmentId: string) =>
    ({ _tag: "visual", title, attachmentId, height: 240 }) as const;
  const body = [
    "# Funnel",
    "```kin_visual Funnel",
    "<p>a</p>",
    "```",
    "# Signups",
    "Before.",
    "```kin_chart",
    "{}",
    "```",
    "```kin_visual Trend",
    "<p>b</p>",
    "```",
    "After.",
  ].join("\n");
  const section = body.split("# Signups")[1]!;

  it("gives a section's blocks the embeds the host drew for them in the whole body", () => {
    const doc = {
      body,
      embeds: [
        visual("Funnel", "page-a"),
        { _tag: "broken", message: "Bad JSON." } as const,
        visual("Trend", "page-b"),
      ],
    };
    expect(kinDocPieces(section, doc)).toEqual([
      { type: "text", text: "\nBefore." },
      { type: "embed", embed: { _tag: "broken", message: "Bad JSON." } },
      { type: "embed", embed: visual("Trend", "page-b") },
      { type: "text", text: "After." },
    ]);
  });

  it("says a block can't be shown when the host drew nothing, or the wrong kind, for it", () => {
    const undrawn = (kind: "chart" | "visual") => ({
      type: "embed",
      embed: { _tag: "broken", message: KIN_DOCS.undrawn[kind] },
    });
    expect(kinDocPieces(section, { body }).filter((piece) => piece.type === "embed")).toEqual([
      undrawn("chart"),
      undrawn("visual"),
    ]);
    const shifted = { body, embeds: [visual("Funnel", "page-a"), visual("Trend", "page-b")] };
    expect(kinDocPieces(section, shifted).filter((piece) => piece.type === "embed")).toEqual([
      undrawn("chart"),
      undrawn("visual"),
    ]);
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
    const playbook = "D-4: chase invoice after days must be 1 to 120 days; nothing was changed.";
    expect(
      kinDocRestoreOutcome(
        AsyncResult.failure(
          Cause.fail(new KinChatError({ reason: "invalid_state", message: playbook })),
        ) as AtomCommandResult<never, unknown>,
      ),
    ).toMatchObject({ _tag: "refused", text: playbook });
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
