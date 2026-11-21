import { describe, expect, it } from "@effect/vitest";
import {
  KinChatError,
  KinConnectionId,
  KinOrgId,
  type KinConnection,
  type KinConnectionAddInput,
  type KinConnectionCall,
  type KinConnectionDetail,
  type KinConnectionService,
  type KinConnectionTool,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Redacted from "effect/Redacted";
import { AsyncResult } from "effect/reactivity";

import {
  createKinConnectionActions,
  kinAcceptAll,
  kinConnectionAddCheck,
  kinConnectionDraft,
  kinConnectionStatus,
  KIN_OWNER_CLIENT_SETUP,
  kinSignInCheck,
  kinSignInClientCheck,
  kinSuggestedModes,
  kinMailModes,
  kinMailPermission,
  kinUseRow,
  kinToolRows,
  kinToolMark,
} from "./kinConnections.ts";

const orgId = KinOrgId.make("org");
const connectionId = KinConnectionId.make("conn_1");
const services: ReadonlyArray<KinConnectionService> = [
  {
    service: "posthog",
    label: "PostHog",
    available: true,
    setup: "Make a key.",
    connect: "key",
    fields: ["key"],
    needsSetup: false,
  },
  {
    service: "sentry",
    label: "Sentry",
    available: true,
    setup: null,
    connect: "sign_in",
    fields: ["org"],
    needsSetup: false,
  },
  {
    service: "zoho_books",
    label: "Zoho Books",
    available: true,
    setup: null,
    connect: "sign_in",
    fields: ["secretUrl"],
    needsSetup: false,
  },
  {
    service: "google",
    label: "Google",
    available: true,
    setup: null,
    connect: "sign_in",
    fields: [],
    needsSetup: true,
  },
  {
    service: "custom",
    label: "Another service",
    available: true,
    setup: null,
    connect: "key",
    fields: ["url", "key"],
    needsSetup: false,
  },
];

const definition = (description: string, inputSchema: unknown = { type: "object" }) => ({
  name: "query",
  title: null,
  description,
  inputSchema,
  annotations: { readOnlyHint: true },
});
const tool = (overrides: Partial<KinConnectionTool>): KinConnectionTool => ({
  connectionId,
  name: "query",
  definition: definition("Run a query."),
  accepted: null,
  pinDigest: "d1",
  mode: "off",
  suggestedMode: "read",
  openWorld: false,
  changed: false,
  firstSeenAt: 0,
  changedAt: null,
  acceptedAt: null,
  removedAt: null,
  ...overrides,
});
const connection = (overrides: Partial<KinConnection> = {}): KinConnection => ({
  connectionId,
  preset: "posthog",
  label: "PostHog",
  kind: "remote",
  url: "https://mcp.posthog.com/mcp",
  urlHost: "mcp.posthog.com",
  auth: "key",
  reach: "closed",
  state: "active",
  paused: false,
  accountLabel: null,
  protocolVersion: null,
  instructions: null,
  instructionsDigest: null,
  acceptedInstructions: null,
  changedTools: 0,
  readTools: 0,
  createdAt: 0,
  updatedAt: 0,
  listedAt: 0,
  lastOkAt: 0,
  lastError: null,
  ...overrides,
});

describe("kinToolRows", () => {
  it("shows a changed tool first, with what changed, and accepts it at the digest shown", () => {
    const changed = tool({
      name: "query",
      mode: "read",
      changed: true,
      pinDigest: "d2",
      definition: definition("Run any query, and export.", { type: "object", required: ["q"] }),
      accepted: definition("Run a query."),
    });
    const rows = kinToolRows([
      tool({ name: "alpha", mode: "read" }),
      changed,
      tool({ name: "gone", removedAt: 5 }),
    ]);
    expect(rows.map((row) => [row.name, row.state])).toEqual([
      ["query", "changed"],
      ["alpha", "on"],
    ]);
    expect(rows[0]!.change).toEqual({
      before: "Run a query.",
      after: "Run any query, and export.",
      inputsChanged: true,
      labelsChanged: false,
    });
    const status = kinConnectionStatus(connection({ state: "needs_review", changedTools: 1 }));
    expect([status.tone, status.detail]).toEqual([
      "attention",
      "1 tool changed since you allowed it.",
    ]);
    expect(kinAcceptAll({ orgId, connectionId }, connection(), rows).tools).toEqual([
      { tool: "query", digest: "d2" },
    ]);
    // A changed tool is never switched on by "suggested"; switching names the digest shown.
    expect(kinSuggestedModes(rows)).toEqual([]);
    expect(kinToolMark(rows[1]!, "read")).toEqual([{ tool: "alpha", mode: "read", digest: "d1" }]);
    expect(kinToolMark(rows[1]!, "ask")).toEqual([{ tool: "alpha", mode: "ask", digest: "d1" }]);
    expect(kinToolMark(rows[1]!, "off")).toEqual([{ tool: "alpha", mode: "off" }]);
    // A tool that sends is never offered Read, and "suggested" sets it to Ask me.
    const [send] = kinToolRows([
      tool({ name: "mail_send", suggestedMode: "ask", alwaysAsk: true }),
    ]);
    expect(send!.modes).toEqual(["off", "ask"]);
    expect(kinSuggestedModes([send!])).toEqual([
      { tool: "mail_send", mode: "ask", digest: send!.digest },
    ]);
  });

  it("asks a sign-in from before sending to sign in again", () => {
    expect(kinConnectionStatus(connection({ needsSignInToSend: true })).label).toBe(
      "Sign in to send",
    );
  });

  it("says paused or broken before anything else", () => {
    expect(kinConnectionStatus(connection({ paused: true, lastError: "x" })).label).toBe("Paused");
    expect(
      kinConnectionStatus(
        connection({ state: "error", lastError: "mcp.posthog.com refused the key (401)." }),
      ).detail,
    ).toBe("The service didn't accept the key. Make a new key there and use Replace key.");
    expect(
      kinConnectionStatus(
        connection({ state: "needs_sign_in", lastError: "Sentry's sign-in expired." }),
      ).label,
    ).toBe("Needs sign-in");
  });
});

describe("kinConnectionAddCheck", () => {
  it("asks for what is missing and sends the key redacted", () => {
    const draft = kinConnectionDraft("posthog");
    expect(kinConnectionAddCheck(orgId, draft, services)).toEqual({
      ok: false,
      problem: "Paste your PostHog key to connect.",
    });
    expect(kinConnectionAddCheck(orgId, kinConnectionDraft("sentry"), services).ok).toBe(false);
    const custom = { ...kinConnectionDraft("custom"), url: "http://mcp.example.com" };
    expect(kinConnectionAddCheck(orgId, custom, services)).toEqual({
      ok: false,
      problem: "The address should start with https://.",
    });
    const open = kinConnectionAddCheck(
      orgId,
      { ...custom, url: " https://mcp.example.com/mcp " },
      services,
    );
    expect(open).toEqual({
      ok: true,
      input: { orgId, service: "custom", url: "https://mcp.example.com/mcp", auth: "none" },
    });
    const keyed = kinConnectionAddCheck(orgId, { ...draft, key: " phx_invented " }, services);
    if (!keyed.ok) throw new Error(keyed.problem);
    expect(Redacted.isRedacted(keyed.input.key)).toBe(true);
    expect(Redacted.value(keyed.input.key!)).toBe("phx_invented");
    expect(JSON.stringify(keyed.input)).not.toContain("phx_invented");
  });
});

describe("kinSignInCheck", () => {
  it.each([
    [{ service: "posthog" as const }, "That service connects with a key."],
    [{ service: "google" as const }, "Set up Google first."],
    [
      { service: "sentry" as const, org: "my org" },
      "Use the organization's short name, as in its address.",
    ],
    [{ service: "zoho_books" as const }, "Paste the server address Zoho Books gave you."],
    [
      { service: "zoho_books" as const, secretUrl: "http://x.zohomcp.com/mcp" },
      "The address should start with https://.",
    ],
  ])("asks for what is missing: %o", (fields, problem) => {
    const draft = { ...kinConnectionDraft(fields.service), ...fields };
    expect(kinSignInCheck(orgId, draft, services, "web")).toEqual({ ok: false, problem });
  });

  it("sends only the fields the service takes, the secret address redacted", () => {
    const sentry = kinSignInCheck(
      orgId,
      { ...kinConnectionDraft("sentry"), org: " invented-co ", secretUrl: "https://x.example" },
      services,
      "app",
    );
    expect(sentry).toEqual({
      ok: true,
      input: { orgId, service: "sentry", returnTo: "app", org: "invented-co" },
    });
    const zoho = kinSignInCheck(
      orgId,
      { ...kinConnectionDraft("zoho_books"), secretUrl: "https://kin-1.zohomcp.com/mcp/k/message" },
      services,
      "web",
    );
    if (!zoho.ok) throw new Error(zoho.problem);
    expect(Redacted.isRedacted(zoho.input.secretUrl)).toBe(true);
    expect(JSON.stringify(zoho.input)).not.toContain("zohomcp");
  });

  it("checks the pasted Google client and Microsoft app", () => {
    expect(kinSignInClientCheck(orgId, "google", "123-abc", "s").ok).toBe(false);
    // The host's rule, whole: a client ID with a space is refused here, not at the host.
    expect(kinSignInClientCheck(orgId, "google", "a b.apps.googleusercontent.com", "s").ok).toBe(
      false,
    );
    const own = kinSignInCheck(
      orgId,
      {
        ...kinConnectionDraft("google"),
        clientId: "a b.apps.googleusercontent.com",
        clientSecret: "s",
      },
      services,
      "web",
    );
    expect(own.ok).toBe(false);
    // One account's own client goes along only where the service's rule offers one.
    const ready = [
      ...services,
      { ...services.find((one) => one.service === "google")!, service: "microsoft" as const },
    ].map((one) => ({ ...one, needsSetup: false }));
    const draft = (service: "google" | "microsoft") => ({
      ...kinConnectionDraft(service),
      clientId:
        service === "google"
          ? "9-x.apps.googleusercontent.com"
          : "00000000-1111-2222-3333-444444444444",
      clientSecret: "s",
    });
    const google = kinSignInCheck(orgId, draft("google"), ready, "web");
    if (!google.ok) throw new Error(google.problem);
    expect(google.input.client?.clientId).toBe("9-x.apps.googleusercontent.com");
    const microsoft = kinSignInCheck(orgId, draft("microsoft"), ready, "web");
    if (!microsoft.ok) throw new Error(microsoft.problem);
    expect(microsoft.input.client).toBeUndefined();
    expect(KIN_OWNER_CLIENT_SETUP.google.accountClient).not.toBeNull();
    expect(KIN_OWNER_CLIENT_SETUP.microsoft.accountClient).toBeNull();
    expect(kinSignInClientCheck(orgId, "google", "123-abc.apps.googleusercontent.com", "").ok).toBe(
      false,
    );
    const ok = kinSignInClientCheck(
      orgId,
      "google",
      " 123-abc.apps.googleusercontent.com ",
      " GOCSPX-x ",
    );
    if (!ok.ok) throw new Error(ok.problem);
    expect(ok.input.client?.clientId).toBe("123-abc.apps.googleusercontent.com");
    expect(Redacted.value(ok.input.client!.clientSecret!)).toBe("GOCSPX-x");

    // Microsoft's app keeps no secret, so the ID alone is enough.
    expect(kinSignInClientCheck(orgId, "microsoft", "kin-app", "").ok).toBe(false);
    const app = kinSignInClientCheck(
      orgId,
      "microsoft",
      " 00000000-1111-2222-3333-444444444444 ",
      "",
    );
    if (!app.ok) throw new Error(app.problem);
    expect(app.input).toEqual({
      orgId,
      service: "microsoft",
      client: { clientId: "00000000-1111-2222-3333-444444444444" },
    });
  });
});

describe("createKinConnectionActions", () => {
  it("adds and removes, answering a refusal in plain words", async () => {
    const sent: Array<KinConnectionAddInput> = [];
    const refreshes: Array<null> = [];
    let refuse = true;
    const actions = createKinConnectionActions({
      orgId,
      add: (input) => {
        sent.push(input);
        return Promise.resolve(
          refuse
            ? AsyncResult.failure(
                Cause.fail(
                  new KinChatError({
                    reason: "unavailable",
                    message: "Kin couldn't reach mcp.example.com.",
                  }),
                ),
              )
            : AsyncResult.success({
                connection: connection(),
                tools: [],
              } satisfies KinConnectionDetail),
        );
      },
      remove: () =>
        Promise.resolve(
          AsyncResult.success({
            orgId,
            connections: [],
            services: [...services],
            signInAddress: "https://kin.example/callback/",
          }),
        ),
      signInStart: () => Promise.reject(new Error("not used")),
      signInFinish: () => Promise.reject(new Error("not used")),
      setSignInClient: () => Promise.reject(new Error("not used")),
      refresh: () => void refreshes.push(null),
    });
    const draft = { ...kinConnectionDraft("custom"), url: "https://mcp.example.com/mcp" };
    expect(await actions.add(kinConnectionDraft("posthog"), services)).toEqual({
      ok: false,
      problem: "Paste your PostHog key to connect.",
    });
    expect(sent).toEqual([]);
    expect(await actions.add(draft, services)).toEqual({
      ok: false,
      problem: "Kin couldn't reach mcp.example.com. Check the address, or try again in a minute.",
    });
    refuse = false;
    expect(await actions.add(draft, services)).toEqual({ ok: true, value: connectionId });
    expect(await actions.remove(connectionId)).toEqual({ ok: true, value: null });
    expect(sent).toHaveLength(2);
    expect(refreshes).toHaveLength(3);
  });
});

describe("mail and calendar, said once", () => {
  const mail = (
    name: string,
    mode: KinConnectionTool["mode"],
    extra: Partial<KinConnectionTool> = {},
  ) =>
    tool({
      name,
      mode,
      pinDigest: `pin-${name}`,
      alwaysAsk: ["mail_send", "mail_reply", "calendar_save_event"].includes(name),
      ...extra,
    });
  const account = (read: KinConnectionTool["mode"], send: KinConnectionTool["mode"]) => [
    mail("mail_search", read),
    mail("calendar_list_events", read),
    mail("mail_send", send),
    mail("mail_reply", send),
    mail("calendar_save_event", "ask"),
  ];

  it.each([
    {
      case: "every account the same",
      accounts: [account("read", "ask"), account("read", "ask")],
      read: "read",
      send: "ask",
      differs: [false, false],
    },
    {
      case: "every account off",
      accounts: [account("off", "off"), account("off", "off")],
      read: "off",
      send: "off",
      differs: [false, false],
    },
    {
      case: "one account differs",
      accounts: [account("read", "ask"), account("read", "ask"), account("off", "ask")],
      read: null,
      send: "ask",
      differs: [false, false, true],
    },
    {
      case: "mixed inside every account",
      accounts: [
        [mail("mail_search", "read"), mail("calendar_get_event", "off")],
        [mail("mail_search", "read"), mail("calendar_get_event", "off")],
      ],
      read: null,
      send: undefined,
      differs: [false, false],
    },
  ] as const)("$case", ({ accounts, read, send, differs }) => {
    const readRow = kinMailPermission(accounts, "read");
    expect(readRow?.value).toBe(read);
    expect(accounts.map((tools) => readRow?.differs(tools))).toEqual(differs);
    // With no account that sends, the row is not shown.
    expect(kinMailPermission(accounts, "send")?.value).toBe(send);
  });

  it("hides every row with no mail account", () => {
    expect(kinMailPermission([], "read")).toBeNull();
    expect(kinMailPermission([[tool({ name: "query", mode: "read" })]], "read")).toBeNull();
  });

  it("writes only the tools that differ, at the digest shown", () => {
    expect(kinMailModes(account("off", "ask"), "read", "read")).toEqual([
      { tool: "calendar_list_events", mode: "read", digest: "pin-calendar_list_events" },
      { tool: "mail_search", mode: "read", digest: "pin-mail_search" },
    ]);
    expect(kinMailModes(account("read", "ask"), "send", "off")).toEqual([
      { tool: "mail_reply", mode: "off" },
      { tool: "mail_send", mode: "off" },
    ]);
    expect(kinMailModes(account("read", "ask"), "read", "read")).toEqual([]);
  });

  it("never writes Read for sending or calendar changes", () => {
    expect(kinMailModes(account("read", "off"), "send", "read")).toEqual([]);
    expect(kinMailModes(account("read", "off"), "calendar", "read")).toEqual([]);
    // A sending tool somehow in the read group still can't take Read.
    expect(kinMailModes([mail("mail_search", "off", { alwaysAsk: true })], "read", "read")).toEqual(
      [],
    );
  });

  it("leaves a tool waiting for a look, and every other connection's tools, alone", () => {
    const tools = [
      mail("mail_search", "off", { changed: true }),
      mail("mail_read_thread", "off"),
      tool({ name: "query", mode: "off" }),
    ];
    expect(kinMailModes(tools, "read", "read")).toEqual([
      { tool: "mail_read_thread", mode: "read", digest: "pin-mail_read_thread" },
    ]);
  });
});

describe("kinUseRow", () => {
  const call = (status: KinConnectionCall["status"], refusedReason: string | null) => ({
    callId: "c1",
    connectionId,
    toolName: "mail_list_threads",
    agentId: "a1",
    agentName: "Chief of staff",
    wakeupId: "w1",
    mode: "read" as const,
    args: null,
    reason: null,
    status,
    refusedReason,
    resultChars: null,
    resultBytes: null,
    durationMs: null,
    createdAt: 0,
  });
  const tools = [{ name: "mail_list_threads", title: "List mail" }];

  it.each([
    ["ok", null, "Done"],
    [
      "refused",
      "Sending is off for this account; the owner can change it.",
      "Not allowed by your settings",
    ],
    [
      "error",
      "Billing's sign-in expired. The owner can sign in again in Settings.",
      "Didn't go through: the sign-in had expired",
    ],
    ["error", "HTTP 500 from graph.microsoft.com", "Didn't go through"],
  ] as const)(
    "says %s in a person's words, never the host's reason to the agent",
    (status, reason, said) => {
      // @effect-diagnostics-next-line globalDate:off - the use row's clock label takes a Date.
      const row = kinUseRow(call(status, reason), new Date(0), tools);
      expect(row.title).toBe("See recent mail");
      expect(row.detail).toContain(`Chief of staff · ${said} · `);
      if (reason !== null) expect(row.detail).not.toContain(reason);
    },
  );
});
