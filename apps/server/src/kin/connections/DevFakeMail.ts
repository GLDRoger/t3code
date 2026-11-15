import type { KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import { ServerConfig } from "../../config.ts";
import { KinConnections } from "./ConnectionsService.ts";
import * as EgressGuard from "./EgressGuard.ts";
import { type FakeMailProvider, fileStore, makeFakeMail } from "./FakeMail.ts";

/**
 * `vp run dev` with `KIN_DEV_FAKE_MAIL=google:a@x.example,microsoft:b@x.example`: Google and
 * Microsoft calls go to a local mailbox file instead, and those accounts are connected at start.
 * Only with a dev server (`devUrl`), so an installed host never offers it.
 */
const devFakeMail = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const raw = yield* Config.String("KIN_DEV_FAKE_MAIL").pipe(Config.withDefault(""));
  if (config.devUrl === undefined || raw.trim() === "") return undefined;
  const accounts = raw.split(",").flatMap((entry) => {
    const [provider, address] = entry.trim().split(":");
    return (provider === "google" || provider === "microsoft") && address?.includes("@")
      ? [{ provider: provider as FakeMailProvider, address: address.trim() }]
      : [];
  });
  const path = (yield* Path.Path).join(config.stateDir, "kin-fake-mail.json");
  const fake = makeFakeMail(fileStore(path));
  for (const account of accounts)
    fake.addAccount({ ...account, name: account.address.split("@")[0]! });
  return { fake, accounts, path };
});

/** The connections' way out: the egress guard, in front of the fake mailbox when it is on. */
export const egress = Layer.unwrap(
  Effect.gen(function* () {
    const dev = yield* devFakeMail;
    if (dev === undefined) return EgressGuard.layer;
    yield* Effect.logWarning(`Kin mail goes to the fake mailbox at ${dev.path}`);
    return EgressGuard.guarded.pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, dev.fake.handle(globalThis.fetch))),
    );
  }),
);

const READ = ["mail_list_threads", "mail_search", "mail_read_thread", "calendar_list_events"];
const ASK = ["mail_send", "mail_reply", "calendar_save_event"];

/** Signs the owner in to each fake account not yet connected, through the real sign-in. */
export const connectFakeAccounts = Effect.fn("KinDevFakeMail.connect")(
  function* (owner: { readonly orgId: KinOrgId; readonly personId: KinPersonId }) {
    const dev = yield* devFakeMail;
    if (dev === undefined) return;
    const connections = yield* KinConnections;
    const people = [{ _tag: "person" as const, ...owner }];
    const orgId = owner.orgId;
    const view = yield* connections.list(people, { orgId });
    const connected = new Set(
      view.connections.flatMap((one) => one.accountLabel?.toLowerCase() ?? []),
    );
    for (const account of dev.accounts) {
      if (connected.has(account.address.toLowerCase())) continue;
      const service = account.provider;
      if (view.services.find((one) => one.service === service)?.needsSetup !== false)
        yield* connections.setSignInClient(people, {
          orgId,
          service,
          client:
            service === "google"
              ? {
                  clientId: "kin-dev-fake.apps.googleusercontent.com",
                  clientSecret: Redacted.make("kin-dev-fake"),
                }
              : { clientId: "00000000-0000-4000-8000-00000000fa4e" },
        });
      const started = yield* connections.signInStart(people, { orgId, service, returnTo: "web" });
      const done = yield* connections.signInFinish(people, {
        orgId,
        response: dev.fake.approve(started.authorizationUrl, account.address),
      });
      yield* connections.setToolModes(people, {
        orgId,
        connectionId: done.connection.connectionId,
        modes: done.tools.flatMap((tool) =>
          READ.includes(tool.name) || ASK.includes(tool.name)
            ? [
                {
                  tool: tool.name,
                  mode: READ.includes(tool.name) ? ("read" as const) : ("ask" as const),
                  digest: tool.pinDigest,
                },
              ]
            : [],
        ),
      });
      yield* Effect.logInfo(`Kin connected the fake mail account ${account.address}`);
    }
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin couldn't connect the fake mail accounts", cause),
  ),
);
