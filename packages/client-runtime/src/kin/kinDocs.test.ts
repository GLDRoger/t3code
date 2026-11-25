// @effect-diagnostics globalDate:off - Fixtures build ISO times relative to a fixed clock.
import {
  KinAgentId,
  KinChatError,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  KinRecordKey,
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
  kinDocChangeItem,
  kinDocChangeLine,
  kinDocCardDraft,
  kinDocCopyText,
  kinDocPieces,
  kinSearchHit,
  KIN_DOCS_DEFAULT_FILTER,
  kinDocFileDraft,
  kinDocFileInput,
  kinDocLibrary,
  kinDocsChip,
  kinDocsMine,
  kinDocsMineHeld,
  kinDocsQuery,
  kinDocRef,
  kinDocRefLabel,
  kinDocEditInput,
  kinDocEditOpen,
  kinDocEditOutcome,
  kinDocRestoreOutcome,
  kinDocSameWords,
  kinDocSections,
  kinDocRow,
  kinDocState,
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

describe("kinDocSameWords", () => {
  const file = (sha256: string, mimeType = "image/png") => ({ sha256, mimeType });
  type File = ReturnType<typeof file>;
  const diff = (from: { file?: File }, to: { file?: File }) => ({ from, to });

  it("says a new picture or file changed when the words read the same", () => {
    expect(kinDocSameWords(diff({ file: file("a") }, { file: file("b") })).title).toBe(
      "The picture changed",
    );
    expect(
      kinDocSameWords(
        diff({ file: file("a", "application/pdf") }, { file: file("b", "application/pdf") }),
      ).title,
    ).toBe("The file changed");
    expect(kinDocSameWords(diff({}, { file: file("b") })).title).toBe("The picture changed");
  });

  it("says nothing changed when the file is the same too", () => {
    expect(kinDocSameWords(diff({ file: file("a") }, { file: file("a") }))).toBe(
      KIN_DOCS.noChanges,
    );
    expect(kinDocSameWords(diff({}, {}))).toBe(KIN_DOCS.noChanges);
  });
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
      kinSearchHit({ ...hitInput, key: "CT-2", kind: "contacts", client: "C-1" }).clientKey,
    ).toBe("C-1");
  });
});

describe("kinDocsMine", () => {
  const ref = (key: string) => ({ recordId: KinRecordId.make(`rec-${key}`), key, title: key });
  const zoya = { _tag: "person", personId: KinPersonId.make("invented-zoya") } as const;
  const held = kinDocsMineHeld(
    zoya.personId,
    [
      { key: "C-1", owner: zoya },
      { key: "C-2", owner: me },
    ],
    [{ key: "P-1" }],
  );
  const rows = [
    row("D-1", { owner: zoya }),
    row("D-2", { party: ref("C-1") }),
    row("D-3", { project: ref("P-1") }),
    row("D-4", { party: ref("C-2") }),
    row("D-5", { project: ref("P-2"), owner: me }),
    row("D-6", { company: true }),
  ];

  it("is mine when I keep it, or it is on a client I look after or a project I lead or am on", () => {
    expect(kinDocsMine(rows, held, true).mine.map((one) => one.key)).toEqual(["D-1", "D-2", "D-3"]);
    // Whoever has no id yet has nothing of theirs.
    expect(kinDocsMine(rows, { ...held, me: null }, true).mine).toEqual([]);
  });

  it("counts both sides from the same rows, exactly only once the list holds every doc", () => {
    expect(kinDocsMine(rows, held, true).counts).toEqual({ mine: { n: 3 }, everyone: { n: 6 } });
    expect(kinDocsMine(rows, held, false).counts).toEqual({
      mine: { n: 3, atLeast: true },
      everyone: { n: 6, atLeast: true },
    });
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
    // Any agent the sales rules reach keeps it before the Chief of staff; a named seat stays first.
    expect(kinWhatWeSellAgent([lead("b", "chief-of-staff"), lead("d", "marketing")])?.agentId).toBe(
      "d",
    );
    expect(kinWhatWeSellAgent([lead("b", "chief-of-staff"), lead("e", "sales-ops")])?.agentId).toBe(
      "e",
    );
    expect(kinWhatWeSellAgent([lead("a", "marketing"), lead("c", "growth")])?.agentId).toBe("c");
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
    ).toBe("Company · Deleted");
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

describe("kinDocCopyText", () => {
  it("gives clean text: no marks, a list's items as lines, a table's rows as tab-separated cells", () => {
    const body = [
      "# Ambermill launch post",
      "",
      "We **finally** ship the _invented_ [planner](https://example.com/planner) on `Monday`.",
      "",
      "- Faster sync",
      "- [ ] Offline mode",
      "  1. On the phone",
      "",
      "3. Book the room",
      "4. Send the invite",
      "",
      "> Rhea: ~~maybe~~ yes.",
      "",
      "| Plan | Price |",
      "| --- | ---: |",
      "| Starter | 10 |",
      "| Team | *20* |",
      "",
      "```kin_chart",
      '{"type":"bar"}',
      "```",
      "",
      "---",
      "",
      "Read [the invented thread](t3-thread:abc) or https://example.com/faq.",
    ].join("\n");
    expect(kinDocCopyText(body)).toBe(
      [
        "Ambermill launch post",
        "",
        "We finally ship the invented planner (https://example.com/planner) on Monday.",
        "",
        "Faster sync\nOffline mode\n1. On the phone",
        "",
        "3. Book the room\n4. Send the invite",
        "",
        "Rhea: maybe yes.",
        "",
        "Plan\tPrice\nStarter\t10\nTeam\t20",
        "",
        "Read the invented thread or https://example.com/faq.",
      ].join("\n"),
    );
    // What a mail keeps besides (`listMarks`) leaves Copy text as it was.
    const extras = [
      "Write to [billing](mailto:billing@invented.example), call [the desk](tel:+10000000000), or",
      "<billing@invented.example>; see [the terms][terms].[^1] Quote your <PO number>, <b>please</b>.",
      "",
      "[terms]: https://invented.example/terms",
      "",
      "[^1]: Prices hold for 30 days.",
    ].join("\n");
    expect(kinDocCopyText(extras)).toBe(
      "Write to billing, call the desk, or\nbilling@invented.example; see . Quote your , please.",
    );
  });

  // A draft's card copies the same clean text, and offers Send to only to the teammate it's for.
  it("a draft card: Copy text for all, Send to only for its teammate until sent", () => {
    const rhea = { personId: KinPersonId.make("rhea"), name: "Rhea" };
    const draft = {
      kind: "post" as const,
      text: "## Teaser\n\n**Soon** at _Harbourline_.\n",
      sendTo: rhea,
      noAccount: { service: "Instagram", by: rhea },
    };
    const teammate = kinDocCardDraft({ key: "D-4", draft }, false, false);
    expect(teammate).toEqual({
      copyText: "Teaser\n\nSoon at Harbourline.",
      sendTo: "Send to Rhea",
      sent: null,
      noAccount: "No Instagram account is connected. Rhea can connect one on their computer.",
    });
    expect(kinDocCardDraft({ key: "D-4", draft }, true, false)).toEqual({
      ...teammate,
      sendTo: null,
      noAccount:
        "No Instagram account is connected. You can connect one in Settings on your computer.",
    });
    const sent = { ...draft, sent: { name: "Rhea", at: "2026-11-16T06:00:00.000Z" } };
    expect(kinDocCardDraft({ key: "D-4", draft: sent }, false, false)).toMatchObject({
      sendTo: null,
      sent: "Sent to Rhea to approve.",
    });
    const { sendTo: _sendTo, ...ownersOwn } = draft;
    expect(kinDocCardDraft({ key: "D-4", draft: ownersOwn }, true, false)?.sendTo).toBeNull();
    // A chat she may only read takes no send from her, so the card offers none.
    expect(kinDocCardDraft({ key: "D-4", draft }, false, true)?.sendTo).toBeNull();
    // Waiting for the owner to be back, it says so rather than that it reached them.
    const held = { ...draft, sent: { ...sent.sent, held: true as const } };
    expect(kinDocCardDraft({ key: "D-4", draft: held }, false, false)?.sent).toBe(
      "Sent. Rhea gets it to approve when they're back.",
    );
    // The owner asked for changes first: sendable again, and it says why; sent again, it says so.
    const changesFirst = { name: "Rhea", at: "2026-11-16T07:00:00.000Z" };
    expect(
      kinDocCardDraft({ key: "D-4", draft: { ...draft, changesFirst } }, false, false),
    ).toMatchObject({
      sendTo: "Send to Rhea",
      sent: "Rhea asked for changes first.",
    });
    expect(
      kinDocCardDraft({ key: "D-4", draft: { ...sent, changesFirst } }, false, false),
    ).toMatchObject({
      sendTo: null,
      sent: "Sent to Rhea to approve.",
    });
    expect(kinDocCardDraft({ key: "D-4", draft: null }, false, false)).toBeNull();
    // A long draft's card holds its opening: it says so, and Copy text fetches its version; from
    // an older host the same text is a short draft's. Changed after it went up, it may go again.
    // Its text ends with a line for older clients, which read it as the whole draft; this one
    // says so in its own line instead, and copies none of it.
    const opening = `${draft.text}\n\nThis is only the opening. Open D-4 to read the whole draft.`;
    const long = { ...draft, text: opening, whole: { version: 3, chars: 6200 } };
    expect(kinDocCardDraft({ key: "D-4", draft: long }, false, false)).toEqual({
      ...teammate,
      long: { line: "A long draft. Open it to read all of it.", version: 3 },
    });
    const { whole: _whole, ...older } = long;
    expect(kinDocCardDraft({ key: "D-4", draft: older }, false, false)?.copyText).toBe(
      `${teammate!.copyText}\n\nThis is only the opening. Open D-4 to read the whole draft.`,
    );
    const changed = { at: "2026-11-16T08:00:00.000Z" };
    expect(
      kinDocCardDraft({ key: "D-4", draft: { ...long, changesFirst, changed } }, false, false),
    ).toMatchObject({
      sendTo: "Send to Rhea",
      sent: "It changed after it was sent, so it wasn't approved. Send it again.",
    });
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

describe("kinDocChangeItem", () => {
  it.each([
    ["the owner level, on a doc it may change", true, true, "hand", KIN_DOCS.change],
    ["a lead, on their project's doc", true, false, "hand", KIN_DOCS.change],
    ["the owner level, on an older version", false, true, "agent", KIN_DOCS.change],
    ["a lead, on a playbook", false, false, "agent", KIN_DOCS.suggest],
    ["a member", false, false, "agent", KIN_DOCS.suggest],
  ] as const)("%s: one Change item", (_who, byHand, ownerLevel, by, label) => {
    expect(kinDocChangeItem({ byHand, ownerLevel })).toEqual({ by, label });
  });
});

describe("kinDocEditOpen", () => {
  const read = (pricing: string, timeline: string) => ({
    key: KinRecordKey.make("D-3"),
    body: `## Pricing\n\n${pricing}\n\n## Timeline\n\n${timeline}\n`,
    outline: [
      { id: "pricing", title: "Pricing", level: 2, chars: 20, hash: `p:${pricing}` },
      { id: "timeline", title: "Timeline", level: 2, chars: 20, hash: `t:${timeline}` },
    ],
  });
  const orgId = KinOrgId.make("org");

  it("saves against the section as opened, whatever version arrives while the editor is open", () => {
    const v1 = read("Starter is 10.", "Launch on the 10th.");
    const opened = kinDocEditOpen(v1, "pricing")!;
    expect(opened).toEqual({
      key: "D-3",
      section: "pricing",
      title: "Pricing",
      hash: "p:Starter is 10.",
      was: "## Pricing\n\nStarter is 10.\n",
    });
    // The same section changes underneath: the save still names version 1's text, so the host
    // refuses it rather than write the older draft over the newer change.
    const sameChanged = read("Starter is 12.", "Launch on the 10th.");
    expect(kinDocEditOpen(sameChanged, "pricing")!.hash).toBe("p:Starter is 12.");
    expect(kinDocEditInput(orgId, opened, "Starter is 11.", "r-1")).toEqual({
      orgId,
      key: "D-3",
      section: "pricing",
      hash: "p:Starter is 10.",
      text: "Starter is 11.",
      clientRequestId: "r-1",
    });
    // Another section changes underneath: the hash sent is still the section's own, which holds.
    const otherChanged = read("Starter is 10.", "Launch on the 20th.");
    expect(kinDocEditInput(orgId, opened, "Starter is 11.", "r-1").hash).toBe(
      kinDocEditOpen(otherChanged, "pricing")!.hash,
    );
    expect(kinDocEditOpen(v1, "missing")).toBeNull();
  });
});

describe("kinDocEditOutcome", () => {
  it("says a newer change to the section refused the edit, in its own words", () => {
    const failed = (reason: "conflict" | "not_allowed", message: string) =>
      kinDocEditOutcome(
        AsyncResult.failure(Cause.fail(new KinChatError({ reason, message }))) as AtomCommandResult<
          never,
          unknown
        >,
      );
    expect(failed("conflict", "Section pricing changed, hash 9f")).toEqual({
      _tag: "refused",
      moved: true,
      text: KIN_DOCS.editMoved,
    });
    const refusal = "Only the owner, a co-owner or the project's lead can change this doc by hand.";
    expect(failed("not_allowed", refusal)).toEqual({
      _tag: "refused",
      moved: false,
      text: refusal,
    });
  });
});

describe("kinDocState", () => {
  it("reads the reader's own draft an owner kept to owners only as private now, any other as gone", () => {
    const missing = (patch: { readonly privateNow?: { readonly by: string } }) =>
      kinDocState(
        AsyncResult.failure(
          Cause.fail(new KinChatError({ reason: "not_found", message: "D-31", ...patch })),
        ),
      );
    expect(missing({ privateNow: { by: "Rhea" } })).toEqual({ _tag: "private", by: "Rhea" });
    expect(missing({})).toEqual({ _tag: "gone" });
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
