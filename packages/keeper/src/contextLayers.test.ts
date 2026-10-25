import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  GENERATED_MAP_MARKER,
  generateHouseMaps,
  houseMapRelativePath,
  parseHousesTsv,
  renderHouseMap,
} from "./agentMap.ts";
import { renderBriefSlot } from "./briefSlot.ts";
import { formatChronicle, type KeeperEntry } from "./chronicle.ts";
import { CLAUDE_MD_IMPORT, KIN_INIT_USAGE, initKinProject } from "./init.ts";
import { makeInMemoryNotesBoard, renderNotesBoard } from "./notesBoard.ts";
import { hashOwnerRules, loadOwnerRules, renderOwnerRules } from "./ownerRules.ts";

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer);
const T0 = "2026-10-24T12:00:00.000Z";
const now = DateTime.makeUnsafe(T0);

const will = (id: string, at: string, body: string): KeeperEntry => ({
  id,
  kind: "will",
  at,
  body,
});

describe("kin init", () => {
  it.effect("writes the Claude import, owner rules, and a missing AGENTS stub", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "kin-init-" });
      const first = yield* initKinProject({ projectRoot: root });
      expect(KIN_INIT_USAGE).toBe("kin init");
      expect(first.claudeMd).toBe("created");
      expect(first.created).toEqual(["AGENTS.md", "CLAUDE.md", ".kin/owner-rules.md"]);
      expect(yield* fs.readFileString(path.join(root, "CLAUDE.md"))).toBe(CLAUDE_MD_IMPORT);
      expect(yield* fs.readFileString(path.join(root, "AGENTS.md"))).toContain("docs/agent-maps");
      const second = yield* initKinProject({ projectRoot: root });
      expect(second.created).toEqual([]);
      expect(second.claudeMd).toBe("already-import");
    }).pipe(Effect.provide(platform)),
  );

  it.effect("leaves an existing AGENTS.md and a custom CLAUDE.md in place", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "kin-init-" });
      yield* fs.writeFileString(path.join(root, "AGENTS.md"), "# Keep me\n");
      yield* fs.writeFileString(path.join(root, "CLAUDE.md"), "# Not an import\n");
      const result = yield* initKinProject({ projectRoot: root });
      expect(result.claudeMd).toBe("left-in-place");
      expect(yield* fs.readFileString(path.join(root, "AGENTS.md"))).toBe("# Keep me\n");
      expect(yield* fs.readFileString(path.join(root, "CLAUDE.md"))).toBe("# Not an import\n");
    }).pipe(Effect.provide(platform)),
  );

  it.effect("imports a legacy owner-rules file without deleting it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "kin-init-" });
      const legacy = "Never compact these rules away.\n";
      yield* fs.writeFileString(path.join(root, "OWNER-AUTHORIZATION.md"), legacy);
      const result = yield* initKinProject({ projectRoot: root });
      expect(result.imported).toEqual(["OWNER-AUTHORIZATION.md"]);
      const rules = yield* fs.readFileString(path.join(root, ".kin", "owner-rules.md"));
      expect(rules).toContain(legacy.trim());
      expect(yield* fs.readFileString(path.join(root, "OWNER-AUTHORIZATION.md"))).toBe(legacy);
    }).pipe(Effect.provide(platform)),
  );

  it.effect("treats a one-line import without a trailing newline as already set", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "kin-init-" });
      yield* fs.writeFileString(path.join(root, "CLAUDE.md"), "@AGENTS.md");
      const result = yield* initKinProject({ projectRoot: root });
      expect(result.claudeMd).toBe("already-import");
      expect(yield* fs.readFileString(path.join(root, "CLAUDE.md"))).toBe("@AGENTS.md");
    }).pipe(Effect.provide(platform)),
  );
});

describe("house agent maps", () => {
  it("parses houses.tsv and renders a stable map with no clock", () => {
    const rows = parseHousesTsv(
      "# comment\n\napps/web/**\tweb-ui\napps/server/**\tserver-orchestration\n",
    );
    expect(rows).toEqual([
      { pattern: "apps/web/**", house: "web-ui" },
      { pattern: "apps/server/**", house: "server-orchestration" },
    ]);
    const rendered = renderHouseMap({
      house: "web-ui",
      patterns: ["apps/web/**", "apps/web/src/**"],
      invariants: ["the shell stays dumb"],
      traps: ["do not restyle ui primitives"],
    });
    expect(rendered).toBe(
      renderHouseMap({
        house: "web-ui",
        patterns: ["apps/web/src/**", "apps/web/**"],
        invariants: ["the shell stays dumb"],
        traps: ["do not restyle ui primitives"],
      }),
    );
    expect(rendered).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
    expect(rendered.startsWith(GENERATED_MAP_MARKER)).toBe(true);
    expect(houseMapRelativePath("web-ui")).toBe("docs/agent-maps/web-ui.md");
  });

  it.effect("generates maps from houses.tsv and leaves hand-written maps alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "kin-maps-" });
      yield* fs.makeDirectory(path.join(root, ".kin", "house-maps"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, ".kin", "houses.tsv"),
        "apps/web/**\tweb-ui\napps/server/**\tweb-ui\n../etc\t../nope\n",
      );
      yield* fs.writeFileString(
        path.join(root, ".kin", "house-maps", "web-ui.md"),
        "## Invariants\n- lists stay windowed\n\n## Traps\n- no layout animation\n",
      );
      const hand = path.join(root, "docs", "agent-maps", "web-ui.md");
      yield* fs.makeDirectory(path.dirname(hand), { recursive: true });
      yield* fs.writeFileString(hand, "# handwritten\n");

      const skipped = yield* generateHouseMaps({ projectRoot: root });
      expect(skipped.rejected).toEqual(["../nope"]);
      expect(skipped.skipped).toEqual(["docs/agent-maps/web-ui.md"]);
      expect(yield* fs.readFileString(hand)).toBe("# handwritten\n");

      const written = yield* generateHouseMaps({ projectRoot: root, force: true });
      expect(written.written).toEqual(["docs/agent-maps/web-ui.md"]);
      const map = yield* fs.readFileString(hand);
      expect(map).toContain("lists stay windowed");
      expect(map).toContain("no layout animation");
      expect(map).toContain("`apps/server/**`");
      expect(map).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
      const again = yield* generateHouseMaps({ projectRoot: root, force: true });
      expect(again.unchanged).toEqual(["docs/agent-maps/web-ui.md"]);
      expect(yield* fs.readFileString(hand)).toBe(map);
    }).pipe(Effect.provide(platform)),
  );
});

describe("owner rules", () => {
  it.effect("loads project and global files and hashes the brief text", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "kin-rules-" });
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "kin-home-" });
      yield* fs.makeDirectory(path.join(root, ".kin"), { recursive: true });
      const projectLine = "Prefer the smallest model that makes the behavior unsurprising.";
      const globalLine = "Do not widen a lane to chase a neighboring idea.";
      yield* fs.writeFileString(path.join(root, ".kin", "owner-rules.md"), `${projectLine}\n`);
      yield* fs.writeFileString(path.join(home, "OWNER-RULES.md"), `${globalLine}\n`);
      const loaded = yield* loadOwnerRules({ projectRoot: root, kinHome: home });
      expect(loaded.projectText).toContain(projectLine);
      expect(loaded.globalText).toContain(globalLine);
      // A case-insensitive volume (macOS default) finds the legacy file under the canonical name.
      const caseSensitive = !(yield* fs.exists(path.join(home, "owner-rules.md")));
      expect(loaded.importedFrom).toEqual(caseSensitive ? [path.join(home, "OWNER-RULES.md")] : []);
      const block = renderOwnerRules(loaded);
      expect(block).toContain(projectLine);
      expect(block).toContain(globalLine);
      const hash = yield* hashOwnerRules(block);
      expect(yield* hashOwnerRules(block)).toBe(hash);
      expect(yield* hashOwnerRules(`${block} `)).not.toBe(hash);
    }).pipe(Effect.provide(platform)),
  );
});

describe("notes board", () => {
  it.effect("filters by house, author, and time, and keeps bodies", () =>
    Effect.gen(function* () {
      const board = yield* makeInMemoryNotesBoard();
      yield* board.add({
        id: "n2",
        houseIds: ["web-ui"],
        author: "heir",
        body: "The list virtualizes.",
        at: "2026-10-24T12:05:00.000Z",
      });
      yield* board.add({
        id: "n1",
        houseIds: ["web-ui", "server-orchestration"],
        author: "author",
        body: "Crown before exit.",
        at: "2026-10-24T12:00:00.000Z",
        flaggedMisleading: true,
      });
      yield* board.add({
        id: "n3",
        houseIds: ["server-orchestration"],
        author: "author",
        body: "other house",
        at: "2026-10-24T12:06:00.000Z",
      });
      const house = yield* board.read({ house: "web-ui" });
      expect(house.map((note) => note.id)).toEqual(["n1", "n2"]);
      const since = yield* board.read({ house: "web-ui", since: "2026-10-24T12:00:00.000Z" });
      expect(since.map((note) => note.id)).toEqual(["n2"]);
      const author = yield* board.read({ author: "author", house: "web-ui" });
      expect(author.map((note) => note.id)).toEqual(["n1"]);
      const duplicate = yield* board
        .add({
          id: "n1",
          houseIds: ["web-ui"],
          author: "author",
          body: "again",
          at: "2026-10-24T12:07:00.000Z",
        })
        .pipe(Effect.flip);
      expect(duplicate._tag).toBe("DuplicateNoteError");
      expect(renderNotesBoard(house)).toContain("Crown before exit.");
      expect(renderNotesBoard(house)).toContain("flagged: misleading");
      expect(renderNotesBoard(house).indexOf("### n1")).toBeLessThan(
        renderNotesBoard(house).indexOf("### n2"),
      );
    }).pipe(Effect.provide(platform)),
  );
});

describe("brief slot", () => {
  const rules = renderOwnerRules({
    projectText: "Owner rule: do not summarize a summary.",
    globalText: "",
  });
  const houseMap = renderHouseMap({
    house: "web-ui",
    patterns: ["apps/web/**"],
    invariants: [],
    traps: [],
  });
  const chronicle = formatChronicle("2026-10-24T11:00:00.000Z", "Digest of the house.");
  const entries = [
    will("old", "2026-10-24T10:00:00.000Z", "already digested"),
    will("new", "2026-10-24T11:30:00.000Z", "Verbatim will body."),
  ];

  it("keeps owner rules, the map, and the chronicle stable, with the task last", () => {
    const notes = [
      {
        id: "n1",
        houseIds: ["web-ui"],
        author: "heir",
        body: "Note body stays.",
        at: "2026-10-24T11:40:00.000Z",
        flaggedMisleading: false,
      },
    ];
    const first = renderBriefSlot({
      house: "web-ui",
      ownerRules: rules,
      houseMap,
      chronicleText: chronicle,
      now,
      entries,
      notes,
      task: "Fix the list.",
    });
    const second = renderBriefSlot({
      house: "web-ui",
      ownerRules: rules,
      houseMap,
      chronicleText: chronicle,
      now: DateTime.makeUnsafe(DateTime.toEpochMillis(now) + 60_000),
      entries,
      notes,
      task: "A different task.",
    });
    const taskAt = (text: string) => text.indexOf("\n## Task\n");
    expect(first.slice(0, taskAt(first))).toBe(second.slice(0, taskAt(second)));
    expect(first.endsWith("## Task\n\nFix the list.")).toBe(true);
    expect(second.endsWith("## Task\n\nA different task.")).toBe(true);
    expect(first).toContain("Owner rule: do not summarize a summary.");
    expect(first).toContain("Digest of the house.");
    expect(first).toContain("Verbatim will body.");
    expect(first).not.toContain("already digested");
    expect(first).toContain("Note body stays.");
    expect(first).toContain("`docs/agent-maps/web-ui.md`");
    expect(first.indexOf("## Owner rules")).toBeLessThan(first.indexOf("## House map"));
    expect(first.indexOf("## House map")).toBeLessThan(first.indexOf("## Chronicle"));
    expect(first.indexOf("## Chronicle")).toBeLessThan(
      first.indexOf("## Wills since the chronicle"),
    );
    expect(first.indexOf("## Wills since the chronicle")).toBeLessThan(
      first.lastIndexOf("## Notes board"),
    );
    expect(first.lastIndexOf("## Notes board")).toBeLessThan(first.indexOf("## Task"));
  });

  it("drops a stale chronicle instead of appending wills against it", () => {
    const staleNow = DateTime.makeUnsafe(
      DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-24T11:00:00.000Z")) +
        12 * 60 * 60 * 1000 +
        1,
    );
    const text = renderBriefSlot({
      house: "web-ui",
      ownerRules: rules,
      houseMap,
      chronicleText: chronicle,
      now: staleNow,
      entries,
      notes: [],
      task: "Continue.",
    });
    expect(text).toContain("No fresh chronicle (stale).");
    expect(text).toContain("Owner rule: do not summarize a summary.");
    expect(text).not.toContain("Verbatim will body.");
    expect(text).not.toContain("Digest of the house.");
  });
});
