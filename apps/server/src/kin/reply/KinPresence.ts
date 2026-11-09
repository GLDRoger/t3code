import type {
  KinAgentId,
  KinChatId,
  KinDraft,
  KinMessageId,
  KinOrgId,
  KinPresence as Presence,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Hub from "../chat/KinChatHub.ts";

/** Draft deltas go out at most this often per chat. */
const DRAFT_THROTTLE_MS = 250;

type DraftState = {
  readonly agentId: KinAgentId;
  full: string;
  sent: number;
  lastSentAt: number;
  flushing: boolean;
};
type Line = {
  readonly presence: Map<KinAgentId, Presence>;
  readonly drafts: Map<string, DraftState>;
};

/**
 * The live part of a chat: each agent's status line and its streaming drafts. In memory only;
 * a restart loses both, and the bridge rebuilds them for wake-ups still running.
 */
export class KinPresence extends Context.Service<
  KinPresence,
  {
    readonly set: (orgId: KinOrgId, chatId: KinChatId, presence: Presence) => Effect.Effect<void>;
    readonly clear: (
      orgId: KinOrgId,
      chatId: KinChatId,
      agentId: KinAgentId,
    ) => Effect.Effect<void>;
    /** `text` is the whole draft so far; only its new tail is sent. */
    readonly draft: (orgId: KinOrgId, chatId: KinChatId, draft: KinDraft) => Effect.Effect<void>;
    readonly endDraft: (
      orgId: KinOrgId,
      chatId: KinChatId,
      draftId: string,
      messageId: KinMessageId | null,
    ) => Effect.Effect<void>;
    readonly snapshot: (
      orgId: KinOrgId,
      chatId: KinChatId,
    ) => {
      readonly presence: ReadonlyArray<Presence>;
      readonly drafts: ReadonlyArray<KinDraft>;
    };
  }
>()("t3/kin/reply/KinPresence") {}

const same = (a: Presence | undefined, b: Presence) =>
  a !== undefined &&
  a.state === b.state &&
  a.label === b.label &&
  a.wakeupId === b.wakeupId &&
  a.since === b.since &&
  a.startedAt === b.startedAt;

const make = Effect.gen(function* () {
  const hub = yield* Hub.KinChatHub;
  const scope = yield* Effect.scope;
  const lines = new Map<string, Line>();
  const keyOf = (orgId: KinOrgId, chatId: KinChatId) => `${orgId}\u0000${chatId}`;
  const line = (orgId: KinOrgId, chatId: KinChatId) => {
    const key = keyOf(orgId, chatId);
    let found = lines.get(key);
    if (found === undefined) {
      found = { presence: new Map(), drafts: new Map() };
      lines.set(key, found);
    }
    return found;
  };
  const prune = (orgId: KinOrgId, chatId: KinChatId) => {
    const key = keyOf(orgId, chatId);
    const found = lines.get(key);
    if (found !== undefined && found.presence.size === 0 && found.drafts.size === 0)
      lines.delete(key);
  };
  const send = Effect.fnUntraced(function* (
    orgId: KinOrgId,
    chatId: KinChatId,
    draftId: string,
    state: DraftState,
    end?: { readonly messageId: KinMessageId | null },
  ) {
    const text = state.full.slice(state.sent);
    if (text === "" && end === undefined) return;
    const offset = state.sent;
    state.sent = state.full.length;
    state.lastSentAt = yield* Clock.currentTimeMillis;
    yield* hub.publish({
      type: "draft.updated",
      orgId,
      chatId,
      draft: {
        draftId,
        agentId: state.agentId,
        offset,
        text,
        ...(end === undefined ? {} : { end }),
      },
    });
  });
  return KinPresence.of({
    set: Effect.fn("KinPresence.set")(function* (orgId, chatId, presence) {
      const current = line(orgId, chatId);
      if (same(current.presence.get(presence.agentId), presence)) return;
      current.presence.set(presence.agentId, presence);
      yield* hub.publish({
        type: "presence.updated",
        orgId,
        chatId,
        agentId: presence.agentId,
        presence,
      });
    }),
    clear: Effect.fn("KinPresence.clear")(function* (orgId, chatId, agentId) {
      const current = line(orgId, chatId);
      const had = current.presence.delete(agentId);
      prune(orgId, chatId);
      if (had)
        yield* hub.publish({ type: "presence.updated", orgId, chatId, agentId, presence: null });
    }),
    // Per-delta work; a span per provider chunk would swamp tracing.
    draft: Effect.fnUntraced(function* (orgId, chatId, draft) {
      const current = line(orgId, chatId);
      let state = current.drafts.get(draft.draftId);
      if (state === undefined) {
        state = { agentId: draft.agentId, full: "", sent: 0, lastSentAt: 0, flushing: false };
        current.drafts.set(draft.draftId, state);
      }
      // Assistant text only grows; anything else waits for the durable message.
      if (!draft.text.startsWith(state.full)) return;
      state.full = draft.text;
      const now = yield* Clock.currentTimeMillis;
      if (now - state.lastSentAt >= DRAFT_THROTTLE_MS)
        return yield* send(orgId, chatId, draft.draftId, state);
      if (state.flushing) return;
      state.flushing = true;
      const held = state;
      yield* Effect.sleep(DRAFT_THROTTLE_MS - (now - state.lastSentAt)).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            held.flushing = false;
            return current.drafts.get(draft.draftId) === held
              ? send(orgId, chatId, draft.draftId, held)
              : Effect.void;
          }),
        ),
        Effect.forkIn(scope),
      );
    }),
    endDraft: Effect.fn("KinPresence.endDraft")(function* (orgId, chatId, draftId, messageId) {
      const current = line(orgId, chatId);
      const state = current.drafts.get(draftId);
      if (state === undefined) return;
      current.drafts.delete(draftId);
      prune(orgId, chatId);
      yield* send(orgId, chatId, draftId, state, { messageId });
    }),
    snapshot: (orgId, chatId) => {
      const current = lines.get(keyOf(orgId, chatId));
      return current === undefined
        ? { presence: [], drafts: [] }
        : {
            presence: [...current.presence.values()],
            // What was already sent, so the next delta's offset lines up.
            drafts: [...current.drafts].map(([draftId, state]) => ({
              draftId,
              agentId: state.agentId,
              text: state.full.slice(0, state.sent),
            })),
          };
    },
  });
});

export const layer = Layer.effect(KinPresence, make);
