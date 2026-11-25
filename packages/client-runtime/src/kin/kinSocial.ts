import {
  KIN_SOCIAL_PACK_CARD,
  KIN_SOCIAL_PLATFORM_LABELS,
  KIN_SOCIAL_PLATFORMS,
  KIN_SOCIAL_WEEK_CARD,
  type KinChatError,
  KinConnectionKey,
  KinSocialPackCard,
  KinSocialWeekCard,
  type EnvironmentId,
  type KinOrgId,
  type KinSocialAccount,
  type KinSocialCardPost,
  type KinSocialCheck,
  type KinSocialCheckInput,
  type KinSocialConnectInput,
  type KinSocialGroup,
  type KinSocialGroupInput,
  type KinSocialLink,
  type KinSocialLinkInput,
  type KinSocialMedia,
  type KinSocialPackCardAction,
  type KinSocialPlatform,
  type KinSocialView,
  type KinSocialWeekCardAction,
  type KinWidget,
  type KinWidgetsActInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";

import { squashAtomCommandFailure, type AtomCommandResult } from "../state/runtime.ts";
import { kinFailureText } from "./kinAnswers.ts";
import type { KinConnectionTone } from "./kinConnections.ts";
import {
  createKinCardActions,
  kinActionFailureNotice,
  type KinCardNotice,
} from "./kinDeferralPresentation.ts";

/**
 * Settings → Connections → Social accounts, the weekly card and the ready-to-post pack. Web and
 * mobile draw what these return; the server builds every card from stored drafts.
 */
export const KIN_SOCIAL_COPY = {
  seePost: "See the post",
  saveFile: "Save the file",
  postPicture: (name: string) => `Picture for this post: ${name}`,
  accountsFor: (label: string) =>
    `In Kin, these become the accounts for ${label}, and its posts can only go to them.`,
  openSignedIn: "Open it on the phone or computer signed in to the account.",
  forwardLink: "Kin doesn't message your client. Forward the link yourself.",
  title: "Social accounts",
  intro:
    "Your company's accounts and each client's, through one posting service. Social drafts the week; nothing goes out until you confirm.",
  add: "Connect accounts",
  addOwn: "Our own accounts",
  addClient: "A client's accounts",
  sheetTitle: "Connect social accounts",
  whose: "Whose accounts?",
  keyLabel: "Profile key",
  keyPlaceholder: "Paste the key",
  keyHint: (service: string) =>
    `Make a key in ${service} limited to this one profile, so it can't reach anyone else's accounts. It goes to your Kin and is never shown again.`,
  openService: (service: string) => `Open ${service}`,
  check: "Check the key",
  checking: "Checking…",
  found: (profile: string) => `This key reaches ${profile}:`,
  noAccounts: "No accounts are connected to this profile yet. Send a connect link after saving.",
  confirm: "Connect these accounts",
  connecting: "Connecting…",
  cancel: "Cancel",
  done: "Done",
  connected: (label: string) =>
    `${label} is connected. Social can read these accounts and draft for them; nothing posts until you confirm a week.`,
  reconnect: "New key",
  refresh: "Check again",
  remove: "Remove",
  removeTitle: (label: string) => `Remove ${label}'s accounts from Kin?`,
  removeDetail:
    "Drafts and posts waiting for Confirm are dropped. Posts already scheduled stay scheduled at the service; cancel them there if you need to.",
  link: "Send a connect link",
  linkOwn: "Connect an account",
  linkTitle: (label: string) => `A connect link for ${label}`,
  linkPlatform: "Which platform?",
  linkMake: "Make the link",
  linkMaking: "Making…",
  copy: "Copy link",
  copied: "Copied",
  share: "Share",
  noClients: "Add the client in Kin first; each client's accounts connect on their own.",
  loadFailed: "Couldn't load your social accounts",
  loading: "Loading…",
  empty: "Nothing connected yet. Social can still draft, and hands you ready-to-post packs.",
  /** Web Settings: the agent may not be called Social, so the line names no agent. */
  settingsEmpty:
    "Nothing connected yet. Your agents can still draft posts for you to put up yourself.",
  open: "Open",
  noAccountsYet: "No accounts yet. Send a connect link to add one.",
} as const;

const makeKey = Schema.decodeSync(KinConnectionKey);

export const kinSocialPlatformLabel = (platform: KinSocialPlatform) =>
  KIN_SOCIAL_PLATFORM_LABELS[platform];

/** "Instagram · @inventedco", the account as the platform names it. */
export const kinSocialAccountLine = (account: KinSocialAccount) => {
  const name = account.handle === null ? account.name : `@${account.handle.replace(/^@/, "")}`;
  return `${kinSocialPlatformLabel(account.platform)} · ${name}`;
};

export interface KinSocialRow {
  readonly groupId: string;
  readonly title: string;
  readonly kind: KinSocialGroup["kind"];
  readonly tone: KinConnectionTone;
  readonly label: string;
  readonly detail: string;
  readonly accounts: ReadonlyArray<{
    readonly accountId: string;
    readonly line: string;
    readonly problem: string | null;
    readonly platform: KinSocialPlatform;
  }>;
  readonly linkLabel: string;
}

/** One row per group, our own first; a dead key or a broken account says why and what to do. */
export function kinSocialRows(view: KinSocialView): ReadonlyArray<KinSocialRow> {
  return view.groups.map((group) => {
    const broken = group.accounts.filter((account) => account.problem !== null);
    const accounts = group.accounts.map((account) => ({
      accountId: account.accountId,
      line: kinSocialAccountLine(account),
      problem: account.problem,
      platform: account.platform,
    }));
    const via =
      group.profileName === null ? group.service : `${group.profileName} in ${group.service}`;
    const base = {
      groupId: group.groupId,
      title: group.label,
      kind: group.kind,
      accounts,
      linkLabel: group.kind === "client" ? KIN_SOCIAL_COPY.link : KIN_SOCIAL_COPY.linkOwn,
    };
    if (group.problem !== null)
      return { ...base, tone: "error", label: "Needs a new key", detail: group.problem };
    if (broken.length > 0)
      return {
        ...base,
        tone: "attention",
        label: broken.length === 1 ? "An account needs reconnecting" : "Accounts need reconnecting",
        detail: `${via}. Send a connect link for ${broken.map((one) => kinSocialPlatformLabel(one.platform)).join(" and ")} to reconnect.`,
      };
    if (group.accounts.length === 0)
      return {
        ...base,
        tone: "attention",
        label: "No accounts yet",
        detail: `${via} has no accounts connected. Send a connect link to add one.`,
      };
    return { ...base, tone: "ok", label: "Connected", detail: via };
  });
}

/** Platforms a connect link can add. */
export const KIN_SOCIAL_LINK_PLATFORMS = KIN_SOCIAL_PLATFORMS.map((platform) => ({
  platform,
  label: kinSocialPlatformLabel(platform),
}));

/** Who can still be connected: our own while free, then each client without accounts. */
export function kinSocialChoices(view: KinSocialView) {
  return [
    ...(view.ownFree
      ? [{ kind: "own" as const, clientId: undefined, label: KIN_SOCIAL_COPY.addOwn }]
      : []),
    ...view.clients.map((client) => ({
      kind: "client" as const,
      clientId: client.clientId,
      label: client.label,
    })),
  ];
}

type Sent<A> = Promise<AtomCommandResult<A, unknown>>;
export type KinSocialOutcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly problem: string };

const settle = async <A>(sent: Sent<A>, doing: string): Promise<KinSocialOutcome<A>> => {
  const result = await sent;
  return AsyncResult.isSuccess(result)
    ? { ok: true, value: result.value }
    : {
        ok: false,
        problem: kinFailureText(squashAtomCommandFailure(result), `Couldn't ${doing}.`, {
          device: `This device isn't allowed to ${doing}.`,
        }),
      };
};

/** The owner's social changes, each answered in plain words. The key travels once, redacted. */
export function createKinSocialActions(options: {
  readonly orgId: KinOrgId;
  readonly check: (input: KinSocialCheckInput) => Sent<KinSocialCheck>;
  readonly connect: (input: KinSocialConnectInput) => Sent<KinSocialView>;
  readonly refresh: (input: KinSocialGroupInput) => Sent<KinSocialView>;
  readonly remove: (input: KinSocialGroupInput) => Sent<KinSocialView>;
  readonly link: (input: KinSocialLinkInput) => Sent<KinSocialLink>;
  readonly reload: () => void;
}) {
  const { orgId } = options;
  const after = async <A>(sent: Sent<A>, doing: string) => {
    const outcome = await settle(sent, doing);
    options.reload();
    return outcome;
  };
  return {
    check: async (input: {
      readonly kind: "own" | "client";
      readonly clientId?: string | undefined;
      readonly groupId?: string | undefined;
      readonly key: string;
    }): Promise<KinSocialOutcome<KinSocialCheck>> => {
      const key = input.key.trim();
      if (key === "") return { ok: false, problem: "Paste the key to check it." };
      return settle(
        options.check({
          orgId,
          kind: input.kind,
          ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
          ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
          key: makeKey(key),
        }),
        "check the key",
      );
    },
    connect: (checkId: string) =>
      after(options.connect({ orgId, checkId }), "connect the accounts"),
    refresh: (groupId: string) => after(options.refresh({ orgId, groupId }), "check the accounts"),
    remove: (groupId: string) => after(options.remove({ orgId, groupId }), "remove the accounts"),
    link: (groupId: string, platform: KinSocialPlatform, accountId?: string) =>
      settle(
        options.link({
          orgId,
          groupId,
          platform,
          ...(accountId === undefined ? {} : { accountId }),
        }),
        "make the link",
      ),
  };
}

const decodeWeek = Schema.decodeUnknownOption(KinSocialWeekCard);
const decodePack = Schema.decodeUnknownOption(KinSocialPackCard);

export type KinSocialPostTone = "waiting" | "active" | "done" | "error" | "muted";

export interface KinSocialPostView {
  readonly postId: string;
  readonly when: string;
  readonly account: string;
  readonly platform: string;
  readonly caption: string;
  readonly media: KinSocialMedia | null;
  readonly state: string;
  readonly tone: KinSocialPostTone;
  readonly url: string | null;
  readonly reason: string | null;
  /** Undo shows while this is ahead of the clock; the server checks it again on the tap. */
  readonly undoUntilMs: number | null;
  readonly actions: ReadonlyArray<"remove" | "retry">;
}

/** The post's taps at this minute: Undo only while it still cancels the post. */
export const kinSocialPostActions = (
  post: KinSocialPostView,
  nowMs: number,
): ReadonlyArray<"remove" | "undo" | "retry"> =>
  post.undoUntilMs !== null && post.undoUntilMs > nowMs ? [...post.actions, "undo"] : post.actions;

export interface KinSocialWeekView {
  readonly widgetId: KinWidget["widgetId"];
  readonly revision: number;
  readonly eyebrow: string;
  readonly title: string;
  readonly posts: ReadonlyArray<KinSocialPostView>;
  /** What the footer says: why nothing is out yet, or what Confirm did. */
  readonly status: string;
  readonly confirm: {
    readonly label: string;
    readonly digest: string;
    readonly ready: boolean;
  } | null;
  readonly clientReview: {
    readonly label: string;
    readonly ok: boolean;
    readonly previewLabel: string;
    readonly making: boolean;
    readonly preview: KinSocialMedia | null;
    readonly canPreview: boolean;
  } | null;
  readonly closed: boolean;
  readonly accessibilityLabel: string;
}

const STATE_WORDS: Record<
  KinSocialCardPost["state"],
  { readonly label: string; readonly tone: KinSocialPostTone }
> = {
  proposed: { label: "Waiting for Confirm", tone: "waiting" },
  removed: { label: "Removed", tone: "muted" },
  scheduling: { label: "Scheduling…", tone: "active" },
  scheduled: { label: "Scheduled", tone: "active" },
  undoing: { label: "Cancelling…", tone: "active" },
  cancelled: { label: "Cancelled", tone: "muted" },
  posted: { label: "Posted", tone: "done" },
  failed: { label: "Failed", tone: "error" },
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The week's posts for one group, in the owner's zone, with only the taps that still work. */
export function kinSocialWeekView(widget: KinWidget): KinSocialWeekView | null {
  if (widget.type !== KIN_SOCIAL_WEEK_CARD) return null;
  const decoded = decodeWeek(widget.state);
  if (Option.isNone(decoded)) return null;
  const card = decoded.value;
  const closed = widget.closedAt !== null || card.replaced;
  const confirmed = card.confirmedAt !== null;
  const posts = card.posts.map((post): KinSocialPostView => {
    const words = STATE_WORDS[post.state];
    const actions: Array<"remove" | "retry"> = [];
    if (!closed && !confirmed && post.state === "proposed") actions.push("remove");
    if (post.state === "failed") actions.push("retry");
    const undoable = post.state === "scheduled" || post.state === "scheduling";
    return {
      postId: post.postId,
      when: post.when,
      account: post.account.name,
      platform: kinSocialPlatformLabel(post.account.platform),
      caption: post.caption,
      media: post.media,
      state: words.label,
      tone: words.tone,
      url: post.url,
      reason: post.reason,
      undoUntilMs: undoable && post.undoUntil !== null ? Date.parse(post.undoUntil) : null,
      actions,
    };
  });
  const left = card.posts.filter((post) => post.state === "proposed").length;
  const count = (state: KinSocialCardPost["state"]) =>
    card.posts.filter((post) => post.state === state).length;
  const status = card.replaced
    ? "A newer card for these posts replaced this one."
    : confirmed
      ? [
          count("scheduled") + count("scheduling") > 0
            ? `${count("scheduled") + count("scheduling")} scheduled`
            : null,
          count("posted") > 0 ? `${count("posted")} posted` : null,
          count("failed") > 0 ? `${count("failed")} failed` : null,
          count("cancelled") > 0 ? `${count("cancelled")} cancelled` : null,
        ]
          .filter((part) => part !== null)
          .join(" · ") || "Confirmed."
      : left === 0
        ? "Every post was removed."
        : "Nothing goes out until you confirm.";
  const review = card.clientReview;
  const ready = review === null || review.ok;
  return {
    widgetId: widget.widgetId,
    revision: widget.revision,
    eyebrow: card.group.kind === "own" ? "Our own accounts" : `${card.group.label} · client`,
    title: card.title,
    posts,
    status,
    confirm:
      closed || confirmed || left === 0 || card.digest === null
        ? null
        : { label: `Confirm ${plural(left, "post")}`, digest: card.digest, ready },
    clientReview:
      review === null
        ? null
        : {
            label: `${card.group.label} said OK`,
            ok: review.ok,
            previewLabel: review.making
              ? "Making the preview…"
              : review.preview === null
                ? "Make a preview to send the client"
                : "Make the preview again",
            making: review.making,
            preview: review.preview,
            canPreview: !closed && !review.making,
          },
    closed,
    accessibilityLabel: `${card.title}. ${plural(card.posts.length, "post")}. ${status}`,
  };
}

export interface KinSocialPackView {
  readonly widgetId: KinWidget["widgetId"];
  readonly revision: number;
  readonly eyebrow: string;
  readonly title: string;
  readonly why: string;
  readonly caption: string;
  readonly media: KinSocialMedia | null;
  readonly reminder: string | null;
  readonly posted: boolean;
}

/** A post to make by hand: where and when, why Kin can't, and everything to copy. */
export function kinSocialPackView(widget: KinWidget): KinSocialPackView | null {
  if (widget.type !== KIN_SOCIAL_PACK_CARD) return null;
  const decoded = decodePack(widget.state);
  if (Option.isNone(decoded)) return null;
  const pack = decoded.value;
  return {
    widgetId: widget.widgetId,
    revision: widget.revision,
    eyebrow: "Ready to post",
    title: `${pack.where} · ${pack.when}`,
    why: pack.why,
    caption: pack.caption,
    media: pack.media,
    reminder:
      pack.posted !== null
        ? null
        : pack.reminderId === null
          ? null
          : `Kin reminds you at ${pack.when}.`,
    posted: pack.posted !== null,
  };
}

export const KIN_SOCIAL_ACTION_LABELS: Record<
  KinSocialWeekCardAction | KinSocialPackCardAction,
  string
> = {
  remove: "Remove",
  confirm: "Confirm",
  undo: "Undo",
  retry: "Retry",
  client_ok: "Client said OK",
  preview: "Make a preview",
  posted: "I posted it",
};

/** A tap on a social card: which post, the digest Confirm signs, or the client switch. */
function kinSocialActInput(
  view: Pick<KinSocialWeekView, "widgetId" | "revision">,
  tap: {
    readonly actionId: KinSocialWeekCardAction | KinSocialPackCardAction;
    readonly value: unknown;
  },
  clientActionId: string,
): KinWidgetsActInput {
  return {
    widgetId: view.widgetId,
    revision: view.revision,
    actionId: tap.actionId,
    value: tap.value,
    clientActionId,
  };
}

/** Kin's refusals on these cards are already in the owner's words, so they're shown as said. */
function kinSocialFailureNotice(cause: KinChatError): KinCardNotice {
  const said = cause.message.trim();
  if ((cause.reason === "invalid_state" || cause.reason === "not_allowed") && said !== "")
    return { kind: "error", text: said };
  return kinActionFailureNotice(cause);
}

type KinSocialTarget = Pick<KinSocialWeekView, "widgetId" | "revision">;
export type KinSocialTap = Parameters<typeof kinSocialActInput>[1];
/** A refusal, tied to the card revision it was raised on. */
export type KinSocialNotice = { readonly revision: number; readonly notice: KinCardNotice } | null;

/** What a social card keeps between renders outside React: its tap queue and each tap's value. */
export interface KinSocialCardTaps {
  queue: ReturnType<typeof createKinCardActions<KinSocialTarget, string>> | null;
  readonly taps: Map<string, KinSocialTap>;
}
export const kinSocialCardTaps = (): KinSocialCardTaps => ({ queue: null, taps: new Map() });

/**
 * One tap at a time per card, the same on every client; a refusal shows in the owner's words
 * until the card changes (`kinSocialNoticeShown`). Each app holds the state and draws it.
 */
export function kinSocialCardActions(options: {
  readonly view: KinSocialTarget;
  readonly environmentId: EnvironmentId;
  readonly newId: () => string;
  /** Made once per card (`kinSocialCardTaps`). */
  readonly taps: KinSocialCardTaps;
  readonly post: (value: {
    readonly environmentId: EnvironmentId;
    readonly input: KinWidgetsActInput;
  }) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly set: {
    readonly pending: (key: string | null) => void;
    readonly notice: (notice: KinSocialNotice) => void;
  };
}) {
  const { view, environmentId, taps, set } = options;
  const press = async (key: string, tap: KinSocialTap) => {
    taps.taps.set(key, tap);
    if (taps.queue === null)
      taps.queue = createKinCardActions<KinSocialTarget, string>({
        newId: options.newId,
        toInput: (target, actionKey, clientActionId) =>
          kinSocialActInput(target, taps.taps.get(actionKey)!, clientActionId),
        failureNotice: (cause) => kinSocialFailureNotice(cause),
        post: async (input) => {
          const result = await options.post({ environmentId, input });
          return AsyncResult.isFailure(result)
            ? { ok: false as const, cause: squashAtomCommandFailure(result) }
            : { ok: true as const };
        },
      });
    const revision = view.revision;
    const outcome = await taps.queue(view, key, () => {
      set.pending(key);
      set.notice(null);
    });
    if (outcome.status === "ignored") return;
    set.pending(null);
    if (outcome.status === "failed") set.notice({ revision, notice: outcome.notice });
  };
  return { press };
}

/** The refusal to show: only while the card is still the one it was raised on. */
export function kinSocialNoticeShown(
  notice: KinSocialNotice,
  view: Pick<KinSocialWeekView, "revision">,
): KinCardNotice | null {
  return notice !== null && notice.revision === view.revision ? notice.notice : null;
}
