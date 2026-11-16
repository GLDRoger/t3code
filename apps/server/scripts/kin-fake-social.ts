// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - a dev command's output and the fake's times.
// Fills and changes a dev server's fake Zernio (KIN_DEV_FAKE_SOCIAL). Invented data only.
//   node scripts/kin-fake-social.ts <stateDir>/kin-fake-social.json profile "Invented Co" instagram:inventedco linkedin:"Invented Co"
//     prints the profile id and a key limited to it; all-profiles makes a key that reaches every profile
//   node scripts/kin-fake-social.ts <file> past <profileId> '[{"platform":"instagram","content":"…","likes":120,…}]'
//   node scripts/kin-fake-social.ts <file> fail-next <accountId> "Instagram refused the picture."
//   node scripts/kin-fake-social.ts <file> posts | accounts <profileId> | shift <ms>
import * as NodeFS from "node:fs";

import { type FakeSocialPast, fileStore, makeFakeZernio } from "../src/kin/social/FakeZernio.ts";

const [path, command, ...rest] = process.argv.slice(2);
const usage =
  "Usage: kin-fake-social.ts <fake.json> profile <name> <platform:handle>... [all-profiles] | past <profileId> '<json>' | fail-next <accountId> <reason> | posts | accounts <profileId> | shift <ms>";
if (path === undefined || command === undefined) {
  console.error(usage);
  process.exit(2);
}
const store = fileStore(path);
const fake = makeFakeZernio(store);
const fail = (message: string) => {
  console.error(message);
  process.exit(2);
};

switch (command) {
  case "profile": {
    const [name, ...specs] = rest.filter((arg) => arg !== "all-profiles");
    if (name === undefined || specs.length === 0)
      fail("profile needs a name and platform:handle pairs.");
    const made = fake.addProfile({
      name: name!,
      wholeWorkspace: rest.includes("all-profiles"),
      accounts: specs.map((spec) => {
        const [platform, ...handle] = spec.split(":");
        const username = handle.join(":");
        return { platform: platform!, username, displayName: username || name! };
      }),
    });
    console.log(JSON.stringify(made));
    break;
  }
  case "past": {
    const [profileId, json] = rest;
    if (profileId === undefined || json === undefined) fail("past needs a profile id and JSON.");
    const accounts = fake.accountsOf(profileId!);
    const rows = JSON.parse(json!) as Array<Partial<FakeSocialPast> & { platform: string }>;
    fake.addPast(
      rows.map((row, index) => {
        const account = accounts.find((one) => one.platform === row.platform);
        if (account === undefined) fail(`No ${row.platform} account in ${profileId}.`);
        return {
          accountId: account!.accountId,
          platform: row.platform,
          content: row.content ?? `Post ${index + 1}`,
          publishedAt:
            row.publishedAt ?? new Date(Date.now() - (index + 1) * 86_400_000).toISOString(),
          mediaType: row.mediaType ?? "image",
          likes: row.likes ?? 0,
          comments: row.comments ?? 0,
          saves: row.saves ?? 0,
          shares: row.shares ?? 0,
          reach: row.reach ?? 0,
        } as FakeSocialPast;
      }),
    );
    console.log(`${rows.length} past posts added`);
    break;
  }
  case "fail-next": {
    const [accountId, reason] = rest;
    if (accountId === undefined || reason === undefined)
      fail("fail-next needs an account id and a reason.");
    fake.failNext(accountId!, reason!);
    console.log(`${accountId}: the next post fails`);
    break;
  }
  case "posts":
    console.log(JSON.stringify(store.load().posts, null, 2));
    break;
  case "accounts":
    console.log(JSON.stringify(fake.accountsOf(rest[0] ?? ""), null, 2));
    break;
  case "shift": {
    // `kv clock advance`: the fake's times move into the past with Kin's.
    const ms = Number(rest[0]);
    if (!Number.isFinite(ms) || ms <= 0) fail("shift needs a positive number of milliseconds.");
    if (!NodeFS.existsSync(path)) break;
    const back = (iso: string) => new Date(Date.parse(iso) - ms).toISOString();
    const state = store.load();
    for (const post of state.posts) Object.assign(post, { scheduledFor: back(post.scheduledFor) });
    for (const past of state.past) Object.assign(past, { publishedAt: back(past.publishedAt) });
    store.save(state);
    console.log(`fake social: ${state.posts.length} posts moved back`);
    break;
  }
  default:
    fail(usage);
}
