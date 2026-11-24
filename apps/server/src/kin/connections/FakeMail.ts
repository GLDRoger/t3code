// @effect-diagnostics nodeBuiltinImport:off globalDate:off - a dev and test fixture: PKCE, a JSON file, mail dates.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { WEEK_MS } from "../durations.ts";

/**
 * A local mailbox that answers the Gmail, Google token, Microsoft Graph and Microsoft token calls
 * Kin's real providers make, so connecting, polling, reading and sending all run their real code
 * with nothing leaving the machine. For tests, and for `vp run dev` with `KIN_DEV_FAKE_MAIL`.
 */
export type FakeMailProvider = "google" | "microsoft";

export type FakeMailAccount = {
  readonly provider: FakeMailProvider;
  readonly address: string;
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
  readonly expired: boolean;
};

export type FakeMailMessage = {
  readonly id: string;
  readonly threadId: string;
  /** The account whose mailbox holds it. */
  readonly account: string;
  readonly from: string;
  readonly to: ReadonlyArray<string>;
  readonly cc: ReadonlyArray<string>;
  readonly subject: string;
  readonly at: number;
  readonly messageId: string;
  readonly inReplyTo: string | null;
  readonly references: string | null;
  /** `Authentication-Results` as the receiving server wrote them, topmost first. */
  readonly authResults?: ReadonlyArray<string>;
  readonly body: string;
  /** File names, for scripts and older mailbox files. */
  readonly attachments: ReadonlyArray<string>;
  /** The files themselves, as a real mailbox serves them. */
  readonly files?: ReadonlyArray<FakeMailFile>;
  readonly unread: boolean;
  readonly sent: boolean;
  /** The fake's revisions at which it entered the Inbox: a change record names each once. */
  readonly revs?: ReadonlyArray<number>;
  /** More headers as the vendor shows them, such as `List-Unsubscribe`. */
  readonly headers?: Readonly<Record<string, string>>;
  /** More Gmail labels, such as `CATEGORY_PROMOTIONS`. */
  readonly labels?: ReadonlyArray<string>;
};

export type FakeMailFile = {
  readonly name: string;
  readonly mimeType: string;
  /** The file's bytes, base64. */
  readonly data: string;
};

/** A calendar event as both vendors keep it; `repeats` makes it a weekly series of that many. */
export type FakeMailEvent = {
  readonly account: string;
  readonly id: string;
  readonly title: string;
  readonly start: number;
  readonly end: number;
  readonly updated: number;
  readonly state: "confirmed" | "cancelled" | "deleted";
  readonly repeats?: number;
  /** The fake's revision when it last changed: a delta round returns what moved past its own. */
  readonly rev: number;
};

export type FakeMailState = {
  readonly accounts: Array<FakeMailAccount>;
  readonly messages: Array<FakeMailMessage>;
  /** What Kin saved through a send card, as the vendor received it. */
  readonly events: Array<{ readonly account: string; readonly id: string; readonly json: unknown }>;
  readonly calendar: Array<FakeMailEvent>;
  readonly codes: Record<string, { readonly address: string; readonly challenge: string }>;
  /** The scopes each account last granted: what its sign-in asked for. */
  readonly granted: Record<string, string>;
  /** Outlook drafts made to be sent, by id. */
  readonly drafts: Record<
    string,
    { readonly account: string; readonly raw: string; readonly threadId: string }
  >;
  seq: number;
};

export interface FakeMailStore {
  readonly load: () => FakeMailState;
  readonly save: (state: FakeMailState) => void;
}

const emptyFakeMail = (): FakeMailState => ({
  accounts: [],
  messages: [],
  events: [],
  calendar: [],
  codes: {},
  granted: {},
  drafts: {},
  seq: 0,
});

const memoryStore = (state: FakeMailState = emptyFakeMail()): FakeMailStore => ({
  load: () => state,
  save: () => {},
});

/** The dev server's mailbox: one JSON file, read on every call, so a script can deliver to it. */
export const fileStore = (path: string): FakeMailStore => ({
  load: () =>
    NodeFS.existsSync(path)
      ? { ...emptyFakeMail(), ...(JSON.parse(NodeFS.readFileSync(path, "utf8")) as FakeMailState) }
      : emptyFakeMail(),
  save: (state) => NodeFS.writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`),
});

const GMAIL = "/gmail/v1/users/me";
const GRAPH = "/v1.0/me";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const lower = (text: string) => text.toLowerCase();
const plain = (who: string) => lower(/<([^<>]+)>/.exec(who)?.[1] ?? who).trim();
const nameIn = (who: string) => /^\s*"?([^"<]*?)"?\s*</.exec(who)?.[1]?.trim() || undefined;
const rfc2822 = (ms: number) => new Date(ms).toUTCString().replace("GMT", "+0000");
const iso = (ms: number) => new Date(ms).toISOString();
/** One page of `items` as the vendors cut them: `size` from an offset, and the offset after. */
const pageOf = <A>(items: ReadonlyArray<A>, size: string | null, offset: string | null) => {
  const from = Number(offset ?? 0);
  const to = size === null ? items.length : from + Number(size);
  return { items: items.slice(from, to), next: to < items.length ? String(to) : undefined };
};

const headerBlock = (head: string) => {
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at > 0) headers.set(lower(line.slice(0, at).trim()), line.slice(at + 1).trim());
  }
  return headers;
};
const split = (raw: string) => {
  const at = /\r?\n\r?\n/.exec(raw);
  return at === null
    ? { head: raw, body: "" }
    : { head: raw.slice(0, at.index), body: raw.slice(at.index + at[0].length) };
};
const decoded = (headers: Map<string, string>, body: string) =>
  lower(headers.get("content-transfer-encoding") ?? "") === "base64"
    ? Buffer.from(body.replace(/\s+/g, ""), "base64")
    : Buffer.from(body, "utf8");

/** A MIME message as Kin builds it: its headers, text part and attached files. */
const parseMime = (raw: string) => {
  const top = split(raw);
  const headers = headerBlock(top.head);
  const words = (value: string) =>
    value.replace(/=\?utf-8\?b\?([^?]*)\?=/gi, (_, data: string) =>
      Buffer.from(data, "base64").toString("utf8"),
    );
  const boundary = /boundary="?([^";]+)"?/i.exec(headers.get("content-type") ?? "")?.[1];
  const parts =
    boundary === undefined
      ? [{ headers, body: top.body }]
      : top.body
          .split(`--${boundary}`)
          .slice(1)
          .filter((part) => !part.startsWith("--"))
          .map((part) => {
            const one = split(part.replace(/^\r?\n/, ""));
            return { headers: headerBlock(one.head), body: one.body.replace(/\r?\n$/, "") };
          });
  const nameOf = (part: (typeof parts)[number]) =>
    /filename="([^"]+)"/i.exec(part.headers.get("content-disposition") ?? "")?.[1];
  const textPart = parts.find(
    (part) =>
      nameOf(part) === undefined &&
      lower(part.headers.get("content-type") ?? "text/plain").startsWith("text/plain"),
  );
  const files = parts.flatMap((part): ReadonlyArray<FakeMailFile> => {
    const name = nameOf(part);
    return name === undefined
      ? []
      : [
          {
            name,
            mimeType: (part.headers.get("content-type") ?? "application/octet-stream")
              .split(";")[0]!
              .trim(),
            data: decoded(part.headers, part.body).toString("base64"),
          },
        ];
  });
  const header = (name: string) => headers.get(name) ?? null;
  const list = (name: string) =>
    (header(name) ?? "")
      .split(",")
      .map((one) => one.trim())
      .filter((one) => one !== "");
  return {
    from: header("from"),
    to: list("to"),
    cc: list("cc"),
    subject: words(header("subject") ?? ""),
    inReplyTo: header("in-reply-to"),
    references: header("references"),
    text: textPart === undefined ? "" : decoded(textPart.headers, textPart.body).toString("utf8"),
    files,
  };
};

const sizeOf = (file: FakeMailFile) => Buffer.from(file.data, "base64").length;

export const makeFakeMail = (store: FakeMailStore = memoryStore()) => {
  const edit = <A>(change: (state: FakeMailState) => A) => {
    const state = store.load();
    const result = change(state);
    store.save(state);
    return result;
  };
  const next = (state: FakeMailState, prefix: string) => `${prefix}${++state.seq}`;
  const accountOf = (state: FakeMailState, address: string) =>
    state.accounts.find((one) => lower(one.address) === lower(address));
  const owns = (account: FakeMailAccount, address: string) =>
    [account.address, ...account.aliases].some((own) => lower(own) === plain(address));

  const addAccount = (
    account: Omit<FakeMailAccount, "expired" | "aliases"> & {
      readonly aliases?: ReadonlyArray<string>;
    },
  ) =>
    edit((state) => {
      if (accountOf(state, account.address) === undefined)
        state.accounts.push({ aliases: [], ...account, expired: false });
    });

  /** The owner approves at the "vendor": the browser comes back with a code for this account. */
  const approve = (authorizationUrl: string, address: string) =>
    edit((state) => {
      const url = new URL(authorizationUrl);
      const code = next(state, "fake-code-");
      state.codes[code] = { address, challenge: url.searchParams.get("code_challenge") ?? "" };
      state.granted[lower(address)] = url.searchParams.get("scope") ?? "";
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state")!);
      return back.toString();
    });

  /** A sign-in that stops working, as a revoked or expired grant does, and its way back. */
  const setExpired = (address: string, expired: boolean) =>
    edit((state) => {
      const index = state.accounts.findIndex((one) => lower(one.address) === lower(address));
      if (index >= 0) state.accounts[index] = { ...state.accounts[index]!, expired };
    });

  /** A mail service that answers but won't send for now, as during an outage. */
  const down = new Set<string>();
  const setDown = (address: string, isDown: boolean) =>
    isDown ? void down.add(lower(address)) : void down.delete(lower(address));
  /** Every call for the account answers this HTTP status, as a refusal or a throttle does. */
  const failing = new Map<string, number>();
  const failWith = (address: string, status: number | null) =>
    status === null
      ? void failing.delete(lower(address))
      : void failing.set(lower(address), status);
  const outage = (account: FakeMailAccount, request: Request) => {
    const status = failing.get(lower(account.address));
    if (status !== undefined) return json({ error: { code: status } }, status);
    return request.method === "POST" && down.has(lower(account.address))
      ? json({ error: { code: 503, message: "The service is unavailable." } }, 503)
      : undefined;
  };

  /** Adds or changes an event on an account's calendar; deleting keeps it, as a tombstone. */
  const putEvent = (event: Omit<FakeMailEvent, "rev" | "state"> & Partial<FakeMailEvent>) =>
    edit((state) => {
      const at = state.calendar.findIndex((one) => one.id === event.id);
      const next: FakeMailEvent = { state: "confirmed", ...event, rev: ++state.seq };
      if (at >= 0) state.calendar[at] = next;
      else state.calendar.push(next);
    });

  /** Mail arriving at `to`, one of an account's addresses, in a new thread or an existing one. */
  const deliver = (input: {
    readonly to: string;
    readonly from: string;
    readonly subject: string;
    readonly body: string;
    readonly cc?: ReadonlyArray<string>;
    readonly threadId?: string;
    readonly at: number;
    readonly files?: ReadonlyArray<FakeMailFile>;
    readonly headers?: Readonly<Record<string, string>>;
    readonly labels?: ReadonlyArray<string>;
    /** The Message-ID header, as the sender's server wrote it. */
    readonly messageId?: string;
    readonly authResults?: ReadonlyArray<string>;
  }) =>
    edit((state) => {
      const account = state.accounts.find((one) => owns(one, input.to));
      if (account === undefined) throw new Error(`No fake account receives ${input.to}.`);
      const earlier = state.messages.filter(
        (one) => one.account === account.address && one.threadId === input.threadId,
      );
      const last = earlier.at(-1);
      const id = next(state, "fm");
      const message: FakeMailMessage = {
        id,
        threadId: input.threadId ?? next(state, "ft"),
        account: account.address,
        from: input.from,
        to: [input.to],
        cc: input.cc ?? [],
        subject: input.subject,
        at: input.at,
        messageId:
          input.messageId ?? `<${id}@${plain(input.from).split("@")[1] ?? "invented.example"}>`,
        inReplyTo: last?.messageId ?? null,
        references: last === undefined ? null : [last.references, last.messageId].join(" ").trim(),
        ...(input.authResults === undefined ? {} : { authResults: input.authResults }),
        body: input.body,
        attachments: (input.files ?? []).map((file) => file.name),
        files: input.files ?? [],
        unread: true,
        sent: false,
        ...(input.headers === undefined ? {} : { headers: input.headers }),
        ...(input.labels === undefined ? {} : { labels: input.labels }),
      };
      const stored = { ...message, revs: [++state.seq] };
      state.messages.push(stored);
      return stored;
    });

  /** A message put back into the Inbox (or labelled Inbox again): its record comes again. */
  const relabel = (messageId: string) =>
    edit((state) => {
      const at = state.messages.findIndex((one) => one.id === messageId);
      if (at < 0) throw new Error(`No fake message ${messageId}.`);
      const one = state.messages[at]!;
      state.messages[at] = { ...one, revs: [...(one.revs ?? []), ++state.seq] };
    });
  /** The vendor forgets every change position up to now, as an expired history id or delta. */
  const forgotten = new Map<string, number>();
  const forgetPositions = (address: string) =>
    edit((state) => void forgotten.set(lower(address), state.seq++));
  /** Reads of one message answer this HTTP status, as an unreadable message does. */
  const unreadable = new Map<string, number>();
  const failRead = (messageId: string, status: number | null) =>
    status === null ? void unreadable.delete(messageId) : void unreadable.set(messageId, status);
  const revsOf = (message: FakeMailMessage) => message.revs ?? [];
  const headersOf = (message: FakeMailMessage) =>
    Object.entries(message.headers ?? {}).map(([name, value]) => ({ name, value }));

  const sent = () => store.load().messages.filter((one) => one.sent);

  const record = (
    state: FakeMailState,
    account: FakeMailAccount,
    raw: string,
    threadId: string | null,
  ) => {
    const mail = parseMime(raw);
    const id = next(state, "fs");
    const message: FakeMailMessage = {
      id,
      threadId: threadId ?? next(state, "ft"),
      account: account.address,
      from: mail.from ?? account.address,
      to: mail.to,
      cc: mail.cc,
      subject: mail.subject,
      // Sent now, and after anything already in the box so threads keep their order.
      at: Math.max(Date.now(), ...state.messages.map((one) => one.at + 1)),
      messageId: `<${id}@${account.address.split("@")[1]}>`,
      inReplyTo: mail.inReplyTo,
      references: mail.references,
      body: mail.text,
      attachments: mail.files.map((file) => file.name),
      files: mail.files,
      unread: false,
      sent: true,
    };
    state.messages.push(message);
    return message;
  };

  const token = async (request: Request) => {
    const form = new URLSearchParams(await request.text());
    return edit((state) => {
      if (form.get("grant_type") === "authorization_code") {
        const issued = state.codes[form.get("code") ?? ""];
        delete state.codes[form.get("code") ?? ""];
        const verifier = form.get("code_verifier") ?? "";
        const challenge = NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
        if (issued === undefined || challenge !== issued.challenge)
          return json({ error: "invalid_grant" }, 400);
        return tokens(state, issued.address);
      }
      const address = /^fake-rt\.(.+)$/.exec(form.get("refresh_token") ?? "")?.[1];
      const account = address === undefined ? undefined : accountOf(state, address);
      if (account === undefined || account.expired) return json({ error: "invalid_grant" }, 400);
      return tokens(state, account.address);
    });
  };
  const tokens = (state: FakeMailState, address: string) =>
    json({
      access_token: `fake-at.${next(state, "")}.${address}`,
      refresh_token: `fake-rt.${address}`,
      expires_in: 3600,
      scope: state.granted[lower(address)] ?? "",
    });
  const bearer = (state: FakeMailState, request: Request) => {
    const address = /^Bearer fake-at\.\d+\.(.+)$/.exec(
      request.headers.get("authorization") ?? "",
    )?.[1];
    const account = address === undefined ? undefined : accountOf(state, address);
    return account === undefined || account.expired ? undefined : account;
  };
  const inbox = (state: FakeMailState, account: FakeMailAccount) =>
    state.messages.filter((one) => one.account === account.address);
  const matches = (message: FakeMailMessage, words: string) =>
    words
      .split(/\s+/)
      .filter((word) => word !== "" && !/^(?:in|after|before):/.test(word))
      .every((word) => {
        const from = /^from:(.+)$/.exec(word)?.[1];
        return from !== undefined
          ? lower(message.from).includes(lower(from))
          : lower(`${message.subject} ${message.body} ${message.from}`).includes(lower(word));
      });

  const authHeaders = (message: FakeMailMessage) =>
    (message.authResults ?? []).map((value) => ({ name: "Authentication-Results", value }));
  const gmailMessage = (message: FakeMailMessage) => ({
    id: message.id,
    threadId: message.threadId,
    labelIds: [
      ...(message.sent ? ["SENT"] : ["INBOX", ...(message.unread ? ["UNREAD"] : [])]),
      ...(message.labels ?? []),
    ],
    snippet: message.body.slice(0, 100),
    payload: {
      mimeType: (message.files ?? []).length === 0 ? "text/plain" : "multipart/mixed",
      headers: [
        { name: "From", value: message.from },
        { name: "To", value: message.to.join(", ") },
        ...(message.cc.length === 0 ? [] : [{ name: "Cc", value: message.cc.join(", ") }]),
        ...(message.sent ? [] : [{ name: "Delivered-To", value: message.account }]),
        { name: "Subject", value: message.subject },
        { name: "Date", value: rfc2822(message.at) },
        { name: "Message-ID", value: message.messageId },
        ...(message.references === null ? [] : [{ name: "References", value: message.references }]),
        ...authHeaders(message),
        ...headersOf(message),
      ],
      ...((message.files ?? []).length === 0
        ? { body: { data: Buffer.from(message.body).toString("base64url") } }
        : {
            body: { size: 0 },
            parts: [
              {
                partId: "0",
                mimeType: "text/plain",
                filename: "",
                body: { data: Buffer.from(message.body).toString("base64url") },
              },
              ...(message.files ?? []).map((file, index) => ({
                partId: String(index + 1),
                mimeType: file.mimeType,
                filename: file.name,
                body: { attachmentId: `${message.id}-a${index}`, size: sizeOf(file) },
              })),
            ],
          }),
    },
  });

  type Occurrence = {
    readonly event: FakeMailEvent;
    readonly id: string;
    readonly start: number;
    readonly end: number;
    readonly kind: "single" | "master" | "instance";
  };
  /** An account's events, each series as its master or as one item per week. */
  const occurrences = (state: FakeMailState, account: FakeMailAccount, expand: boolean) =>
    state.calendar
      .filter((event) => event.account === account.address)
      .flatMap((event): ReadonlyArray<Occurrence> =>
        event.repeats === undefined
          ? [{ event, id: event.id, start: event.start, end: event.end, kind: "single" }]
          : expand
            ? Array.from({ length: event.repeats }, (_, week) => ({
                event,
                id: `${event.id}_${week}`,
                start: event.start + week * WEEK_MS,
                end: event.end + week * WEEK_MS,
                kind: "instance" as const,
              }))
            : [{ event, id: event.id, start: event.start, end: event.end, kind: "master" }],
      );
  const googleEvent = (item: Occurrence) => ({
    kind: "calendar#event",
    id: item.id,
    status: item.event.state === "confirmed" ? "confirmed" : "cancelled",
    summary: item.event.title,
    start: { dateTime: iso(item.start) },
    end: { dateTime: iso(item.end) },
    updated: iso(item.event.updated),
    organizer: { email: item.event.account },
    attendees: [],
    ...(item.kind === "instance"
      ? { recurringEventId: item.event.id, originalStartTime: { dateTime: iso(item.start) } }
      : item.kind === "master"
        ? { recurrence: [`RRULE:FREQ=WEEKLY;COUNT=${item.event.repeats}`] }
        : {}),
  });
  const graphTime = (ms: number) => ({
    dateTime: iso(ms).replace(/\.\d+Z$/, ".0000000"),
    timeZone: "UTC",
  });
  const graphEvent = (item: Occurrence) => ({
    "@odata.type": "#microsoft.graph.event",
    id: item.id,
    subject: item.event.title,
    isCancelled: item.event.state === "cancelled",
    isAllDay: false,
    start: graphTime(item.start),
    end: graphTime(item.end),
    lastModifiedDateTime: iso(item.event.updated),
    type: { single: "singleInstance", master: "seriesMaster", instance: "occurrence" }[item.kind],
    seriesMasterId: item.kind === "instance" ? item.event.id : null,
    organizer: { emailAddress: { address: item.event.account } },
    attendees: [],
    location: { displayName: "" },
    bodyPreview: "",
    body: { contentType: "html", content: "" },
  });

  const gmail = async (request: Request, url: URL) => {
    const body = request.method === "GET" ? undefined : await request.json();
    return edit((state) => {
      const account = bearer(state, request);
      if (account === undefined) return json({ error: { code: 401 } }, 401);
      const unavailable = outage(account, request);
      if (unavailable !== undefined) return unavailable;
      const path = url.pathname;
      const mine = inbox(state, account);
      if (path === `${GMAIL}/profile`)
        return json({ emailAddress: account.address, historyId: String(state.seq) });
      if (path === `${GMAIL}/history`) {
        const start = Number(url.searchParams.get("startHistoryId") ?? Number.NaN);
        if (!Number.isSafeInteger(start) || start <= (forgotten.get(lower(account.address)) ?? -1))
          return json({ error: { code: 404 } }, 404);
        const records = mine
          .filter((one) => !one.sent)
          .flatMap((one) =>
            revsOf(one)
              .map((rev, index) => ({ one, rev, first: index === 0 }))
              .filter(({ rev }) => rev > start),
          )
          .toSorted((a, b) => a.rev - b.rev)
          .map(({ one, rev, first }) => {
            const message = { id: one.id, threadId: one.threadId, labelIds: ["INBOX"] };
            return first
              ? { id: String(rev), messagesAdded: [{ message }] }
              : { id: String(rev), labelsAdded: [{ message, labelIds: ["INBOX"] }] };
          });
        const page = pageOf(
          records,
          url.searchParams.get("maxResults"),
          url.searchParams.get("pageToken"),
        );
        return json({
          historyId: String(state.seq),
          ...(page.items.length === 0 ? {} : { history: page.items }),
          ...(page.next === undefined ? {} : { nextPageToken: page.next }),
        });
      }
      const single = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(path)?.[1];
      if (single !== undefined && request.method === "GET") {
        const one = mine.find((message) => message.id === decodeURIComponent(single));
        if (one === undefined) return json({ error: { code: 404 } }, 404);
        const failed = unreadable.get(one.id);
        if (failed !== undefined) return json({ error: { code: failed } }, failed);
        const full = gmailMessage(one);
        const asked = new Set(url.searchParams.getAll("metadataHeaders").map(lower));
        const headers = [
          ...full.payload.headers,
          {
            name: "Content-Type",
            value: (one.files ?? []).length === 0 ? "text/plain" : "multipart/mixed; boundary=x",
          },
        ].filter((header) => asked.size === 0 || asked.has(lower(header.name)));
        return json({
          id: one.id,
          threadId: one.threadId,
          labelIds: full.labelIds,
          snippet: full.snippet,
          internalDate: String(one.at),
          payload: { mimeType: full.payload.mimeType, headers },
        });
      }
      if (path === `${GMAIL}/settings/sendAs`)
        return json({
          sendAs: [
            {
              sendAsEmail: account.address,
              displayName: account.name,
              isPrimary: true,
              isDefault: true,
            },
            ...account.aliases.map((alias) => ({
              sendAsEmail: alias,
              displayName: account.name,
              verificationStatus: "accepted",
            })),
          ],
        });
      if (path === `${GMAIL}/threads`) {
        const after = Number(/after:(\d+)/.exec(url.searchParams.get("q") ?? "")?.[1] ?? 0);
        const before = Number(
          /before:(\d+)/.exec(url.searchParams.get("q") ?? "")?.[1] ?? Infinity,
        );
        const inboxOnly =
          url.searchParams.get("labelIds") === "INBOX" ||
          (url.searchParams.get("q") ?? "").includes("in:inbox");
        const found = mine.filter(
          (one) =>
            (!inboxOnly || !one.sent) &&
            one.at >= after * 1000 &&
            one.at < before * 1000 &&
            matches(one, url.searchParams.get("q") ?? ""),
        );
        const ids = [...new Set(found.toSorted((a, b) => b.at - a.at).map((one) => one.threadId))];
        const page = pageOf(
          ids,
          url.searchParams.get("maxResults"),
          url.searchParams.get("pageToken"),
        );
        return json({
          threads: page.items.map((id) => ({ id })),
          ...(page.next === undefined ? {} : { nextPageToken: page.next }),
        });
      }
      const thread = /^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/.exec(path)?.[1];
      if (thread !== undefined) {
        const messages = mine.filter((one) => one.threadId === decodeURIComponent(thread));
        if (messages.length === 0) return json({ error: { code: 404 } }, 404);
        return json({ id: messages[0]!.threadId, messages: messages.map(gmailMessage) });
      }
      if (path === `${GMAIL}/messages/send` && request.method === "POST") {
        const { raw, threadId } = body as { raw: string; threadId?: string };
        const message = record(
          state,
          account,
          Buffer.from(raw, "base64url").toString("utf8"),
          threadId ?? null,
        );
        return json({ id: message.id, threadId: message.threadId });
      }
      const eventPath = /^\/calendar\/v3\/calendars\/[^/]+\/events(?:\/([^/]+))?$/.exec(path);
      if (eventPath !== null && request.method === "GET") {
        const params = url.searchParams;
        const singles = params.get("singleEvents") === "true";
        const items = occurrences(state, account, singles).filter(
          ({ event, start, end }) =>
            (params.get("showDeleted") === "true" || event.state === "confirmed") &&
            event.updated >= Date.parse(params.get("updatedMin") ?? "1970-01-01T00:00:00Z") &&
            end > Date.parse(params.get("timeMin") ?? "1970-01-01T00:00:00Z") &&
            start < Date.parse(params.get("timeMax") ?? "9999-01-01T00:00:00Z") &&
            lower(event.title).includes(lower(params.get("q") ?? "")),
        );
        if (eventPath[1] === undefined) {
          const page = pageOf(
            params.get("orderBy") === "updated"
              ? items.toSorted((a, b) => a.event.updated - b.event.updated)
              : items,
            params.get("maxResults"),
            params.get("pageToken"),
          );
          return json({
            items: page.items.map(googleEvent),
            ...(page.next === undefined ? {} : { nextPageToken: page.next }),
          });
        }
        const one = occurrences(state, account, true).find(
          (item) => item.id === decodeURIComponent(eventPath[1]!),
        );
        return one === undefined ? json({ error: { code: 404 } }, 404) : json(googleEvent(one));
      }
      if (eventPath !== null) {
        const id = next(state, "fev");
        state.events.push({ account: account.address, id, json: body });
        return json({ id });
      }
      return json({ error: { code: 404 } }, 404);
    });
  };

  const who = (address: string) => ({
    emailAddress: {
      address: plain(address),
      ...(nameIn(address) ? { name: nameIn(address) } : {}),
    },
  });
  const graphMessage = (message: FakeMailMessage) => ({
    id: message.id,
    conversationId: message.threadId,
    subject: message.subject,
    from: who(message.from),
    toRecipients: message.to.map(who),
    ccRecipients: message.cc.map(who),
    receivedDateTime: iso(message.at),
    isRead: !message.unread,
    bodyPreview: message.body.slice(0, 100),
    internetMessageId: message.messageId,
    hasAttachments: (message.files ?? []).length > 0,
    body: { contentType: "text", content: message.body },
    internetMessageHeaders: [
      ...headersOf(message),
      ...authHeaders(message),
      ...(message.references === null ? [] : [{ name: "References", value: message.references }]),
    ],
  });
  const odata = (filter: string, field: string) =>
    new RegExp(`${field} (?:eq|ge) '?((?:[^']|'')*)'?`).exec(filter)?.[1]?.replaceAll("''", "'");

  const graph = async (request: Request, url: URL) => {
    const text = request.method === "POST" ? await request.text() : "";
    return edit((state) => {
      const account = bearer(state, request);
      if (account === undefined)
        return json({ error: { code: "InvalidAuthenticationToken" } }, 401);
      const unavailable = outage(account, request);
      if (unavailable !== undefined) return unavailable;
      const path = url.pathname;
      const mine = inbox(state, account).toSorted((a, b) => b.at - a.at);
      const filter = url.searchParams.get("$filter") ?? "";
      if (path === GRAPH)
        return json({
          displayName: account.name,
          mail: account.address,
          proxyAddresses: [
            `SMTP:${account.address}`,
            ...account.aliases.map((alias) => `smtp:${alias}`),
          ],
        });
      if (path === `${GRAPH}/mailFolders/inbox/messages`) {
        const since = odata(filter, "receivedDateTime");
        const found = mine.filter(
          (one) => !one.sent && (since === undefined || iso(one.at) >= since),
        );
        const page = pageOf(
          url.searchParams.get("$orderby")?.endsWith(" asc") ? found.toReversed() : found,
          url.searchParams.get("$top"),
          url.searchParams.get("$skip"),
        );
        const nextLink = new URL(url);
        nextLink.searchParams.set("$skip", page.next ?? "");
        return json({
          value: page.items.map(graphMessage),
          ...(page.next === undefined ? {} : { "@odata.nextLink": nextLink.href }),
        });
      }
      if (path === `${GRAPH}/messages` && request.method === "GET") {
        const conversation = odata(filter, "conversationId");
        const internet = odata(filter, "internetMessageId");
        const search = url.searchParams.get("$search")?.replace(/^"|"$/g, "");
        return json({
          value: mine
            .filter((one) =>
              conversation !== undefined
                ? one.threadId === conversation
                : internet !== undefined
                  ? one.messageId === internet
                  : search === undefined || matches(one, search),
            )
            .map(graphMessage),
        });
      }
      if (path === `${GRAPH}/mailFolders/inbox/messages/delta`) {
        const token = url.searchParams.get("$deltatoken");
        const rounds = token === null ? undefined : Number(token);
        if (rounds !== undefined && rounds <= (forgotten.get(lower(account.address)) ?? -1))
          return json({ error: { code: "syncStateNotFound" } }, 410);
        const after = /receivedDateTime gt (\S+)/.exec(filter)?.[1];
        const value = mine
          .filter((one) => !one.sent)
          .filter((one) =>
            rounds === undefined
              ? after === undefined || iso(one.at) > after
              : revsOf(one).some((rev) => rev > rounds),
          )
          .map((one) => ({ id: one.id, conversationId: one.threadId }));
        return json({
          value,
          "@odata.deltaLink": `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=${state.seq}`,
        });
      }
      const singleMessage = /^\/v1\.0\/me\/messages\/([^/]+)$/.exec(path)?.[1];
      if (singleMessage !== undefined && request.method === "GET") {
        const one = mine.find((message) => message.id === decodeURIComponent(singleMessage));
        if (one === undefined) return json({ error: { code: "ErrorItemNotFound" } }, 404);
        const failed = unreadable.get(one.id);
        if (failed !== undefined)
          return json({ error: { code: "ErrorInternalServerError" } }, failed);
        const shown = graphMessage(one);
        return json({
          ...shown,
          internetMessageHeaders: [
            ...shown.internetMessageHeaders,
            { name: "Message-ID", value: one.messageId },
          ],
        });
      }
      const attachmentsOf = /^\/v1\.0\/me\/messages\/([^/]+)\/attachments$/.exec(path)?.[1];
      if (attachmentsOf !== undefined) {
        const message = mine.find((one) => one.id === decodeURIComponent(attachmentsOf));
        if (message === undefined) return json({ error: { code: "ErrorItemNotFound" } }, 404);
        return json({
          value: (message.files ?? []).map((file, index) => ({
            "@odata.type": "#microsoft.graph.fileAttachment",
            id: `${message.id}-a${index}`,
            name: file.name,
            contentType: file.mimeType,
            size: sizeOf(file),
            contentBytes: file.data,
          })),
        });
      }
      const mime = () => Buffer.from(text, "base64").toString("utf8");
      if (path === `${GRAPH}/messages` && request.method === "POST") {
        const id = next(state, "fd");
        const threadId = next(state, "ft");
        state.drafts[id] = { account: account.address, raw: mime(), threadId };
        return json({ id, conversationId: threadId }, 201);
      }
      const draftSent = /^\/v1\.0\/me\/messages\/([^/]+)\/send$/.exec(path)?.[1];
      if (draftSent !== undefined) {
        const draft = state.drafts[decodeURIComponent(draftSent)];
        if (draft === undefined || draft.account !== account.address)
          return json({ error: { code: "ErrorItemNotFound" } }, 404);
        delete state.drafts[decodeURIComponent(draftSent)];
        record(state, account, draft.raw, draft.threadId);
        return new Response(null, { status: 202 });
      }
      const replyTo = /^\/v1\.0\/me\/messages\/([^/]+)\/reply$/.exec(path)?.[1];
      if (replyTo !== undefined) {
        const answered = mine.find((one) => one.id === decodeURIComponent(replyTo));
        if (answered === undefined) return json({ error: { code: "ErrorItemNotFound" } }, 404);
        record(state, account, mime(), answered.threadId);
        return new Response(null, { status: 202 });
      }
      if (path === `${GRAPH}/calendarView/delta`) {
        const since = url.searchParams.get("$deltatoken");
        const from = Date.parse(url.searchParams.get("startDateTime") ?? "1970-01-01T00:00:00Z");
        const until = Date.parse(url.searchParams.get("endDateTime") ?? "9999-01-01T00:00:00Z");
        const rounds = since === null ? undefined : Number(since);
        const value = occurrences(state, account, true)
          .filter(({ event, start, end }) =>
            rounds === undefined
              ? event.state !== "deleted" && end > from && start < until
              : event.rev > rounds,
          )
          .map((item) =>
            item.event.state === "deleted"
              ? {
                  "@odata.type": "#microsoft.graph.event",
                  id: item.id,
                  "@removed": { reason: "deleted" },
                }
              : graphEvent(item),
          );
        return json({
          "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#Collection(event)",
          "@odata.deltaLink": `https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=${state.seq}`,
          value,
        });
      }
      if (/\/calendarView$/.test(path)) {
        const from = Date.parse(url.searchParams.get("startDateTime") ?? "1970-01-01T00:00:00Z");
        const until = Date.parse(url.searchParams.get("endDateTime") ?? "9999-01-01T00:00:00Z");
        return json({
          value: occurrences(state, account, true)
            .filter(
              ({ event, start, end }) => event.state !== "deleted" && end > from && start < until,
            )
            .map(graphEvent),
        });
      }
      const graphEventId = /\/events\/([^/]+)$/.exec(path)?.[1];
      if (graphEventId !== undefined && request.method === "GET") {
        const one = occurrences(state, account, true).find(
          (item) => item.id === decodeURIComponent(graphEventId) && item.event.state !== "deleted",
        );
        return one === undefined
          ? json({ error: { code: "ErrorItemNotFound" } }, 404)
          : json(graphEvent(one));
      }
      if (/\/events$/.test(path)) {
        if (request.method === "GET") {
          // A list of events holds single ones and each series' master, never its occurrences.
          const since = odata(filter, "lastModifiedDateTime");
          return json({
            value: occurrences(state, account, false)
              .filter(
                ({ event }) =>
                  event.state !== "deleted" &&
                  (since === undefined || event.updated >= Date.parse(since)),
              )
              .map(graphEvent),
          });
        }
        const id = next(state, "fev");
        state.events.push({ account: account.address, id, json: JSON.parse(text) });
        return json({ id }, 201);
      }
      return json({ error: { code: "ErrorItemNotFound" } }, 404);
    });
  };

  /** Answers for the vendors' hosts; anything else goes to `fallback`. */
  const handle = (fallback: typeof globalThis.fetch) =>
    Object.assign(
      (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.host === "oauth2.googleapis.com" || url.host === "login.microsoftonline.com")
          return token(request);
        if (url.host === "gmail.googleapis.com" || url.host === "www.googleapis.com")
          return gmail(request, url);
        if (url.host === "graph.microsoft.com") return graph(request, url);
        return fallback(request);
      },
      { preconnect() {} },
    ) satisfies typeof globalThis.fetch;

  return {
    addAccount,
    approve,
    setExpired,
    setDown,
    failWith,
    deliver,
    relabel,
    forgetPositions,
    failRead,
    putEvent,
    sent,
    handle,
    load: store.load,
  };
};
export type FakeMail = ReturnType<typeof makeFakeMail>;
