import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  KIN_MESSAGE_BODY_MAX_LENGTH,
  KinChatError,
  KinChatId,
  type KinMessage,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom, type AtomRegistry } from "effect/reactivity";

/** `KinMessagesSendInput.body`'s max length; longer bodies would be refused for good. */
export const KIN_MESSAGE_MAX_LENGTH = KIN_MESSAGE_BODY_MAX_LENGTH;
/** Unsent messages one environment may hold; past it, Send keeps the text in the draft. */
export const KIN_OUTBOX_MAX_ENTRIES = 200;
/** A send with no reply by then waits for the next attempt; dedupe makes the resend safe. */
export const KIN_SEND_TIMEOUT_MS = 30_000;

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
  /** Null while it waits to go out; why the host refused it for good otherwise. */
  error: Schema.NullOr(Schema.String),
});
export type KinOutboxRecord = typeof KinOutboxRecord.Type;

const recordCodec = Schema.toCodecJson(KinOutboxRecord);
const decodeRecord = Schema.decodeUnknownOption(recordCodec);
const encodeRecord = Schema.encodeSync(recordCodec);
// Entries decode one by one, so one corrupt record never costs the rest.
const decodeFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ version: Schema.Literal(1), entries: Schema.Array(Schema.Unknown) }),
  ),
);

export type KinOutboxEntry = KinOutboxRecord & {
  readonly state: "waiting" | "sending" | "failed" | "sent";
  /** The host's message once acked; shown until the stream carries its own copy. */
  readonly sent: KinMessage | null;
};

export type KinSendOutcome =
  | { readonly _tag: "sent"; readonly message: KinMessage }
  /** Not reachable now, or no answer; the entry waits for the next attempt. */
  | { readonly _tag: "offline" }
  /** Refused for good. Resending the same body can't succeed. */
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
  readonly sendTimeoutMs?: number;
  readonly maxEntries?: number;
  readonly warn?: (message: string, error: unknown) => void;
}

const EMPTY: ReadonlyArray<KinOutboxEntry> = [];
const chatKey = (environmentId: EnvironmentId, chatId: KinChatId) =>
  `${environmentId}\u0000${chatId}`;

const isChatError = Schema.is(KinChatError);
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

const refusalReasons: Partial<Record<KinChatError["reason"], string>> = {
  not_found: "this chat is gone",
  not_allowed: "you can't post here",
  invalid_state: "the chat can't take it",
  limit: "over the limit",
};

/**
 * Only a typed refusal fails the bubble. Kin being off, a dropped connection, a lost or
 * undecodable reply all wait and resend under the same id.
 */
export function classifyKinSendFailure(error: unknown): KinSendOutcome {
  if (isAuthorizationError(error)) return { _tag: "rejected", message: "not allowed here" };
  if (!isChatError(error) || error.reason === "unavailable") return { _tag: "offline" };
  return { _tag: "rejected", message: refusalReasons[error.reason] ?? error.message };
}

const TIMED_OUT: KinSendOutcome = { _tag: "offline" };

export function createKinOutbox(options: KinOutboxOptions) {
  const now = options.now ?? (() => new Date());
  const warn = options.warn ?? ((message, error) => console.warn(message, error));
  const sendTimeoutMs = options.sendTimeoutMs ?? KIN_SEND_TIMEOUT_MS;
  const maxEntries = options.maxEntries ?? KIN_OUTBOX_MAX_ENTRIES;
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

  const remove = (entry: KinOutboxEntry) => {
    entries.delete(entry.clientMessageId);
    publish(entry.environmentId, entry.chatId);
  };

  // Acked entries stay in memory only: the host holds them, so a restart must not resend them.
  const persist = (): Promise<void> => {
    const records = [...entries.values()]
      .filter((entry) => entry.state !== "sent")
      .map(({ state: _state, sent: _sent, ...record }) => encodeRecord(record));
    const payload = JSON.stringify({ version: 1, entries: records });
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
        if (payload === null) return;
        const file = decodeFile(payload);
        if (file._tag === "None") {
          warn("[kin-outbox] unreadable outbox file, starting empty", payload.length);
          return;
        }
        let corrupt = 0;
        for (const raw of file.value.entries) {
          const record = decodeRecord(raw);
          if (record._tag === "None") {
            corrupt++;
            continue;
          }
          if (entries.has(record.value.clientMessageId)) continue;
          // A send cut off by the restart goes out again under the same id.
          const state = record.value.error === null ? "waiting" : "failed";
          set({ ...record.value, state, sent: null });
        }
        if (corrupt > 0) warn("[kin-outbox] skipped corrupt entries", corrupt);
      })
      .catch((error) => warn("[kin-outbox] load failed", error)));

  const sendWithTimeout = (entry: KinOutboxEntry): Promise<KinSendOutcome> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<KinSendOutcome>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), sendTimeoutMs);
    });
    const sent = options
      .send(entry)
      .catch(classifyKinSendFailure)
      .finally(() => clearTimeout(timer));
    return Promise.race([sent, timeout]);
  };

  const deliverOne = async (entry: KinOutboxEntry): Promise<"next" | "stop"> => {
    set({ ...entry, state: "sending" });
    const outcome = await sendWithTimeout(entry);
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
  }): Promise<
    | { readonly _tag: "queued"; readonly entry: KinOutboxEntry }
    | { readonly _tag: "full" }
    | { readonly _tag: "too_long" }
  > => {
    if (input.body.length > KIN_MESSAGE_MAX_LENGTH) return { _tag: "too_long" };
    await load();
    let unsent = 0;
    for (const entry of entries.values()) {
      if (entry.environmentId === input.environmentId && entry.state !== "sent") unsent++;
    }
    if (unsent >= maxEntries) return { _tag: "full" };
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
    return { _tag: "queued", entry };
  };

  /** Drops an unsent message for good; the same id is never sent again. Returns its body. */
  const discard = async (clientMessageId: string): Promise<string | null> => {
    const entry = entries.get(clientMessageId);
    if (entry === undefined || entry.state === "sending" || entry.state === "sent") return null;
    remove(entry);
    await persist();
    return entry.body;
  };

  /** Forgets entries the chat's stream carries, acked or not, by `clientMessageId`. */
  const forgetEchoed = (clientMessageIds: ReadonlySet<string>) => {
    let unsent = false;
    for (const entry of entries.values()) {
      if (!clientMessageIds.has(entry.clientMessageId)) continue;
      unsent ||= entry.state !== "sent";
      remove(entry);
    }
    if (unsent) void persist();
  };

  /** The environment was removed from this device; its unsent messages go with it. */
  const clearEnvironment = async (environmentId: EnvironmentId): Promise<void> => {
    await load();
    for (const entry of entries.values()) {
      if (entry.environmentId === environmentId) remove(entry);
    }
    await persist();
  };

  return {
    load,
    enqueue,
    deliver,
    discard,
    forgetEchoed,
    clearEnvironment,
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
 * arrives) and the rest render as pending bubbles after the last message. `echoed` lists the
 * `clientMessageId`s the stream already carries, even for a send whose reply never came back,
 * so the outbox can forget them and the author sees one bubble.
 */
export function splitKinOutbox(
  outbox: ReadonlyArray<KinOutboxEntry>,
  streamed: ReadonlyArray<KinMessage>,
): {
  readonly acked: ReadonlyArray<KinMessage>;
  readonly pending: ReadonlyArray<KinOutboxEntry>;
  readonly echoed: ReadonlyArray<string>;
} {
  if (outbox.length === 0) return { acked: [], pending: EMPTY, echoed: [] };
  // The host returns `clientMessageId` only to the message's author, which is who holds the outbox.
  const known = new Set(streamed.map((message) => message.clientMessageId));
  const acked: KinMessage[] = [];
  const pending: KinOutboxEntry[] = [];
  const echoed: string[] = [];
  for (const entry of outbox) {
    if (known.has(entry.clientMessageId)) echoed.push(entry.clientMessageId);
    else if (entry.sent === null) pending.push(entry);
    else acked.push(entry.sent);
  }
  return { acked, pending, echoed };
}
