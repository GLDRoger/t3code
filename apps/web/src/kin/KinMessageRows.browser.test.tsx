import { buildKinFeedRows } from "@t3tools/client-runtime/kin/kinChatFeed";
import { makeKinFixtureMessages } from "@t3tools/client-runtime/kin/kinChatFixtures";
import { EnvironmentId, KinMessageId, KinPersonId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { KinMessageRow } from "./KinMessageRows";

// Ambermill, invented: Zoya's morning page, as Kin writes it at 08:00 her time.
const zoya = KinPersonId.make("ambermill-zoya");
const page8 = {
  ...makeKinFixtureMessages(1)[0]!,
  messageId: KinMessageId.make("kin-holder-morning-1"),
  author: { _tag: "system" },
  kind: "system",
  form: "brief",
  widgetId: null,
  createdAt: new Date(2026, 10, 23, 8).toISOString(),
  body: [
    "Clients:",
    "- Follow-ups today: 1.",
    "- Corran rollout for Corran Tiles has no next step.",
    "",
    "Coming up:",
    "- Juniper launch for Juniper Loom is expected by Mon 23 Nov.",
  ].join("\n"),
} as const;

describe("Kin's morning page in a chat", () => {
  it("reads Good morning, Zoya over real headings and lists, never ## or hyphens", async () => {
    const [row] = buildKinFeedRows(
      [page8],
      { personId: zoya, agentNames: new Map() },
      new Set(),
    ).filter((one) => one.type === "message");
    expect(row?.type).toBe("message");
    if (row?.type !== "message") return;
    await using _screen = await render(
      <KinMessageRow
        row={row}
        head={null}
        direct
        widget={undefined}
        environmentId={EnvironmentId.make("env-1")}
        orgId="ambermill"
        viewerPersonId={zoya}
        heldFor={null}
        reactions={[]}
        onReact={null}
        previewKey="page"
        firstName="Zoya"
        connected
      />,
    );
    await expect
      .element(page.getByRole("heading", { level: 2, name: "Good morning, Zoya" }))
      .toBeVisible();
    expect(
      page
        .getByRole("heading", { level: 3 })
        .elements()
        .map((heading) => heading.textContent),
    ).toEqual(["Clients", "Coming up"]);
    await expect
      .element(
        page
          .getByRole("listitem")
          .filter({ hasText: "Corran rollout for Corran Tiles has no next step." }),
      )
      .toBeVisible();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("##");
    expect(text).not.toContain("- Corran");
    expect(text).not.toContain("Clients:");
  });
});
