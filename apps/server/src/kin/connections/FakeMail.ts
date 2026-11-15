// @effect-diagnostics nodeBuiltinImport:off globalDate:off - a dev and test fixture: PKCE, a JSON file, mail dates.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

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
  readonly body: string;
  readonly attachments: ReadonlyArray<string>;
  readonly unread: boolean;
  readonly sent: boolean;
};

export type FakeMailState = {
  readonly accounts: Array<FakeMailAccount>;
  readonly messages: Array<FakeMailMessage>;
  readonly events: Array<{ readonly account: string; readonly id: string; readonly json: unknown }>;
  readonly codes: Record<string, { readonly address: string; readonly challenge: string }>;
  /** The scopes each account last granted: what its sign-in asked for. */
  readonly granted: Record<string, string>;
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
  codes: {},
  granted: {},
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
      ? (JSON.parse(NodeFS.readFileSync(path, "utf8")) as FakeMailState)
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

/** The header block and text part of a MIME message as Kin builds it. */
const parseMime = (raw: string) => {
  const [head = "", ...rest] = raw.split(/\r?\n\r?\n/);
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at > 0) headers.set(lower(line.slice(0, at).trim()), line.slice(at + 1).trim());
  }
  const words = (value: string) =>
    value.replace(/=\?utf-8\?b\?([^?]*)\?=/gi, (_, data: string) =>
      Buffer.from(data, "base64").toString("utf8"),
    );
  const body = rest.join("\n\n");
  const textPart =
    /Content-Type: text\/plain[^\n]*\r?\nContent-Transfer-Encoding: base64\r?\n\r?\n([\s\S]*?)\r?\n--/i.exec(
      body,
    );
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
    text:
      textPart === null
        ? body
        : Buffer.from(textPart[1]!.replace(/\s+/g, ""), "base64").toString("utf8"),
    attachments: [...raw.matchAll(/filename="([^"]+)"/g)].map((match) => match[1]!),
  };
};

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

  /** Mail arriving at `to`, one of an account's addresses, in a new thread or an existing one. */
  const deliver = (input: {
    readonly to: string;
    readonly from: string;
    readonly subject: string;
    readonly body: string;
    readonly cc?: ReadonlyArray<string>;
    readonly threadId?: string;
    readonly at: number;
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
        messageId: `<${id}@${plain(input.from).split("@")[1] ?? "invented.example"}>`,
        inReplyTo: last?.messageId ?? null,
        references: last === undefined ? null : [last.references, last.messageId].join(" ").trim(),
        body: input.body,
        attachments: [],
        unread: true,
        sent: false,
      };
      state.messages.push(message);
      return message;
    });

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
      at: Math.max(0, ...state.messages.map((one) => one.at)) + 1,
      messageId: `<${id}@${account.address.split("@")[1]}>`,
      inReplyTo: mail.inReplyTo,
      references: mail.references,
      body: mail.text,
      attachments: mail.attachments,
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
      .filter((word) => word !== "" && !word.startsWith("in:") && !word.startsWith("after:"))
      .every((word) => {
        const from = /^from:(.+)$/.exec(word)?.[1];
        return from !== undefined
          ? lower(message.from).includes(lower(from))
          : lower(`${message.subject} ${message.body} ${message.from}`).includes(lower(word));
      });

  const gmailMessage = (message: FakeMailMessage) => ({
    id: message.id,
    threadId: message.threadId,
    labelIds: message.sent ? ["SENT"] : ["INBOX", ...(message.unread ? ["UNREAD"] : [])],
    snippet: message.body.slice(0, 100),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: message.from },
        { name: "To", value: message.to.join(", ") },
        ...(message.cc.length === 0 ? [] : [{ name: "Cc", value: message.cc.join(", ") }]),
        ...(message.sent ? [] : [{ name: "Delivered-To", value: message.account }]),
        { name: "Subject", value: message.subject },
        { name: "Date", value: rfc2822(message.at) },
        { name: "Message-ID", value: message.messageId },
        ...(message.references === null ? [] : [{ name: "References", value: message.references }]),
      ],
      body: { data: Buffer.from(message.body).toString("base64url") },
    },
  });

  const gmail = async (request: Request, url: URL) => {
    const body = request.method === "GET" ? undefined : await request.json();
    return edit((state) => {
      const account = bearer(state, request);
      if (account === undefined) return json({ error: { code: 401 } }, 401);
      const path = url.pathname;
      const mine = inbox(state, account);
      if (path === `${GMAIL}/profile`) return json({ emailAddress: account.address });
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
        const inboxOnly =
          url.searchParams.get("labelIds") === "INBOX" ||
          (url.searchParams.get("q") ?? "").includes("in:inbox");
        const found = mine.filter(
          (one) =>
            (!inboxOnly || !one.sent) &&
            one.at >= after * 1000 &&
            matches(one, url.searchParams.get("q") ?? ""),
        );
        const ids = [...new Set(found.toSorted((a, b) => b.at - a.at).map((one) => one.threadId))];
        return json({ threads: ids.map((id) => ({ id })) });
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
      if (/^\/calendar\/v3\/calendars\/[^/]+\/events/.test(path)) {
        if (request.method === "GET") return json({ items: [] });
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
    hasAttachments: false,
    body: { contentType: "text", content: message.body },
    internetMessageHeaders:
      message.references === null ? [] : [{ name: "References", value: message.references }],
  });
  const odata = (filter: string, field: string) =>
    new RegExp(`${field} (?:eq|ge) '?((?:[^']|'')*)'?`).exec(filter)?.[1]?.replaceAll("''", "'");

  const graph = async (request: Request, url: URL) => {
    const text = request.method === "POST" ? await request.text() : "";
    return edit((state) => {
      const account = bearer(state, request);
      if (account === undefined)
        return json({ error: { code: "InvalidAuthenticationToken" } }, 401);
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
        return json({
          value: mine
            .filter((one) => !one.sent && (since === undefined || iso(one.at) >= since))
            .map(graphMessage),
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
      if (/^\/v1\.0\/me\/messages\/[^/]+\/attachments$/.test(path)) return json({ value: [] });
      const mime = () => Buffer.from(text, "base64").toString("utf8");
      if (path === `${GRAPH}/sendMail`) {
        record(state, account, mime(), null);
        return new Response(null, { status: 202 });
      }
      const replyTo = /^\/v1\.0\/me\/messages\/([^/]+)\/reply$/.exec(path)?.[1];
      if (replyTo !== undefined) {
        const answered = mine.find((one) => one.id === decodeURIComponent(replyTo));
        if (answered === undefined) return json({ error: { code: "ErrorItemNotFound" } }, 404);
        record(state, account, mime(), answered.threadId);
        return new Response(null, { status: 202 });
      }
      if (/\/events$/.test(path)) {
        if (request.method === "GET") return json({ value: [] });
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

  return { addAccount, approve, setExpired, deliver, sent, handle, load: store.load };
};
export type FakeMail = ReturnType<typeof makeFakeMail>;
