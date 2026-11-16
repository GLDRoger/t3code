import {
  KIN_SOCIAL_WEEK_CARD,
  KinChatId,
  KinMessageId,
  KinOrgId,
  KinWidgetId,
  type KinSocialCardPost,
  type KinSocialWeekCard,
  type KinWidget,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { kinSocialPostActions, kinSocialRows, kinSocialWeekView } from "./kinSocial.ts";

const account = {
  accountId: "acc_1",
  platform: "instagram" as const,
  name: "Invented Co",
  handle: "inventedco",
  problem: null,
};
const post = (postId: string, state: KinSocialCardPost["state"], undoUntil: string | null = null) =>
  ({
    postId,
    account,
    caption: `Post ${postId} 🚀`,
    media: null,
    at: "2026-11-18T13:30:00.000Z",
    when: "Wed 18 Nov · 7:00 pm",
    state,
    url: null,
    reason: null,
    undoUntil,
  }) satisfies KinSocialCardPost;

const widget = (card: Partial<KinSocialWeekCard>): KinWidget => ({
  orgId: KinOrgId.make("org"),
  chatId: KinChatId.make("chat"),
  messageId: KinMessageId.make("msg"),
  widgetId: KinWidgetId.make("kin-social:g:1"),
  widgetClass: "native",
  type: KIN_SOCIAL_WEEK_CARD,
  revision: 3,
  state: {
    text: "Posts",
    groupId: "g",
    group: { kind: "client", label: "Lumen Studio" },
    title: "Lumen Studio: 2 posts",
    posts: [post("a", "proposed"), post("b", "removed")],
    digest: "d1",
    confirmedAt: null,
    clientReview: { ok: false, notedAt: null, preview: null, making: false },
    replaced: false,
    ...card,
  },
  source: null,
  feed: null,
  awaiting: [],
  pinnedAt: null,
  closedAt: null,
  updatedAt: "2026-11-16T09:00:00.000Z",
});

describe("kinSocialWeekView", () => {
  it("confirms only the posts left, and a client's only after his OK", () => {
    const waiting = kinSocialWeekView(widget({}))!;
    expect(waiting.confirm).toEqual({ label: "Confirm 1 post", digest: "d1", ready: false });
    expect(waiting.posts.map((one) => one.actions)).toEqual([["remove"], []]);
    const ok = kinSocialWeekView(
      widget({ clientReview: { ok: true, notedAt: null, preview: null, making: false } }),
    )!;
    expect(ok.confirm?.ready).toBe(true);
    expect(kinSocialWeekView(widget({ replaced: true }))!.confirm).toBeNull();
  });

  it("offers Undo only until it stops cancelling the post, and Retry on a failure", () => {
    const view = kinSocialWeekView(
      widget({
        confirmedAt: "2026-11-16T09:00:00.000Z",
        digest: null,
        posts: [post("a", "scheduled", "2026-11-18T13:25:00.000Z"), post("b", "failed")],
      }),
    )!;
    expect(view.confirm).toBeNull();
    expect(view.status).toBe("1 scheduled · 1 failed");
    const [scheduled, failed] = view.posts;
    expect(kinSocialPostActions(scheduled!, Date.parse("2026-11-18T13:20:00.000Z"))).toEqual([
      "undo",
    ]);
    expect(kinSocialPostActions(scheduled!, Date.parse("2026-11-18T13:25:00.000Z"))).toEqual([]);
    expect(kinSocialPostActions(failed!, 0)).toEqual(["retry"]);
  });
});

describe("kinSocialRows", () => {
  it("says what is broken and how to fix it", () => {
    const base = {
      groupId: "g",
      kind: "own" as const,
      clientId: null,
      label: "Our own",
      service: "Zernio",
      profileName: "Invented Co",
      checkedAt: null,
      connectedAt: "2026-11-16T09:00:00.000Z",
    };
    const view = {
      orgId: KinOrgId.make("org"),
      clients: [],
      ownFree: false,
      service: { label: "Zernio", keyUrl: "https://zernio.com", setup: "" },
      groups: [
        { ...base, problem: "The key was revoked.", accounts: [account] },
        {
          ...base,
          groupId: "h",
          problem: null,
          accounts: [{ ...account, problem: "Instagram needs reconnecting." }],
        },
      ],
    };
    expect(kinSocialRows(view).map((row) => [row.tone, row.label, row.detail])).toEqual([
      ["error", "Needs a new key", "The key was revoked."],
      [
        "attention",
        "An account needs reconnecting",
        "Invented Co in Zernio. Send a connect link for Instagram to reconnect.",
      ],
    ]);
  });
});
