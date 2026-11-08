import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  KinChatError,
  KinChatId,
  type KinMessage,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { shouldRetryThreadOutboxDelivery } from "../../../state/thread-outbox-model";

/**
 * Sends wait here, keyed by `clientMessageId`, until the host acks them. The host dedupes a
 * repeated `(chat, author, clientMessageId)`, so resending after a lost reply, a reconnect or a
 * restart yields the first message, never a second one.
 */
const KinOutboxRecord = Schema.Struct({
  environmentId: EnvironmentId,
  chatId: KinChatId,
  clientMessageId: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  /** Null while it waits to go out; the host's reason once it refused the send. */
  error: Schema.NullOr(Schema.String),
});
export type KinOutboxRecord = typeof KinOutboxRecord.Type;

const KinOutboxFile = Schema.Struct({
  version: Schema.Literal(1),
  entries: Schema.Array(KinOutboxRecord),
});
const fileCodec = Schema.fromJsonString(Schema.toCodecJson(KinOutboxFile));
const decodeFile = Schema.decodeUnknownOption(fileCodec);
const encodeFile = Schema.encodeSync(fileCodec);

export type KinOutboxEntry = KinOutboxRecord & {
  readonly state: "waiting" | "sending" | "failed" | "sent";
  /** The host's message once acked; shown until the stream carries its own copy. */
  readonly sent: KinMessage | null;
};

export type KinSendOutcome =
  | { readonly _tag: "sent"; readonly message: KinMessage }
  /** Not reachable now; the entry waits for the next reconnect. */
  | { readonly _tag: "offline" }
  | { readonly _tag: "rejected"; readonly message: string };

export interface KinOutboxStorage {
  readonly load: () => Promise<string | null>;
  readonly save: (payload: string) => Promise<void>;
}

export interface KinOutboxOptions {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly storage: KinOutboxStorage;
  readonly send: (record: KinOutboxRecord) => Promise<KinSendOutcome>;
  readonly makeId: () => string;
  readonly now?: () => Date;
  readonly warn?: (message: string, error: unknown) => void;
}

const EMPTY: ReadonlyArray<KinOutboxEntry> = [];
const chatKey = (environmentId: EnvironmentId, chatId: KinChatId) =>
  `${environmentId}\u0000${chatId}`;

const isChatError = Schema.is(KinChatError);
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

/** A refused send fails the bubble; anything that looks like the connection waits to resend. */
export function classifyKinSendFailure(error: unknown): KinSendOutcome {
  if (isChatError(error)) return { _tag: "rejected", message: error.message };
  if (isAuthorizationError(error)) {
    return { _tag: "rejected", message: "This device can't send in this chat." };
  }
  return shouldRetryThreadOutboxDelivery(error)
    ? { _tag: "offline" }
    : { _tag: "rejected", message: "Kin didn't accept the message." };
}

export function createKinOutbox(options: KinOutboxOptions) {
  const now = options.now ?? (() => new Date());
  const warn = options.warn ?? ((message, error) => console.warn(message, error));
  // One atom per chat, so a send repaints only that chat's feed.
  const chatAtom = Atom.family((_key: string) =>
    Atom.make<ReadonlyArray<KinOutboxEntry>>(EMPTY).pipe(
      Atom.keepAlive,
      Atom.withLabel("kin:outbox:chat"),
    ),
  );
  const entries = new Map<string, KinOutboxEntry>();
  const delivering = new Set<EnvironmentId>();
  const deliverAgain = new Set<EnvironmentId>();
  let loaded: Promise<void> | null = null;
  let writes: Promise<void> = Promise.resolve();

  const publish = (environmentId: EnvironmentId, chatId: KinChatId) => {
    const forChat = [...entries.values()].filter(
      (entry) => entry.environmentId === environmentId && entry.chatId === chatId,
    );
    options.registry.set(
      chatAtom(chatKey(environmentId, chatId)),
      forChat.length ? forChat : EMPTY,
    );
  };

  const set = (entry: KinOutboxEntry) => {
    entries.set(entry.clientMessageId, entry);
    publish(entry.environmentId, entry.chatId);
  };

  // Acked entries stay in memory only: the host holds them, so a restart must not resend them.
  const persist = (): Promise<void> => {
    const records = [...entries.values()]
      .filter((entry) => entry.state !== "sent")
      .map(({ state: _state, sent: _sent, ...record }) => record);
    const payload = encodeFile({ version: 1, entries: records });
    writes = writes.then(
      () => options.storage.save(payload),
      () => options.storage.save(payload),
    );
    return writes.catch((error) => warn("[kin-outbox] save failed", error));
  };

  const load = (): Promise<void> =>
    (loaded ??= options.storage
      .load()
      .then((payload) => {
        const file = payload === null ? null : decodeFile(payload);
        if (file === null || file._tag === "None") return;
        for (const record of file.value.entries) {
          if (entries.has(record.clientMessageId)) continue;
          // A send cut off by the restart goes out again under the same id.
          set({ ...record, state: record.error === null ? "waiting" : "failed", sent: null });
        }
      })
      .catch((error) => warn("[kin-outbox] load failed", error)));

  const deliverOne = async (entry: KinOutboxEntry): Promise<"next" | "stop"> => {
    set({ ...entry, state: "sending" });
    const outcome = await options.send(entry).catch(classifyKinSendFailure);
    const current = entries.get(entry.clientMessageId);
    // Discarded while in flight, or a duplicate ack for an entry that already settled.
    if (current === undefined || current.state === "sent") return "next";
    switch (outcome._tag) {
      case "sent":
        set({ ...current, state: "sent", error: null, sent: outcome.message });
        await persist();
        return "next";
      case "offline":
        set({ ...current, state: "waiting" });
        return "stop";
      case "rejected":
        set({ ...current, state: "failed", error: outcome.message });
        await persist();
        return "next";
    }
  };

  /** Sends everything waiting for one environment, oldest first, one at a time. */
  const deliver = async (environmentId: EnvironmentId): Promise<void> => {
    await load();
    if (delivering.has(environmentId)) {
      deliverAgain.add(environmentId);
      return;
    }
    delivering.add(environmentId);
    try {
      do {
        deliverAgain.delete(environmentId);
        for (;;) {
          const next = [...entries.values()].find(
            (entry) => entry.environmentId === environmentId && entry.state === "waiting",
          );
          if (next === undefined || (await deliverOne(next)) === "stop") break;
        }
      } while (deliverAgain.has(environmentId));
    } finally {
      delivering.delete(environmentId);
    }
  };

  const enqueue = async (input: {
    readonly environmentId: EnvironmentId;
    readonly chatId: KinChatId;
    readonly body: string;
  }): Promise<KinOutboxEntry> => {
    await load();
    const entry: KinOutboxEntry = {
      environmentId: input.environmentId,
      chatId: input.chatId,
      clientMessageId: options.makeId(),
      body: input.body,
      createdAt: now().toISOString(),
      error: null,
      state: "waiting",
      sent: null,
    };
    set(entry);
    await persist();
    return entry;
  };

  const retry = async (clientMessageId: string): Promise<void> => {
    const entry = entries.get(clientMessageId);
    if (entry?.state !== "failed") return;
    set({ ...entry, state: "waiting", error: null });
    await persist();
    await deliver(entry.environmentId);
  };

  /** Drops a failed send for good. The same id is never sent again. */
  const discard = async (clientMessageId: string): Promise<void> => {
    const entry = entries.get(clientMessageId);
    if (entry === undefined || entry.state === "sending") return;
    entries.delete(clientMessageId);
    publish(entry.environmentId, entry.chatId);
    await persist();
  };

  return {
    load,
    enqueue,
    deliver,
    retry,
    discard,
    chatAtom: (environmentId: EnvironmentId, chatId: KinChatId) =>
      chatAtom(chatKey(environmentId, chatId)),
    /** Environments with sends still waiting, for the reconnect trigger. */
    waitingEnvironments: (): ReadonlySet<EnvironmentId> =>
      new Set(
        [...entries.values()]
          .filter((entry) => entry.state === "waiting")
          .map((entry) => entry.environmentId),
      ),
    /** Resolves once every queued save has reached storage. */
    flushWrites: () => writes.catch(() => undefined),
  };
}

export type KinOutbox = ReturnType<typeof createKinOutbox>;

/**
 * Splits a chat's outbox for the feed: acked messages join the stream's (its copy wins once it
 * arrives) and the rest render as pending bubbles after the last message.
 */
export function splitKinOutbox(
  outbox: ReadonlyArray<KinOutboxEntry>,
  streamed: ReadonlyArray<KinMessage>,
): { readonly acked: ReadonlyArray<KinMessage>; readonly pending: ReadonlyArray<KinOutboxEntry> } {
  if (outbox.length === 0) return { acked: [], pending: EMPTY };
  const known = new Set(streamed.map((message) => message.messageId));
  const acked: KinMessage[] = [];
  const pending: KinOutboxEntry[] = [];
  for (const entry of outbox) {
    if (entry.sent === null) pending.push(entry);
    else if (!known.has(entry.sent.messageId)) acked.push(entry.sent);
  }
  return { acked, pending };
}
