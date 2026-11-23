import { EnvironmentId, KinOrgId, KinPersonId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

// Ambermill, invented: Rhea's Chief of staff waits on her for a post, then a proposal, in one chat.
const fixture = vi.hoisted(() => {
  const waiting = (waitingId: string, messageId: string, question: string, at: string) => ({
    waitingId,
    orgId: "org-ambermill",
    personId: "rhea",
    chatId: "chat-chief",
    messageId,
    widgetId: `widget-${waitingId}`,
    reason: "question",
    question,
    createdAt: at,
    resolvedAt: null,
    resolution: null,
  });
  return {
    host: {
      _tag: "host",
      environmentId: "env-ambermill",
      connected: true,
      probe: {
        _tag: "ready",
        orgs: {
          orgs: [
            {
              orgId: "org-ambermill",
              agents: [{ agentId: "agent-chief", displayName: "Chief of staff", retired: false }],
            },
          ],
          me: [{ orgId: "org-ambermill", personId: "rhea" }],
        },
      },
    },
    waiting: [
      waiting("w-post", "msg-post", "Approve this post?", "2026-11-20T06:23:00.000Z"),
      waiting("w-proposal", "msg-proposal", "Approve this proposal?", "2026-11-20T06:25:00.000Z"),
    ],
  };
});
vi.mock(import("./useKinHost"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinInbox: () =>
    ({
      host: fixture.host,
      state: {
        _tag: "ready",
        environmentId: "env-ambermill",
        inbox: { value: { chats: [], waiting: fixture.waiting } },
      },
      retry: () => {},
    }) as never,
}));
vi.mock(import("./useKinMoney"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinMoneySummary: (() => ({ state: { _tag: "loading" } })) as never,
  useKinLists: (() => ({ state: { _tag: "loading" } })) as never,
}));
vi.mock(import("./useKinAttention"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinAttention: (() => null) as never,
  useKinAttentionHandle: (() => ({})) as never,
}));
vi.mock(import("./useKinOwnerLevel"), async (importOriginal) => ({
  ...(await importOriginal()),
  useKinOwnerLevel: () => true,
}));

import "~/index.css";
import { render } from "../../test/render";
import { KinNeedsYou } from "./KinNeedsYou";

describe("Needs you on the web", () => {
  it("opens the chat on the waiting row's own card, not the chat's newest", async () => {
    await using screen = await render(
      <KinNeedsYou
        environmentId={EnvironmentId.make("env-ambermill")}
        orgId={KinOrgId.make("org-ambermill")}
        directory={
          {
            names: {
              people: new Map(),
              agents: new Map(),
              me: KinPersonId.make("rhea"),
              owner: KinPersonId.make("rhea"),
              zone: "UTC",
            },
          } as never
        }
        mine={[]}
        onOpenTask={() => {}}
        onOpenList={() => {}}
        onOpenMoney={() => {}}
      />,
    );
    await userEvent.click(page.getByRole("button", { name: /Approve this post\?/ }));
    await vi.waitFor(() =>
      expect(screen.router!.state.location.href).toBe(
        "/kin/env-ambermill/org-ambermill/chat-chief?message=msg-post",
      ),
    );
  });
});
